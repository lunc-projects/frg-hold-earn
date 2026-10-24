// FRG bonus NFT collection — storage layout.
// Token ids are strings (paid mints use auto-incrementing numeric
// ids; admin mints may use any unique string). AllTokens ordering is
// lexicographic on the string id — the standard cw721 behavior.

use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::{Item, Map};
use cw_utils::Expiration;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub name: String,
    pub symbol: String,
    pub admin: Addr,
    pub frg_token: Addr,
    pub mint_cost: Uint128,
    pub fee_recipient: Option<Addr>,
    pub max_supply: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Token {
    pub owner: Addr,
    pub approvals: Vec<Approval>,
    pub token_uri: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Approval {
    pub spender: Addr,
    pub expires: Expiration,
}

pub const CONFIG: Item<Config> = Item::new("config");
/// Next auto-assigned token id for paid mints (starts at 1).
pub const NEXT_ID: Item<u64> = Item::new("next_id");
/// Total minted tokens (for the supply cap and NumTokens).
pub const COUNT: Item<u64> = Item::new("count");
pub const TOKENS: Map<String, Token> = Map::new("tokens");
/// Owner index for the tokens query: (owner, token_id) -> ().
pub const TOKENS_BY_OWNER: Map<(Addr, String), ()> = Map::new("tokens_by_owner");
/// Operator approvals: (owner, operator) -> expiration.
pub const OPERATORS: Map<(Addr, Addr), Expiration> = Map::new("operators");
