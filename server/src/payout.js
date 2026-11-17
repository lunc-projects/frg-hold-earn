// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — payout wallet (the ONLY wallet that ever sends).
// Holders' FRG never moves. BASE rewards pay in the LIVE reward
// asset (assets.js): FRG via the CW20 transfer path since
// 2026-11-05 (owner ruling: holders earn FRG). The USTC native
// bank-send path is retained INTACT as the dormant future option
// (USTC-from-commission is the planned delegation driver) —
// getRewardBalance/sendReward dispatch on the configured reward
// asset descriptor; selecting the USTC descriptor later revives
// that path without touching this logic. The NFT bonus mechanic
// has always been FRG and uses sendFrg via `send` below.
//
// Key handling (non-negotiable):
// - The payout ADDRESS is env var FRG_PAYOUT_ADDRESS (configured
//   default: the owner's "New admin" wallet, user-settled 2026-10-24
//   as BOTH payout and admin wallet for this app). It is public info
//   (a wallet address) and is all the balance display needs —
//   reading a balance from LCD requires NO key. No other wallet is
//   ever configured as the payout wallet — in particular, the owner's
//   regular-use wallets are never payout wallets and their keys
//   never go on the server.
// - The payout KEY is env var FRG_PAYOUT_MNEMONIC, and ONLY the key
//   enables sending. With the key absent, collects fail safely with
//   "payout wallet not configured yet" — never a crash, never a
//   fake success. The address and the key are INDEPENDENT settings.
// - If BOTH are set and the key derives a DIFFERENT address than
//   FRG_PAYOUT_ADDRESS, sending refuses outright (configuration
//   mismatch). The server must never silently pay from a wallet
//   other than the one it displays.
// - The mnemonic is NEVER logged, printed, stored, or returned.
//   The owner pastes it into Railway himself at deploy time. It must
//   never travel through chat.
// ─────────────────────────────────────────────────────────────
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { stringToPath } from '@cosmjs/crypto';
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { SigningStargateClient, GasPrice, calculateFee } from '@cosmjs/stargate';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { createHash } from 'node:crypto';
import { FRG_TOKEN, REWARD_ASSETS, rewardAssetFor } from './assets.js';

export { FRG_TOKEN };

// Terra HD derivation path (coin type 330). Terra wallets (Terra
// Station, Keplr, Leap, Galaxy Station) derive Terra addresses with
// m/44'/330'/0'/0/0. CosmJS's DEFAULT path is the Cosmos one
// (m/44'/118'/0'/0/0), which derives a DIFFERENT terra1 address from
// the same mnemonic — that bug made the key/address guard refuse
// every Collect on 2026-10-27 even though the owner's key was the
// correct payout-wallet key. Every derivation below uses 330.
const TERRA_HD_PATHS = [stringToPath("m/44'/330'/0'/0/0")];

export const USTC_DENOM = 'uusd';

// Terra Classic on-chain gas price for uluna (columbus-5
// minGasPrices). The chain's fee check accepts payment in ANY one
// denom of its multi-denom list, but the offered fee must cover
// gas x that denom's price. Uluna's price is 28.325 — NOT the
// 0.15 this file shipped with (a stale pre-2023 value ~189x too
// low). On 2026-11-07 the first real payout run's 13 sends were
// ALL rejected at broadcast with code 13 "insufficient fees; got:
// 26517uluna, required: ...,5007124uluna,..." (26517 = 0.15 x
// 176,780 gas; 5,007,124 / 176,780 = 28.325). Nothing ever
// reached the chain. Every send below prices gas at this rate.
export const TERRA_GAS_PRICE = '28.325uluna';

// The memo on every daily-payout send (owner, 2026-11-07: holders
// must be able to see in their wallet what the FRG is). On Terra
// the memo rides on the tx itself, so it shows in every wallet
// and explorer next to the transfer.
export const PAYOUT_MEMO = 'Thank you for holding FRG — here is your Hold & Earn reward';

