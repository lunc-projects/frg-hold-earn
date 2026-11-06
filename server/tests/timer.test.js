// Split countdown timer tests (owner, 2026-11-05): the owner
// announces, starts a 24-hour timer from the admin side, holders
// get their wallets in before it ends, and the split runs after.
// The deadline is a payout-build CUTOFF: registrations at/before
// it are in; registrations after it stay registered and wait for
// the next split. No timer set = behavior exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { buildPayoutTable, runPayoutDay, createApp } from '../src/server.js';

const A = 'terra1' + 'a'.repeat(38);
const B = 'terra1' + 'q'.repeat(38);
const ADMIN = 'terra1' + 'w'.repeat(38);
const FRG1 = 1_000_000n;
const T0 = new Date('2026-11-06T02:40:00Z');
const HOUR = 3_600_000;

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-timer-'));
  return openStore(path.join(dir, 'test.db'));
}

function fakePayout(balance) {
  const sent = [];
  const fp = {
    sent,
    configured: true,
    getRewardBalance: async () => fp.balance,
    sendReward: async (to, amount) => {
      if (amount > fp.balance) throw new Error('insufficient funds');
      fp.balance -= amount;
      sent.push({ to, amount });
      return `TX${sent.length}`;
    },
    getBalance: async () => fp.balance,
    send: async () => { throw new Error('NFT path must not be used by base payout'); },
    getUstcBalance: async () => 0n,
    sendUstc: async () => { throw new Error('USTC path must never send'); },
    address: async () => 'terra1' + 'z'.repeat(38),
  };
  fp.balance = balance;
  return fp;
}

// FRG = exactly $0.05 -> the $0.50 set amount is a 10 FRG pot.
const FAKE_PRICE = {
  frgReserveBase: 1_000_000n * FRG1, luncReserveBase: 500_000n * FRG1,
  luncUsdMicro: 100_000n, pair: 'fake-pair',
};
const fakePriceFeed = async () => FAKE_PRICE;
const balances = (map) => async (addr) => map[addr] ?? 0n;

function setup({ minHoldingBase = 0n } = {}) {
  const s = tmpStore();
  s.setDailyPayoutUsdMicro(500_000n); // the owner's $0.50
  s.setMinHoldingBase(minHoldingBase);
  return s;
}

function reg(s, wallet, when) {
  s.registerWallet(wallet, null);
  s.recordRegistration(wallet, when);
}

test('store: the deadline defaults to 0 (no timer) and round-trips', () => {
  const s = tmpStore();
  assert.equal(s.getSplitDeadlineMs(), 0);
  s.setSplitDeadlineMs(T0.getTime());
  assert.equal(s.getSplitDeadlineMs(), T0.getTime());
  s.setSplitDeadlineMs(0);
  assert.equal(s.getSplitDeadlineMs(), 0); // cleared
});

test('cutoff: registered BEFORE the deadline is in, AFTER is out but stays registered', async () => {
  const s = setup();
  const D = T0.getTime() + 24 * HOUR; // the deadline
  reg(s, A, D - HOUR); // in before the timer ends
  reg(s, B, D + HOUR); // too late for this split
  s.setSplitDeadlineMs(D);
  const fetchB = balances({ [A]: 1_000n * FRG1, [B]: 1_000n * FRG1 });
  const table = await buildPayoutTable(s, fetchB,
    { now: T0, priceFeed: fakePriceFeed, poolBalance: 2_000n * FRG1 });
  assert.equal(table.splitDeadlineMs, D);
  assert.deepEqual(table.rows.map((r) => r.wallet), [A]); // B not in this split
  assert.equal(table.registeredCount, 1);
  assert.equal(table.registeredBeforeCutoff, 1);
  assert.equal(table.registeredAfterCutoff, 1);
  assert.deepEqual(table.lateRegistrations, [B]);
  // B is NOT removed — it is simply waiting for the next split.
  assert.notEqual(s.registrationFor(B), null);
  assert.deepEqual(table.deregistered, []);
  // A wallet registered AT the deadline exactly is in (at/before).
  const s2 = setup();
  reg(s2, A, D);
  s2.setSplitDeadlineMs(D);
  const t2 = await buildPayoutTable(s2, fetchB,
    { now: T0, priceFeed: fakePriceFeed, poolBalance: 2_000n * FRG1 });
  assert.deepEqual(t2.rows.map((r) => r.wallet), [A]);
});

