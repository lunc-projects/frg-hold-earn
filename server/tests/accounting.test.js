// Accounting tests (owner, 2026-11-07): the admin panel's full FRG
// accounting is built from THIS app's own records only — payout
// runs, the base payments ledger, the NFT bonus ledgers. These
// tests pin the accounting math: giveaway running totals, the
// per-run USD value at that run's OWN stored price, the bonus
// pool identity (available = funded − paid), per-wallet lines
// (including a wallet that accrued exactly 0), and CSV traceability
// (every payment row carries its finder tx link or record id).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { runPayoutDay, createApp } from '../src/server.js';
import { buildAccounting, accountingToCsv, finderTxUrl } from '../src/accounting.js';

const A = 'terra1' + 'a'.repeat(38);
const B = 'terra1' + 'q'.repeat(38);
const KUR3 = 'terra1kur3cr4vask4lgs3tr4gww7lr0zvc944gjfcqc'; // owner's monitor wallet shape
const ADMIN = 'terra1' + 'w'.repeat(38);
const FRG1 = 1_000_000n;
const T0 = new Date('2026-11-06T02:40:00Z');
const T1 = new Date('2026-11-07T02:40:00Z');
const HOUR = 3_600_000;

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frg-acct-'));
  return openStore(path.join(dir, 'test.db'));
}

function fakePayout(balance) {
  const sent = [];
  const fp = {
    sent,
    configured: true,
    getRewardBalance: async () => fp.balance,
    sendReward: async (to, amount) => {
      if (amount > fp.balance) throw new Error('insufficient funds');
      fp.balance -= amount;
      sent.push({ to, amount });
      return `TX${sent.length}`;
    },
    getBalance: async () => fp.balance,
    getUstcBalance: async () => 0n,
    address: async () => 'terra1' + 'z'.repeat(38),
  };
  fp.balance = balance;
  return fp;
}

// FRG = exactly $0.05 at this fake price; $0.50 set amount = 10 FRG.
const FAKE_PRICE = {
  frgReserveBase: 1_000_000n * FRG1, luncReserveBase: 500_000n * FRG1,
  luncUsdMicro: 100_000n, pair: 'fake-pair',
};
const fakePriceFeed = async () => FAKE_PRICE;
const balances = (map) => async (addr) => map[addr] ?? 0n;

function reg(s, wallet, when = T0.getTime() - HOUR) {
  s.registerWallet(wallet, null);
  s.recordRegistration(wallet, when);
}

async function twoRunStore() {
  const s = tmpStore();
  s.setDailyPayoutUsdMicro(500_000n); // $0.50
  s.setMinHoldingBase(0n);
  reg(s, A); reg(s, B);
  const payout = fakePayout(2_000n * FRG1);
  // Day 1: A holds 1,000, B holds 3,000 → pot 10 FRG → A 2.5, B 7.5.
  await runPayoutDay(s, payout, balances({ [A]: 1_000n * FRG1, [B]: 3_000n * FRG1 }),
    { now: T0, priceFeed: fakePriceFeed });
  // Day 2: same holdings → another 10 FRG.
  await runPayoutDay(s, payout, balances({ [A]: 1_000n * FRG1, [B]: 3_000n * FRG1 }),
    { now: T1, priceFeed: fakePriceFeed });
  return s;
}

