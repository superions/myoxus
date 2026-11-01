// SPDX-License-Identifier: AGPL-3.0-or-later
#![recursion_limit = "256"]
//! `myoxus-mcp` — Model Context Protocol server implementation.
//!
//! Implements the MCP Streamable HTTP transport as an Axum route group mounted
//! at `/mcp`. The SDK owns protocol parsing, negotiation and request lifecycle;
//! Myoxus supplies authenticated tool and read-only resource adapters.
//!
//! ## Architecture
//!
//! - [`auth`] — middleware that extracts `Authorization: Bearer`
//!   headers, SHA-256 hashes the key, and resolves `McpAuthContext`.
//! - [`router`] — SDK HTTP service and Myoxus `ServerHandler`.
//! - [`protocol`] — SDK result projections and stable Myoxus errors.
//! - [`tool_registry`] — authoritative tool discovery and metadata.
//! - [`tools`] — tool handler implementations.
//! - [`resources`] — resource handler implementations.
//! - [`subscriptions`] — SSE subscription fanout state.

pub mod auth;
mod idempotency;
#[cfg(test)]
mod output_schema_test_support;
pub mod protocol;
pub mod resources;
pub mod router;
pub mod subscriptions;
pub mod tool_registry;
pub mod tools;

pub use router::mcp_router;