test('no timer set: every registered wallet is in, exactly as before', async () => {
  const s = setup();
  reg(s, A, T0.getTime() - 100 * HOUR);
  reg(s, B, T0.getTime() + 100 * HOUR); // "future" registration, still in with no timer
  const table = await buildPayoutTable(s,
    balances({ [A]: 1_000n * FRG1, [B]: 1_000n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed, poolBalance: 2_000n * FRG1 });
  assert.equal(table.splitDeadlineMs, null);
  assert.equal(table.registeredAfterCutoff, 0);
  assert.deepEqual(table.rows.map((r) => r.wallet), [A, B]);
});

test('payout run honors the cutoff; the late wallet is paid by a later run once the timer is cleared', async () => {
  const s = setup();
  const D = T0.getTime() + 24 * HOUR;
  reg(s, A, D - HOUR);
  reg(s, B, D + HOUR); // registered after the deadline
  s.setSplitDeadlineMs(D);
  const payout = fakePayout(2_000n * FRG1);
  const fetchB = balances({ [A]: 1_000n * FRG1, [B]: 1_000n * FRG1 });
  const run = await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.status, 'completed');
  assert.equal(s.paid(A), 10n * FRG1); // sole participant: the whole $0.50 pot
  assert.equal(s.accrued(B), 0n); // late: nothing for this split
  assert.equal(s.paid(B), 0n);
  assert.notEqual(s.registrationFor(B), null); // still registered
  // The run record carries the cutoff it used.
  assert.equal(run.detail.splitDeadlineMs, D);
  assert.equal(run.detail.registeredAfterCutoff, 1);
  assert.deepEqual(run.detail.lateRegistrations, [B]);
  // Next day, timer cleared: B is in and gets paid.
  s.setSplitDeadlineMs(0);
  const T1 = new Date(T0.getTime() + 48 * HOUR);
  const run2 = await runPayoutDay(s, payout, fetchB, { now: T1, priceFeed: fakePriceFeed });
  assert.equal(run2.status, 'completed');
  assert.equal(run2.detail.splitDeadlineMs, null);
  assert.equal(s.paid(B), 5n * FRG1); // equal holdings -> half of day 2's pot
  assert.equal(s.paid(A), 15n * FRG1); // 10 (day 1) + 5 (day 2)
});

test('cutoff + minimum holding: the build never deregisters a LATE wallet', async () => {
  const s = setup({ minHoldingBase: 100n * FRG1 });
  const D = T0.getTime() + 24 * HOUR;
  reg(s, A, D - HOUR); // in before the deadline, but below the minimum
  reg(s, B, D + HOUR); // late AND below the minimum
  s.setSplitDeadlineMs(D);
  const fetchB = balances({ [A]: 50n * FRG1, [B]: 50n * FRG1 });
  const table = await buildPayoutTable(s, fetchB,
    { now: T0, priceFeed: fakePriceFeed, poolBalance: 2_000n * FRG1 });
  // A (a participant) is below the minimum -> removed, as built.
  assert.deepEqual(table.deregistered.map((d) => d.wallet), [A]);
  assert.equal(s.registrationFor(A), null);
  // B was never a participant in this build -> untouched.
  assert.notEqual(s.registrationFor(B), null);
  assert.deepEqual(table.lateRegistrations, [B]);
});

