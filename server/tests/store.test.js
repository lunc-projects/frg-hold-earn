// Store tests: first-touch referral binding, idempotent days, ledger math.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';

const A = 'terra1' + 'a'.repeat(38);
const B = 'terra1' + 'q'.repeat(38);
const C = 'terra1' + 'p'.repeat(38);

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-store-'));
  return openStore(path.join(dir, 'test.db'));
}

test('first-touch referral binding is immutable', () => {
  const s = tmpStore();
  let r = s.registerWallet(A, B);
  assert.equal(r.created, true);
  assert.equal(r.referrer, B);
  r = s.registerWallet(A, C); // second touch with a different referrer
  assert.equal(r.created, false);
  assert.equal(r.referrer, B);
  r = s.registerWallet(A, null);
  assert.equal(r.referrer, B);
});

test('registration without a referrer stays without one', () => {
  const s = tmpStore();
  assert.equal(s.registerWallet(A, null).referrer, null);
  assert.equal(s.registerWallet(A, B).referrer, null);
});

test('recordDay is idempotent: a second run never double-accrues', () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  s.setDailyPool(1000n);
  const first = s.recordDay('2026-10-24', 1000n,
    [{ wallet: A, balance: 10n }],
    [{ wallet: A, amount: 1000n }], []);
  assert.equal(first.skipped, false);
  const second = s.recordDay('2026-10-24', 1000n,
    [{ wallet: A, balance: 10n }],
    [{ wallet: A, amount: 1000n }], []);
  assert.equal(second.skipped, true);
  assert.equal(s.accrued(A), 1000n);
});

test('claimable = accrued minus paid; pending counts as paid', () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  s.recordDay('2026-10-24', 1000n, [{ wallet: A, balance: 10n }],
    [{ wallet: A, amount: 1000n }], []);
  assert.equal(s.claimable(A), 1000n);
  const pid = s.createPendingPayment(A, 400n);
  assert.equal(s.claimable(A), 600n); // pending already spoken for
  s.confirmPayment(pid, 'TX1');
  assert.equal(s.claimable(A), 600n);
  assert.equal(s.paid(A), 400n);
});

test('voiding a failed payment restores claimability', () => {
  const s = tmpStore();
  s.registerWallet(A, null);
  s.recordDay('2026-10-24', 1000n, [{ wallet: A, balance: 10n }],
    [{ wallet: A, amount: 1000n }], []);
  const pid = s.createPendingPayment(A, 1000n);
  assert.equal(s.claimable(A), 0n);
  s.voidPayment(pid);
  assert.equal(s.claimable(A), 1000n);
});

test('referrals list and bonus totals', () => {
  const s = tmpStore();
  s.registerWallet(A, B);
  s.registerWallet(C, B);
  assert.deepEqual(s.referralsOf(B), [A, C].sort());
  s.recordDay('2026-10-24', 1000n,
    [{ wallet: A, balance: 10n }, { wallet: C, balance: 10n }],
    [{ wallet: A, amount: 500n }, { wallet: C, amount: 500n }],
    [{ wallet: B, amount: 100n }]);
  assert.equal(s.referralEarned(B), 100n);
  assert.equal(s.accrued(B), 100n); // bonus accrues even though B never held
});

test('defaults: pool 0, affiliate rate 10%', () => {
  const s = tmpStore();
  assert.equal(s.getDailyPool(), 0n);
  assert.equal(s.getAffiliateRateBps(), 1000);
});
