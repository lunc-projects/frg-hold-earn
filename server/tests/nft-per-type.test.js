// NFT bonus PER-TYPE rates tests (owner decision 2026-10-28,
// built 2026-10-29): the flat per-NFT rate is replaced by three
// rates keyed to each token's type, read from its on-chain
// nft_info — Bonus (default / no rarity) 4 FRG/day, Common 50,
// Uncommon 100, mirroring the old FRG app. Fixtures below copy the
// REAL FRG REWARDS nft_info shapes read live from the chain
// (2026-10-29): "Bonus" tokens carry name "Bonus" and an EMPTY
// attributes list; numbered tokens carry a "Rarity" attribute.
//
// Steve's test case is encoded verbatim: his app-admin wallet
// holds FRG REWARDS #102 ("FRG 38", Rarity Common) and must read
// common:1 and accrue exactly 50 FRG/day, while his excluded main
// wallet (69 Bonus NFTs on-chain) reads all-zero, is never
// chain-read, and accrues nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classifyNftType, computeNftDailyBonusByType, validateNftSettings } from '../src/nft.js';
import { cw721TypeCountsMulti } from '../src/nftChain.js';
import { openStore } from '../src/store.js';
import { createApp, runSnapshot } from '../src/server.js';

const FRG_REWARDS = 'terra1qhnugpekln5lzlxq83g8ecu0j47r5tga7yryprjuhwaugaamelusgtg0af';
const S = 'terra1hjr335tu8perh0hmqnmmru4aw7llppl9a4svu7'; // holds #102 (Common)
const X = 'terra1kur3cr4vask4lgs3tr4gww7lr0zvc944gjfcqc'; // excluded; holds 69 Bonus
const M = 'terra1' + 'm'.repeat(38); // mixed-type holder
const POOL_WALLET = 'terra1' + 'd'.repeat(38);
const ADMIN = 'terra1' + 'w'.repeat(38);
const SECRET = 'test-secret';
const LCD = 'http://lcd-stub';

// Real response shapes (trimmed to the fields the classifier reads;
// the identifier/image fields on-chain are irrelevant here).
const BONUS_INFO = {
  token_uri: 'https://ipfs.bigbangx.io/ipfs/QmbQDbjRUyLnxBZPCzsKhRCick9guhXyiMKVom5aZt5cws',
  extension: { name: 'Bonus', attributes: [] },
};
const COMMON_102_INFO = {
  token_uri: 'https://ipfs.bigbangx.io/ipfs/QmYnhcUQsqiJqNAZFuTkqHftqki97GFj4zvmcrar5L36wf',
  extension: {
    name: 'FRG 38',
    attributes: [{ display_type: null, trait_type: 'Rarity', value: 'Common' }],
  },
};
const COMMON_INFO = {
  extension: { name: 'FRG 48', attributes: [{ display_type: null, trait_type: 'Rarity', value: 'Common' }] },
};
const UNCOMMON_INFO = {
  extension: { name: 'FRG 17', attributes: [{ display_type: null, trait_type: 'Rarity', value: 'Uncommon' }] },
};

const HOLDINGS = {
  [FRG_REWARDS]: {
    [S]: ['102'],
    [X]: Array.from({ length: 69 }, (_, i) => `x-${i + 1}`),
    [M]: ['b-1', 'b-2', 'c-1', 'u-1', 'u-2', 'u-3'],
  },
};
const NFTINFO = {
  '102': COMMON_102_INFO,
  'c-1': COMMON_INFO,
  'u-1': UNCOMMON_INFO, 'u-2': UNCOMMON_INFO, 'u-3': UNCOMMON_INFO,
  // everything else (b-*, x-*) is a Bonus token
};

// Stub LCD serving tokens + nft_info from the fixtures, recording
// every query so tests can prove the excluded wallet is never read.
// failInfo=true -> nft_info queries return HTTP 500.
function stubLcdFetch({ failInfo = false } = {}) {
  const seen = { tokenOwners: [], infoIds: [] };
  const fn = async (url) => {
    const m = String(url).match(/\/contract\/([^/]+)\/smart\/(.+)$/);
    assert.ok(m, `unexpected fetch url: ${url}`);
    const [, collection, b64q] = m;
    const query = JSON.parse(Buffer.from(b64q, 'base64').toString('utf8'));
    if (query.nft_info) {
      seen.infoIds.push(query.nft_info.token_id);
      if (failInfo) return { ok: false, status: 500, json: async () => ({}) };
      const info = NFTINFO[query.nft_info.token_id] || BONUS_INFO;
      return { ok: true, status: 200, json: async () => ({ data: info }) };
    }
    const { owner, limit = 30, start_after } = query.tokens;
    seen.tokenOwners.push(owner);
    const all = (HOLDINGS[collection] && HOLDINGS[collection][owner]) || [];
    let from = 0;
    if (start_after) from = all.indexOf(start_after) + 1;
    const tokens = all.slice(from, from + limit);
    return { ok: true, status: 200, json: async () => ({ data: { tokens } }) };
  };
  fn.seen = seen;
  return fn;
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-nfttypes-'));
  return openStore(path.join(dir, 'test.db'));
}

