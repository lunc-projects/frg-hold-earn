// NFT bonus EXCLUDED WALLETS tests: wallets on the admin-set
// exclusion list (e.g. the owner's own wallet holding unsold bonus
// stock) record an NFT count of 0 with NO chain read and never
// accrue NFT bonus — while their BASE hold-and-earn rewards accrue
// exactly as before. Non-excluded holders are unaffected, and the
// NFT-day failure isolation is unchanged with exclusions present.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateNftSettings } from '../src/nft.js';
import { cw721CountMulti } from '../src/nftChain.js';
import { openStore } from '../src/store.js';
import { createApp, runSnapshot } from '../src/server.js';

const A = 'terra1' + 'a'.repeat(38); // excluded holder (stubbed 35 NFTs)
const B = 'terra1' + 'e'.repeat(38); // regular holder (stubbed 2 NFTs)
const COL1 = 'terra1' + 'c'.repeat(38);
const COL2 = 'terra1' + 'f'.repeat(38);
const POOL_WALLET = 'terra1' + 'd'.repeat(38);
const ADMIN = 'terra1' + 'w'.repeat(38);
const SECRET = 'test-secret';
const LCD = 'http://lcd-stub';

// Same holdings fixture as nft-collections.test.js: A holds 32 in
// COL1 + 3 in COL2 = 35; B holds 2 in COL2.
const HOLDINGS = {
  [COL1]: { [A]: Array.from({ length: 32 }, (_, i) => `c1-${i + 1}`), [B]: [] },
  [COL2]: { [A]: ['c2-1', 'c2-2', 'c2-3'], [B]: ['c2-8', 'c2-9'] },
};

function stubLcdFetch({ fail = false } = {}) {
  return async (url) => {
    if (fail) return { ok: false, status: 500, json: async () => ({}) };
    const m = String(url).match(/\/contract\/([^/]+)\/smart\/(.+)$/);
    assert.ok(m, `unexpected fetch url: ${url}`);
    const [, collection, b64q] = m;
    const query = JSON.parse(Buffer.from(b64q, 'base64').toString('utf8'));
    const { owner, limit = 30, start_after } = query.tokens;
    const all = (HOLDINGS[collection] && HOLDINGS[collection][owner]) || [];
    let from = 0;
    if (start_after) from = all.indexOf(start_after) + 1;
    const tokens = all.slice(from, from + limit);
    return { ok: true, status: 200, json: async () => ({ data: { tokens } }) };
  };
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-nftexcl-'));
  return openStore(path.join(dir, 'test.db'));
}

// --- Admin validation: the exclusion list ---

test('admin NFT settings: excluded wallets list is validated and deduped', () => {
  const u = validateNftSettings({ excludedWallets: [A, B, A] });
  assert.deepEqual(u.excludedWallets, [A, B]);
  assert.deepEqual(validateNftSettings({ excludedWallets: [] }).excludedWallets, []);
  assert.throws(() => validateNftSettings({ excludedWallets: [A, 'bogus'] }), /excluded wallets list/);
  assert.throws(() => validateNftSettings({ excludedWallets: A }), /invalid NFT excluded wallets list/);
  assert.throws(() => validateNftSettings({ excludedWallets: [''] }), /excluded wallets list/);
});

// --- Store: default + round-trip ---

test('store: excluded wallets default empty, round-trip via NFT settings', () => {
  const store = tempStore();
  assert.deepEqual(store.getNftExcludedWallets(), []);
  assert.deepEqual(store.getNftSettings().excludedWallets, []);
  store.setNftSettings({ excludedWallets: [A, B] });
  assert.deepEqual(store.getNftExcludedWallets(), [A, B]);
  assert.deepEqual(store.getNftSettings().excludedWallets, [A, B]);
  store.setNftSettings({ excludedWallets: [] });
  assert.deepEqual(store.getNftExcludedWallets(), []);
});

// --- Snapshot integration: exclusion zeroes the NFT side only ---

test('snapshot: excluded holder records 0, accrues 0, is never chain-read; base unaffected', async () => {
  const realFetch = global.fetch;
  global.fetch = stubLcdFetch();
  try {
    const store = tempStore();
    store.registerWallet(A, null);
    store.registerWallet(B, null);
    store.setDailyPool(1_000_000n);
    store.setNftSettings({
      collections: [COL1, COL2],
      bonusPerNft: 2_000_000n, // 2 FRG per NFT/day
      excludedWallets: [A],
    });
    const readFor = [];
    const fetchNftCount = (addr) => {
      readFor.push(addr);
      return cw721CountMulti(LCD, store.getNftCollections(), addr);
    };
    const out = await runSnapshot(store, async () => 1_000_000n, '2026-10-28', fetchNftCount);
    assert.equal(out.nft.skipped, false);
    // The excluded wallet's chain read is skipped entirely.
    assert.deepEqual(readFor, [B]);
    // Excluded: count 0 recorded, zero NFT bonus — despite 35 stubbed NFTs.
    assert.equal(store.latestNftCount(A), 0);
    assert.equal(store.nftAccrued(A), 0n);
    // Non-excluded: completely unaffected (2 NFTs x 2 FRG = 4 FRG).
    assert.equal(store.latestNftCount(B), 2);
    assert.equal(store.nftAccrued(B), 4_000_000n);
    // Base hold-and-earn accrues normally for BOTH (equal FRG weights).
    assert.equal(store.accrued(A), 500_000n);
    assert.equal(store.accrued(B), 500_000n);
    assert.deepEqual(store.snapshotDays(), ['2026-10-28']);
    assert.deepEqual(store.nftSnapshotDays(), ['2026-10-28']);
  } finally { global.fetch = realFetch; }
});

