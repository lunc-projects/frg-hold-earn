// Migration tests: the one-time FRG -> USTC conversion of the base
// reward ledger. A legacy database is built BY HAND with the old
// schema and FRG-denominated accrual rows, then opened with the new
// store code — exactly what happens on the first boot after deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.js';

const A = 'terra1' + 'a'.repeat(38);
const B = 'terra1' + 'q'.repeat(38);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frg-migration-'));
}

// Legacy fixture:
// - A accrued 700 share + 300 referral bonus (all unpaid)
// - B accrued 500 share, of which 200 was historically paid
// - legacy daily pool setting: 100 FRG/day (100,000,000 base units)
// - one NFT bonus accrual (separate FRG mechanic — must be untouched)
function buildLegacyDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE wallets(address TEXT PRIMARY KEY, referrer TEXT, registered_at INTEGER);
    CREATE TABLE snapshots(day TEXT, wallet TEXT, balance TEXT, PRIMARY KEY(day, wallet));
    CREATE TABLE day_pools(day TEXT PRIMARY KEY, pool TEXT);
    CREATE TABLE accruals(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT, wallet TEXT, kind TEXT, amount TEXT,
      UNIQUE(day, wallet, kind));
    CREATE TABLE payments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT, amount TEXT, status TEXT, txhash TEXT, created_at INTEGER);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE nft_accruals(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT, wallet TEXT, amount TEXT,
      UNIQUE(day, wallet));
  `);
  const insSetting = db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)`);
  insSetting.run('daily_pool', '100000000');
  insSetting.run('affiliate_rate_bps', '1000');
  const insAccrual = db.prepare(
    `INSERT INTO accruals(id, day, wallet, kind, amount) VALUES(?, ?, ?, ?, ?)`);
  insAccrual.run(1, '2026-10-24', A, 'share', '700');
  insAccrual.run(2, '2026-10-24', A, 'bonus', '300');
  insAccrual.run(3, '2026-10-24', B, 'share', '500');
  db.prepare(`INSERT INTO payments(wallet, amount, status, txhash, created_at)
              VALUES(?, '200', 'confirmed', 'LEGACYTX', 1)`).run(B);
  db.prepare(`INSERT INTO nft_accruals(day, wallet, amount) VALUES('2026-10-24', ?, '777')`).run(A);
  db.close();
}

test('migration archives every legacy accrual, zeroes unpaid, resets the pool', () => {
  const file = path.join(tmpDir(), 'legacy.db');
  buildLegacyDb(file);
  const s = openStore(file);
  try {
    // Active base ledger: nothing FRG-denominated remains claimable.
    assert.equal(s.accrued(A), 0n);
    assert.equal(s.accrued(B), 0n);
    assert.equal(s.claimable(A), 0n);
    assert.equal(s.claimable(B), 0n);
    assert.equal(s.totalAccrued(), 0n);

    // Archive: verbatim copies, tagged and complete.
    const archived = s.legacyAccruals();
    assert.equal(archived.length, 3);
    assert.deepEqual(
      archived.map((r) => [r.original_id, r.day, r.wallet, r.kind, r.amount]),
      [
        [1, '2026-10-24', A, 'share', '700'],
        [2, '2026-10-24', A, 'bonus', '300'],
        [3, '2026-10-24', B, 'share', '500'],
      ]);

    // Migration record: gross archived 1,500; unpaid archived 1,300
    // (B's 200 historically paid is not counted as unpaid); the old
    // 100 FRG/day pool value is recorded, NOT carried into USTC.
    const m = s.getRewardCurrencyMigration();
    assert.equal(m.fromSymbol, 'FRG');
    assert.equal(m.toSymbol, 'USTC');
    assert.equal(m.toDenom, 'uusd');
    assert.equal(m.archivedRows, 3);
    assert.equal(m.archivedAmount, 1500n);
    assert.equal(m.archivedUnpaidAmount, 1300n);
    assert.equal(m.legacyDailyPool, 100000000n);
    assert.equal(typeof m.migratedAt, 'number');
    assert.equal(s.getDailyPool(), 0n); // reset — owner sets USTC/day fresh

    // NFT bonus ledger is a separate mechanic: untouched.
    assert.equal(s.nftAccrued(A), 777n);
  } finally {
    s.db.close();
  }
});

