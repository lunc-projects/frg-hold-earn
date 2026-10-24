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
    -- NFT bonus section (separate from base rewards by design):
    -- nft_days/nft_snapshots/nft_accruals mirror the base snapshot
    -- ledger but NEVER mix into it — base Collect must never pay NFT
    -- bonuses, and NFT bonus Collect must never pay base shares.
    CREATE TABLE IF NOT EXISTS nft_days(day TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS nft_snapshots(
      day TEXT, wallet TEXT, nft_count INTEGER,
      PRIMARY KEY(day, wallet));
    CREATE TABLE IF NOT EXISTS nft_accruals(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT, wallet TEXT, amount TEXT,
      UNIQUE(day, wallet));
    CREATE TABLE IF NOT EXISTS nft_payments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT, amount TEXT, status TEXT, txhash TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS nft_pool_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount TEXT, note TEXT, txhash TEXT UNIQUE, created_at INTEGER);
  `);
  // Defaults (only when never set): daily pool 0, affiliate rate 10%.
  db.prepare(`INSERT OR IGNORE INTO settings(key, value)
              VALUES('daily_pool', '0'), ('affiliate_rate_bps', '1000')`).run();
  // NFT defaults (only when never set): no collection configured
  // (bonus holdings read as zero), mint cost 0, bonus per NFT 0,
  // threshold 0 (unset), supply cap 0 (unlimited), no bonus pool
  // wallet (bonus payouts blocked until set), pool funded 0.
  db.prepare(`INSERT OR IGNORE INTO settings(key, value) VALUES
              ('nft_collection', ''), ('nft_mint_cost', '0'),
              ('nft_bonus_per_nft', '0'), ('nft_threshold', '0'),
              ('nft_supply_cap', '0'), ('nft_bonus_pool_wallet', ''),
              ('nft_bonus_pool_funded', '0')`).run();

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

    // --- NFT bonus settings (all admin-settable, never hardcoded) ---
    getNftCollection() { return q(`SELECT value FROM settings WHERE key='nft_collection'`).value; },
    getNftMintCost() { return BigInt(q(`SELECT value FROM settings WHERE key='nft_mint_cost'`).value); },
    getNftBonusPerNft() { return BigInt(q(`SELECT value FROM settings WHERE key='nft_bonus_per_nft'`).value); },
    getNftThreshold() { return Number(q(`SELECT value FROM settings WHERE key='nft_threshold'`).value); },
    getNftSupplyCap() { return Number(q(`SELECT value FROM settings WHERE key='nft_supply_cap'`).value); },
    getNftBonusPoolWallet() { return q(`SELECT value FROM settings WHERE key='nft_bonus_pool_wallet'`).value; },
    getNftSettings() {
      return {
        collection: this.getNftCollection(),
        mintCost: this.getNftMintCost(),
        bonusPerNft: this.getNftBonusPerNft(),
        threshold: this.getNftThreshold(),
        supplyCap: this.getNftSupplyCap(),
        bonusPoolWallet: this.getNftBonusPoolWallet(),
      };
    },
    setNftSettings(updates) {
      const map = {
        collection: 'nft_collection', mintCost: 'nft_mint_cost',
        bonusPerNft: 'nft_bonus_per_nft', threshold: 'nft_threshold',
        supplyCap: 'nft_supply_cap', bonusPoolWallet: 'nft_bonus_pool_wallet',
      };
      for (const [field, key] of Object.entries(map)) {
        if (field in updates) {
          run(`INSERT INTO settings(key, value) VALUES(?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
              key, String(updates[field]));
        }
      }
    },

    // --- NFT snapshot + accrual (idempotent per day, like recordDay) ---
    // counts: [{wallet, nftCount}], bonuses: [{wallet, amount: BigInt}].
    recordNftDay(day, counts, bonuses) {
      if (q(`SELECT day FROM nft_days WHERE day = ?`, day)) return { skipped: true };
      try {
        db.exec('BEGIN');
        run(`INSERT INTO nft_days(day) VALUES(?)`, day);
        for (const { wallet, nftCount } of counts) {
          run(`INSERT INTO nft_snapshots(day, wallet, nft_count) VALUES(?, ?, ?)`,
              day, wallet, nftCount);
        }
        for (const { wallet, amount } of bonuses) {
          if (amount > 0n) {
            run(`INSERT INTO nft_accruals(day, wallet, amount) VALUES(?, ?, ?)`,
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
    nftSnapshotDays() {
      return all(`SELECT day FROM nft_days ORDER BY day`).map((r) => r.day);
    },
    latestNftCount(wallet) {
      const r = q(`SELECT nft_count FROM nft_snapshots WHERE wallet = ?
                   ORDER BY day DESC LIMIT 1`, wallet);
      return r ? r.nft_count : 0;
    },
    lastNftSnapshotDay(wallet) {
      const r = q(`SELECT day FROM nft_snapshots WHERE wallet = ?
                   ORDER BY day DESC LIMIT 1`, wallet);
      return r ? r.day : null;
    },

    // --- NFT bonus ledgers (separate from base accruals/payments) ---
    nftAccrued(wallet) {
      const r = q(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS t
                   FROM nft_accruals WHERE wallet = ?`, wallet);
      return BigInt(r.t);
    },
    nftPaid(wallet) {
      const r = q(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS t
                   FROM nft_payments WHERE wallet = ? AND status IN ('pending', 'confirmed')`, wallet);
      return BigInt(r.t);
    },
    nftClaimable(wallet) {
      const c = this.nftAccrued(wallet) - this.nftPaid(wallet);
      return c > 0n ? c : 0n;
    },
    nftTotalPaid() {
      return BigInt(q(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS t
                      FROM nft_payments WHERE status IN ('pending', 'confirmed')`).t);
    },

    // --- Bonus pool ledger: funded ONLY by recorded mint-fee proceeds.
    // Available = funded - (pending + confirmed bonus payments).
    // A bonus Collect must never exceed this tracked balance.
    nftBonusPoolFunded() {
      return BigInt(q(`SELECT value FROM settings WHERE key='nft_bonus_pool_funded'`).value);
    },
    nftBonusPoolAvailable() {
      const avail = this.nftBonusPoolFunded() - this.nftTotalPaid();
      return avail > 0n ? avail : 0n;
    },
    // Records real funding. txhash (when given, e.g. a verified mint
    // tx) is UNIQUE: recording the same tx twice is a no-op that
    // returns { recorded: false } instead of double-crediting.
    fundBonusPool(amount, note, txhash = null) {
      if (txhash) {
        const existing = q(`SELECT id FROM nft_pool_events WHERE txhash = ?`, txhash);
        if (existing) return { recorded: false };
      }
      try {
        db.exec('BEGIN');
        run(`INSERT INTO nft_pool_events(amount, note, txhash, created_at) VALUES(?, ?, ?, ?)`,
            String(amount), note || null, txhash, Date.now());
        const funded = this.nftBonusPoolFunded() + amount;
        run(`INSERT INTO settings(key, value) VALUES('nft_bonus_pool_funded', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(funded));
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
      return { recorded: true };
    },

    // --- NFT bonus payments: pending -> confirmed (or void) ---
    // Same pattern as base payments: pending counts as paid, so a crash
    // between send and confirm can never double-pay; a failed send
    // voids the pending row and the bonus stays collectable.
    createPendingNftPayment(wallet, amount) {
      const r = run(`INSERT INTO nft_payments(wallet, amount, status, txhash, created_at)
                     VALUES(?, ?, 'pending', NULL, ?)`, wallet, String(amount), Date.now());
      return Number(r.lastInsertRowid);
    },
    confirmNftPayment(id, txhash) {
      run(`UPDATE nft_payments SET status = 'confirmed', txhash = ? WHERE id = ?`, txhash, id);
    },
    voidNftPayment(id) {
      run(`UPDATE nft_payments SET status = 'void' WHERE id = ?`, id);
    },
    nftPaymentsFor(wallet) {
      return all(`SELECT * FROM nft_payments WHERE wallet = ? ORDER BY id DESC LIMIT 20`, wallet);
    },
  };
}
