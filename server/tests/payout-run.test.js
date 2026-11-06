// Payout-run tests (the owner's FINAL model, 2026-11-05):
// paste-register inside a rolling 24h window -> owed = tier % x own
// snapshot balance -> $0.50/day total cap converted at the run's
// live price -> the owner presses the button -> automatic sends
// from the payout wallet, pool paying only what is owed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { buildPayoutTable, runPayoutDay, createApp } from '../src/server.js';
import { capBaseForUsd } from '../src/price.js';

const A = 'terra1' + 'a'.repeat(38);
const B = 'terra1' + 'q'.repeat(38);
const C = 'terra1' + 'p'.repeat(38);
const ADMIN = 'terra1' + 'w'.repeat(38);
const FRG1 = 1_000_000n;
// The first real press: Nov 6 ~21:40 ET = 02:40 UTC.
const T0 = new Date('2026-11-06T02:40:00Z');
const HOUR = 3_600_000;

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-payout-'));
  return openStore(path.join(dir, 'test.db'));
}

// Fake payout wallet with a REAL tracked balance: sends decrement
// it, so pool-remainder assertions are honest.
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

// A price that makes FRG exactly $0.05: pair reserves give
// 0.5 LUNC per FRG; LUNC = $0.10 (100000 micro).
const FAKE_PRICE = {
  frgReserveBase: 1_000_000n * FRG1, luncReserveBase: 500_000n * FRG1,
  luncUsdMicro: 100_000n, pair: 'fake-pair',
};
const fakePriceFeed = async () => FAKE_PRICE;
const noPriceFeed = async () => { throw new Error('price must not be consulted'); };

const balances = (map) => async (addr) => map[addr] ?? 0n;

function setup({ tiers = [{ minBase: 0n, pctBps: 100 }], capMicro = 0n } = {}) {
  const s = tmpStore();
  s.setRewardTiers(tiers);
  s.setDailyCapUsdMicro(capMicro);
  return s;
}

test('pool pays only what is owed: pool 2,000, owed 37 -> pays 37, pool keeps 1,963', async () => {
  const s = setup(); // 1%/day base tier, cap off
  s.registerWallet(A, null);
  s.recordRegistration(A, T0.getTime() - HOUR);
  const payout = fakePayout(2_000n * FRG1);
  const run = await runPayoutDay(s, payout, balances({ [A]: 3_700n * FRG1 }),
    { now: T0, priceFeed: noPriceFeed });
  assert.equal(run.status, 'completed');
  assert.equal(run.totalOwed, 37n * FRG1); // 1% of 3,700
  assert.equal(run.totalPaid, 37n * FRG1);
  assert.equal(payout.balance, 1_963n * FRG1); // the pool does NOT empty
  assert.equal(payout.sent.length, 1);
  assert.equal(payout.sent[0].amount, 37n * FRG1);
  assert.equal(run.detail.rows[0].txhash, 'TX1'); // recorded with tx hash
  assert.equal(run.registeredCount, 1);
});

