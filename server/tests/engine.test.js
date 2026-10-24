// Engine tests: pro-rata split, affiliate bonus, snapshot gaming, parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeShares, computeBonuses, computeDay,
  parseWholeToBase, formatBaseToWhole, isValidTerraAddress,
} from '../src/engine.js';

const A = 'terra1' + 'a'.repeat(38);
const B = 'terra1' + 'q'.repeat(38);
const C = 'terra1' + 'p'.repeat(38);

test('pro-rata split sums exactly to the pool', () => {
  const shares = computeShares(1_000_000n, [
    { wallet: A, balance: 600_000n }, { wallet: B, balance: 400_000n },
  ]);
  assert.equal(shares.find((s) => s.wallet === A).amount, 600_000n);
  assert.equal(shares.find((s) => s.wallet === B).amount, 400_000n);
  assert.equal(shares.reduce((s, x) => s + x.amount, 0n), 1_000_000n);
});

test('dust goes to the largest holder, sum still equals pool', () => {
  const shares = computeShares(100n, [
    { wallet: A, balance: 1n }, { wallet: B, balance: 1n }, { wallet: C, balance: 1n },
  ]);
  assert.equal(shares.reduce((s, x) => s + x.amount, 0n), 100n);
  assert.deepEqual(shares.map((s) => s.amount).sort(), [33n, 33n, 34n]);
});

test('zero pool and zero total pay zero', () => {
  assert.deepEqual(computeShares(0n, [{ wallet: A, balance: 5n }]).map((s) => s.amount), [0n]);
  assert.deepEqual(computeShares(100n, [{ wallet: A, balance: 0n }]).map((s) => s.amount), [0n]);
  assert.deepEqual(computeShares(100n, []).map((s) => s.amount), []);
});

test('zero-balance holders earn zero', () => {
  const { shares } = computeDay(1_000n, [
    { wallet: A, balance: 10n }, { wallet: B, balance: 0n },
  ], new Map(), 1000);
  assert.equal(shares.find((s) => s.wallet === B).amount, 0n);
});

test('affiliate bonus is extra, never deducted from the referral', () => {
  const shares = [{ wallet: A, amount: 1000n }, { wallet: B, amount: 500n }];
  const bonuses = computeBonuses(shares, new Map([[B, A]]), 1000); // 10%
  assert.equal(bonuses.find((b) => b.wallet === A).amount, 50n);
  // Referral's own share untouched by the bonus computation.
  assert.equal(shares.find((s) => s.wallet === B).amount, 500n);
});

test('self-referral earns no bonus', () => {
  const bonuses = computeBonuses([{ wallet: A, amount: 1000n }], new Map([[A, A]]), 1000);
  assert.equal(bonuses.length, 0);
});

test('snapshot gaming: no snapshot day means no earnings for that day', () => {
  // Day 1 snapshot covers only A. B registers later and holds on day 2.
  const day1 = computeDay(1_000n, [{ wallet: A, balance: 1000n }], new Map([[B, A]]), 1000);
  assert.equal(day1.shares.find((s) => s.wallet === A).amount, 1000n);
  assert.equal(day1.shares.some((s) => s.wallet === B), false);
  assert.equal(day1.bonuses.length, 0); // A has no referrer; B wasn't in the snapshot
  const day2 = computeDay(1_000n, [
    { wallet: A, balance: 1000n }, { wallet: B, balance: 1000n },
  ], new Map([[B, A]]), 1000);
  assert.equal(day2.shares.find((s) => s.wallet === B).amount, 500n);
  assert.equal(day2.bonuses.find((b) => b.wallet === A).amount, 50n);
});

test('amount parsing is exact, no floats', () => {
  assert.equal(parseWholeToBase('1234.5'), 1234500000n);
  assert.equal(parseWholeToBase('0.000001'), 1n);
  assert.equal(parseWholeToBase('1000'), 1000000000n);
  assert.equal(formatBaseToWhole(1234500000n), '1234.5');
  assert.equal(formatBaseToWhole(1n), '0.000001');
  assert.equal(formatBaseToWhole(1000000000n), '1000');
  assert.throws(() => parseWholeToBase('abc'));
  assert.throws(() => parseWholeToBase('1.1234567')); // > 6 decimals
});

test('address validation', () => {
  assert.equal(isValidTerraAddress('terra17ntyhh0242y2tjmq37zjgl0chysu84s9hkph69'), true);
  assert.equal(isValidTerraAddress(A), true);
  assert.equal(isValidTerraAddress('terra1short'), false);
  assert.equal(isValidTerraAddress('cosmos1' + 'a'.repeat(38)), false);
  assert.equal(isValidTerraAddress('terra1' + 'b'.repeat(38)), false); // b not in bech32 set
  assert.equal(isValidTerraAddress('terra1' + '1'.repeat(38)), false);
});
