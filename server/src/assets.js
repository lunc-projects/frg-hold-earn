// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — asset descriptors (single source of truth).
//
// The HELD token is always FRG: holders keep it in their own
// wallets and its snapshot balances drive the base earnings math.
//
// The base REWARD asset is described here ONCE and consumed by the
// engine metadata, the API rewardMeta, the payout routing
// (payout.js) and the frontend labels (which render the API's
// symbol — no currency copy is hard-coded in the page):
//
// - FRG  — CW20 contract (the CURRENT live reward, owner ruling
//   2026-11-05: holders earn FRG). Pays via the CW20 transfer path.
// - USTC — native denom "uusd" (DORMANT future option, kept intact
//   on purpose: paying USTC out of validator commission is the
//   planned delegation driver. Switching to it later means one new
//   ordered migration + selecting this descriptor — never deleting
//   the FRG path either).
//
// Which descriptor is LIVE is a store fact, not a code guess: the
// reward-currency migrations maintain the `reward_symbol` setting,
// and rewardAssetFor() resolves it. Both descriptors stay in this
// file forever; a currency switch is data + migration, not surgery.
// ─────────────────────────────────────────────────────────────

export const FRG_TOKEN = 'terra14rfnhc2aru7jp304lht3yf903necsnrt4cxd464cftsfcksw0rtsgundnt';

export const REWARD_ASSETS = Object.freeze({
  FRG: Object.freeze({
    symbol: 'FRG',
    kind: 'cw20',
    token: FRG_TOKEN,
    // API denom identifier for a CW20 is its contract address.
    denom: FRG_TOKEN,
    decimals: 6,
  }),
  USTC: Object.freeze({
    symbol: 'USTC',
    kind: 'native',
    token: null,
    denom: 'uusd',
    decimals: 6,
  }),
});

// Resolve a stored reward symbol to its descriptor. Unknown or
// missing symbols resolve to the current live default (FRG) — the
// migrations always write a valid symbol, so this is only a guard.
export function rewardAssetFor(symbol) {
  return REWARD_ASSETS[symbol] || REWARD_ASSETS.FRG;
}
