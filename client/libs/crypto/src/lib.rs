//! Cryptographic utilities for Myoxus clients.
//!
//! This crate provides AGPL-3.0-or-later licensed, clean-room implementations of
//! cryptographic primitives used by the Myoxus desktop and mobile clients.
//!
//! ## Modules
//!
//! - [`hashcash`] — SHA3-256 Hashcash proof-of-work for challenge-response auth
//! - [`napi`] — NAPI bindings (enabled via `napi` feature flag)

pub mod hashcash;
pub mod napi;
