// Sampling tests: hourly balance samples, daily averages, and the
// snapshot splitting on averages (with live-read fallback). The point
// of the upgrade: a balance held for one hour must earn ~1/24 of the
// weight of the same balance held all day.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { runBalanceSampling, buildPayoutTable, runPayoutDay } from '../src/server.js';

const A = 'terra1' + 'a'.repeat(38);
const B = 'terra1' + 'q'.repeat(38);
const C = 'terra1' + 'p'.repeat(38);
const FRG = 1_000_000n; // 1 FRG in base units
const DAY = '2026-10-25';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-sampling-'));
  return openStore(path.join(dir, 'test.db'));
}

function sampleDay(store, wallet, day, balancesByHour) {
  for (const [hour, balance] of balancesByHour) {
    store.recordBalanceSample(day, wallet, hour, balance);
  }
}

test('averageBalances: exact mean of the day samples', () => {
  const s = tmpStore();
  sampleDay(s, A, DAY, [[0, 100n * FRG], [1, 200n * FRG], [2, 300n * FRG]]);
  const avgs = s.averageBalances(DAY);
  assert.equal(avgs.get(A).average, 200n * FRG);
  assert.equal(avgs.get(A).samples, 3);
  // A day with no samples yields an empty map (callers fall back).
  assert.equal(s.averageBalances('2026-10-26').size, 0);
});

test('averageBalances: integer division drops sub-unit dust only', () => {
  const s = tmpStore();
  sampleDay(s, A, DAY, [[0, 1n], [1, 2n]]); // mean of 1 and 2 base units
  assert.equal(s.averageBalances(DAY).get(A).average, 1n);
});

test('re-sampling the same hour replaces that hour (latest wins)', () => {
  const s = tmpStore();
  s.recordBalanceSample(DAY, A, 5, 100n);
  s.recordBalanceSample(DAY, A, 5, 400n);
  const avgs = s.averageBalances(DAY);
  assert.equal(avgs.get(A).samples, 1);
  assert.equal(avgs.get(A).average, 400n);
});

test('pruneSamples removes only days before the cutoff', () => {
  const s = tmpStore();
  s.recordBalanceSample('2026-10-01', A, 0, 1n);
  s.recordBalanceSample(DAY, A, 0, 2n);
  s.pruneSamples('2026-10-18');
  assert.equal(s.sampleStats('2026-10-01').samples, 0);
  assert.equal(s.sampleStats(DAY).samples, 1);
});

test('runBalanceSampling records every wallet; one failure blocks nobody', async () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  s.registerWallet(B, null);
  const fetchBalance = async (addr) => {
    if (addr === B) throw new Error('lcd down for this one');
    return 500n * FRG;
  };
  const out = await runBalanceSampling(s, fetchBalance, new Date('2026-10-25T13:05:00Z'));
  assert.deepEqual(out, { day: DAY, hour: 13, sampled: 1, failed: 1 });
  assert.equal(s.averageBalances(DAY).get(A).average, 500n * FRG);
  assert.equal(s.averageBalances(DAY).has(B), false);
});

test('payout table splits on AVERAGES: flash-holding one hour earns 1/24 weight', async () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  s.registerWallet(B, null);
  s.registerWallet(C, null);
  // Final model: all three registered inside the rolling 24h window;
  // a 100% base tier makes owed == the balance the table uses, so the
  // table's balances ARE the averaging proof.
  const now = new Date('2026-10-25T23:00:00Z');
  for (const w of [A, B, C]) s.recordRegistration(w, now.getTime() - 3_600_000);
  s.setRewardTiers([{ minBase: 0n, pctBps: 10000 }]); // 100%/day test tier
  s.setDailyCapUsdMicro(0n); // cap off: no price feed needed
  // A flash-holds 2,400 FRG for exactly one hour, holds 0 the other 23.
  sampleDay(s, A, DAY, [[0, 2400n * FRG], ...Array.from({ length: 23 }, (_, i) => [i + 1, 0n])]);
  // B steadily holds 100 FRG all 24 hours.
  sampleDay(s, B, DAY, Array.from({ length: 24 }, (_, h) => [h, 100n * FRG]));
  // C has NO samples: falls back to a live read of 300 FRG.
  const fetchBalance = async (addr) => (addr === C ? 300n * FRG : 9999n * FRG);
  const table = await buildPayoutTable(s, fetchBalance, { now });
  const owed = Object.fromEntries(table.rows.map((r) => [r.wallet, r.owed]));
  // Weights: A avg 100, B avg 100, C live 300 -> owed 100/100/300 at 100%.
  assert.equal(owed[A], 100n * FRG);
  assert.equal(owed[B], 100n * FRG);
  assert.equal(owed[C], 300n * FRG);
  assert.deepEqual(table.balanceSource, { averaged: 2, live: 1 });
});

test('payout run with samples present pays exactly once per day', async () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  const now = new Date('2026-10-25T23:00:00Z');
  s.recordRegistration(A, now.getTime() - 3_600_000);
  s.setRewardTiers([{ minBase: 0n, pctBps: 10000 }]); // owed == balance
  s.setDailyCapUsdMicro(0n);
  sampleDay(s, A, DAY, [[0, 50n * FRG]]); // average balance: 50 FRG
  const sent = [];
  const payout = {
    configured: true,
    getRewardBalance: async () => 1_000_000n * FRG,
    sendReward: async (to, amount) => { sent.push({ to, amount }); return 'TX1'; },
  };
  const fetchBalance = async () => 1n; // samples exist, so this is never used for A
  const first = await runPayoutDay(s, payout, fetchBalance, { now });
  assert.equal(first.status, 'completed');
  assert.equal(s.paid(A), 50n * FRG); // the average, paid once
  const second = await runPayoutDay(s, payout, fetchBalance, { now });
  assert.equal(second.status, 'completed');
  assert.equal(s.paid(A), 50n * FRG); // never twice
  assert.equal(sent.length, 1);
});
