// Engine tests: reward-asset descriptors, the simple split
// (pro-rata by holdings, exact pot sum), limit scaling, affiliate
// bonus, parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSplit, computeDay, computeBonuses, scaleAmountsToLimit,
  MIN_PAYOUT_BASE,
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

test('simple split: proportional to balance (not headcount), sums EXACTLY to the pot', () => {
  const rows = computeSplit([
    { wallet: A, balance: 1_000n * FRG1 },
    { wallet: B, balance: 3_000n * FRG1 },
  ], 100n * FRG1);
  assert.equal(rows[0].amount, 25n * FRG1); // 1/4 of the holdings -> 1/4 of the pot
  assert.equal(rows[1].amount, 75n * FRG1);
  assert.equal(rows.reduce((s, r) => s + r.amount, 0n), 100n * FRG1);
});

test('simple split: three equal holders, dust goes to the largest holder and the sum is exact', () => {
  const rows = computeSplit([
    { wallet: A, balance: 1n }, { wallet: B, balance: 1n }, { wallet: C, balance: 1n },
  ], 10n);
  assert.deepEqual(rows.map((r) => r.amount), [4n, 3n, 3n]); // 3+3+3=9 floored, dust 1 to the first (tied-largest)
  assert.equal(rows.reduce((s, r) => s + r.amount, 0n), 10n);
});

test('simple split: a 1-token holder among large holders gets a dust share, not the pot', () => {
  const pot = 1_174n * FRG1;
  const rows = computeSplit([
    { wallet: A, balance: 1n * FRG1 },        // holds exactly 1 FRG
    { wallet: B, balance: 999_999n * FRG1 },  // holds the rest
  ], pot);
  assert.equal(rows[0].amount, 1_174n); // its 1/1,000,000 share — dust, below the send threshold
  assert.ok(rows[0].amount < MIN_PAYOUT_BASE);
  assert.equal(rows[0].amount + rows[1].amount, pot); // still exact
});

test('simple split: a sole registrant receives the full pot', () => {
  const rows = computeSplit([{ wallet: A, balance: 42n * FRG1 }], 10n * FRG1);
  assert.equal(rows[0].amount, 10n * FRG1);
});

test('simple split: zero-balance registrant gets 0; pot 0 or no holdings pays nothing', () => {
  const rows = computeSplit([
    { wallet: A, balance: 0n }, { wallet: B, balance: 100n * FRG1 },
  ], 10n * FRG1);
  assert.equal(rows[0].amount, 0n);
  assert.equal(rows[1].amount, 10n * FRG1); // the whole pot follows the holdings
  const zero = computeSplit([{ wallet: A, balance: 100n * FRG1 }], 0n);
  assert.equal(zero[0].amount, 0n);
  const noHoldings = computeSplit([{ wallet: A, balance: 0n }], 10n * FRG1);
  assert.equal(noHoldings[0].amount, 0n);
});

test('computeDay: shares are the split; the referral bonus is computed on shares, extra', () => {
  const { shares, bonuses } = computeDay(
    [{ wallet: A, balance: 1_000n }, { wallet: B, balance: 1_000n }],
    1_000n, new Map([[B, A]]), 1000);
  assert.equal(shares.find((s) => s.wallet === B).amount, 500n);
  assert.equal(bonuses.find((b) => b.wallet === A).amount, 50n);
});

test('scale-to-limit: exact sum at the limit, proportional, untouched when under', () => {
  const rows = [
    { wallet: A, amount: 300n }, { wallet: B, amount: 100n }, { wallet: C, amount: 100n },
  ];
  const scaled = scaleAmountsToLimit(rows, 250n);
  assert.equal(scaled.reduce((s, r) => s + r.amount, 0n), 250n); // exactly the limit
  assert.deepEqual(scaled.map((r) => r.amount), [150n, 50n, 50n]);
  const under = scaleAmountsToLimit(rows, 1_000n);
  assert.deepEqual(under.map((r) => r.amount), [300n, 100n, 100n]); // limit is a max, not a target
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
