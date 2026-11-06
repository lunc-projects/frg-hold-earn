// Pot-model tests (the owner's design, 2026-11-05): each day is its
// own round — the daily pot empties to the wallets that REGISTERED
// that day, pro-rata by their snapshot FRG balances. Exercised
// through runSnapshot + the real store, the way production runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { runSnapshot } from '../src/server.js';
import { FRG_TOKEN } from '../src/assets.js';

const A = 'terra1' + 'a'.repeat(38);
const B = 'terra1' + 'q'.repeat(38);
const FRG1 = 1_000_000n;
const DAY1 = '2026-11-05';
const DAY2 = '2026-11-06';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-pot-'));
  return openStore(path.join(dir, 'test.db'));
}

const balances = (map) => async (addr) => map[addr] ?? 0n;

test('the pot empties completely to the day\'s registered wallets, pro-rata by balance', async () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  s.registerWallet(B, null);
  s.registerForDay(DAY1, A);
  s.registerForDay(DAY1, B);
  s.setDailyPool(10n * FRG1); // pot: 10 FRG
  await runSnapshot(s, balances({ [A]: 3n * FRG1, [B]: 1n * FRG1 }), DAY1);
  assert.equal(s.accrued(A), 7_500_000n);
  assert.equal(s.accrued(B), 2_500_000n);
  assert.equal(s.totalAccrued(), 10n * FRG1); // exactly the pot — nothing left, nothing over
});

test('an unregistered wallet earns 0 that day, even with a huge balance', async () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  s.registerWallet(B, null);
  s.registerForDay(DAY1, A); // only A is in today's round
  s.setDailyPool(10n * FRG1);
  await runSnapshot(s, balances({ [A]: 1n * FRG1, [B]: 999n * FRG1 }), DAY1);
  assert.equal(s.accrued(B), 0n); // 999 FRG held, never registered today
  assert.equal(s.accrued(A), 10n * FRG1); // sole registrant takes the pot, by balance among registrants
});

test('registering after the day ends earns 0 for that day', async () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  // A's registration belongs to DAY2 — the next day's round.
  s.registerForDay(DAY2, A);
  s.setDailyPool(10n * FRG1);
  // DAY1's round runs with nobody registered for DAY1.
  const out = await runSnapshot(s, balances({ [A]: 100n * FRG1 }), DAY1);
  assert.equal(out.registered, 0);
  assert.equal(s.accrued(A), 0n);
  // DAY2's round: A is in, and earns normally.
  await runSnapshot(s, balances({ [A]: 100n * FRG1 }), DAY2);
  assert.equal(s.accrued(A), 10n * FRG1);
});

test('a registered wallet holding 0 FRG earns 0', async () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  s.registerWallet(B, null);
  s.registerForDay(DAY1, A);
  s.registerForDay(DAY1, B);
  s.setDailyPool(10n * FRG1);
  await runSnapshot(s, balances({ [A]: 0n, [B]: 5n * FRG1 }), DAY1);
  assert.equal(s.accrued(A), 0n);
  assert.equal(s.accrued(B), 10n * FRG1);
});

test('pot 0: nothing accrues even for registered holders', async () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  s.registerForDay(DAY1, A);
  assert.equal(s.getDailyPool(), 0n); // default: off
  await runSnapshot(s, balances({ [A]: 1000n * FRG1 }), DAY1);
  assert.equal(s.accrued(A), 0n);
});

test('registration is per-day: yesterday\'s registration is not in today\'s round', async () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  s.registerForDay(DAY1, A);
  assert.equal(s.isRegisteredForDay(DAY1, A), true);
  assert.equal(s.isRegisteredForDay(DAY2, A), false); // does not carry over
  // Registering twice the same day is one entry.
  const again = s.registerForDay(DAY1, A);
  assert.equal(again.alreadyRegistered, true);
  assert.deepEqual(s.dayRegistrations(DAY1), [A]);
});

test('past days\' distributions never change when new wallets register later', async () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  s.registerForDay(DAY1, A);
  s.setDailyPool(10n * FRG1);
  await runSnapshot(s, balances({ [A]: 5n * FRG1 }), DAY1);
  assert.equal(s.accrued(A), 10n * FRG1);
  // B arrives and registers for DAY2.
  s.registerWallet(B, null);
  s.registerForDay(DAY2, B);
  s.registerForDay(DAY2, A);
  // Re-running DAY1 is refused outright (idempotent) — B cannot
  // reach back into it, and A's day-1 amount is frozen.
  const rerun = await runSnapshot(s, balances({ [A]: 5n * FRG1, [B]: 5n * FRG1 }), DAY1);
  assert.equal(rerun.skipped, true);
  assert.equal(s.accrued(A), 10n * FRG1);
  assert.equal(s.accrued(B), 0n);
  // DAY2 runs fresh: equal balances split the pot evenly.
  await runSnapshot(s, balances({ [A]: 5n * FRG1, [B]: 5n * FRG1 }), DAY2);
  assert.equal(s.accrued(A), 15n * FRG1);
  assert.equal(s.accrued(B), 5n * FRG1);
});

test('store reports the live reward asset as FRG after both migrations', () => {
  const s = tmpStore();
  assert.equal(s.getRewardSymbol(), 'FRG');
  const migrations = s.getRewardCurrencyMigrations();
  assert.equal(migrations.length, 2);
  assert.equal(migrations[0].fromSymbol, 'FRG');
  assert.equal(migrations[0].toSymbol, 'USTC');
  assert.equal(migrations[1].fromSymbol, 'USTC');
  assert.equal(migrations[1].toSymbol, 'FRG');
  assert.equal(migrations[1].toDenom, FRG_TOKEN);
});
