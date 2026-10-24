// Backend + LCD calls for FRG Hold & Earn.
// The frontend NEVER decides an amount: rewards and collect results
// always come from the backend, which recomputes from its ledger.
import { API_BASE, FRG, LCD_URL } from '../config.js';

const b64 = (obj) => btoa(JSON.stringify(obj));

// Every fetch carries a timeout: a stalled lookup must fail fast with a
// visible error instead of hanging refresh (and the whole page) forever.
// Plain fetch has no timeout, which is exactly the freeze users hit on
// slow mobile / in-app browsers.
const TIMEOUT_MS = 20000;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out — check connection and retry');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function api(path, opts = {}) {
  const url = API_BASE ? `${API_BASE}${path}` : path;
  const res = await fetchWithTimeout(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Live FRG balance straight from the LCD (no backend needed).
export async function fetchHoldings(address) {
  const res = await fetchWithTimeout(
    `${LCD_URL}/cosmwasm/wasm/v1/contract/${FRG.address}/smart/${b64({ balance: { address } })}`);
  if (!res.ok) throw new Error(`Balance lookup failed (${res.status})`);
  const data = await res.json();
  return data.data.balance;
}

export const getStats = () => api('/api/stats');
export const getRewards = (address) => api(`/api/rewards?address=${address}`);
export const getReferrals = (address) => api(`/api/referrals?address=${address}`);
export const register = (address, referrer) =>
  api('/api/register', { method: 'POST', body: JSON.stringify({ address, referrer }) });
export const collect = (address) =>
  api('/api/collect', { method: 'POST', body: JSON.stringify({ address }) });

const adminHeaders = (secret, address) => ({
  'x-admin-wallet': address,
  'x-admin-secret': secret,
});
export const getAdmin = (secret, address) =>
  api('/api/admin', { headers: adminHeaders(secret, address) });
export const adminSetPool = (secret, address, poolWhole) =>
  api('/api/admin/pool', { method: 'POST', headers: adminHeaders(secret, address), body: JSON.stringify({ poolWhole }) });
export const adminSetRate = (secret, address, percent) =>
  api('/api/admin/rate', { method: 'POST', headers: adminHeaders(secret, address), body: JSON.stringify({ percent }) });
export const adminSnapshot = (secret, address) =>
  api('/api/admin/snapshot', { method: 'POST', headers: adminHeaders(secret, address) });

// --- NFT bonus section ---
// The backend never decides a mint: the mint below is a real
// wallet-signed CW20 send from the connected wallet to the collection
// contract. These helpers only read backend state and report txhashes.
export const getNft = (address) => api(`/api/nft?address=${address}`);
export const collectNftBonus = (address) =>
  api('/api/nft/collect', { method: 'POST', body: JSON.stringify({ address }) });
export const recordMint = (address, txhash) =>
  api('/api/nft/mint-record', { method: 'POST', body: JSON.stringify({ address, txhash }) });
export const getAdminNft = (secret, address) =>
  api('/api/admin/nft', { headers: adminHeaders(secret, address) });
export const adminSetNftSettings = (secret, address, settings) =>
  api('/api/admin/nft/settings', { method: 'POST', headers: adminHeaders(secret, address), body: JSON.stringify(settings) });
export const adminFundBonusPool = (secret, address, amountWhole, note) =>
  api('/api/admin/nft/fund', { method: 'POST', headers: adminHeaders(secret, address), body: JSON.stringify({ amountWhole, note }) });

// Read-only LCD smart queries against the NFT collection contract
// (used to verify the contract matches the app settings BEFORE the
// user signs any mint — never to decide amounts server-side).
async function collectionQuery(collection, query) {
  const res = await fetchWithTimeout(
    `${LCD_URL}/cosmwasm/wasm/v1/contract/${collection}/smart/${b64(query)}`);
  if (!res.ok) throw new Error(`Collection query failed (${res.status})`);
  const data = await res.json();
  return data.data;
}
export const fetchNftContractConfig = (collection) => collectionQuery(collection, { config: {} });
export const fetchNftNumTokens = (collection) =>
  collectionQuery(collection, { num_tokens: {} }).then((d) => d.count);
