// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — backend API.
// Holders NEVER send anything: they connect, the server snapshots
// their FRG balance daily, and they collect rewards the owner funds.
// The ONLY wallet that ever sends is the payout wallet (payout.js).
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
import { computeDay, isValidTerraAddress, parseWholeToBase, formatBaseToWhole } from './engine.js';
import { createPayout, cw20Balance, FRG_TOKEN } from './payout.js';
import {
  consolidateNftPower, computeNftDailyBonus,
  validateNftSettings, validateFundingAmount,
  verifyMintTransfer, isValidTxhash,
} from './nft.js';
import { cw721Count } from './nftChain.js';

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
// same day is a no-op (store.recordDay refuses a duplicate day).
// fetchNftCount (optional): when given, the same day also snapshots
// each wallet's NFT count for the configured collection and accrues
// NFT bonuses into the SEPARATE nft ledger. When omitted (old callers,
// tests), the NFT side is skipped entirely — base behavior unchanged.
export async function runSnapshot(store, fetchBalance, day = dayString(), fetchNftCount = null) {
  const wallets = store.allWallets();
  const balances = [];
  for (const w of wallets) {
    balances.push({ wallet: w.address, balance: await fetchBalance(w.address) });
  }
  const pool = store.getDailyPool();
  const referralOf = new Map(wallets.map((w) => [w.address, w.referrer]));
  const { shares, bonuses } = computeDay(pool, balances, referralOf, store.getAffiliateRateBps());
  const result = store.recordDay(day, pool, balances, shares, bonuses);
  const total = balances.reduce((s, b) => s + b.balance, 0n);
  let nftOut = null;
  if (fetchNftCount) {
    const nftCounts = [];
    for (const w of wallets) {
      nftCounts.push({ wallet: w.address, nftCount: await fetchNftCount(w.address) });
    }
    const bonusPerNft = store.getNftBonusPerNft();
    const nftBonuses = nftCounts.map(({ wallet, nftCount }) => ({
      wallet, amount: computeNftDailyBonus(nftCount, bonusPerNft),
    }));
    nftOut = store.recordNftDay(day, nftCounts, nftBonuses);
  }
  return { day, wallets: balances.length, totalBalance: total.toString(), pool: pool.toString(), ...result, nft: nftOut };
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

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Public totals — honest numbers straight from the ledger.
  // The daily pool and affiliate rate are public program parameters,
  // not promises: an individual's share depends on snapshots.
  app.get('/api/stats', (_req, res) => res.json({
    holders: store.walletCount(),
    totalAccrued: store.totalAccrued().toString(),
    totalPaid: store.totalPaid().toString(),
    snapshotDays: store.snapshotDays(),
    dailyPool: store.getDailyPool().toString(),
    dailyPoolWhole: formatBaseToWhole(store.getDailyPool()),
    affiliateRatePercent: store.getAffiliateRateBps() / 100,
    // NFT section (additive — base stats above are untouched).
    nft: (() => {
      const s = store.getNftSettings();
      return {
        configured: s.collection !== '',
        collection: s.collection,
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
          const balance = await payout.getBalance();
          if (balance < claim) throw Object.assign(new Error('rewards pool empty, top up'), { status: 400 });
          const txhash = await payout.send(addr, claim);
          store.confirmPayment(paymentId, txhash);
          return { paid: claim.toString(), paidWhole: formatBaseToWhole(claim), txhash };
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
    const configured = s.collection !== '';
    const count = configured ? store.latestNftCount(addr) : 0;
    const power = consolidateNftPower(count, s.threshold);
    const mintReady = configured && s.mintCost > 0n && s.bonusPoolWallet !== '';
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
    try { if (payoutAddress) payoutBalance = (await payout.getBalance()).toString(); } catch { /* show null */ }
    res.json({
      holders: store.walletCount(),
      totalAccrued: store.totalAccrued().toString(),
      totalPaid: store.totalPaid().toString(),
      snapshotDays: store.snapshotDays(),
      dailyPool: store.getDailyPool().toString(),
      dailyPoolWhole: formatBaseToWhole(store.getDailyPool()),
      affiliateRateBps: store.getAffiliateRateBps(),
      affiliateRatePercent: store.getAffiliateRateBps() / 100,
      payoutCanSend: payout.configured,
      payoutAddress,
      payoutBalance,
      nft: (() => {
        const s = store.getNftSettings();
        return {
          collection: s.collection,
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
      res.json({ dailyPool: base.toString(), dailyPoolWhole: formatBaseToWhole(base) });
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
        dayString(), (addr) => cw721Count(config.lcdUrl, store.getNftCollection(), addr));
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
  const fetchNftCount = (addr) => cw721Count(config.lcdUrl, store.getNftCollection(), addr);
  setInterval(() => {
    runSnapshot(store, fetchBalance, dayString(), fetchNftCount).then(
      (r) => console.log('snapshot', r.day, r.skipped ? 'skipped (already done)' : `${r.wallets} wallets`),
      (e) => console.error('snapshot failed:', e.message));
  }, config.snapshotIntervalMs);
  app.listen(config.port, async () => {
    // Address only — never anything about the key.
    console.log(`FRG Hold & Earn backend on :${config.port} (payout wallet: ${await payout.address() || 'not set'})`);
  });
}
