// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — NFT bonus module (pure functions, no I/O).
// Separate from the base hold-and-earn engine (engine.js) by design:
// base rewards (hold FRG -> daily pool share) NEVER change because of
// NFTs. NFTs only add a bonus on top, paid from a SEPARATE bonus pool
// ledger that is funded by mint fees — never from the daily pool.
//
// The mechanic, user-decided 2026-10-24 (nothing here is a placeholder
// for a different mechanic):
// - People earning base rewards by holding FRG get NFT bonuses on top.
// - More NFTs held = more bonus / more power.
// - All of one holder's NFTs consolidate into ONE calculation: a single
//   power value per wallet (the NFT count itself).
// - That calculation drives the website display: a battery visual whose
//   charge reflects the calculation, showing FULLY POWERED at an
//   admin-set threshold NFT count.
// - Bonus pool: a separate ledger from the daily pool, funded by mint
//   fees (recorded by the admin as real on-chain mint proceeds arrive
//   — the server never invents funding).
// - No other bonuses exist: no PvP steal, no grid bonuses, no top-10
//   airdrops. Only this mechanic.
// - Bonus formula (admin-set per type, never hardcoded): each NFT is
//   classified by TYPE from its on-chain metadata (see
//   classifyNftType) and earns that type's FRG rate per snapshot day.
//   Types: bonus (the default — no rarity), common, uncommon. The
//   rates MIRROR the old FRG app's (user-decided 2026-10-28/29):
//   Bonus 4, Common 50, Uncommon 100 FRG/day ship as the settings
//   defaults; the admin can change any of them at any time.
//   Daily bonus = bonusCount*rateBonus + commonCount*rateCommon
//               + uncommonCount*rateUncommon.
// ─────────────────────────────────────────────────────────────
import { isValidTerraAddress, isValidTerraContractAddress, parseWholeToBase } from './engine.js';

// A collection setting names a CONTRACT (64 chars on Terra
// Classic). The historical 44-char shape is also accepted so
// existing stored values and tests keep validating; wallet-shaped
// settings (excluded wallets, bonus pool wallet) do NOT use this —
// they stay on the strict wallet check.
const isCollectionAddress = (v) => isValidTerraAddress(v) || isValidTerraContractAddress(v);

// Consolidate one holder's NFTs into a single calculation.
// nftCount: non-negative integer (tokens owned at snapshot time).
// threshold: admin-set NFT count for FULLY POWERED; 0 = not set.
// Returns { nftCount, power, chargePct, fullyPowered, thresholdSet }.
// chargePct is an integer 0-100, capped at 100 above the threshold.
export function consolidateNftPower(nftCount, threshold) {
  const count = Math.max(0, Math.floor(Number(nftCount) || 0));
  const thr = Math.max(0, Math.floor(Number(threshold) || 0));
  if (thr <= 0) {
    return { nftCount: count, power: count, chargePct: 0, fullyPowered: false, thresholdSet: false };
  }
  const chargePct = Math.min(100, Math.floor((count * 100) / thr));
  return {
    nftCount: count,
    power: count,
    chargePct,
    fullyPowered: count >= thr,
    thresholdSet: true,
  };
}

// ── NFT types ────────────────────────────────────────────────
// Every NFT belongs to exactly one bonus type. Classification reads
// the token's nft_info result (the object the LCD smart query
// returns under `data`), defensively, in this order:
// 1. a "Rarity" attribute in extension.attributes (the FRG REWARDS
//    collection carries trait_type "Rarity" with value "Common" /
//    "Uncommon" — verified on-chain 2026-10-29);
// 2. a type word in the token name ("Uncommon" is checked before
//    "Common" because it contains it);
// 3. the DEFAULT type, "bonus" — e.g. the FRG REWARDS giveaway
//    tokens, whose name is literally "Bonus" and whose attributes
//    list is empty. An unreadable or empty extension also lands
//    here, never in a higher-paying type.
export const NFT_TYPES = ['bonus', 'common', 'uncommon'];
export const DEFAULT_NFT_TYPE = 'bonus';

function matchTypeName(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('uncommon')) return 'uncommon';
  if (s.includes('common')) return 'common';
  if (s.includes('bonus')) return 'bonus';
  return null;
}

