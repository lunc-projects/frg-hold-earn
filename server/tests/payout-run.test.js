// Payout-run tests (the owner's FINAL model, 2026-11-05):
// paste-register ONCE (permanent) -> the day's pot =
// min(daily payout amount converted at the run's live price,
// 2,000 FRG hard limit, pool balance) -> SIMPLE pro-rata split of
// the pot by holdings -> the owner presses the button -> sends
// from the payout wallet. No tiers anywhere. At each build, a
// registered wallet below the minimum-holding limit is removed
// from registration entirely.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { buildPayoutTable, runPayoutDay, createApp } from '../src/server.js';
import { amountBaseForUsd } from '../src/price.js';

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
// At the fake price, $0.50 (the owner's set amount) = exactly 10 FRG.
const USD_050 = 500_000n;

const balances = (map) => async (addr) => map[addr] ?? 0n;

// payoutMicro: the daily payout amount (micro-USD). Default is the
// owner's $0.50. limitBase: default null = the shipped 2,000 FRG.
// minHoldingBase: tests default to 0 (rule off) so the shipped
// 100 FRG PLACEHOLDER default never interferes; the min-holding
// tests set it explicitly.
function setup({ payoutMicro = USD_050, limitBase = null, minHoldingBase = 0n } = {}) {
  const s = tmpStore();
  s.setDailyPayoutUsdMicro(payoutMicro);
  if (limitBase !== null) s.setDailyLimitBase(limitBase);
  s.setMinHoldingBase(minHoldingBase);
  return s;
}

function reg(s, wallet, when = T0.getTime() - HOUR) {
  s.registerWallet(wallet, null);
  s.recordRegistration(wallet, when);
}

