// NFT bonus tests: consolidated calculation, bonus pool funding math,
// bonus payout safety (no double-pay), admin-number validation, and
// mint-transfer verification — plus HTTP tests against the real app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  consolidateNftPower, computeNftDailyBonus,
  validateNftSettings, validateFundingAmount,
  verifyMintTransfer, isValidTxhash,
} from '../src/nft.js';
import { openStore } from '../src/store.js';
import { createApp, runSnapshot } from '../src/server.js';
import { FRG_TOKEN } from '../src/payout.js';

const A = 'terra1' + 'a'.repeat(38); // holder
const COLLECTION = 'terra1' + 'c'.repeat(38);
const POOL_WALLET = 'terra1' + 'd'.repeat(38);
const ADMIN = 'terra1' + 'w'.repeat(38);
const SECRET = 'test-secret';
const TXHASH = 'ab'.repeat(32);

// --- Consolidated calculation ---

test('battery: 0 NFTs is 0% charged, not fully powered', () => {
  const p = consolidateNftPower(0, 10);
  assert.equal(p.power, 0);
  assert.equal(p.chargePct, 0);
  assert.equal(p.fullyPowered, false);
});

test('battery: 1 NFT of threshold 10 is 10% charged', () => {
  const p = consolidateNftPower(1, 10);
  assert.equal(p.power, 1);
  assert.equal(p.chargePct, 10);
  assert.equal(p.fullyPowered, false);
});

test('battery: threshold-1 is just under full', () => {
  const p = consolidateNftPower(9, 10);
  assert.equal(p.chargePct, 90);
  assert.equal(p.fullyPowered, false);
});

test('battery: exactly at threshold is 100% and FULLY POWERED', () => {
  const p = consolidateNftPower(10, 10);
  assert.equal(p.chargePct, 100);
  assert.equal(p.fullyPowered, true);
});

test('battery: above threshold caps at 100% and stays fully powered', () => {
  const p = consolidateNftPower(25, 10);
  assert.equal(p.power, 25);
  assert.equal(p.chargePct, 100);
  assert.equal(p.fullyPowered, true);
});

test('battery: unset threshold (0) never claims fully powered', () => {
  const p = consolidateNftPower(5, 0);
  assert.equal(p.thresholdSet, false);
  assert.equal(p.chargePct, 0);
  assert.equal(p.fullyPowered, false);
});

// --- Daily bonus math ---

test('daily NFT bonus: count x per-NFT rate, zero cases pay zero', () => {
  assert.equal(computeNftDailyBonus(3, 5000000n), 15000000n);
  assert.equal(computeNftDailyBonus(0, 5000000n), 0n);
  assert.equal(computeNftDailyBonus(3, 0n), 0n);
});

// --- Admin-number validation ---

test('admin NFT settings: valid update normalizes', () => {
  const u = validateNftSettings({
    collection: COLLECTION, mintCostWhole: '1000', bonusPerNftWhole: '5',
    threshold: 10, supplyCap: 0, bonusPoolWallet: POOL_WALLET,
  });
  assert.equal(u.collection, COLLECTION);
  assert.equal(u.mintCost, 1000000000n);
  assert.equal(u.bonusPerNft, 5000000n);
  assert.equal(u.threshold, 10);
  assert.equal(u.supplyCap, 0);
  assert.equal(u.bonusPoolWallet, POOL_WALLET);
});

test('admin NFT settings: clearing the collection with empty string works', () => {
  assert.equal(validateNftSettings({ collection: '' }).collection, '');
});

