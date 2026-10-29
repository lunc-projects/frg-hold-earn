// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — CW721 ownership reads (LCD only, no signing).
// Counts how many tokens of a collection one wallet owns, paging
// through the standard cw721 `tokens` query (limit 30 per page),
// and — for the per-type bonus — reads each token's `nft_info` to
// classify it (see classifyNftType in nft.js). If no collection is
// configured, the count is 0 WITHOUT any chain call — an
// unconfigured collection honestly means zero bonus holdings,
// never an error and never an invented number.
// ─────────────────────────────────────────────────────────────
import { classifyNftType, emptyTypeCounts } from './nft.js';

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

async function smartQuery(lcdUrl, collection, query) {
  const res = await fetch(`${lcdUrl}/cosmwasm/wasm/v1/contract/${collection}/smart/${b64(query)}`);
  if (!res.ok) throw new Error(`NFT tokens query failed (${res.status})`);
  const data = await res.json();
  return data.data;
}

// All token ids of `collection` owned by `owner`, paging at 30.
export async function cw721TokenIds(lcdUrl, collection, owner) {
  if (!collection) return [];
  const ids = [];
  let startAfter = null;
  for (let page = 0; page < 1000; page++) {
    const query = { tokens: { owner, limit: 30, ...(startAfter ? { start_after: startAfter } : {}) } };
    const data = await smartQuery(lcdUrl, collection, query);
    const pageIds = data?.tokens ?? [];
    ids.push(...pageIds);
    if (pageIds.length < 30) break;
    startAfter = pageIds[pageIds.length - 1];
  }
  return ids;
}

export async function cw721Count(lcdUrl, collection, owner) {
  return (await cw721TokenIds(lcdUrl, collection, owner)).length;
}

// One token's nft_info result object ({ token_uri, extension }).
// Throws on an LCD error like every other read here — the caller
// treats any failure as "skip the NFT bonus day", never a guess.
export async function cw721NftInfo(lcdUrl, collection, tokenId) {
  const data = await smartQuery(lcdUrl, collection, { nft_info: { token_id: tokenId } });
  if (!data || typeof data !== 'object') throw new Error('NFT nft_info query returned no data');
  return data;
}

// Per-type counts for ONE collection: list the owner's tokens,
// then classify each one from its nft_info. A failure on ANY token
// throws — a partial classification would misprice the holder's
// day, so the whole read fails instead.
export async function cw721TypeCounts(lcdUrl, collection, owner) {
  const counts = emptyTypeCounts();
  if (!collection) return counts;
  const ids = await cw721TokenIds(lcdUrl, collection, owner);
  for (const id of ids) {
    counts[classifyNftType(await cw721NftInfo(lcdUrl, collection, id))] += 1;
    counts.total += 1;
  }
  return counts;
}

// Consolidated count across ALL configured bonus collections: the
// design (user-decided 2026-10-24) is one calculation per holder, so
// tokens in every configured collection sum into a single number.
// An empty list honestly counts 0 without any chain call. A chain
// error on ANY collection throws — the caller (runSnapshot) treats
// that as "skip the NFT bonus for this snapshot", never as a
// partial count that would understate a holder's NFTs.
export async function cw721CountMulti(lcdUrl, collections, owner) {
  if (!collections || collections.length === 0) return 0;
  let total = 0;
  for (const collection of collections) {
    total += await cw721Count(lcdUrl, collection, owner);
  }
  return total;
}

// The per-type counterpart of cw721CountMulti: same consolidation
// and same fail-whole contract, but the result breaks the holder's
// NFTs down by bonus type: { bonus, common, uncommon, total }.
export async function cw721TypeCountsMulti(lcdUrl, collections, owner) {
  const counts = emptyTypeCounts();
  if (!collections || collections.length === 0) return counts;
  for (const collection of collections) {
    const c = await cw721TypeCounts(lcdUrl, collection, owner);
    counts.bonus += c.bonus;
    counts.common += c.common;
    counts.uncommon += c.uncommon;
    counts.total += c.total;
  }
  return counts;
}
