// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — storage module (SQLite, via node:sqlite).
// All money values are TEXT holding integer base units (uFRG, 6 dp)
// so no float rounding ever touches a balance.
// One store = one SQLite file. Production MUST NOT use a local file:
// Railway's filesystem is ephemeral and a claims ledger wiped on
// redeploy would double-pay. See README "Production storage TODO"
// (Upstash Redis via UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
// This module is the seam: the server only talks to these methods, so
// swapping the backend later does not touch the earnings logic.
// ─────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets(
      address TEXT PRIMARY KEY, referrer TEXT, registered_at INTEGER);
    CREATE TABLE IF NOT EXISTS snapshots(
      day TEXT, wallet TEXT, balance TEXT,
      PRIMARY KEY(day, wallet));
    CREATE TABLE IF NOT EXISTS day_pools(
      day TEXT PRIMARY KEY, pool TEXT);
    CREATE TABLE IF NOT EXISTS accruals(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT, wallet TEXT, kind TEXT, amount TEXT,
      UNIQUE(day, wallet, kind));
    CREATE TABLE IF NOT EXISTS payments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT, amount TEXT, status TEXT, txhash TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY, value TEXT);
  `);
  // Defaults (only when never set): daily pool 0, affiliate rate 10%.
  db.prepare(`INSERT OR IGNORE INTO settings(key, value)
              VALUES('daily_pool', '0'), ('affiliate_rate_bps', '1000')`).run();

  const q = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  return {
    db,

    // --- Registration: first-touch wins, binding immutable ---
    // Returns { address, referrer, created }. A second registration for
    // the same wallet returns the ORIGINAL binding unchanged, even if
    // the caller passes a different (or first-time) referrer.
    registerWallet(address, referrer) {
      const existing = q(`SELECT * FROM wallets WHERE address = ?`, address);
      if (existing) return { address, referrer: existing.referrer, created: false };
      run(`INSERT INTO wallets(address, referrer, registered_at) VALUES(?, ?, ?)`,
          address, referrer || null, Date.now());
      return { address, referrer: referrer || null, created: true };
    },
    getWallet(address) {
      return q(`SELECT * FROM wallets WHERE address = ?`, address) || null;
    },
    walletCount() {
      return q(`SELECT COUNT(*) AS n FROM wallets`).n;
    },
    allWallets() {
      return all(`SELECT address, referrer FROM wallets ORDER BY address`);
    },

    // --- Settings ---
    getDailyPool() { return BigInt(q(`SELECT value FROM settings WHERE key='daily_pool'`).value); },
    setDailyPool(baseUnits) {
      run(`INSERT INTO settings(key, value) VALUES('daily_pool', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(baseUnits));
    },
    getAffiliateRateBps() { return Number(q(`SELECT value FROM settings WHERE key='affiliate_rate_bps'`).value); },
    setAffiliateRateBps(bps) {
      run(`INSERT INTO settings(key, value) VALUES('affiliate_rate_bps', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(bps));
    },

    // --- Daily snapshot + accrual (idempotent per day) ---
    // Returns { skipped: true } if this day already accrued — a second
    // run for the same day must NEVER double-accrue.
    // `shares`/`bonuses` are [{wallet, amount: BigInt}] computed by engine.js.
    recordDay(day, poolBaseUnits, snapshotBalances, shares, bonuses) {
      if (q(`SELECT day FROM day_pools WHERE day = ?`, day)) return { skipped: true };
      // node:sqlite has no transaction() helper — explicit BEGIN/COMMIT.
      // A crash mid-write rolls back, so a retry can never half-accrue.
      try {
        db.exec('BEGIN');
        run(`INSERT INTO day_pools(day, pool) VALUES(?, ?)`, day, String(poolBaseUnits));
        for (const { wallet, balance } of snapshotBalances) {
          run(`INSERT INTO snapshots(day, wallet, balance) VALUES(?, ?, ?)`,
              day, wallet, String(balance));
        }
        for (const { wallet, amount } of shares) {
          if (amount > 0n) {
            run(`INSERT INTO accruals(day, wallet, kind, amount) VALUES(?, ?, 'share', ?)`,
                day, wallet, String(amount));
          }
        }
        for (const { wallet, amount } of bonuses) {
          if (amount > 0n) {
            run(`INSERT INTO accruals(day, wallet, kind, amount) VALUES(?, ?, 'bonus', ?)`,
                day, wallet, String(amount));
          }
        }
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
      return { skipped: false };
    },
    snapshotDays() {
      return all(`SELECT day FROM day_pools ORDER BY day`).map((r) => r.day);
    },

    // --- Ledgers ---
    accrued(wallet) {
      const r = q(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS t
                   FROM accruals WHERE wallet = ?`, wallet);
      return BigInt(r.t);
    },
    paid(wallet) {
      const r = q(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS t
                   FROM payments WHERE wallet = ? AND status IN ('pending', 'confirmed')`, wallet);
      return BigInt(r.t);
    },
    claimable(wallet) {
      const c = this.accrued(wallet) - this.paid(wallet);
      return c > 0n ? c : 0n;
    },
    totalAccrued() {
      return BigInt(q(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS t FROM accruals`).t);
    },
    totalPaid() {
      return BigInt(q(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS t
                      FROM payments WHERE status IN ('pending', 'confirmed')`).t);
    },

    // --- Payments: pending -> confirmed (or void on failure) ---
    // Pending rows count as paid, so a crash between send and confirm
    // can never double-pay: the next collect sees the pending amount
    // as already spoken for. A failed send voids the pending row.
    createPendingPayment(wallet, amount) {
      const r = run(`INSERT INTO payments(wallet, amount, status, txhash, created_at)
                     VALUES(?, ?, 'pending', NULL, ?)`, wallet, String(amount), Date.now());
      return Number(r.lastInsertRowid);
    },
    confirmPayment(id, txhash) {
      run(`UPDATE payments SET status = 'confirmed', txhash = ? WHERE id = ?`, txhash, id);
    },
    voidPayment(id) {
      run(`UPDATE payments SET status = 'void' WHERE id = ?`, id);
    },
    paymentsFor(wallet) {
      return all(`SELECT * FROM payments WHERE wallet = ? ORDER BY id DESC LIMIT 20`, wallet);
    },

    // --- Referrals ---
    referralsOf(referrer) {
      return all(`SELECT address FROM wallets WHERE referrer = ? ORDER BY address`, referrer)
        .map((r) => r.address);
    },
    referralEarned(referrer) {
      // Bonus accruals credited to the referrer, across all days.
      const r = q(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS t
                   FROM accruals WHERE wallet = ? AND kind = 'bonus'`, referrer);
      return BigInt(r.t);
    },
  };
}
