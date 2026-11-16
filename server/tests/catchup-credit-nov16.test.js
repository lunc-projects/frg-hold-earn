// Catch-up credit round 2 tests: the one-time auto-credit for
// the SAME six wallets, for the ONE extra day they were missed —
// day 2026-11-16, whose payout run fired at 19:00 ET on Nov 15,
// 6 minutes BEFORE the frozen-cutoff fix deployed at 19:06 ET,
// so it paid the same 8 wallets one last time (owner ruling,
// 2026-11-16: "it was supposed to be fixed").
//
// The credit is an ordinary base-ledger accrual per wallet
// (day '2026-11-16', kind 'catchup-2026-11-16'), applied once by
// openStore when the store's books contain the recorded payout
// run for 2026-11-16. It has its own applied flag and never
// touches the Nov 15 rows (kind 'catchup-2026-11-15'). It pays
// out through the existing Collect — no new send path exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  CATCHUP_CREDIT_2026_11_15,
  CATCHUP_CREDIT_2026_11_16,
  CATCHUP2_CREDIT_DAY,
  CATCHUP2_CREDIT_KIND,
} from '../src/store.js';
import { createApp } from '../src/server.js';
import { isValidTerraAddress } from '../src/engine.js';

const TOTAL = 868_220_551n; // 868.220551 FRG in base units
const TOTAL_R1 = 6_409_490_000n; // round 1 (Nov 15) — must stay untouched
const [W1, W2, W3, W4, W5, W6] = CATCHUP_CREDIT_2026_11_16.map(([w]) => w);
const AMOUNT = new Map(CATCHUP_CREDIT_2026_11_16.map(([w, a]) => [w, BigInt(a)]));
const AMOUNT_R1 = new Map(CATCHUP_CREDIT_2026_11_15.map(([w, a]) => [w, BigInt(a)]));
const OTHER = 'terra1' + 'q'.repeat(38); // never credited
const ADMIN = 'terra1' + 'w'.repeat(38);

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-catchup2-'));
  return path.join(dir, 'test.db');
}

// Seed the one thing round 2's incident gate looks for: the
// recorded payout run for day 2026-11-16 itself, written through
// the store's own run-record path.
function seedNov16Run(store) {
  store.savePayoutRun({
    day: '2026-11-16', status: 'partial', pressedAt: Date.parse('2026-11-16T00:00:18Z'),
    windowStart: 0, windowEnd: Date.parse('2026-11-16T00:01:24Z'),
    registeredCount: 8, totalSplit: 1_373_983_620n, potBase: 1_373_983_620n,
    payoutUsdMicro: 500_000n, totalPaid: 1_356_407_417n, shortfall: 0n,
    detail: { rows: [] },
  });
}

// Seed a round-1 incident-window run as well (for the
// coexistence test: the live store carries both).
function seedNov15Run(store) {
  store.savePayoutRun({
    day: '2026-11-15', status: 'completed', pressedAt: Date.parse('2026-11-15T00:00:42Z'),
    windowStart: 0, windowEnd: Date.parse('2026-11-15T00:01:24Z'),
    registeredCount: 16, totalSplit: 1_414_394_903n, potBase: 1_414_394_903n,
    payoutUsdMicro: 500_000n, totalPaid: 1_414_394_903n, shortfall: 0n,
    detail: { rows: [] },
  });
}

function incidentStore(file) {
  const seed = openStore(file);
  seedNov16Run(seed);
  seed.db.close();
  return openStore(file); // the boot that must apply the credit
}

test('credit table: same six valid addresses, exact total 868.220551 FRG', () => {
  assert.equal(CATCHUP_CREDIT_2026_11_16.length, 6);
  assert.deepEqual(
    CATCHUP_CREDIT_2026_11_16.map(([w]) => w),
    CATCHUP_CREDIT_2026_11_15.map(([w]) => w),
    'round 2 credits exactly the wallets round 1 credited');
  let sum = 0n;
  for (const [wallet, base] of CATCHUP_CREDIT_2026_11_16) {
    assert.ok(isValidTerraAddress(wallet), `valid address: ${wallet}`);
    sum += BigInt(base);
  }
  assert.equal(sum, TOTAL);
  assert.ok(!AMOUNT.has('terra1xketp9yp3lrvkkd6ypk2m7jkmtpxuh6yntdjmv'));
  assert.ok(!AMOUNT.has('terra1kur3cr4vask4lgs3tr4gww7lr0zvc944gjfcqc'));
});

