// FRG bonus NFT collection — errors.

use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Token already exists: {token_id}")]
    TokenExists { token_id: String },

    #[error("Token not found: {token_id}")]
    TokenNotFound { token_id: String },

    #[error("Invalid token id")]
    InvalidTokenId {},

    #[error("Minting is disabled: mint cost is 0")]
    MintDisabled {},

    #[error("Wrong mint payment: expected {expected} uFRG, got {got} uFRG")]
    WrongPayment { expected: String, got: String },

    #[error("Only the FRG token contract can pay for mints")]
    WrongPaymentToken {},

    #[error("Invalid mint message: expected {{\"mint\":{{}}}}")]
    InvalidMintMessage {},

    #[error("Supply cap reached")]
    SupplyCapReached {},

    #[error("Approval not found")]
    ApprovalNotFound {},

    #[error("Operator not found")]
    OperatorNotFound {},
}