test('giveaway ledger: running total across runs, per-wallet totals, run price USD', async () => {
  const s = await twoRunStore();
  const acct = buildAccounting(s);
  assert.equal(acct.giveaway.runCount, 2);
  // Headline: total FRG given away = both runs' paid totals.
  assert.equal(acct.giveaway.totalPaid, 20n * FRG1);
  assert.equal(acct.giveaway.totalPaidWhole, '20');
  assert.equal(acct.giveaway.totalSplit, 20n * FRG1);
  // Each run valued at its own stored price ($0.05/FRG): 10 FRG = $0.50.
  assert.equal(acct.giveaway.runs[0].priceFrgUsd, 0.05);
  assert.ok(Math.abs(acct.giveaway.runs[0].paidUsdAtRunPrice - 0.5) < 1e-9);
  assert.ok(Math.abs(acct.giveaway.totalPaidUsdAtRunPrices - 1.0) < 1e-9);
  // Per-wallet: A sent 2.5 + 2.5 = 5; B sent 7.5 + 7.5 = 15.
  const pa = acct.giveaway.perWallet.find((w) => w.wallet === A);
  const pb = acct.giveaway.perWallet.find((w) => w.wallet === B);
  assert.equal(pa.sent, 5n * FRG1);
  assert.equal(pb.sent, 15n * FRG1);
  // Run detail rows carry the tx hashes the sends recorded.
  assert.equal(acct.giveaway.runs[0].rows.find((r) => r.wallet === A).txhash, 'TX1');
  // The payments-ledger total reconciles with the run totals.
  assert.equal(acct.giveaway.ledgerPaid, 20n * FRG1);
  assert.equal(acct.recordsFrom, '2026-11-06');
});

test('empty books: zeros and a null records-from, never invented numbers', () => {
  const s = tmpStore();
  const acct = buildAccounting(s);
  assert.equal(acct.giveaway.runCount, 0);
  assert.equal(acct.giveaway.totalPaid, 0n);
  assert.equal(acct.giveaway.totalPaidUsdAtRunPrices, 0);
  assert.equal(acct.recordsFrom, null);
  assert.equal(acct.holdings.registeredCount, 0);
  assert.equal(acct.holdings.latestSnapshotDay, null);
  assert.equal(acct.holdings.totalHeldLatest, 0n);
});

test('holdings summary reads live config, never hardcoded values', async () => {
  const s = await twoRunStore();
  s.setMinHoldingBase(777n * FRG1);
  s.setDailyPayoutUsdMicro(1_250_000n);
  s.setDailyLimitBase(1_500n * FRG1);
  const acct = buildAccounting(s);
  assert.equal(acct.holdings.registeredCount, 2);
  assert.equal(acct.holdings.minHolding, 777n * FRG1);
  assert.equal(acct.holdings.dailyPayoutUsd, '1.25');
  assert.equal(acct.holdings.dailyLimit, 1_500n * FRG1);
  // Latest recorded snapshot: day 2, A 1,000 + B 3,000 = 4,000 FRG held.
  assert.equal(acct.holdings.latestSnapshotDay, '2026-11-07');
  assert.equal(acct.holdings.totalHeldLatest, 4_000n * FRG1);
});

test('NFT bonus ledger: funded − paid = available; zero-accrual wallet still listed', () => {
  const s = tmpStore();
  // Fund 20,000 FRG (the Nov 6 live funding shape).
  const fund = s.fundBonusPool(20_000n * FRG1, 'owner funding', 'FUNDTX');
  assert.equal(fund.recorded, true);
  // One snapshot day: A holds 2 Bonus-type → 2 × 4 = 8 FRG accrued.
  // KUR3's count recorded too, but it accrued 0 (excluded at count
  // time in the live story) — its line must still appear, as zeros.
  s.registerWallet(A, null); s.registerWallet(KUR3, null);
  s.recordNftDay('2026-11-06',
    [
      { wallet: A, nftCount: 2, typeCounts: { bonus: 2, common: 0, uncommon: 0 } },
      { wallet: KUR3, nftCount: 0, typeCounts: { bonus: 0, common: 0, uncommon: 0 } },
    ],
    [{ wallet: A, amount: 8n * FRG1 }]);
  // A collects the 8 FRG.
  const pid = s.createPendingNftPayment(A, 8n * FRG1);
  s.confirmNftPayment(pid, 'BONUSTX1');

  const acct = buildAccounting(s);
  assert.equal(acct.nftBonus.funded, 20_000n * FRG1);
  assert.equal(acct.nftBonus.paid, 8n * FRG1);
  // The pool identity the owner checks: available = funded − paid.
  assert.equal(acct.nftBonus.available, acct.nftBonus.funded - acct.nftBonus.paid);
  assert.equal(acct.nftBonus.available, 19_992n * FRG1);
  assert.equal(acct.nftBonus.accruedTotal, 8n * FRG1);
  assert.equal(acct.nftBonus.poolEvents.length, 1);
  assert.equal(acct.nftBonus.poolEvents[0].txhash, 'FUNDTX');
  assert.equal(acct.nftBonus.accrualDays.length, 1);
  assert.equal(acct.nftBonus.accrualDays[0].total, 8n * FRG1);
  const kur3 = acct.nftBonus.perWallet.find((w) => w.wallet === KUR3);
  assert.ok(kur3, 'the zero-accrual wallet has its own line');
  assert.equal(kur3.accrued, 0n);
  assert.equal(kur3.claimable, 0n);
  assert.equal(kur3.lastSnapshotDay, '2026-11-06');
  const pa = acct.nftBonus.perWallet.find((w) => w.wallet === A);
  assert.equal(pa.accrued, 8n * FRG1);
  assert.equal(pa.paid, 8n * FRG1);
  assert.equal(pa.claimable, 0n);
  assert.equal(pa.nftCount, 2);
});

