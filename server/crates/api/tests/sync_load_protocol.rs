//! Focused real Socket.IO document-load protocol target.
//!
//! The unified integration binary intentionally owns broad cross-domain
//! coverage, but its link cost can exhaust the quick-gate timeout before this
//! latency-sensitive sync regression executes. Keep the production router,
//! PostgreSQL helpers and assertions in the shared source module while giving
//! this contract one bounded executable target.

#![allow(
  clippy::await_holding_lock,
  clippy::doc_overindented_list_items,
  clippy::duplicate_mod,
  clippy::type_complexity,
  dead_code,
  non_snake_case,
  unused_imports
)]

#[path = "support/helpers.rs"]
mod helpers;
#[path = "realtime/yjs_ingress_validation_test.rs"]
mod yjs_ingress_validation_test;
