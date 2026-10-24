# 🌌 FRG Hold & Earn — Luna Classic

Hold FRG in your own wallet, earn rewards. **Core hold-and-earn: no
contracts, no staking, no cross-staking, no locking.** Holders keep
their FRG in their own wallets at all times; they visit the website,
connect, and Collect rewards. A separate opt-in NFT bonus section
exists (see below) — it is inactive until the admin configures a
real CW721 collection, and no collection is deployed yet. Earnings are measured by **daily balance snapshots** over time,
so buying just before a payout and selling right after earns nothing
for the days you were not holding.

> **Status: CORE BUILD COMPLETE. Affiliate program = STUB ONLY.**
> The core (hold → snapshot → pro-rata pool split → Collect → admin)
> is built and tested. The affiliate program is NOT finished: referral
> link capture/storage and a configurable rate exist, but the rate
> (default 10%) is a **proposed default, UNCONFIRMED**, and the
> affiliate rules are pending a design session with the owner. Do not
> present affiliate terms as final to anyone.

## How it works

1. A holder connects their wallet (first connect registers them; an
   optional `?ref=<wallet>` link records their referrer — first touch
   wins, the binding can never be changed later).
2. Once a day, the backend snapshots every registered wallet's FRG
   balance (live from the Terra Classic LCD).
3. That day's configured reward pool splits **pro-rata** across that
   day's snapshot balances. The split sums **exactly** to the pool
   (integer dust goes to the largest holder). Zero-balance holders
   earn zero. A wallet earns only for days it appears in a snapshot.
4. The holder clicks **Collect**. The backend recomputes what they are
   owed from snapshots minus what they have already been paid, and
   pays it from the **payout wallet**. The frontend never decides an
   amount — any amount it sends is ignored.

## Safety rules (non-negotiable, enforced in code)

- **No holder's FRG ever leaves their own wallet.** The ONLY wallet
  that ever sends is the payout wallet.
- **The backend never pays more than the payout wallet's actual FRG
  balance.** If the payout wallet is short, Collect fails with
  "rewards pool empty, top up" and nothing is recorded as paid.
- **Every Collect is verified server-side** from snapshots + the
  payment ledger. One wallet's claim can never exceed its own
  accrued-minus-paid, and a double-Collect pays only once.
- **Crash-safe payments:** a Collect first writes a `pending` payment
  row (pending counts as paid), then sends, then confirms. A crash
  between send and confirm can never double-pay; a failed send voids
  the pending row and the rewards stay collectable.
- **Idempotent snapshots:** running a day's snapshot twice records it
  once. A failed snapshot (e.g. an LCD error) records nothing at all.
- **Affiliate bonus is EXTRA, funded from the same reward pot** — never
  deducted from the referral's share or from other holders' shares.
  Consequence the admin must fund for: **one day's total cost = daily
  pool + referral bonuses.** The hard cap at payout time is the payout
  wallet's actual FRG balance.

## Roles — settled 2026-10-24 (this app only)

- **Payout wallet AND admin wallet (both):**
  `terra1xketp9yp3lrvkkd6ypk2m7jkmtpxuh6yntdjmv`
  ("New admin" wallet, supplied by the owner, verified on-chain:
  funded, never sent). The admin panel is visible only when the
  connected wallet equals this address, and the backend's
  `/api/stats` is the live source for that gate — changing the admin
  wallet is a server env change, no app rebuild.
- **This replaces the owner's other wallet as admin FOR THIS APP
  ONLY.** His other apps keep their own admins. Do not change them.
- **The owner's regular-use wallet is NOT involved in any way.** Its
  key never goes on the server, and it is not configured anywhere in
  this code.

## Running locally

Backend (from `server/`):

```sh
npm install
npm test          # 29 tests, must all pass
PORT=3001 node src/server.js
```

Frontend (from `frontend/`):

```sh
npm install
npm run build     # must succeed; serves from dist/
npm run dev       # or: dev server (API at http://localhost:3001)
```

The backend serves the built frontend from `dist/` when it exists, so
a single service can host both in production.

## Environment variables (names only — never commit values)

| Variable | Purpose |
|---|---|
| `PORT` | Backend port (default 3001). |
| `LCD_URL` | Terra Classic LCD (public: `https://terra-classic-lcd.publicnode.com`). |
| `RPC_URL` | Terra Classic RPC (public: `https://terra-classic-rpc.publicnode.com`). |
| `ADMIN_WALLET` | Admin wallet for this app (default: the "New admin" wallet above). |
| `ADMIN_SECRET` | Shared secret for admin endpoints. **If unset, admin endpoints refuse outright (503).** The owner sets this in Railway; it is typed per session in the admin panel and never stored in the browser or in code. |
| `FRG_PAYOUT_ADDRESS` | Payout wallet address (default: the "New admin" wallet above). Env-overridable. Displayed in the admin panel; balance is read from LCD with no key. |
| `FRG_PAYOUT_MNEMONIC` | Payout wallet key. **Deploy-time only.** |
| `DB_PATH` | SQLite file (default `data/frg-hold-earn.db`). Local dev/tests only — see production storage below. |
| `SNAPSHOT_INTERVAL_MS` | Snapshot interval (default 24h). Manual runs via the admin panel. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | **TODO, unprovisioned** — production durable store (see below). |

## Deploy-time steps (owner only — the key never travels through chat)

1. The payout wallet already exists (the "New admin" wallet above).
   Its **key goes into Railway as `FRG_PAYOUT_MNEMONIC`**, pasted by
   the owner himself into Railway env vars. Never send the key in
   chat, never put it in code, never log it.
