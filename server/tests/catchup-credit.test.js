// Catch-up credit tests: the one-time auto-credit for the six
// wallets the frozen split cutoff excluded from the Nov 8–15,
// 2026 payout runs (owner ruling, 2026-11-15: "Just auto credit
// — then when they come to claim they get extra").
//
// The credit is an ordinary base-ledger accrual per wallet
// (day '2026-11-15', kind 'catchup-2026-11-15'), applied once
// by openStore when the store's books contain a payout run
// from the incident window. It pays out through the existing
// Collect — no new send path exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  CATCHUP_CREDIT_2026_11_15,
  CATCHUP_CREDIT_DAY,
  CATCHUP_CREDIT_KIND,
} from '../src/store.js';
import { createApp } from '../src/server.js';
import { isValidTerraAddress } from '../src/engine.js';

const TOTAL = 6_409_490_000n; // 6,409.49 FRG in base units
const [W1, W2, W3, W4, W5, W6] = CATCHUP_CREDIT_2026_11_15.map(([w]) => w);
const AMOUNT = new Map(CATCHUP_CREDIT_2026_11_15.map(([w, a]) => [w, BigInt(a)]));
const OTHER = 'terra1' + 'q'.repeat(38); // never credited
const ADMIN = 'terra1' + 'w'.repeat(38);

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-catchup-'));
  return path.join(dir, 'test.db');
}

// Seed the one thing the credit's incident gate looks for: a
// recorded payout run inside the frozen-cutoff window, written
// through the store's own run-record path.
function seedIncidentRun(store, day = '2026-11-15') {
  store.savePayoutRun({
    day, status: 'completed', pressedAt: Date.parse(`${day}T00:00:42Z`),
    windowStart: 0, windowEnd: Date.parse(`${day}T00:01:24Z`),
    registeredCount: 16, totalSplit: 1_414_394_903n, potBase: 1_414_394_903n,
    payoutUsdMicro: 500_000n, totalPaid: 1_414_394_903n, shortfall: 0n,
    detail: { rows: [] },
  });
}

function incidentStore(file) {
  const seed = openStore(file);
  seedIncidentRun(seed);
  seed.db.close();
  return openStore(file); // the boot that must apply the credit
}

test('credit table: six valid addresses, exact total 6,409.49 FRG', () => {
  assert.equal(CATCHUP_CREDIT_2026_11_15.length, 6);
  let sum = 0n;
  for (const [wallet, base] of CATCHUP_CREDIT_2026_11_15) {
    assert.ok(isValidTerraAddress(wallet), `valid address: ${wallet}`);
    sum += BigInt(base);
  }
  assert.equal(sum, TOTAL);
  // The payout wallet's circular share and kur3's zero are NOT
  // in the table (excluded by design).
  assert.ok(!AMOUNT.has('terra1xketp9yp3lrvkkd6ypk2m7jkmtpxuh6yntdjmv'));
  assert.ok(!AMOUNT.has('terra1kur3cr4vask4lgs3tr4gww7lr0zvc944gjfcqc'));
});

test('a store with no incident-window run is never credited', () => {
  const s = openStore(tmpFile());
  try {
    const view = s.catchupCredit20261115();
    assert.equal(view.appliedAt, null);
    assert.deepEqual(view.rows, []);
    for (const w of AMOUNT.keys()) assert.equal(s.claimable(w), 0n);
    assert.equal(s.totalAccrued(), 0n);
  } finally { s.db.close(); }
});

test('credit lands exactly once per wallet, exact to the micro', () => {
  const s = incidentStore(tmpFile());
  try {
    const view = s.catchupCredit20261115();
    assert.ok(view.appliedAt > 0, 'applied flag recorded');
    assert.equal(view.rows.length, 6);
    assert.equal(view.rows.reduce((sum, r) => sum + r.amount, 0n), TOTAL);
    for (const [wallet, amount] of AMOUNT) {
      assert.equal(s.accrualForDay(CATCHUP_CREDIT_DAY, wallet, CATCHUP_CREDIT_KIND), amount);
      assert.equal(s.claimable(wallet), amount); // nothing else accrued
      assert.equal(s.accrued(wallet), amount);
    }
    // Nobody else gained anything.
    assert.equal(s.claimable(OTHER), 0n);
    assert.equal(s.totalAccrued(), TOTAL);
  } finally { s.db.close(); }
});

