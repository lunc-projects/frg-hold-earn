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
export async function runSnapshot(store, fetchBalance, day = dayString()) {
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
  return { day, wallets: balances.length, totalBalance: total.toString(), pool: pool.toString(), ...result };
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
      const out = await runSnapshot(store, (addr) => cw20Balance(config.lcdUrl, FRG_TOKEN, addr));
      res.json(out);
    } catch (e) {
      bad(res, 502, `snapshot failed: ${e.message}`);
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
  setInterval(() => {
    runSnapshot(store, fetchBalance).then(
      (r) => console.log('snapshot', r.day, r.skipped ? 'skipped (already done)' : `${r.wallets} wallets`),
      (e) => console.error('snapshot failed:', e.message));
  }, config.snapshotIntervalMs);
  app.listen(config.port, async () => {
    // Address only — never anything about the key.
    console.log(`FRG Hold & Earn backend on :${config.port} (payout wallet: ${await payout.address() || 'not set'})`);
  });
}