test('CSV export: same totals, full addresses, finder tx links, record ids', async () => {
  const s = await twoRunStore();
  s.fundBonusPool(20_000n * FRG1, 'owner funding', 'FUNDTX');
  const acct = buildAccounting(s);
  const csv = accountingToCsv(acct, { payoutWallet: ADMIN, generatedAt: T1.getTime() });
  assert.match(csv, /Total FRG given away \(all runs\),20/);
  assert.match(csv, /Available = funded - paid \(FRG\),20000/);
  // Full, never truncated addresses and clickable finder links.
  assert.ok(csv.includes(A));
  assert.ok(csv.includes(`https://finder.terraclassic.community/mainnet/address/${A}`));
  assert.ok(csv.includes(finderTxUrl('TX1')));
  assert.ok(csv.includes(finderTxUrl('FUNDTX')));
  // No other product's bookkeeping leaks into this app's books.
  assert.ok(!/LDS-|Dev Studio|studio/i.test(csv));
});

test('HTTP: accounting endpoints are admin-gated and read-only shaped', async (t) => {
  const s = await twoRunStore();
  const payout = fakePayout(2_000n * FRG1);
  const app = createApp({
    store: s, payout,
    config: {
      lcdUrl: 'http://127.0.0.1:1', rpcUrl: '', adminWallet: ADMIN, adminSecret: 'test-secret',
      fetchBalance: balances({}), priceFeed: fakePriceFeed,
    },
  });
  const server = await new Promise((r) => { const srv = app.listen(0, () => r(srv)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminH = { 'x-admin-wallet': ADMIN, 'x-admin-secret': 'test-secret' };

  const denied = await fetch(`${base}/api/admin/accounting`);
  assert.equal(denied.status, 403);
  const deniedCsv = await fetch(`${base}/api/admin/accounting.csv`);
  assert.equal(deniedCsv.status, 403);

  const ok = await fetch(`${base}/api/admin/accounting`, { headers: adminH });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.giveaway.totalPaid, (20n * FRG1).toString()); // BigInt-safe strings
  assert.equal(body.giveaway.totalPaidWhole, '20');
  assert.equal(body.giveaway.runs.length, 2);
  assert.equal(body.holdings.minHoldingWhole, '0'); // this store set 0
  // Wallet snapshot block present: the FRG balance comes from the
  // payout wallet (fake here: its tracked 2,000 FRG), while the LUNC
  // read goes to the LCD — a dead port in this test — and fails
  // honestly to null rather than inventing a number.
  assert.equal(body.payoutWallet.address, 'terra1' + 'z'.repeat(38));
  assert.equal(body.payoutWallet.frg, (2_000n * FRG1).toString());
  assert.equal(body.payoutWallet.lunc, null);
  assert.ok(body.payoutWallet.readAt);

  const csvRes = await fetch(`${base}/api/admin/accounting.csv`, { headers: adminH });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type'), /text\/csv/);
  const csv = await csvRes.text();
  assert.match(csv, /FRG Hold & Earn — FRG accounting statement/);
  assert.match(csv, /Total FRG given away \(all runs\),20/);
});