test('migrations are idempotent and never touch post-conversion accruals', () => {
  const file = path.join(tmpDir(), 'legacy.db');
  buildLegacyDb(file);
  const first = openStore(file);
  first.db.close();

  const second = openStore(file);
  try {
    assert.equal(second.legacyAccruals().length, 3); // no second archive pass
    const count = second.db.prepare(`SELECT COUNT(*) AS n FROM reward_currency_migrations`).get().n;
    assert.equal(count, 2); // migration #1 (FRG->USTC) + #2 (USTC->FRG), each exactly once
    // New earnings recorded after the conversions...
    second.registerWallet(A, null);
    second.setDailyPool(400n);
    second.recordDay('2026-10-28', 400n,
      [{ wallet: A, balance: 10n }], [{ wallet: A, amount: 400n }], []);
    assert.equal(second.claimable(A), 400n);
  } finally {
    second.db.close();
  }

  const third = openStore(file);
  try {
    // ...survive later restarts completely untouched.
    assert.equal(third.accrued(A), 400n);
    assert.equal(third.claimable(A), 400n);
    assert.equal(third.legacyAccruals().length, 3);
    const count = third.db.prepare(`SELECT COUNT(*) AS n FROM reward_currency_migrations`).get().n;
    assert.equal(count, 2);
  } finally {
    third.db.close();
  }
});

test('a brand-new store records an empty migration and starts at a zero USTC pool', () => {
  const s = openStore(path.join(tmpDir(), 'fresh.db'));
  try {
    const m = s.getRewardCurrencyMigration();
    assert.equal(m.archivedRows, 0);
    assert.equal(m.archivedAmount, 0n);
    assert.equal(m.archivedUnpaidAmount, 0n);
    assert.equal(s.getDailyPool(), 0n);
  } finally {
    s.db.close();
  }
});

// ── Migration #2: USTC -> FRG (owner ruling, 2026-11-05) ──────────
// Fixture: a database as it existed AFTER migration #1 ran and the
// USTC era accrued real rows — migration #1's record present,
// USTC-denominated accruals active, a USTC daily cap set, settings
// reading USTC. Opening it with the new code must run ONLY #2.
function buildPostUstcDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE wallets(address TEXT PRIMARY KEY, referrer TEXT, registered_at INTEGER);
    CREATE TABLE snapshots(day TEXT, wallet TEXT, balance TEXT, PRIMARY KEY(day, wallet));
    CREATE TABLE day_pools(day TEXT PRIMARY KEY, pool TEXT);
    CREATE TABLE accruals(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT, wallet TEXT, kind TEXT, amount TEXT,
      UNIQUE(day, wallet, kind));
    CREATE TABLE payments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT, amount TEXT, status TEXT, txhash TEXT, created_at INTEGER);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE nft_accruals(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT, wallet TEXT, amount TEXT,
      UNIQUE(day, wallet));
    CREATE TABLE reward_currency_migrations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_symbol TEXT, to_symbol TEXT, to_denom TEXT,
      archived_rows INTEGER, archived_amount TEXT,
      archived_unpaid_amount TEXT, legacy_daily_pool TEXT,
      migrated_at INTEGER);
  `);
  // Migration #1's historical record — must survive untouched.
  db.prepare(`INSERT INTO reward_currency_migrations(
                from_symbol, to_symbol, to_denom, archived_rows, archived_amount,
                archived_unpaid_amount, legacy_daily_pool, migrated_at)
              VALUES('FRG', 'USTC', 'uusd', 3, '1500', '1300', '100000000', 111)`).run();
  const insSetting = db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)`);
  insSetting.run('daily_pool', '777000000'); // 777 USTC/day cap
  insSetting.run('affiliate_rate_bps', '1000');
  insSetting.run('reward_denom', 'uusd');
  insSetting.run('reward_symbol', 'USTC');
  const insAccrual = db.prepare(
    `INSERT INTO accruals(id, day, wallet, kind, amount) VALUES(?, ?, ?, ?, ?)`);
  insAccrual.run(1, '2026-10-26', A, 'share', '900');
  insAccrual.run(2, '2026-10-26', A, 'bonus', '100');
  insAccrual.run(3, '2026-10-26', B, 'share', '500');
  db.prepare(`INSERT INTO payments(wallet, amount, status, txhash, created_at)
              VALUES(?, '200', 'confirmed', 'USTCTX', 2)`).run(B);
  db.prepare(`INSERT INTO nft_accruals(day, wallet, amount) VALUES('2026-10-26', ?, '555')`).run(A);
  db.close();
}

