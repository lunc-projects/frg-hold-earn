// FRG bonus NFT collection — entry points (see contract.rs).
// NOT DEPLOYED: this crate is source only. Deploying needs the
// owner's wallet (see README.md in this directory).

pub mod contract;
pub mod error;
pub mod msg;
pub mod state;

pub use crate::contract::{execute, instantiate, query};