export function classifyNftType(info) {
  if (!info || typeof info !== 'object') return DEFAULT_NFT_TYPE;
  const ext = info.extension && typeof info.extension === 'object' ? info.extension : info;
  const attrs = Array.isArray(ext.attributes) ? ext.attributes : [];
  for (const a of attrs) {
    if (String(a?.trait_type ?? '').trim().toLowerCase() === 'rarity') {
      const t = matchTypeName(a?.value);
      if (t) return t;
    }
  }
  return matchTypeName(ext.name) || DEFAULT_NFT_TYPE;
}

// A zeroed per-type count bag: { bonus, common, uncommon, total }.
export function emptyTypeCounts() {
  return { bonus: 0, common: 0, uncommon: 0, total: 0 };
}

// Normalize anything count-shaped into a full type-count bag.
// A plain number is the pre-type contract (an older caller that only
// counted tokens): every token lands in the DEFAULT type, which is
// what those callers' flat rate priced anyway. Objects may carry
// any subset of the per-type fields; `total` is recomputed from the
// parts unless the parts are all absent and a total was supplied.
export function normalizeTypeCounts(x) {
  if (typeof x === 'number' || typeof x === 'bigint') {
    const n = Math.max(0, Math.floor(Number(x) || 0));
    return { bonus: n, common: 0, uncommon: 0, total: n };
  }
  const out = emptyTypeCounts();
  if (x && typeof x === 'object') {
    let parts = 0;
    for (const t of NFT_TYPES) {
      out[t] = Math.max(0, Math.floor(Number(x[t]) || 0));
      parts += out[t];
    }
    out.total = parts > 0 || x.total == null
      ? parts
      : Math.max(0, Math.floor(Number(x.total) || 0));
    if (parts === 0 && out.total > 0) out[DEFAULT_NFT_TYPE] = out.total;
  }
  return out;
}

// Daily NFT bonus for one holder under per-type rates: the sum of
// count(type) x rate(type), BigInt base units (uFRG). A type with
// zero count or zero rate contributes zero.
export function computeNftDailyBonusByType(typeCounts, rates) {
  const counts = normalizeTypeCounts(typeCounts);
  let total = 0n;
  for (const t of NFT_TYPES) {
    const c = BigInt(counts[t]);
    const r = BigInt(rates?.[t] || 0n);
    if (c > 0n && r > 0n) total += c * r;
  }
  return total;
}

// Validate an admin NFT-settings update. Only fields PRESENT in the
// input are validated and returned; absent fields are left unchanged
// by the caller. Throws Error with a plain message on the first bad
// field — the admin endpoint turns that into a visible 400.
// - collection: '' clears it (no collection configured); otherwise a
//   valid Terra address. This is the MINT collection (single).
// - collections: the BONUS collections list — an array of valid Terra
//   addresses whose holdings consolidate into one bonus count per
//   holder. An empty array clears the list. Duplicates are dropped,
//   order is preserved. (When the list is empty, the store falls back
//   to the single `collection` above — see store.getNftCollections.)
// - excludedWallets: wallets that never count toward the NFT bonus
//   (e.g. the owner's own bonus-stock wallet). Same list rules as
//   `collections`: array of valid Terra addresses, duplicates
//   dropped, empty array clears the list.
// - mintCostWhole: whole-FRG decimal string, must parse and be >= 0.
// - bonusRateBonusWhole / bonusRateCommonWhole /
//   bonusRateUncommonWhole: the per-type daily bonus rates as
//   whole-FRG decimal strings, each parsed and >= 0, each settable
//   independently of the others.
// - threshold / supplyCap: non-negative integers (0 = unset / unlimited).
// - bonusPoolWallet: '' clears it; otherwise a valid Terra address.
export function validateNftSettings(input) {
  const updates = {};
  if (input == null || typeof input !== 'object') throw new Error('invalid settings');
  if ('collection' in input) {
    const v = String(input.collection ?? '').trim();
    if (v !== '' && !isCollectionAddress(v)) throw new Error('invalid NFT collection address');
    updates.collection = v;
  }
  if ('collections' in input) {
    if (!Array.isArray(input.collections)) throw new Error('invalid NFT collections list');
    const seen = new Set();
    const list = [];
    for (const raw of input.collections) {
      const v = String(raw ?? '').trim();
      if (!isCollectionAddress(v)) throw new Error('invalid NFT collection address in collections list');
      if (!seen.has(v)) { seen.add(v); list.push(v); }
    }
    updates.collections = list;
  }
  if ('excludedWallets' in input) {
    if (!Array.isArray(input.excludedWallets)) throw new Error('invalid NFT excluded wallets list');
    const seen = new Set();
    const list = [];
    for (const raw of input.excludedWallets) {
      const v = String(raw ?? '').trim();
      if (!isValidTerraAddress(v)) throw new Error('invalid NFT wallet address in excluded wallets list');
      if (!seen.has(v)) { seen.add(v); list.push(v); }
    }
    updates.excludedWallets = list;
  }
  if ('mintCostWhole' in input) {
    updates.mintCost = parseAmount(input.mintCostWhole, 'invalid mint cost');
  }
  if ('bonusRateBonusWhole' in input) {
    updates.bonusRateBonus = parseAmount(input.bonusRateBonusWhole, 'invalid Bonus NFT rate');
  }
  if ('bonusRateCommonWhole' in input) {
    updates.bonusRateCommon = parseAmount(input.bonusRateCommonWhole, 'invalid Common NFT rate');
  }
  if ('bonusRateUncommonWhole' in input) {
    updates.bonusRateUncommon = parseAmount(input.bonusRateUncommonWhole, 'invalid Uncommon NFT rate');
  }
  if ('threshold' in input) {
    updates.threshold = parseCount(input.threshold, 'invalid fully-powered threshold');
  }
  if ('supplyCap' in input) {
    updates.supplyCap = parseCount(input.supplyCap, 'invalid supply cap');
  }
  if ('bonusPoolWallet' in input) {
    const v = String(input.bonusPoolWallet ?? '').trim();
    if (v !== '' && !isValidTerraAddress(v)) throw new Error('invalid bonus pool wallet address');
    updates.bonusPoolWallet = v;
  }
  return updates;
}

