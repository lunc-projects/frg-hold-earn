// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — frontend config.
// NO contracts, NO staking, NO NFTs: holders keep FRG in their own
// wallets; this app only READS balances and talks to the backend,
// which pays rewards from the owner's payout wallet.
// ─────────────────────────────────────────────────────────────

export const CHAIN_ID = 'columbus-5';
export const CHAIN_NAME = 'terraclassic'; // Cosmos Kit lookup key (see chainDef.js)
export const LCD_URL = 'https://terra-classic-lcd.publicnode.com';
export const RPC_URL = 'https://terra-classic-rpc.publicnode.com';
export const FINDER = 'https://finder.terraclassic.community/mainnet';

// FRG — "FRG Universe" CW20, decimals 6 (verified on-chain).
export const FRG = {
  symbol: 'FRG',
  name: 'FRG Universe',
  address: 'terra14rfnhc2aru7jp304lht3yf903necsnrt4cxd464cftsfcksw0rtsgundnt',
  decimals: 6,
};

// Admin wallet FOR THIS APP ONLY ("New admin" wallet, user-settled
// 2026-10-24). The panel renders only for this address — but the live
// gate is the backend's /api/stats adminWallet, so changing it needs
// no app rebuild. Backend admin calls are additionally gated by the
// admin secret. Other apps keep their own admins.
export const ADMIN_ADDRESS = 'terra1xketp9yp3lrvkkd6ypk2m7jkmtpxuh6yntdjmv';

// Backend base URL. Build with VITE_API_URL='' for same-origin serving
// (backend serves the built frontend), or the backend URL for split hosting.
// Local dev default: the backend on :3001.
export const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export const DECIMALS = 1_000_000;
export const toWhole = (raw) => (Number(raw) / DECIMALS).toLocaleString();
export const shortAddr = (a) => (a ? `${a.slice(0, 9)}…${a.slice(-6)}` : '');
