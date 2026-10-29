import { useCallback, useEffect, useRef, useState } from 'react';
import { useChain } from '@cosmos-kit/react';
import { CHAIN_NAME, ADMIN_ADDRESS, FINDER, FRG, toWhole, shortAddr } from './config.js';
import {
  fetchHoldings, getStats, getRewards, getReferrals, register, collect,
  getAdmin, adminSetPool, adminSetRate, adminSnapshot,
  getNft, collectNftBonus, recordMint,
  getAdminNft, adminSetNftSettings, adminFundBonusPool,
  fetchNftContractConfig, fetchNftNumTokens,
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
  const [nft, setNft] = useState(null);
  const [collectingNft, setCollectingNft] = useState(false);
  const [minting, setMinting] = useState(false);
  const [log, setLog] = useState('');
  const [collecting, setCollecting] = useState(false);
  const [refLink, setRefLink] = useState('');
  const [registered, setRegistered] = useState(null);
  const [adminSecret, setAdminSecret] = useState('');
  const [adminStats, setAdminStats] = useState(null);
  const [adminNft, setAdminNft] = useState(null);
  const [poolInput, setPoolInput] = useState('');
  const [rateInput, setRateInput] = useState('');
  const [nftCollectionInput, setNftCollectionInput] = useState('');
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
  const autoRegDone = useRef('');

  const pushLog = useCallback((m) => setLog((prev) => (prev ? `${prev}\n${m}` : m)), []);

  const refresh = useCallback(async () => {
    if (!connected) return;
    // allSettled, not all: one stalled/failed lookup must never wipe the
    // others or leave the page stuck — each result lands on its own,
    // and each failure logs visibly instead of hanging refresh.
    const [h, r, rf, s, n] = await Promise.allSettled([
      fetchHoldings(address), getRewards(address), getReferrals(address), getStats(), getNft(address),
    ]);
    if (h.status === 'fulfilled') setHoldings(h.value);
    else pushLog(`Balance lookup failed: ${h.reason?.message || h.reason}`);
    if (r.status === 'fulfilled') setRewards(r.value);
    else pushLog(`Rewards lookup failed: ${r.reason?.message || r.reason}`);
    if (rf.status === 'fulfilled') setReferrals(rf.value);
    else pushLog(`Referrals lookup failed: ${rf.reason?.message || rf.reason}`);
    if (s.status === 'fulfilled') setStats(s.value);
    else pushLog(`Stats lookup failed: ${s.reason?.message || s.reason}`);
    if (n.status === 'fulfilled') setNft(n.value);
    else pushLog(`NFT lookup failed: ${n.reason?.message || n.reason}`);
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
      pushLog(`✅ Collected ${out.paidWhole} USTC — ${FINDER}/tx/${out.txhash}`);
      await refresh();
    } catch (e) {
      pushLog(`Collect failed: ${e.message}`);
    } finally {
      setCollecting(false);
    }
  };

  const doCollectNft = async () => {
    setCollectingNft(true);
    try {
      const out = await collectNftBonus(address);
      pushLog(`✅ Collected ${out.paidWhole} FRG NFT bonus — ${FINDER}/tx/${out.txhash}`);
      await refresh();
    } catch (e) {
      pushLog(`NFT bonus collect failed: ${e.message}`);
    } finally {
      setCollectingNft(false);
    }
  };

  // Real mint, signed by the connected wallet — no simulated mint
  // anywhere in this app. Steps, all verified before/after signing:
  // 1. The app reads the collection contract on-chain and refuses to
  //    sign unless it matches the app settings: same FRG fee token,
  //    same mint price, fee recipient = bonus pool wallet, not sold out.
  // 2. The wallet signs a CW20 send of the mint fee to the collection
  //    with a {mint:{}} message. The contract mints to the sender and
  //    forwards the fee to the bonus pool wallet.
  // 3. The app reports ONLY the txhash to the backend, which verifies
  //    the fee transfer on-chain before crediting the tracked bonus
  //    pool. If verification fails, the mint itself still happened —
  //    the log says so honestly instead of claiming a credit.
  const doMint = async () => {
    if (!nft?.mintReady) { pushLog('Minting is not ready — see the NFT section.'); return; }
    setMinting(true);
    try {
      const cfg = await fetchNftContractConfig(nft.collection);
      const num = await fetchNftNumTokens(nft.collection);
      if (cfg.frg_token !== FRG.address) throw new Error('Collection is not an FRG-fee collection — mint blocked.');
      if (String(cfg.mint_cost) !== String(nft.mintCost)) throw new Error(`Collection mint price (${cfg.mint_cost}) does not match the app setting (${nft.mintCost}) — mint blocked. Ask the admin to sync them.`);
      if ((cfg.fee_recipient || '') !== nft.bonusPoolWallet) throw new Error('Collection fee recipient is not the bonus pool wallet — mint blocked. Ask the admin to sync them.');
      const cap = nft.supplyCap > 0 ? nft.supplyCap : (cfg.max_supply ?? null);
      if (cap !== null && num >= cap) throw new Error('Sold out — no more NFTs to mint.');
      const client = await chain.getSigningCosmWasmClient();
      const res = await client.execute(address, FRG.address,
        { send: { contract: nft.collection, amount: nft.mintCost, msg: btoa(JSON.stringify({ mint: {} })) } },
        'auto');
      pushLog(`✅ Minted — ${FINDER}/tx/${res.transactionHash}`);
      try {
        const rec = await recordMint(address, res.transactionHash);
        pushLog(rec.alreadyRecorded
          ? 'Bonus pool already credited for this mint.'
          : `Bonus pool credited +${toWhole(rec.credited)} FRG from your mint fee.`);
      } catch (e) {
        pushLog(`Mint is on-chain, but the bonus pool credit could not be verified yet: ${e.message} — ask the admin to record it.`);
      }
      await refresh();
    } catch (e) {
      pushLog(`Mint failed: ${e.message}`);
    } finally {
      setMinting(false);
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

  const loadAdminNft = async () => {
    if (!adminSecret) { pushLog('Enter the admin secret first.'); return; }
    try {
      const out = await getAdminNft(adminSecret, address);
      setAdminNft(out);
      setNftCollectionsInput((out.collections || []).join('\n'));
      setNftExcludedInput((out.excludedWallets || []).join('\n'));
      pushLog('NFT admin stats ✅');
    } catch (e) {
      pushLog(`NFT admin stats failed: ${e.message}`);
    }
  };

  // Bonus collections are saved as a complete list (one address per
  // line): whatever is in the box REPLACES the list, so an empty box
  // deliberately disconnects all bonus collections. This is separate
  // from the blank-means-unchanged fields above.
  const saveBonusCollections = async () => {
    const list = nftCollectionsInput.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    await doAdmin('Bonus collections saved', () => adminSetNftSettings(adminSecret, address, { collections: list }));
    await loadAdminNft();
  };

  // Excluded wallets are saved the same way: the box REPLACES the
  // whole list, so an empty box clears all exclusions. Excluded
  // wallets record an NFT count of 0 and never accrue NFT bonus;
  // their base hold-and-earn rewards are unaffected.
  const saveExcludedWallets = async () => {
    const list = nftExcludedInput.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    await doAdmin('Excluded wallets saved', () => adminSetNftSettings(adminSecret, address, { excludedWallets: list }));
    await loadAdminNft();
  };

  // Save only fields the admin actually typed — a blank field leaves
  // that setting unchanged. Clearing the collection has its own button
  // below, since blank means "unchanged" here, not "clear".
  const saveNftSettings = async () => {
    const body = {};
    if (nftCollectionInput.trim() !== '') body.collection = nftCollectionInput.trim();
    if (nftMintInput !== '') body.mintCostWhole = nftMintInput;
    if (nftRateBonusInput !== '') body.bonusRateBonusWhole = nftRateBonusInput;
    if (nftRateCommonInput !== '') body.bonusRateCommonWhole = nftRateCommonInput;
    if (nftRateUncommonInput !== '') body.bonusRateUncommonWhole = nftRateUncommonInput;
    if (nftThresholdInput !== '') body.threshold = nftThresholdInput;
    if (nftCapInput !== '') body.supplyCap = nftCapInput;
    if (nftPoolWalletInput.trim() !== '') body.bonusPoolWallet = nftPoolWalletInput.trim();
    if (Object.keys(body).length === 0) { pushLog('Nothing to save — fill in an NFT setting first.'); return; }
    await doAdmin('NFT settings saved', () => adminSetNftSettings(adminSecret, address, body));
    await loadAdminNft();
  };

  return (
    <main>
      <div className="hero">
        <div className="planet">🌌</div>
        <h1>FRG Hold &amp; Earn</h1>
        <p className="tagline">Hold FRG in your own wallet. Earn USTC. Nothing ever leaves your wallet.</p>
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
        <p>Accrued: <span className="big">{connected && rewards ? toWhole(rewards.accrued) : '—'}</span> USTC</p>
        <p>Already collected: <span>{connected && rewards ? toWhole(rewards.paid) : '—'}</span> USTC</p>
        <p>Ready to collect: <span className="big gold">{connected && rewards ? toWhole(rewards.claimable) : '—'}</span> USTC</p>
        {connected && rewards && Number(rewards.claimable) === 0 && (
          <p className="muted">No rewards accrued yet — they build up from daily snapshots of your holdings. Come back after a snapshot day.</p>
        )}
        <button className="glow" disabled={!connected || collecting} onClick={doCollect}>
          {collecting ? 'Collecting…' : '✨ Collect rewards'}
        </button>
        <p className="muted">Collect sends USTC from the program&apos;s payout wallet straight to your wallet. No amount is ever promised — what you see is what the snapshots earned.</p>
      </div>

      <div className="card">
        <h2>🔋 Your FRG NFTs — bonus power</h2>
        {connected ? (
          <>
            <div className="battery" aria-label={`Battery ${nft ? nft.chargePct : 0}% charged`}>
              <div className="battery-fill" style={{ width: `${nft ? nft.chargePct : 0}%` }} />
            </div>
            <p>{nft ? `${nft.chargePct}% charged` : '…'}
              {nft?.fullyPowered && <span className="gold"> 🔋 FULLY POWERED</span>}</p>
            <p>NFTs held: <span className="big">{nft ? nft.nftCount : '…'}</span>
              <span className="muted"> · power: {nft ? nft.power : '…'}</span></p>
            <p className="muted">All your NFTs roll into one calculation — that number is your power.
              {nft && (nft.thresholdSet
                ? ` At ${nft.threshold} NFTs the battery shows fully powered.`
                : ' The admin has not set the fully-powered threshold yet.')}</p>
            {nft && !nft.configured && (
              <p className="warn">{nft.bonusNotice || 'No NFT bonus collections are connected yet — bonus holdings read as zero.'} Minting is not open yet.</p>
            )}
            {nft?.configured && !nft.bonusRateSet && (
              <p className="warn">{nft.bonusNotice}</p>
            )}
            {nft?.configured && (
              <>
                <p>Bonus accrued: {toWhole(nft.accrued)} FRG · Ready to collect: <span className="big gold">{toWhole(nft.claimable)}</span> FRG</p>
                {nft.nftTypeCounts && (
                  <p className="muted">Your NFTs by type: {nft.nftTypeCounts.bonus} Bonus · {nft.nftTypeCounts.common} Common · {nft.nftTypeCounts.uncommon} Uncommon</p>
                )}
                <p className="muted">Bonus rates: {nft.bonusRateSet && nft.bonusRates ? `Bonus ${toWhole(nft.bonusRates.bonus)} · Common ${toWhole(nft.bonusRates.common)} · Uncommon ${toWhole(nft.bonusRates.uncommon)} FRG per NFT per snapshot day` : 'not set yet — no NFT bonus accrues'}
                  · Mint price: {toWhole(nft.mintCost)} FRG
                  · Bonus pool available: {toWhole(nft.bonusPoolAvailable)} FRG</p>
                {nft.lastSnapshotDay === null && (
                  <p className="muted">No NFT snapshot yet for this wallet — counts update on the next snapshot day.</p>
                )}
                <button className="glow" disabled={collectingNft || Number(nft.claimable) === 0} onClick={doCollectNft}>
                  {collectingNft ? 'Collecting…' : '✨ Collect NFT bonus'}
                </button>
                <button className="glow" disabled={!nft.mintReady || minting} onClick={doMint}>
                  {minting ? 'Minting…' : '🔋 Mint NFT'}
                </button>
                <p className="muted">{nft.mintNotice} Minting sends the mint fee in FRG from your wallet to the collection — the contract forwards it to the bonus pool wallet. Your wallet signs the mint; nothing is minted without your approval.</p>
              </>
            )}
          </>
        ) : (
          <p className="muted">Connect your wallet to see your NFT bonus power.</p>
        )}
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
              {referrals && <span className="muted"> · bonus earned from referrals: {toWhole(referrals.bonusEarned)} USTC</span>}</p>
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
          <li>That day&apos;s USTC reward pool splits pro-rata across the FRG snapshot balances.</li>
          <li>Come here any time and Collect — USTC rewards arrive from the payout wallet.</li>
          <li>Share your referral link: a referral bonus is planned (details to be confirmed) — it would come from the same pot, never from your referrals&apos; share.</li>
        </ol>
        {stats && (
          <p className="muted">Program totals: {stats.holders} holders · {toWhole(stats.totalPaid)} USTC paid out · daily pool {toWhole(stats.dailyPool)} USTC · {stats.snapshotDays.length} snapshot days so far.</p>
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
              <p>Holders: {adminStats.holders} · Paid out: {toWhole(adminStats.totalPaid)} USTC · Accrued: {toWhole(adminStats.totalAccrued)} USTC</p>
              <p>Daily pool: {toWhole(adminStats.dailyPool)} USTC · Affiliate rate: {adminStats.affiliateRatePercent}%</p>
              <p>Payout wallet: {adminStats.payoutAddress ? <span className="mono">{adminStats.payoutAddress}</span> : 'not set yet'}
                {adminStats.payoutUstcBalance !== null && adminStats.payoutUstcBalance !== undefined && <> · USTC balance: {toWhole(adminStats.payoutUstcBalance)} USTC</>}
                {adminStats.payoutBalance !== null && <> · FRG balance: {toWhole(adminStats.payoutBalance)} FRG</>}
                {!adminStats.payoutCanSend && <span className="warn"> · auto-payout key not configured — collects will report &quot;not configured&quot; until the key is set in Railway</span>}</p>
              {adminStats.rewardMigration && adminStats.rewardMigration.archivedRows > 0 && (
                <p>Legacy conversion: {adminStats.rewardMigration.archivedRows} FRG-denominated accrual rows archived on {new Date(adminStats.rewardMigration.migratedAt).toLocaleDateString()} ({adminStats.rewardMigration.archivedAmountWhole} FRG gross, {adminStats.rewardMigration.archivedUnpaidAmountWhole} FRG unpaid) — archived only, not payable as USTC. The legacy daily pool was reset to 0.</p>
              )}
              <p>Snapshot days: {adminStats.snapshotDays.length ? adminStats.snapshotDays.join(', ') : 'none yet'}</p>
              {adminStats.nft && (
                <p>NFT: collection {adminStats.nft.collection || 'not configured'}
                  {' · '}bonus collections {(adminStats.nft.collections || []).length} connected
                  {adminStats.nft.bonusRateSet ? '' : ' (rate not set yet)'}
                  {' · '}mint {adminStats.nft.mintCostWhole} FRG
                  {adminStats.nft.bonusRatesWhole && <>{' · '}bonus rates B {adminStats.nft.bonusRatesWhole.bonus} / C {adminStats.nft.bonusRatesWhole.common} / U {adminStats.nft.bonusRatesWhole.uncommon} FRG/day</>}
                  {' · '}threshold {adminStats.nft.threshold}
                  {' · '}cap {adminStats.nft.supplyCap || 'unlimited'}
                  {' · '}bonus pool available {adminStats.nft.bonusPoolAvailableWhole} FRG</p>
              )}
            </div>
          )}
          <label className="muted" htmlFor="pool-input">Daily reward pool (USTC)</label>
          <input id="pool-input" type="number" min="0" step="any" placeholder="e.g. 1000" value={poolInput} onChange={(e) => setPoolInput(e.target.value)} />
          <button className="cyan" onClick={() => poolInput && doAdmin('Daily pool set', () => adminSetPool(adminSecret, address, poolInput))}>Set daily pool</button>
          <label className="muted" htmlFor="rate-input">Affiliate rate (%) — proposed default, pending confirmation</label>
          <input id="rate-input" type="number" min="0" max="100" step="any" placeholder="e.g. 10" value={rateInput} onChange={(e) => setRateInput(e.target.value)} />
          <button className="cyan" onClick={() => rateInput && doAdmin('Affiliate rate set', () => adminSetRate(adminSecret, address, rateInput))}>Set affiliate rate</button>
          <button className="glow" onClick={() => doAdmin('Snapshot run', () => adminSnapshot(adminSecret, address))}>📸 Run snapshot now</button>
          <h2>🔋 NFT settings</h2>
          <p className="muted">All NFT numbers are adjustable here — nothing is hardcoded. Leave a field blank to leave that setting unchanged. Invalid numbers are rejected with a visible error.</p>
          <button className="cyan" onClick={loadAdminNft}>Load NFT admin stats</button>
          {adminNft && (
            <div className="adminstats">
              <p>Collection: {adminNft.collection ? <span className="mono">{adminNft.collection}</span> : 'not configured'}</p>
              <p>Bonus collections: {(adminNft.collections || []).length
                ? adminNft.collections.map((c) => <span key={c} className="mono">{c}<br /></span>)
                : 'none connected — NFT bonus counts read as zero'}</p>
              <p>Excluded wallets (no NFT bonus): {(adminNft.excludedWallets || []).length
                ? adminNft.excludedWallets.map((c) => <span key={c} className="mono">{c}<br /></span>)
                : 'none — every wallet counts'}</p>
              <p>Bonus rates: {adminNft.bonusRateSet && adminNft.bonusRatesWhole
                ? `Bonus ${adminNft.bonusRatesWhole.bonus} · Common ${adminNft.bonusRatesWhole.common} · Uncommon ${adminNft.bonusRatesWhole.uncommon} FRG per NFT per day`
                : 'not set yet — collections are connected but no NFT bonus accrues'}</p>
              <p>Mint price: {adminNft.mintCostWhole} FRG</p>
              <p>Threshold: {adminNft.threshold} · Supply cap: {adminNft.supplyCap || 'unlimited'}</p>
              <p>Bonus pool wallet: {adminNft.bonusPoolWallet ? <span className="mono">{adminNft.bonusPoolWallet}</span> : 'not set — bonus payouts are blocked until it is set'}</p>
              <p>Bonus pool: funded {adminNft.bonusPoolFundedWhole} FRG · available {adminNft.bonusPoolAvailableWhole} FRG · paid {toWhole(adminNft.bonusPoolPaid)} FRG</p>
              <p>NFT snapshot days: {adminNft.snapshotDays.length ? adminNft.snapshotDays.join(', ') : 'none yet'}</p>
            </div>
          )}
          <label className="muted" htmlFor="nft-collections-input">Bonus collections (CW721 addresses, one per line — holdings across all of them count as one NFT total per holder). This box replaces the whole list when saved; empty disconnects all bonus collections.</label>
          <textarea id="nft-collections-input" rows="3" placeholder="terra1…" value={nftCollectionsInput} onChange={(e) => setNftCollectionsInput(e.target.value)} />
          <button className="cyan" onClick={saveBonusCollections}>Save bonus collections</button>
          <label className="muted" htmlFor="nft-excluded-input">Excluded wallets (no NFT bonus) — wallet addresses, one per line. These wallets record an NFT count of 0 and never accrue NFT bonus; their base hold-and-earn rewards are unaffected. This box replaces the whole list when saved; empty clears all exclusions.</label>
          <textarea id="nft-excluded-input" rows="3" placeholder="terra1…" value={nftExcludedInput} onChange={(e) => setNftExcludedInput(e.target.value)} />
          <button className="cyan" onClick={saveExcludedWallets}>Save excluded wallets</button>
          <label className="muted" htmlFor="nft-collection-input">NFT collection address (CW721 — mint collection)</label>
          <input id="nft-collection-input" placeholder="terra1…" value={nftCollectionInput} onChange={(e) => setNftCollectionInput(e.target.value)} />
          <label className="muted" htmlFor="nft-mint-input">Mint price (FRG)</label>
          <input id="nft-mint-input" type="number" min="0" step="any" placeholder="e.g. 1000" value={nftMintInput} onChange={(e) => setNftMintInput(e.target.value)} />
          <label className="muted" htmlFor="nft-rate-bonus-input">Bonus rate — Bonus NFTs (the default type, no rarity) (FRG per day)</label>
          <input id="nft-rate-bonus-input" type="number" min="0" step="any" placeholder="e.g. 4" value={nftRateBonusInput} onChange={(e) => setNftRateBonusInput(e.target.value)} />
          <label className="muted" htmlFor="nft-rate-common-input">Bonus rate — Common NFTs (FRG per day)</label>
          <input id="nft-rate-common-input" type="number" min="0" step="any" placeholder="e.g. 50" value={nftRateCommonInput} onChange={(e) => setNftRateCommonInput(e.target.value)} />
          <label className="muted" htmlFor="nft-rate-uncommon-input">Bonus rate — Uncommon NFTs (FRG per day)</label>
          <input id="nft-rate-uncommon-input" type="number" min="0" step="any" placeholder="e.g. 100" value={nftRateUncommonInput} onChange={(e) => setNftRateUncommonInput(e.target.value)} />
          <label className="muted" htmlFor="nft-threshold-input">Fully-powered threshold (NFT count, 0 = unset)</label>
          <input id="nft-threshold-input" type="number" min="0" step="1" placeholder="e.g. 10" value={nftThresholdInput} onChange={(e) => setNftThresholdInput(e.target.value)} />
          <label className="muted" htmlFor="nft-cap-input">Supply cap (0 = unlimited)</label>
          <input id="nft-cap-input" type="number" min="0" step="1" placeholder="e.g. 1000" value={nftCapInput} onChange={(e) => setNftCapInput(e.target.value)} />
          <label className="muted" htmlFor="nft-pool-wallet-input">Bonus pool wallet (receives mint fees)</label>
          <input id="nft-pool-wallet-input" placeholder="terra1…" value={nftPoolWalletInput} onChange={(e) => setNftPoolWalletInput(e.target.value)} />
          <button className="cyan" onClick={saveNftSettings}>Save NFT settings</button>
          <button className="ghost" onClick={() => doAdmin('NFT collection cleared', () => adminSetNftSettings(adminSecret, address, { collection: '' }))}>Clear NFT collection</button>
          <label className="muted" htmlFor="nft-fund-input">Bonus pool funding (FRG — real mint proceeds only)</label>
          <input id="nft-fund-input" type="number" min="0" step="any" placeholder="e.g. 5000" value={nftFundInput} onChange={(e) => setNftFundInput(e.target.value)} />
          <input placeholder="Note, e.g. mint txhash (optional)" value={nftFundNoteInput} onChange={(e) => setNftFundNoteInput(e.target.value)} />
          <button className="cyan" onClick={() => nftFundInput && doAdmin('Bonus pool funded', () => adminFundBonusPool(adminSecret, address, nftFundInput, nftFundNoteInput || null))}>Record bonus pool funding</button>
        </div>
      )}

      {log && <div className="card log"><pre>{log}</pre></div>}
    </main>
  );
}
