// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — accounting aggregation (pure, read-only).
//
// Builds the owner's full FRG accounting from THIS app's own
// records only: payout runs, the base payments ledger, the NFT
// bonus ledgers, registrations and settings. This app's books are
// fully separate from LUNC Dev Studio accounting (or any other
// product's) — no shared ledger, no cross-references, no outside
// numbers. Only the presentation style is shared: clean totals,
// in/out, balances, and every row traceable to a full clickable
// Terra Classic finder link or an app record id.
//
// Honesty rules (never fake anything):
// - Every figure comes from a store record or is arithmetic over
//   store records. Nothing is estimated, backfilled, or cached.
// - USD values are computed ONLY from a run's own stored price
//   (detail.price.frgUsd, the live price that run converted at)
//   and are labeled as such. A run with no stored price reports
//   its USD value as null — never a substitute price.
// - All money math is BigInt base units (6 decimals). The one
//   float in this module is the display-only USD conversion of a
//   run's paid total at that run's stored price.
// ─────────────────────────────────────────────────────────────
import { formatBaseToWhole } from './engine.js';

export const FINDER_BASE = 'https://finder.terraclassic.community/mainnet';
export const finderAddressUrl = (addr) => `${FINDER_BASE}/address/${addr}`;
export const finderTxUrl = (txhash) => `${FINDER_BASE}/tx/${txhash}`;

const whole = (base) => formatBaseToWhole(base);
const usdOfMicro = (micro) => (Number(micro) / 1_000_000).toFixed(2);
// Display-only USD value of a base-unit FRG total at a stored
// USD-per-FRG price. Returns null when the price is unknown.
const usdAtPrice = (base, frgUsd) => (frgUsd === null || frgUsd === undefined
  ? null
  : (Number(base) / 1_000_000) * frgUsd);

