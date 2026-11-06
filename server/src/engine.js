// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — earnings engine (pure functions, no I/O).
// All math is BigInt base units with 6 decimals. No floats.
//
// Assets (see assets.js for the descriptors):
// - snapshot weights are FRG base units held in users' own wallets;
// - accruals are denominated in the LIVE reward asset (FRG since
//   migration #2, 2026-11-05 — owner ruling: holders earn FRG).
//
// Model (the owner's own design, 2026-11-05 — replaces both the
// original all-holders split and the short-lived rate+cap idea):
// - There is a DAILY POT (admin-set FRG amount; 0 = off).
// - Each day is its own round: only wallets that REGISTERED that
//   day are eligible for that day's pot. Registration does not
//   carry over — yesterday's registration earns nothing today.
// - At the end of the day the pot EMPTIES COMPLETELY to the day's
//   registered wallets, split PRO-RATA by their snapshot FRG
//   balances: the shares sum EXACTLY to the pot (integer dust goes
//   to the largest holder of the day). Nothing rolls over.
// - A registered wallet holding 0 FRG earns 0. A wallet that did
//   not register that day earns 0 for that day no matter how much
//   it holds. Registering after the day has ended earns nothing
//   for that day — a day's distribution is computed once, from
//   that day's registrations and snapshot, and never changes
//   afterwards.
// - NO rate, NO cap-scaling, NO time/tenure weighting (the owner
//   rejected all three explicitly — "just a simple concept:
//   hold and earn").
// - Affiliate bonus: referrer accrues rate% of each referral's
//   share. It is EXTRA, funded from the same reward pot — never
//   taken out of the referral's share. (The affiliate program is
//   a stub with an unconfirmed rate; see README.)
// ─────────────────────────────────────────────────────────────

export const DECIMALS = 1_000_000n;
export const HELD_TOKEN_SYMBOL = 'FRG';
const BECH32 = '023456789acdefghjklmnpqrstuvwxyz';

export function isValidTerraAddress(addr) {
  return typeof addr === 'string' && addr.length === 44 && addr.startsWith('terra1') &&
    [...addr.slice(6)].every((ch) => BECH32.includes(ch));
}

// Contract addresses are a different shape from wallet addresses:
// 64 chars (a 32-byte contract address bech32-encoded). Collection
// settings must accept THESE — the 44-char wallet check above
// rejects every real CW721/CW20 contract, including FRG REWARDS.
// Wallet-shaped fields keep using isValidTerraAddress alone.
export function isValidTerraContractAddress(addr) {
  return typeof addr === 'string' && addr.length === 64 && addr.startsWith('terra1') &&
    [...addr.slice(6)].every((ch) => BECH32.includes(ch));
}

// Whole-token decimal string ("1234.5") -> 6-decimal base units.
// Used for FRG wallet balances and reward amounts alike; both
// assets share the same decimal scale.
export function parseWholeToBase(str) {
  if (typeof str !== 'string') str = String(str);
  const m = str.trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) throw new Error('Invalid amount');
  const whole = BigInt(m[1]);
  const frac = (m[2] || '').padEnd(6, '0');
  return whole * DECIMALS + BigInt(frac);
}

// Base units BigInt -> display string ("1234.5", trailing zeros trimmed).
export function formatBaseToWhole(base) {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const whole = abs / DECIMALS;
  const frac = (abs % DECIMALS).toString().padStart(6, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

// Pro-rata split of the day's pot. `pot` is reward base units;
// `balances` are the day's REGISTERED wallets' snapshot FRG
// balances, used only as weights. Returns [{wallet, amount}]
// summing EXACTLY to the pot (when total balance > 0): the pot
// empties completely, nothing rolls over. Integer dust (always
// less than the number of holders) goes to the largest holder of
// the day. Zero-balance holders get 0; total == 0 or pot == 0 ->
// all zero (an empty round pays nothing, and there is nobody to
// empty to).
export function computeShares(pot, balances) {
  const total = balances.reduce((s, b) => s + b.balance, 0n);
  if (total <= 0n || pot <= 0n) {
    return balances.map(({ wallet }) => ({ wallet, amount: 0n }));
  }
  const shares = balances.map(({ wallet, balance }) => ({
    wallet, amount: (pot * balance) / total, balance,
  }));
  const distributed = shares.reduce((s, x) => s + x.amount, 0n);
  const dust = pot - distributed;
  if (dust > 0n) {
    // Dust goes to the largest holder of the day.
    let biggest = shares[0];
    for (const s of shares) if (s.balance > biggest.balance) biggest = s;
    biggest.amount += dust;
  }
  return shares.map(({ wallet, amount }) => ({ wallet, amount }));
}

// Referral bonuses: rateBps of each referral's share, credited to the
// referrer. referralOf: Map wallet -> referrer (or null). Self-links
// are ignored defensively (registration already rejects them).
export function computeBonuses(shares, referralOf, rateBps) {
  const byWallet = new Map();
  for (const { wallet, amount } of shares) {
    const ref = referralOf.get(wallet);
    if (!ref || ref === wallet || amount <= 0n || rateBps <= 0) continue;
    const bonus = (amount * BigInt(rateBps)) / 10000n;
    if (bonus > 0n) byWallet.set(ref, (byWallet.get(ref) || 0n) + bonus);
  }
  return [...byWallet.entries()].map(([wallet, amount]) => ({ wallet, amount }));
}

// Full day computation: the day's pot splits across the day's
// registered wallets' snapshot balances; referral bonuses on top.
export function computeDay(pot, balances, referralOf, rateBps) {
  const shares = computeShares(pot, balances);
  const bonuses = computeBonuses(shares, referralOf, rateBps);
  return { shares, bonuses };
}
