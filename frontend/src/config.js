// ─────────────────────────────────────────────────────────────
// FRG Hold & Earn — frontend config.
// Core hold-and-earn: NO contracts, NO staking, NO locking — holders
// keep FRG in their own wallets; this app only READS balances and talks
// to the backend, which pays rewards from the owner's payout wallet.
// Separate opt-in NFT bonus section: only active once the admin
// configures a real CW721 collection address; until then the NFT
// section honestly reports zero holdings and minting not open.
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

// Backend base URL. Default is same-origin ('') because the backend serves
// the built frontend in production — a localhost fallback here breaks the
// deployed app (the visitor's own phone has nothing on :3001, so every API
// call fails to fetch). For local split dev only, build/run with
// VITE_API_URL=http://localhost:3001.
export const API_BASE = import.meta.env.VITE_API_URL ?? '';

export const DECIMALS = 1_000_000;
export const toWhole = (raw) => (Number(raw) / DECIMALS).toLocaleString();
export const shortAddr = (a) => (a ? `${a.slice(0, 9)}…${a.slice(-6)}` : '');
