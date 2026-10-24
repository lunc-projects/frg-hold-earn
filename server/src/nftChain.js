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