function parseAmount(v, message) {
  try {
    const base = parseWholeToBase(v);
    if (base < 0n) throw new Error(message);
    return base;
  } catch {
    throw new Error(message);
  }
}

function parseCount(v, message) {
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(message);
  return n;
}

// Validate a bonus-pool funding record (admin records REAL mint-fee
// proceeds; the server never invents funding). Returns base units.
export function validateFundingAmount(amountWhole) {
  const base = parseAmount(amountWhole, 'invalid funding amount');
  if (base <= 0n) throw new Error('funding amount must be greater than 0');
  return base;
}

// Verify a mint-fee transfer from an LCD tx response object, WITHOUT
// trusting the caller: the caller only supplies a txhash, and this
// checks the on-chain record itself. opts: { txhash, buyer,
// collection, bonusPoolWallet, mintCostBase, frgToken }.
// Passes ONLY when ALL hold:
// - tx_response.code == 0 (the tx succeeded),
// - tx_response.txhash matches the claimed hash,
// - one tx message is a MsgExecuteContract from the buyer to the
//   collection contract (the CW20 send that triggers the mint),
// - a wasm transfer event on the FRG token contract moves EXACTLY
//   mintCostBase to the bonus pool wallet (the collection contract
//   forwarding the mint fee).
// Returns { ok: true } or { ok: false, reason }.
export function verifyMintTransfer(txJson, opts) {
  const fail = (reason) => ({ ok: false, reason });
  const resp = txJson?.tx_response;
  if (!resp) return fail('transaction not found');
  if (String(resp.code ?? 0) !== '0') return fail('transaction failed on-chain');
  if (resp.txhash !== opts.txhash) return fail('txhash mismatch');
  const messages = txJson.tx?.body?.messages ?? [];
  const mintCall = messages.some((m) => {
    const v = m.value || {};
    return m.type === '/cosmwasm.wasm.v1.MsgExecuteContract' &&
      v.sender === opts.buyer && v.contract === opts.collection;
  });
  if (!mintCall) return fail('no mint call from buyer to collection in this transaction');
  // Events live in tx_response.events (newer SDK) or per-log events.
  const events = resp.events ?? (resp.logs ?? []).flatMap((l) => l.events ?? []);
  const transfer = events.some((ev) => {
    if (ev.type !== 'wasm') return false;
    const attrs = {};
    for (const a of ev.attributes ?? []) attrs[a.key] = a.value;
    return attrs._contract_address === opts.frgToken &&
      attrs.action === 'transfer' &&
      attrs.recipient === opts.bonusPoolWallet &&
      attrs.amount === String(opts.mintCostBase);
  });
  if (!transfer) return fail('no exact mint-fee transfer to the bonus pool wallet in this transaction');
  return { ok: true };
}

// Txhash shape check (64 hex chars) — rejects garbage before any LCD call.
export function isValidTxhash(h) {
  return typeof h === 'string' && /^[0-9a-fA-F]{64}$/.test(h);
}