test('migration #2 archives USTC accruals, resets the cap, flips the live symbol to FRG', () => {
  const file = path.join(tmpDir(), 'post-ustc.db');
  buildPostUstcDb(file);
  const s = openStore(file);
  try {
    // Active ledger cleared of USTC-denominated value.
    assert.equal(s.totalAccrued(), 0n);
    assert.equal(s.claimable(A), 0n);
    assert.equal(s.claimable(B), 0n);
    // Archive: verbatim, in the USTC archive table, tagged with #2.
    const archived = s.legacyUstcAccruals();
    assert.equal(archived.length, 3);
    assert.deepEqual(
      archived.map((r) => [r.original_id, r.day, r.wallet, r.kind, r.amount, r.migration_id]),
      [
        [1, '2026-10-26', A, 'share', '900', 2],
        [2, '2026-10-26', A, 'bonus', '100', 2],
        [3, '2026-10-26', B, 'share', '500', 2],
      ]);
    // Migration #1's FRG archive is untouched and separate.
    assert.equal(s.legacyAccruals().length, 0); // (this fixture predates no FRG rows)
    const migrations = s.getRewardCurrencyMigrations();
    assert.equal(migrations.length, 2);
    // #1 record byte-for-byte the historical one.
    assert.equal(migrations[0].id, 1);
    assert.equal(migrations[0].fromSymbol, 'FRG');
    assert.equal(migrations[0].toSymbol, 'USTC');
    assert.equal(migrations[0].archivedAmount, 1500n);
    assert.equal(migrations[0].migratedAt, 111);
    // #2 record: gross 1,500; unpaid 1,300 (B's 200 paid nets out);
    // the 777 USTC/day cap recorded, NOT carried into FRG.
    assert.equal(migrations[1].fromSymbol, 'USTC');
    assert.equal(migrations[1].toSymbol, 'FRG');
    assert.equal(migrations[1].toDenom, 'terra14rfnhc2aru7jp304lht3yf903necsnrt4cxd464cftsfcksw0rtsgundnt');
    assert.equal(migrations[1].archivedRows, 3);
    assert.equal(migrations[1].archivedAmount, 1500n);
    assert.equal(migrations[1].archivedUnpaidAmount, 1300n);
    assert.equal(migrations[1].legacyDailyPool, 777000000n);
    assert.equal(s.getDailyPool(), 0n); // cap reset — owner sets FRG numbers fresh
    assert.equal(s.getRewardSymbol(), 'FRG'); // operative setting flipped
    // NFT ledger untouched by #2 as well.
    assert.equal(s.nftAccrued(A), 555n);
  } finally {
    s.db.close();
  }
});

test('migration #2 is idempotent; new FRG accruals after it survive restarts', () => {
  const file = path.join(tmpDir(), 'post-ustc.db');
  buildPostUstcDb(file);
  const first = openStore(file);
  first.registerWallet(A, null);
  first.setDailyPool(400n);
  first.recordDay('2026-11-06', 400n,
    [{ wallet: A, balance: 10n }], [{ wallet: A, amount: 400n }], []);
  first.db.close();

  const second = openStore(file);
  try {
    assert.equal(second.getRewardCurrencyMigrations().length, 2); // no third run
    assert.equal(second.legacyUstcAccruals().length, 3); // no re-archive
    assert.equal(second.accrued(A), 400n); // FRG-era accrual intact
    assert.equal(second.getRewardSymbol(), 'FRG');
  } finally {
    second.db.close();
  }
});
