// NFT bonus COLLECTIONS tests: holdings across several configured
// CW721 collections consolidate into ONE count per holder; an LCD
// failure skips the NFT bonus for that snapshot without touching the
// base snapshot; a configured-but-unset bonus rate accrues exactly
// zero and says so honestly in the views.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateNftSettings } from '../src/nft.js';
import { cw721CountMulti, cw721TypeCountsMulti } from '../src/nftChain.js';
import { openStore } from '../src/store.js';
import { createApp, runSnapshot } from '../src/server.js';

const A = 'terra1' + 'a'.repeat(38); // holder with NFTs in 2 collections
const B = 'terra1' + 'e'.repeat(38); // holder with NFTs in 1 collection
const COL1 = 'terra1' + 'c'.repeat(38);
const COL2 = 'terra1' + 'f'.repeat(38);
const POOL_WALLET = 'terra1' + 'd'.repeat(38);
const ADMIN = 'terra1' + 'w'.repeat(38);
const SECRET = 'test-secret';
const LCD = 'http://lcd-stub';

// Holdings fixture: A holds 32 in COL1 (forces paging at limit 30)
// and 3 in COL2 -> 35 consolidated. B holds 0 in COL1, 2 in COL2.
const HOLDINGS = {
  [COL1]: { [A]: Array.from({ length: 32 }, (_, i) => `c1-${i + 1}`), [B]: [] },
  [COL2]: { [A]: ['c2-1', 'c2-2', 'c2-3'], [B]: ['c2-8', 'c2-9'] },
};

// Stub global fetch serving the cw721 `tokens` smart query (with
// start_after/limit paging, from HOLDINGS) and `nft_info` queries —
// every fixture token reports the default-type metadata (name
// "Bonus", no rarity attribute), so consolidated per-type counts
// land entirely in the bonus bucket. fail=true -> HTTP 500.
function stubLcdFetch({ fail = false } = {}) {
  let calls = 0;
  const fn = async (url) => {
    calls++;
    if (fail) return { ok: false, status: 500, json: async () => ({}) };
    const m = String(url).match(/\/contract\/([^/]+)\/smart\/(.+)$/);
    assert.ok(m, `unexpected fetch url: ${url}`);
    const [, collection, b64q] = m;
    const query = JSON.parse(Buffer.from(b64q, 'base64').toString('utf8'));
    if (query.nft_info) {
      return { ok: true, status: 200, json: async () => ({ data: { token_uri: null, extension: { name: 'Bonus', attributes: [] } } }) };
    }
    const { owner, limit = 30, start_after } = query.tokens;
    const all = (HOLDINGS[collection] && HOLDINGS[collection][owner]) || [];
    let from = 0;
    if (start_after) from = all.indexOf(start_after) + 1;
    const tokens = all.slice(from, from + limit);
    return { ok: true, status: 200, json: async () => ({ data: { tokens } }) };
  };
  fn.calls = () => calls;
  return fn;
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-nftcols-'));
  return openStore(path.join(dir, 'test.db'));
}

// --- Chain read: multi-collection consolidation ---

test('cw721CountMulti: sums holdings across collections, paging included', async () => {
  const realFetch = global.fetch;
  global.fetch = stubLcdFetch();
  try {
    assert.equal(await cw721CountMulti(LCD, [COL1, COL2], A), 35);
    assert.equal(await cw721CountMulti(LCD, [COL1, COL2], B), 2);
    assert.equal(await cw721CountMulti(LCD, [COL2], A), 3);
  } finally { global.fetch = realFetch; }
});

test('cw721CountMulti: empty list counts 0 with NO chain call', async () => {
  const realFetch = global.fetch;
  const stub = stubLcdFetch();
  global.fetch = stub;
  try {
    assert.equal(await cw721CountMulti(LCD, [], A), 0);
    assert.equal(await cw721CountMulti(LCD, null, A), 0);
    assert.equal(stub.calls(), 0);
  } finally { global.fetch = realFetch; }
});

test('cw721CountMulti: an LCD error throws (never a partial count)', async () => {
  const realFetch = global.fetch;
  global.fetch = stubLcdFetch({ fail: true });
  try {
    await assert.rejects(() => cw721CountMulti(LCD, [COL1, COL2], A), /NFT tokens query failed/);
  } finally { global.fetch = realFetch; }
});

// --- Admin validation: the collections list ---