test('a store with no 2026-11-16 run is never credited', () => {
  const s = openStore(tmpFile());
  try {
    const view = s.catchupCredit20261116();
    assert.equal(view.appliedAt, null);
    assert.deepEqual(view.rows, []);
    for (const w of AMOUNT.keys()) assert.equal(s.claimable(w), 0n);
    assert.equal(s.totalAccrued(), 0n);
  } finally { s.db.close(); }
});

test('a round-1 window run alone does not trigger round 2', () => {
  const file = tmpFile();
  const seed = openStore(file);
  seedNov15Run(seed);
  seed.db.close();
  const s = openStore(file);
  try {
    assert.equal(s.catchupCredit20261116().appliedAt, null);
    assert.deepEqual(s.catchupCredit20261116().rows, []);
    // Round 1 applied (its own gate was met) — and only round 1.
    assert.equal(s.catchupCredit20261115().rows.length, 6);
    for (const [wallet, amount] of AMOUNT_R1) assert.equal(s.claimable(wallet), amount);
    assert.equal(s.totalAccrued(), TOTAL_R1);
  } finally { s.db.close(); }
});

test('credit lands exactly once per wallet, exact to the micro', () => {
  const s = incidentStore(tmpFile());
  try {
    const view = s.catchupCredit20261116();
    assert.ok(view.appliedAt > 0, 'applied flag recorded');
    assert.equal(view.rows.length, 6);
    assert.equal(view.rows.reduce((sum, r) => sum + r.amount, 0n), TOTAL);
    for (const [wallet, amount] of AMOUNT) {
      assert.equal(s.accrualForDay(CATCHUP2_CREDIT_DAY, wallet, CATCHUP2_CREDIT_KIND), amount);
      assert.equal(s.claimable(wallet), amount); // nothing else accrued
      assert.equal(s.accrued(wallet), amount);
    }
    // Round 1 did NOT apply here (no incident-window run seeded).
    assert.equal(s.catchupCredit20261115().appliedAt, null);
    assert.deepEqual(s.catchupCredit20261115().rows, []);
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
      assert.equal(s.catchupCredit20261116().rows.length, 6);
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
  s1.db.prepare(`DELETE FROM settings WHERE key = 'catchup_2026_11_16_applied_at'`).run();
  s1.db.close();
  const s = openStore(file);
  try {
    assert.equal(s.catchupCredit20261116().rows.length, 6);
    for (const [wallet, amount] of AMOUNT) assert.equal(s.claimable(wallet), amount);
    assert.equal(s.totalAccrued(), TOTAL);
  } finally { s.db.close(); }
});

test('coexistence: both rounds apply on the live books, Nov 15 rows untouched', () => {
  const file = tmpFile();
  const seed = openStore(file);
  seedNov15Run(seed);
  seedNov16Run(seed);
  seed.db.close();
  const s = openStore(file);
  try {
    assert.equal(s.catchupCredit20261115().rows.length, 6);
    assert.equal(s.catchupCredit20261116().rows.length, 6);
    for (const [wallet, amount] of AMOUNT) {
      assert.equal(s.claimable(wallet), amount + AMOUNT_R1.get(wallet));
    }
    assert.equal(s.totalAccrued(), TOTAL + TOTAL_R1);
  } finally { s.db.close(); }
});

// ── Collect flow (HTTP, fake payout — modeled on catchup-credit.test.js) ──
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

test('a credited wallet that is not registered still claims its Nov 16 credit', async (t) => {
  const file = tmpFile();
  const store = incidentStore(file);
  assert.equal(store.registrationFor(W6), null);
  const payout = fakePayout();
  const { server, base } = await startApp(store, payout);
  t.after(() => { server.closeAllConnections(); server.close(); store.db.close(); });

  const c = await post(base, '/api/collect', { address: W6 });
  assert.equal(c.status, 200);
  assert.equal(c.body.paid, AMOUNT.get(W6).toString());
  assert.equal(payout.sentReward[0].amount, AMOUNT.get(W6));
  const c2 = await post(base, '/api/collect', { address: W6 });
  assert.equal(c2.status, 400);
  assert.match(c2.body.error, /nothing to collect/);
  assert.equal(payout.sentReward.length, 1); // paid once, never twice
});