test('admin NFT settings: invalid values are rejected', () => {
  assert.throws(() => validateNftSettings({ collection: 'terra1short' }), /invalid NFT collection/);
  assert.throws(() => validateNftSettings({ collection: 'cosmos1' + 'a'.repeat(38) }), /invalid NFT collection/);
  assert.throws(() => validateNftSettings({ mintCostWhole: '-5' }), /invalid mint cost/);
  assert.throws(() => validateNftSettings({ mintCostWhole: 'abc' }), /invalid mint cost/);
  assert.throws(() => validateNftSettings({ bonusPerNftWhole: '1.1234567' }), /invalid bonus per NFT/);
  assert.throws(() => validateNftSettings({ threshold: -1 }), /invalid fully-powered threshold/);
  assert.throws(() => validateNftSettings({ threshold: 2.5 }), /invalid fully-powered threshold/);
  assert.throws(() => validateNftSettings({ threshold: 'abc' }), /invalid fully-powered threshold/);
  assert.throws(() => validateNftSettings({ supplyCap: -1 }), /invalid supply cap/);
  assert.throws(() => validateNftSettings({ bonusPoolWallet: 'nope' }), /invalid bonus pool wallet/);
});

test('bonus pool funding: zero and negative amounts rejected', () => {
  assert.throws(() => validateFundingAmount('0'), /greater than 0/);
  assert.throws(() => validateFundingAmount('-10'), /invalid funding amount/);
  assert.equal(validateFundingAmount('2500'), 2500000000n);
});

// --- Mint-transfer verification (pure) ---

function mintTx(overrides = {}) {
  const base = {
    tx: { body: { messages: [{
      type: '/cosmwasm.wasm.v1.MsgExecuteContract',
      value: { sender: A, contract: COLLECTION, msg: { send: {} }, funds: [] },
    }] } },
    tx_response: {
      txhash: TXHASH, code: 0,
      events: [{ type: 'wasm', attributes: [
        { key: '_contract_address', value: FRG_TOKEN },
        { key: 'action', value: 'transfer' },
        { key: 'from', value: COLLECTION },
        { key: 'recipient', value: POOL_WALLET },
        { key: 'amount', value: '1000000000' },
      ] }],
    },
  };
  return { ...base, ...overrides };
}

const OPTS = {
  txhash: TXHASH, buyer: A, collection: COLLECTION,
  bonusPoolWallet: POOL_WALLET, mintCostBase: 1000000000n, frgToken: FRG_TOKEN,
};

test('mint verification: valid mint passes', () => {
  assert.deepEqual(verifyMintTransfer(mintTx(), OPTS), { ok: true });
});

test('mint verification: failed tx, wrong amount, wrong recipient, wrong buyer, wrong collection all fail', () => {
  const failed = mintTx();
  failed.tx_response = { ...failed.tx_response, code: 5 };
  assert.equal(verifyMintTransfer(failed, OPTS).ok, false);
  const wrongAmount = mintTx();
  wrongAmount.tx_response.events[0].attributes.find((a) => a.key === 'amount').value = '999';
  assert.equal(verifyMintTransfer(wrongAmount, OPTS).ok, false);
  const wrongRecipient = mintTx();
  wrongRecipient.tx_response.events[0].attributes.find((a) => a.key === 'recipient').value = A;
  assert.equal(verifyMintTransfer(wrongRecipient, OPTS).ok, false);
  assert.equal(verifyMintTransfer(mintTx(), { ...OPTS, buyer: 'terra1' + 'q'.repeat(38) }).ok, false);
  assert.equal(verifyMintTransfer(mintTx(), { ...OPTS, collection: 'terra1' + 'p'.repeat(38) }).ok, false);
  assert.equal(verifyMintTransfer(mintTx(), { ...OPTS, txhash: 'cd'.repeat(32) }).ok, false);
  const noTransfer = mintTx();
  noTransfer.tx_response.events = [];
  assert.equal(verifyMintTransfer(noTransfer, OPTS).ok, false);
});

test('txhash shape check', () => {
  assert.equal(isValidTxhash(TXHASH), true);
  assert.equal(isValidTxhash('xyz'), false);
  assert.equal(isValidTxhash('ab'.repeat(31)), false);
});

// --- HTTP: store + routes ---

function fakePayout({ balance = 100_000_000n, configured = true } = {}) {
  const sent = [];
  return {
    sent, configured, canSend: configured,
    address: async () => POOL_WALLET,
    getBalance: async () => balance,
    send: async (to, amount) => { sent.push({ to, amount }); return 'FAKETX123'; },
  };
}

