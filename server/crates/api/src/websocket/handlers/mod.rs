//! Per-event handler implementations for the WS layer.
//!
//! Each submodule contains the handler function(s) for one category of
//! Socket.IO events. `mod.rs::on_connect` registers them as thin
//! Wrapper-Closures; actual logic lives here.
//!
//! Extracted from `mod.rs` in P107-I (doc handlers) and P108 (all others).

pub(super) mod awareness;
pub(super) mod copilot;
pub(super) mod database;
pub(super) mod disconnect;
pub(super) mod doc;
pub(super) mod notification;
pub(super) mod space;
pub(super) mod subscriptions;
pub(super) mod telemetry;
