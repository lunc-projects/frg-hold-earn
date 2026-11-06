// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — backend API.
// Holders NEVER send anything and NEVER connect a wallet: they
// PASTE their address (paste-only app — a version asking to
// connect or sign is a fake). Pasting registers the wallet ONCE,
// permanently — every payout run includes ALL registered wallets
// (owner rule, 2026-11-05). The one way off the list: at a payout
// build, a registered wallet whose balance is below the owner's
// MINIMUM HOLDING limit is removed from registration entirely
// (it rejoins only by pasting again). The day's pot is the DAILY PAYOUT AMOUNT the
// owner set (USD — currently $0.50 total — converted to FRG at
// the run's live price), bounded by a HARD LIMIT of 2,000 FRG/day
// and by the pool's actual balance, and split SIMPLE PRO-RATA by
// holdings (engine.js computeSplit — no tiers). Sends happen ONLY
// when the owner presses the payout button (review-before-press)
// — no timer ever sends. Rewards are the LIVE reward asset
// (assets.js — FRG since migration #2; USTC remains the dormant
// future option). The ONLY wallet that ever sends is the payout
// wallet (payout.js).
//
// Admin auth (v1, stated limitation — see README):
// admin endpoints require BOTH headers:
//   x-admin-wallet: must equal ADMIN_WALLET env
//   x-admin-secret: must equal ADMIN_SECRET env (owner-only, Railway)
// With ADMIN_SECRET unset, admin endpoints refuse outright.
// This is a shared-secret header, NOT signed-message auth — the
// upgrade path is: admin signs a message with the admin wallet and
// the backend verifies the signature. Until then, the secret is
// typed into the admin panel per session (never baked into code,
// never stored in the browser).
// ─────────────────────────────────────────────────────────────
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import {
  computeSplit, computeBonuses, scaleAmountsToLimit,
  MIN_PAYOUT_BASE, isValidTerraAddress, parseWholeToBase, formatBaseToWhole,
} from './engine.js';
import { fetchFrgUsdPrice, amountBaseForUsd, frgUsdPrice } from './price.js';
import { rewardAssetFor } from './assets.js';
import { createPayout, cw20Balance, FRG_TOKEN } from './payout.js';
import {
  consolidateNftPower, computeNftDailyBonusByType,
  normalizeTypeCounts, emptyTypeCounts,
  validateNftSettings, validateFundingAmount,
  verifyMintTransfer, isValidTxhash,
} from './nft.js';
import { cw721TypeCountsMulti } from './nftChain.js';

// Admin wallet FOR THIS APP ONLY ("New admin" wallet, user-settled
// 2026-10-24). Other apps keep their own admins — do not change them.
// Env-overridable via ADMIN_WALLET; the frontend follows /api/stats,
// so changing it needs no app rebuild.
export const ADMIN_WALLET_DEFAULT = 'terra1xketp9yp3lrvkkd6ypk2m7jkmtpxuh6yntdjmv';
const LCD_DEFAULT = 'https://terra-classic-lcd.publicnode.com';
const RPC_DEFAULT = 'https://terra-classic-rpc.publicnode.com';

export function dayString(d = new Date()) {
  return d.toISOString().slice(0, 10); // UTC day
}

// NFT-side snapshot ONLY (base rewards no longer snapshot-accrue
// here — they are computed and paid by the owner-pressed payout
// run, see runPayoutDay). Snapshots each bound wallet's
// consolidated NFT counts across the configured bonus collections
// — broken down BY TYPE — and accrues NFT bonuses at the per-type
// rates into the SEPARATE nft ledger. Idempotent per day. If any
// NFT read FAILS, the NFT day is skipped as a whole (no partial
// counts) and can be recorded by a later run the same day.
// Wallets on the exclusion list record 0 WITHOUT any chain read
// and never accrue NFT bonus.
export async function runSnapshot(store, fetchBalance, day = dayString(), fetchNftCounts = null) {
  const wallets = store.allWallets();
  let nftOut = null;
  if (fetchNftCounts) {
    try {
      const excludedWallets = new Set(store.getNftExcludedWallets());
      const nftCounts = [];
      for (const w of wallets) {
        const typeCounts = excludedWallets.has(w.address)
          ? emptyTypeCounts()
          : normalizeTypeCounts(await fetchNftCounts(w.address));
        nftCounts.push({ wallet: w.address, nftCount: typeCounts.total, typeCounts });
      }
      const rates = store.getNftBonusRates();
      const nftBonuses = nftCounts.map(({ wallet, typeCounts }) => ({
        wallet, amount: computeNftDailyBonusByType(typeCounts, rates),
      }));
      nftOut = store.recordNftDay(day, nftCounts, nftBonuses);
    } catch (e) {
      nftOut = { skipped: true, error: `NFT bonus snapshot skipped: ${e.message}` };
    }
  }
  return { day, wallets: wallets.length, nft: nftOut, base: 'payout-run-only' };
}

