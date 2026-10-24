import { useCallback, useEffect, useRef, useState } from 'react';
import { useChain } from '@cosmos-kit/react';
import { CHAIN_NAME, ADMIN_ADDRESS, FINDER, toWhole, shortAddr } from './config.js';
import {
  fetchHoldings, getStats, getRewards, getReferrals, register, collect,
  getAdmin, adminSetPool, adminSetRate, adminSnapshot,
} from './lib/api.js';

export default function App() {
  const chain = useChain(CHAIN_NAME);
  const connected = chain.status === 'Connected' && chain.address;
  const address = chain.address || '';
  // Admin gate follows the BACKEND's admin wallet (from /api/stats),
  // falling back to the baked-in constant only before stats load — so
  // the admin wallet can change by server env alone, no app rebuild.
  const [stats, setStats] = useState(null);
  const isAdmin = connected && address === (stats?.adminWallet || ADMIN_ADDRESS);

  const [holdings, setHoldings] = useState(null);
  const [rewards, setRewards] = useState(null);
  const [referrals, setReferrals] = useState(null);
  const [log, setLog] = useState('');
  const [collecting, setCollecting] = useState(false);
  const [refLink, setRefLink] = useState('');
  const [registered, setRegistered] = useState(null);
  const [adminSecret, setAdminSecret] = useState('');
  const [adminStats, setAdminStats] = useState(null);
  const [poolInput, setPoolInput] = useState('');
  const [rateInput, setRateInput] = useState('');
  const autoRegDone = useRef('');

  const pushLog = useCallback((m) => setLog((prev) => (prev ? `${prev}\n${m}` : m)), []);

  const refresh = useCallback(async () => {
    if (!connected) return;
    // allSettled, not all: one stalled/failed lookup must never wipe the
    // other three or leave the page stuck — each result lands on its own,
    // and each failure logs visibly instead of hanging refresh.
    const [h, r, rf, s] = await Promise.allSettled([
      fetchHoldings(address), getRewards(address), getReferrals(address), getStats(),
    ]);
    if (h.status === 'fulfilled') setHoldings(h.value);
    else pushLog(`Balance lookup failed: ${h.reason?.message || h.reason}`);
    if (r.status === 'fulfilled') setRewards(r.value);
    else pushLog(`Rewards lookup failed: ${r.reason?.message || r.reason}`);
    if (rf.status === 'fulfilled') setReferrals(rf.value);
    else pushLog(`Referrals lookup failed: ${rf.reason?.message || rf.reason}`);
    if (s.status === 'fulfilled') setStats(s.value);
    else pushLog(`Stats lookup failed: ${s.reason?.message || s.reason}`);
    setRefLink(`${window.location.origin}${window.location.pathname}?ref=${address}`);
  }, [connected, address, pushLog]);

  // Auto-register on first connect when arriving via a referral link.
  // First-touch wins server-side: an existing binding never changes.
  useEffect(() => {
    if (!connected || autoRegDone.current === address) return;
    autoRegDone.current = address;
    const ref = new URLSearchParams(window.location.search).get('ref') || '';
    register(address, ref && ref !== address ? ref : null)
      .then((r) => {
        setRegistered(r);
        if (r.created && r.referrer) pushLog(`Registered — your referrer is ${shortAddr(r.referrer)}.`);
      })
      .catch((e) => pushLog(`Registration failed: ${e.message}`));
    refresh();
  }, [connected, address, refresh, pushLog]);

  const doCollect = async () => {
    setCollecting(true);
    try {
      const out = await collect(address);
      pushLog(`✅ Collected ${out.paidWhole} FRG — ${FINDER}/tx/${out.txhash}`);
      await refresh();
    } catch (e) {
      pushLog(`Collect failed: ${e.message}`);
    } finally {
      setCollecting(false);
    }
  };

  const doAdmin = async (label, fn) => {
    try {
      const out = await fn();
      setAdminStats(out);
      pushLog(`${label} ✅`);
      await refresh();
    } catch (e) {
      pushLog(`${label} failed: ${e.message}`);
    }
  };

  const loadAdmin = async () => {
    if (!adminSecret) { pushLog('Enter the admin secret first.'); return; }
    await doAdmin('Admin stats', () => getAdmin(adminSecret, address));
  };

  return (
    <main>
      <div className="hero">
        <div className="planet">🌌</div>
        <h1>FRG Hold &amp; Earn</h1>
        <p className="tagline">Hold FRG in your own wallet. Earn rewards. Nothing ever leaves your wallet.</p>
      </div>

      <div className="card">
        {connected ? (
          <>
            <p><span className="muted">Connected: </span><span className="mono">{address}</span></p>
            <button className="ghost" onClick={() => chain.disconnect()}>Disconnect</button>
          </>
        ) : (
          <button className="glow" onClick={() => chain.connect()}>🌌 Connect wallet</button>
        )}
        <p className="muted">{connected
          ? 'Wallet connected — pick a wallet in the modal to switch.'
          : 'Connect with Keplr, Station, or Galaxy Station. On your phone, pick a WalletConnect wallet and approve in the wallet app.'}</p>
      </div>

      <div className="card">
        <h2>💰 Your holdings</h2>
        <p>FRG in your wallet: <span className="big">{connected ? (holdings === null ? '…' : `${toWhole(holdings)}`) : '—'}</span> FRG</p>
        {connected && holdings !== null && Number(holdings) === 0 && (
          <p className="muted">No FRG in this wallet yet — rewards build up from daily snapshots of your FRG balance, so holding is what earns.</p>
        )}
        <p className="muted">Your FRG never leaves your wallet. No staking, no locking, no contracts.</p>
      </div>

      <div className="card">
        <h2>🎁 Your rewards</h2>
        <p>Accrued: <span className="big">{connected && rewards ? toWhole(rewards.accrued) : '—'}</span> FRG</p>
        <p>Already collected: <span>{connected && rewards ? toWhole(rewards.paid) : '—'}</span> FRG</p>
        <p>Ready to collect: <span className="big gold">{connected && rewards ? toWhole(rewards.claimable) : '—'}</span> FRG</p>
        {connected && rewards && Number(rewards.claimable) === 0 && (
          <p className="muted">No rewards accrued yet — they build up from daily snapshots of your holdings. Come back after a snapshot day.</p>
        )}
        <button className="glow" disabled={!connected || collecting} onClick={doCollect}>
          {collecting ? 'Collecting…' : '✨ Collect rewards'}
        </button>
        <p className="muted">Collect sends FRG from the program&apos;s payout wallet straight to your wallet. No amount is ever promised — what you see is what the snapshots earned.</p>
      </div>

      <div className="card">
        <h2>🤝 Your referral link</h2>
        {connected ? (
          <>
            <p className="mono linkbox">{refLink}</p>
            <button className="cyan" onClick={() => {
              if (navigator.clipboard) navigator.clipboard.writeText(refLink).then(() => pushLog('Referral link copied.'));
              else pushLog(`Copy this link: ${refLink}`);
            }}>Copy link</button>
            <p>Referrals: <span className="big">{referrals ? referrals.count : '…'}</span>
              {referrals && <span className="muted"> · bonus earned from referrals: {toWhole(referrals.bonusEarned)} FRG</span>}</p>
            <p className="muted">Friends who connect through your link are linked to you. A referral bonus is planned — it would be paid from the reward pot, never taken from their share. Affiliate details are still to be confirmed: the rate shown ({stats ? `${stats.affiliateRatePercent}%` : '…'}) is a proposed default, not final.</p>
          </>
        ) : (
          <p className="muted">Connect your wallet to get your referral link.</p>
        )}
      </div>

      <div className="card">
        <h2>🌠 How it works</h2>
        <ol>
          <li>Hold FRG in your own wallet — it never moves.</li>
          <li>Each day, the program snapshots every registered wallet&apos;s FRG balance.</li>
          <li>That day&apos;s reward pool splits pro-rata across the snapshot balances.</li>
          <li>Come here any time and Collect — rewards arrive from the payout wallet.</li>
          <li>Share your referral link: a referral bonus is planned (details to be confirmed) — it would come from the same pot, never from your referrals&apos; share.</li>
        </ol>
        {stats && (
          <p className="muted">Program totals: {stats.holders} holders · {toWhole(stats.totalPaid)} FRG paid out · daily pool {toWhole(stats.dailyPool)} FRG · {stats.snapshotDays.length} snapshot days so far.</p>
        )}
        <button className="ghost" onClick={refresh}>🔄 Refresh</button>
      </div>

      {isAdmin && (
        <div className="card admin">
          <h2>🛠️ Admin panel</h2>
          <p className="muted">Only visible to the admin wallet. The admin secret is typed here per session — it is never saved in the app or the browser.</p>
          <input type="password" placeholder="Admin secret" value={adminSecret} onChange={(e) => setAdminSecret(e.target.value)} />
          <button className="cyan" onClick={loadAdmin}>Load admin stats</button>
          {adminStats && (
            <div className="adminstats">
              <p>Holders: {adminStats.holders} · Paid out: {toWhole(adminStats.totalPaid)} FRG · Accrued: {toWhole(adminStats.totalAccrued)} FRG</p>
              <p>Daily pool: {toWhole(adminStats.dailyPool)} FRG · Affiliate rate: {adminStats.affiliateRatePercent}%</p>
              <p>Payout wallet: {adminStats.payoutAddress ? <span className="mono">{adminStats.payoutAddress}</span> : 'not set yet'}
                {adminStats.payoutBalance !== null && <> · balance: {toWhole(adminStats.payoutBalance)} FRG</>}
                {!adminStats.payoutCanSend && <span className="warn"> · auto-payout key not configured — collects will report &quot;not configured&quot; until the key is set in Railway</span>}</p>
              <p>Snapshot days: {adminStats.snapshotDays.length ? adminStats.snapshotDays.join(', ') : 'none yet'}</p>
            </div>
          )}
          <label className="muted" htmlFor="pool-input">Daily reward pool (FRG)</label>
          <input id="pool-input" type="number" min="0" step="any" placeholder="e.g. 1000" value={poolInput} onChange={(e) => setPoolInput(e.target.value)} />
          <button className="cyan" onClick={() => poolInput && doAdmin('Daily pool set', () => adminSetPool(adminSecret, address, poolInput))}>Set daily pool</button>
          <label className="muted" htmlFor="rate-input">Affiliate rate (%) — proposed default, pending confirmation</label>
          <input id="rate-input" type="number" min="0" max="100" step="any" placeholder="e.g. 10" value={rateInput} onChange={(e) => setRateInput(e.target.value)} />
          <button className="cyan" onClick={() => rateInput && doAdmin('Affiliate rate set', () => adminSetRate(adminSecret, address, rateInput))}>Set affiliate rate</button>
          <button className="glow" onClick={() => doAdmin('Snapshot run', () => adminSnapshot(adminSecret, address))}>📸 Run snapshot now</button>
        </div>
      )}

      {log && <div className="card log"><pre>{log}</pre></div>}
    </main>
  );
}
