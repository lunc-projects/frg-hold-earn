// HTTP tests: collect flow, admin gating, referral rules — against the
// real Express app on an ephemeral port, with a FAKE payout (no chain).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { createApp, runSnapshot } from '../src/server.js';

const A = 'terra1' + 'a'.repeat(38); // holder
const B = 'terra1' + 'q'.repeat(38); // referrer
const C = 'terra1' + 'p'.repeat(38); // late registrant
const ADMIN = 'terra1' + 'w'.repeat(38);
const SECRET = 'test-secret';

function fakePayout({ balance = 10_000_000n, ustcBalance = balance, configured = true } = {}) {
  const sent = [];
  const sentUstc = [];
  return {
    sent,
    sentUstc,
    configured,
    canSend: configured,
    address: async () => 'terra1' + 'z'.repeat(38),
    // FRG CW20 path (NFT bonus only — base Collect must never use it).
    getBalance: async () => balance,
    send: async (to, amount) => {
      sent.push({ to, amount });
      return 'FAKETX123';
    },
    // USTC native path (base rewards).
    getUstcBalance: async () => ustcBalance,
    getRewardBalance: async () => ustcBalance,
    sendUstc: async (to, amount) => {
      sentUstc.push({ to, amount });
      return 'FAKETX123';
    },
  };
}