// Builds the payout table for a run at `now` WITHOUT recording or
// sending anything (the admin preview and the dry run use this;
// the payout press uses the same builder, so what the owner
// reviews is exactly what the press computes).
// Participants: ALL paste-registered wallets — registration is
// one-time and permanent (no window). Balances: the day's
// AVERAGE sampled balance when samples exist (hourly sampler —
// flash-holding earns ~1/24 weight per hour), else a live read.
// MINIMUM-HOLDING ENFORCEMENT happens here, at the build: any
// registered wallet whose balance (same source as the split) is
// BELOW the owner's minimum-holding limit is REMOVED from the
// registration list entirely and takes no part in this or any
// later run until it pastes its address again. A balance AT the
// limit stays. Removed wallets are reported in `deregistered`.
// (windowStart/windowEnd survive in the table/run record shape
// for schema compatibility only: windowStart is 0 — "all
// registrations, ever" — and windowEnd is the build time.)
// The pot (owner's two numbers, never merged):
//   pot = min(daily payout amount converted at the LIVE price,
//             2,000 FRG hard limit, pool balance when known)
// The price is fetched whenever a payout amount is set and any
// registered wallet actually holds FRG — a price failure throws
// (the caller halts the run; a price is never guessed). The pot
// is then split simple pro-rata by holdings (engine computeSplit):
// the rows' amounts sum EXACTLY to the pot whenever anyone
// registered holds FRG; payout amount 0/unset means pot 0 —
// nothing pays and no price is consulted.
export async function buildPayoutTable(store, fetchBalance, { now = new Date(), priceFeed, poolBalance = null } = {}) {
  const windowEnd = now.getTime();
  const windowStart = 0; // one-time registration: no window — all registered wallets
  const regs = store.allRegistrations();
  const day = dayString(now);
  const averages = store.averageBalances(day);
  const allBalances = [];
  for (const r of regs) {
    const a = averages.get(r.wallet);
    if (a) { allBalances.push({ wallet: r.wallet, balance: a.average, src: 'avg' }); }
    else allBalances.push({ wallet: r.wallet, balance: await fetchBalance(r.wallet), src: 'live' });
  }
  // Minimum-holding deregistration (owner rule, 2026-11-05):
  // below the limit -> off the registration list entirely.
  const minHoldingBase = store.getMinHoldingBase();
  const balances = [];
  const deregistered = [];
  for (const b of allBalances) {
    if (b.balance < minHoldingBase) {
      store.removeRegistration(b.wallet);
      deregistered.push({ wallet: b.wallet, balance: b.balance });
    } else {
      balances.push(b);
    }
  }
  const averaged = balances.filter((b) => b.src === 'avg').length;
  const payoutUsdMicro = store.getDailyPayoutUsdMicro();
  const limitBase = store.getDailyLimitBase();
  const totalBalance = balances.reduce((s, r) => s + r.balance, 0n);
  let price = null;
  let amountBase = null;
  let potBase = 0n;
  if (payoutUsdMicro > 0n && totalBalance > 0n) {
    if (!priceFeed) throw new Error('price feed unavailable');
    price = await priceFeed(); // throws on any source failure -> halt
    amountBase = amountBaseForUsd(payoutUsdMicro, price);
    potBase = amountBase;
    if (potBase > limitBase) potBase = limitBase;
    if (poolBalance !== null && potBase > poolBalance) potBase = poolBalance;
  }
  const rows = computeSplit(balances, potBase);
  const totalSplit = rows.reduce((s, r) => s + r.amount, 0n);
  return {
    day, windowStart, windowEnd, registeredCount: balances.length,
    rows, totalSplit, totalBalance, payoutUsdMicro, amountBase,
    limitBase, poolBalance, potBase, price,
    minHoldingBase, deregistered,
    balanceSource: { averaged, live: balances.length - averaged },
  };
}

// THE owner-pressed payout run. One run per day:
// 1. If the day is not recorded yet, the table is built (above)
//    and the day's accruals are recorded ONCE from the split
//    amounts (frozen forever — later setting changes or
//    registrations can never alter a recorded day). A price
//    failure at this point HALTS the run: a 'halted_price' run
//    record is saved, nothing is recorded, nothing is paid.
// 2. Pay phase: each participant's CLAIMABLE (all accruals minus
//    all payments — so carried sub-dust amounts from earlier days
//    join in) is sent via the payout wallet's reward path, when it
//    reaches MIN_PAYOUT_BASE (1 FRG); below that it stays accrued
//    (carried). POOL GUARD: if the total to send exceeds the
//    payout wallet's actual FRG balance, sends scale down
//    pro-rata to exactly the balance; the unpaid remainder stays
//    claimable and the shortfall is recorded in the run record.
// 3. Every send is a pending -> confirmed payment row with its tx
//    hash; a failed send voids its row and is reported, never
//    faked. Re-pressing the same day pays only what is still
//    claimable — a wallet can never be paid twice for a day.
export async function runPayoutDay(store, payout, fetchBalance, { now = new Date(), priceFeed } = {}) {
  const day = dayString(now);
  const payoutUsdMicro = store.getDailyPayoutUsdMicro();
  let table = null;
  if (!store.dayRecorded(day)) {
    // The pool balance bounds the pot, so read it before building
    // the table. If the read fails, the table is built without it
    // and the pay phase's own pool guard still bounds the sends.
    let poolBalance = null;
    try { poolBalance = await payout.getRewardBalance(); } catch { poolBalance = null; }
    try {
      table = await buildPayoutTable(store, fetchBalance, { now, priceFeed, poolBalance });
    } catch (e) {
      const rec = {
        day, status: 'halted_price', pressedAt: now.getTime(),
        windowStart: 0, windowEnd: now.getTime(),
        registeredCount: store.allRegistrations().length,
        totalSplit: 0n, potBase: null, payoutUsdMicro, totalPaid: 0n, shortfall: 0n,
        detail: { rows: [], price: null, error: `payout halted: ${e.message}` },
      };
      store.savePayoutRun(rec);
      return { ...rec, halted: true };
    }
    const referralOf = new Map(store.allWallets().map((w) => [w.address, w.referrer]));
    const bonuses = computeBonuses(
      table.rows.map(({ wallet, amount }) => ({ wallet, amount })),
      referralOf, store.getAffiliateRateBps());
    store.recordDay(day, table.potBase,
      table.rows.map(({ wallet, balance }) => ({ wallet, balance })),
      table.rows.map(({ wallet, amount }) => ({ wallet, amount })),
      bonuses);
  } else {
    // Day already recorded (re-press): rebuild the display table
    // from the frozen record — amounts never recompute.
    const snaps = store.daySnapshots(day);
    const rows = snaps.map((s) => ({
      wallet: s.wallet, balance: s.balance,
      amount: store.accrualForDay(day, s.wallet, 'share'),
    }));
    const prev = store.getPayoutRun(day);
    table = {
      day, windowStart: prev?.windowStart ?? 0,
      windowEnd: prev?.windowEnd ?? now.getTime(),
      registeredCount: prev?.registeredCount ?? rows.length,
      rows,
      totalSplit: rows.reduce((s, r) => s + r.amount, 0n),
      totalBalance: rows.reduce((s, r) => s + r.balance, 0n),
      payoutUsdMicro, amountBase: null,
      limitBase: store.getDailyLimitBase(), poolBalance: null,
      potBase: prev?.potBase ?? null, price: null,
      // A recorded day is frozen: no deregistration on a re-press.
      minHoldingBase: store.getMinHoldingBase(), deregistered: [],
      balanceSource: { averaged: 0, live: 0 },
    };
  }

  // Pay phase.
  const available = await payout.getRewardBalance();
  const payList = [];
  for (const row of table.rows) {
    const claimable = store.claimable(row.wallet);
    row.claimable = claimable;
    if (claimable >= MIN_PAYOUT_BASE) payList.push({ wallet: row.wallet, amount: claimable });
    row.payStatus = claimable <= 0n ? 'nothing-owed' : claimable < MIN_PAYOUT_BASE ? 'carried-dust' : 'queued';
  }
  const totalToSend = payList.reduce((s, p) => s + p.amount, 0n);
  let shortfall = 0n;
  let sendList = payList;
  if (totalToSend > available) {
    shortfall = totalToSend - available;
    sendList = available <= 0n ? []
      : scaleAmountsToLimit(payList.map((p) => ({ ...p })), available);
  }
  const sendByWallet = new Map(sendList.map((p) => [p.wallet, p.amount]));
  let totalPaidThisPress = 0n;
  const failures = [];
  for (const row of table.rows) {
    const amount = sendByWallet.get(row.wallet) || 0n;
    row.sendAmount = amount;
    if (amount <= 0n) continue;
    const paymentId = store.createPendingPayment(row.wallet, amount);
    try {
      const txhash = await payout.sendReward(row.wallet, amount);
      store.confirmPayment(paymentId, txhash);
      row.txhash = txhash;
      row.payStatus = amount < row.claimable ? 'paid-partial-pool' : 'paid';
      totalPaidThisPress += amount;
    } catch (e) {
      store.voidPayment(paymentId);
      row.payStatus = 'send-failed';
      row.error = e.message;
      failures.push(row.wallet);
    }
  }
  const prev = store.getPayoutRun(day);
  const totalPaid = (prev && prev.status !== 'halted_price' ? prev.totalPaid : 0n) + totalPaidThisPress;
  const status = failures.length
    ? 'partial'
    : shortfall > 0n
      ? (totalPaidThisPress > 0n ? 'partial_pool' : 'pool_empty')
      : 'completed';
  const rec = {
    day, status, pressedAt: now.getTime(),
    windowStart: table.windowStart, windowEnd: table.windowEnd,
    registeredCount: table.registeredCount,
    totalSplit: table.totalSplit, potBase: table.potBase, payoutUsdMicro,
    totalPaid, shortfall,
    detail: {
      rows: table.rows.map((r) => ({
        wallet: r.wallet, balance: r.balance.toString(),
        amount: r.amount.toString(),
        claimable: (r.claimable ?? 0n).toString(),
        sent: (r.sendAmount ?? 0n).toString(),
        txhash: r.txhash || null, payStatus: r.payStatus || null,
        error: r.error || null,
      })),
      price: table.price ? {
        frgUsd: frgUsdPrice(table.price),
        luncUsdMicro: table.price.luncUsdMicro.toString(),
        frgReserveBase: table.price.frgReserveBase.toString(),
        luncReserveBase: table.price.luncReserveBase.toString(),
      } : null,
      amountBase: table.amountBase === null ? null : table.amountBase.toString(),
      limitBase: table.limitBase.toString(),
      poolBalance: table.poolBalance === null ? null : table.poolBalance.toString(),
      minHoldingBase: (table.minHoldingBase ?? 0n).toString(),
      deregistered: (table.deregistered ?? []).map((d) => ({
        wallet: d.wallet, balance: d.balance.toString(),
      })),
    },
  };
  store.savePayoutRun(rec);
  return rec;
}