test('cap math is exact: $0.50 at a $0.05 FRG price caps the day at exactly 10 FRG', async () => {
  assert.equal(capBaseForUsd(500_000n, FAKE_PRICE), 10n * FRG1);
  const s = setup({ tiers: [{ minBase: 0n, pctBps: 10000 }], capMicro: 500_000n }); // cap ON ($0.50)
  s.registerWallet(A, null);
  s.recordRegistration(A, T0.getTime() - HOUR);
  const payout = fakePayout(2_000n * FRG1);
  // A is owed 100 FRG (100% of 100) — way over the $0.50 cap.
  const run = await runPayoutDay(s, payout, balances({ [A]: 100n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.totalOwed, 100n * FRG1);
  assert.equal(run.capBase, 10n * FRG1);
  assert.equal(run.totalPaid, 10n * FRG1); // exactly the cap, never more
  assert.equal(run.detail.scaledToCap, true);
  assert.equal(run.detail.price.frgUsd, 0.05); // the live price used is in the record
  assert.equal(payout.balance, 1_990n * FRG1);
});

test('cap is a maximum, not a target: owed under the cap pays in full', async () => {
  const s = setup({ tiers: [{ minBase: 0n, pctBps: 100 }], capMicro: 500_000n });
  s.registerWallet(A, null);
  s.recordRegistration(A, T0.getTime() - HOUR);
  const payout = fakePayout(2_000n * FRG1);
  const run = await runPayoutDay(s, payout, balances({ [A]: 100n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.totalPaid, 1n * FRG1); // 1 FRG owed; cap (10 FRG) untouched beyond that
  assert.equal(run.detail.scaledToCap, false);
});

test('price-feed failure halts the run and pays nothing; a later press still works', async () => {
  const s = setup({ tiers: [{ minBase: 0n, pctBps: 100 }], capMicro: 500_000n });
  s.registerWallet(A, null);
  s.recordRegistration(A, T0.getTime() - HOUR);
  const payout = fakePayout(2_000n * FRG1);
  const halted = await runPayoutDay(s, payout, balances({ [A]: 100n * FRG1 }),
    { now: T0, priceFeed: async () => { throw new Error('LCD down'); } });
  assert.equal(halted.status, 'halted_price');
  assert.equal(payout.sent.length, 0); // never guess a price
  assert.equal(s.dayRecorded('2026-11-06'), false); // nothing recorded
  assert.equal(s.accrued(A), 0n);
  const run = await runPayoutDay(s, payout, balances({ [A]: 100n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.status, 'completed');
  assert.equal(run.totalPaid, 1n * FRG1);
});

test('owed > pool balance: pro-rata scale-down, total paid == pool balance, shortfall stays owed', async () => {
  const s = setup({ tiers: [{ minBase: 0n, pctBps: 10000 }] }); // owed == balance
  s.registerWallet(A, null); s.registerWallet(B, null);
  s.recordRegistration(A, T0.getTime() - HOUR);
  s.recordRegistration(B, T0.getTime() - HOUR);
  const payout = fakePayout(50n * FRG1); // pool holds only 50 FRG
  const run = await runPayoutDay(s, payout,
    balances({ [A]: 100n * FRG1, [B]: 100n * FRG1 }), { now: T0, priceFeed: noPriceFeed });
  assert.equal(run.status, 'partial_pool');
  assert.equal(run.totalPaid, 50n * FRG1); // exactly the pool balance, never more
  assert.equal(run.shortfall, 150n * FRG1); // honestly recorded
  assert.equal(s.claimable(A), 75n * FRG1); // the shortfall stays owed
  assert.equal(s.claimable(B), 75n * FRG1);
  // Owner tops the pool up and presses again the same day: the
  // remainder pays out, still never double-paying the first half.
  payout.balance += 500n * FRG1;
  const run2 = await runPayoutDay(s, payout,
    balances({ [A]: 100n * FRG1, [B]: 100n * FRG1 }), { now: T0, priceFeed: noPriceFeed });
  assert.equal(run2.totalPaid, 200n * FRG1);
  assert.equal(s.claimable(A), 0n);
  assert.equal(s.paid(A), 100n * FRG1);
  assert.equal(s.paid(B), 100n * FRG1);
});

test('idempotent press: pressing twice pays once', async () => {
  const s = setup();
  s.registerWallet(A, null);
  s.recordRegistration(A, T0.getTime() - HOUR);
  const payout = fakePayout(2_000n * FRG1);
  const fetchB = balances({ [A]: 3_700n * FRG1 });
  await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: noPriceFeed });
  const run2 = await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: noPriceFeed });
  assert.equal(payout.sent.length, 1);
  assert.equal(run2.totalPaid, 37n * FRG1);
  assert.equal(s.paid(A), 37n * FRG1);
});

test('rolling 24h window: registered 25h ago is OUT, 23h ago is IN, re-pasting refreshes', async () => {
  const s = setup();
  s.registerWallet(A, null); s.registerWallet(B, null); s.registerWallet(C, null);
  s.recordRegistration(A, T0.getTime() - 25 * HOUR); // too old
  s.recordRegistration(B, T0.getTime() - 23 * HOUR); // in
  s.recordRegistration(C, T0.getTime() - 30 * HOUR); // too old...
  s.recordRegistration(C, T0.getTime() - HOUR);      // ...refreshed by pasting again
  const table = await buildPayoutTable(s,
    balances({ [A]: 1_000n * FRG1, [B]: 1_000n * FRG1, [C]: 1_000n * FRG1 }), { now: T0 });
  assert.equal(table.registeredCount, 2); // the count the owner will check
  assert.deepEqual(table.rows.map((r) => r.wallet), [C, B]); // rows are wallet-sorted
  const payout = fakePayout(2_000n * FRG1);
  await runPayoutDay(s, payout,
    balances({ [A]: 1_000n * FRG1, [B]: 1_000n * FRG1, [C]: 1_000n * FRG1 }),
    { now: T0, priceFeed: noPriceFeed });
  assert.equal(s.paid(A), 0n); // unregistered-in-window: paid 0, even holding 1,000 FRG
  assert.equal(s.paid(B), 10n * FRG1);
  assert.equal(s.paid(C), 10n * FRG1);
});

test('sub-dust owed carries forward instead of sending, then pays combined', async () => {
  const s = setup({ tiers: [{ minBase: 0n, pctBps: 5 }] }); // 0.05%/day
  s.registerWallet(A, null);
  s.recordRegistration(A, T0.getTime() - HOUR);
  const payout = fakePayout(2_000n * FRG1);
  // Day 1: holds 100 FRG -> owed 0.05 FRG (below the 1 FRG threshold).
  const run1 = await runPayoutDay(s, payout, balances({ [A]: 100n * FRG1 }),
    { now: T0, priceFeed: noPriceFeed });
  assert.equal(payout.sent.length, 0); // never send dust
  assert.equal(run1.detail.rows[0].payStatus, 'carried-dust');
  assert.equal(s.accrued(A), 50_000n); // carried, honestly accrued
  // Day 2: holds 2,000 FRG -> owed 1 FRG; combined 1.05 FRG sends.
  const T1 = new Date(T0.getTime() + 24 * HOUR);
  s.recordRegistration(A, T1.getTime() - HOUR);
  const run2 = await runPayoutDay(s, payout, balances({ [A]: 2_000n * FRG1 }),
    { now: T1, priceFeed: noPriceFeed });
  assert.equal(run2.status, 'completed');
  assert.equal(payout.sent.length, 1);
  assert.equal(payout.sent[0].amount, 1_050_000n); // 1 FRG + carried 0.05 FRG
  assert.equal(s.claimable(A), 0n);
});

test('changing tiers never alters a recorded day; the next day uses the new tiers', async () => {
  const s = setup({ tiers: [{ minBase: 0n, pctBps: 100 }] }); // 1%
  s.registerWallet(A, null);
  s.recordRegistration(A, T0.getTime() - HOUR);
  const payout = fakePayout(2_000n * FRG1);
  const fetchB = balances({ [A]: 1_000n * FRG1 });
  await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: noPriceFeed });
  assert.equal(s.paid(A), 10n * FRG1); // 1% of 1,000
  s.setRewardTiers([{ minBase: 0n, pctBps: 200 }]); // owner doubles the rate
  const again = await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: noPriceFeed });
  assert.equal(again.totalPaid, 10n * FRG1); // day 1 frozen at the old tier
  assert.equal(payout.sent.length, 1);
  const T1 = new Date(T0.getTime() + 24 * HOUR);
  s.recordRegistration(A, T1.getTime() - HOUR);
  await runPayoutDay(s, payout, fetchB, { now: T1, priceFeed: noPriceFeed });
  assert.equal(s.paid(A), 30n * FRG1); // day 2 paid at the new 2%
});

