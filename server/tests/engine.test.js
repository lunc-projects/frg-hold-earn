// Engine tests: reward-asset descriptors, the tier table (owed =
// tier % x own balance, exact boundaries), cap scaling, affiliate
// bonus, parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOwed, computeBonuses, scaleAmountsToLimit, normalizeTiers,
  tierForBalance, MIN_PAYOUT_BASE,
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

// The owner's example tiers (placeholders in his try-out brief):
// base from 0 FRG at 0.05%/day, mid from 10,000 at 0.1%, top from
// 100,000 at 0.2%.
const EXAMPLE_TIERS = [
  { minBase: 0n, pctBps: 5 },
  { minBase: 10_000n * FRG1, pctBps: 10 },
  { minBase: 100_000n * FRG1, pctBps: 20 },
];

test('owed = tier percentage x own balance, exact per tier', () => {
  const rows = computeOwed([
    { wallet: A, balance: 5_000n * FRG1 },   // base tier 0.05%
    { wallet: B, balance: 50_000n * FRG1 },  // mid tier 0.1%
    { wallet: C, balance: 200_000n * FRG1 }, // top tier 0.2%
  ], EXAMPLE_TIERS);
  assert.equal(rows[0].owed, 2_500_000n);   // 2.5 FRG
  assert.equal(rows[1].owed, 50_000_000n);  // 50 FRG
  assert.equal(rows[2].owed, 400_000_000n); // 400 FRG
});

test('tier selection at exact boundaries: balance AT a minimum gets that tier', () => {
  assert.equal(tierForBalance(10_000n * FRG1, EXAMPLE_TIERS).pctBps, 10);
  assert.equal(tierForBalance(10_000n * FRG1 - 1n, EXAMPLE_TIERS).pctBps, 5);
  assert.equal(tierForBalance(100_000n * FRG1, EXAMPLE_TIERS).pctBps, 20);
  assert.equal(tierForBalance(0n, EXAMPLE_TIERS).pctBps, 5); // base tier (min 0) covers everyone
});

test('a 1-token holder is owed dust only (its own % of 1 FRG)', () => {
  const rows = computeOwed([{ wallet: A, balance: 1n * FRG1 }], EXAMPLE_TIERS);
  assert.equal(rows[0].owed, 500n); // 0.05% of 1 FRG — dust, far below the 1 FRG send threshold
  assert.ok(rows[0].owed < MIN_PAYOUT_BASE);
});

test('no tiers configured: only the base tier at 0% — owed is 0 (program off)', () => {
  const rows = computeOwed([{ wallet: A, balance: 1_000_000n * FRG1 }], []);
  assert.equal(rows[0].pctBps, 0);
  assert.equal(rows[0].owed, 0n);
  const table = normalizeTiers([]);
  assert.equal(table.length, 1);
  assert.equal(table[0].minBase, 0n);
});

test('scale-to-limit: exact sum at the limit, proportional, untouched when under', () => {
  const rows = [
    { wallet: A, amount: 300n }, { wallet: B, amount: 100n }, { wallet: C, amount: 100n },
  ];
  const scaled = scaleAmountsToLimit(rows, 250n);
  assert.equal(scaled.reduce((s, r) => s + r.amount, 0n), 250n); // exactly the limit
  assert.deepEqual(scaled.map((r) => r.amount), [150n, 50n, 50n]);
  const under = scaleAmountsToLimit(rows, 1_000n);
  assert.deepEqual(under.map((r) => r.amount), [300n, 100n, 100n]); // cap is a max, not a target
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
