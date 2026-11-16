// Regression tests for the 2026-11-15 payout-freeze fix.
//
// Incident: the split deadline was set once (2026-11-07T13:00:41Z)
// and the live code NEVER rolled it forward. Every daily build
// filtered registrations by that frozen cutoff, so the same 8
// wallets split every pot for 8 days while 8 later registrations
// (incl. the owner's kur3) were reported as `lateRegistrations`
// and never paid. The fix: advanceSplitDeadline + self-restart
// hooks in runPayoutDay / maybeAutoPayout. The payout MODEL is
// unchanged ($0.50/day pro-rata, 2,000 FRG cap, 1,000 FRG min).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { buildPayoutTable, runPayoutDay, maybeAutoPayout, advanceSplitDeadline } from '../src/server.js';

const FRG1 = 1_000_000n;
const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;
// The real frozen deadline from production (08:00:41.704 ET).
const STALE = Date.parse('2026-11-07T13:00:41.704Z');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-fix-'));
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

// FRG = exactly $0.0005 -> the $0.50 set amount is a 1,000 FRG pot.
const FAKE_PRICE = {
  frgReserveBase: 1_000_000n * FRG1, luncReserveBase: 500_000n * FRG1,
  luncUsdMicro: 1_000n, pair: 'fake-pair',
};
const fakePriceFeed = async () => FAKE_PRICE;
const balances = (map) => async (addr) => map[addr] ?? 0n;

function reg(s, wallet, when) {
  s.registerWallet(wallet, null);
  s.recordRegistration(wallet, when);
}

const W = (c) => 'terra1' + c.repeat(38);
// The 16 production registrations, in the two sets the frozen
// cutoff created. Balances are the real weights (whole FRG,
// truncated): the paid 8 from the 2026-11-15 run record, the
// missed 8 from live LCD reads at fix time. KUR3 stands in for
// terra1kur3... with its real read: 0 FRG.
const EARLY = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(W);
const LATE = ['j', 'k', 'l', 'm', 'n', 'o', 'p', 'r'].map(W);
const KUR3 = LATE[3];
const REAL_BALANCES = {
  [EARLY[0]]: 96_201n, [EARLY[1]]: 80_931n, [EARLY[2]]: 16_567n, [EARLY[3]]: 15_941n,
  [EARLY[4]]: 7_192n, [EARLY[5]]: 2_870n, [EARLY[6]]: 2_856n, [EARLY[7]]: 1_775n,
  [LATE[0]]: 75_473n, [LATE[1]]: 30_410n, [LATE[2]]: 89_537n, [KUR3]: 0n,
  [LATE[4]]: 83_611n, [LATE[5]]: 67_564n, [LATE[6]]: 10_585n, [LATE[7]]: 56_778n,
};
const BAL = Object.fromEntries(Object.entries(REAL_BALANCES).map(([k, v]) => [k, v * FRG1]));

function incidentStore() {
  const s = tmpStore();
  s.setDailyPayoutUsdMicro(500_000n); // the owner's $0.50
  s.setMinHoldingBase(1_000n * FRG1); // the live 1,000 FRG minimum
  const D = Date.parse('2026-11-07T13:00:00.000Z');
  for (const w of EARLY) reg(s, w, D - HOUR); // in before the deadline
  for (const w of LATE) reg(s, w, D + HOUR); // registered after it
  s.setSplitDeadlineMs(D);
  return { s, D };
}

test('advanceSplitDeadline: null without a timer, future unchanged, stale steps +24h preserving wall clock', () => {
  const s = tmpStore();
  assert.equal(advanceSplitDeadline(s, Date.now()), null); // no timer
  s.setSplitDeadlineMs(STALE);
  const now = Date.parse('2026-11-15T19:00:00.000Z');
  const next = advanceSplitDeadline(s, now);
  assert.equal(next, Date.parse('2026-11-16T13:00:41.704Z')); // next 08:00 ET
  assert.equal(s.getSplitDeadlineMs(), next);
  assert.equal(advanceSplitDeadline(s, now), next); // idempotent
});

