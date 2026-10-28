// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — payout wallet (the ONLY wallet that ever sends).
// Holders' FRG never moves. BASE rewards are native USTC bank sends
// FROM this wallet TO the holder (denom "uusd"); the owner funds the
// wallet with USTC deposits plus a little LUNC for gas. The older FRG
// CW20 send path below is retained ONLY for the separate NFT bonus
// mechanic, whose currency and logic were not converted.
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
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';

export const FRG_TOKEN = 'terra14rfnhc2aru7jp304lht3yf903necsnrt4cxd464cftsfcksw0rtsgundnt';
export const USTC_DENOM = 'uusd';

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

export function createPayout({ lcdUrl, rpcUrl, payoutAddress, mnemonic }) {
  const envAddress = (payoutAddress || '').trim() || null;
  const hasKey = Boolean(mnemonic && mnemonic.trim());
  let derivedAddress = null;

  // The displayed payout address. Env var wins; otherwise the key's
  // own address; otherwise null. Needs NO key when the env var is set.
  async function address() {
    if (envAddress) return envAddress;
    if (!hasKey) return null;
    if (!derivedAddress) {
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix: 'terra' });
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
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix: 'terra' });
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

  // BASE reward send: `amount` base units of USTC (uusd) via a native
  // bank send. The actual USTC balance is re-read from the SENDING
  // wallet immediately before signing and hard-caps the payment.
  // Throws on every failure mode; the caller voids the pending
  // payment on throw.
  async function sendUstc(recipient, amount) {
    const { wallet, from } = await sendingWallet();
    const balance = await bankBalance(lcdUrl, from, USTC_DENOM);
    if (balance < amount) throw new Error('rewards pool empty, top up');
    const client = await SigningStargateClient.connectWithSigner(
      rpcUrl, wallet, { gasPrice: GasPrice.fromString('0.15uluna') });
    try {
      const res = await client.sendTokens(from, recipient,
        [{ denom: USTC_DENOM, amount: amount.toString() }], 'auto');
      return res.transactionHash;
    } finally {
      client.disconnect();
    }
  }

  // FRG CW20 send, retained ONLY for the separate NFT bonus mechanic
  // (its currency was not converted). Base Collect must never call
  // this — it calls sendUstc above.
  async function sendFrg(recipient, amount) {
    const { wallet, from } = await sendingWallet();
    const balance = await cw20Balance(lcdUrl, FRG_TOKEN, from);
    if (balance < amount) throw new Error('rewards pool empty, top up');
    const client = await SigningCosmWasmClient.connectWithSigner(
      rpcUrl, wallet, { gasPrice: GasPrice.fromString('0.15uluna') });
    try {
      const res = await client.execute(from, FRG_TOKEN,
        { transfer: { recipient, amount: amount.toString() } }, 'auto');
      return res.transactionHash;
    } finally {
      client.disconnect();
    }
  }

  return {
    // True only when sending is possible (a key is present).
    get configured() { return hasKey; },
    get canSend() { return hasKey; },
    address,

    // FRG CW20 balance of the payout wallet. Retained for the admin
    // FRG display and the NFT bonus path — NOT the base reward cap.
    async getBalance() {
      const addr = await address();
      if (!addr) throw new Error('payout wallet not configured yet');
      return cw20Balance(lcdUrl, FRG_TOKEN, addr);
    },

    // USTC balance of the payout wallet: the base reward cap and the
    // balance the owner's deposits land in.
    getUstcBalance: ustcBalance,
    getRewardBalance: ustcBalance,

    send: sendFrg,
    sendUstc,
    sendReward: sendUstc,
  };
}
