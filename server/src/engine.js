// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — earnings engine (pure functions, no I/O).
// All math is BigInt base units with 6 decimals. No floats.
//
// Assets (see assets.js for the descriptors):
// - snapshot weights are FRG base units held in users' own wallets;
// - accruals are denominated in the LIVE reward asset (FRG since
//   migration #2, 2026-11-05 — owner ruling: holders earn FRG).
//
// Model (the owner's FINAL design, 2026-11-05 — tiers removed at
// his direction the same night: "do a simple split"):
// - Registration is BY PASTE, ONE-TIME and PERMANENT: a holder
//   pastes their wallet address once (no wallet connect anywhere)
//   and is in every payout run from then on — "they shouldn't
//   have to do it every day if they are holding" (owner,
//   2026-11-05). The ONLY way off the list: at a payout build, a
//   registered wallet whose balance is below the owner's
//   MINIMUM HOLDING limit is removed from registration entirely
//   (server.js enforces it at the build, on the same balance the
//   split uses; a balance AT the limit stays). It rejoins only
//   by pasting its address again.
// - Each day has ONE pot, built from TWO separate owner numbers
//   (never merged): the DAILY PAYOUT AMOUNT (the specific amount
//   set to be split that day — USD-denominated, currently $0.50,
//   converted to FRG at the run's LIVE price) and a HARD LIMIT of
//   2,000 FRG/day (an absolute ceiling only, never a target).
//   pot = min(payout amount in FRG, hard limit, pool balance).
//   Payout amount 0/unset = nothing pays.
// - The pot is split SIMPLE PRO-RATA BY HOLDINGS: each registered
//   wallet's share = (its snapshot FRG balance / total FRG held by
//   all registered wallets) x pot. A wallet's share of the
//   holdings is its share of the reward. No tiers, no per-tier
//   rates, no tenure weighting. Shares sum EXACTLY to the pot;
//   a sole registrant receives the whole pot; a wallet holding
//   0 FRG receives 0.
// - Payouts are AUTOMATIC per run but NOT on a timer: the system
//   computes the table, the owner reviews it and PRESSES THE
//   BUTTON; only then do sends go out (review-before-press). One
//   run per day; re-presses never double-pay (payments net against
//   accruals). Every payment is recorded with its tx hash.
// - POOL PROTECTION: sends never exceed the payout wallet's
//   actual FRG balance (a pro-rata scale applies if claimable
//   amounts ever exceed it, and the shortfall is recorded, still
//   owed). The pool only pays the set amount — it does not empty
//   by design.
// - Sub-dust rule: a wallet whose total claimable is below
//   MIN_PAYOUT_BASE (1 FRG) is not sent a micro-payment; the amount
//   stays accrued (carried) and is included the next run it takes
//   part in, once the combined amount reaches the threshold.
// - Affiliate bonus: referrer accrues rate% of each referral's
//   share. It is EXTRA — never taken out of the referral's share.
//   (The affiliate program is a stub with an unconfirmed rate;
//   see README.)
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

// ── The simple split ──────────────────────────────────────────
// computeSplit divides a pot PRO-RATA BY HOLDINGS: each wallet's
// amount = (its balance / total balance of all rows) x pot, exact
// BigInt math (floor per row). The shares sum EXACTLY to the pot:
// the few base units lost to flooring go to the largest holder
// (the same dust rule as scaleAmountsToLimit). Rows:
// [{wallet, balance, amount}].
// - pot <= 0 or total balance <= 0: every amount is 0 (nothing
//   can be split, nothing pays).
// - A wallet holding 0 FRG gets exactly 0.
// - A sole registrant receives the full pot (documented behavior
//   of the simple split — the pot itself is bounded by the daily
//   payout amount, the hard limit, and the pool balance).
export function computeSplit(balances, potBase) {
  const pot = potBase > 0n ? potBase : 0n;
  const total = balances.reduce((s, r) => s + r.balance, 0n);
  if (pot <= 0n || total <= 0n) {
    return balances.map(({ wallet, balance }) => ({ wallet, balance, amount: 0n }));
  }
  const rows = balances.map(({ wallet, balance }) => ({
    wallet, balance, amount: (balance * pot) / total,
  }));
  const distributed = rows.reduce((s, r) => s + r.amount, 0n);
  const dust = pot - distributed;
  if (dust > 0n) {
    let biggest = rows[0];
    for (const r of rows) if (r.balance > biggest.balance) biggest = r;
    biggest.amount += dust;
  }
  return rows;
}

// Scale amounts down pro-rata so their sum equals `limit` EXACTLY
// (used for the payout run's pool-balance guard on sends). If the
// total already fits, amounts pass through unchanged (the limit is
// a maximum, not a target). Integer dust goes to the largest
// amount. Rows keep their other fields; `amount` is rewritten.
export function scaleAmountsToLimit(rows, limit) {
  const total = rows.reduce((s, r) => s + r.amount, 0n);
  if (total <= limit || total <= 0n) return rows.map((r) => ({ ...r }));
  const scaled = rows.map((r) => ({ ...r, amount: (r.amount * limit) / total, _orig: r.amount }));
  const distributed = scaled.reduce((s, r) => s + r.amount, 0n);
  const dust = limit - distributed;
  if (dust > 0n) {
    let biggest = scaled[0];
    for (const r of scaled) if (r._orig > biggest._orig) biggest = r;
    biggest.amount += dust;
  }
  return scaled.map(({ _orig, ...r }) => r);
}

// Minimum send threshold: claimable amounts below 1 FRG are NOT
// sent as micro-payments; they stay accrued (carried) and join the
// wallet's next run until the combined amount reaches 1 FRG.
export const MIN_PAYOUT_BASE = 1_000_000n;

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

// Full day computation: the pot split pro-rata by holdings, plus
// referral bonuses on top (EXTRA — never deducted from shares).
// The pot itself is built by the caller (server.js), which is the
// only place that knows the run's live price, the hard limit, and
// the pool balance.
export function computeDay(balances, potBase, referralOf, rateBps) {
  const shares = computeSplit(balances, potBase);
  const bonuses = computeBonuses(shares, referralOf, rateBps);
  return { shares, bonuses };
}
