// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — earnings engine (pure functions, no I/O).
// All math is BigInt base units with 6 decimals. No floats. The two
// currencies in the base engine are deliberately different:
// - snapshot weights are FRG base units held in users' own wallets;
// - the daily pool, shares and affiliate bonuses are USTC base units
//   (denom "uusd") that the owner deposits into the payout wallet.
//
// Model (see README for the full write-up):
// - Each snapshot day, that day's USTC pool splits PRO-RATA across the
//   FRG snapshot balances of registered wallets. Sum of shares == pool
//   exactly (integer dust goes to the largest holder).
// - Affiliate bonus: referrer accrues rate% of each referral's share.
//   It is EXTRA, funded from the same USTC reward pot — it is NEVER taken
//   out of the referral's share, and never out of other holders'
//   shares either. Consequence the admin must fund for: one day's
//   total cost = pool + bonuses. The hard cap at payout time is the
//   payout wallet's actual USTC balance (collect refuses to overpay).
// - A wallet earns ONLY for days it appears in a snapshot. Holding on
//   a non-snapshot day, or registering after a snapshot, earns nothing
//   for that day. This is what defeats flash-holding.
// ─────────────────────────────────────────────────────────────

export const DECIMALS = 1_000_000n;
export const HELD_TOKEN_SYMBOL = 'FRG';
export const REWARD_SYMBOL = 'USTC';
export const REWARD_DENOM = 'uusd';
const BECH32 = '023456789acdefghjklmnpqrstuvwxyz';

export function isValidTerraAddress(addr) {
  return typeof addr === 'string' && addr.length === 44 && addr.startsWith('terra1') &&
    [...addr.slice(6)].every((ch) => BECH32.includes(ch));
}

// Whole-token decimal string ("1234.5") -> 6-decimal base units.
// Used for both FRG wallet balances and USTC reward amounts; the two
// assets share the same decimal scale but are never interchanged.
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

// Pro-rata split. `pool` is USTC base units; `balances` are FRG base
// units used only as weights. Returns [{wallet, amount}] in USTC base
// units summing EXACTLY to pool (when total > 0); zero-balance holders
// get 0; total == 0 -> all zero.
export function computeShares(pool, balances) {
  const total = balances.reduce((s, b) => s + b.balance, 0n);
  if (total <= 0n || pool <= 0n) {
    return balances.map(({ wallet }) => ({ wallet, amount: 0n }));
  }
  const shares = balances.map(({ wallet, balance }) => ({
    wallet, amount: (pool * balance) / total, balance,
  }));
  const distributed = shares.reduce((s, x) => s + x.amount, 0n);
  const dust = pool - distributed;
  if (dust > 0n) {
    // Dust (always < number of holders) goes to the largest holder.
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

// Full day computation: snapshots in, accruals out.
export function computeDay(pool, balances, referralOf, rateBps) {
  const shares = computeShares(pool, balances);
  const bonuses = computeBonuses(shares, referralOf, rateBps);
  return { shares, bonuses };
}