test('past days are never re-paid when new wallets register later', async () => {
  const s = setup();
  s.registerWallet(A, null);
  s.recordRegistration(A, T0.getTime() - HOUR);
  const payout = fakePayout(2_000n * FRG1);
  const fetchB = balances({ [A]: 1_000n * FRG1, [B]: 1_000n * FRG1 });
  await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: noPriceFeed });
  assert.equal(s.paid(A), 10n * FRG1);
  // B registers AFTER day 1's run and the owner re-presses day 1:
  // B gets nothing for day 1 and A is not paid again.
  s.registerWallet(B, null);
  s.recordRegistration(B, T0.getTime() + 30 * 60_000);
  await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: noPriceFeed });
  assert.equal(s.paid(B), 0n);
  assert.equal(s.paid(A), 10n * FRG1);
  assert.equal(payout.sent.length, 1);
});

test('HTTP: preview shows the window count + table; the payout button pays; admin gating holds', async (t) => {
  const s = tmpStore();
  s.setRewardTiers([{ minBase: 0n, pctBps: 100 }]);
  s.setDailyCapUsdMicro(0n);
  const payout = fakePayout(2_000n * FRG1);
  const app = createApp({
    store: s, payout,
    config: {
      lcdUrl: 'http://127.0.0.1:1', rpcUrl: '', adminWallet: ADMIN, adminSecret: 'test-secret',
      fetchBalance: balances({ [A]: 3_700n * FRG1 }),
      priceFeed: noPriceFeed,
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

  // Paste-register over HTTP (no wallet connect exists in this app).
  const reg = await post('/api/register', { address: A, referrer: null });
  assert.equal(reg.status, 200);
  const preview = await get('/api/admin/payout-preview', adminH);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.registeredCount, 1); // the window count
  assert.equal(preview.body.rows[0].owedWhole, '37');
  assert.equal(preview.body.poolBalanceWhole, '2000');
  assert.equal(preview.body.poolRemainderWhole, '1963'); // pool does not empty
  // The button refuses without admin auth...
  const denied = await post('/api/admin/payout', {});
  assert.equal(denied.status, 403);
  assert.equal(payout.sent.length, 0);
  // ...and pays with it.
  const run = await post('/api/admin/payout', {}, adminH);
  assert.equal(run.status, 200);
  assert.equal(run.body.status, 'completed');
  assert.equal(run.body.totalPaid, '37000000');
  assert.equal(payout.sent.length, 1);
  // Tier validation: nonsense percentages are rejected plainly.
  const badTiers = await post('/api/admin/tiers', { tiers: [{ minWhole: '0', pct: 150 }] }, adminH);
  assert.equal(badTiers.status, 400);
});
