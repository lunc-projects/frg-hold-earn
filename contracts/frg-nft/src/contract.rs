// FRG bonus NFT collection — contract logic.
//
// Security posture, stated plainly (this contract is NOT deployed and
// NOT audited):
// - No factory, no shared admin: the admin is a single plain wallet.
// - NO migrate entry point by design: this contract can never be
//   migrated. An upgrade needs a fresh deployment + a new collection.
// - Paid mints accept ONLY the configured FRG token, ONLY the exact
//   mint price, and ONLY through the {"mint":{}} receive message.
// - The contract never holds users' FRG except fees awaiting an admin
//   withdrawal (only when no fee recipient is set).
// - Token ownership is the bonus source of truth for the app: the app
//   counts tokens per wallet via the standard `tokens` query.

use cosmwasm_std::{
    entry_point, to_json_binary, Addr, Binary, CosmosMsg, Deps, DepsMut, Env,
    MessageInfo, Order, Response, StdResult, Uint128, WasmMsg,
};
use cw2::set_contract_version;
use cw_storage_plus::Bound;
use cw_utils::Expiration;
use serde::{Deserialize, Serialize};

use crate::error::ContractError;
use crate::msg::{
    AllNftInfoResponse, Approval as MsgApproval, ApprovalsResponse, ConfigResponse,
    ContractInfoResponse, Cw20ExecuteMsg, Cw20ReceiveMsg, ExecuteMsg, InstantiateMsg,
    MinterResponse, NftInfoResponse, NumTokensResponse, OperatorsResponse, OwnerOfResponse,
    QueryMsg, TokensResponse,
};
use crate::state::{
    Approval, Config, Token, CONFIG, COUNT, NEXT_ID, OPERATORS, TOKENS, TOKENS_BY_OWNER,
};

const CONTRACT_NAME: &str = "crates.io:frg-nft";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_LIMIT: u32 = 10;
const MAX_LIMIT: u32 = 30;

/// Inner message of a paid mint: exactly {"mint":{}}.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct MintCall {
    mint: Empty,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Empty {}

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    let admin = deps.api.addr_validate(&msg.admin)?;
    let frg_token = deps.api.addr_validate(&msg.frg_token)?;
    let fee_recipient = match msg.fee_recipient {
        Some(a) => Some(deps.api.addr_validate(&a)?),
        None => None,
    };
    CONFIG.save(
        deps.storage,
        &Config {
            name: msg.name,
            symbol: msg.symbol,
            admin,
            frg_token,
            mint_cost: msg.mint_cost,
            fee_recipient,
            max_supply: msg.max_supply,
        },
    )?;
    NEXT_ID.save(deps.storage, &1)?;
    COUNT.save(deps.storage, &0)?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Mint { token_id, owner, token_uri } => {
            execute_mint(deps, info, token_id, owner, token_uri)
        }
        ExecuteMsg::Receive(msg) => execute_receive(deps, info, msg),
        ExecuteMsg::UpdateConfig { admin, mint_cost, fee_recipient, max_supply } => {
            execute_update_config(deps, info, admin, mint_cost, fee_recipient, max_supply)
        }
        ExecuteMsg::WithdrawFees { recipient, amount } => {
            execute_withdraw_fees(deps, info, recipient, amount)
        }
        ExecuteMsg::TransferNft { recipient, token_id } => {
            execute_transfer(deps, env, info, recipient, token_id)
        }
        ExecuteMsg::SendNft { contract, token_id, msg } => {
            execute_send(deps, env, info, contract, token_id, msg)
        }
        ExecuteMsg::Approve { spender, token_id, expires } => {
            execute_approve(deps, env, info, spender, token_id, expires)
        }
        ExecuteMsg::Revoke { spender, token_id } => {
            execute_revoke(deps, env, info, spender, token_id)
        }
        ExecuteMsg::ApproveAll { operator, expires } => {
            execute_approve_all(deps, env, info, operator, expires)
        }
        ExecuteMsg::RevokeAll { operator } => execute_revoke_all(deps, env, info, operator),
        ExecuteMsg::Burn { token_id } => execute_burn(deps, env, info, token_id),
    }
}