test('incident replay: frozen cutoff pays 8, the run self-restarts the timer, next day pays the late set', async () => {
  const { s, D } = incidentStore();
  const payout = fakePayout(1_000_000n * FRG1);
  const fetchB = balances(BAL);

  // Day 1 (the bug's shape): only the early 8 are in; the late 8
  // are reported, not paid — exactly what production did.
  const run1 = await runPayoutDay(s, payout, fetchB,
    { now: new Date(D + 42_000), priceFeed: fakePriceFeed });
  assert.equal(run1.status, 'completed');
  assert.equal(run1.registeredCount, 8);
  assert.deepEqual(run1.detail.lateRegistrations, LATE);
  assert.equal(payout.sent.length, 8);
  for (const w of LATE) assert.equal(s.paid(w), 0n);
  // THE FIX: the completed run rolled the deadline to the next round.
  assert.equal(run1.nextDeadlineMs, D + DAY_MS);
  assert.equal(s.getSplitDeadlineMs(), D + DAY_MS);

  // Day 2: every registration is at/before the rolled deadline —
  // the late set joins. kur3 (0 FRG, below the 1,000 FRG minimum)
  // is deregistered by the owner's min-holding rule, as designed;
  // the other 7 late wallets are paid their pro-rata shares.
  const run2 = await runPayoutDay(s, payout, fetchB,
    { now: new Date(D + DAY_MS + 42_000), priceFeed: fakePriceFeed });
  assert.equal(run2.status, 'completed');
  assert.deepEqual(run2.detail.lateRegistrations, []);
  assert.equal(run2.registeredCount, 15); // 16 minus kur3 (min-holding)
  assert.deepEqual(run2.detail.deregistered.map((d) => d.wallet), [KUR3]);
  assert.equal(s.registrationFor(KUR3), null);
  for (const w of LATE) {
    if (w !== KUR3) assert.ok(s.paid(w) > 0n, `late wallet ${w} paid on day 2`);
  }
  // Pro-rata across ALL eligible holders: day-2 amounts sum to the
  // pot, and a favored wallet's day-2 share is its weight over the
  // FULL set (smaller than its day-1 share of the same pot — the
  // favored 8 are NOT double-paid, just diluted to their true share).
  const pot = 1_000n * FRG1;
  const day2Total = run2.detail.rows.reduce((sum, r) => sum + BigInt(r.amount), 0n);
  assert.equal(day2Total, pot);
  const totalWeight = Object.entries(REAL_BALANCES)
    .filter(([w]) => w !== KUR3).reduce((sum, [, b]) => sum + b, 0n);
  const bigAmt = BigInt(run2.detail.rows.find((r) => r.wallet === EARLY[0]).amount);
  const expected = (pot * REAL_BALANCES[EARLY[0]]) / totalWeight;
  assert.ok(bigAmt - expected <= 16n && expected - bigAmt <= 16n,
    `largest holder within dust of exact pro-rata (${bigAmt} vs ${expected})`);
  const day1BigAmt = BigInt(run1.detail.rows.find((r) => r.wallet === EARLY[0]).amount);
  assert.ok(bigAmt < day1BigAmt, 'favored share shrinks to its true weight');
  // Paid ledgers are exactly the two days' frozen amounts — no more.
  assert.equal(s.paid(EARLY[0]), day1BigAmt + bigAmt);
  assert.equal(payout.sent.length, 8 + 15);
});

test('selector proof with the minimum at 0: a kur3-like late wallet IS included and paid', async () => {
  const s = tmpStore();
  s.setDailyPayoutUsdMicro(500_000n);
  s.setMinHoldingBase(0n);
  const D = Date.parse('2026-11-07T13:00:00.000Z');
  reg(s, EARLY[0], D - HOUR);
  reg(s, KUR3, D + HOUR);
  s.setSplitDeadlineMs(D);
  const fetchB = balances({ [EARLY[0]]: 50_000n * FRG1, [KUR3]: 50_000n * FRG1 });
  const payout = fakePayout(1_000_000n * FRG1);
  const run1 = await runPayoutDay(s, payout, fetchB,
    { now: new Date(D + 60_000), priceFeed: fakePriceFeed });
  assert.equal(run1.registeredCount, 1); // kur3-like still late on day 1
  const run2 = await runPayoutDay(s, payout, fetchB,
    { now: new Date(D + DAY_MS + 60_000), priceFeed: fakePriceFeed });
  assert.equal(run2.registeredCount, 2);
  assert.equal(s.paid(KUR3), 500n * FRG1); // equal holdings -> half the pot
});

