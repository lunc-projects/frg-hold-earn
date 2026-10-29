// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — storage module (SQLite, via node:sqlite).
// All money values are TEXT holding integer 6-decimal base units, so
// no float rounding ever touches a balance. Currency is table-scoped:
// - snapshots / balance_samples hold FRG balances (the held asset);
// - day_pools / accruals / payments hold USTC base units (denom
//   "uusd") for the base reward engine;
// - nft_* ledgers remain FRG, as that separate bonus mechanic was not
//   converted. See the one-time legacy migration below.
// One store = one SQLite file. Production MUST NOT use a local file:
// Railway's filesystem is ephemeral and a claims ledger wiped on
// redeploy would double-pay. See README "Production storage TODO"
// (Upstash Redis via UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
// This module is the seam: the server only talks to these methods, so
// swapping the backend later does not touch the earnings logic.
// ─────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import { isValidTerraAddress, isValidTerraContractAddress } from './engine.js';

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
    -- Hourly balance samples (accuracy upgrade, 2026-10-25): one FRG
    -- balance reading per registered wallet per UTC hour. A day's
    -- snapshot splits the pool on each wallet's AVERAGE sampled
    -- balance for the day, not a single moment's reading.
    CREATE TABLE IF NOT EXISTS balance_samples(
      day TEXT, wallet TEXT, hour INTEGER, balance TEXT,
      PRIMARY KEY(day, wallet, hour));
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
    -- One-time USTC conversion audit tables. The archive preserves a
    -- verbatim copy of every pre-conversion base accrual row before
    -- the active accrual ledger is cleared; the migration table is
    -- both the run record and the flag that prevents a second run.
    CREATE TABLE IF NOT EXISTS legacy_frg_accruals(
      legacy_id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_id INTEGER, day TEXT, wallet TEXT, kind TEXT, amount TEXT,
      archived_at INTEGER, migration_id INTEGER);
    CREATE TABLE IF NOT EXISTS reward_currency_migrations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_symbol TEXT, to_symbol TEXT, to_denom TEXT,
      archived_rows INTEGER, archived_amount TEXT,
      archived_unpaid_amount TEXT, legacy_daily_pool TEXT,
      migrated_at INTEGER);
  `);
  // Defaults (only when never set): daily pool 0, affiliate rate 10%.
  db.prepare(`INSERT OR IGNORE INTO settings(key, value)
              VALUES('daily_pool', '0'), ('affiliate_rate_bps', '1000')`).run();
  // NFT defaults (only when never set): no collection configured
  // (bonus holdings read as zero), mint cost 0, threshold 0 (unset),
  // supply cap 0 (unlimited), no bonus pool wallet (bonus payouts
  // blocked until set), pool funded 0. Per-type bonus rates ship at
  // the owner-decided mirror of the old FRG app (2026-10-28):
  // Bonus 4, Common 50, Uncommon 100 FRG/day, in 6-decimal base
  // units — INSERT OR IGNORE, so an admin-changed rate is never
  // reset by a restart. ('nft_bonus_per_nft' is the retired flat
  // rate; the row is left in place on older databases, unused.)
  db.prepare(`INSERT OR IGNORE INTO settings(key, value) VALUES
              ('nft_collection', ''), ('nft_collections', '[]'),
              ('nft_excluded_wallets', '[]'),
              ('nft_mint_cost', '0'),
              ('nft_bonus_per_nft', '0'), ('nft_threshold', '0'),
              ('nft_supply_cap', '0'), ('nft_bonus_pool_wallet', ''),
              ('nft_bonus_pool_funded', '0'),
              ('nft_bonus_rate_bonus', '4000000'),
              ('nft_bonus_rate_common', '50000000'),
              ('nft_bonus_rate_uncommon', '100000000')`).run();
  // Per-type snapshot counts (2026-10-29): nft_snapshots gains one
  // column per bonus type. Rows written before this upgrade keep
  // their exact nft_count total and read 0 per type — their type
  // split was never read, and 0 is the honest record of that.
  {
    const cols = db.prepare(`PRAGMA table_info(nft_snapshots)`).all().map((r) => r.name);
    for (const col of ['count_bonus', 'count_common', 'count_uncommon']) {
      if (!cols.includes(col)) {
        db.exec(`ALTER TABLE nft_snapshots ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
      }
    }
  }

  const q = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  // ── One-time FRG -> USTC base-reward migration ──────────────────
  // Runs on the first openStore() under the USTC code. Exact rule:
  // 1. EVERY row then present in the base `accruals` table (kinds
  //    'share' and 'bonus') is copied verbatim to
  //    `legacy_frg_accruals`, tagged with this migration's id.
  // 2. The copied rows are then removed from active `accruals`, so
  //    their FRG-denominated value can never be claimed as USTC.
  //    Historical `payments` rows are not rewritten; unpaid legacy
  //    earnings are computed as accrued - (pending + confirmed paid)
  //    per wallet, floored at zero, and recorded in the migration row.
  // 3. The legacy numeric daily-pool setting is recorded and reset
  //    to 0: an old "100 FRG/day" value must never be silently
  //    reinterpreted as "100 USTC/day". The owner sets a new USTC/day
  //    pool deliberately after the conversion.
  // 4. NFT tables are deliberately untouched (separate FRG mechanic).
  // The reward_currency_migrations row is the guard: if one exists,
  // this function is a no-op, including on later restarts and after
  // new USTC accruals have been recorded.
  function runLegacyFrgRewardMigration() {
    const existing = q(`SELECT * FROM reward_currency_migrations ORDER BY id ASC LIMIT 1`);
    if (existing) return existing;

    const accrualRows = all(`SELECT * FROM accruals ORDER BY id`);
    const accruedByWallet = new Map();
    let archivedAmount = 0n;
    for (const row of accrualRows) {
      const amount = BigInt(row.amount);
      archivedAmount += amount;
      accruedByWallet.set(row.wallet, (accruedByWallet.get(row.wallet) || 0n) + amount);
    }
    const paidByWallet = new Map();
    for (const row of all(
      `SELECT wallet, amount FROM payments WHERE status IN ('pending', 'confirmed')`)) {
      paidByWallet.set(row.wallet, (paidByWallet.get(row.wallet) || 0n) + BigInt(row.amount));
    }
    let archivedUnpaidAmount = 0n;
    for (const [wallet, accrued] of accruedByWallet) {
      const unpaid = accrued - (paidByWallet.get(wallet) || 0n);
      if (unpaid > 0n) archivedUnpaidAmount += unpaid;
    }
    const poolRow = q(`SELECT value FROM settings WHERE key = 'daily_pool'`);
    const legacyDailyPool = BigInt(poolRow?.value ?? '0');
    const migratedAt = Date.now();

    try {
      db.exec('BEGIN');
      const inserted = run(
        `INSERT INTO reward_currency_migrations(
           from_symbol, to_symbol, to_denom, archived_rows, archived_amount,
           archived_unpaid_amount, legacy_daily_pool, migrated_at)
         VALUES('FRG', 'USTC', 'uusd', ?, ?, ?, ?, ?)`,
        accrualRows.length, String(archivedAmount), String(archivedUnpaidAmount),
        String(legacyDailyPool), migratedAt);
      const migrationId = Number(inserted.lastInsertRowid);
      for (const row of accrualRows) {
        run(
          `INSERT INTO legacy_frg_accruals(
             original_id, day, wallet, kind, amount, archived_at, migration_id)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
          row.id, row.day, row.wallet, row.kind, row.amount, migratedAt, migrationId);
      }
      run(`DELETE FROM accruals`);
      run(`INSERT INTO settings(key, value) VALUES('daily_pool', '0')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      run(`INSERT INTO settings(key, value) VALUES('reward_denom', 'uusd')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      run(`INSERT INTO settings(key, value) VALUES('reward_symbol', 'USTC')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      db.exec('COMMIT');
      return q(`SELECT * FROM reward_currency_migrations WHERE id = ?`, migrationId);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }
  runLegacyFrgRewardMigration();
  db.prepare(`INSERT OR IGNORE INTO settings(key, value)
              VALUES('reward_denom', 'uusd'), ('reward_symbol', 'USTC')`).run();

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
    // Conversion audit: the first (and only) FRG -> USTC migration
    // record, or null if this store somehow predates the migration
    // code without having run it. Amounts are BigInt base units:
    // archived amounts are legacy FRG; see runLegacyFrgRewardMigration
    // above for the exact rule.
    getRewardCurrencyMigration() {
      const r = q(`SELECT * FROM reward_currency_migrations ORDER BY id ASC LIMIT 1`);
      if (!r) return null;
      return {
        id: r.id,
        fromSymbol: r.from_symbol,
        toSymbol: r.to_symbol,
        toDenom: r.to_denom,
        archivedRows: r.archived_rows,
        archivedAmount: BigInt(r.archived_amount),
        archivedUnpaidAmount: BigInt(r.archived_unpaid_amount),
        legacyDailyPool: BigInt(r.legacy_daily_pool),
        migratedAt: r.migrated_at,
      };
    },
    legacyAccruals() {
      return all(`SELECT * FROM legacy_frg_accruals ORDER BY legacy_id`);
    },

    // --- Daily snapshot + accrual (idempotent per day) ---
    // Returns { skipped: true } if this day already accrued — a second
    // run for the same day must NEVER double-accrue. Snapshot balances
    // are FRG weights; pool/shares/bonuses are USTC base units computed
    // by engine.js.
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

    // --- Hourly balance samples (accuracy upgrade, 2026-10-25) ---
    // One sample per wallet per UTC hour; re-sampling the same hour
    // replaces that hour's reading (latest wins). Averages are exact
    // BigInt math: SUM of base-unit samples / sample count (integer
    // division drops < 1 base unit — far below display precision, and
    // the split's dust rule still makes shares sum exactly to the pool).
    recordBalanceSample(day, wallet, hour, balance) {
      run(`INSERT INTO balance_samples(day, wallet, hour, balance) VALUES(?, ?, ?, ?)
           ON CONFLICT(day, wallet, hour) DO UPDATE SET balance = excluded.balance`,
          day, wallet, hour, String(balance));
    },
    // Map wallet -> { average: BigInt, samples: n } for one day.
    // Wallets with no samples that day are absent — callers fall back
    // to a live balance read for them.
    averageBalances(day) {
      const rows = all(`SELECT wallet, SUM(CAST(balance AS INTEGER)) AS s, COUNT(*) AS n
                        FROM balance_samples WHERE day = ? GROUP BY wallet`, day);
      const out = new Map();
      for (const r of rows) {
        out.set(r.wallet, { average: BigInt(r.s) / BigInt(r.n), samples: r.n });
      }
      return out;
    },
    sampleStats(day) {
      const r = q(`SELECT COUNT(*) AS rows_n, COUNT(DISTINCT wallet) AS holders_n
                   FROM balance_samples WHERE day = ?`, day);
      return { samples: r.rows_n, holders: r.holders_n };
    },
    // Samples older than the cutoff day are dead weight: a day that
    // has passed can never be re-snapshotted (recordDay refuses
    // duplicates), so its samples are never read again.
    pruneSamples(beforeDay) {
      run(`DELETE FROM balance_samples WHERE day < ?`, beforeDay);
    },

    // --- Ledgers (active base ledger: USTC base units) ---
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
    // Bonus collections list (JSON array in settings): the CW721
    // collections whose holdings count toward the NFT bonus. A
    // holder's tokens across ALL of them consolidate into one count.
    // Falls back to the legacy single 'nft_collection' (the original
    // bonus + mint collection) when the list was never set, so older
    // deployments keep their exact behavior. The legacy value also
    // remains the MINT collection — minting is a separate flow.
    getNftCollections() {
      let list = [];
      try {
        const raw = q(`SELECT value FROM settings WHERE key='nft_collections'`);
        const parsed = raw ? JSON.parse(raw.value) : [];
        if (Array.isArray(parsed)) list = parsed;
      } catch { list = []; }
      // Collections are contracts (64-char addresses); the 44-char
      // wallet shape is also kept for historical stored values.
      list = [...new Set(list.filter((a) => isValidTerraAddress(a) || isValidTerraContractAddress(a)))];
      if (list.length) return list;
      const legacy = this.getNftCollection();
      return legacy ? [legacy] : [];
    },
    // Excluded wallets list (JSON array in settings): wallets that
    // NEVER count toward the NFT bonus — e.g. the owner's own wallet
    // holding unsold bonus stock bought to give away. A snapshot
    // records 0 for them without any chain read; their BASE
    // hold-and-earn rewards are completely unaffected. Admin-set
    // only, empty by default, no legacy fallback.
    getNftExcludedWallets() {
      let list = [];
      try {
        const raw = q(`SELECT value FROM settings WHERE key='nft_excluded_wallets'`);
        const parsed = raw ? JSON.parse(raw.value) : [];
        if (Array.isArray(parsed)) list = parsed;
      } catch { list = []; }
      return [...new Set(list.filter((a) => isValidTerraAddress(a)))];
    },
    getNftMintCost() { return BigInt(q(`SELECT value FROM settings WHERE key='nft_mint_cost'`).value); },
    // Per-type daily bonus rates (base units): { bonus, common,
    // uncommon }. Defaults ship at the owner-decided 4 / 50 / 100
    // FRG (see the defaults insert above); each is independently
    // admin-settable, and 0 disables that type's bonus.
    getNftBonusRates() {
      const rate = (key) => {
        const r = q(`SELECT value FROM settings WHERE key = ?`, key);
        return r ? BigInt(r.value) : 0n;
      };
      return {
        bonus: rate('nft_bonus_rate_bonus'),
        common: rate('nft_bonus_rate_common'),
        uncommon: rate('nft_bonus_rate_uncommon'),
      };
    },
    getNftThreshold() { return Number(q(`SELECT value FROM settings WHERE key='nft_threshold'`).value); },
    getNftSupplyCap() { return Number(q(`SELECT value FROM settings WHERE key='nft_supply_cap'`).value); },
    getNftBonusPoolWallet() { return q(`SELECT value FROM settings WHERE key='nft_bonus_pool_wallet'`).value; },
    getNftSettings() {
      return {
        collection: this.getNftCollection(),
        collections: this.getNftCollections(),
        excludedWallets: this.getNftExcludedWallets(),
        mintCost: this.getNftMintCost(),
        bonusRates: this.getNftBonusRates(),
        threshold: this.getNftThreshold(),
        supplyCap: this.getNftSupplyCap(),
        bonusPoolWallet: this.getNftBonusPoolWallet(),
      };
    },
    setNftSettings(updates) {
      const map = {
        collection: 'nft_collection', collections: 'nft_collections',
        excludedWallets: 'nft_excluded_wallets',
        mintCost: 'nft_mint_cost',
        bonusRateBonus: 'nft_bonus_rate_bonus',
        bonusRateCommon: 'nft_bonus_rate_common',
        bonusRateUncommon: 'nft_bonus_rate_uncommon',
        threshold: 'nft_threshold',
        supplyCap: 'nft_supply_cap', bonusPoolWallet: 'nft_bonus_pool_wallet',
      };
      for (const [field, key] of Object.entries(map)) {
        if (field in updates) {
          const value = field === 'collections' || field === 'excludedWallets'
            ? JSON.stringify(updates[field])
            : String(updates[field]);
          run(`INSERT INTO settings(key, value) VALUES(?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
              key, value);
        }
      }
    },

    // --- NFT snapshot + accrual (idempotent per day, like recordDay) ---
    // counts: [{wallet, nftCount, typeCounts?: {bonus, common,
    // uncommon}}], bonuses: [{wallet, amount: BigInt}]. typeCounts is
    // the per-type split behind nftCount; entries without it record
    // zeros per type (their split was never read).
    recordNftDay(day, counts, bonuses) {
      if (q(`SELECT day FROM nft_days WHERE day = ?`, day)) return { skipped: true };
      try {
        db.exec('BEGIN');
        run(`INSERT INTO nft_days(day) VALUES(?)`, day);
        for (const { wallet, nftCount, typeCounts } of counts) {
          run(`INSERT INTO nft_snapshots(day, wallet, nft_count, count_bonus, count_common, count_uncommon)
               VALUES(?, ?, ?, ?, ?, ?)`,
              day, wallet, nftCount,
              Math.max(0, Math.floor(Number(typeCounts?.bonus) || 0)),
              Math.max(0, Math.floor(Number(typeCounts?.common) || 0)),
              Math.max(0, Math.floor(Number(typeCounts?.uncommon) || 0)));
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
    // Per-type split of the wallet's latest NFT snapshot:
    // { bonus, common, uncommon }. All zeros when the wallet has no
    // snapshot, was excluded, or the snapshot predates type reads.
    latestNftTypeCounts(wallet) {
      const r = q(`SELECT count_bonus, count_common, count_uncommon
                   FROM nft_snapshots WHERE wallet = ?
                   ORDER BY day DESC LIMIT 1`, wallet);
      return {
        bonus: r ? r.count_bonus : 0,
        common: r ? r.count_common : 0,
        uncommon: r ? r.count_uncommon : 0,
      };
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
