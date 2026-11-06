# 🌌 FRG Hold & Earn — Luna Classic

Hold FRG in your own wallet, earn FRG rewards. **Core hold-and-earn: no
contracts, no staking, no cross-staking, no locking.** Holders keep
their FRG in their own wallets at all times; they visit the website,
**paste their wallet address** (there is NO wallet connect anywhere
in this app), and the daily payout is sent to them automatically
when the owner presses the payout button. A separate opt-in NFT bonus section
exists (see below) — it is inactive until the admin configures a
real CW721 collection, and no collection is deployed yet. Earnings are measured by **daily balance snapshots** over time,
so buying just before a payout and selling right after earns nothing
for the days you were not holding.

> **Status: CORE BUILD COMPLETE. Affiliate program = STUB ONLY.**
> The core (hold → paste-register ONCE (permanent) → snapshot →
> the day's pot = min(daily payout amount at the live price,
> 2,000 FRG hard limit, pool balance) → SIMPLE pro-rata split by
> holdings → the owner reviews the table and presses the payout
> button → automatic sends) is built and tested. The affiliate
> program is NOT finished: referral link capture/storage and a
> configurable rate exist, but the rate (default 10%) is a
> **proposed default, UNCONFIRMED**, and the affiliate rules are
> pending a design session with the owner. Do not present affiliate
> terms as final to anyone.

## How it works

1. A holder **pastes their wallet address once**. Pasting registers
   the wallet **permanently** (owner rule, 2026-11-05: "they
   shouldn't have to do it every day if they are holding"): an
   optional `?ref=<wallet>` link records their referrer (first
   touch wins, the binding can never be changed later), and the
   wallet joins the registration list for good — every payout run
   includes ALL registered wallets, however long ago they pasted.
   Pasting again is harmless (it just shows the wallet's view).
   The ONLY way off the list is the minimum-holding rule (step
   3a). Invalid addresses are rejected with a plain error and
   nothing is recorded.
2. The backend samples every registered wallet's FRG balance (live
   from the Terra Classic LCD) **once an hour**. Once a day, the
   snapshot fixes each wallet's weight as its **average sampled
   balance for that day** — holding FRG for one hour earns ~1/24 of
   the weight of holding it all day, so flash-holding into the
   snapshot moment does not pay. A wallet with no samples that day
   falls back to a single live read at snapshot time.
3a. **Minimum-holding deregistration** (owner rule, 2026-11-05):
   at each payout build, any registered wallet whose balance —
   the same average-sampled / live-fallback balance the split
   uses — is **below the owner's minimum-holding limit** is
   **removed from the registration list entirely**. It receives
   nothing that day and takes no part in later runs until it
   pastes its address again (one-time registration applies again
   from that paste). A balance **at** the limit stays. The limit
   is admin-settable (`min_holding_base`, FRG base units);
   **the shipped default of 100 FRG is a PLACEHOLDER — the owner
   picks the real number next.** Removed wallets are listed in
   the preview and in the run record.
3. The day's pot comes from **two separate owner numbers, never
   merged**: (1) the **DAILY PAYOUT AMOUNT** — the specific amount
   set to be split that day (owner-set, stored in USD; current
   value **$0.50 total across ALL holders**), converted to FRG at
   the run's **live price** (FRG/LUNC pair reserves via LCD +
   LUNC/USD via CoinPaprika — see `price.js`; the FRG amount is
   never hard-coded); and (2) a **HARD LIMIT of 2,000 FRG/day** —
   an absolute ceiling only, never a target.
   **pot = min(payout amount in FRG, hard limit, pool balance).**
   The pot is split **simple pro-rata by holdings**: each
   registered wallet's share = (its snapshot FRG balance ÷ total
   FRG held by all registered wallets) × pot — its share of the
   holdings is its share of the reward. Shares sum EXACTLY to the
   pot (rounding dust to the largest holder); a sole registrant
   receives the whole pot; a wallet holding 0 FRG receives 0. No
   tiers, no per-tier rates, no tenure weighting. **A price-feed
   failure halts the run and pays nothing — a price is never
   guessed.** Payout amount 0/unset = nothing pays (and no price
   is consulted). Changing any setting never alters a recorded
   day. Every reward amount is FRG (CW20, 6 decimals) — see the
   reward-currency migrations below.