test('restart-safe: reopening the same store never double-credits', () => {
  const file = tmpFile();
  const s1 = incidentStore(file);
  s1.db.close();
  for (let i = 0; i < 2; i++) {
    const s = openStore(file);
    try {
      assert.equal(s.catchupCredit20261115().rows.length, 6);
      for (const [wallet, amount] of AMOUNT) {
        assert.equal(s.claimable(wallet), amount);
      }
      assert.equal(s.totalAccrued(), TOTAL);
    } finally { s.db.close(); }
  }
});

test('even with the applied flag lost, the ledger cannot double-credit', () => {
  const file = tmpFile();
  const s1 = incidentStore(file);
  s1.db.prepare(`DELETE FROM settings WHERE key = 'catchup_2026_11_15_applied_at'`).run();
  s1.db.close();
  const s = openStore(file);
  try {
    // UNIQUE(day, wallet, kind) + INSERT OR IGNORE: the re-run
    // inserts nothing; the flag is simply re-stamped.
    assert.equal(s.catchupCredit20261115().rows.length, 6);
    for (const [wallet, amount] of AMOUNT) assert.equal(s.claimable(wallet), amount);
    assert.equal(s.totalAccrued(), TOTAL);
  } finally { s.db.close(); }
});

// ── Collect flow (HTTP, fake payout — modeled on collect.test.js) ──
function fakePayout({ balance = 100_000_000_000n } = {}) {
  const sentReward = [];
  return {
    sentReward,
    configured: true,
    canSend: true,
    address: async () => 'terra1' + 'z'.repeat(38),
    getBalance: async () => balance,
    send: async () => { throw new Error('NFT path must not be used by base Collect'); },
    getRewardBalance: async () => balance,
    sendReward: async (to, amount) => { sentReward.push({ to, amount }); return 'FAKETX123'; },
    getUstcBalance: async () => balance,
    sendUstc: async () => { throw new Error('USTC path must not be used by base Collect'); },
  };
}

async function startApp(store, payout) {
  const app = createApp({
    store,
    payout,
    config: { lcdUrl: 'http://127.0.0.1:1', rpcUrl: '', adminWallet: ADMIN, adminSecret: 'test-secret' },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('collect pays normal accrual + catch-up credit together, exactly once', async (t) => {
  const file = tmpFile();
  const store = incidentStore(file);
  // W1 also earned a normal 500 FRG share on a recorded day.
  store.recordDay('2026-11-16', 500_000_000n,
    [{ wallet: W1, balance: 1_000_000n }],
    [{ wallet: W1, amount: 500_000_000n }],
    []);
  const payout = fakePayout();
  const { server, base } = await startApp(store, payout);
  t.after(() => { server.closeAllConnections(); server.close(); store.db.close(); });

  const expected = AMOUNT.get(W1) + 500_000_000n;
  const c1 = await post(base, '/api/collect', { address: W1 });
  assert.equal(c1.status, 200);
  assert.equal(c1.body.paid, expected.toString());
  assert.equal(payout.sentReward.length, 1);
  assert.equal(payout.sentReward[0].amount, expected);
  const c2 = await post(base, '/api/collect', { address: W1 });
  assert.equal(c2.status, 400);
  assert.match(c2.body.error, /nothing to collect/);
  assert.equal(payout.sentReward.length, 1); // paid once, never twice
});

test('a credited wallet that is not registered still claims its credit', async (t) => {
  const file = tmpFile();
  const store = incidentStore(file);
  // W6 is never registered anywhere in this store — the credit
  // is held against its address and Collect has no registration
  // gate, so its first claim pays the credit in full.
  assert.equal(store.registrationFor(W6), null);
  const payout = fakePayout();
  const { server, base } = await startApp(store, payout);
  t.after(() => { server.closeAllConnections(); server.close(); store.db.close(); });

  const c = await post(base, '/api/collect', { address: W6 });
  assert.equal(c.status, 200);
  assert.equal(c.body.paid, AMOUNT.get(W6).toString());
  assert.equal(payout.sentReward[0].amount, AMOUNT.get(W6));
});

test('an uncredited wallet collects only its own accrual — the credit leaks nowhere', async (t) => {
  const file = tmpFile();
  const store = incidentStore(file);
  store.recordDay('2026-11-16', 250_000_000n,
    [{ wallet: OTHER, balance: 1_000_000n }],
    [{ wallet: OTHER, amount: 250_000_000n }],
    []);
  const payout = fakePayout();
  const { server, base } = await startApp(store, payout);
  t.after(() => { server.closeAllConnections(); server.close(); store.db.close(); });

  const c = await post(base, '/api/collect', { address: OTHER });
  assert.equal(c.status, 200);
  assert.equal(c.body.paid, '250000000');
  assert.equal(payout.sentReward[0].amount, 250_000_000n);
});