// One sampling round: record every registered wallet's current FRG
// balance under the current UTC day+hour. A wallet whose read fails
// simply misses that hour (its average uses the hours that did land);
// one failure never blocks the others. Also prunes samples older than
// 7 days — a passed day can never be re-snapshotted, so they are
// never read again.
export async function runBalanceSampling(store, fetchBalance, now = new Date()) {
  const day = dayString(now);
  const hour = now.getUTCHours();
  let sampled = 0;
  let failed = 0;
  for (const w of store.allWallets()) {
    try {
      store.recordBalanceSample(day, w.address, hour, await fetchBalance(w.address));
      sampled++;
    } catch { failed++; }
  }
  const cutoff = dayString(new Date(now.getTime() - 7 * 24 * 3600 * 1000));
  store.pruneSamples(cutoff);
  return { day, hour, sampled, failed };
}

// Tiny async mutex so two simultaneous collects can't double-pay.
function createMutex() {
  let tail = Promise.resolve();
  return async (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

export function createApp({ store, payout, config }) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  const collectMutex = createMutex();
  const adminWallet = config.adminWallet;
  const adminSecret = config.adminSecret;

  const bad = (res, status, error) => res.status(status).json({ error });
  const validAddr = (req, res) => {
    const addr = (req.query.address || req.body?.address || '').trim();
    if (!isValidTerraAddress(addr)) { bad(res, 400, 'invalid Terra address'); return null; }
    return addr;
  };
  // Base reward metadata comes from the ONE reward-asset
  // descriptor (assets.js), resolved from the store's operative
  // reward_symbol — FRG since migration #2. The frontend renders
  // these fields; no currency is hard-coded in the page.
  const rewardAsset = rewardAssetFor(store.getRewardSymbol());
  const rewardMeta = {
    rewardDenom: rewardAsset.denom,
    rewardSymbol: rewardAsset.symbol,
    rewardCurrency: rewardAsset.symbol,
    rewardAssetKind: rewardAsset.kind,
  };
  const migrationFields = (m) => ({
    id: m.id,
    fromSymbol: m.fromSymbol,
    toSymbol: m.toSymbol,
    toDenom: m.toDenom,
    archivedRows: m.archivedRows,
    archivedAmount: m.archivedAmount.toString(),
    archivedAmountWhole: formatBaseToWhole(m.archivedAmount),
    archivedUnpaidAmount: m.archivedUnpaidAmount.toString(),
    archivedUnpaidAmountWhole: formatBaseToWhole(m.archivedUnpaidAmount),
    legacyDailyPool: m.legacyDailyPool.toString(),
    legacyDailyPoolWhole: formatBaseToWhole(m.legacyDailyPool),
    migratedAt: m.migratedAt,
  });
  // First migration (FRG -> USTC) — kept for the existing admin view.
  const migrationView = () => {
    const m = store.getRewardCurrencyMigration();
    return m ? migrationFields(m) : null;
  };
  // The full ordered switch history (#1 FRG->USTC, #2 USTC->FRG).
  const migrationsView = () => store.getRewardCurrencyMigrations().map(migrationFields);

  // Per-type bonus rates as exposed on the public/admin views:
  // base-unit strings + whole-FRG strings + the honest "set" flag
  // (set = at least one type pays something; all three at 0 is the
  // unset state — counts still record by type, nothing accrues).
  const nftRatesView = (s) => ({
    bonusRateSet: s.bonusRates.bonus > 0n || s.bonusRates.common > 0n || s.bonusRates.uncommon > 0n,
    bonusRates: {
      bonus: s.bonusRates.bonus.toString(),
      common: s.bonusRates.common.toString(),
      uncommon: s.bonusRates.uncommon.toString(),
    },
    bonusRatesWhole: {
      bonus: formatBaseToWhole(s.bonusRates.bonus),
      common: formatBaseToWhole(s.bonusRates.common),
      uncommon: formatBaseToWhole(s.bonusRates.uncommon),
    },
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // The payout machinery's injectables: tests pass fakes; production
  // uses the live LCD balance read + the live price feed.
  const fetchBalanceLive = config.fetchBalance
    || ((addr) => cw20Balance(config.lcdUrl, FRG_TOKEN, addr));
  const priceFeedLive = config.priceFeed
    || (() => fetchFrgUsdPrice({ lcdUrl: config.lcdUrl }));

  // The program's two numbers, exposed publicly/admin as distinct
  // fields: the DAILY PAYOUT AMOUNT (USD — the amount set to be
  // split each day) and the DAILY HARD LIMIT (FRG — a ceiling
  // only, never a promised amount).
  const payoutAmountView = () => ({
    dailyPayoutUsdMicro: store.getDailyPayoutUsdMicro().toString(),
    dailyPayoutUsd: Number(store.getDailyPayoutUsdMicro()) / 1_000_000,
  });
  const limitView = () => ({
    dailyLimitBase: store.getDailyLimitBase().toString(),
    dailyLimitWhole: formatBaseToWhole(store.getDailyLimitBase()),
  });
  // The minimum holding a registered wallet must keep to STAY
  // registered (below it at a payout build = removed from the
  // list). Ships with a PLACEHOLDER default of 100 FRG until the
  // owner sets his real number.
  const minHoldingView = () => ({
    minHoldingBase: store.getMinHoldingBase().toString(),
    minHoldingWhole: formatBaseToWhole(store.getMinHoldingBase()),
  });
  const payoutRunView = (run) => (run ? {
    day: run.day, status: run.status, pressedAt: run.pressedAt,
    registeredCount: run.registeredCount,
    totalSplit: run.totalSplit.toString(), totalSplitWhole: formatBaseToWhole(run.totalSplit),
    potBase: run.potBase === null ? null : run.potBase.toString(),
    potWhole: run.potBase === null ? null : formatBaseToWhole(run.potBase),
    payoutUsdMicro: run.payoutUsdMicro.toString(),
    totalPaid: run.totalPaid.toString(), totalPaidWhole: formatBaseToWhole(run.totalPaid),
    shortfall: run.shortfall.toString(),
    detail: run.detail,
  } : null);

  // Public totals — honest numbers straight from the ledger.
  app.get('/api/stats', (_req, res) => res.json({
    holders: store.walletCount(),
    ...rewardMeta,
    heldTokenSymbol: 'FRG',
    totalAccrued: store.totalAccrued().toString(),
    totalPaid: store.totalPaid().toString(),
    snapshotDays: store.snapshotDays(),
    // Count only (no balances): proves the hourly sampler is running.
    balanceSamplesToday: store.sampleStats(dayString()).samples,
    // The daily payout amount + hard limit are the program's
    // public shape (two distinct numbers), plus the minimum
    // holding a registered wallet must keep.
    ...payoutAmountView(),
    ...limitView(),
    ...minHoldingView(),
    // Total wallets registered right now. Registration is
    // one-time and permanent — this is the count the next payout
    // run starts from (a build may still remove below-minimum
    // wallets, per the rule above).
    registered: store.allRegistrations().length,
    lastPayoutRun: payoutRunView(store.latestPayoutRun()),
    affiliateRatePercent: store.getAffiliateRateBps() / 100,
    // NFT section (additive — base stats above are untouched).
    nft: (() => {
      const s = store.getNftSettings();
      return {
        configured: s.collection !== '',
        collection: s.collection,
        collections: s.collections,
        excludedWallets: s.excludedWallets,
        bonusCollectionsConfigured: s.collections.length > 0,
        ...nftRatesView(s),
        threshold: s.threshold,
        thresholdSet: s.threshold > 0,
        mintCostWhole: formatBaseToWhole(s.mintCost),
        supplyCap: s.supplyCap,
        mintReady: s.collection !== '' && s.mintCost > 0n && s.bonusPoolWallet !== '',
      };
    })(),
    // Public address only (knowing it grants nothing — admin calls
    // still need the secret). The frontend uses this, not a baked-in
    // constant, as the admin-panel gate, so the admin wallet can be
    // changed by env alone — its role for this app is still TBD.
    adminWallet: config.adminWallet,
  }));

  // LCD passthrough: live FRG balance for any wallet.
  app.get('/api/balance', async (req, res) => {
    const addr = validAddr(req, res); if (!addr) return;
    try {
      const balance = await cw20Balance(config.lcdUrl, FRG_TOKEN, addr);
      res.json({ address: addr, balance: balance.toString(), whole: formatBaseToWhole(balance) });
    } catch (e) {
      bad(res, 502, `balance lookup failed: ${e.message}`);
    }
  });

  // Registration: THE paste path (the app is paste-only — no
  // wallet connect exists). Pasting a valid address registers it
  // PERMANENTLY (one-time — owner rule, 2026-11-05): the
  // first-touch referral binding is recorded (immutable) and the
  // wallet joins the registration list for good. Pasting again
  // later is harmless — it just shows the wallet's balance/rewards
  // view; the only way off the list is the minimum-holding rule
  // at a payout build. Invalid addresses are rejected with a
  // plain error; nothing is recorded for them.
  app.post('/api/register', (req, res) => {
    const addr = validAddr(req, res); if (!addr) return;
    const referrer = (req.body?.referrer || '').trim() || null;
    if (referrer) {
      if (!isValidTerraAddress(referrer)) return bad(res, 400, 'invalid referrer address');
      if (referrer === addr) return bad(res, 400, 'referrer cannot be your own wallet');
    }
    const out = store.registerWallet(addr, referrer);
    const reg = store.recordRegistration(addr, Date.now());
    res.json({ ...out, registeredAt: reg.registeredAt, registered: true });
  });

  app.get('/api/rewards', (req, res) => {
    const addr = validAddr(req, res); if (!addr) return;
    const accrued = store.accrued(addr);
    const paid = store.paid(addr);
    const registeredAt = store.registrationFor(addr);
    res.json({
      address: addr,
      ...rewardMeta,
      // Is this wallet on the (permanent) registration list?
      registeredAt,
      registered: registeredAt !== null,
      accrued: accrued.toString(), accruedWhole: formatBaseToWhole(accrued),
      paid: paid.toString(), paidWhole: formatBaseToWhole(paid),
      claimable: store.claimable(addr).toString(),
      claimableWhole: formatBaseToWhole(store.claimable(addr)),
    });
  });

  app.get('/api/referrals', (req, res) => {
    const addr = validAddr(req, res); if (!addr) return;
    const list = store.referralsOf(addr);
    res.json({
      address: addr, count: list.length, referrals: list,
      ...rewardMeta,
      bonusEarned: store.referralEarned(addr).toString(),
      bonusEarnedWhole: formatBaseToWhole(store.referralEarned(addr)),
    });
  });

  // Collect: the server recomputes everything. The frontend sends ONLY
  // an address — any amount it claims is ignored by design.
  app.post('/api/collect', async (req, res) => {
    const addr = validAddr(req, res); if (!addr) return;
    if (!payout.configured) return bad(res, 503, 'payout wallet not configured yet');
    try {
      const result = await collectMutex(async () => {
        const claim = store.claimable(addr);
        if (claim <= 0n) throw Object.assign(new Error('nothing to collect yet'), { status: 400 });
        const paymentId = store.createPendingPayment(addr, claim);
        try {
          // Base rewards pay in the LIVE reward asset: cap against
          // the payout wallet's ACTUAL reward-asset balance and send
          // via the descriptor-dispatched path (payout.js) — FRG
          // CW20 today; the USTC native path revives only if the
          // USTC descriptor is ever selected again.
          const balance = await payout.getRewardBalance();
          if (balance < claim) throw Object.assign(new Error('rewards pool empty, top up'), { status: 400 });
          const txhash = await payout.sendReward(addr, claim);
          store.confirmPayment(paymentId, txhash);
          return {
            paid: claim.toString(), paidWhole: formatBaseToWhole(claim), txhash,
            ...rewardMeta,
          };
        } catch (e) {
          store.voidPayment(paymentId);
          throw e;
        }
      });
      res.json(result);
    } catch (e) {
      bad(res, e.status || 500, e.message);
    }
  });

  // --- NFT bonus section (separate ledger, separate pool) ---
  // Base rewards are untouched: this section only ADDS the NFT bonus.
  // Until a collection is configured, bonus holdings read as zero and
  // minting is honestly not open — there is no mint button that
  // pretends otherwise, anywhere in the app.
  function nftView(addr) {
    const s = store.getNftSettings();
    // Bonus configuration = the bonus collections list (which falls
    // back to the legacy single collection when never set). Counts and
    // power read against THAT; the mint fields below stay keyed to the
    // single mint collection, a separate flow.
    const configured = s.collections.length > 0;
    const count = configured ? store.latestNftCount(addr) : 0;
    const typeCounts = configured ? store.latestNftTypeCounts(addr) : { bonus: 0, common: 0, uncommon: 0 };
    const power = consolidateNftPower(count, s.threshold);
    const ratesView = nftRatesView(s);
    const bonusRateSet = ratesView.bonusRateSet;
    const bonusNotice = !configured
      ? 'No NFT bonus collections are connected yet — NFT bonus holdings read as zero.'
      : !bonusRateSet
        ? 'NFT bonus collections are connected, but the bonus rates are not set yet — NFT counts are recorded by type, but no NFT bonus accrues until the admin sets the per-type bonus rates.'
        : `NFT bonus is active: Bonus ${ratesView.bonusRatesWhole.bonus} FRG, Common ${ratesView.bonusRatesWhole.common} FRG, Uncommon ${ratesView.bonusRatesWhole.uncommon} FRG per NFT per snapshot day, counted across ${s.collections.length} connected collection${s.collections.length === 1 ? '' : 's'}.`;
    const mintReady = s.collection !== '' && s.mintCost > 0n && s.bonusPoolWallet !== '';
    const mintNotice = !configured
      ? 'Minting is not open yet — no NFT collection is configured.'
      : s.mintCost <= 0n
        ? 'Minting is not open yet — the admin has not set a mint price.'
        : s.bonusPoolWallet === ''
          ? 'Minting is not open yet — the bonus pool wallet is not set.'
          : 'Ready to mint — the app checks the collection contract before signing.';
    return {
      address: addr,
      configured,
      collection: s.collection,
      collections: s.collections,
      excludedWallets: s.excludedWallets,
      walletExcluded: s.excludedWallets.includes(addr),
      bonusRateSet,
      bonusNotice,
      mintReady,
      mintNotice,
      nftCount: power.nftCount,
      nftTypeCounts: typeCounts,
      power: power.power,
      chargePct: power.chargePct,
      fullyPowered: power.fullyPowered,
      threshold: s.threshold,
      thresholdSet: power.thresholdSet,
      bonusRates: ratesView.bonusRates,
      bonusRatesWhole: ratesView.bonusRatesWhole,
      mintCost: s.mintCost.toString(),
      mintCostWhole: formatBaseToWhole(s.mintCost),
      supplyCap: s.supplyCap,
      accrued: store.nftAccrued(addr).toString(),
      accruedWhole: formatBaseToWhole(store.nftAccrued(addr)),
      paid: store.nftPaid(addr).toString(),
      paidWhole: formatBaseToWhole(store.nftPaid(addr)),
      claimable: store.nftClaimable(addr).toString(),
      claimableWhole: formatBaseToWhole(store.nftClaimable(addr)),
      bonusPoolWallet: s.bonusPoolWallet,
      bonusPoolFunded: store.nftBonusPoolFunded().toString(),
      bonusPoolFundedWhole: formatBaseToWhole(store.nftBonusPoolFunded()),
      bonusPoolAvailable: store.nftBonusPoolAvailable().toString(),
      bonusPoolAvailableWhole: formatBaseToWhole(store.nftBonusPoolAvailable()),
      lastSnapshotDay: configured ? store.lastNftSnapshotDay(addr) : null,
      snapshotDays: store.nftSnapshotDays(),
    };
  }

  app.get('/api/nft', (req, res) => {
    const addr = validAddr(req, res); if (!addr) return;
    res.json(nftView(addr));
  });

  // Bonus Collect: same safety pattern as base Collect (pending counts
  // as paid, failed send voids and stays collectable), but against the
  // SEPARATE bonus pool ledger. Sends go out through the payout wallet
  // (the only key on the server) and are capped by the tracked bonus
  // pool balance — never more than mint fees actually recorded.
  // Blocked until a bonus pool wallet is set, and until the payout
  // wallet is configured.
  app.post('/api/nft/collect', async (req, res) => {
    const addr = validAddr(req, res); if (!addr) return;
    if (store.getNftBonusPoolWallet() === '') return bad(res, 503, 'bonus pool wallet not set yet');
    if (!payout.configured) return bad(res, 503, 'payout wallet not configured yet');
    try {
      const result = await collectMutex(async () => {
        const claim = store.nftClaimable(addr);
        if (claim <= 0n) throw Object.assign(new Error('nothing to collect yet'), { status: 400 });
        const paymentId = store.createPendingNftPayment(addr, claim);
        try {
          const available = store.nftBonusPoolAvailable();
          if (available < claim) throw Object.assign(new Error('bonus pool empty, top up'), { status: 400 });
          // NFT bonus is an FRG mechanic by design, on its own
          // ledger and pool: this route intentionally uses the FRG
          // CW20 balance/send path directly (never the base reward
          // routing), so the two ledgers can never mix.
          const balance = await payout.getBalance();
          if (balance < claim) throw Object.assign(new Error('rewards pool empty, top up'), { status: 400 });
          const txhash = await payout.send(addr, claim);
          store.confirmNftPayment(paymentId, txhash);
          return { paid: claim.toString(), paidWhole: formatBaseToWhole(claim), txhash };
        } catch (e) {
          store.voidNftPayment(paymentId);
          throw e;
        }
      });
      res.json(result);
    } catch (e) {
      bad(res, e.status || 500, e.message);
    }
  });

  // Mint record: after a wallet-signed mint on the app, the frontend
  // reports ONLY the txhash. The backend verifies the mint on-chain
  // (tx succeeded, buyer sent to the collection, exactly the mint fee
  // reached the bonus pool wallet) and only then credits the tracked
  // bonus pool. A txhash already recorded is a no-op, never a double
  // credit. Nothing here is trusted from the client.
  app.post('/api/nft/mint-record', async (req, res) => {
    const buyer = validAddr(req, res); if (!buyer) return;
    const txhash = (req.body?.txhash || '').trim();
    if (!isValidTxhash(txhash)) return bad(res, 400, 'invalid txhash');
    const s = store.getNftSettings();
    if (!s.collection) return bad(res, 400, 'no NFT collection configured');
    if (s.bonusPoolWallet === '') return bad(res, 400, 'bonus pool wallet not set');
    if (s.mintCost <= 0n) return bad(res, 400, 'mint price not set');
    try {
      const txRes = await fetch(`${config.lcdUrl}/cosmos/tx/v1beta1/txs/${txhash}`);
      if (!txRes.ok) return bad(res, 502, 'transaction lookup failed');
      const txJson = await txRes.json();
      const v = verifyMintTransfer(txJson, {
        txhash, buyer, collection: s.collection,
        bonusPoolWallet: s.bonusPoolWallet, mintCostBase: s.mintCost, frgToken: FRG_TOKEN,
      });
      if (!v.ok) return bad(res, 400, `mint not verified: ${v.reason}`);
      const out = store.fundBonusPool(s.mintCost, `mint ${txhash}`, txhash);
      res.json({
        credited: out.recorded ? s.mintCost.toString() : '0',
        creditedWhole: out.recorded ? formatBaseToWhole(s.mintCost) : '0',
        alreadyRecorded: !out.recorded,
        bonusPoolAvailable: store.nftBonusPoolAvailable().toString(),
        bonusPoolAvailableWhole: formatBaseToWhole(store.nftBonusPoolAvailable()),
      });
    } catch (e) {
      bad(res, 502, `mint verification failed: ${e.message}`);
    }
  });

  // --- Admin (shared-secret header, v1 — see header note) ---
  function requireAdmin(req, res, next) {
    if (!adminSecret) return bad(res, 503, 'admin not configured');
    if (req.headers['x-admin-wallet'] !== adminWallet ||
        req.headers['x-admin-secret'] !== adminSecret) {
      return bad(res, 403, 'admin only');
    }
    next();
  }

  app.get('/api/admin', requireAdmin, async (_req, res) => {
    // Balance display is read-only from LCD: it works with the payout
    // ADDRESS alone and needs no key. Sending is a separate flag.
    const payoutAddress = await payout.address();
    let payoutBalance = null;
    let payoutUstcBalance = null;
    try { if (payoutAddress) payoutBalance = (await payout.getBalance()).toString(); } catch { /* show null */ }
    try { if (payoutAddress) payoutUstcBalance = (await payout.getUstcBalance()).toString(); } catch { /* show null */ }
    res.json({
      holders: store.walletCount(),
      ...rewardMeta,
      totalAccrued: store.totalAccrued().toString(),
      totalPaid: store.totalPaid().toString(),
      snapshotDays: store.snapshotDays(),
      ...payoutAmountView(),
      ...limitView(),
      ...minHoldingView(),
      registered: store.allRegistrations().length,
      lastPayoutRun: payoutRunView(store.latestPayoutRun()),
      affiliateRateBps: store.getAffiliateRateBps(),
      affiliateRatePercent: store.getAffiliateRateBps() / 100,
      payoutCanSend: payout.configured,
      payoutAddress,
      // payoutBalance is the FRG CW20 balance (the live reward
      // balance AND the NFT bonus path's funding view).
      // payoutUstcBalance is the wallet's USTC bank balance — the
      // dormant future option's funding view; base Collect caps
      // against it only if USTC is ever selected again.
      payoutBalance,
      payoutBalanceWhole: payoutBalance === null ? null : formatBaseToWhole(BigInt(payoutBalance)),
      payoutUstcBalance,
      payoutUstcBalanceWhole: payoutUstcBalance === null ? null : formatBaseToWhole(BigInt(payoutUstcBalance)),
      rewardMigration: migrationView(),
      rewardMigrations: migrationsView(),
      balanceSamples: store.sampleStats(dayString()),
      nft: (() => {
        const s = store.getNftSettings();
        return {
          collection: s.collection,
          collections: s.collections,
          excludedWallets: s.excludedWallets,
          ...nftRatesView(s),
          mintCostWhole: formatBaseToWhole(s.mintCost),
          threshold: s.threshold,
          supplyCap: s.supplyCap,
          bonusPoolWallet: s.bonusPoolWallet,
          bonusPoolFundedWhole: formatBaseToWhole(store.nftBonusPoolFunded()),
          bonusPoolAvailableWhole: formatBaseToWhole(store.nftBonusPoolAvailable()),
          snapshotDays: store.nftSnapshotDays(),
        };
      })(),
    });
  });

  // Sets the DAILY PAYOUT AMOUNT in USD — the specific amount to
  // be split between all registered holders that day (owner's
  // current value: $0.50). Stored as micro-USD; converted to FRG
  // at each run's live price. 0 = nothing pays that day. Changing
  // it never alters a recorded day: recorded days pay from their
  // frozen accruals.
  app.post('/api/admin/payout-amount', requireAdmin, (req, res) => {
    try {
      const usd = Number(req.body?.amountUsd);
      if (!Number.isFinite(usd) || usd < 0 || usd > 1_000_000) throw new Error('payout amount must be a USD amount ≥ 0');
      const micro = BigInt(Math.round(usd * 1_000_000));
      store.setDailyPayoutUsdMicro(micro);
      res.json({ ...payoutAmountView(), ...rewardMeta });
    } catch (e) { bad(res, 400, e.message || 'invalid payout amount'); }
  });

  // Sets the DAILY HARD LIMIT in FRG (whole-token amount) — an
  // absolute ceiling on a day's payout, never a target (owner's
  // number: 2,000 FRG/day). A day never pays more than this.
  app.post('/api/admin/limit', requireAdmin, (req, res) => {
    try {
      const base = parseWholeToBase(String(req.body?.limitWhole ?? ''));
      store.setDailyLimitBase(base);
      res.json({ ...limitView(), ...rewardMeta });
    } catch (e) { bad(res, 400, e.message || 'invalid limit'); }
  });

  // Sets the MINIMUM HOLDING in FRG (whole-token amount) — the
  // balance a registered wallet must keep to STAY registered. At
  // each payout build, a registered wallet below this is removed
  // from the registration list entirely (rejoin = paste again).
  // SHIPPED DEFAULT IS A PLACEHOLDER (100 FRG) until the owner
  // sets his real number here.
  app.post('/api/admin/min-holding', requireAdmin, (req, res) => {
    try {
      const base = parseWholeToBase(String(req.body?.limitWhole ?? ''));
      store.setMinHoldingBase(base);
      res.json({ ...minHoldingView(), ...rewardMeta });
    } catch (e) { bad(res, 400, e.message || 'invalid minimum holding'); }
  });

  // The payout PREVIEW: exactly the table the press will compute
  // (same builder), plus the pool's actual balance and the
  // projected remainder. Records nothing, sends nothing. A price
  // failure surfaces as 502 — the press would halt the same way.
  app.get('/api/admin/payout-preview', requireAdmin, async (_req, res) => {
    try {
      let poolBalance = null;
      try { poolBalance = await payout.getRewardBalance(); } catch { /* show null */ }
      const table = await buildPayoutTable(store, fetchBalanceLive, { priceFeed: priceFeedLive, poolBalance });
      const totalToSend = table.totalSplit;
      res.json({
        day: table.day,
        windowStart: table.windowStart, windowEnd: table.windowEnd,
        registeredCount: table.registeredCount,
        rows: table.rows.map((r) => ({
          wallet: r.wallet, balance: r.balance.toString(), balanceWhole: formatBaseToWhole(r.balance),
          sharePct: table.totalBalance > 0n
            ? Number((r.balance * 10000n) / table.totalBalance) / 100 : 0,
          amount: r.amount.toString(), amountWhole: formatBaseToWhole(r.amount),
        })),
        totalSplit: table.totalSplit.toString(), totalSplitWhole: formatBaseToWhole(table.totalSplit),
        potBase: table.potBase.toString(), potWhole: formatBaseToWhole(table.potBase),
        payoutUsdMicro: table.payoutUsdMicro.toString(),
        dailyPayoutUsd: Number(table.payoutUsdMicro) / 1_000_000,
        amountBase: table.amountBase === null ? null : table.amountBase.toString(),
        amountWhole: table.amountBase === null ? null : formatBaseToWhole(table.amountBase),
        limitBase: table.limitBase.toString(),
        limitWhole: formatBaseToWhole(table.limitBase),
        priceFrgUsd: table.price ? frgUsdPrice(table.price) : null,
        poolBalance: poolBalance === null ? null : poolBalance.toString(),
        poolBalanceWhole: poolBalance === null ? null : formatBaseToWhole(poolBalance),
        poolRemainder: poolBalance === null ? null : (poolBalance - totalToSend).toString(),
        poolRemainderWhole: poolBalance === null ? null : formatBaseToWhole(poolBalance - totalToSend),
        // Minimum-holding enforcement at this build: wallets
        // below the limit were REMOVED from registration and are
        // not in the table (the press will see the same list —
        // the build already applied the rule).
        minHoldingBase: table.minHoldingBase.toString(),
        minHoldingWhole: formatBaseToWhole(table.minHoldingBase),
        deregistered: table.deregistered.map((d) => ({
          wallet: d.wallet, balance: d.balance.toString(),
          balanceWhole: formatBaseToWhole(d.balance),
        })),
      });
    } catch (e) {
      bad(res, 502, `payout preview failed (the press would halt): ${e.message}`);
    }
  });

  // THE PAYOUT BUTTON. The owner presses; only then do sends go
  // out. Idempotent per day (see runPayoutDay). Nothing in the app
  // sends on a timer.
  const payoutMutex = createMutex();
  app.post('/api/admin/payout', requireAdmin, async (_req, res) => {
    if (!payout.configured) return bad(res, 503, 'payout wallet not configured yet');
    try {
      const run = await payoutMutex(() => runPayoutDay(store, payout, fetchBalanceLive, { priceFeed: priceFeedLive }));
      res.json({ ...payoutRunView(run), halted: run.status === 'halted_price' });
    } catch (e) {
      bad(res, 502, `payout run failed: ${e.message}`);
    }
  });

  app.post('/api/admin/rate', requireAdmin, (req, res) => {
    const pct = Number(req.body?.percent ?? req.body?.rate);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return bad(res, 400, 'rate must be 0–100');
    const bps = Math.round(pct * 100);
    store.setAffiliateRateBps(bps);
    res.json({ affiliateRateBps: bps, affiliateRatePercent: bps / 100 });
  });

  app.post('/api/admin/snapshot', requireAdmin, async (_req, res) => {
    try {
      const out = await runSnapshot(store, (addr) => cw20Balance(config.lcdUrl, FRG_TOKEN, addr),
        dayString(), (addr) => cw721TypeCountsMulti(config.lcdUrl, store.getNftCollections(), addr));
      res.json(out);
    } catch (e) {
      bad(res, 502, `snapshot failed: ${e.message}`);
    }
  });

  // --- Admin NFT settings (same requireAdmin gate, same 400 honesty) ---
  app.get('/api/admin/nft', requireAdmin, (_req, res) => {
    const s = store.getNftSettings();
    res.json({
      collection: s.collection,
      collections: s.collections,
      excludedWallets: s.excludedWallets,
      ...nftRatesView(s),
      mintCost: s.mintCost.toString(),
      mintCostWhole: formatBaseToWhole(s.mintCost),
      threshold: s.threshold,
      supplyCap: s.supplyCap,
      bonusPoolWallet: s.bonusPoolWallet,
      bonusPoolFunded: store.nftBonusPoolFunded().toString(),
      bonusPoolFundedWhole: formatBaseToWhole(store.nftBonusPoolFunded()),
      bonusPoolAvailable: store.nftBonusPoolAvailable().toString(),
      bonusPoolAvailableWhole: formatBaseToWhole(store.nftBonusPoolAvailable()),
      bonusPoolPaid: store.nftTotalPaid().toString(),
      snapshotDays: store.nftSnapshotDays(),
    });
  });

  app.post('/api/admin/nft/settings', requireAdmin, (req, res) => {
    try {
      const updates = validateNftSettings(req.body || {});
      store.setNftSettings(updates);
      const s = store.getNftSettings();
      res.json({
        collection: s.collection,
        collections: s.collections,
        excludedWallets: s.excludedWallets,
        ...nftRatesView(s),
        mintCost: s.mintCost.toString(),
        mintCostWhole: formatBaseToWhole(s.mintCost),
        threshold: s.threshold,
        supplyCap: s.supplyCap,
        bonusPoolWallet: s.bonusPoolWallet,
      });
    } catch (e) {
      bad(res, 400, e.message);
    }
  });

  // Record REAL mint-fee proceeds (admin-verified, e.g. a mint txhash
  // in the note). The server never invents funding: only recorded
  // amounts count toward the bonus pool balance.
  app.post('/api/admin/nft/fund', requireAdmin, (req, res) => {
    try {
      const amount = validateFundingAmount(req.body?.amountWhole ?? req.body?.amount);
      const note = String(req.body?.note || '').slice(0, 200) || null;
      store.fundBonusPool(amount, note);
      res.json({
        funded: store.nftBonusPoolFunded().toString(),
        fundedWhole: formatBaseToWhole(store.nftBonusPoolFunded()),
        available: store.nftBonusPoolAvailable().toString(),
        availableWhole: formatBaseToWhole(store.nftBonusPoolAvailable()),
      });
    } catch (e) {
      bad(res, 400, e.message);
    }
  });

  // Serve the built frontend when it exists (single-service deploy).
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }
  return app;
}

export function configFromEnv(env = process.env) {
  return {
    lcdUrl: env.LCD_URL || LCD_DEFAULT,
    rpcUrl: env.RPC_URL || RPC_DEFAULT,
    adminWallet: env.ADMIN_WALLET || ADMIN_WALLET_DEFAULT,
    adminSecret: env.ADMIN_SECRET || '',
    // Payout wallet ("New admin" wallet, user-settled 2026-10-24 — it
    // is BOTH the payout wallet AND the admin wallet for this app).
    // Env-overridable via FRG_PAYOUT_ADDRESS. The KEY is separate
    // (FRG_PAYOUT_MNEMONIC, Railway-only, never here): with the key
    // absent, collects fail safely with "not configured".
    // The owner's regular-use wallet is NOT involved in any way.
    payoutAddress: env.FRG_PAYOUT_ADDRESS || 'terra1xketp9yp3lrvkkd6ypk2m7jkmtpxuh6yntdjmv',
    port: Number(env.PORT || 3001),
    dbPath: env.DB_PATH || 'data/frg-hold-earn.db',
    snapshotIntervalMs: Number(env.SNAPSHOT_INTERVAL_MS || 24 * 60 * 60 * 1000),
    sampleIntervalMs: Number(env.SAMPLE_INTERVAL_MS || 60 * 60 * 1000),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const store = openStore(config.dbPath);
  const payout = createPayout({
    lcdUrl: config.lcdUrl, rpcUrl: config.rpcUrl,
    payoutAddress: config.payoutAddress,
    mnemonic: process.env.FRG_PAYOUT_MNEMONIC || '',
    // Base-reward routing follows the store's operative reward
    // asset (FRG since migration #2 — see assets.js / store.js).
    rewardAsset: rewardAssetFor(store.getRewardSymbol()),
  });
  const app = createApp({ store, payout, config });
  const fetchBalance = (addr) => cw20Balance(config.lcdUrl, FRG_TOKEN, addr);
  const fetchNftCounts = (addr) => cw721TypeCountsMulti(config.lcdUrl, store.getNftCollections(), addr);
  setInterval(() => {
    runSnapshot(store, fetchBalance, dayString(), fetchNftCounts).then(
      (r) => console.log('snapshot', r.day, r.skipped ? 'skipped (already done)' : `${r.wallets} wallets`),
      (e) => console.error('snapshot failed:', e.message));
  }, config.snapshotIntervalMs);
  // Hourly balance sampling (accuracy upgrade): the day's snapshot
  // splits on each wallet's average sampled balance. First round runs
  // shortly after boot so a fresh deploy starts collecting samples
  // right away instead of waiting for the first hour tick.
  const sample = () => runBalanceSampling(store, fetchBalance).then(
    (r) => console.log('balance sample', r.day, `hour ${r.hour}:`, `${r.sampled} ok, ${r.failed} failed`),
    (e) => console.error('balance sampling failed:', e.message));
  setTimeout(sample, 15000);
  setInterval(sample, config.sampleIntervalMs);
  app.listen(config.port, async () => {
    // Address only — never anything about the key.
    console.log(`FRG Hold & Earn backend on :${config.port} (payout wallet: ${await payout.address() || 'not set'})`);
  });
}