test('snapshot: empty exclusion list keeps legacy behavior (every wallet read + counted)', async () => {
  const realFetch = global.fetch;
  global.fetch = stubLcdFetch();
  try {
    const store = tempStore();
    store.registerWallet(A, null);
    store.setDailyPool(0n);
    store.setNftSettings({ collections: [COL1, COL2], bonusPerNft: 2_000_000n });
    // No excludedWallets set — default empty list.
    const readFor = [];
    const fetchNftCount = (addr) => {
      readFor.push(addr);
      return cw721CountMulti(LCD, store.getNftCollections(), addr);
    };
    await runSnapshot(store, async () => 1_000_000n, '2026-10-28', fetchNftCount);
    assert.deepEqual(readFor, [A]);
    assert.equal(store.latestNftCount(A), 35);
    assert.equal(store.nftAccrued(A), 70_000_000n);
  } finally { global.fetch = realFetch; }
});

// --- Failure isolation with an exclusion present ---

test('snapshot: LCD failure still skips the whole NFT day when an exclusion is set', async () => {
  const store = tempStore();
  store.registerWallet(A, null);
  store.registerWallet(B, null);
  store.setDailyPool(1_000_000n);
  store.setNftSettings({ collections: [COL1, COL2], bonusPerNft: 2_000_000n, excludedWallets: [A] });
  const fetchNftCount = (addr) => cw721CountMulti(LCD, store.getNftCollections(), addr);

  const realFetch = global.fetch;
  global.fetch = stubLcdFetch({ fail: true });
  let out;
  try {
    out = await runSnapshot(store, async () => 1_000_000n, '2026-10-28', fetchNftCount);
  } finally { global.fetch = realFetch; }
  // Base completed for both; NFT day skipped as a whole (nothing
  // partial recorded for anyone, excluded or not).
  assert.deepEqual(store.snapshotDays(), ['2026-10-28']);
  assert.equal(store.accrued(A), 500_000n);
  assert.equal(store.accrued(B), 500_000n);
  assert.equal(out.nft.skipped, true);
  assert.deepEqual(store.nftSnapshotDays(), []);
  assert.equal(store.nftAccrued(B), 0n);

  // Retry with a healthy LCD: NFT day lands; exclusion still applies.
  global.fetch = stubLcdFetch();
  try {
    const out2 = await runSnapshot(store, async () => 1_000_000n, '2026-10-28', fetchNftCount);
    assert.equal(out2.nft.skipped, false);
  } finally { global.fetch = realFetch; }
  assert.deepEqual(store.nftSnapshotDays(), ['2026-10-28']);
  assert.equal(store.latestNftCount(A), 0);
  assert.equal(store.latestNftCount(B), 2);
  assert.equal(store.nftAccrued(B), 4_000_000n);
});

// --- HTTP: admin set/get, 400 honesty, public state exposure ---

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

test('admin HTTP: set/get excluded wallets; invalid entry rejected with 400', async (t) => {
  const store = tempStore();
  const { server, base } = await startApp(store);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const ok = await post(base, '/api/admin/nft/settings',
    { excludedWallets: [A, B] }, adminHeaders);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.excludedWallets, [A, B]);
  const bad = await post(base, '/api/admin/nft/settings',
    { excludedWallets: [A, 'bogus'] }, adminHeaders);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /excluded wallets list/);
  const got = await get(base, '/api/admin/nft', adminHeaders);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.excludedWallets, [A, B]); // unchanged by the rejected write
  const stats = await get(base, '/api/stats');
  assert.deepEqual(stats.body.nft.excludedWallets, [A, B]);
});

test('/api/nft state: exposes the exclusion list and per-wallet flag', async (t) => {
  const store = tempStore();
  store.setNftSettings({ collections: [COL1], excludedWallets: [A] });
  const { server, base } = await startApp(store);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const viewA = await get(base, `/api/nft?address=${A}`);
  assert.deepEqual(viewA.body.excludedWallets, [A]);
  assert.equal(viewA.body.walletExcluded, true);
  const viewB = await get(base, `/api/nft?address=${B}`);
  assert.deepEqual(viewB.body.excludedWallets, [A]);
  assert.equal(viewB.body.walletExcluded, false);
});