export function buildAccounting(store) {
  // ── Giveaway ledger: every owner-pressed payout run ──────────
  const runsRaw = store.allPayoutRuns();
  let givenFrg = 0n;          // the headline: total FRG given away
  let splitFrg = 0n;          // total FRG split across all runs
  let shortfallFrg = 0n;      // total recorded shortfall (still owed)
  let givenUsdAtRunPrices = 0; // display-only sum, run prices only
  let givenUsdComplete = true; // false if any paid run lacks a price
  const perWalletGiven = new Map(); // wallet -> { share, sent }
  const runs = runsRaw.map((run) => {
    givenFrg += run.totalPaid;
    splitFrg += run.totalSplit;
    shortfallFrg += run.shortfall;
    const priceFrgUsd = run.detail?.price?.frgUsd ?? null;
    const paidUsdAtRunPrice = usdAtPrice(run.totalPaid, priceFrgUsd);
    if (run.totalPaid > 0n) {
      if (paidUsdAtRunPrice === null) givenUsdComplete = false;
      else givenUsdAtRunPrices += paidUsdAtRunPrice;
    }
    const rows = (run.detail?.rows || []).map((r) => {
      const share = BigInt(r.amount || '0');
      const sent = BigInt(r.sent || '0');
      const agg = perWalletGiven.get(r.wallet) || { share: 0n, sent: 0n };
      agg.share += share; agg.sent += sent;
      perWalletGiven.set(r.wallet, agg);
      return {
        wallet: r.wallet,
        balance: BigInt(r.balance || '0'), balanceWhole: whole(BigInt(r.balance || '0')),
        amount: share, amountWhole: whole(share),
        claimable: BigInt(r.claimable || '0'), claimableWhole: whole(BigInt(r.claimable || '0')),
        sent, sentWhole: whole(sent),
        txhash: r.txhash || null, payStatus: r.payStatus || null,
      };
    });
    return {
      day: run.day, status: run.status, pressedAt: run.pressedAt,
      registeredCount: run.registeredCount,
      payoutUsdMicro: run.payoutUsdMicro,
      payoutUsd: usdOfMicro(run.payoutUsdMicro),
      potBase: run.potBase, potWhole: run.potBase === null ? null : whole(run.potBase),
      totalSplit: run.totalSplit, totalSplitWhole: whole(run.totalSplit),
      totalPaid: run.totalPaid, totalPaidWhole: whole(run.totalPaid),
      shortfall: run.shortfall, shortfallWhole: whole(run.shortfall),
      priceFrgUsd,
      paidUsdAtRunPrice,
      error: run.detail?.error || null,
      deregistered: (run.detail?.deregistered || []).map((d) => ({
        wallet: d.wallet, balanceWhole: whole(BigInt(d.balance || '0')),
      })),
      rows,
    };
  });

  // The base payments ledger (every send the server ever made for
  // base rewards — payout-run sends and Collect sends alike), and
  // its confirmed+pending total, which the store also reports as
  // totalPaid(). Shown next to the run totals so the two records
  // can be reconciled at a glance.
  const payments = store.allPayments();
  const ledgerPaid = store.totalPaid();
  const ledgerAccrued = store.totalAccrued();

  // ── NFT bonus ledger ─────────────────────────────────────────
  const bonusFunded = store.nftBonusPoolFunded();
  const bonusPaid = store.nftTotalPaid();
  const bonusAvailable = store.nftBonusPoolAvailable();
  const poolEvents = store.allNftPoolEvents().map((e) => ({
    id: e.id, amount: e.amount, amountWhole: whole(e.amount),
    note: e.note, txhash: e.txhash, createdAt: e.createdAt,
  }));
  const nftPayments = store.allNftPayments();
  // Per-day accrual records, grouped honestly by recorded day.
  const accrualsByDay = new Map();
  for (const a of store.allNftAccruals()) {
    const d = accrualsByDay.get(a.day) || { day: a.day, wallets: 0, total: 0n };
    d.wallets += 1; d.total += a.amount;
    accrualsByDay.set(a.day, d);
  }
  const nftAccrualDays = [...accrualsByDay.values()].map((d) => ({
    ...d, totalWhole: whole(d.total),
  }));
  // Per-wallet bonus totals. The wallet set is the union of every
  // wallet appearing in the bonus ledgers OR holding an NFT
  // snapshot — so a wallet whose count ran while it was excluded
  // (accrued exactly 0) still gets its own visible line of zeros.
  const nftWallets = new Set([
    ...store.allNftAccruals().map((a) => a.wallet),
    ...nftPayments.map((p) => p.wallet),
    ...store.allNftSnapshotWallets(),
  ]);
  const nftPerWallet = [...nftWallets].sort().map((wallet) => {
    const accrued = store.nftAccrued(wallet);
    const paid = store.nftPaid(wallet);
    const claimable = store.nftClaimable(wallet);
    const counts = store.latestNftTypeCounts(wallet);
    return {
      wallet,
      nftCount: store.latestNftCount(wallet),
      typeCounts: counts,
      lastSnapshotDay: store.lastNftSnapshotDay(wallet),
      accrued, accruedWhole: whole(accrued),
      paid, paidWhole: whole(paid),
      claimable, claimableWhole: whole(claimable),
    };
  });
  const bonusAccruedTotal = nftPerWallet.reduce((s, w) => s + w.accrued, 0n);

  // ── Holdings / registrations summary ─────────────────────────
  const registrations = store.allRegistrations();
  const latestDay = store.latestSnapshotDay();
  const latestSnapshot = latestDay ? store.daySnapshots(latestDay) : [];
  const totalHeldLatest = latestSnapshot.reduce((s, r) => s + r.balance, 0n);

  // Records horizon: the earliest day this app's books cover,
  // from the run/snapshot records themselves. Null when the books
  // are empty — the view says so instead of inventing a start.
  const firstDays = [
    runs.length ? runs[0].day : null,
    store.snapshotDays()[0] || null,
    store.nftSnapshotDays()[0] || null,
  ].filter(Boolean).sort();
  const recordsFrom = firstDays.length ? firstDays[0] : null;

  return {
    recordsFrom,
    giveaway: {
      runs,
      runCount: runs.length,
      totalPaid: givenFrg, totalPaidWhole: whole(givenFrg),
      totalSplit: splitFrg, totalSplitWhole: whole(splitFrg),
      totalShortfall: shortfallFrg, totalShortfallWhole: whole(shortfallFrg),
      // USD value of everything given away, each run valued at
      // ITS OWN stored price; null total when a paid run has no
      // stored price (the per-run lines still show what is known).
      totalPaidUsdAtRunPrices: givenUsdComplete ? givenUsdAtRunPrices : null,
      perWallet: [...perWalletGiven.entries()]
        .map(([wallet, v]) => ({
          wallet, share: v.share, shareWhole: whole(v.share),
          sent: v.sent, sentWhole: whole(v.sent),
        }))
        .sort((a, b) => (b.sent > a.sent ? 1 : b.sent < a.sent ? -1 : 0)),
      ledgerAccrued, ledgerAccruedWhole: whole(ledgerAccrued),
      ledgerPaid, ledgerPaidWhole: whole(ledgerPaid),
      payments: payments.map((p) => ({
        id: p.id, wallet: p.wallet, amount: p.amount, amountWhole: whole(p.amount),
        status: p.status, txhash: p.txhash, createdAt: p.createdAt,
      })),
    },
    nftBonus: {
      collection: store.getNftSettings().collection,
      collections: store.getNftSettings().collections,
      bonusPoolWallet: store.getNftSettings().bonusPoolWallet,
      funded: bonusFunded, fundedWhole: whole(bonusFunded),
      paid: bonusPaid, paidWhole: whole(bonusPaid),
      available: bonusAvailable, availableWhole: whole(bonusAvailable),
      accruedTotal: bonusAccruedTotal, accruedTotalWhole: whole(bonusAccruedTotal),
      poolEvents,
      accrualDays: nftAccrualDays,
      perWallet: nftPerWallet,
      payments: nftPayments.map((p) => ({
        id: p.id, wallet: p.wallet, amount: p.amount, amountWhole: whole(p.amount),
        status: p.status, txhash: p.txhash, createdAt: p.createdAt,
      })),
    },
    holdings: {
      registeredCount: registrations.length,
      registrations: registrations.map((r) => ({
        wallet: r.wallet, registeredAt: r.registeredAt,
      })),
      latestSnapshotDay: latestDay,
      latestSnapshotWallets: latestSnapshot.length,
      totalHeldLatest, totalHeldLatestWhole: whole(totalHeldLatest),
      minHolding: store.getMinHoldingBase(),
      minHoldingWhole: whole(store.getMinHoldingBase()),
      dailyPayoutUsdMicro: store.getDailyPayoutUsdMicro(),
      dailyPayoutUsd: usdOfMicro(store.getDailyPayoutUsdMicro()),
      dailyLimit: store.getDailyLimitBase(),
      dailyLimitWhole: whole(store.getDailyLimitBase()),
      splitDeadlineMs: store.getSplitDeadlineMs() || null,
    },
  };
}