fn assert_admin(deps: &DepsMut, sender: &Addr) -> Result<Config, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if *sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    Ok(cfg)
}

fn mint_token(
    deps: &mut DepsMut,
    owner: Addr,
    token_id: String,
    token_uri: Option<String>,
) -> Result<(), ContractError> {
    if token_id.is_empty() {
        return Err(ContractError::InvalidTokenId {});
    }
    if TOKENS.has(deps.storage, token_id.clone()) {
        return Err(ContractError::TokenExists { token_id });
    }
    let cfg = CONFIG.load(deps.storage)?;
    let count = COUNT.load(deps.storage)?;
    if let Some(cap) = cfg.max_supply {
        if count >= cap {
            return Err(ContractError::SupplyCapReached {});
        }
    }
    TOKENS.save(
        deps.storage,
        token_id.clone(),
        &Token { owner: owner.clone(), approvals: vec![], token_uri },
    )?;
    TOKENS_BY_OWNER.save(deps.storage, (owner, token_id), &())?;
    COUNT.save(deps.storage, &(count + 1))?;
    Ok(())
}

fn execute_mint(
    deps: DepsMut,
    info: MessageInfo,
    token_id: String,
    owner: String,
    token_uri: Option<String>,
) -> Result<Response, ContractError> {
    assert_admin(&deps, &info.sender)?;
    let owner = deps.api.addr_validate(&owner)?;
    let mut deps = deps;
    mint_token(&mut deps, owner.clone(), token_id.clone(), token_uri)?;
    Ok(Response::new()
        .add_attribute("action", "mint")
        .add_attribute("token_id", token_id)
        .add_attribute("owner", owner))
}

fn execute_receive(
    deps: DepsMut,
    info: MessageInfo,
    msg: Cw20ReceiveMsg,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    // The CW20 contract calling us must be the FRG token — anything
    // else is rejected before any state changes.
    if info.sender != cfg.frg_token {
        return Err(ContractError::WrongPaymentToken {});
    }
    if cfg.mint_cost.is_zero() {
        return Err(ContractError::MintDisabled {});
    }
    // Inner message must be exactly {"mint":{}}.
    let inner: MintCall = cosmwasm_std::from_json(&msg.msg)
        .map_err(|_| ContractError::InvalidMintMessage {})?;
    let _ = inner;
    if msg.amount != cfg.mint_cost {
        return Err(ContractError::WrongPayment {
            expected: cfg.mint_cost.to_string(),
            got: msg.amount.to_string(),
        });
    }
    let buyer = deps.api.addr_validate(&msg.sender)?;
    let mut deps = deps;
    let id = NEXT_ID.load(deps.storage)?;
    let token_id = id.to_string();
    mint_token(&mut deps, buyer.clone(), token_id.clone(), None)?;
    NEXT_ID.save(deps.storage, &(id + 1))?;
    let mut resp = Response::new()
        .add_attribute("action", "mint")
        .add_attribute("token_id", token_id)
        .add_attribute("buyer", buyer)
        .add_attribute("mint_cost", msg.amount);
    // Forward the fee to the bonus pool wallet when one is set.
    if let Some(recipient) = cfg.fee_recipient {
        resp = resp.add_message(CosmosMsg::Wasm(WasmMsg::Execute {
            contract_addr: cfg.frg_token.to_string(),
            msg: to_json_binary(&Cw20ExecuteMsg::Transfer {
                recipient: recipient.to_string(),
                amount: msg.amount,
            })?,
            funds: vec![],
        }));
    }
    Ok(resp)
}

