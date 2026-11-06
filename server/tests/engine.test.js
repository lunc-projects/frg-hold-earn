// Engine tests: reward-asset descriptors, the daily-pot pro-rata
// split (exact sum, dust rule), affiliate bonus, parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeShares, computeBonuses, computeDay,
  parseWholeToBase, formatBaseToWhole, isValidTerraAddress,
  HELD_TOKEN_SYMBOL,
} from '../src/engine.js';
import { REWARD_ASSETS, FRG_TOKEN, rewardAssetFor } from '../src/assets.js';

const A = 'terra1' + 'a'.repeat(38);
const B = 'terra1' + 'q'.repeat(38);
const C = 'terra1' + 'p'.repeat(38);
const FRG1 = 1_000_000n; // 1 FRG in base units

test('asset descriptors: FRG is held; FRG (CW20) is the live reward; USTC stays as the dormant option', () => {
  assert.equal(HELD_TOKEN_SYMBOL, 'FRG');
  // FRG reward: CW20 contract descriptor.
  assert.equal(REWARD_ASSETS.FRG.symbol, 'FRG');
  assert.equal(REWARD_ASSETS.FRG.kind, 'cw20');
  assert.equal(REWARD_ASSETS.FRG.token, 'terra14rfnhc2aru7jp304lht3yf903necsnrt4cxd464cftsfcksw0rtsgundnt');
  assert.equal(REWARD_ASSETS.FRG.token, FRG_TOKEN);
  assert.equal(REWARD_ASSETS.FRG.denom, FRG_TOKEN);
  // USTC descriptor still present, untouched, for the future switch.
  assert.equal(REWARD_ASSETS.USTC.symbol, 'USTC');
  assert.equal(REWARD_ASSETS.USTC.kind, 'native');
  assert.equal(REWARD_ASSETS.USTC.denom, 'uusd');
  assert.equal(REWARD_ASSETS.USTC.token, null);
  assert.equal(rewardAssetFor('FRG'), REWARD_ASSETS.FRG);
  assert.equal(rewardAssetFor('USTC'), REWARD_ASSETS.USTC);
  assert.equal(rewardAssetFor(undefined), REWARD_ASSETS.FRG); // safe default
});

test('the pot empties completely: shares sum EXACTLY to the pot', () => {
  // Pot 10 FRG; A holds 3 FRG, B holds 1 FRG (base units).
  const { shares, bonuses } = computeDay(10n * FRG1, [
    { wallet: A, balance: 3n * FRG1 }, { wallet: B, balance: 1n * FRG1 },
  ], new Map([[B, A]]), 1000);
  assert.equal(shares.find((s) => s.wallet === A).amount, 7_500_000n); // 7.5 FRG
  assert.equal(shares.find((s) => s.wallet === B).amount, 2_500_000n); // 2.5 FRG
  assert.equal(shares.reduce((s, x) => s + x.amount, 0n), 10n * FRG1); // pot fully emptied
  assert.equal(bonuses.find((b) => b.wallet === A).amount, 250_000n); // 10% of B's share, extra
});

test('pro-rata by balance: a 1-token holder among large holders earns a dust share, not the pot', () => {
  // Pot 1,000 FRG. A holds 1 FRG; B holds 999 FRG.
  const shares = computeShares(1000n * FRG1, [
    { wallet: A, balance: 1n * FRG1 }, { wallet: B, balance: 999n * FRG1 },
  ]);
  assert.equal(shares.find((s) => s.wallet === A).amount, 1n * FRG1); // 1/1000 of the pot
  assert.equal(shares.find((s) => s.wallet === B).amount, 999n * FRG1);
  assert.equal(shares.reduce((s, x) => s + x.amount, 0n), 1000n * FRG1);
});

test('dust goes to the largest holder of the day, sum still equals the pot', () => {
  const shares = computeShares(100n, [
    { wallet: A, balance: 1n }, { wallet: B, balance: 1n }, { wallet: C, balance: 1n },
  ]);
  assert.equal(shares.reduce((s, x) => s + x.amount, 0n), 100n);
  assert.deepEqual(shares.map((s) => s.amount).sort(), [33n, 33n, 34n]);
});

test('zero pot pays zero; zero total balance pays zero', () => {
  assert.deepEqual(computeShares(0n, [{ wallet: A, balance: 5n }]).map((s) => s.amount), [0n]);
  assert.deepEqual(computeShares(100n, [{ wallet: A, balance: 0n }]).map((s) => s.amount), [0n]);
  assert.deepEqual(computeShares(100n, []).map((s) => s.amount), []);
});

test('zero-balance holders earn zero even when registered', () => {
  const { shares } = computeDay(1_000n, [
    { wallet: A, balance: 10n }, { wallet: B, balance: 0n },
  ], new Map(), 1000);
  assert.equal(shares.find((s) => s.wallet === B).amount, 0n);
  assert.equal(shares.find((s) => s.wallet === A).amount, 1_000n);
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