// ── CSV export ─────────────────────────────────────────────────
// Plain statement, same numbers as the on-screen view, every row
// traceable to a tx link or an app record id. Sections are
// separated by blank lines; each section carries its own header.
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(',');

export function accountingToCsv(acct, { payoutWallet, generatedAt }) {
  const lines = [];
  lines.push('FRG Hold & Earn — FRG accounting statement');
  lines.push(csvRow(['Generated (UTC)', new Date(generatedAt).toISOString()]));
  lines.push(csvRow(['Records from', acct.recordsFrom || 'no records yet']));
  lines.push(csvRow(['Payout wallet', payoutWallet || 'not set']));
  if (payoutWallet) lines.push(csvRow(['Payout wallet (finder)', finderAddressUrl(payoutWallet)]));
  lines.push('');
  lines.push('GIVEAWAY TOTALS — the amount we give away');
  lines.push(csvRow(['Payout runs recorded', acct.giveaway.runCount]));
  lines.push(csvRow(['Total FRG given away (all runs)', acct.giveaway.totalPaidWhole]));
  lines.push(csvRow(['Total FRG split (all runs)', acct.giveaway.totalSplitWhole]));
  lines.push(csvRow(['Total shortfall still owed (FRG)', acct.giveaway.totalShortfallWhole]));
  lines.push(csvRow(['Total USD value at each run\'s own price',
    acct.giveaway.totalPaidUsdAtRunPrices === null
      ? 'not fully known — a paid run has no stored price'
      : acct.giveaway.totalPaidUsdAtRunPrices.toFixed(2)]));
  lines.push(csvRow(['Base ledger accrued (FRG)', acct.giveaway.ledgerAccruedWhole]));
  lines.push(csvRow(['Base ledger paid, pending+confirmed (FRG)', acct.giveaway.ledgerPaidWhole]));
  lines.push('');
  lines.push('GIVEAWAY RUNS');
  lines.push(csvRow(['day', 'status', 'pressed_at_utc', 'registered_wallets',
    'daily_amount_set_usd', 'frg_price_usd_at_run', 'pot_frg', 'split_frg',
    'paid_frg', 'paid_usd_at_run_price', 'shortfall_frg']));
  for (const r of acct.giveaway.runs) {
    lines.push(csvRow([r.day, r.status,
      r.pressedAt ? new Date(r.pressedAt).toISOString() : '',
      r.registeredCount, r.payoutUsd,
      r.priceFrgUsd === null ? '' : r.priceFrgUsd,
      r.potWhole ?? '', r.totalSplitWhole, r.totalPaidWhole,
      r.paidUsdAtRunPrice === null ? '' : r.paidUsdAtRunPrice.toFixed(2),
      r.shortfallWhole]));
  }
  lines.push('');
  lines.push('GIVEAWAY RUN DETAIL — per wallet');
  lines.push(csvRow(['day', 'wallet', 'wallet_finder', 'held_frg', 'share_frg',
    'sent_frg', 'pay_status', 'txhash', 'tx_finder']));
  for (const r of acct.giveaway.runs) {
    for (const row of r.rows) {
      lines.push(csvRow([r.day, row.wallet, finderAddressUrl(row.wallet),
        row.balanceWhole, row.amountWhole, row.sentWhole, row.payStatus || '',
        row.txhash || '', row.txhash ? finderTxUrl(row.txhash) : '']));
    }
  }
  lines.push('');
  lines.push('GIVEAWAY TOTALS PER WALLET (all runs)');
  lines.push(csvRow(['wallet', 'wallet_finder', 'total_share_frg', 'total_sent_frg']));
  for (const w of acct.giveaway.perWallet) {
    lines.push(csvRow([w.wallet, finderAddressUrl(w.wallet), w.shareWhole, w.sentWhole]));
  }
  lines.push('');
  lines.push('BASE PAYMENTS LEDGER (app record)');
  lines.push(csvRow(['record_id', 'wallet', 'wallet_finder', 'amount_frg', 'status',
    'created_at_utc', 'txhash', 'tx_finder']));
  for (const p of acct.giveaway.payments) {
    lines.push(csvRow([p.id, p.wallet, finderAddressUrl(p.wallet), p.amountWhole,
      p.status, p.createdAt ? new Date(p.createdAt).toISOString() : '',
      p.txhash || '', p.txhash ? finderTxUrl(p.txhash) : '']));
  }
  lines.push('');
  lines.push('NFT BONUS POOL');
  lines.push(csvRow(['Bonus pool wallet', acct.nftBonus.bonusPoolWallet || 'not set']));
  if (acct.nftBonus.bonusPoolWallet) {
    lines.push(csvRow(['Bonus pool wallet (finder)', finderAddressUrl(acct.nftBonus.bonusPoolWallet)]));
  }
  lines.push(csvRow(['Funded (FRG)', acct.nftBonus.fundedWhole]));
  lines.push(csvRow(['Paid out (FRG)', acct.nftBonus.paidWhole]));
  lines.push(csvRow(['Available = funded - paid (FRG)', acct.nftBonus.availableWhole]));
  lines.push(csvRow(['Accrued to holders, all days (FRG)', acct.nftBonus.accruedTotalWhole]));
  lines.push('');
  lines.push('NFT BONUS POOL FUNDING EVENTS (app record)');
  lines.push(csvRow(['record_id', 'amount_frg', 'note', 'created_at_utc', 'txhash', 'tx_finder']));
  for (const e of acct.nftBonus.poolEvents) {
    lines.push(csvRow([e.id, e.amountWhole, e.note || '',
      e.createdAt ? new Date(e.createdAt).toISOString() : '',
      e.txhash || '', e.txhash ? finderTxUrl(e.txhash) : '']));
  }
  lines.push('');
  lines.push('NFT BONUS ACCRUALS BY DAY');
  lines.push(csvRow(['day', 'wallets_accrued', 'total_frg']));
  for (const d of acct.nftBonus.accrualDays) {
    lines.push(csvRow([d.day, d.wallets, d.totalWhole]));
  }
  lines.push('');
  lines.push('NFT BONUS PER WALLET');
  lines.push(csvRow(['wallet', 'wallet_finder', 'nfts_latest', 'bonus_type', 'common_type',
    'uncommon_type', 'last_snapshot_day', 'accrued_frg', 'collected_frg', 'claimable_frg']));
  for (const w of acct.nftBonus.perWallet) {
    lines.push(csvRow([w.wallet, finderAddressUrl(w.wallet), w.nftCount,
      w.typeCounts.bonus, w.typeCounts.common, w.typeCounts.uncommon,
      w.lastSnapshotDay || '', w.accruedWhole, w.paidWhole, w.claimableWhole]));
  }
  lines.push('');
  lines.push('NFT BONUS PAYMENTS (app record)');
  lines.push(csvRow(['record_id', 'wallet', 'wallet_finder', 'amount_frg', 'status',
    'created_at_utc', 'txhash', 'tx_finder']));
  for (const p of acct.nftBonus.payments) {
    lines.push(csvRow([p.id, p.wallet, finderAddressUrl(p.wallet), p.amountWhole,
      p.status, p.createdAt ? new Date(p.createdAt).toISOString() : '',
      p.txhash || '', p.txhash ? finderTxUrl(p.txhash) : '']));
  }
  lines.push('');
  lines.push('HOLDINGS & SETTINGS (current)');
  lines.push(csvRow(['Registered wallets', acct.holdings.registeredCount]));
  lines.push(csvRow(['Latest recorded snapshot day', acct.holdings.latestSnapshotDay || 'none yet']));
  lines.push(csvRow(['Wallets in latest snapshot', acct.holdings.latestSnapshotWallets]));
  lines.push(csvRow(['Total FRG held by those wallets', acct.holdings.totalHeldLatestWhole]));
  lines.push(csvRow(['Minimum holding setting (FRG)', acct.holdings.minHoldingWhole]));
  lines.push(csvRow(['Daily payout amount setting (USD)', acct.holdings.dailyPayoutUsd]));
  lines.push(csvRow(['Daily hard limit setting (FRG)', acct.holdings.dailyLimitWhole]));
  lines.push('');
  lines.push('REGISTERED WALLETS');
  lines.push(csvRow(['wallet', 'wallet_finder', 'registered_at_utc']));
  for (const r of acct.holdings.registrations) {
    lines.push(csvRow([r.wallet, finderAddressUrl(r.wallet),
      r.registeredAt ? new Date(r.registeredAt).toISOString() : '']));
  }
  return lines.join('\n') + '\n';
}