fn execute_update_config(
    deps: DepsMut,
    info: MessageInfo,
    admin: Option<String>,
    mint_cost: Option<Uint128>,
    fee_recipient: Option<Option<String>>,
    max_supply: Option<Option<u64>>,
) -> Result<Response, ContractError> {
    let mut cfg = assert_admin(&deps, &info.sender)?;
    if let Some(a) = admin {
        cfg.admin = deps.api.addr_validate(&a)?;
    }
    if let Some(m) = mint_cost {
        cfg.mint_cost = m;
    }
    if let Some(f) = fee_recipient {
        cfg.fee_recipient = match f {
            Some(a) => Some(deps.api.addr_validate(&a)?),
            None => None,
        };
    }
    if let Some(m) = max_supply {
        cfg.max_supply = m;
    }
    CONFIG.save(deps.storage, &cfg)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

fn execute_withdraw_fees(
    deps: DepsMut,
    info: MessageInfo,
    recipient: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    let cfg = assert_admin(&deps, &info.sender)?;
    let recipient = deps.api.addr_validate(&recipient)?;
    Ok(Response::new()
        .add_attribute("action", "withdraw_fees")
        .add_message(CosmosMsg::Wasm(WasmMsg::Execute {
            contract_addr: cfg.frg_token.to_string(),
            msg: to_json_binary(&Cw20ExecuteMsg::Transfer {
                recipient: recipient.to_string(),
                amount,
            })?,
            funds: vec![],
        })))
}

/// True when `sender` may move/approve `token`: owner, an unexpired
/// per-token approval, or an unexpired operator approval.
fn can_act(
    deps: &Deps,
    env: &Env,
    sender: &Addr,
    token: &Token,
) -> Result<bool, ContractError> {
    if *sender == token.owner {
        return Ok(true);
    }
    if token
        .approvals
        .iter()
        .any(|a| a.spender == *sender && !a.expires.is_expired(&env.block))
    {
        return Ok(true);
    }
    if let Some(exp) = OPERATORS.may_load(deps.storage, (token.owner.clone(), sender.clone()))? {
        if !exp.is_expired(&env.block) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn transfer_token(
    deps: &mut DepsMut,
    env: &Env,
    info: &MessageInfo,
    recipient: String,
    token_id: String,
) -> Result<(Addr, Addr), ContractError> {
    let recipient = deps.api.addr_validate(&recipient)?;
    let mut token = TOKENS
        .may_load(deps.storage, token_id.clone())?
        .ok_or(ContractError::TokenNotFound { token_id: token_id.clone() })?;
    if !can_act(&deps.as_ref(), env, &info.sender, &token)? {
        return Err(ContractError::Unauthorized {});
    }
    let old_owner = token.owner.clone();
    TOKENS_BY_OWNER.remove(deps.storage, (old_owner.clone(), token_id.clone()));
    // A transfer clears per-token approvals (standard cw721 behavior).
    token.approvals.clear();
    token.owner = recipient.clone();
    TOKENS.save(deps.storage, token_id.clone(), &token)?;
    TOKENS_BY_OWNER.save(deps.storage, (recipient.clone(), token_id), &())?;
    Ok((old_owner, recipient))
}

fn execute_transfer(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    recipient: String,
    token_id: String,
) -> Result<Response, ContractError> {
    let mut deps = deps;
    let (from, to) = transfer_token(&mut deps, &env, &info, recipient, token_id.clone())?;
    Ok(Response::new()
        .add_attribute("action", "transfer_nft")
        .add_attribute("from", from)
        .add_attribute("to", to)
        .add_attribute("token_id", token_id))
}

fn execute_send(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    contract: String,
    token_id: String,
    msg: Binary,
) -> Result<Response, ContractError> {
    let mut deps = deps;
    let contract = deps.api.addr_validate(&contract)?;
    let (from, _) = transfer_token(&mut deps, &env, &info, contract.to_string(), token_id.clone())?;
    // The receive message goes out as a submessage of the same tx:
    // if the recipient rejects it, the transfer rolls back too.
    let receive = CosmosMsg::Wasm(WasmMsg::Execute {
        contract_addr: contract.to_string(),
        msg: to_json_binary(&Cw721ReceiveMsg {
            sender: info.sender.to_string(),
            token_id: token_id.clone(),
            msg,
        })?,
        funds: vec![],
    });
    Ok(Response::new()
        .add_attribute("action", "send_nft")
        .add_attribute("from", from)
        .add_attribute("to", contract)
        .add_attribute("token_id", token_id)
        .add_message(receive))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Cw721ReceiveMsg {
    sender: String,
    token_id: String,
    msg: Binary,
}

fn execute_approve(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    spender: String,
    token_id: String,
    expires: Option<Expiration>,
) -> Result<Response, ContractError> {
    let spender = deps.api.addr_validate(&spender)?;
    let mut token = TOKENS
        .may_load(deps.storage, token_id.clone())?
        .ok_or(ContractError::TokenNotFound { token_id: token_id.clone() })?;
    if !can_act(&deps.as_ref(), &env, &info.sender, &token)? {
        return Err(ContractError::Unauthorized {});
    }
    let expires = expires.unwrap_or(Expiration::Never {});
    token.approvals.retain(|a| a.spender != spender);
    token.approvals.push(Approval { spender: spender.clone(), expires });
    TOKENS.save(deps.storage, token_id.clone(), &token)?;
    Ok(Response::new()
        .add_attribute("action", "approve")
        .add_attribute("spender", spender)
        .add_attribute("token_id", token_id))
}

fn execute_revoke(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    spender: String,
    token_id: String,
) -> Result<Response, ContractError> {
    let spender = deps.api.addr_validate(&spender)?;
    let mut token = TOKENS
        .may_load(deps.storage, token_id.clone())?
        .ok_or(ContractError::TokenNotFound { token_id: token_id.clone() })?;
    if !can_act(&deps.as_ref(), &env, &info.sender, &token)? {
        return Err(ContractError::Unauthorized {});
    }
    let before = token.approvals.len();
    token.approvals.retain(|a| a.spender != spender);
    if token.approvals.len() == before {
        return Err(ContractError::ApprovalNotFound {});
    }
    TOKENS.save(deps.storage, token_id.clone(), &token)?;
    Ok(Response::new()
        .add_attribute("action", "revoke")
        .add_attribute("spender", spender)
        .add_attribute("token_id", token_id))
}

fn execute_approve_all(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    operator: String,
    expires: Option<Expiration>,
) -> Result<Response, ContractError> {
    let operator = deps.api.addr_validate(&operator)?;
    if operator == info.sender {
        return Err(ContractError::Unauthorized {});
    }
    OPERATORS.save(
        deps.storage,
        (info.sender.clone(), operator.clone()),
        &expires.unwrap_or(Expiration::Never {}),
    )?;
    Ok(Response::new()
        .add_attribute("action", "approve_all")
        .add_attribute("operator", operator))
}

fn execute_revoke_all(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    operator: String,
) -> Result<Response, ContractError> {
    let operator = deps.api.addr_validate(&operator)?;
    if !OPERATORS.has(deps.storage, (info.sender.clone(), operator.clone())) {
        return Err(ContractError::OperatorNotFound {});
    }
    OPERATORS.remove(deps.storage, (info.sender.clone(), operator));
    Ok(Response::new().add_attribute("action", "revoke_all"))
}

fn execute_burn(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    token_id: String,
) -> Result<Response, ContractError> {
    let token = TOKENS
        .may_load(deps.storage, token_id.clone())?
        .ok_or(ContractError::TokenNotFound { token_id: token_id.clone() })?;
    if !can_act(&deps.as_ref(), &env, &info.sender, &token)? {
        return Err(ContractError::Unauthorized {});
    }
    TOKENS.remove(deps.storage, token_id.clone());
    TOKENS_BY_OWNER.remove(deps.storage, (token.owner.clone(), token_id.clone()));
    let count = COUNT.load(deps.storage)?;
    COUNT.save(deps.storage, &count.saturating_sub(1))?;
    Ok(Response::new()
        .add_attribute("action", "burn")
        .add_attribute("token_id", token_id))
}

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::ContractInfo {} => {
            let cfg = CONFIG.load(deps.storage)?;
            to_json_binary(&ContractInfoResponse { name: cfg.name, symbol: cfg.symbol })
        }
        QueryMsg::Minter {} => {
            let cfg = CONFIG.load(deps.storage)?;
            to_json_binary(&MinterResponse { minter: cfg.admin.to_string() })
        }
        QueryMsg::NumTokens {} => {
            to_json_binary(&NumTokensResponse { count: COUNT.load(deps.storage)? })
        }
        QueryMsg::NftInfo { token_id } => {
            let token = TOKENS
                .may_load(deps.storage, token_id.clone())?
                .ok_or_else(|| cosmwasm_std::StdError::not_found("token"))?;
            to_json_binary(&NftInfoResponse {
                token_uri: token.token_uri,
                extension: None,
            })
        }
        QueryMsg::OwnerOf { token_id, include_expired } => {
            let token = TOKENS
                .may_load(deps.storage, token_id.clone())?
                .ok_or_else(|| cosmwasm_std::StdError::not_found("token"))?;
            to_json_binary(&OwnerOfResponse {
                owner: token.owner.to_string(),
                approvals: filter_approvals(token.approvals, &env, include_expired),
            })
        }
        QueryMsg::AllNftInfo { token_id, include_expired } => {
            let token = TOKENS
                .may_load(deps.storage, token_id.clone())?
                .ok_or_else(|| cosmwasm_std::StdError::not_found("token"))?;
            to_json_binary(&AllNftInfoResponse {
                access: OwnerOfResponse {
                    owner: token.owner.to_string(),
                    approvals: filter_approvals(token.approvals.clone(), &env, include_expired),
                },
                info: NftInfoResponse { token_uri: token.token_uri, extension: None },
            })
        }
        QueryMsg::Tokens { owner, start_after, limit } => {
            let owner = deps.api.addr_validate(&owner)?;
            let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
            let start = start_after.map(Bound::exclusive);
            let tokens: Vec<String> = TOKENS_BY_OWNER
                .prefix(owner)
                .range(deps.storage, start, None, Order::Ascending)
                .take(limit)
                .map(|r| r.map(|(id, _)| id))
                .collect::<StdResult<_>>()?;
            to_json_binary(&TokensResponse { tokens })
        }
        QueryMsg::AllTokens { start_after, limit } => {
            let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
            let start = start_after.map(Bound::exclusive);
            let tokens: Vec<String> = TOKENS
                .range(deps.storage, start, None, Order::Ascending)
                .take(limit)
                .map(|r| r.map(|(id, _)| id))
                .collect::<StdResult<_>>()?;
            to_json_binary(&TokensResponse { tokens })
        }
        QueryMsg::AllOperators { owner, include_expired, start_after, limit } => {
            let owner = deps.api.addr_validate(&owner)?;
            let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
            let start = match start_after {
                Some(s) => Some(Bound::exclusive(deps.api.addr_validate(&s)?)),
                None => None,
            };
            let operators: Vec<MsgApproval> = OPERATORS
                .prefix(owner)
                .range(deps.storage, start, None, Order::Ascending)
                .take(limit)
                .map(|r| {
                    r.map(|(op, exp)| MsgApproval { spender: op.to_string(), expires: exp })
                })
                .collect::<StdResult<_>>()?;
            let operators = if include_expired.unwrap_or(false) {
                operators
            } else {
                operators.into_iter().filter(|a| !a.expires.is_expired(&env.block)).collect()
            };
            to_json_binary(&OperatorsResponse { operators })
        }
        QueryMsg::Approvals { token_id, include_expired } => {
            let token = TOKENS
                .may_load(deps.storage, token_id.clone())?
                .ok_or_else(|| cosmwasm_std::StdError::not_found("token"))?;
            to_json_binary(&ApprovalsResponse {
                approvals: filter_approvals(token.approvals, &env, include_expired),
            })
        }
        QueryMsg::Config {} => {
            let cfg = CONFIG.load(deps.storage)?;
            to_json_binary(&ConfigResponse {
                admin: cfg.admin.to_string(),
                frg_token: cfg.frg_token.to_string(),
                mint_cost: cfg.mint_cost,
                fee_recipient: cfg.fee_recipient.map(|a| a.to_string()),
                max_supply: cfg.max_supply,
                next_token_id: NEXT_ID.load(deps.storage)?,
            })
        }
    }
}

fn filter_approvals(
    approvals: Vec<Approval>,
    env: &Env,
    include_expired: Option<bool>,
) -> Vec<MsgApproval> {
    let keep_all = include_expired.unwrap_or(false);
    approvals
        .into_iter()
        .filter(|a| keep_all || !a.expires.is_expired(&env.block))
        .map(|a| MsgApproval { spender: a.spender.to_string(), expires: a.expires })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::{from_json, Uint128};

    const ADMIN: &str = "terra1admin00000000000000000000000000000";
    const FRG: &str = "terra14rfnhc2aru7jp304lht3yf903necsnrt4cxd464cftsfcksw0rtsgundnt";
    const BUYER: &str = "terra1buyer00000000000000000000000000000";
    const POOL: &str = "terra1pool000000000000000000000000000000";

    fn setup(max_supply: Option<u64>, fee_recipient: Option<String>) -> cosmwasm_std::OwnedDeps<
        cosmwasm_std::MemoryStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    > {
        let mut deps = mock_dependencies();
        instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("creator", &[]),
            InstantiateMsg {
                name: "FRG Battery".to_string(),
                symbol: "FRGB".to_string(),
                admin: ADMIN.to_string(),
                frg_token: FRG.to_string(),
                mint_cost: Uint128::new(1_000_000_000),
                fee_recipient,
                max_supply,
            },
        )
        .unwrap();
        deps
    }

    fn paid_mint_msg(sender: &str, amount: u128) -> (MessageInfo, Cw20ReceiveMsg) {
        let inner = to_json_binary(&serde_json_lite::mint_call()).unwrap();
        (
            mock_info(FRG, &[]),
            Cw20ReceiveMsg { sender: sender.to_string(), amount: Uint128::new(amount), msg: inner },
        )
    }

    #[test]
    fn instantiate_sets_config() {
        let deps = setup(None, Some(POOL.to_string()));
        let cfg: ConfigResponse =
            from_json(&query(deps.as_ref(), mock_env(), QueryMsg::Config {}).unwrap()).unwrap();
        assert_eq!(cfg.admin, ADMIN);
        assert_eq!(cfg.frg_token, FRG);
        assert_eq!(cfg.mint_cost, Uint128::new(1_000_000_000));
        assert_eq!(cfg.fee_recipient.as_deref(), Some(POOL));
        assert_eq!(cfg.next_token_id, 1);
    }

    #[test]
    fn admin_mint_and_queries() {
        let mut deps = setup(None, None);
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info(ADMIN, &[]),
            ExecuteMsg::Mint { token_id: "nft-1".to_string(), owner: BUYER.to_string(), token_uri: None },
        )
        .unwrap();
        let owner: OwnerOfResponse = from_json(
            &query(deps.as_ref(), mock_env(), QueryMsg::OwnerOf { token_id: "nft-1".to_string(), include_expired: None }).unwrap(),
        )
        .unwrap();
        assert_eq!(owner.owner, BUYER);
        let tokens: TokensResponse = from_json(
            &query(deps.as_ref(), mock_env(), QueryMsg::Tokens { owner: BUYER.to_string(), start_after: None, limit: None }).unwrap(),
        )
        .unwrap();
        assert_eq!(tokens.tokens, vec!["nft-1".to_string()]);
        let num: NumTokensResponse =
            from_json(&query(deps.as_ref(), mock_env(), QueryMsg::NumTokens {}).unwrap()).unwrap();
        assert_eq!(num.count, 1);
    }

    #[test]
    fn non_admin_mint_is_rejected() {
        let mut deps = setup(None, None);
        let err = execute(
            deps.as_mut(),
            mock_env(),
            mock_info(BUYER, &[]),
            ExecuteMsg::Mint { token_id: "x".to_string(), owner: BUYER.to_string(), token_uri: None },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));
    }

    #[test]
    fn paid_mint_forwards_fee_to_pool_wallet() {
        let mut deps = setup(None, Some(POOL.to_string()));
        let (info, msg) = paid_mint_msg(BUYER, 1_000_000_000);
        let res = execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Receive(msg)).unwrap();
        // One submessage: FRG transfer of the full fee to the pool wallet.
        assert_eq!(res.messages.len(), 1);
        let owner: OwnerOfResponse = from_json(
            &query(deps.as_ref(), mock_env(), QueryMsg::OwnerOf { token_id: "1".to_string(), include_expired: None }).unwrap(),
        )
        .unwrap();
        assert_eq!(owner.owner, BUYER);
        let cfg: ConfigResponse =
            from_json(&query(deps.as_ref(), mock_env(), QueryMsg::Config {}).unwrap()).unwrap();
        assert_eq!(cfg.next_token_id, 2);
    }

    #[test]
    fn paid_mint_wrong_amount_wrong_token_and_bad_message_rejected() {
        let mut deps = setup(None, Some(POOL.to_string()));
        let (info, msg) = paid_mint_msg(BUYER, 999);
        assert!(execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Receive(msg)).is_err());
        let (mut info, msg) = paid_mint_msg(BUYER, 1_000_000_000);
        info.sender = Addr::unchecked("terra1other0000000000000000000000000000");
        assert!(execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Receive(msg)).is_err());
        let bad_msg = Cw20ReceiveMsg {
            sender: BUYER.to_string(),
            amount: Uint128::new(1_000_000_000),
            msg: to_json_binary(&serde_json_lite::not_mint()).unwrap(),
        };
        assert!(execute(
            deps.as_mut(),
            mock_env(),
            mock_info(FRG, &[]),
            ExecuteMsg::Receive(bad_msg)
        )
        .is_err());
    }

    #[test]
    fn supply_cap_is_enforced() {
        let mut deps = setup(Some(1), None);
        let (info, msg) = paid_mint_msg(BUYER, 1_000_000_000);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Receive(msg)).unwrap();
        let (info, msg) = paid_mint_msg(BUYER, 1_000_000_000);
        assert!(execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Receive(msg)).is_err());
    }

    #[test]
    fn transfer_clears_approvals_and_moves_index() {
        let mut deps = setup(None, None);
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info(ADMIN, &[]),
            ExecuteMsg::Mint { token_id: "t1".to_string(), owner: BUYER.to_string(), token_uri: None },
        )
        .unwrap();
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info(BUYER, &[]),
            ExecuteMsg::Approve { spender: POOL.to_string(), token_id: "t1".to_string(), expires: None },
        )
        .unwrap();
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info(BUYER, &[]),
            ExecuteMsg::TransferNft { recipient: POOL.to_string(), token_id: "t1".to_string() },
        )
        .unwrap();
        let owner: OwnerOfResponse = from_json(
            &query(deps.as_ref(), mock_env(), QueryMsg::OwnerOf { token_id: "t1".to_string(), include_expired: None }).unwrap(),
        )
        .unwrap();
        assert_eq!(owner.owner, POOL);
        assert!(owner.approvals.is_empty());
        let tokens: TokensResponse = from_json(
            &query(deps.as_ref(), mock_env(), QueryMsg::Tokens { owner: BUYER.to_string(), start_after: None, limit: None }).unwrap(),
        )
        .unwrap();
        assert!(tokens.tokens.is_empty());
    }

    #[test]
    fn burn_removes_token_and_decrements_count() {
        let mut deps = setup(None, None);
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info(ADMIN, &[]),
            ExecuteMsg::Mint { token_id: "b1".to_string(), owner: BUYER.to_string(), token_uri: None },
        )
        .unwrap();
        execute(
            deps.as_mut(),
            mock_env(),
            mock_info(BUYER, &[]),
            ExecuteMsg::Burn { token_id: "b1".to_string() },
        )
        .unwrap();
        let num: NumTokensResponse =
            from_json(&query(deps.as_ref(), mock_env(), QueryMsg::NumTokens {}).unwrap()).unwrap();
        assert_eq!(num.count, 0);
        assert!(query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::OwnerOf { token_id: "b1".to_string(), include_expired: None }
        )
        .is_err());
    }
}

// Tiny JSON helpers for tests without adding a serde_json dependency.
#[cfg(test)]
mod serde_json_lite {
    use super::*;

    pub fn mint_call() -> MintCall {
        MintCall { mint: Empty {} }
    }

    pub fn not_mint() -> OtherCall {
        OtherCall { transfer: Empty {} }
    }

    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    pub struct OtherCall {
        pub transfer: Empty,
    }
}

