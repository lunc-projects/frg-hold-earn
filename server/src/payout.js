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
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';
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

export function createPayout({ lcdUrl, rpcUrl, payoutAddress, mnemonic, rewardAsset }) {
  const envAddress = (payoutAddress || '').trim() || null;
  const hasKey = Boolean(mnemonic && mnemonic.trim());
  let derivedAddress = null;
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

  // USTC send: `amount` base units of USTC (uusd) via a native bank
  // send. The actual USTC balance is re-read from the SENDING wallet
  // immediately before signing and hard-caps the payment. Throws on
  // every failure mode; the caller voids the pending payment on
  // throw. Retained for the dormant USTC reward option — the base
  // Collect reaches it only when the USTC descriptor is selected.
  async function sendUstc(recipient, amount, memo = '') {
    const { wallet, from } = await sendingWallet();
    const balance = await bankBalance(lcdUrl, from, USTC_DENOM);
    if (balance < amount) throw new Error('rewards pool empty, top up');
    const client = await SigningStargateClient.connectWithSigner(
      rpcUrl, wallet, { gasPrice: GasPrice.fromString(TERRA_GAS_PRICE) });
    try {
      const res = await client.sendTokens(from, recipient,
        [{ denom: USTC_DENOM, amount: amount.toString() }], 'auto', memo);
      return res.transactionHash;
    } finally {
      client.disconnect();
    }
  }

  // FRG CW20 send: used by the separate NFT bonus mechanic AND by
  // base rewards while FRG is the live reward asset. The actual FRG
  // balance is re-read from the SENDING wallet immediately before
  // signing and hard-caps the payment.
  async function sendFrg(recipient, amount, memo = '') {
    const { wallet, from } = await sendingWallet();
    const balance = await cw20Balance(lcdUrl, FRG_TOKEN, from);
    if (balance < amount) throw new Error('rewards pool empty, top up');
    const client = await SigningCosmWasmClient.connectWithSigner(
      rpcUrl, wallet, { gasPrice: GasPrice.fromString(TERRA_GAS_PRICE) });
    try {
      const res = await client.execute(from, FRG_TOKEN,
        { transfer: { recipient, amount: amount.toString() } }, 'auto', memo);
      return res.transactionHash;
    } finally {
      client.disconnect();
    }
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