test('admin NFT settings: collections list is validated and deduped', () => {
  const u = validateNftSettings({ collections: [COL1, COL2, COL1] });
  assert.deepEqual(u.collections, [COL1, COL2]);
  assert.deepEqual(validateNftSettings({ collections: [] }).collections, []);
  assert.throws(() => validateNftSettings({ collections: [COL1, 'bogus'] }), /collections list/);
  assert.throws(() => validateNftSettings({ collections: COL1 }), /invalid NFT collections list/);
  assert.throws(() => validateNftSettings({ collections: [''] }), /collections list/);
});

// --- Store: list round-trip + legacy fallback ---

test('store: collections round-trip; legacy single collection is the fallback', () => {
  const store = tempStore();
  assert.deepEqual(store.getNftCollections(), []);
  store.setNftSettings({ collection: COL1 });
  assert.deepEqual(store.getNftCollections(), [COL1]); // fallback
  store.setNftSettings({ collections: [COL1, COL2] });
  assert.deepEqual(store.getNftCollections(), [COL1, COL2]);
  assert.deepEqual(store.getNftSettings().collections, [COL1, COL2]);
  store.setNftSettings({ collections: [] });
  assert.deepEqual(store.getNftCollections(), [COL1]); // list cleared -> legacy fallback again
});

// --- Snapshot integration: consolidation + exact bonus math ---

test('snapshot: holdings in 2 collections consolidate; bonus = count x rate exactly', async () => {
  const realFetch = global.fetch;
  global.fetch = stubLcdFetch();
  try {
    const store = tempStore();
    store.registerWallet(A, null);
    store.registerWallet(B, null);
    store.setDailyPool(1_000_000n); // 1 USTC base-unit pool for the base side
    store.setNftSettings({ collections: [COL1, COL2], bonusRateBonus: 2_000_000n }); // 2 FRG per NFT/day
    const fetchNftCount = (addr) => cw721TypeCountsMulti(LCD, store.getNftCollections(), addr);
    const out = await runSnapshot(store, async () => 1_000_000n, '2026-10-28', fetchNftCount);
    assert.equal(out.nft.skipped, false);
    // Consolidated counts persisted with the snapshot.
    assert.equal(store.latestNftCount(A), 35);
    assert.equal(store.latestNftCount(B), 2);
    // Worked example: A: 35 NFTs x 2 FRG = 70 FRG = 70,000,000 base.
    //                 B:  2 NFTs x 2 FRG =  4 FRG =  4,000,000 base.
    assert.equal(store.nftAccrued(A), 70_000_000n);
    assert.equal(store.nftAccrued(B), 4_000_000n);
    // Base side ran normally alongside (equal FRG weights split the pool).
    assert.deepEqual(store.snapshotDays(), ['2026-10-28']);
    assert.equal(store.accrued(A), 500_000n);
    assert.equal(store.accrued(B), 500_000n);
  } finally { global.fetch = realFetch; }
});

test('snapshot: holder with no NFTs counts 0 and accrues no bonus', async () => {
  const realFetch = global.fetch;
  global.fetch = stubLcdFetch();
  try {
    const store = tempStore();
    store.registerWallet(B, null);
    store.setDailyPool(0n);
    store.setNftSettings({ collections: [COL1], bonusRateBonus: 2_000_000n });
    const fetchNftCount = (addr) => cw721TypeCountsMulti(LCD, store.getNftCollections(), addr);
    await runSnapshot(store, async () => 5_000_000n, '2026-10-28', fetchNftCount);
    assert.equal(store.latestNftCount(B), 0); // B holds nothing in COL1
    assert.equal(store.nftAccrued(B), 0n);
    assert.deepEqual(store.nftSnapshotDays(), ['2026-10-28']);
  } finally { global.fetch = realFetch; }
});

// --- Snapshot failure isolation: LCD down ---

