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
// - Bonus formula (admin-set, never hardcoded): a flat FRG amount per
//   NFT per snapshot day. Daily bonus = nftCount * bonusPerNft.
// ─────────────────────────────────────────────────────────────
import { isValidTerraAddress, parseWholeToBase } from './engine.js';

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

// Daily NFT bonus for one holder: flat rate per NFT per day, BigInt
// base units (uFRG). Zero NFTs or zero rate pays zero.
export function computeNftDailyBonus(nftCount, bonusPerNftBase) {
  const count = BigInt(Math.max(0, Math.floor(Number(nftCount) || 0)));
  const rate = BigInt(bonusPerNftBase || 0n);
  if (count <= 0n || rate <= 0n) return 0n;
  return count * rate;
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
// - mintCostWhole / bonusPerNftWhole: whole-FRG decimal strings,
//   must parse and be >= 0.
// - threshold / supplyCap: non-negative integers (0 = unset / unlimited).
// - bonusPoolWallet: '' clears it; otherwise a valid Terra address.
export function validateNftSettings(input) {
  const updates = {};
  if (input == null || typeof input !== 'object') throw new Error('invalid settings');
  if ('collection' in input) {
    const v = String(input.collection ?? '').trim();
    if (v !== '' && !isValidTerraAddress(v)) throw new Error('invalid NFT collection address');
    updates.collection = v;
  }
  if ('collections' in input) {
    if (!Array.isArray(input.collections)) throw new Error('invalid NFT collections list');
    const seen = new Set();
    const list = [];
    for (const raw of input.collections) {
      const v = String(raw ?? '').trim();
      if (!isValidTerraAddress(v)) throw new Error('invalid NFT collection address in collections list');
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
  if ('bonusPerNftWhole' in input) {
    updates.bonusPerNft = parseAmount(input.bonusPerNftWhole, 'invalid bonus per NFT');
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