4. At the end of the day the system computes the payout table; the
   **owner reviews it in the admin panel and presses the payout
   button** — only then do sends go out, automatically, from the
   **payout wallet** by CW20 transfer (one run per day, every
   payment recorded with its tx hash; re-presses never double-pay).
   **No timer ever sends.** Sub-dust rule: a wallet owed less than
   1 FRG in total is not sent a micro-payment; the amount stays
   accrued (carried) and pays out once its combined claimable
   reaches 1 FRG.

## Safety rules (non-negotiable, enforced in code)

- **No holder's FRG ever leaves their own wallet.** The ONLY wallet
  that ever sends is the payout wallet.
- **The pool only ever pays what is owed — it does not empty by
  design.** Total paid per run never exceeds the payout wallet's
  actual FRG balance: if total owed ever exceeds the balance, sends
  scale down pro-rata to exactly the balance, the shortfall is
  recorded in the run record, and the unpaid remainder stays owed
  (claimable) for a later press after top-up.
- **Every payout is computed server-side** from registrations,
  snapshots, and the payment ledger. The frontend never decides an
  amount.
- **Crash-safe payments:** each send first writes a `pending`
  payment row (pending counts as paid), then sends, then confirms.
  A crash between send and confirm can never double-pay; a failed
  send voids the pending row and the amount stays owed.
- **Idempotent snapshots:** running a day's snapshot twice records it
  once. A failed snapshot (e.g. an LCD error) records nothing at all.
- **Affiliate bonus is EXTRA, funded from the same reward pot** — never
  deducted from the referral's share or from other holders' shares.
  Consequence the admin must fund for: **one day's total cost =
  the day's split (the pot: the set payout amount, bounded by the
  2,000 FRG hard limit and the pool balance) + referral bonuses.**
  The hard bound at payout time is the payout wallet's actual FRG
  balance.

## Reward-currency migrations (two one-time switches, auditable)

The live reward asset is defined ONCE, in `server/src/assets.js`
(FRG = the CW20 contract; USTC = native `uusd`), and consumed by the
engine metadata, the API `rewardMeta`, payout routing, and the
frontend labels (the page displays the API's symbol — no currency is
hard-coded in the page). Two flag-guarded migrations in `store.js`
(the `reward_currency_migrations` rows are the flags) moved the
program between the two assets; each runs once, in order, and
re-running the server never repeats either:

**Migration #1 — FRG → USTC (the original conversion).** On the first
boot under the USTC code:

1. Every row then in the base `accruals` table (`share` + affiliate
   `bonus`) is copied **verbatim** into `legacy_frg_accruals` — nothing
   is silently deleted.
2. The copied rows are removed from the active accrual ledger, so no
   FRG-denominated amount can ever be collected as USTC. The migration
   record stores the timestamp, the gross archived total, and the
   archived **unpaid** total (accrued − pending/confirmed paid, per
   wallet, floored at zero).
3. The legacy daily-pool number is recorded in the migration row and
   the active pool is **reset to 0** — an old FRG/day value is never
   silently reinterpreted as the same number of USTC/day.
4. The NFT bonus tables are **not** touched: that separate mechanic
   remains FRG-denominated (see the NFT section below).

**Migration #2 — USTC → FRG (owner ruling, 2026-11-05: holders earn
FRG now).** Modeled exactly on migration #1, in reverse: every active
USTC-denominated accrual row is copied verbatim into
`legacy_ustc_accruals` (same netting rule for the unpaid total), then
removed from the active ledger; the daily pool is recorded and reset
to 0 (a USTC/day pot is never silently reinterpreted as FRG/day);
settings `reward_symbol` / `reward_denom` are rewritten to the FRG
descriptor — and those settings are OPERATIVE: the server resolves
the live reward asset from them. Migration #1's row and archive are
never altered. `/api/admin` surfaces the full history as
`rewardMigrations` (plus `rewardMigration` for the first record),
and the admin panel displays any switch that archived rows.