async function startApp({ payout, secret = SECRET } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-http-'));
  const store = openStore(path.join(dir, 'test.db'));
  const app = createApp({
    store,
    payout: payout || fakePayout(),
    config: { lcdUrl: 'http://127.0.0.1:1', rpcUrl: '', adminWallet: ADMIN, adminSecret: secret },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, server, base };
}

const post = (base, p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (base, p, headers = {}) => fetch(`${base}${p}`, { headers })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

// Seed: A holds 1,000,000 FRG base units on day 1, referred by B.
// Pool is 1,000,000 USTC base units (1 USTC, denom uusd), split by FRG
// weight. A earns the whole pool; B earns the 10% bonus (100,000 uusd).
async function seeded() {
  const payout = fakePayout();
  const ctx = await startApp({ payout });
  const { store } = ctx;
  store.registerWallet(A, B);
  store.setDailyPool(1_000_000n);
  await runSnapshot(store, async () => 1_000_000n, '2026-10-24');
  return { ...ctx, payout };
}

test('collect pays the server-computed USTC amount, and only once', async (t) => {
  const { server, base, payout } = await seeded();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const r1 = await get(base, `/api/rewards?address=${A}`);
  assert.equal(r1.body.claimable, '1000000');
  assert.equal(r1.body.rewardDenom, 'uusd');
  assert.equal(r1.body.rewardSymbol, 'USTC');
  const c1 = await post(base, '/api/collect', { address: A });
  assert.equal(c1.status, 200);
  assert.equal(c1.body.paid, '1000000');
  assert.equal(c1.body.rewardDenom, 'uusd');
  assert.equal(c1.body.txhash, 'FAKETX123');
  assert.equal(payout.sentUstc.length, 1);
  assert.equal(payout.sentUstc[0].amount, 1000000n);
  assert.equal(payout.sent.length, 0); // FRG CW20 path untouched by base Collect
  const c2 = await post(base, '/api/collect', { address: A });
  assert.equal(c2.status, 400);
  assert.match(c2.body.error, /nothing to collect/);
  assert.equal(payout.sentUstc.length, 1); // double-collect pays once
});

test('frontend-supplied amounts are ignored', async (t) => {
  const { server, base, payout } = await seeded();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const c = await post(base, '/api/collect', { address: A, amount: '999999999' });
  assert.equal(c.status, 200);
  assert.equal(payout.sentUstc[0].amount, 1000000n); // server's number, not the client's
  assert.equal(payout.sent.length, 0);
});

test('insufficient USTC payout balance fails safely, nothing marked paid', async (t) => {
  // Plenty of FRG, almost no USTC: the USTC cap is the one that binds.
  const payout = fakePayout({ balance: 10_000_000n, ustcBalance: 10n });
  const ctx = await startApp({ payout });
  t.after(() => { ctx.server.closeAllConnections(); ctx.server.close(); });
  ctx.store.registerWallet(A, B);
  ctx.store.setDailyPool(1_000_000n);
  await runSnapshot(ctx.store, async () => 1_000_000n, '2026-10-24');
  const c = await post(ctx.base, '/api/collect', { address: A });
  assert.equal(c.status, 400);
  assert.match(c.body.error, /rewards pool empty, top up/);
  assert.equal(payout.sentUstc.length, 0);
  assert.equal(payout.sent.length, 0);
  const r = await get(ctx.base, `/api/rewards?address=${A}`);
  assert.equal(r.body.claimable, '1000000'); // unchanged, still collectable later
});

test('payout not configured fails safely', async (t) => {
  const ctx = await startApp({ payout: fakePayout({ configured: false }) });
  t.after(() => { ctx.server.closeAllConnections(); ctx.server.close(); });
  ctx.store.registerWallet(A, B);
  ctx.store.setDailyPool(1_000_000n);
  await runSnapshot(ctx.store, async () => 1_000_000n, '2026-10-24');
  const c = await post(ctx.base, '/api/collect', { address: A });
  assert.equal(c.status, 503);
  assert.match(c.body.error, /payout wallet not configured yet/);
  assert.equal(ctx.store.claimable(A), 1000000n);
});

test('referral rules: self-link rejected, first-touch immutable', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const self = await post(base, '/api/register', { address: A, referrer: A });
  assert.equal(self.status, 400);
  const r1 = await post(base, '/api/register', { address: A, referrer: B });
  assert.equal(r1.body.referrer, B);
  const r2 = await post(base, '/api/register', { address: A, referrer: C });
  assert.equal(r2.body.referrer, B); // first touch wins
  assert.equal(store.getWallet(A).referrer, B);
});

test('late registrant earns nothing for days before they registered', async (t) => {
  const { server, base, store } = await seeded();
  t.after(() => { server.closeAllConnections(); server.close(); });
  await post(base, '/api/register', { address: C, referrer: null });
  const r = await get(base, `/api/rewards?address=${C}`);
  assert.equal(r.body.claimable, '0');
  assert.equal(store.walletCount(), 2); // A + C (B is a referrer, not a holder)
});

test('admin gating: wrong wallet/secret refused, correct pair works', async (t) => {
  const { server, base } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const noHeaders = await get(base, '/api/admin');
  assert.equal(noHeaders.status, 403);
  const wrongSecret = await get(base, '/api/admin', { 'x-admin-wallet': ADMIN, 'x-admin-secret': 'nope' });
  assert.equal(wrongSecret.status, 403);
  const wrongWallet = await get(base, '/api/admin', { 'x-admin-wallet': A, 'x-admin-secret': SECRET });
  assert.equal(wrongWallet.status, 403);
  const ok = await get(base, '/api/admin', { 'x-admin-wallet': ADMIN, 'x-admin-secret': SECRET });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rewardDenom, 'uusd');
  assert.equal(ok.body.rewardSymbol, 'USTC');
  assert.equal(ok.body.payoutBalance, '10000000'); // FRG CW20 balance still shown
  assert.equal(ok.body.payoutUstcBalance, '10000000'); // live USTC balance alongside it
  assert.equal(ok.body.rewardMigration.archivedAmount, '0'); // fresh store: migration ran, nothing legacy
  const setPool = await post(base, '/api/admin/pool', { poolWhole: '5000' },
    { 'x-admin-wallet': ADMIN, 'x-admin-secret': SECRET });
  assert.equal(setPool.status, 200);
  assert.equal(setPool.body.dailyPool, '5000000000'); // 5,000 USTC in uusd base units
  assert.equal(setPool.body.rewardDenom, 'uusd');
  const setPoolBad = await post(base, '/api/admin/pool', { poolWhole: '5000' },
    { 'x-admin-wallet': ADMIN, 'x-admin-secret': 'nope' });
  assert.equal(setPoolBad.status, 403);
  const setRate = await post(base, '/api/admin/rate', { percent: 15 },
    { 'x-admin-wallet': ADMIN, 'x-admin-secret': SECRET });
  assert.equal(setRate.status, 200);
  assert.equal(setRate.body.affiliateRateBps, 1500);
});

test('admin endpoints refuse outright when no secret is configured', async (t) => {
  const { server, base } = await startApp({ secret: '' });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const r = await get(base, '/api/admin', { 'x-admin-wallet': ADMIN, 'x-admin-secret': 'anything' });
  assert.equal(r.status, 503);
});

test('public stats denominate the daily pool and totals in USTC', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  store.setDailyPool(2_500_000n); // 2.5 USTC/day
  const s = await get(base, '/api/stats');
  assert.equal(s.status, 200);
  assert.equal(s.body.dailyPool, '2500000');
  assert.equal(s.body.dailyPoolWhole, '2.5');
  assert.equal(s.body.rewardDenom, 'uusd');
  assert.equal(s.body.rewardSymbol, 'USTC');
  assert.equal(s.body.heldTokenSymbol, 'FRG');
});

test('referral bonus accrues to the referrer, collectable by them', async (t) => {
  const { server, base } = await seeded();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const r = await get(base, `/api/rewards?address=${B}`);
  assert.equal(r.body.claimable, '100000'); // 10% of A's 1,000,000
  const refs = await get(base, `/api/referrals?address=${B}`);
  assert.equal(refs.body.count, 1);
  assert.deepEqual(refs.body.referrals, [A]);
});