// LUNC (uluna) balance RESERVE required per payout send before a
// run may start (owner, 2026-11-07: "make sure we have enough
// gas"). Measured 2026-11-07 from the failed run's own broadcast
// data: a CW20 transfer estimates ~176,780 gas; at 28.325
// uluna/gas the chain-required fee is ~5,007,124 uluna ~ 5.01
// LUNC (independently confirmed by LCD simulate: gas_used
// 126,015 x 1.4 = ~176,421). The chain's error showed an EMPTY
// tax leg — CW20 contract executes carry no burn tax in the fee;
// the 1.5% tax applies to bank sends of taxed denoms, not to
// this path. The reserve is the measured fee x ~1.5 headroom,
// so gas-price or gas-estimate drift cannot silently eat a run:
// 7.5 LUNC/send.
export const GAS_RESERVE_PER_SEND_ULUNA = 7_500_000n;

// ─────────────────────────────────────────────────────────────
// SEQUENCE-SAFE SENDING (fix, 2026-11-17). The 2026-11-17 daily
// run paid 15 of 18 wallets; 3 sends failed with "account
// sequence mismatch, expected 95, got 94" and stayed owed. Cause:
// every send let the signing client read the account sequence
// from a node that had not yet seen the previous send land (and
// the user Collect endpoints and the daily run hold DIFFERENT
// mutexes in server.js, so sends from the one payout account
// could also overlap). The sender now guarantees, for EVERY send
// through this module:
// 1. SERIALIZED: all sends from the payout account run one at a
//    time through a queue inside createPayout — no caller (run,
//    Collect, NFT Collect) can sign in parallel with another.
// 2. FRESH SEQUENCE: the account number + sequence are read from
//    the LCD immediately before signing EACH attempt — never a
//    sequence captured earlier in a batch.
// 3. RETRY ON MISMATCH ONLY: a sequence-mismatch rejection (the
//    tx was NOT accepted) re-reads the sequence and retries THAT
//    payment, up to SEND_MAX_ATTEMPTS attempts. Every other
//    failure keeps the old behavior: throw, the caller voids the
//    pending payment, the amount stays owed.
// 4. NO BLIND RESEND: the tx hash is computed locally from the
//    signed bytes BEFORE broadcast. If a broadcast's outcome is
//    ever unknown (network error, confirmation window elapsed),
//    the hash is looked up on-chain before any resend — a tx
//    that actually landed is reported as paid, never sent twice.
// ─────────────────────────────────────────────────────────────
export const SEND_MAX_ATTEMPTS = 3;
export const SEND_RETRY_DELAY_MS = 2_000;
export const TX_CONFIRM_POLL_ATTEMPTS = 20; // x 3s = up to ~60s for inclusion
export const TX_CHECK_POLL_ATTEMPTS = 5;    // x 3s = up to ~15s pre-resend check
export const TX_POLL_INTERVAL_MS = 3_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A sequence mismatch means the chain's expected sequence differs
// from the one the tx was signed with (Cosmos SDK error code 32,
// "account sequence mismatch, expected N, got M: incorrect
// account sequence"). Such a tx was rejected BEFORE execution —
// its sequence was not consumed and nothing was paid — so it is
// the one failure that is always safe to retry with a fresh read.
export function isSequenceMismatchError(e) {
  if (!e) return false;
  if (e.code === 32 && (e.codespace === 'sdk' || e.codespace === undefined)) return true;
  const msg = String(e.message || e);
  return /sequence mismatch/i.test(msg) || /incorrect account sequence/i.test(msg);
}

// A CheckTx rejection ("Broadcasting transaction failed with
// code …") is DEFINITE: the node refused the tx, it never entered
// the mempool, nothing can land later. Distinguished from network
// errors during broadcast, whose outcome is unknown (ambiguous).
export function isBroadcastRejection(e) {
  return /^Broadcasting transaction failed with code /.test(String(e?.message || ''));
}