USTC is **not** deleted: its descriptor, the native bank-send path
(`sendUstc`), and its admin balance readout all stay in place as the
**dormant future option** — paying USTC out of validator commission
is the owner's parked plan to drive delegation to LUNC Dev Studio.
Selecting it again is a deliberate future switch, not a config flip
that happens by accident.

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
npm test          # 114 tests, must all pass
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
2. Fund the payout wallet with **FRG for the reward pool plus a little
   LUNC for gas** (base payouts are CW20 transfers of FRG from the
   payout wallet). The owner deposits FRG himself. The admin panel
   shows its live FRG balance (the USTC bank balance is also shown,
   labeled as the dormant future option), so a deposit landing is
   visible before any payout runs.
3. Set `ADMIN_SECRET` in Railway (a secret only the owner knows).
4. With the key absent, the payout button fails safely with "payout
   wallet not configured yet" — no crash, no fake success. With the key present
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
- [ ] Payout wallet funded with FRG (reward pool) + LUNC for gas.
- [x] Wallet connect REMOVED entirely (owner, 2026-11-05): the app
      is paste-only; no WalletConnect, no connect button, no signing
      anywhere. The page carries the copycat warning: a version that
      asks to connect or sign is a fake.
- [ ] Affiliate design session with the owner (rate, rules, wording)
      — the 10% default is proposed, not final.
- [x] Tier table REMOVED by the owner (2026-11-05): the split is
      simple pro-rata by holdings. The daily payout amount ships
      at his chosen $0.50/day total; the hard limit ships at
      2,000 FRG/day.
- [ ] Minimum-holding limit set by the owner — the shipped
      100 FRG default is a PLACEHOLDER until he picks the number.

## Project layout

```text
frg-hold-earn/
  README.md
  frontend/            # Vite + React — PASTE-ONLY, no wallet libraries
    src/
      main.jsx         # plain React root — no wallet providers
      App.jsx          # paste-register / holdings / rewards /
                       # referrals / admin + payout button
      config.js        # FRG token, admin fallback, LCD/RPC/Finder
      chainDef.js wallets.js polyfills.js   # copied LNC-app pattern
      lib/api.js       # backend calls + direct LCD balance
      styles.css       # dark cosmic FRG Universe theme
  server/              # Node + Express, no build step
    src/
      server.js        # endpoints, snapshot runner, admin gating
      engine.js        # pure BigInt earnings math
      store.js         # SQLite storage module (node:sqlite)
      assets.js        # the ONE reward-asset descriptor (FRG live;
                       # USTC dormant future option)
      price.js         # live FRG/USD (pair reserves + CoinPaprika)
                       # for the daily payout amount conversion
      payout.js        # the ONLY sender (base rewards route through
                       # the descriptor: FRG CW20 today; the USTC
                       # native bank-send path stays, dormant)
    tests/
      engine.test.js store.test.js collect.test.js payout.test.js
      payout-run.test.js sampling.test.js nft.test.js migration.test.js
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
  mint fees. Bonus Collect reuses the base payment safety pattern
  (pending counts as paid, failed send voids and stays collectable)
  and never pays more than the tracked bonus pool balance. Sends go
  out through the payout wallet (the only key on the server); the
  bonus pool wallet setting designates where mint fees are collected.
- **All numbers adjustable in the admin panel** (requireAdmin gate):
  collection address, mint price, bonus per NFT per day, fully-powered
  threshold, supply cap, bonus pool wallet. Invalid numbers are
  rejected with a visible error.
- **Honesty rules:** until a real collection address is configured,
  bonus holdings read as zero. NOTE (2026-11-05): the app is now
  paste-only — it cannot sign a mint. The mint-record endpoint and
  its on-chain verification remain server-side, but in-app minting
  is unavailable until/unless the owner chooses a signing route;
  the frontend offers no mint button rather than one that cannot
  work.
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
