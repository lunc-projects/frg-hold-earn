// FRG bonus NFT collection — message types.
// This contract is SOURCE ONLY: it is not deployed anywhere, and no
// address in this repo is a live collection. The app treats "no
// collection configured" as zero holdings and minting not open.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Binary, Uint128};
use cw_utils::Expiration;

#[cw_serde]
pub struct InstantiateMsg {
    pub name: String,
    pub symbol: String,
    /// Admin wallet (plain wallet, NOT a factory). Only the admin can
    /// mint directly, update config, or withdraw retained fees.
    pub admin: String,
    /// The FRG CW20 token contract. Paid mints are accepted ONLY as
    /// CW20 receives from this token — any other token is rejected.
    pub frg_token: String,
    /// Mint price in uFRG (base units, 6 decimals). 0 means paid mint
    /// is disabled (a CW20 send of 0 is not a valid payment).
    pub mint_cost: Uint128,
    /// Where mint fees go. When set, every paid mint forwards the fee
    /// here (this is the app's bonus pool wallet). When unset, fees
    /// stay in the contract and the admin can withdraw them.
    pub fee_recipient: Option<String>,
    /// Optional hard cap on total minted tokens. None = unlimited.
    pub max_supply: Option<u64>,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Admin-only direct mint (no payment). For admin distributions.
    Mint { token_id: String, owner: String, token_uri: Option<String> },
    /// CW20 receive hook — the PUBLIC paid mint path. The app mints by
    /// having the buyer's wallet Send FRG to this contract with this
    /// message. The inner message must be exactly {"mint":{}}.
    Receive(Cw20ReceiveMsg),
    /// Admin-only config update. Absent = unchanged. For
    /// fee_recipient / max_supply: null clears (fee stays in contract /
    /// unlimited); a value sets.
    UpdateConfig {
        admin: Option<String>,
        mint_cost: Option<Uint128>,
        fee_recipient: Option<Option<String>>,
        max_supply: Option<Option<u64>>,
    },
    /// Admin-only: withdraw fees retained in the contract (only when
    /// fee_recipient was unset at mint time) to an address — normally
    /// the bonus pool wallet.
    WithdrawFees { recipient: String, amount: Uint128 },
    TransferNft { recipient: String, token_id: String },
    SendNft { contract: String, token_id: String, msg: Binary },
    Approve { spender: String, token_id: String, expires: Option<Expiration> },
    Revoke { spender: String, token_id: String },
    ApproveAll { operator: String, expires: Option<Expiration> },
    RevokeAll { operator: String },
    Burn { token_id: String },
}

#[cw_serde]
pub struct Cw20ReceiveMsg {
    pub sender: String,
    pub amount: Uint128,
    pub msg: Binary,
}

#[cw_serde]
pub enum Cw20ExecuteMsg {
    Transfer { recipient: String, amount: Uint128 },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ContractInfoResponse)]
    ContractInfo {},
    /// Returns the admin as the minter (cw721 tooling convention).
    #[returns(MinterResponse)]
    Minter {},
    #[returns(NumTokensResponse)]
    NumTokens {},
    #[returns(NftInfoResponse)]
    NftInfo { token_id: String },
    #[returns(OwnerOfResponse)]
    OwnerOf { token_id: String, include_expired: Option<bool> },
    #[returns(AllNftInfoResponse)]
    AllNftInfo { token_id: String, include_expired: Option<bool> },
    #[returns(TokensResponse)]
    Tokens { owner: String, start_after: Option<String>, limit: Option<u32> },
    #[returns(TokensResponse)]
    AllTokens { start_after: Option<String>, limit: Option<u32> },
    #[returns(OperatorsResponse)]
    AllOperators {
        owner: String,
        include_expired: Option<bool>,
        start_after: Option<String>,
        limit: Option<u32>,
    },
    #[returns(ApprovalsResponse)]
    Approvals { token_id: String, include_expired: Option<bool> },
    /// App-specific: the mint configuration the app checks before
    /// letting a wallet sign a mint (price, fee recipient, cap, token).
    #[returns(ConfigResponse)]
    Config {},
}

#[cw_serde]
pub struct ContractInfoResponse {
    pub name: String,
    pub symbol: String,
}

#[cw_serde]
pub struct MinterResponse {
    pub minter: String,
}

#[cw_serde]
pub struct NumTokensResponse {
    pub count: u64,
}

#[cw_serde]
pub struct NftInfoResponse {
    pub token_uri: Option<String>,
    pub extension: Option<Extension>,
}

#[cw_serde]
pub struct Extension {
    pub name: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
}

#[cw_serde]
pub struct OwnerOfResponse {
    pub owner: String,
    pub approvals: Vec<Approval>,
}

#[cw_serde]
pub struct Approval {
    pub spender: String,
    pub expires: Expiration,
}

#[cw_serde]
pub struct AllNftInfoResponse {
    pub access: OwnerOfResponse,
    pub info: NftInfoResponse,
}

#[cw_serde]
pub struct TokensResponse {
    pub tokens: Vec<String>,
}

#[cw_serde]
pub struct OperatorsResponse {
    pub operators: Vec<Approval>,
}

#[cw_serde]
pub struct ApprovalsResponse {
    pub approvals: Vec<Approval>,
}

#[cw_serde]
pub struct ConfigResponse {
    pub admin: String,
    pub frg_token: String,
    pub mint_cost: Uint128,
    pub fee_recipient: Option<String>,
    pub max_supply: Option<u64>,
    pub next_token_id: u64,
}