test('snapshot: LCD failure skips the NFT day, base completes, retry lands the NFT day', async () => {
  const store = tempStore();
  store.registerWallet(A, null);
  store.setDailyPool(1_000_000n);
  store.setNftSettings({ collections: [COL1, COL2], bonusRateBonus: 2_000_000n });
  const fetchNftCount = (addr) => cw721TypeCountsMulti(LCD, store.getNftCollections(), addr);

  const realFetch = global.fetch;
  global.fetch = stubLcdFetch({ fail: true });
  let out;
  try {
    out = await runSnapshot(store, async () => 1_000_000n, '2026-10-28', fetchNftCount);
  } finally { global.fetch = realFetch; }
  // Base snapshot completed and paid its share despite the LCD outage.
  assert.deepEqual(store.snapshotDays(), ['2026-10-28']);
  assert.equal(store.accrued(A), 1_000_000n);
  // NFT day skipped as a whole: nothing partial recorded.
  assert.equal(out.nft.skipped, true);
  assert.match(out.nft.error, /NFT bonus snapshot skipped/);
  assert.deepEqual(store.nftSnapshotDays(), []);
  assert.equal(store.nftAccrued(A), 0n);

  // Retry the same day with a healthy LCD: the NFT day now records,
  // and the base day is NOT double-recorded.
  global.fetch = stubLcdFetch();
  try {
    const out2 = await runSnapshot(store, async () => 1_000_000n, '2026-10-28', fetchNftCount);
    assert.equal(out2.nft.skipped, false);
  } finally { global.fetch = realFetch; }
  assert.deepEqual(store.nftSnapshotDays(), ['2026-10-28']);
  assert.equal(store.latestNftCount(A), 35);
  assert.equal(store.nftAccrued(A), 70_000_000n);
  assert.equal(store.accrued(A), 1_000_000n); // still one base day
});

// --- Rate unset: counts recorded, zero bonus, honest labels ---

function fakePayout() {
  const sent = [];
  return {
    sent, configured: true, canSend: true,
    address: async () => POOL_WALLET,
    getBalance: async () => 100_000_000n,
    getUstcBalance: async () => 100_000_000n,
    send: async (to, amount) => { sent.push({ to, amount }); return 'FAKETX123'; },
  };
}

async function startApp(store) {
  const app = createApp({
    store,
    payout: fakePayout(),
    config: { lcdUrl: LCD, rpcUrl: '', adminWallet: ADMIN, adminSecret: SECRET },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (base, p, headers = {}) => fetch(`${base}${p}`, { headers })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const adminHeaders = { 'x-admin-wallet': ADMIN, 'x-admin-secret': SECRET };

test('rate unset: counts snapshot, zero bonus accrues, views say "not set yet"', async (t) => {
  const realFetch = global.fetch;
  global.fetch = stubLcdFetch();
  const store = tempStore();
  store.registerWallet(A, null);
  store.setDailyPool(0n);
  // The unset state under per-type rates: all three rates at 0.
  // (A fresh store ships the decided 4/50/100 defaults instead.)
  store.setNftSettings({
    collections: [COL1, COL2],
    bonusRateBonus: 0n, bonusRateCommon: 0n, bonusRateUncommon: 0n,
  });
  const fetchNftCount = (addr) => cw721TypeCountsMulti(LCD, store.getNftCollections(), addr);
  await runSnapshot(store, async () => 1_000_000n, '2026-10-28', fetchNftCount);
  global.fetch = realFetch;

  assert.equal(store.latestNftCount(A), 35); // holdings still counted
  assert.deepEqual(store.latestNftTypeCounts(A), { bonus: 35, common: 0, uncommon: 0 });
  assert.equal(store.nftAccrued(A), 0n); // but no bonus figure accrues

  const { server, base } = await startApp(store);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const view = await get(base, `/api/nft?address=${A}`);
  assert.equal(view.body.configured, true);
  assert.deepEqual(view.body.collections, [COL1, COL2]);
  assert.equal(view.body.bonusRateSet, false);
  assert.match(view.body.bonusNotice, /bonus rates are not set yet/);
  assert.equal(view.body.nftCount, 35);
  assert.deepEqual(view.body.nftTypeCounts, { bonus: 35, common: 0, uncommon: 0 });
  assert.equal(view.body.claimable, '0');
  const stats = await get(base, '/api/stats');
  assert.equal(stats.body.nft.bonusCollectionsConfigured, true);
  assert.equal(stats.body.nft.bonusRateSet, false);
});

test('admin HTTP: set/get bonus collections; invalid entry rejected with 400', async (t) => {
  const store = tempStore();
  const { server, base } = await startApp(store);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const ok = await post(base, '/api/admin/nft/settings',
    { collections: [COL1, COL2] }, adminHeaders);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.collections, [COL1, COL2]);
  // A fresh store ships the decided per-type rates (4/50/100), so
  // the rates read as set with their defaults in the response.
  assert.equal(ok.body.bonusRateSet, true);
  assert.deepEqual(ok.body.bonusRatesWhole, { bonus: '4', common: '50', uncommon: '100' });
  const bad = await post(base, '/api/admin/nft/settings',
    { collections: [COL1, 'bogus'] }, adminHeaders);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /collections list/);
  const got = await get(base, '/api/admin/nft', adminHeaders);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.collections, [COL1, COL2]); // unchanged by the rejected write
});