test('a HALTED day does not advance the deadline; the retry pays and only then it rolls', async () => {
  const { s, D } = incidentStore();
  const payout = fakePayout(1_000_000n * FRG1);
  const fetchB = balances(BAL);
  const halted = await maybeAutoPayout(s, payout, fetchB,
    { now: new Date(D + 60_000), priceFeed: async () => { throw new Error('LCD down'); } });
  assert.equal(halted.ran, true);
  assert.equal(halted.run.status, 'halted_price');
  assert.equal(s.getSplitDeadlineMs(), D); // unchanged — the day stays due
  assert.equal(payout.sent.length, 0);
  const out = await maybeAutoPayout(s, payout, fetchB,
    { now: new Date(D + 2 * 60_000), priceFeed: fakePriceFeed });
  assert.equal(out.ran, true);
  assert.equal(out.run.status, 'completed');
  assert.equal(s.getSplitDeadlineMs(), D + DAY_MS);
});

test('production deploy moment: stale deadline + today already paid -> advance, no fire, no double pay', async () => {
  const { s } = incidentStore();
  const payout = fakePayout(1_000_000n * FRG1);
  const fetchB = balances(BAL);
  // Simulate the pre-fix record: a completed run today under the
  // stale deadline (as production's Nov 15 00:00 UTC run was).
  s.setSplitDeadlineMs(STALE);
  const run = await runPayoutDay(s, payout, fetchB,
    { now: new Date('2026-11-15T00:00:42.000Z'), priceFeed: fakePriceFeed });
  assert.equal(run.status, 'completed');
  const sentAfterRun = payout.sent.length;
  s.setSplitDeadlineMs(STALE); // the pre-fix store still holds the stale value
  const out = await maybeAutoPayout(s, payout, fetchB,
    { now: new Date('2026-11-15T19:00:00.000Z'), priceFeed: fakePriceFeed });
  assert.deepEqual(out, { ran: false, reason: 'already-ran' });
  assert.equal(payout.sent.length, sentAfterRun); // nothing re-sent
  assert.equal(s.getSplitDeadlineMs(), Date.parse('2026-11-16T13:00:41.704Z'));
});

test('day-flip guard: a stale deadline after the UTC flip does not fire a spurious run', async () => {
  const { s, D } = incidentStore();
  const payout = fakePayout(1_000_000n * FRG1);
  const fetchB = balances(BAL);
  const out1 = await maybeAutoPayout(s, payout, fetchB,
    { now: new Date(D + 60_000), priceFeed: fakePriceFeed });
  assert.equal(out1.ran, true);
  const sent = payout.sent.length;
  s.setSplitDeadlineMs(D); // stale again (reset by an old admin action)
  const flip = new Date('2026-11-08T00:30:00.000Z'); // 30 min after the UTC flip
  const out2 = await maybeAutoPayout(s, payout, fetchB, { now: flip, priceFeed: fakePriceFeed });
  assert.deepEqual(out2, { ran: false, reason: 'already-ran' });
  assert.equal(payout.sent.length, sent);
  assert.equal(s.getSplitDeadlineMs(), D + DAY_MS);
});

test('auto-pay sustains itself day after day with the late set included', async () => {
  const { s, D } = incidentStore();
  const payout = fakePayout(1_000_000n * FRG1);
  const fetchB = balances(BAL);
  const out1 = await maybeAutoPayout(s, payout, fetchB,
    { now: new Date(D + 60_000), priceFeed: fakePriceFeed });
  assert.equal(out1.ran, true);
  assert.equal(s.getSplitDeadlineMs(), D + DAY_MS);
  const out2 = await maybeAutoPayout(s, payout, fetchB,
    { now: new Date(D + DAY_MS + 60_000), priceFeed: fakePriceFeed });
  assert.equal(out2.ran, true);
  assert.equal(s.getSplitDeadlineMs(), D + 2 * DAY_MS);
  // Day 2's run is the first with the late set in (15 eligible).
  assert.equal(out2.run.registeredCount, 15);
});
