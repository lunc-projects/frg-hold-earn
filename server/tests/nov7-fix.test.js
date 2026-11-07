// Nov 7 fix tests: the gas-price root cause + memo + low-gas
// guard + admin deregister + auto-pay at timer zero.
//
// The 2026-11-07 first payout failed ALL 13 sends: the send path
// priced gas at 0.15uluna while Terra Classic's on-chain uluna
// min gas price is 28.325 — every broadcast was rejected with
// code 13 "insufficient fees; got: 26517uluna, required:
// …,5007124uluna,…". These tests pin the corrected price, the
// per-send memo, the pre-run gas guard, the deregister control,
// and the auto-pay semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { buildPayoutTable, runPayoutDay, maybeAutoPayout, createApp } from '../src/server.js';
import {
  createPayout, TERRA_GAS_PRICE, PAYOUT_MEMO, GAS_RESERVE_PER_SEND_ULUNA,
} from '../src/payout.js';

const A = 'terra1' + 'a'.repeat(38);
const B = 'terra1' + 'q'.repeat(38);
const OWNER = 'terra1kur3cr4vask4lgs3tr4gww7lr0zvc944gjfcqc'; // the owner's own wallet
const ADMIN = 'terra1' + 'w'.repeat(38);
const FRG1 = 1_000_000n;
const LUNC1 = 1_000_000n;
const T0 = new Date('2026-11-07T14:37:00Z'); // the failed run's day, ~09:37 ET
const HOUR = 3_600_000;

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-nov7-'));
  return openStore(path.join(dir, 'test.db'));
}