2. Fund the payout wallet with FRG for the reward pool **plus a little
   LUNC for gas** (payouts are CW20 transfers, gas `0.15uluna`).
   The admin panel shows its live FRG balance, so topping up is
   visible before anyone Collects.
3. Set `ADMIN_SECRET` in Railway (a secret only the owner knows).
4. With the key absent, Collects fail safely with "payout wallet not
   configured yet" — no crash, no fake success. With the key present
   but mismatched to `FRG_PAYOUT_ADDRESS`, sending refuses outright
   ("key does not match payout address") before any chain call.

## Admin auth — v1 limitation (stated plainly)

V1 admin endpoints require **two headers**: `x-admin-wallet` equal to
`ADMIN_WALLET` **and** `x-admin-secret` equal to `ADMIN_SECRET`. This
is a shared-secret header, **not** signed-message auth. Upgrade path:
the admin signs a message with the admin wallet and the backend
verifies the signature. Until then, the secret is typed per session
in the admin panel, never baked into code or stored in the browser.

## Production storage TODO (must be solved before real payouts)

SQLite (`DB_PATH`) is for local dev and tests. **A claims ledger must
NOT live on Railway's ephemeral filesystem in production** — a redeploy
that wipes the ledger could double-pay. Before launch, provision a
durable store (Upstash Redis via the env vars above) and swap the
storage module; the server only talks to the store's methods, so the
earnings logic does not change. The Upstash credentials do not exist
yet — they are env vars with a TODO, not invented values.

## Before launch checklist

- [ ] Production durable store provisioned (Upstash Redis) and wired in.
- [ ] `FRG_PAYOUT_MNEMONIC` + `ADMIN_SECRET` set in Railway by the owner.
- [ ] Payout wallet funded with FRG + LUNC for gas.
- [ ] WalletConnect metadata URL in `frontend/src/main.jsx` updated
      from its placeholder to the real deployed URL (currently a
      `lunc-projects.github.io/frg-hold-earn/` placeholder — NOT live).
- [ ] Affiliate design session with the owner (rate, rules, wording)
      — the 10% default is proposed, not final.
- [ ] Daily pool set by the owner (starts at 0 — rewards honestly
      show "not started yet" until then).

## Project layout

```text
frg-hold-earn/
  README.md
  frontend/            # Vite + React + Cosmos Kit (Keplr / Station /
                       # Keplr Mobile / Galaxy Station via WalletConnect)
    src/
      main.jsx         # Cosmos Kit provider (WC metadata URL = TODO)
      App.jsx          # holdings / rewards / Collect / referrals / admin
      config.js        # FRG token, admin fallback, LCD/RPC/Finder
      chainDef.js wallets.js polyfills.js   # copied LNC-app pattern
      lib/api.js       # backend calls + direct LCD balance
      styles.css       # dark cosmic FRG Universe theme
  server/              # Node + Express, no build step
    src/
      server.js        # endpoints, snapshot runner, admin gating
      engine.js        # pure BigInt earnings math
      store.js         # SQLite storage module (node:sqlite)
      payout.js        # the ONLY sender (CosmJS CW20 transfer)
    tests/
      engine.test.js store.test.js collect.test.js payout.test.js
```

## Design note

Dark cosmic FRG Universe theme (deep space, nebula glow, gold) —
deliberately NOT the LNC app's bright candy pastels. No remote JS
module imports anywhere in the frontend (all libraries bundled
locally — mobile wallet browsers fail on remote imports). Honest
empty states only: no fake APY, no fake balance, no fake earnings.

## NFT bonus section (built 2026-10-24, collection NOT deployed)

A separate, opt-in section — base hold-and-earn rewards are untouched.
Holders who also hold FRG NFTs earn extra bonus rewards on top:

- **One calculation per wallet:** all of a holder's NFTs consolidate
  into a single power value (the NFT count). That drives the battery
  visual: charge % = count / threshold, showing FULLY POWERED at the
  admin-set threshold count.
- **Bonus formula:** flat FRG per NFT per snapshot day (admin-set in
  the admin panel). Daily bonus = NFT count × bonus per NFT, accrued
  during the same daily snapshot that records base rewards.
- **Bonus pool:** a SEPARATE ledger from the daily pool, funded by
  mint fees. Bonus Collect reuses the base Collect safety pattern
  (pending counts as paid, failed send voids and stays collectable)
  and never pays more than the tracked bonus pool balance. Sends go
  out through the payout wallet (the only key on the server); the
  bonus pool wallet setting designates where mint fees are collected.
- **All numbers adjustable in the admin panel** (requireAdmin gate):
  collection address, mint price, bonus per NFT per day, fully-powered
  threshold, supply cap, bonus pool wallet. Invalid numbers are
  rejected with a visible error.
- **Honesty rules:** until a real collection address is configured,
  bonus holdings read as zero and minting shows as not open — there
  is no button that pretends to mint. Minting (once configured) is a
  real wallet-signed CW20 send from the connected wallet to the
  collection with a `{"mint":{}}` message; the app checks the
  collection contract's config (price, fee recipient, sold-out state)
  before signing, and the backend verifies the fee transfer on-chain
  before crediting the tracked bonus pool.
- **No other bonuses:** no PvP steal, no grid bonuses, no top-10
  airdrops. Only this mechanic.
- **Collection contract:** `contracts/frg-nft/` — a standard CW721
  (source only, NOT deployed, NOT audited, NO migrate entry point).
  Deployment needs the owner's wallet; see its README for the config
  sync requirements (contract mint price / fee recipient must match
  the app's admin panel settings exactly).
- **Still undecided (owner's numbers):** mint price, bonus per NFT,
  threshold count, supply cap. The app ships with all of them at 0 /
  unset, which honestly means "not started yet."
