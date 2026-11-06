import { useCallback, useEffect, useState } from 'react';
import { ADMIN_ADDRESS, FINDER, toWhole, shortAddr } from './config.js';
import {
  fetchHoldings, getStats, getBalance, getRewards, getReferrals, register,
  getAdmin, adminSetRate, adminSnapshot, adminSetPayoutAmount, adminSetLimit,
  adminSetMinHolding, adminPayoutPreview, adminRunPayout,
  adminTimerStart, adminTimerSet, adminTimerClear,
  getNft, collectNftBonus, getAdminNft, adminSetNftSettings, adminFundBonusPool,
} from './lib/api.js';

// Every deadline shown anywhere on this page is rendered in US
// Eastern Time with the zone named, so the printed time always
// matches the announced cutoff (e.g. "8:00 AM ET"). Local device
// time is never used for deadline displays — a visitor in another
// timezone would otherwise see a different hour than the cutoff
// the owner announced.
const fmtET = (ms) => new Date(ms).toLocaleString('en-US', {
  timeZone: 'America/New_York',
  month: 'numeric', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
}) + ' ET';

const fmtCountdown = (totalSeconds) => {
  const s = Math.max(0, Math.floor(totalSeconds));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

// FRG Hold & Earn — PASTE-ONLY. There is no wallet connect and no
// signing anywhere in this app: pasting an address registers it and
// shows its balance/rewards view. Payouts are sent automatically
// from the program's payout wallet when the owner runs the daily
// payout. Any version of this app that asks to connect a wallet or
// sign anything is a fake.
const ADDR_RE = /^terra1[023456789acdefghjklmnpqrstuvwxyz]{38}$/;

export default function App() {
  const [stats, setStats] = useState(null);
  const [paste, setPaste] = useState('');
  const [address, setAddress] = useState(''); // the pasted (viewed) wallet
  const [holdings, setHoldings] = useState(null);
  const [rewards, setRewards] = useState(null);
  const [referrals, setReferrals] = useState(null);
  const [nft, setNft] = useState(null);
  const [collectingNft, setCollectingNft] = useState(false);
  const [log, setLog] = useState('');
  const [regBusy, setRegBusy] = useState(false);

  // Admin state (panel shows when the pasted wallet is the admin
  // wallet; the secret gates every admin call server-side).
  const isAdmin = address !== '' && address === (stats?.adminWallet || ADMIN_ADDRESS);
  const [adminSecret, setAdminSecret] = useState('');
  const [adminStats, setAdminStats] = useState(null);
  const [adminNft, setAdminNft] = useState(null);
  const [payoutInput, setPayoutInput] = useState('');
  const [limitInput, setLimitInput] = useState('');
  const [minHoldingInput, setMinHoldingInput] = useState('');
  const [rateInput, setRateInput] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [deadlineInput, setDeadlineInput] = useState('');
  // Split countdown: anchored to the SERVER's secondsRemaining on
  // every stats load (the visitor's device clock never decides
  // the deadline), then ticked down locally once a second.
  const [remaining, setRemaining] = useState(null);
  useEffect(() => {
    setRemaining(stats?.splitDeadlineMs ? (stats.secondsRemaining ?? 0) : null);
  }, [stats]);
  const timerRunning = remaining !== null && remaining > 0;
  useEffect(() => {
    if (!timerRunning) return undefined;
    const id = setInterval(() => setRemaining((r) => (r === null ? null : Math.max(0, r - 1))), 1000);
    return () => clearInterval(id);
  }, [timerRunning]);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [nftCollectionsInput, setNftCollectionsInput] = useState('');
  const [nftExcludedInput, setNftExcludedInput] = useState('');
  const [nftMintInput, setNftMintInput] = useState('');
  const [nftRateBonusInput, setNftRateBonusInput] = useState('');
  const [nftRateCommonInput, setNftRateCommonInput] = useState('');
  const [nftRateUncommonInput, setNftRateUncommonInput] = useState('');
  const [nftThresholdInput, setNftThresholdInput] = useState('');
  const [nftCapInput, setNftCapInput] = useState('');
  const [nftPoolWalletInput, setNftPoolWalletInput] = useState('');
  const [nftFundInput, setNftFundInput] = useState('');
  const [nftFundNoteInput, setNftFundNoteInput] = useState('');

  // The reward currency is whatever the API reports (FRG since the
  // 2026-11-05 switch) — the page never hard-codes it.
  const rewardSymbol = rewards?.rewardSymbol || stats?.rewardSymbol || 'FRG';

  const pushLog = useCallback((m) => setLog((prev) => (prev ? `${prev}\n${m}` : m)), []);

  const loadStats = useCallback(async () => {
    try { setStats(await getStats()); } catch (e) { pushLog(`Stats failed: ${e.message}`); }
  }, [pushLog]);

  useEffect(() => { loadStats(); }, [loadStats]);

  const refreshViews = useCallback(async (addr) => {
    const [h, r, rf, n, b] = await Promise.allSettled([
      fetchHoldings(addr), getRewards(addr), getReferrals(addr), getNft(addr), getBalance(addr),
    ]);
    if (h.status === 'fulfilled') setHoldings(h.value);
    else if (b.status === 'fulfilled') setHoldings(b.value.balance);
    else pushLog(`Balance lookup failed: ${h.reason?.message || h.reason}`);
    if (r.status === 'fulfilled') setRewards(r.value);
    else pushLog(`Rewards lookup failed: ${r.reason?.message || r.reason}`);
    if (rf.status === 'fulfilled') setReferrals(rf.value);
    if (n.status === 'fulfilled') setNft(n.value);
  }, [pushLog]);

  // THE door: paste an address -> it registers ONCE, permanently,
  // and its view loads. Pasting again later just shows the view.
  // Invalid input is a plain error.
  const doRegister = async () => {
    const addr = paste.trim();
    if (!ADDR_RE.test(addr)) {
      pushLog('That does not look like a Terra address. Paste a full terra1… address and try again.');
      return;
    }
    setRegBusy(true);
    try {
      const ref = new URLSearchParams(window.location.search).get('ref') || '';
      const out = await register(addr, ref && ref !== addr ? ref : null);
      setAddress(addr);
      pushLog(out.created
        ? '✅ Registered! Paste once — you\'re registered. As long as you hold FRG, you\'re in every day\'s split.'
        : '✅ You\'re registered — this paste just shows your wallet view. Registration is one-time and permanent.');
      await refreshViews(addr);
      await loadStats();
    } catch (e) {
      pushLog(`Registration failed: ${e.message}`);
    } finally {
      setRegBusy(false);
    }
  };

  const doCollectNft = async () => {
    setCollectingNft(true);
    try {
      const out = await collectNftBonus(address);
      pushLog(`✅ Collected ${out.paidWhole} FRG NFT bonus — ${FINDER}/tx/${out.txhash}`);
      await refreshViews(address);
    } catch (e) {
      pushLog(`NFT bonus collect failed: ${e.message}`);
    } finally {
      setCollectingNft(false);
    }
  };

  // --- Admin helpers ---
  const doAdmin = async (label, fn) => {
    try {
      const out = await fn();
      pushLog(`✅ ${label}`);
      return out;
    } catch (e) {
      pushLog(`${label} failed: ${e.message}`);
      return null;
    }
  };

  const loadAdmin = async () => {
    const out = await doAdmin('Admin stats loaded', () => getAdmin(adminSecret, address));
    if (out) {
      setAdminStats(out);
      setPayoutInput(String(out.dailyPayoutUsd ?? ''));
      setLimitInput(String(out.dailyLimitWhole ?? ''));
      setMinHoldingInput(String(out.minHoldingWhole ?? ''));
    }
  };

  const loadAdminNft = async () => {
    const out = await doAdmin('NFT admin stats loaded', () => getAdminNft(adminSecret, address));
    if (out) setAdminNft(out);
  };

  const loadPreview = async () => {
    setPreviewBusy(true);
    try {
      const out = await adminPayoutPreview(adminSecret, address);
      setPreview(out);
      pushLog(`Preview loaded: ${out.registeredCount} registered wallet(s) in the split.`);
    } catch (e) {
      pushLog(`Preview failed: ${e.message}`);
    } finally {
      setPreviewBusy(false);
    }
  };

  const pressPayout = async () => {
    setPayoutBusy(true);
    try {
      const run = await adminRunPayout(adminSecret, address);
      setLastRun(run);
      pushLog(run.status === 'halted_price'
        ? '⛔ Payout halted: the live price could not be read, so nothing was paid. Press again when the price is back.'
        : `✅ Payout run ${run.day}: status ${run.status} — paid ${run.totalPaidWhole} ${rewardSymbol} to the registered wallets.`);
      await loadStats();
      if (address) await refreshViews(address);
    } catch (e) {
      pushLog(`Payout failed: ${e.message}`);
    } finally {
      setPayoutBusy(false);
    }
  };

  const saveNftSettings = async () => {
    const body = {};
    const list = (txt) => txt.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    if (nftCollectionsInput.trim() !== '') body.collections = list(nftCollectionsInput);
    if (nftExcludedInput.trim() !== '') body.excludedWallets = list(nftExcludedInput);
    if (nftMintInput !== '') body.mintCost = nftMintInput;
    if (nftRateBonusInput !== '') body.bonusRateBonus = nftRateBonusInput;
    if (nftRateCommonInput !== '') body.bonusRateCommon = nftRateCommonInput;
    if (nftRateUncommonInput !== '') body.bonusRateUncommon = nftRateUncommonInput;
    if (nftThresholdInput !== '') body.threshold = nftThresholdInput;
    if (nftCapInput !== '') body.supplyCap = nftCapInput;
    if (nftPoolWalletInput.trim() !== '') body.bonusPoolWallet = nftPoolWalletInput.trim();
    if (Object.keys(body).length === 0) { pushLog('Nothing to save — fill in an NFT setting first.'); return; }
    await doAdmin('NFT settings saved', () => adminSetNftSettings(adminSecret, address, body));
    await loadAdminNft();
  };

  const refLink = address ? `${window.location.origin}${window.location.pathname}?ref=${address}` : '';

  return (
    <main>
      <div className="hero">
        <div className="planet">🌌</div>
        <h1>FRG Hold &amp; Earn</h1>
        <p className="tagline">Hold FRG in your own wallet. Earn {rewardSymbol}, paid automatically. No wallet connect — just paste your address.</p>
      </div>

      <div className="security" role="alert">
        🔒 <strong>Security:</strong> This app never asks you to connect your wallet or sign anything — you only paste your address. Any version that asks you to connect or sign is a fake.
      </div>

      {stats?.splitDeadlineMs ? (
        <div className="card countdown">
          {remaining !== null && remaining > 0 ? (
            <h2>⏰ Time left to get your wallet in:<span className="clock">{fmtCountdown(remaining)}</span></h2>
          ) : (
            <h2>⏰ Time&apos;s up — wallets are locked in for this split.<span className="clock done">00:00:00</span></h2>
          )}
          <p>You must get your wallet address in before the timer runs out to be in this split. Registering is one-time — miss this split and you&apos;re in the next one.</p>
          <p className="muted">Split deadline: {fmtET(stats.splitDeadlineMs)}</p>
        </div>
      ) : null}

      <div className="card">
        <h2>📋 Paste your wallet address</h2>
        <p className="muted">Paste your address once — you&apos;re registered. Pasting registers your wallet for the daily payout and shows your balance and rewards. That is the only step — nothing is ever sent from your wallet.</p>
        <input
          type="text" placeholder="terra1…" value={paste}
          onChange={(e) => setPaste(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doRegister(); }}
          autoComplete="off" spellCheck="false"
        />
        <button className="glow" disabled={regBusy || !paste.trim()} onClick={doRegister}>
          {regBusy ? 'Registering…' : '✅ Register & view my wallet'}
        </button>
        {address && (
          <p><span className="muted">Viewing: </span><span className="mono">{address}</span></p>
        )}
      </div>

      {address && (
        <div className="card">
          <h2>💰 Your holdings &amp; rewards</h2>
          <p>FRG in your wallet: <span className="big">{holdings === null ? '…' : toWhole(holdings)}</span> FRG</p>
          {rewards && (
            <>
              <p>{rewards.registered
                ? <span className="gold">✅ Registered — you are in every day&apos;s split while you hold FRG.</span>
                : <span className="warn">Not registered — paste your address above to register (one time only).</span>}</p>
              <p>Accrued: <span className="big">{toWhole(rewards.accrued)}</span> {rewardSymbol}
                {' · '}Already paid to you: {toWhole(rewards.paid)} {rewardSymbol}</p>
              <p>Carried (below the 1 {rewardSymbol} send minimum, pays out once it adds up): <span className="gold">{toWhole(rewards.claimable)}</span> {rewardSymbol}</p>
            </>
          )}
          <p className="muted">Payouts are sent automatically from the program&apos;s payout wallet when the owner runs the daily payout — you never collect, connect, or sign anything. Your FRG never leaves your wallet: no staking, no locking, no contracts.</p>
          <button className="ghost" onClick={() => refreshViews(address)}>🔄 Refresh</button>
        </div>
      )}

      <div className="card">
        <h2>📊 How much you earn</h2>
        {stats ? (
          <>
            <p>Every day, ${stats.dailyPayoutUsd} worth of FRG is split between everyone registered, by how much FRG you hold. Your share of the holdings is your share of the reward.</p>
            <p className="muted">Paste your address once — you&apos;re registered. As long as you hold FRG, you&apos;re in every day&apos;s split. Wallets registered: <strong>{stats.registered}</strong>.</p>
            <p className="muted">Keep at least {stats.minHoldingWhole} FRG in your wallet — if your balance drops below {stats.minHoldingWhole} FRG, you&apos;re removed from registration and you&apos;ll need to register again.</p>
            {stats.lastPayoutRun && (
              <p className="muted">Last payout: {stats.lastPayoutRun.day} — {stats.lastPayoutRun.totalPaidWhole} {rewardSymbol} paid to {stats.lastPayoutRun.registeredCount} registered wallet(s), status: {stats.lastPayoutRun.status}.</p>
            )}
            <p className="muted">Program totals: {toWhole(stats.totalPaid)} {rewardSymbol} paid out so far.</p>
          </>
        ) : <p className="muted">Loading program details…</p>}
      </div>

      {address && (
        <div className="card">
          <h2>🔋 Your FRG NFTs — bonus power</h2>
          {nft ? (
            <>
              <div className="battery" aria-label={`Battery ${nft.chargePct}% charged`}>
                <div className="battery-fill" style={{ width: `${nft.chargePct}%` }} />
              </div>
              <p>{nft.chargePct}% charged{nft.fullyPowered && <span className="gold"> 🔋 FULLY POWERED</span>}</p>
              <p>NFTs held: <span className="big">{nft.nftCount}</span><span className="muted"> · power: {nft.power}</span></p>
              {nft.nftTypeCounts && (
                <p className="muted">By type: {nft.nftTypeCounts.bonus} Bonus · {nft.nftTypeCounts.common} Common · {nft.nftTypeCounts.uncommon} Uncommon</p>
              )}
              {!nft.configured && <p className="warn">{nft.bonusNotice}</p>}
              {nft.configured && (
                <>
                  <p>Bonus accrued: {toWhole(nft.accrued)} FRG · Ready to collect: <span className="big gold">{toWhole(nft.claimable)}</span> FRG</p>
                  <button className="glow" disabled={collectingNft || Number(nft.claimable) === 0} onClick={doCollectNft}>
                    {collectingNft ? 'Collecting…' : '✨ Collect NFT bonus'}
                  </button>
                  <p className="muted">The NFT bonus is paid from the program&apos;s bonus pool by the server — collecting never asks you to sign anything either.</p>
                </>
              )}
            </>
          ) : <p className="muted">Loading NFT bonus…</p>}
        </div>
      )}

      {address && (
        <div className="card">
          <h2>🤝 Your referral link</h2>
          <p className="mono linkbox">{refLink}</p>
          <button className="cyan" onClick={() => {
            if (navigator.clipboard) navigator.clipboard.writeText(refLink).then(() => pushLog('Referral link copied.'));
            else pushLog(`Copy this link: ${refLink}`);
          }}>Copy link</button>
          <p>Referrals: <span className="big">{referrals ? referrals.count : '…'}</span>
            {referrals && <span className="muted"> · bonus earned from referrals: {toWhole(referrals.bonusEarned)} {rewardSymbol}</span>}</p>
          <p className="muted">Friends who paste their address after opening your link are linked to you. A referral bonus is planned — it would be paid on top, never taken from their earnings. Details are still to be confirmed.</p>
        </div>
      )}

      <div className="card">
        <h2>🌠 How it works</h2>
        <ol>
          <li>Hold FRG in your own wallet — it never moves.</li>
          <li>Paste your wallet address above once. That registers you for good — no wallet connect, no signing, ever.</li>
          <li>Keep at least {stats ? stats.minHoldingWhole : '…'} FRG in your wallet. If your balance drops below that, you&apos;re removed from registration and you&apos;ll need to paste your address again to rejoin.</li>
          <li>Every day, the day&apos;s amount is split between all registered wallets by how much FRG each one holds. Your share of the holdings is your share of the reward.</li>
          <li>The owner reviews the split and presses the payout button — then the payments are sent automatically. The pool only pays the set amount — it never empties just because a day ran.</li>
        </ol>
        <button className="ghost" onClick={loadStats}>🔄 Refresh</button>
      </div>

      {isAdmin && (
        <div className="card admin">
          <h2>🛠️ Admin panel</h2>
          <p className="muted">Shown because the pasted wallet is the admin wallet. The admin secret is typed here per session — it is never saved in the app or the browser — and every admin action is checked against it on the server.</p>
          <input type="password" placeholder="Admin secret" value={adminSecret} onChange={(e) => setAdminSecret(e.target.value)} />
          <button className="cyan" onClick={loadAdmin}>Load admin stats</button>
          {adminStats && (
            <div className="adminstats">
              <p>Holders: {adminStats.holders} · Paid out: {toWhole(adminStats.totalPaid)} {adminStats.rewardSymbol || rewardSymbol} · Accrued: {toWhole(adminStats.totalAccrued)} {adminStats.rewardSymbol || rewardSymbol}</p>
              <p>Registered wallets: {adminStats.registered} · Daily payout amount: ${adminStats.dailyPayoutUsd} total · Daily hard limit: {adminStats.dailyLimitWhole} FRG · Minimum holding: {adminStats.minHoldingWhole} FRG · Affiliate rate: {adminStats.affiliateRatePercent}%</p>
              <p>Split timer: {adminStats.splitDeadlineMs
                ? <>⏰ deadline {fmtET(adminStats.splitDeadlineMs)} ({adminStats.secondsRemaining > 0 ? `${fmtCountdown(adminStats.secondsRemaining)} left when this panel loaded` : 'time is up — the cutoff applies at the next build'})</>
                : 'not set — the page shows no clock and every registered wallet is counted.'}</p>
              <p>Payout wallet: {adminStats.payoutAddress ? <span className="mono">{adminStats.payoutAddress}</span> : 'not set yet'}
                {adminStats.payoutBalance !== null && <> · FRG balance: {toWhole(adminStats.payoutBalance)} FRG</>}
                {adminStats.payoutUstcBalance !== null && adminStats.payoutUstcBalance !== undefined && <> · USTC balance (dormant future option): {toWhole(adminStats.payoutUstcBalance)} USTC</>}
                {!adminStats.payoutCanSend && <span className="warn"> · auto-payout key not configured — the payout button will report &quot;not configured&quot; until the key is set in Railway</span>}</p>
              {(adminStats.rewardMigrations || (adminStats.rewardMigration ? [adminStats.rewardMigration] : []))
                .filter((m) => m && m.archivedRows > 0)
                .map((m) => (
                  <p key={m.id}>Currency switch {m.fromSymbol} → {m.toSymbol}: {m.archivedRows} {m.fromSymbol}-denominated accrual rows archived on {new Date(m.migratedAt).toLocaleDateString()} ({m.archivedAmountWhole} {m.fromSymbol} gross, {m.archivedUnpaidAmountWhole} {m.fromSymbol} unpaid) — archived only, not payable as {m.toSymbol}. The daily pool was reset to 0 at the switch.</p>
                ))}
              {adminStats.lastPayoutRun && (
                <p>Last payout run: {adminStats.lastPayoutRun.day} · status {adminStats.lastPayoutRun.status} · paid {adminStats.lastPayoutRun.totalPaidWhole} {rewardSymbol} · {adminStats.lastPayoutRun.registeredCount} registered</p>
              )}
            </div>
          )}

          <h2>💰 The day&apos;s two numbers + the holding rule</h2>
          <p className="muted">Two separate numbers — they are never merged. Changing any of these never changes a day that already paid.</p>
          <label className="muted" htmlFor="payout-input">Daily payout amount (USD) — the specific amount split between all registered holders that day; converted to FRG at the live price when the payout runs. 0 = nothing pays.</label>
          <input id="payout-input" type="number" min="0" step="any" placeholder="e.g. 0.50" value={payoutInput} onChange={(e) => setPayoutInput(e.target.value)} />
          <button className="cyan" onClick={() => payoutInput !== '' && doAdmin('Daily payout amount set', () => adminSetPayoutAmount(adminSecret, address, Number(payoutInput)))}>Set daily payout amount</button>

          <label className="muted" htmlFor="limit-input">Daily hard limit (FRG) — never pays more than this. An absolute ceiling only, not the amount and not a target.</label>
          <input id="limit-input" type="number" min="0" step="any" placeholder="e.g. 2000" value={limitInput} onChange={(e) => setLimitInput(e.target.value)} />
          <button className="cyan" onClick={() => limitInput !== '' && doAdmin('Daily hard limit set', () => adminSetLimit(adminSecret, address, limitInput))}>Set daily hard limit</button>

          <label className="muted" htmlFor="minholding-input">Minimum holding (FRG) — a registered wallet below this at a payout build is REMOVED from registration (it rejoins only by pasting again). ⚠️ The shipped 100 FRG is a PLACEHOLDER — set your real number here.</label>
          <input id="minholding-input" type="number" min="0" step="any" placeholder="e.g. 100" value={minHoldingInput} onChange={(e) => setMinHoldingInput(e.target.value)} />
          <button className="cyan" onClick={() => minHoldingInput !== '' && doAdmin('Minimum holding set', () => adminSetMinHolding(adminSecret, address, minHoldingInput))}>Set minimum holding</button>

          <label className="muted" htmlFor="rate-input">Affiliate rate (%) — proposed default, pending confirmation</label>
          <input id="rate-input" type="number" min="0" max="100" step="any" placeholder="e.g. 10" value={rateInput} onChange={(e) => setRateInput(e.target.value)} />
          <button className="cyan" onClick={() => rateInput && doAdmin('Affiliate rate set', () => adminSetRate(adminSecret, address, rateInput))}>Set affiliate rate</button>

          <h2>⏰ Split countdown timer</h2>
          <p className="muted">Start the timer when you announce — holders then have until the deadline to get their wallet in. A payout build counts only wallets registered at or before the deadline; later ones stay registered and are in the next split. No timer = every registered wallet counts, as before.</p>
          <button className="cyan" onClick={async () => { await doAdmin('24-hour timer started — the deadline is now + 24 hours', () => adminTimerStart(adminSecret, address)); await loadAdmin(); await loadStats(); }}>▶ Start 24-hour timer</button>
          <label className="muted" htmlFor="deadline-input">…or set an exact deadline</label>
          <input id="deadline-input" type="datetime-local" value={deadlineInput} onChange={(e) => setDeadlineInput(e.target.value)} />
          <button className="cyan" onClick={async () => {
            const d = new Date(deadlineInput);
            if (!deadlineInput || Number.isNaN(d.getTime())) { pushLog('Pick a deadline date and time first.'); return; }
            await doAdmin(`Split deadline set to ${d.toLocaleString()}`, () => adminTimerSet(adminSecret, address, d.toISOString()));
            await loadAdmin(); await loadStats();
          }}>Set exact deadline</button>
          <button className="ghost" onClick={async () => { await doAdmin('Split timer cleared — no deadline in effect', () => adminTimerClear(adminSecret, address)); await loadAdmin(); await loadStats(); }}>⏹ Stop / clear timer</button>

          <h2>💸 Daily payout</h2>
          <p className="muted">Review the table first — nothing sends until you press the payout button. The table shows every registered wallet, what it holds, its share, and what it will be paid. Loading the preview also applies the minimum-holding rule: wallets below {preview?.minHoldingWhole ?? '…'} FRG are removed from registration and listed under the table.</p>
          <button className="cyan" disabled={previewBusy} onClick={loadPreview}>{previewBusy ? 'Loading…' : '👁 Load payout preview'}</button>
          {preview && (
            <div className="adminstats">
              <p>Registered: <strong>{preview.registeredCount}</strong> · Pot: {preview.potWhole} {rewardSymbol} (daily payout amount ${preview.dailyPayoutUsd} at {preview.priceFrgUsd ? `$${preview.priceFrgUsd}` : 'live price'} per FRG · hard limit {preview.limitWhole} {rewardSymbol})
                {' · '}Pool balance: {preview.poolBalanceWhole} {rewardSymbol} · Pool keeps after payout: {preview.poolRemainderWhole} {rewardSymbol}</p>
              {preview.splitDeadlineMs ? (
                <p>⏰ Timer cutoff used: wallets registered by <strong>{fmtET(preview.splitDeadlineMs)}</strong> — <strong>{preview.registeredBeforeCutoff}</strong> in before it · <strong>{preview.registeredAfterCutoff}</strong> after it (they stay registered and wait for the next split).
                  {preview.lateRegistrations?.length > 0 && <> After the cutoff: {preview.lateRegistrations.map((w) => shortAddr(w)).join(', ')}</>}</p>
              ) : (
                <p className="muted">No split timer set — this preview counted every registered wallet.</p>
              )}
              <table className="payout">
                <thead><tr><th>Wallet</th><th>Holds</th><th>Share</th><th>Will be paid</th></tr></thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.wallet}>
                      <td className="addr">{shortAddr(r.wallet)}</td>
                      <td>{r.balanceWhole}</td>
                      <td>{r.sharePct}%</td>
                      <td>{r.amountWhole}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.deregistered?.length > 0 && (
                <p className="warn">Removed from registration at this build (below the {preview.minHoldingWhole} FRG minimum): {preview.deregistered.map((d) => `${shortAddr(d.wallet)} (${d.balanceWhole} FRG)`).join(', ')}</p>
              )}
            </div>
          )}
          <button className="glow" disabled={payoutBusy} onClick={pressPayout}>
            {payoutBusy ? 'Paying…' : '💸 PRESS TO PAY OUT'}
          </button>
          {lastRun && (
            <div className="adminstats">
              <p>Run {lastRun.day}: <strong>{lastRun.status}</strong> · paid {lastRun.totalPaidWhole} {rewardSymbol} · split {lastRun.totalSplitWhole} {rewardSymbol}
                {Number(lastRun.shortfall) > 0 && <> · shortfall {toWhole(lastRun.shortfall)} {rewardSymbol} (stays owed)</>}
                {' · '}{lastRun.registeredCount} registered</p>
              {lastRun.detail?.deregistered?.length > 0 && (
                <p className="warn">Removed from registration at this run (below the minimum holding): {lastRun.detail.deregistered.map((d) => shortAddr(d.wallet)).join(', ')}</p>
              )}
              {lastRun.detail?.splitDeadlineMs && (
                <p className="muted">⏰ This run used the timer cutoff {fmtET(lastRun.detail.splitDeadlineMs)} — {lastRun.detail.registeredAfterCutoff ?? 0} wallet(s) registered after it and waited for the next split.</p>
              )}
              {lastRun.detail?.rows?.map((r) => (
                <p key={r.wallet} className="mono">{shortAddr(r.wallet)}: share {toWhole(r.amount)} → sent {toWhole(r.sent)} ({r.payStatus}){r.txhash && <> · <a href={`${FINDER}/tx/${r.txhash}`} target="_blank" rel="noreferrer">tx</a></>}</p>
              ))}
            </div>
          )}
          <button className="ghost" onClick={() => doAdmin('NFT snapshot run', () => adminSnapshot(adminSecret, address))}>📸 Run NFT snapshot now</button>

          <h2>🔋 NFT settings</h2>
          <p className="muted">All NFT numbers are adjustable here — nothing is hardcoded. Leave a field blank to leave that setting unchanged. Invalid numbers are rejected with a visible error.</p>
          <button className="cyan" onClick={loadAdminNft}>Load NFT admin stats</button>
          {adminNft && (
            <div className="adminstats">
              <p>Collection: {adminNft.collection ? <span className="mono">{adminNft.collection}</span> : 'not configured'}</p>
              <p>Bonus collections: {(adminNft.collections || []).length
                ? adminNft.collections.map((c) => <span key={c} className="mono">{c}<br /></span>)
                : 'none connected — NFT bonus counts read as zero'}</p>
              <p>Excluded wallets: {(adminNft.excludedWallets || []).length
                ? adminNft.excludedWallets.map((c) => <span key={c} className="mono">{c}<br /></span>)
                : 'none'}</p>
              <p>Bonus rates: Bonus {adminNft.bonusRatesWhole.bonus} · Common {adminNft.bonusRatesWhole.common} · Uncommon {adminNft.bonusRatesWhole.uncommon} FRG per NFT per day</p>
              <p>Mint: {adminNft.mintCostWhole} FRG · Threshold: {adminNft.threshold} · Supply cap: {adminNft.supplyCap || 'unlimited'}</p>
              <p>Bonus pool wallet: {adminNft.bonusPoolWallet ? <span className="mono">{adminNft.bonusPoolWallet}</span> : 'not set'} · funded {adminNft.bonusPoolFundedWhole} FRG · available {adminNft.bonusPoolAvailableWhole} FRG</p>
            </div>
          )}
          <label className="muted">Bonus collections (one per line or comma-separated)</label>
          <textarea rows="2" value={nftCollectionsInput} onChange={(e) => setNftCollectionsInput(e.target.value)} />
          <label className="muted">Excluded wallets (no NFT bonus; one per line)</label>
          <textarea rows="2" value={nftExcludedInput} onChange={(e) => setNftExcludedInput(e.target.value)} />
          <label className="muted">Mint cost (FRG)</label>
          <input type="number" min="0" step="any" value={nftMintInput} onChange={(e) => setNftMintInput(e.target.value)} />
          <label className="muted">Bonus rate — Bonus type (FRG per NFT per day)</label>
          <input type="number" min="0" step="any" value={nftRateBonusInput} onChange={(e) => setNftRateBonusInput(e.target.value)} />
          <label className="muted">Bonus rate — Common type (FRG per NFT per day)</label>
          <input type="number" min="0" step="any" value={nftRateCommonInput} onChange={(e) => setNftRateCommonInput(e.target.value)} />
          <label className="muted">Bonus rate — Uncommon type (FRG per NFT per day)</label>
          <input type="number" min="0" step="any" value={nftRateUncommonInput} onChange={(e) => setNftRateUncommonInput(e.target.value)} />
          <label className="muted">Fully-powered threshold (NFT count)</label>
          <input type="number" min="0" step="1" value={nftThresholdInput} onChange={(e) => setNftThresholdInput(e.target.value)} />
          <label className="muted">Supply cap (0 = unlimited)</label>
          <input type="number" min="0" step="1" value={nftCapInput} onChange={(e) => setNftCapInput(e.target.value)} />
          <label className="muted">Bonus pool wallet</label>
          <input type="text" value={nftPoolWalletInput} onChange={(e) => setNftPoolWalletInput(e.target.value)} />
          <button className="cyan" onClick={saveNftSettings}>Save NFT settings</button>
          <label className="muted">Record bonus pool funding (FRG — real mint-fee proceeds only)</label>
          <input type="number" min="0" step="any" value={nftFundInput} onChange={(e) => setNftFundInput(e.target.value)} />
          <input type="text" placeholder="Note (e.g. mint tx hash)" value={nftFundNoteInput} onChange={(e) => setNftFundNoteInput(e.target.value)} />
          <button className="cyan" onClick={() => nftFundInput && doAdmin('Funding recorded', () => adminFundBonusPool(adminSecret, address, nftFundInput, nftFundNoteInput))}>Record funding</button>
        </div>
      )}

      {log && (
        <div className="card log">
          <pre>{log}</pre>
        </div>
      )}
    </main>
  );
}