// --- Classifier: real shapes + defensive reads ---

test('classify: real FRG REWARDS shapes — Bonus by empty attributes, Common/Uncommon by Rarity', () => {
  assert.equal(classifyNftType(BONUS_INFO), 'bonus');
  assert.equal(classifyNftType(COMMON_102_INFO), 'common');
  assert.equal(classifyNftType(UNCOMMON_INFO), 'uncommon');
});

test('classify: defensive — case, name-only, unknown rarity, empty extension', () => {
  // Lowercase rarity value still reads.
  assert.equal(classifyNftType({ extension: { name: 'FRG 1', attributes: [{ trait_type: 'rarity', value: 'common' }] } }), 'common');
  // Name-only: "Uncommon" must win over the "common" inside it.
  assert.equal(classifyNftType({ extension: { name: 'Uncommon FRG', attributes: [] } }), 'uncommon');
  assert.equal(classifyNftType({ extension: { name: 'Common FRG', attributes: [] } }), 'common');
  // Unknown rarity + plain name -> the default type, never higher.
  assert.equal(classifyNftType({ extension: { name: 'FRG 9', attributes: [{ trait_type: 'Rarity', value: 'Legendary' }] } }), 'bonus');
  // Empty / missing metadata -> default type.
  assert.equal(classifyNftType({ extension: {} }), 'bonus');
  assert.equal(classifyNftType({}), 'bonus');
  assert.equal(classifyNftType(null), 'bonus');
  assert.equal(classifyNftType(undefined), 'bonus');
});

// --- Collection address shape (regression) ---
// The app's wallet validator only accepts 44-char account
// addresses, but a CW721 collection is a 64-char contract address.
// Before this fix the REAL FRG REWARDS address was rejected by the
// settings validator and silently filtered out of the stored
// collections list — the bonus could never have been connected.

test('collection settings accept the real 64-char FRG REWARDS contract address', () => {
  const u = validateNftSettings({ collection: FRG_REWARDS, collections: [FRG_REWARDS] });
  assert.equal(u.collection, FRG_REWARDS);
  assert.deepEqual(u.collections, [FRG_REWARDS]);
  const store = tempStore();
  store.setNftSettings({ collections: [FRG_REWARDS] });
  assert.deepEqual(store.getNftCollections(), [FRG_REWARDS]); // not filtered out
  // Wallet-shaped settings stay strict: a contract address is not
  // a wallet and must still be rejected there.
  assert.throws(() => validateNftSettings({ excludedWallets: [FRG_REWARDS] }), /excluded wallets list/);
  assert.throws(() => validateNftSettings({ bonusPoolWallet: FRG_REWARDS }), /invalid bonus pool wallet/);
});

// --- Store: shipped defaults + admin override persistence ---

test('store: fresh rates default to the decided Bonus 4 / Common 50 / Uncommon 100 FRG', () => {
  const store = tempStore();
  assert.deepEqual(store.getNftBonusRates(), { bonus: 4_000_000n, common: 50_000_000n, uncommon: 100_000_000n });
  assert.deepEqual(store.getNftSettings().bonusRates, { bonus: 4_000_000n, common: 50_000_000n, uncommon: 100_000_000n });
});

test('store: an admin-changed rate survives a reopen (defaults never clobber)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-nfttypes-'));
  const file = path.join(dir, 'test.db');
  const s1 = openStore(file);
  s1.setNftSettings({ bonusRateCommon: 60_000_000n });
  const s2 = openStore(file);
  assert.equal(s2.getNftBonusRates().common, 60_000_000n);
  assert.equal(s2.getNftBonusRates().bonus, 4_000_000n); // untouched default intact
});

