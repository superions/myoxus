//! Authentication HTTP route handlers.
//!
//! This module groups the session-based authentication routes ([`base`]) and
//! OAuth2 flow routes ([`oauth`]). The public surface from `base` is
//! re-exported so callers can use `auth::*` without naming the sub-module.

pub mod base;
pub(crate) mod capabilities;
pub mod oauth;
pub(crate) mod oidc;

pub use base::*;