async function startApp({ payout, secret = SECRET } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-nft-'));
  const store = openStore(path.join(dir, 'test.db'));
  const app = createApp({
    store,
    payout: payout || fakePayout(),
    config: { lcdUrl: 'http://127.0.0.1:1', rpcUrl: '', adminWallet: ADMIN, adminSecret: secret },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, server, base };
}

const post = (base, p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (base, p, headers = {}) => fetch(`${base}${p}`, { headers })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const adminHeaders = { 'x-admin-wallet': ADMIN, 'x-admin-secret': SECRET };

async function seededNft() {
  const payout = fakePayout();
  const ctx = await startApp({ payout });
  const { store } = ctx;
  store.registerWallet(A, null);
  store.setDailyPool(1_000_000n);
  store.setNftSettings({
    collection: COLLECTION, mintCost: 1000000000n, bonusPerNft: 5000000n,
    threshold: 10, supplyCap: 0, bonusPoolWallet: POOL_WALLET,
  });
  store.fundBonusPool(100_000_000n, 'test funding');
  // Day 1: A holds 3 NFTs -> bonus 3 x 5 FRG = 15,000,000 base.
  await runSnapshot(store, async () => 1_000_000n, '2026-10-24', async () => 3);
  return { ...ctx, payout };
}

test('NFT view: consolidated power, charge, claimable bonus', async (t) => {
  const { server, base } = await seededNft();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const r = await get(base, `/api/nft?address=${A}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.configured, true);
  assert.equal(r.body.nftCount, 3);
  assert.equal(r.body.power, 3);
  assert.equal(r.body.chargePct, 30);
  assert.equal(r.body.fullyPowered, false);
  assert.equal(r.body.claimable, '15000000');
  assert.equal(r.body.bonusPoolAvailable, '100000000');
});

test('NFT view: unconfigured collection reads zero and mint not open', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  store.registerWallet(A, null);
  const r = await get(base, `/api/nft?address=${A}`);
  assert.equal(r.body.configured, false);
  assert.equal(r.body.nftCount, 0);
  assert.equal(r.body.mintReady, false);
  assert.match(r.body.mintNotice, /not open yet/);
});

test('NFT bonus collect pays once; second collect finds nothing', async (t) => {
  const { server, base, payout } = await seededNft();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const c1 = await post(base, '/api/nft/collect', { address: A });
  assert.equal(c1.status, 200);
  assert.equal(c1.body.paid, '15000000');
  assert.equal(payout.sent.length, 1);
  const c2 = await post(base, '/api/nft/collect', { address: A });
  assert.equal(c2.status, 400);
  assert.match(c2.body.error, /nothing to collect/);
  assert.equal(payout.sent.length, 1);
});

test('NFT bonus collect: empty bonus pool fails safely, bonus stays collectable', async (t) => {
  const payout = fakePayout();
  const ctx = await startApp({ payout });
  t.after(() => { ctx.server.closeAllConnections(); ctx.server.close(); });
  const { store, base } = ctx;
  store.registerWallet(A, null);
  store.setNftSettings({
    collection: COLLECTION, mintCost: 1000000000n, bonusPerNft: 5000000n,
    threshold: 10, supplyCap: 0, bonusPoolWallet: POOL_WALLET,
  });
  // No funding: pool available is 0, bonus accrued is 15,000,000.
  await runSnapshot(store, async () => 1_000_000n, '2026-10-24', async () => 3);
  const c = await post(base, '/api/nft/collect', { address: A });
  assert.equal(c.status, 400);
  assert.match(c.body.error, /bonus pool empty/);
  assert.equal(payout.sent.length, 0);
  const r = await get(base, `/api/nft?address=${A}`);
  assert.equal(r.body.claimable, '15000000'); // unchanged
});

test('NFT bonus collect: blocked when bonus pool wallet unset', async (t) => {
  const ctx = await startApp();
  t.after(() => { ctx.server.closeAllConnections(); ctx.server.close(); });
  const { store, base } = ctx;
  store.registerWallet(A, null);
  store.setNftSettings({ collection: COLLECTION, bonusPerNft: 5000000n });
  await runSnapshot(store, async () => 1_000_000n, '2026-10-24', async () => 2);
  const c = await post(base, '/api/nft/collect', { address: A });
  assert.equal(c.status, 503);
  assert.match(c.body.error, /bonus pool wallet not set/);
});

test('NFT snapshot is idempotent: second run same day never double-accrues', async (t) => {
  const { server, base, store } = await seededNft();
  t.after(() => { server.closeAllConnections(); server.close(); });
  await runSnapshot(store, async () => 1_000_000n, '2026-10-24', async () => 3);
  const r = await get(base, `/api/nft?address=${A}`);
  assert.equal(r.body.claimable, '15000000'); // still one day's bonus
});

test('admin NFT settings: valid saves, invalid rejected with 400', async (t) => {
  const { server, base } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const bad = await post(base, '/api/admin/nft/settings',
    { mintCostWhole: '-5' }, adminHeaders);
  assert.equal(bad.status, 400);
  const bad2 = await post(base, '/api/admin/nft/settings',
    { collection: 'bogus' }, adminHeaders);
  assert.equal(bad2.status, 400);
  const bad3 = await post(base, '/api/admin/nft/settings',
    { threshold: 'abc' }, adminHeaders);
  assert.equal(bad3.status, 400);
  const noAuth = await post(base, '/api/admin/nft/settings',
    { mintCostWhole: '100' }, { 'x-admin-wallet': ADMIN, 'x-admin-secret': 'nope' });
  assert.equal(noAuth.status, 403);
  const ok = await post(base, '/api/admin/nft/settings',
    { collection: COLLECTION, mintCostWhole: '1000', bonusPerNftWhole: '5', threshold: 10 },
    adminHeaders);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mintCost, '1000000000');
  assert.equal(ok.body.threshold, 10);
  const fundBad = await post(base, '/api/admin/nft/fund',
    { amountWhole: '0' }, adminHeaders);
  assert.equal(fundBad.status, 400);
  const fundOk = await post(base, '/api/admin/nft/fund',
    { amountWhole: '2500', note: 'mint proceeds' }, adminHeaders);
  assert.equal(fundOk.status, 200);
  assert.equal(fundOk.body.available, '2500000000');
});

// --- HTTP: mint-record verification ---

test('mint-record: verified mint credits the pool once; replay is a no-op', async (t) => {
  const { server, base, store } = await seededNft();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/cosmos/tx/v1beta1/txs/')) {
      return { ok: true, json: async () => mintTx() };
    }
    return realFetch(url, opts);
  };
  try {
    const r1 = await post(base, '/api/nft/mint-record', { address: A, txhash: TXHASH });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.credited, '1000000000');
    assert.equal(r1.body.alreadyRecorded, false);
    // Pool was 100,000,000 funded; minus 15,000,000 not yet paid here,
    // plus 1,000,000,000 mint credit.
    assert.equal(store.nftBonusPoolFunded(), 1100000000n);
    const r2 = await post(base, '/api/nft/mint-record', { address: A, txhash: TXHASH });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.alreadyRecorded, true);
    assert.equal(r2.body.credited, '0');
    assert.equal(store.nftBonusPoolFunded(), 1100000000n); // no double credit
  } finally {
    global.fetch = realFetch;
  }
});

test('mint-record: unverified mint credits nothing; bad txhash rejected', async (t) => {
  const { server, base, store } = await seededNft();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const bad = await post(base, '/api/nft/mint-record', { address: A, txhash: 'xyz' });
  assert.equal(bad.status, 400);
  const realFetch = global.fetch;
  const wrongAmount = mintTx();
  wrongAmount.tx_response.events[0].attributes.find((a) => a.key === 'amount').value = '5';
  global.fetch = async (url, opts) => {
    if (String(url).includes('/cosmos/tx/v1beta1/txs/')) {
      return { ok: true, json: async () => wrongAmount };
    }
    return realFetch(url, opts);
  };
  try {
    const r = await post(base, '/api/nft/mint-record', { address: A, txhash: TXHASH });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /mint not verified/);
    assert.equal(store.nftBonusPoolFunded(), 100000000n); // unchanged
  } finally {
    global.fetch = realFetch;
  }
});
