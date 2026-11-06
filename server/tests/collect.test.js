// HTTP tests: collect flow, admin gating, referral rules — against the
// real Express app on an ephemeral port, with a FAKE payout (no chain).
// Base rewards are FRG (CW20) since migration #2: base Collect must
// route through the descriptor reward path (getRewardBalance /
// sendReward) and never the dormant USTC bank path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { createApp } from '../src/server.js';
import { FRG_TOKEN } from '../src/assets.js';

const A = 'terra1' + 'a'.repeat(38); // holder
const B = 'terra1' + 'q'.repeat(38); // referrer
const C = 'terra1' + 'p'.repeat(38); // late registrant
const ADMIN = 'terra1' + 'w'.repeat(38);
const SECRET = 'test-secret';

function fakePayout({ balance = 10_000_000n, ustcBalance = balance, configured = true } = {}) {
  const sent = []; // NFT FRG path (payout.send)
  const sentReward = []; // base reward path (descriptor-dispatched)
  const sentUstc = []; // dormant USTC path — base Collect must never use it now
  return {
    sent,
    sentReward,
    sentUstc,
    configured,
    canSend: configured,
    address: async () => 'terra1' + 'z'.repeat(38),
    // FRG CW20 balance (NFT bonus path + admin display).
    getBalance: async () => balance,
    send: async (to, amount) => {
      sent.push({ to, amount });
      return 'FAKETX123';
    },
    // Base reward routing: FRG is the live asset, so the reward
    // balance/send are the FRG CW20 ones.
    getRewardBalance: async () => balance,
    sendReward: async (to, amount) => {
      sentReward.push({ to, amount });
      return 'FAKETX123';
    },
    // USTC native path (dormant future option + admin display).
    getUstcBalance: async () => ustcBalance,
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

// Seed: a recorded day (as a payout run would leave it) where A
// was owed 1 FRG (1,000,000 base units) and B, A's referrer, earned
// the 10% referral bonus (100,000). Recorded directly through the
// store — Collect is what is under test here, not the payout run
// (payout.test.js covers that end to end).
async function seeded() {
  const payout = fakePayout();
  const ctx = await startApp({ payout });
  const { store } = ctx;
  store.registerWallet(A, B);
  store.recordDay('2026-10-24', 1_000_000n,
    [{ wallet: A, balance: 1_000_000n }],
    [{ wallet: A, amount: 1_000_000n }],
    [{ wallet: B, amount: 100_000n }]);
  return { ...ctx, payout };
}

test('collect pays the server-computed FRG amount via the CW20 reward path, and only once', async (t) => {
  const { server, base, payout } = await seeded();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const r1 = await get(base, `/api/rewards?address=${A}`);
  assert.equal(r1.body.claimable, '1000000');
  assert.equal(r1.body.rewardDenom, FRG_TOKEN);
  assert.equal(r1.body.rewardSymbol, 'FRG');
  const c1 = await post(base, '/api/collect', { address: A });
  assert.equal(c1.status, 200);
  assert.equal(c1.body.paid, '1000000');
  assert.equal(c1.body.rewardDenom, FRG_TOKEN);
  assert.equal(c1.body.rewardSymbol, 'FRG');
  assert.equal(c1.body.txhash, 'FAKETX123');
  assert.equal(payout.sentReward.length, 1);
  assert.equal(payout.sentReward[0].amount, 1000000n);
  assert.equal(payout.sentUstc.length, 0); // dormant USTC path untouched
  assert.equal(payout.sent.length, 0); // NFT send path untouched by base Collect
  const c2 = await post(base, '/api/collect', { address: A });
  assert.equal(c2.status, 400);
  assert.match(c2.body.error, /nothing to collect/);
  assert.equal(payout.sentReward.length, 1); // double-collect pays once
});

test('frontend-supplied amounts are ignored', async (t) => {
  const { server, base, payout } = await seeded();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const c = await post(base, '/api/collect', { address: A, amount: '999999999' });
  assert.equal(c.status, 200);
  assert.equal(payout.sentReward[0].amount, 1000000n); // server's number, not the client's
  assert.equal(payout.sentUstc.length, 0);
});

test('insufficient FRG reward balance fails safely, nothing marked paid', async (t) => {
  // Plenty of USTC, almost no FRG: the FRG cap is the one that binds
  // now — USTC wealth must not rescue an FRG collect.
  const payout = fakePayout({ balance: 10n, ustcBalance: 10_000_000n });
  const ctx = await startApp({ payout });
  t.after(() => { ctx.server.closeAllConnections(); ctx.server.close(); });
  ctx.store.registerWallet(A, B);
  ctx.store.recordDay('2026-10-24', 1_000_000n,
    [{ wallet: A, balance: 1_000_000n }],
    [{ wallet: A, amount: 1_000_000n }],
    [{ wallet: B, amount: 100_000n }]);
  const c = await post(ctx.base, '/api/collect', { address: A });
  assert.equal(c.status, 400);
  assert.match(c.body.error, /rewards pool empty, top up/);
  assert.equal(payout.sentReward.length, 0);
  assert.equal(payout.sentUstc.length, 0);
  const r = await get(ctx.base, `/api/rewards?address=${A}`);
  assert.equal(r.body.claimable, '1000000'); // unchanged, still collectable later
});

test('payout not configured fails safely', async (t) => {
  const ctx = await startApp({ payout: fakePayout({ configured: false }) });
  t.after(() => { ctx.server.closeAllConnections(); ctx.server.close(); });
  ctx.store.registerWallet(A, B);
  ctx.store.recordDay('2026-10-24', 1_000_000n,
    [{ wallet: A, balance: 1_000_000n }],
    [{ wallet: A, amount: 1_000_000n }],
    [{ wallet: B, amount: 100_000n }]);
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
  assert.equal(ok.body.rewardDenom, FRG_TOKEN);
  assert.equal(ok.body.rewardSymbol, 'FRG');
  assert.equal(ok.body.payoutBalance, '10000000'); // FRG CW20 balance (the live reward funds)
  assert.equal(ok.body.payoutUstcBalance, '10000000'); // dormant USTC balance still shown
  assert.equal(ok.body.rewardMigration.archivedAmount, '0'); // migration #1: fresh store, nothing legacy
  assert.equal(ok.body.rewardMigrations.length, 2); // #1 FRG->USTC, then #2 USTC->FRG
  assert.equal(ok.body.rewardMigrations[1].fromSymbol, 'USTC');
  assert.equal(ok.body.rewardMigrations[1].toSymbol, 'FRG');
  const setAmount = await post(base, '/api/admin/payout-amount',
    { amountUsd: 0.5 },
    { 'x-admin-wallet': ADMIN, 'x-admin-secret': SECRET });
  assert.equal(setAmount.status, 200);
  assert.equal(setAmount.body.dailyPayoutUsd, 0.5);
  assert.equal(setAmount.body.rewardDenom, FRG_TOKEN);
  const setAmountBad = await post(base, '/api/admin/payout-amount',
    { amountUsd: 0.5 },
    { 'x-admin-wallet': ADMIN, 'x-admin-secret': 'nope' });
  assert.equal(setAmountBad.status, 403);
  const setLimit = await post(base, '/api/admin/limit', { limitWhole: '2000' },
    { 'x-admin-wallet': ADMIN, 'x-admin-secret': SECRET });
  assert.equal(setLimit.status, 200);
  assert.equal(setLimit.body.dailyLimitWhole, '2000');
  const setMinHolding = await post(base, '/api/admin/min-holding', { limitWhole: '500' },
    { 'x-admin-wallet': ADMIN, 'x-admin-secret': SECRET });
  assert.equal(setMinHolding.status, 200);
  assert.equal(setMinHolding.body.minHoldingWhole, '500');
  const setMinHoldingBad = await post(base, '/api/admin/min-holding', { limitWhole: '500' },
    { 'x-admin-wallet': ADMIN, 'x-admin-secret': 'nope' });
  assert.equal(setMinHoldingBad.status, 403);
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

test('public stats show the two numbers distinctly: payout amount + hard limit', async (t) => {
  const { server, base } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const s = await get(base, '/api/stats');
  assert.equal(s.status, 200);
  assert.equal(s.body.rewardTiers, undefined); // tiers are gone
  assert.equal(s.body.dailyPayoutUsd, 0.5); // the set amount ships as the default
  assert.equal(s.body.dailyLimitWhole, '2000'); // the hard limit, a separate number
  assert.equal(s.body.minHoldingWhole, '100'); // PLACEHOLDER default until the owner sets his number
  assert.equal(s.body.registered, 0); // total registered (one-time, permanent)
  assert.equal(s.body.registeredLast24h, undefined); // the 24h window is gone
  assert.equal(s.body.rewardDenom, FRG_TOKEN);
  assert.equal(s.body.rewardSymbol, 'FRG');
  assert.equal(s.body.heldTokenSymbol, 'FRG');
});

test('paste-register registers the wallet permanently (one-time); rewards report it', async (t) => {
  const { server, base } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const before = await get(base, `/api/rewards?address=${A}`);
  assert.equal(before.body.registered, false);
  const r = await post(base, '/api/register', { address: A, referrer: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.registered, true);
  assert.equal(r.body.windowHours, undefined); // no window anymore
  assert.ok(r.body.registeredAt > 0);
  const after = await get(base, `/api/rewards?address=${A}`);
  assert.equal(after.body.registered, true);
  // Pasting again is harmless: still registered, same view.
  const again = await post(base, '/api/register', { address: A, referrer: null });
  assert.equal(again.status, 200);
  assert.equal(again.body.registered, true);
  const s = await get(base, '/api/stats');
  assert.equal(s.body.registered, 1); // total count, not a 24h window count
  // Paste-register rejects invalid addresses with a plain error.
  const badAddr = await post(base, '/api/register', { address: 'not-a-wallet', referrer: null });
  assert.equal(badAddr.status, 400);
  assert.match(badAddr.body.error, /invalid Terra address/);
});

test('referral bonus accrues to the referrer, collectable by them', async (t) => {
  const { server, base } = await seeded();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const r = await get(base, `/api/rewards?address=${B}`);
  assert.equal(r.body.claimable, '100000'); // 10% of A's 1,000,000
  const refs = await get(base, `/api/referrals?address=${B}`);
  assert.equal(refs.body.count, 1);
  assert.deepEqual(refs.body.referrals, [A]);
  assert.equal(refs.body.rewardSymbol, 'FRG');
});
