// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — live FRG/USD price for the daily cap.
// The daily cap is stored in USD (owner's $0.50) and must be
// converted to FRG at each payout run's LIVE price — the FRG
// amount is never hard-coded.
//
// Sources (owner-specified, 2026-11-05):
// - FRG/LUNC price: the FRG/LUNC Terraswap-style pair reserves via
//   LCD smart query {pool:{}} — price = LUNC reserve / FRG reserve.
// - LUNC/USD: CoinPaprika ticker lunc-terra-classic.
//
// All math is BigInt rational: the pair reserves are base units
// (both 6 decimals, so the ratio is unitless), and LUNC/USD is
// carried as micro-USD (price × 1e6, rounded). ANY failure — LCD
// error, malformed reserves, CoinPaprika error, zero reserves —
// throws: the payout run HALTS and pays nothing. A price is never
// guessed, cached, or fallen back to.
// ─────────────────────────────────────────────────────────────

export const FRG_LUNC_PAIR = 'terra1ht0fuwnurs5afln8u36nkjsdy4zcmuv3hnre54rgy2lf9286fxtqsaf4yu';
const COINPAPRIKA_LUNC = 'https://api.coinpaprika.com/v1/tickers/lunc-terra-classic';
const FRG_TOKEN = 'terra14rfnhc2aru7jp304lht3yf903necsnrt4cxd464cftsfcksw0rtsgundnt';

async function fetchJson(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res || !res.ok) throw new Error(`price source failed (${res ? res.status : 'no response'}): ${url}`);
  return res.json();
}

// Fetches the live price. Returns:
// {
//   frgReserveBase, luncReserveBase,   // pair reserves (base units)
//   luncUsdMicro,                      // LUNC price in micro-USD
//   frgUsdMicroPerWhole,               // 1 FRG in micro-USD, ×1e6 scale
//                                      // (kept rational via reserves)
// }
// Throws on any source failure.
export async function fetchFrgUsdPrice({ lcdUrl, fetchImpl = fetch, pair = FRG_LUNC_PAIR } = {}) {
  const q = Buffer.from(JSON.stringify({ pool: {} })).toString('base64');
  const poolJson = await fetchJson(fetchImpl, `${lcdUrl}/cosmwasm/wasm/v1/contract/${pair}/smart/${q}`);
  const assets = poolJson?.data?.assets;
  if (!Array.isArray(assets) || assets.length !== 2) throw new Error('price source failed: pair reserves malformed');
  let frgReserveBase = null;
  let luncReserveBase = null;
  for (const a of assets) {
    const amount = BigInt(a.amount);
    if (a.info?.token?.contract_addr === FRG_TOKEN) frgReserveBase = amount;
    else if (a.info?.native_token?.denom === 'uluna') luncReserveBase = amount;
  }
  if (frgReserveBase === null || luncReserveBase === null || frgReserveBase <= 0n || luncReserveBase <= 0n) {
    throw new Error('price source failed: pair reserves missing or zero');
  }
  const tick = await fetchJson(fetchImpl, COINPAPRIKA_LUNC);
  const luncUsd = Number(tick?.quotes?.USD?.price);
  if (!Number.isFinite(luncUsd) || luncUsd <= 0) throw new Error('price source failed: LUNC/USD unavailable');
  const luncUsdMicro = BigInt(Math.round(luncUsd * 1_000_000));
  if (luncUsdMicro <= 0n) throw new Error('price source failed: LUNC/USD rounds to zero');
  return { frgReserveBase, luncReserveBase, luncUsdMicro, pair };
}

// The cap in FRG base units for a USD cap, at a fetched price:
//   FRG price (USD/whole) = (luncReserve / frgReserve) × luncUsd
//   capBase = capUsd × 1e6 / priceUsd
//           = capUsdMicro × frgReserveBase × 1e6
//             / (luncReserveBase × luncUsdMicro)
// Exact BigInt math, floor (the cap is a maximum — never round up).
export function capBaseForUsd(capUsdMicro, price) {
  const cap = BigInt(capUsdMicro);
  if (cap <= 0n) return 0n;
  return (cap * price.frgReserveBase * 1_000_000n) / (price.luncReserveBase * price.luncUsdMicro);
}

// Display helper: 1 FRG in USD as a Number (for tables/logs only —
// never used in money math).
export function frgUsdPrice(price) {
  const luncPerFrg = Number(price.luncReserveBase) / Number(price.frgReserveBase);
  return luncPerFrg * (Number(price.luncUsdMicro) / 1_000_000);
}