// The sender account's CURRENT account number + sequence, read
// from the LCD at call time. Wrapped accounts (vesting etc.)
// carry the values on their base_account.
export async function fetchAccountSequence(lcdUrl, address) {
  const res = await fetch(`${lcdUrl}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) throw new Error(`LCD account query failed (${res.status})`);
  const data = await res.json();
  const acct = data?.account || {};
  const base = acct.base_account || acct;
  const sequence = Number(base.sequence);
  const accountNumber = Number(base.account_number);
  if (!Number.isFinite(sequence) || !Number.isFinite(accountNumber)) {
    throw new Error('LCD account query returned no usable sequence');
  }
  return { accountNumber, sequence };
}

// Look a tx up by hash on the LCD, polling for the window given.
// Returns { status: 'success' } (landed, code 0),
// { status: 'sequence-failed' } (landed but rejected for a stale
// sequence — sequence NOT consumed, safe to sign fresh),
// { status: 'failed', code, error } (landed, failed for another
// reason), or { status: 'not-found' } (no sign of it after the
// whole window — treated as never landed).
export async function pollTxOutcome(lcdUrl, txHash, {
  attempts = TX_CONFIRM_POLL_ATTEMPTS, intervalMs = TX_POLL_INTERVAL_MS, sleep = defaultSleep,
} = {}) {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(intervalMs);
    let res;
    try {
      res = await fetch(`${lcdUrl}/cosmos/tx/v1beta1/txs/${txHash}`);
    } catch { continue; } // LCD hiccup — keep looking within the window
    if (!res.ok) continue; // 404 = not indexed yet; anything else = retry
    const data = await res.json().catch(() => null);
    const resp = data?.tx_response;
    if (!resp) continue;
    const code = Number(resp.code ?? 0);
    if (code === 0) return { status: 'success' };
    if (code === 32) return { status: 'sequence-failed', code };
    return { status: 'failed', code, error: resp.raw_log || '' };
  }
  return { status: 'not-found' };
}

// The retry engine (exported for tests; production wires it to
// the real LCD + signing client in createPayout below).
// - fetchSequence(): fresh { accountNumber, sequence } per attempt.
// - attempt(seq): one signed send. Resolves { status: 'confirmed',
//   txHash } | { status: 'sequence-mismatch' } |
//   { status: 'ambiguous', txHash }; THROWS for every other
//   failure (which propagates immediately — no retry).
// - checkTxByHash(hash): outcome lookup for an ambiguous attempt.
// A payment is reported sent ONLY with a hash confirmed on-chain.
export async function sendWithSequenceRetry({
  fetchSequence, attempt, checkTxByHash,
  maxAttempts = SEND_MAX_ATTEMPTS, retryDelayMs = SEND_RETRY_DELAY_MS, sleep = defaultSleep,
}) {
  let unknownHash = null;
  let lastMismatch = null;
  for (let i = 1; i <= maxAttempts; i++) {
    if (unknownHash) {
      // The previous attempt may or may not have landed. Look it
      // up by hash BEFORE signing anything new — resending a tx
      // that actually landed would pay the wallet twice.
      const found = await checkTxByHash(unknownHash);
      if (found.status === 'success') return unknownHash;
      if (found.status === 'failed') {
        throw new Error(`payout tx ${unknownHash} failed on-chain (code ${found.code}): ${found.error || 'unknown error'}`);
      }
      unknownHash = null; // sequence-failed or never landed: safe to sign fresh
    }
    let res;
    try {
      res = await attempt(await fetchSequence());
    } catch (e) {
      if (!isSequenceMismatchError(e)) throw e;
      lastMismatch = e;
      res = { status: 'sequence-mismatch' };
    }
    if (res.status === 'confirmed') return res.txHash;
    if (res.status === 'ambiguous') {
      unknownHash = res.txHash;
    } else if (res.status === 'sequence-mismatch') {
      if (res.error) lastMismatch = res.error;
    } else {
      throw new Error(`internal error: unknown send attempt status ${res.status}`);
    }
    if (i < maxAttempts) await sleep(retryDelayMs);
  }
  if (unknownHash) {
    // Attempts exhausted with one outcome still unknown: one last
    // lookup before failing the row. If it cannot be confirmed,
    // the send reports failure and the amount stays owed — the
    // error names the hash so the owner can check it before any
    // re-press (a re-press re-checks claimable from the ledger,
    // and this hash is the first thing to verify).
    const found = await checkTxByHash(unknownHash);
    if (found.status === 'success') return unknownHash;
    throw new Error(`payout send outcome unknown after ${maxAttempts} attempts — tx ${unknownHash} was not confirmed on-chain; the amount stays owed, check that hash before re-pressing`);
  }
  throw new Error(`payout send failed after ${maxAttempts} attempts: ${lastMismatch ? lastMismatch.message : 'account sequence kept changing underneath the sender'}`);
}

const sha256HexUpper = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const utf8 = (s) => new TextEncoder().encode(s);

// Default signing-client factory (the test seam is the
// `clientFactory` option of createPayout — production never sets
// it). kind 'wasm' sends MsgExecuteContract (FRG CW20 path);
// kind 'bank' sends MsgSend (dormant USTC path).
async function defaultClientFactory(kind, rpcUrl, wallet) {
  const opts = { gasPrice: GasPrice.fromString(TERRA_GAS_PRICE) };
  return kind === 'wasm'
    ? SigningCosmWasmClient.connectWithSigner(rpcUrl, wallet, opts)
    : SigningStargateClient.connectWithSigner(rpcUrl, wallet, opts);
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

export async function cw20Balance(lcdUrl, token, address) {
  const res = await fetch(
    `${lcdUrl}/cosmwasm/wasm/v1/contract/${token}/smart/${b64({ balance: { address } })}`);
  if (!res.ok) throw new Error(`LCD balance query failed (${res.status})`);
  const data = await res.json();
  return BigInt(data.data.balance);
}

// Native bank balance for one denom (default USTC / "uusd"). The LCD
// returns {"balance":{"denom":"uusd","amount":"..."}}; a wallet that
// has never held the denom reads as 0, never as an invented amount.
export async function bankBalance(lcdUrl, address, denom = USTC_DENOM) {
  const res = await fetch(
    `${lcdUrl}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`);
  if (!res.ok) throw new Error(`LCD bank balance query failed (${res.status})`);
  const data = await res.json();
  return BigInt(data.balance?.amount ?? '0');
}

export function createPayout({ lcdUrl, rpcUrl, payoutAddress, mnemonic, rewardAsset, clientFactory, sleep, sendTiming }) {
  const envAddress = (payoutAddress || '').trim() || null;
  const hasKey = Boolean(mnemonic && mnemonic.trim());
  let derivedAddress = null;
  // Test seams (production passes neither): clientFactory replaces
  // how a signing client is obtained; sleep + sendTiming shrink
  // the retry/poll waits. Defaults are the real implementations.
  const makeClient = clientFactory || defaultClientFactory;
  const sleepFn = sleep || defaultSleep;
  const timing = {
    retryDelayMs: sendTiming?.retryDelayMs ?? SEND_RETRY_DELAY_MS,
    confirmPollAttempts: sendTiming?.confirmPollAttempts ?? TX_CONFIRM_POLL_ATTEMPTS,
    checkPollAttempts: sendTiming?.checkPollAttempts ?? TX_CHECK_POLL_ATTEMPTS,
    pollIntervalMs: sendTiming?.pollIntervalMs ?? TX_POLL_INTERVAL_MS,
  };
  // The LIVE reward asset for base rewards (descriptor object or
  // symbol string). Defaults to FRG, the current live reward.
  const asset = typeof rewardAsset === 'string'
    ? rewardAssetFor(rewardAsset)
    : (rewardAsset || REWARD_ASSETS.FRG);

  // The displayed payout address. Env var wins; otherwise the key's
  // own address; otherwise null. Needs NO key when the env var is set.
  async function address() {
    if (envAddress) return envAddress;
    if (!hasKey) return null;
    if (!derivedAddress) {
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix: 'terra', hdPaths: TERRA_HD_PATHS });
      derivedAddress = (await wallet.getAccounts())[0].address;
    }
    return derivedAddress;
  }

  // Shared send guard: a key must exist, and the KEY's own address
  // must match the configured payout address. Compare against the
  // key-derived address — NOT the display address (which is the env
  // address itself, so comparing against it could never fail).
  async function sendingWallet() {
    if (!hasKey) throw new Error('payout wallet not configured yet');
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix: 'terra', hdPaths: TERRA_HD_PATHS });
    const from = (await wallet.getAccounts())[0].address;
    if (envAddress && from !== envAddress) {
      throw new Error('payout wallet misconfigured: key does not match payout address');
    }
    return { wallet, from };
  }

  async function ustcBalance() {
    const addr = await address();
    if (!addr) throw new Error('payout wallet not configured yet');
    return bankBalance(lcdUrl, addr, USTC_DENOM);
  }

  // The payout wallet's LUNC balance in uluna — the gas tank every
  // send draws its fee from. Read-only (LCD), needs no key.
  async function gasBalance() {
    const addr = await address();
    if (!addr) throw new Error('payout wallet not configured yet');
    return bankBalance(lcdUrl, addr, 'uluna');
  }

  // SEND QUEUE: every send from the payout account — daily run,
  // user Collect, NFT Collect — runs strictly one at a time
  // through this chain, whichever caller asked. Two sends signing
  // at once from one account is exactly how sequences collide.
  let sendQueue = Promise.resolve();
  function serializedSend(fn) {
    const result = sendQueue.then(fn, fn);
    sendQueue = result.then(() => {}, () => {});
    return result;
  }

  // One message, sent sequence-safely (see the fix block above):
  // fresh LCD sequence per attempt, explicit signer data, gas
  // estimated per attempt with the same 1.4 multiplier the old
  // 'auto' fee used, hash computed locally before broadcast, and
  // inclusion confirmed on the LCD before the send is reported.
  async function sendMessage({ wallet, from, kind, message, memo }) {
    const client = await makeClient(kind, rpcUrl, wallet);
    try {
      const chainId = await client.getChainId();
      const attempt = async ({ accountNumber, sequence }) => {
        const gasEstimate = await client.simulate(from, [message], memo);
        const fee = calculateFee(Math.round(gasEstimate * 1.4), GasPrice.fromString(TERRA_GAS_PRICE));
        const txRaw = await client.sign(from, [message], fee, memo, { accountNumber, sequence, chainId });
        const txBytes = TxRaw.encode(txRaw).finish();
        const txHash = sha256HexUpper(txBytes);
        try {
          await client.broadcastTxSync(txBytes);
        } catch (e) {
          // CheckTx refused it: never entered the mempool. A
          // sequence mismatch is retryable; any other refusal is
          // a definite failure and keeps today's behavior.
          if (isSequenceMismatchError(e)) return { status: 'sequence-mismatch', error: e };
          if (isBroadcastRejection(e)) throw e;
          // Network-class error: the tx may have reached the node
          // anyway. Outcome unknown — the engine checks the hash
          // on-chain before any resend.
          return { status: 'ambiguous', txHash };
        }
        const outcome = await pollTxOutcome(lcdUrl, txHash, {
          attempts: timing.confirmPollAttempts, intervalMs: timing.pollIntervalMs, sleep: sleepFn,
        });
        if (outcome.status === 'success') return { status: 'confirmed', txHash };
        if (outcome.status === 'sequence-failed') {
          return { status: 'sequence-mismatch', error: new Error(`account sequence mismatch on-chain for tx ${txHash} (code 32)`) };
        }
        if (outcome.status === 'failed') {
          throw new Error(`payout tx ${txHash} failed on-chain (code ${outcome.code}): ${outcome.error || 'unknown error'}`);
        }
        return { status: 'ambiguous', txHash }; // window elapsed, never sighted
      };
      return await sendWithSequenceRetry({
        fetchSequence: () => fetchAccountSequence(lcdUrl, from),
        attempt,
        checkTxByHash: (hash) => pollTxOutcome(lcdUrl, hash, {
          attempts: timing.checkPollAttempts, intervalMs: timing.pollIntervalMs, sleep: sleepFn,
        }),
        maxAttempts: SEND_MAX_ATTEMPTS,
        retryDelayMs: timing.retryDelayMs,
        sleep: sleepFn,
      });
    } finally {
      client.disconnect();
    }
  }

  // USTC send: `amount` base units of USTC (uusd) via a native bank
  // send. The actual USTC balance is re-read from the SENDING wallet
  // immediately before signing and hard-caps the payment. Throws on
  // every failure mode; the caller voids the pending payment on
  // throw. Retained for the dormant USTC reward option — the base
  // Collect reaches it only when the USTC descriptor is selected.
  async function sendUstc(recipient, amount, memo = '') {
    return serializedSend(async () => {
      const { wallet, from } = await sendingWallet();
      const balance = await bankBalance(lcdUrl, from, USTC_DENOM);
      if (balance < amount) throw new Error('rewards pool empty, top up');
      const message = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: from, toAddress: recipient,
          amount: [{ denom: USTC_DENOM, amount: amount.toString() }],
        },
      };
      return sendMessage({ wallet, from, kind: 'bank', message, memo });
    });
  }

  // FRG CW20 send: used by the separate NFT bonus mechanic AND by
  // base rewards while FRG is the live reward asset. The actual FRG
  // balance is re-read from the SENDING wallet immediately before
  // signing and hard-caps the payment.
  async function sendFrg(recipient, amount, memo = '') {
    return serializedSend(async () => {
      const { wallet, from } = await sendingWallet();
      const balance = await cw20Balance(lcdUrl, FRG_TOKEN, from);
      if (balance < amount) throw new Error('rewards pool empty, top up');
      const message = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: {
          sender: from, contract: FRG_TOKEN,
          msg: utf8(JSON.stringify({ transfer: { recipient, amount: amount.toString() } })),
          funds: [],
        },
      };
      return sendMessage({ wallet, from, kind: 'wasm', message, memo });
    });
  }

  // Base-reward balance/send, dispatched on the live reward asset:
  // CW20 (FRG today) reads/sends through the contract path; native
  // (USTC, dormant) through the bank path. This is the ONLY pair the
  // base Collect is allowed to use.
  async function rewardBalance() {
    const addr = await address();
    if (!addr) throw new Error('payout wallet not configured yet');
    return asset.kind === 'cw20'
      ? cw20Balance(lcdUrl, asset.token, addr)
      : bankBalance(lcdUrl, addr, asset.denom);
  }
  async function sendReward(recipient, amount, memo = '') {
    return asset.kind === 'cw20' ? sendFrg(recipient, amount, memo) : sendUstc(recipient, amount, memo);
  }

  return {
    // True only when sending is possible (a key is present).
    get configured() { return hasKey; },
    get canSend() { return hasKey; },
    address,

    // The live reward asset descriptor this payout routes by.
    rewardAsset: asset,

    // FRG CW20 balance of the payout wallet (NFT bonus path and,
    // while FRG is the reward, the base reward balance too).
    async getBalance() {
      const addr = await address();
      if (!addr) throw new Error('payout wallet not configured yet');
      return cw20Balance(lcdUrl, FRG_TOKEN, addr);
    },

    // USTC balance of the payout wallet (dormant future option's
    // funding view; base Collect caps against it only when the
    // USTC descriptor is selected).
    getUstcBalance: ustcBalance,

    // LUNC gas-tank balance (uluna) of the payout wallet.
    getGasBalance: gasBalance,

    // Base reward routing (descriptor-dispatched — see above).
    getRewardBalance: rewardBalance,
    sendReward,

    send: sendFrg,
    sendUstc,
    sendFrg,
  };
}