// Fake payout wallet: tracked FRG balance + tracked LUNC gas
// tank; sends record the MEMO they were called with.
function fakePayout(balance, { gasUluna = 21_267_708n * LUNC1 } = {}) {
  const sent = [];
  const fp = {
    sent,
    configured: true,
    gasUluna,
    getRewardBalance: async () => fp.balance,
    getGasBalance: async () => fp.gasUluna,
    sendReward: async (to, amount, memo) => {
      if (amount > fp.balance) throw new Error('insufficient funds');
      fp.balance -= amount;
      sent.push({ to, amount, memo });
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

const FAKE_PRICE = {
  frgReserveBase: 1_000_000n * FRG1, luncReserveBase: 500_000n * FRG1,
  luncUsdMicro: 100_000n, pair: 'fake-pair',
};
const fakePriceFeed = async () => FAKE_PRICE;
const balances = (map) => async (addr) => map[addr] ?? 0n;

function setup() {
  const s = tmpStore();
  s.setDailyPayoutUsdMicro(500_000n); // the owner's $0.50
  s.setMinHoldingBase(0n);
  return s;
}
function reg(s, wallet, when = T0.getTime() - HOUR) {
  s.registerWallet(wallet, null);
  s.recordRegistration(wallet, when);
}

// ── Gas price + memo constants (the root-cause fix) ────────────

test('gas price is the on-chain Terra Classic uluna price, not the stale 0.15', () => {
  assert.equal(TERRA_GAS_PRICE, '28.325uluna');
  // The failed run's arithmetic: 0.15 × 176,780 gas = 26,517
  // uluna offered; the chain required 5,007,124 uluna for the
  // same gas. At the shipped price the fee clears it.
  const gas = 176_780;
  assert.equal(Math.floor(gas * 0.15), 26_517);
  assert.ok(gas * 28.325 >= 5_007_124);
});

test('gas reserve per send is ~1.5x the measured CW20 fee', () => {
  // Measured fee at the corrected price: ~5,007,124 uluna.
  assert.equal(GAS_RESERVE_PER_SEND_ULUNA, 7_500_000n);
  assert.ok(GAS_RESERVE_PER_SEND_ULUNA > 5_007_124n); // strictly above the measured fee
  assert.ok(GAS_RESERVE_PER_SEND_ULUNA * 2n >= 5_007_124n * 2n); // and not more than ~2x it
  assert.ok(GAS_RESERVE_PER_SEND_ULUNA * 3n >= 5_007_124n * 4n); // ≈1.5x headroom band
});

test('payout memo is the owner\'s exact wording', () => {
  assert.equal(PAYOUT_MEMO, 'Thank you for holding FRG — here is your Hold & Earn reward');
});

test('getGasBalance reads the payout wallet uluna bank balance', async () => {
  const realFetch = global.fetch;
  let seenUrl = '';
  global.fetch = async (url) => {
    seenUrl = String(url);
    return { ok: true, json: async () => ({ balance: { denom: 'uluna', amount: '21267708000000' } }) };
  };
  try {
    const p = createPayout({ lcdUrl: 'http://lcd.example', rpcUrl: '', payoutAddress: A, mnemonic: '' });
    assert.equal(await p.getGasBalance(), 21_267_708_000_000n); // 21,267.708 LUNC
    assert.match(seenUrl, /denom=uluna/);
  } finally {
    global.fetch = realFetch;
  }
});

// ── Memo on every payout send ──────────────────────────────────

test('a payout run puts the owner memo on EVERY send', async () => {
  const s = setup();
  reg(s, A); reg(s, B);
  const payout = fakePayout(2_000n * FRG1);
  const run = await runPayoutDay(s, payout,
    balances({ [A]: 1_000n * FRG1, [B]: 3_000n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.status, 'completed');
  assert.equal(payout.sent.length, 2);
  for (const send of payout.sent) assert.equal(send.memo, PAYOUT_MEMO);
});

// ── Low-gas guard ──────────────────────────────────────────────

test('low gas halts the run BEFORE any send, with a clear reason; top-up + re-press pays the same split', async () => {
  const s = setup();
  reg(s, A); reg(s, B);
  // 2 sends need a 15 LUNC reserve; the tank holds only 10 LUNC.
  const payout = fakePayout(2_000n * FRG1, { gasUluna: 10n * LUNC1 });
  const fetchB = balances({ [A]: 1_000n * FRG1, [B]: 3_000n * FRG1 });
  const halted = await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(halted.status, 'halted_gas');
  assert.equal(payout.sent.length, 0); // nothing sent — no all-fail surprise
  assert.match(halted.detail.error, /not enough LUNC for gas/);
  assert.match(halted.detail.error, /15 LUNC reserve/);
  assert.match(halted.detail.error, /holds 10 LUNC/);
  // Everything stays owed, exactly as accrued.
  assert.equal(s.claimable(A), 2_500_000n);
  assert.equal(s.claimable(B), 7_500_000n);
  // Top up the gas tank and press again: the SAME frozen split pays.
  payout.gasUluna = 100n * LUNC1;
  const run = await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.status, 'completed');
  assert.equal(payout.sent.length, 2);
  assert.equal(s.paid(A), 2_500_000n);
  assert.equal(s.paid(B), 7_500_000n);
});

test('gas at exactly the reserve boundary lets the run proceed', async () => {
  const s = setup();
  reg(s, A);
  const payout = fakePayout(2_000n * FRG1, { gasUluna: GAS_RESERVE_PER_SEND_ULUNA }); // exactly 1 send's reserve
  const run = await runPayoutDay(s, payout, balances({ [A]: 100n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.status, 'completed');
  assert.equal(payout.sent.length, 1);
});

// ── Deregister ─────────────────────────────────────────────────

test('HTTP deregister: removes the wallet from future splits; NFT exclusions untouched; admin gating holds', async (t) => {
  const s = tmpStore();
  s.setDailyPayoutUsdMicro(500_000n);
  s.setMinHoldingBase(0n);
  reg(s, OWNER); reg(s, A);
  s.setNftSettings({ excludedWallets: [B] }); // a pre-existing exclusion must survive untouched
  const payout = fakePayout(2_000n * FRG1);
  const app = createApp({
    store: s, payout,
    config: {
      lcdUrl: 'http://127.0.0.1:1', rpcUrl: '', adminWallet: ADMIN, adminSecret: 'test-secret',
      fetchBalance: balances({ [OWNER]: 1_000n * FRG1, [A]: 1_000n * FRG1 }),
      priceFeed: fakePriceFeed, autoPayout: false,
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

  // Admin view exposes the memo and the registrations list.
  const admin = await get('/api/admin', adminH);
  assert.equal(admin.status, 200);
  assert.equal(admin.body.payoutMemo, PAYOUT_MEMO);
  assert.deepEqual(admin.body.registrations.map((r) => r.wallet).sort(), [A, OWNER].sort());

  // Gating: no auth, no removal.
  const denied = await post('/api/admin/deregister', { wallet: OWNER });
  assert.equal(denied.status, 403);
  assert.notEqual(s.registrationFor(OWNER), null);

  // Invalid address is a 400, nothing removed.
  const badReq = await post('/api/admin/deregister', { wallet: 'not-an-address' }, adminH);
  assert.equal(badReq.status, 400);

  // The removal itself.
  const out = await post('/api/admin/deregister', { wallet: OWNER }, adminH);
  assert.equal(out.status, 200);
  assert.equal(out.body.removed, true);
  assert.equal(out.body.registered, 1);
  assert.equal(s.registrationFor(OWNER), null); // off the list
  assert.notEqual(s.registrationFor(A), null); // the other wallet stays
  // NFT bonus exclusion mechanism untouched by the deregister.
  assert.deepEqual(s.getNftExcludedWallets(), [B]);

  // Removing again is a harmless no-op (removed: false).
  const again = await post('/api/admin/deregister', { wallet: OWNER }, adminH);
  assert.equal(again.status, 200);
  assert.equal(again.body.removed, false);

  // The next split no longer includes the removed wallet at all.
  const run = await runPayoutDay(s, payout,
    balances({ [OWNER]: 1_000n * FRG1, [A]: 1_000n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.registeredCount, 1);
  assert.equal(s.paid(OWNER), 0n);
  assert.equal(s.accrued(OWNER), 0n);
  assert.equal(s.paid(A), 10n * FRG1); // sole remaining holder takes the pot
});

// ── Auto-pay ───────────────────────────────────────────────────

function autoSetup() {
  const s = setup();
  reg(s, A); reg(s, B);
  return s;
}
const autoFetch = balances({ [A]: 1_000n * FRG1, [B]: 3_000n * FRG1 });

test('auto-pay: no timer -> nothing runs', async () => {
  const s = autoSetup();
  const payout = fakePayout(2_000n * FRG1);
  const out = await maybeAutoPayout(s, payout, autoFetch, { now: T0, priceFeed: fakePriceFeed });
  assert.deepEqual(out, { ran: false, reason: 'no-timer' });
  assert.equal(payout.sent.length, 0);
});

test('auto-pay: timer still running -> nothing runs', async () => {
  const s = autoSetup();
  s.setSplitDeadlineMs(T0.getTime() + HOUR); // zero is an hour away
  const payout = fakePayout(2_000n * FRG1);
  const out = await maybeAutoPayout(s, payout, autoFetch, { now: T0, priceFeed: fakePriceFeed });
  assert.deepEqual(out, { ran: false, reason: 'not-due' });
  assert.equal(payout.sent.length, 0);
});

test('auto-pay: at timer zero the payout runs by itself, with the memo, and never twice', async () => {
  const s = autoSetup();
  s.setSplitDeadlineMs(T0.getTime() - 60_000); // ran out a minute ago
  const payout = fakePayout(2_000n * FRG1);
  const out = await maybeAutoPayout(s, payout, autoFetch, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(out.ran, true);
  assert.equal(out.run.status, 'completed');
  assert.equal(payout.sent.length, 2);
  for (const send of payout.sent) assert.equal(send.memo, PAYOUT_MEMO);
  assert.equal(s.paid(A), 2_500_000n);
  assert.equal(s.paid(B), 7_500_000n);
  // A later check the same day is a no-op — no double pay.
  const again = await maybeAutoPayout(s, payout, autoFetch,
    { now: new Date(T0.getTime() + HOUR), priceFeed: fakePriceFeed });
  assert.deepEqual(again, { ran: false, reason: 'already-ran' });
  assert.equal(payout.sent.length, 2);
});

test('auto-pay: a manual press BEFORE the deadline does not satisfy the day — at zero, the run fires (and pays only what is still owed)', async () => {
  const s = autoSetup();
  const deadline = T0.getTime() + 2 * HOUR;
  s.setSplitDeadlineMs(deadline);
  const payout = fakePayout(2_000n * FRG1);
  // Owner presses early (before zero): the day pays out fully.
  const early = await runPayoutDay(s, payout, autoFetch,
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(early.status, 'completed');
  assert.equal(payout.sent.length, 2);
  // At zero, auto-pay still "runs" — but the recorded day is
  // frozen and nothing is claimable, so NOTHING sends again.
  const out = await maybeAutoPayout(s, payout, autoFetch,
    { now: new Date(deadline + 60_000), priceFeed: fakePriceFeed });
  assert.equal(out.ran, true);
  assert.equal(payout.sent.length, 2); // unchanged — no double-pay
  assert.equal(s.paid(A), 2_500_000n);
  assert.equal(s.paid(B), 7_500_000n);
});

test('auto-pay: price failure at zero halts and pays nothing; a later check retries and pays', async () => {
  const s = autoSetup();
  s.setSplitDeadlineMs(T0.getTime() - 60_000);
  const payout = fakePayout(2_000n * FRG1);
  const halted = await maybeAutoPayout(s, payout, autoFetch,
    { now: T0, priceFeed: async () => { throw new Error('LCD down'); } });
  assert.equal(halted.ran, true);
  assert.equal(halted.run.status, 'halted_price');
  assert.equal(payout.sent.length, 0);
  // Price back: the next check runs the day for real.
  const out = await maybeAutoPayout(s, payout, autoFetch,
    { now: new Date(T0.getTime() + 5 * 60_000), priceFeed: fakePriceFeed });
  assert.equal(out.ran, true);
  assert.equal(out.run.status, 'completed');
  assert.equal(payout.sent.length, 2);
});

test('auto-pay: minimum-holding rule applies in the auto run too', async () => {
  const s = setup();
  s.setMinHoldingBase(100n * FRG1);
  reg(s, A); reg(s, B);
  s.setSplitDeadlineMs(T0.getTime() - 60_000);
  const payout = fakePayout(2_000n * FRG1);
  const out = await maybeAutoPayout(s, payout,
    balances({ [A]: 50n * FRG1, [B]: 300n * FRG1 }), // A below the minimum
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(out.ran, true);
  assert.equal(s.registrationFor(A), null); // removed by the rule
  assert.equal(s.paid(A), 0n);
  assert.equal(s.paid(B), 10n * FRG1);
});

test('buildPayoutTable import stays used (preview parity)', async () => {
  const s = setup();
  reg(s, A);
  const table = await buildPayoutTable(s, balances({ [A]: 100n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed, poolBalance: 2_000n * FRG1 });
  assert.equal(table.rows.length, 1);
});