test('normal day pays the SET AMOUNT worth — not the 2,000 limit', async () => {
  const s = setup(); // $0.50 set amount, 2,000 FRG hard limit
  reg(s, A);
  const payout = fakePayout(2_000n * FRG1);
  const run = await runPayoutDay(s, payout, balances({ [A]: 3_700n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.status, 'completed');
  assert.equal(run.potBase, 10n * FRG1); // $0.50 at $0.05/FRG — the limit is NOT the pot
  assert.equal(run.totalSplit, 10n * FRG1);
  assert.equal(run.totalPaid, 10n * FRG1);
  assert.equal(payout.balance, 1_990n * FRG1); // the pool keeps the rest
  assert.equal(payout.sent.length, 1);
  assert.equal(run.detail.rows[0].txhash, 'TX1'); // recorded with tx hash
  assert.equal(run.registeredCount, 1);
});

test('split sums exactly to the pot and follows holdings, not headcount', async () => {
  const s = setup();
  reg(s, A); reg(s, B);
  const payout = fakePayout(2_000n * FRG1);
  const run = await runPayoutDay(s, payout,
    balances({ [A]: 1_000n * FRG1, [B]: 3_000n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.totalPaid, 10n * FRG1); // exactly the pot
  assert.equal(s.paid(A), 2_500_000n); // 1/4 of the holdings -> 2.5 FRG
  assert.equal(s.paid(B), 7_500_000n); // 3/4 -> 7.5 FRG
});

test('set amount over the hard limit: the day pays EXACTLY 2,000 FRG', async () => {
  assert.equal(amountBaseForUsd(500_000_000n, FAKE_PRICE), 10_000n * FRG1); // $500 -> 10,000 FRG
  const s = setup({ payoutMicro: 500_000_000n }); // owner set $500/day
  reg(s, A);
  const payout = fakePayout(5_000n * FRG1); // pool holds plenty
  const run = await runPayoutDay(s, payout, balances({ [A]: 100n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.potBase, 2_000n * FRG1); // the hard limit binds
  assert.equal(run.totalPaid, 2_000n * FRG1); // exactly the limit, never more
  assert.equal(payout.balance, 3_000n * FRG1);
  assert.equal(run.detail.limitBase, '2000000000'); // the limit is in the run record
});

test('hard limit is never exceeded even with a huge pool and a huge set amount', async () => {
  const s = setup({ payoutMicro: 500_000_000n });
  reg(s, A); reg(s, B);
  const payout = fakePayout(1_000_000n * FRG1);
  const run = await runPayoutDay(s, payout,
    balances({ [A]: 1_000_000n * FRG1, [B]: 1_000_000n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.totalPaid, 2_000n * FRG1);
  assert.equal(s.paid(A) + s.paid(B), 2_000n * FRG1);
});

test('pool smaller than the pot: the day pays only what the pool holds', async () => {
  const s = setup(); // pot would be 10 FRG
  reg(s, A);
  const payout = fakePayout(4n * FRG1); // pool holds only 4 FRG
  const run = await runPayoutDay(s, payout, balances({ [A]: 100n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.potBase, 4n * FRG1); // min(amount, limit, POOL)
  assert.equal(run.totalPaid, 4n * FRG1);
  assert.equal(payout.balance, 0n);
});

test('payout amount 0/unset: nothing pays and no price is consulted', async () => {
  const s = setup({ payoutMicro: 0n });
  reg(s, A);
  const payout = fakePayout(2_000n * FRG1);
  const run = await runPayoutDay(s, payout, balances({ [A]: 100n * FRG1 }),
    { now: T0, priceFeed: noPriceFeed });
  assert.equal(run.status, 'completed');
  assert.equal(run.potBase, 0n);
  assert.equal(run.totalPaid, 0n);
  assert.equal(payout.sent.length, 0);
  assert.equal(s.accrued(A), 0n);
});

test('price conversion is exact: $0.50 at a $0.05 FRG price is a 10 FRG pot', async () => {
  assert.equal(amountBaseForUsd(USD_050, FAKE_PRICE), 10n * FRG1);
});

test('price-feed failure halts the run and pays nothing; a later press still works', async () => {
  const s = setup();
  reg(s, A);
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
  assert.equal(run.totalPaid, 10n * FRG1);
});

test('a 1-token holder among large holders: dust share carries, the rest pays', async () => {
  const s = setup();
  reg(s, A); reg(s, B);
  const payout = fakePayout(2_000n * FRG1);
  const run = await runPayoutDay(s, payout,
    balances({ [A]: 1n * FRG1, [B]: 999_999n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  // A's share of the 10 FRG pot: 10 base units... exactly 10n base
  // units of FRG — dust, below the 1 FRG send threshold, so it
  // carries as accrued; B is paid the rest of the pot.
  assert.equal(s.accrued(A), 10n);
  assert.equal(run.detail.rows.find((r) => r.wallet === A).payStatus, 'carried-dust');
  assert.equal(payout.sent.length, 1);
  assert.equal(s.paid(B), 10n * FRG1 - 10n);
  assert.equal(s.accrued(A) + s.paid(B), 10n * FRG1); // the split still sums to the pot
});

test('sole registrant receives the full pot', async () => {
  const s = setup();
  reg(s, A);
  const payout = fakePayout(2_000n * FRG1);
  const run = await runPayoutDay(s, payout, balances({ [A]: 42n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.totalPaid, 10n * FRG1); // the whole $0.50 pot, whatever they hold
});

test('zero-balance registrant gets 0 while holders split the pot', async () => {
  const s = setup();
  reg(s, A); reg(s, B);
  const payout = fakePayout(2_000n * FRG1);
  const run = await runPayoutDay(s, payout,
    balances({ [A]: 0n, [B]: 100n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(s.paid(A), 0n);
  assert.equal(s.accrued(A), 0n);
  assert.equal(s.paid(B), 10n * FRG1); // the full pot follows the holdings
  assert.equal(run.totalPaid, 10n * FRG1);
});

test('one-time registration: registered 30 DAYS ago is IN; never-registered is OUT; re-pasting is harmless', async () => {
  const s = setup();
  const DAY_MS = 24 * HOUR;
  reg(s, A, T0.getTime() - 30 * DAY_MS); // pasted a month ago — still registered
  reg(s, B, T0.getTime() - 23 * HOUR);
  s.recordRegistration(B, T0.getTime() - HOUR); // re-paste: harmless refresh, still in
  // C holds FRG but NEVER pasted its address: not registered, not in.
  const fetchB = balances({ [A]: 1_000n * FRG1, [B]: 1_000n * FRG1, [C]: 1_000n * FRG1 });
  const table = await buildPayoutTable(s, fetchB,
    { now: T0, priceFeed: fakePriceFeed, poolBalance: 2_000n * FRG1 });
  assert.equal(table.registeredCount, 2); // A + B — the count the owner will check
  assert.deepEqual(table.rows.map((r) => r.wallet), [A, B]); // rows are wallet-sorted; no C
  const payout = fakePayout(2_000n * FRG1);
  await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(s.paid(A), 5n * FRG1); // equal holdings -> equal halves of the 10 FRG pot
  assert.equal(s.paid(B), 5n * FRG1);
  assert.equal(s.accrued(C), 0n); // never registered: nothing, whatever it holds
  assert.equal(s.paid(C), 0n);
});

test('minimum holding: a wallet AT exactly the limit stays registered and is paid', async () => {
  const s = setup({ minHoldingBase: 100n * FRG1 });
  reg(s, A); reg(s, B);
  const payout = fakePayout(2_000n * FRG1);
  const run = await runPayoutDay(s, payout,
    balances({ [A]: 100n * FRG1, [B]: 300n * FRG1 }), // A holds EXACTLY the limit
    { now: T0, priceFeed: fakePriceFeed });
  assert.deepEqual(run.detail.deregistered, []);
  assert.notEqual(s.registrationFor(A), null); // still on the list
  assert.equal(s.paid(A), 2_500_000n); // 1/4 of the holdings -> 2.5 FRG of the pot
  assert.equal(s.paid(B), 7_500_000n);
});

test('minimum holding: 1 base unit BELOW the limit is removed entirely — nothing that day, absent later', async () => {
  const s = setup({ minHoldingBase: 100n * FRG1 });
  reg(s, A); reg(s, B);
  const payout = fakePayout(2_000n * FRG1);
  const fetchB = balances({ [A]: 100n * FRG1 - 1n, [B]: 300n * FRG1 }); // A is 1 unit short
  const run = await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.detail.deregistered.length, 1);
  assert.equal(run.detail.deregistered[0].wallet, A);
  assert.equal(s.registrationFor(A), null); // OFF the registration list
  assert.equal(s.accrued(A), 0n); // receives nothing that day
  assert.equal(s.paid(A), 0n);
  assert.equal(s.paid(B), 10n * FRG1); // B, the sole survivor, takes the whole pot
  // Next day: A's balance is back above the limit, but A is NOT
  // re-registered by holding — it stays out until it pastes again.
  const T1 = new Date(T0.getTime() + 24 * HOUR);
  const fetchB2 = balances({ [A]: 500n * FRG1, [B]: 300n * FRG1 });
  const table2 = await buildPayoutTable(s, fetchB2,
    { now: T1, priceFeed: fakePriceFeed, poolBalance: 2_000n * FRG1 });
  assert.deepEqual(table2.rows.map((r) => r.wallet), [B]);
  assert.equal(table2.registeredCount, 1);
});

test('minimum holding: re-registering after topping up works — paste again and the wallet is back in', async () => {
  const s = setup({ minHoldingBase: 100n * FRG1 });
  reg(s, A); reg(s, B);
  const payout = fakePayout(2_000n * FRG1);
  // Day 1: A is below the limit and is removed.
  await runPayoutDay(s, payout,
    balances({ [A]: 50n * FRG1, [B]: 300n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(s.registrationFor(A), null);
  assert.equal(s.paid(B), 10n * FRG1);
  // A tops up and pastes its address again -> registered again.
  s.registerWallet(A, null);
  s.recordRegistration(A, T0.getTime() + 25 * HOUR);
  const T1 = new Date(T0.getTime() + 24 * HOUR);
  const run2 = await runPayoutDay(s, payout,
    balances({ [A]: 300n * FRG1, [B]: 300n * FRG1 }),
    { now: T1, priceFeed: fakePriceFeed });
  assert.equal(run2.status, 'completed');
  assert.notEqual(s.registrationFor(A), null);
  assert.equal(s.paid(A), 5n * FRG1); // equal holdings -> half the day-2 pot
  assert.equal(s.paid(B), 15n * FRG1); // 10 (day 1) + 5 (day 2)
});

test('idempotent press: pressing twice pays once', async () => {
  const s = setup();
  reg(s, A);
  const payout = fakePayout(2_000n * FRG1);
  const fetchB = balances({ [A]: 3_700n * FRG1 });
  await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  const run2 = await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(payout.sent.length, 1);
  assert.equal(run2.totalPaid, 10n * FRG1);
  assert.equal(s.paid(A), 10n * FRG1);
});

test('recorded day is frozen: changing the amount or limit afterwards changes nothing', async () => {
  const s = setup();
  reg(s, A);
  const payout = fakePayout(5_000n * FRG1);
  const fetchB = balances({ [A]: 1_000n * FRG1 });
  await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(s.paid(A), 10n * FRG1);
  s.setDailyPayoutUsdMicro(500_000_000n); // owner cranks the amount
  s.setDailyLimitBase(5n * FRG1); // ...and slashes the limit
  const again = await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(again.totalPaid, 10n * FRG1); // day 1 frozen at its recorded split
  assert.equal(payout.sent.length, 1);
  // The NEXT day uses the new numbers: amount $500 -> 10,000 FRG,
  // limit 5 FRG -> pot 5 FRG.
  const T1 = new Date(T0.getTime() + 24 * HOUR);
  s.recordRegistration(A, T1.getTime() - HOUR);
  const run2 = await runPayoutDay(s, payout, fetchB, { now: T1, priceFeed: fakePriceFeed });
  assert.equal(run2.potBase, 5n * FRG1);
  assert.equal(s.paid(A), 15n * FRG1);
});

test('past days are never re-paid when new wallets register later', async () => {
  const s = setup();
  reg(s, A);
  const payout = fakePayout(2_000n * FRG1);
  const fetchB = balances({ [A]: 1_000n * FRG1, [B]: 1_000n * FRG1 });
  await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(s.paid(A), 10n * FRG1);
  // B registers AFTER day 1's run and the owner re-presses day 1:
  // B gets nothing for day 1 and A is not paid again.
  reg(s, B, T0.getTime() + 30 * 60_000);
  await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(s.paid(B), 0n);
  assert.equal(s.paid(A), 10n * FRG1);
  assert.equal(payout.sent.length, 1);
});

test('sub-dust share carries forward instead of sending, then pays combined', async () => {
  // Day 1: set amount $0.025 -> pot 0.5 FRG (sole holder A).
  const s = setup({ payoutMicro: 25_000n });
  reg(s, A);
  const payout = fakePayout(2_000n * FRG1);
  const run1 = await runPayoutDay(s, payout, balances({ [A]: 100n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  assert.equal(payout.sent.length, 0); // never send dust
  assert.equal(run1.detail.rows[0].payStatus, 'carried-dust');
  assert.equal(s.accrued(A), 500_000n); // 0.5 FRG carried
  // Day 2: set amount $0.03 -> pot 0.6 FRG; combined 1.1 FRG sends.
  s.setDailyPayoutUsdMicro(30_000n);
  const T1 = new Date(T0.getTime() + 24 * HOUR);
  s.recordRegistration(A, T1.getTime() - HOUR);
  const run2 = await runPayoutDay(s, payout, balances({ [A]: 100n * FRG1 }),
    { now: T1, priceFeed: fakePriceFeed });
  assert.equal(run2.status, 'completed');
  assert.equal(payout.sent.length, 1);
  assert.equal(payout.sent[0].amount, 1_100_000n); // 0.6 + carried 0.5
  assert.equal(s.claimable(A), 0n);
});

test('pool guard at send time: pool drained after the table was built scales sends down, shortfall stays owed', async () => {
  const s = setup(); // pot 10 FRG
  reg(s, A);
  // A payout wallet whose balance drops between the table build
  // (which reads it to bound the pot) and the pay phase — e.g. the
  // NFT bonus path paid FRG out of the same wallet in between.
  const payout = fakePayout(2_000n * FRG1);
  let reads = 0;
  const realGet = payout.getRewardBalance;
  payout.getRewardBalance = async () => {
    reads++;
    return reads === 1 ? realGet() : 3n * FRG1; // only 3 FRG left by send time
  };
  const fetchB = balances({ [A]: 100n * FRG1 });
  const run = await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run.potBase, 10n * FRG1); // the table was built against the full pool
  assert.equal(run.status, 'partial_pool');
  assert.equal(run.totalPaid, 3n * FRG1); // exactly what the pool actually held
  assert.equal(run.shortfall, 7n * FRG1); // honestly recorded
  assert.equal(s.claimable(A), 7n * FRG1); // the shortfall stays owed
  // Pool refilled; a re-press the same day pays the remainder —
  // never double-paying the first part.
  payout.getRewardBalance = realGet;
  payout.balance = 100n * FRG1;
  const run2 = await runPayoutDay(s, payout, fetchB, { now: T0, priceFeed: fakePriceFeed });
  assert.equal(run2.totalPaid, 10n * FRG1);
  assert.equal(s.claimable(A), 0n);
  assert.equal(s.paid(A), 10n * FRG1);
});

test('HTTP: preview shows the window count + split table; the payout button pays; admin gating holds', async (t) => {
  const s = tmpStore();
  s.setDailyPayoutUsdMicro(USD_050);
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

  // Paste-register over HTTP (no wallet connect exists in this app).
  const reg1 = await post('/api/register', { address: A, referrer: null });
  assert.equal(reg1.status, 200);
  assert.equal(reg1.body.registered, true); // one-time, permanent — no window fields
  assert.equal(reg1.body.windowHours, undefined);
  const preview = await get('/api/admin/payout-preview', adminH);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.registeredCount, 1); // total registered count
  assert.equal(preview.body.minHoldingWhole, '100'); // shipped PLACEHOLDER default
  assert.deepEqual(preview.body.deregistered, []);
  assert.equal(preview.body.rows[0].amountWhole, '10'); // sole holder: the full $0.50 pot
  assert.equal(preview.body.rows[0].sharePct, 100);
  assert.equal(preview.body.dailyPayoutUsd, 0.5); // the set amount, distinct...
  assert.equal(preview.body.limitWhole, '2000'); // ...from the hard limit
  assert.equal(preview.body.poolBalanceWhole, '2000');
  assert.equal(preview.body.poolRemainderWhole, '1990'); // pool keeps the rest
  // The button refuses without admin auth...
  const denied = await post('/api/admin/payout', {});
  assert.equal(denied.status, 403);
  assert.equal(payout.sent.length, 0);
  // ...and pays with it.
  const run = await post('/api/admin/payout', {}, adminH);
  assert.equal(run.status, 200);
  assert.equal(run.body.status, 'completed');
  assert.equal(run.body.totalPaid, '10000000');
  assert.equal(run.body.totalSplit, '10000000');
  assert.equal(payout.sent.length, 1);
  // The two numbers are set through two distinct endpoints.
  const setAmount = await post('/api/admin/payout-amount', { amountUsd: 1.25 }, adminH);
  assert.equal(setAmount.status, 200);
  assert.equal(setAmount.body.dailyPayoutUsd, 1.25);
  const setLimit = await post('/api/admin/limit', { limitWhole: '3000' }, adminH);
  assert.equal(setLimit.status, 200);
  assert.equal(setLimit.body.dailyLimitWhole, '3000');
  const badLimit = await post('/api/admin/limit', { limitWhole: '-5' }, adminH);
  assert.equal(badLimit.status, 400);
  // The minimum holding is set through its own endpoint.
  const setMin = await post('/api/admin/min-holding', { limitWhole: '250' }, adminH);
  assert.equal(setMin.status, 200);
  assert.equal(setMin.body.minHoldingWhole, '250');
  const badMin = await post('/api/admin/min-holding', { limitWhole: '-5' }, adminH);
  assert.equal(badMin.status, 400);
  // The tier endpoint is GONE (raw fetch: the 404 body is not JSON).
  const tiersGone = await fetch(`${base}/api/admin/tiers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...adminH },
    body: JSON.stringify({ tiers: [] }),
  });
  assert.equal(tiersGone.status, 404);
});