test('store: pre-upgrade snapshot rows keep their total and read zero per type', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-nfttypes-'));
  const file = path.join(dir, 'old.db');
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE nft_snapshots(day TEXT, wallet TEXT, nft_count INTEGER,
            PRIMARY KEY(day, wallet));
            INSERT INTO nft_snapshots VALUES('2026-10-28', '${S}', 5)`);
  raw.close();
  const store = openStore(file); // migration adds the type columns
  assert.equal(store.latestNftCount(S), 5);
  assert.deepEqual(store.latestNftTypeCounts(S), { bonus: 0, common: 0, uncommon: 0 });
});

// --- Steve's test case, end to end through a snapshot ---

test("snapshot: #102 reads common:1 and accrues 50 FRG/day; excluded 69-NFT wallet reads zero, never chain-read", async () => {
  const realFetch = global.fetch;
  const stub = stubLcdFetch();
  global.fetch = stub;
  try {
    const store = tempStore();
    store.registerWallet(S, null);
    store.registerWallet(X, null);
    store.registerWallet(M, null);
    store.setDailyPool(0n);
    // Rates are NOT set by this test — the shipped 4/50/100
    // defaults are what must price the day. Only the collection
    // and the exclusion are configured.
    store.setNftSettings({ collections: [FRG_REWARDS], excludedWallets: [X] });
    const fetchNftCounts = (addr) => cw721TypeCountsMulti(LCD, store.getNftCollections(), addr);
    const out = await runSnapshot(store, async () => 1_000_000n, '2026-10-29', fetchNftCounts);
    assert.equal(out.nft.skipped, false);

    // Steve's test case: token #102 is a Common.
    assert.deepEqual(store.latestNftTypeCounts(S), { bonus: 0, common: 1, uncommon: 0 });
    assert.equal(store.latestNftCount(S), 1);
    assert.equal(store.nftAccrued(S), 50_000_000n); // exactly 50 FRG for the day

    // Excluded wallet: 69 Bonus NFTs on the fixture chain, but the
    // recorded counts are all zero, nothing accrued, and the chain
    // was NEVER queried for this wallet (no tokens, no nft_info).
    assert.deepEqual(store.latestNftTypeCounts(X), { bonus: 0, common: 0, uncommon: 0 });
    assert.equal(store.latestNftCount(X), 0);
    assert.equal(store.nftAccrued(X), 0n);
    assert.ok(!stub.seen.tokenOwners.includes(X), 'excluded wallet must not be token-queried');
    assert.ok(!stub.seen.infoIds.some((id) => id.startsWith('x-')), 'excluded wallet tokens must not be info-queried');

    // Mixed holder: 2 Bonus + 1 Common + 3 Uncommon
    // = 2x4 + 1x50 + 3x100 = 358 FRG for the day.
    assert.deepEqual(store.latestNftTypeCounts(M), { bonus: 2, common: 1, uncommon: 3 });
    assert.equal(store.latestNftCount(M), 6);
    assert.equal(store.nftAccrued(M), 358_000_000n);

    assert.deepEqual(store.snapshotDays(), ['2026-10-29']); // base side ran
  } finally { global.fetch = realFetch; }
});

test('snapshot: an nft_info failure skips the whole NFT day; base completes; retry lands it', async () => {
  const store = tempStore();
  store.registerWallet(S, null);
  store.setDailyPool(1_000_000n);
  store.setNftSettings({ collections: [FRG_REWARDS] });
  const fetchNftCounts = (addr) => cw721TypeCountsMulti(LCD, store.getNftCollections(), addr);

  const realFetch = global.fetch;
  global.fetch = stubLcdFetch({ failInfo: true });
  let out;
  try {
    out = await runSnapshot(store, async () => 1_000_000n, '2026-10-29', fetchNftCounts);
  } finally { global.fetch = realFetch; }
  assert.equal(out.nft.skipped, true);
  assert.deepEqual(store.snapshotDays(), ['2026-10-29']); // base completed
  assert.deepEqual(store.nftSnapshotDays(), []); // nothing partial
  assert.equal(store.nftAccrued(S), 0n);

  global.fetch = stubLcdFetch();
  try {
    const out2 = await runSnapshot(store, async () => 1_000_000n, '2026-10-29', fetchNftCounts);
    assert.equal(out2.nft.skipped, false);
  } finally { global.fetch = realFetch; }
  assert.deepEqual(store.latestNftTypeCounts(S), { bonus: 0, common: 1, uncommon: 0 });
  assert.equal(store.nftAccrued(S), 50_000_000n);
});

// --- HTTP views: rates + per-type counts exposed ---

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

test('views: /api/nft, /api/stats and /api/admin/nft expose the three rates and per-type counts', async (t) => {
  const realFetch = global.fetch;
  global.fetch = stubLcdFetch();
  const store = tempStore();
  store.registerWallet(S, null);
  store.setDailyPool(0n);
  store.setNftSettings({ collections: [FRG_REWARDS], excludedWallets: [X] });
  const fetchNftCounts = (addr) => cw721TypeCountsMulti(LCD, store.getNftCollections(), addr);
  await runSnapshot(store, async () => 1_000_000n, '2026-10-29', fetchNftCounts);
  global.fetch = realFetch;

  const { server, base } = await startApp(store);
  t.after(() => { server.closeAllConnections(); server.close(); });

  const view = await get(base, `/api/nft?address=${S}`);
  assert.equal(view.body.bonusRateSet, true);
  assert.deepEqual(view.body.bonusRatesWhole, { bonus: '4', common: '50', uncommon: '100' });
  assert.deepEqual(view.body.bonusRates, { bonus: '4000000', common: '50000000', uncommon: '100000000' });
  assert.deepEqual(view.body.nftTypeCounts, { bonus: 0, common: 1, uncommon: 0 });
  assert.equal(view.body.nftCount, 1);
  assert.match(view.body.bonusNotice, /Common 50 FRG/);

  const excluded = await get(base, `/api/nft?address=${X}`);
  assert.equal(excluded.body.walletExcluded, true);
  assert.deepEqual(excluded.body.nftTypeCounts, { bonus: 0, common: 0, uncommon: 0 });

  const stats = await get(base, '/api/stats');
  assert.deepEqual(stats.body.nft.bonusRatesWhole, { bonus: '4', common: '50', uncommon: '100' });
  assert.equal(stats.body.nft.bonusRateSet, true);

  const admin = await get(base, '/api/admin/nft', adminHeaders);
  assert.deepEqual(admin.body.bonusRatesWhole, { bonus: '4', common: '50', uncommon: '100' });
});

test('admin HTTP: each rate is settable on its own; a bad rate is a 400', async (t) => {
  const store = tempStore();
  const { server, base } = await startApp(store);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const ok = await post(base, '/api/admin/nft/settings',
    { bonusRateCommonWhole: '60' }, adminHeaders);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.bonusRatesWhole.common, '60');
  assert.equal(ok.body.bonusRatesWhole.bonus, '4'); // others untouched
  assert.equal(ok.body.bonusRatesWhole.uncommon, '100');
  const bad = await post(base, '/api/admin/nft/settings',
    { bonusRateUncommonWhole: '-5' }, adminHeaders);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /invalid Uncommon NFT rate/);
  const got = await get(base, '/api/admin/nft', adminHeaders);
  assert.equal(got.body.bonusRatesWhole.uncommon, '100'); // unchanged by the rejected write
});

test('rates all zeroed: counts by type still record, zero accrues, views say not set', async (t) => {
  const realFetch = global.fetch;
  global.fetch = stubLcdFetch();
  const store = tempStore();
  store.registerWallet(M, null);
  store.setDailyPool(0n);
  store.setNftSettings({
    collections: [FRG_REWARDS],
    bonusRateBonus: 0n, bonusRateCommon: 0n, bonusRateUncommon: 0n,
  });
  const fetchNftCounts = (addr) => cw721TypeCountsMulti(LCD, store.getNftCollections(), addr);
  await runSnapshot(store, async () => 1_000_000n, '2026-10-29', fetchNftCounts);
  global.fetch = realFetch;

  assert.deepEqual(store.latestNftTypeCounts(M), { bonus: 2, common: 1, uncommon: 3 });
  assert.equal(store.nftAccrued(M), 0n);

  const { server, base } = await startApp(store);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const view = await get(base, `/api/nft?address=${M}`);
  assert.equal(view.body.bonusRateSet, false);
  assert.match(view.body.bonusNotice, /bonus rates are not set yet/);
  assert.deepEqual(view.body.nftTypeCounts, { bonus: 2, common: 1, uncommon: 3 });
});

test('per-type math sanity: computeNftDailyBonusByType at the decided rates', () => {
  const rates = { bonus: 4_000_000n, common: 50_000_000n, uncommon: 100_000_000n };
  assert.equal(computeNftDailyBonusByType({ bonus: 0, common: 1, uncommon: 0 }, rates), 50_000_000n);
  assert.equal(computeNftDailyBonusByType({ bonus: 69, common: 0, uncommon: 0 }, rates), 276_000_000n);
  // The full-collection census (100 Bonus / 4 Common / 13 Uncommon)
  // in one wallet would earn 400 + 200 + 1300 = 1900 FRG/day.
  assert.equal(computeNftDailyBonusByType({ bonus: 100, common: 4, uncommon: 13 }, rates), 1_900_000_000n);
});
