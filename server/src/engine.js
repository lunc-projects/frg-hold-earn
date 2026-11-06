// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — earnings engine (pure functions, no I/O).
// All math is BigInt base units with 6 decimals. No floats.
//
// Assets (see assets.js for the descriptors):
// - snapshot weights are FRG base units held in users' own wallets;
// - accruals are denominated in the LIVE reward asset (FRG since
//   migration #2, 2026-11-05 — owner ruling: holders earn FRG).
//
// Model (the owner's FINAL design, 2026-11-05 — replaces the
// all-holders split, the rate+cap idea, and the daily-pot idea):
// - Registration is BY PASTE: a holder pastes their wallet address
//   (no wallet connect anywhere). A registration counts for a
//   payout run if its timestamp is within the 24 HOURS before the
//   run (rolling window — the owner's "register within 24 hours").
// - Each registered wallet is OWED a percentage of its own snapshot
//   FRG balance. The percentage comes from a TIER TABLE (admin-set):
//   each tier = a minimum FRG held + a daily percentage; a wallet's
//   tier is the highest tier whose minimum its balance meets. The
//   base tier's minimum is 0, so every holder has a tier. No crowd
//   split, no tenure weighting. Defaults: no tiers beyond the base
//   tier at 0% = the program is OFF until the owner sets numbers.
// - A DAILY CAP (admin-set, stored as USD — $0.50 total across ALL
//   holders) bounds each run: the cap is converted to FRG at the
//   run's LIVE price; if total owed exceeds the cap, all payments
//   scale down pro-rata so the day pays exactly the cap. If total
//   owed is under the cap, owed amounts pay in full. Cap 0 = off.
// - Payouts are AUTOMATIC per run but NOT on a timer: the system
//   computes the table, the owner reviews it and PRESSES THE
//   BUTTON; only then do sends go out (review-before-press). One
//   run per day; re-presses never double-pay (payments net against
//   accruals). Every payment is recorded with its tx hash.
// - POOL PROTECTION is the point: total paid never exceeds the
//   payout wallet's actual FRG balance (a second pro-rata scale
//   applies if owed ever exceeds the balance, and the shortfall is
//   recorded, still owed). The pool only ever pays what is owed —
//   it does not empty by design.
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

// ── Tier table ────────────────────────────────────────────────
// A tier is { minBase: BigInt (FRG base units), pctBps: number
// (basis points of the balance owed per day; 10000 = 100%) }.
// normalizeTiers takes raw stored/input tiers and returns the
// canonical table: sorted by minimum ascending, duplicates by
// minimum merged (highest pct wins), invalid entries rejected,
// and the BASE TIER (minimum 0) always present — inserted at 0%
// when absent, so every holder always has a tier.
export function normalizeTiers(raw) {
  if (raw === null || raw === undefined) raw = [];
  if (!Array.isArray(raw)) throw new Error('tiers must be a list');
  const byMin = new Map();
  for (const t of raw) {
    const minBase = typeof t.minBase === 'bigint' ? t.minBase : BigInt(t.minBase ?? t.min ?? '0');
    const pctBps = Number(t.pctBps);
    if (minBase < 0n) throw new Error('tier minimum cannot be negative');
    if (!Number.isInteger(pctBps) || pctBps < 0 || pctBps > 10000) {
      throw new Error('tier percentage must be 0–100% (0–10000 bps)');
    }
    const prev = byMin.get(minBase.toString());
    if (!prev || pctBps > prev.pctBps) byMin.set(minBase.toString(), { minBase, pctBps });
  }
  if (!byMin.has('0')) byMin.set('0', { minBase: 0n, pctBps: 0 });
  return [...byMin.values()].sort((a, b) => (a.minBase < b.minBase ? -1 : a.minBase > b.minBase ? 1 : 0));
}

// The tier a balance falls in: the highest tier whose minimum the
// balance MEETS — a balance exactly at a tier minimum gets that
// tier (boundary rule, owner's spec).
export function tierForBalance(balance, tiers) {
  let current = tiers[0];
  for (const t of tiers) {
    if (balance >= t.minBase) current = t;
    else break;
  }
  return current;
}

// Owed per wallet: owed = tier percentage × snapshot balance,
// exact BigInt math (floor). Rows: [{wallet, balance, minBase,
// pctBps, owed}]. Percentages apply to the wallet's OWN balance
// only — never to any pool or crowd total.
export function computeOwed(balances, tiers) {
  const table = normalizeTiers(tiers);
  return balances.map(({ wallet, balance }) => {
    const tier = tierForBalance(balance, table);
    return {
      wallet, balance,
      minBase: tier.minBase, pctBps: tier.pctBps,
      owed: (balance * BigInt(tier.pctBps)) / 10000n,
    };
  });
}

// Scale amounts down pro-rata so their sum equals `limit` EXACTLY
// (used for the daily cap and for the pool-balance guard). If the
// total already fits, amounts pass through unchanged (the cap is a
// maximum, not a target). Integer dust goes to the largest amount.
// Rows keep their other fields; `amount` is rewritten.
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

// Full day computation: each registered wallet is owed its tier
// percentage of its own balance; referral bonuses on top (EXTRA).
// Cap/pool scaling is applied by the caller (server.js), which is
// the only place that knows the run's live price and pool balance.
export function computeDay(balances, tiers, referralOf, rateBps) {
  const owed = computeOwed(balances, tiers);
  const bonuses = computeBonuses(
    owed.map(({ wallet, owed: amount }) => ({ wallet, amount })), referralOf, rateBps);
  return { owed, bonuses };
}
