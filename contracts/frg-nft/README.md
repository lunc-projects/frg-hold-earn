# FRG Bonus NFT Collection (CW721) — SOURCE ONLY, NOT DEPLOYED

A standard CW721 collection for the FRG Hold & Earn app's NFT bonus
section. **Nothing here is live.** No collection address exists yet,
and the app treats "no collection configured" as zero holdings with
minting not open. Do not claim this collection exists until it is
actually deployed and the address is configured in the app's admin
panel.

## What it does

- **Paid public mint (the app's mint flow):** a buyer sends exactly
  `mint_cost` FRG to this contract with the message `{"mint":{}}`.
  The contract mints the next token id to the buyer and forwards the
  full fee to `fee_recipient` — which must be the app's bonus pool
  wallet, so mint fees fund the bonus pool.
- **Admin direct mint:** the admin can mint any token id to any owner
  without payment (for distributions).
- **Standard cw721:** transfer, send, approve/revoke, approve-all,
  operator approvals, burn, and the standard queries (`tokens`,
  `all_tokens`, `num_tokens`, `owner_of`, `nft_info`, `config`).
- **Supply cap:** optional `max_supply` enforced on every mint.

## Security posture (read before deploying)

- **No factory, no shared admin:** the admin is a single plain wallet.
- **NO migrate entry point, by design.** This contract can never be
  migrated. An upgrade needs a fresh deployment and a new collection.
- **Paid mints accept ONLY the configured FRG token, ONLY the exact
  mint price, and ONLY the `{"mint":{}}` message.** Anything else is
  rejected before any state changes.
- **Not audited.** This is new code with unit tests (8 passing), not a
  third-party audit. Review before mainnet use.

## Deploy (owner's wallet required — NOT done by this repo)

1. Build the wasm (already built here for reference):
   `cargo build --release --target wasm32-unknown-unknown`
   (Note: this is a plain release build, not the CosmWasm optimizer
   output. The optimizer produces a smaller artifact; either works.)
2. Store the code on Terra Classic from the owner's wallet, then
   instantiate with:
   - `admin`: the owner's admin wallet
   - `frg_token`: `terra14rfnhc2aru7jp304lht3yf903necsnrt4cxd464cftsfcksw0rtsgundnt`
   - `mint_cost`: the mint price in uFRG (must match the app's admin
     panel mint price exactly)
   - `fee_recipient`: the app's bonus pool wallet (must match the
     app's admin panel bonus pool wallet exactly)
   - `max_supply`: optional cap (must be >= the app's supply cap if
     the app cap is set, or the app will report sold out early)
3. In the app's admin panel, set the collection address to the new
   contract address, plus the matching mint price, bonus per NFT,
   threshold, and bonus pool wallet.
4. The app checks the contract's `config` query before letting any
   wallet sign a mint, and refuses to sign on any mismatch — so keep
   the contract config and the app settings in sync.

## Build & test

- `cargo test --offline` — 8 unit tests (instantiate, admin mint,
  paid mint + fee forwarding, wrong payment/token/message rejection,
  supply cap, transfer clearing approvals, burn).
- `cargo build --release --target wasm32-unknown-unknown` — wasm at
  `target/wasm32-unknown-unknown/release/frg_nft.wasm`.
