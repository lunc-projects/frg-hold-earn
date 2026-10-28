// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — backend API.
// Holders NEVER send anything: they connect, the server snapshots
// their FRG balance daily, and they collect USTC rewards the owner
// funds by depositing USTC into the payout wallet. FRG balances are
// only the pro-rata weights; every base reward amount is USTC
// (denom "uusd"). The ONLY wallet that ever sends is the payout
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
  computeDay, isValidTerraAddress, parseWholeToBase, formatBaseToWhole,
  REWARD_DENOM, REWARD_SYMBOL,
} from './engine.js';
import { createPayout, cw20Balance, FRG_TOKEN } from './payout.js';
import {
  consolidateNftPower, computeNftDailyBonus,
  validateNftSettings, validateFundingAmount,
  verifyMintTransfer, isValidTxhash,
} from './nft.js';
import { cw721CountMulti } from './nftChain.js';

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

// Runs one day's snapshot + accrual. Idempotent: a second run for the
// same day is a no-op (store.recordDay refuses a duplicate day). The
// FRG balances below are weights only; the configured pool and the
// resulting accruals are USTC base units.
// Balance accuracy (2026-10-25): each wallet's split weight is its
// AVERAGE sampled balance for the day (hourly samples, see
// runBalanceSampling) — holding FRG for one hour earns ~1/24 of the
// weight of holding it all day, so flash-holding into the snapshot
// moment no longer pays. A wallet with no samples that day (e.g. the
// sampler was down, or it registered after the last sample) falls
// back to a live balance read, exactly the pre-upgrade behavior.
// fetchNftCount (optional): when given, the same day also snapshots
// each wallet's consolidated NFT count across the configured bonus
// collections and accrues NFT bonuses into the SEPARATE nft ledger.
// When omitted (old callers, tests), the NFT side is skipped entirely
// — base behavior unchanged. If any NFT read FAILS (e.g. the LCD is
// down), the NFT day is skipped as a whole — no partial counts are
// ever recorded — and the base snapshot still completes; the NFT day
// can simply be recorded by a later run the same day.
// Wallets on the admin-set exclusion list (nft_excluded_wallets, e.g.
// the owner's own bonus-stock wallet) are recorded with an NFT count
// of 0 WITHOUT any chain read and never accrue NFT bonus; their base
// rewards above are completely unaffected.
export async function runSnapshot(store, fetchBalance, day = dayString(), fetchNftCount = null) {
  const wallets = store.allWallets();
  const averages = store.averageBalances(day);
  const balances = [];
  let averaged = 0;
  for (const w of wallets) {
    const a = averages.get(w.address);
    if (a) {
      balances.push({ wallet: w.address, balance: a.average });
      averaged++;
    } else {
      balances.push({ wallet: w.address, balance: await fetchBalance(w.address) });
    }
  }
  const pool = store.getDailyPool();
  const referralOf = new Map(wallets.map((w) => [w.address, w.referrer]));
  const { shares, bonuses } = computeDay(pool, balances, referralOf, store.getAffiliateRateBps());
  const result = store.recordDay(day, pool, balances, shares, bonuses);
  const total = balances.reduce((s, b) => s + b.balance, 0n);
  let nftOut = null;
  if (fetchNftCount) {
    try {
      const excludedWallets = new Set(store.getNftExcludedWallets());
      const nftCounts = [];
      for (const w of wallets) {
        nftCounts.push({
          wallet: w.address,
          nftCount: excludedWallets.has(w.address) ? 0 : await fetchNftCount(w.address),
        });
      }
      const bonusPerNft = store.getNftBonusPerNft();
      const nftBonuses = nftCounts.map(({ wallet, nftCount }) => ({
        wallet, amount: computeNftDailyBonus(nftCount, bonusPerNft),
      }));
      nftOut = store.recordNftDay(day, nftCounts, nftBonuses);
    } catch (e) {
      // Bonus read failed: skip the NFT day entirely (nothing partial
      // is recorded, so a retry today can still land it). The base
      // snapshot above is already recorded and is never affected.
      nftOut = { skipped: true, error: `NFT bonus snapshot skipped: ${e.message}` };
    }
  }
  return {
    day, wallets: balances.length, totalBalance: total.toString(), pool: pool.toString(),
    ...result, nft: nftOut,
    balanceSource: { averaged, live: balances.length - averaged },
  };
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
  // Base rewards are USTC end to end (additive API fields; the
  // existing amount field names are unchanged).
  const rewardMeta = {
    rewardDenom: REWARD_DENOM,
    rewardSymbol: REWARD_SYMBOL,
    rewardCurrency: REWARD_SYMBOL,
  };
  const migrationView = () => {
    const m = store.getRewardCurrencyMigration();
    if (!m) return null;
    return {
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
    };
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Public totals — honest numbers straight from the ledger.
  // The daily pool and affiliate rate are public program parameters,
  // not promises: an individual's share depends on snapshots.
  app.get('/api/stats', (_req, res) => res.json({
    holders: store.walletCount(),
    ...rewardMeta,
    heldTokenSymbol: 'FRG',
    totalAccrued: store.totalAccrued().toString(),
    totalPaid: store.totalPaid().toString(),
    snapshotDays: store.snapshotDays(),
    // Count only (no balances): proves the hourly sampler is running.
    balanceSamplesToday: store.sampleStats(dayString()).samples,
    dailyPool: store.getDailyPool().toString(),
    dailyPoolWhole: formatBaseToWhole(store.getDailyPool()),
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
        bonusRateSet: s.bonusPerNft > 0n,
        threshold: s.threshold,
        thresholdSet: s.threshold > 0,
        bonusPerNftWhole: formatBaseToWhole(s.bonusPerNft),
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

  // Registration: first-touch wins, binding immutable (store enforces).
  app.post('/api/register', (req, res) => {
    const addr = validAddr(req, res); if (!addr) return;
    const referrer = (req.body?.referrer || '').trim() || null;
    if (referrer) {
      if (!isValidTerraAddress(referrer)) return bad(res, 400, 'invalid referrer address');
      if (referrer === addr) return bad(res, 400, 'referrer cannot be your own wallet');
    }
    const out = store.registerWallet(addr, referrer);
    res.json(out);
  });

  app.get('/api/rewards', (req, res) => {
    const addr = validAddr(req, res); if (!addr) return;
    const accrued = store.accrued(addr);
    const paid = store.paid(addr);
    res.json({
      address: addr,
      ...rewardMeta,
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
          // Base rewards pay USTC only: cap against the payout
          // wallet's ACTUAL USTC (uusd) balance and send via the
          // native bank-send path — never the FRG CW20 path, which
          // belongs to the separate NFT bonus mechanic.
          const balance = await payout.getUstcBalance();
          if (balance < claim) throw Object.assign(new Error('rewards pool empty, top up'), { status: 400 });
          const txhash = await payout.sendUstc(addr, claim);
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
    const power = consolidateNftPower(count, s.threshold);
    const bonusRateSet = s.bonusPerNft > 0n;
    const bonusNotice = !configured
      ? 'No NFT bonus collections are connected yet — NFT bonus holdings read as zero.'
      : !bonusRateSet
        ? 'NFT bonus collections are connected, but the bonus rate is not set yet — no NFT bonus accrues until the admin sets a bonus per NFT.'
        : `NFT bonus is active: ${formatBaseToWhole(s.bonusPerNft)} FRG per NFT per snapshot day, counted across ${s.collections.length} connected collection${s.collections.length === 1 ? '' : 's'}.`;
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
      power: power.power,
      chargePct: power.chargePct,
      fullyPowered: power.fullyPowered,
      threshold: s.threshold,
      thresholdSet: power.thresholdSet,
      bonusPerNft: s.bonusPerNft.toString(),
      bonusPerNftWhole: formatBaseToWhole(s.bonusPerNft),
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
          // NFT bonus remains an FRG mechanic by design: this route
          // intentionally keeps the FRG CW20 balance/send path and
          // was NOT converted to USTC with the base reward engine.
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
      dailyPool: store.getDailyPool().toString(),
      dailyPoolWhole: formatBaseToWhole(store.getDailyPool()),
      affiliateRateBps: store.getAffiliateRateBps(),
      affiliateRatePercent: store.getAffiliateRateBps() / 100,
      payoutCanSend: payout.configured,
      payoutAddress,
      // payoutBalance remains the FRG CW20 balance (NFT bonus path /
      // legacy display). payoutUstcBalance is the live USTC balance
      // the owner's deposits land in and base Collect caps against.
      payoutBalance,
      payoutBalanceWhole: payoutBalance === null ? null : formatBaseToWhole(BigInt(payoutBalance)),
      payoutUstcBalance,
      payoutUstcBalanceWhole: payoutUstcBalance === null ? null : formatBaseToWhole(BigInt(payoutUstcBalance)),
      rewardMigration: migrationView(),
      balanceSamples: store.sampleStats(dayString()),
      nft: (() => {
        const s = store.getNftSettings();
        return {
          collection: s.collection,
          collections: s.collections,
          excludedWallets: s.excludedWallets,
          bonusRateSet: s.bonusPerNft > 0n,
          mintCostWhole: formatBaseToWhole(s.mintCost),
          bonusPerNftWhole: formatBaseToWhole(s.bonusPerNft),
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

  app.post('/api/admin/pool', requireAdmin, (req, res) => {
    try {
      const base = parseWholeToBase(req.body?.poolWhole ?? req.body?.pool);
      if (base < 0n) throw new Error('Invalid amount');
      store.setDailyPool(base);
      res.json({
        dailyPool: base.toString(), dailyPoolWhole: formatBaseToWhole(base),
        ...rewardMeta,
      });
    } catch { bad(res, 400, 'invalid pool amount'); }
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
        dayString(), (addr) => cw721CountMulti(config.lcdUrl, store.getNftCollections(), addr));
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
      bonusRateSet: s.bonusPerNft > 0n,
      mintCost: s.mintCost.toString(),
      mintCostWhole: formatBaseToWhole(s.mintCost),
      bonusPerNft: s.bonusPerNft.toString(),
      bonusPerNftWhole: formatBaseToWhole(s.bonusPerNft),
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
        bonusRateSet: s.bonusPerNft > 0n,
        mintCost: s.mintCost.toString(),
        mintCostWhole: formatBaseToWhole(s.mintCost),
        bonusPerNft: s.bonusPerNft.toString(),
        bonusPerNftWhole: formatBaseToWhole(s.bonusPerNft),
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
  });
  const app = createApp({ store, payout, config });
  const fetchBalance = (addr) => cw20Balance(config.lcdUrl, FRG_TOKEN, addr);
  const fetchNftCount = (addr) => cw721CountMulti(config.lcdUrl, store.getNftCollections(), addr);
  setInterval(() => {
    runSnapshot(store, fetchBalance, dayString(), fetchNftCount).then(
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
