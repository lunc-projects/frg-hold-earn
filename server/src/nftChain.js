// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — CW721 ownership reads (LCD only, no signing).
// Counts how many tokens of a collection one wallet owns, paging
// through the standard cw721 `tokens` query (limit 30 per page).
// If no collection is configured, the count is 0 WITHOUT any chain
// call — an unconfigured collection honestly means zero bonus
// holdings, never an error and never an invented number.
// ─────────────────────────────────────────────────────────────

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

export async function cw721Count(lcdUrl, collection, owner) {
  if (!collection) return 0;
  let count = 0;
  let startAfter = null;
  for (let page = 0; page < 1000; page++) {
    const query = { tokens: { owner, limit: 30, ...(startAfter ? { start_after: startAfter } : {}) } };
    const res = await fetch(`${lcdUrl}/cosmwasm/wasm/v1/contract/${collection}/smart/${b64(query)}`);
    if (!res.ok) throw new Error(`NFT tokens query failed (${res.status})`);
    const data = await res.json();
    const ids = data.data?.tokens ?? [];
    count += ids.length;
    if (ids.length < 30) break;
    startAfter = ids[ids.length - 1];
  }
  return count;
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