test('HTTP: timer endpoints are admin-gated; stats exposes the deadline + seconds remaining', async (t) => {
  const s = tmpStore();
  s.setDailyPayoutUsdMicro(500_000n);
  s.setMinHoldingBase(0n);
  const payout = fakePayout(2_000n * FRG1);
  const app = createApp({
    store: s, payout,
    config: {
      lcdUrl: 'http://127.0.0.1:1', rpcUrl: '', adminWallet: ADMIN, adminSecret: 'test-secret',
      fetchBalance: balances({ [A]: 3_700n * FRG1 }),
      priceFeed: fakePriceFeed,
    },
  });
  const server = await new Promise((r) => { const srv = app.listen(0, () => r(srv)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const get = (p, headers = {}) => fetch(`${base}${p}`, { headers })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  const adminH = { 'x-admin-wallet': ADMIN, 'x-admin-secret': 'test-secret' };

  // No timer: stats is explicit and quiet — nulls, not zeros.
  const st0 = await get('/api/stats');
  assert.equal(st0.body.splitDeadline, null);
  assert.equal(st0.body.splitDeadlineMs, null);
  assert.equal(st0.body.secondsRemaining, null);

  // The timer controls refuse without admin auth.
  assert.equal((await post('/api/admin/timer/start', {})).status, 403);
  assert.equal((await post('/api/admin/timer/set', { deadline: new Date().toISOString() })).status, 403);
  assert.equal((await post('/api/admin/timer/clear', {})).status, 403);
  assert.equal(s.getSplitDeadlineMs(), 0);

  // START: deadline lands ~24h out, and stats agrees with the server clock.
  const before = Date.now();
  const started = await post('/api/admin/timer/start', {}, adminH);
  const after = Date.now();
  assert.equal(started.status, 200);
  assert.ok(started.body.splitDeadlineMs >= before + 24 * HOUR - 1000);
  assert.ok(started.body.splitDeadlineMs <= after + 24 * HOUR + 1000);
  assert.equal(started.body.splitDeadline, new Date(started.body.splitDeadlineMs).toISOString());
  const st1 = await get('/api/stats');
  assert.equal(st1.body.splitDeadlineMs, started.body.splitDeadlineMs);
  assert.ok(st1.body.secondsRemaining > 86_000 && st1.body.secondsRemaining <= 86_400);

  // A bad length is rejected and changes nothing.
  assert.equal((await post('/api/admin/timer/start', { hours: -1 }, adminH)).status, 400);
  assert.equal(s.getSplitDeadlineMs(), started.body.splitDeadlineMs);

  // SET an exact deadline.
  const exact = Date.parse('2026-11-07T02:40:00.000Z');
  const set = await post('/api/admin/timer/set', { deadline: '2026-11-07T02:40:00.000Z' }, adminH);
  assert.equal(set.status, 200);
  assert.equal(set.body.splitDeadlineMs, exact);
  assert.equal(s.getSplitDeadlineMs(), exact);
  assert.equal((await post('/api/admin/timer/set', { deadline: 'not-a-date' }, adminH)).status, 400);
  assert.equal(s.getSplitDeadlineMs(), exact);

  // PREVIEW shows the cutoff it used: move the deadline to one
  // hour ago, then A registers NOW — after the deadline — and is
  // reported late, not split.
  const past = Date.now() - HOUR;
  await post('/api/admin/timer/set', { deadlineMs: past }, adminH);
  const regA = await post('/api/register', { address: A, referrer: null });
  assert.equal(regA.status, 200);
  const prevLate = await get('/api/admin/payout-preview', adminH);
  assert.equal(prevLate.body.splitDeadlineMs, past);
  assert.equal(prevLate.body.registeredBeforeCutoff, 0);
  assert.equal(prevLate.body.registeredAfterCutoff, 1);
  assert.deepEqual(prevLate.body.lateRegistrations, [A]);
  assert.equal(prevLate.body.registeredCount, 0);
  // Move the deadline past A's registration: A is in before it.
  const future = Date.now() + HOUR;
  await post('/api/admin/timer/set', { deadlineMs: future }, adminH);
  const prevIn = await get('/api/admin/payout-preview', adminH);
  assert.equal(prevIn.body.registeredBeforeCutoff, 1);
  assert.equal(prevIn.body.registeredAfterCutoff, 0);
  assert.equal(prevIn.body.registeredCount, 1);
  assert.equal(prevIn.body.rows[0].wallet, A);

  // CLEAR: the clock disappears from stats entirely.
  const cleared = await post('/api/admin/timer/clear', {}, adminH);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.splitDeadline, null);
  const st2 = await get('/api/stats');
  assert.equal(st2.body.splitDeadline, null);
  assert.equal(st2.body.splitDeadlineMs, null);
  assert.equal(st2.body.secondsRemaining, null);
  assert.equal(s.getSplitDeadlineMs(), 0);
});
