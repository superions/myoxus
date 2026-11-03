//! `myoxus-domain` — pure domain types for the Myoxus server.
//!
//! This crate contains the core building blocks of the Myoxus business domain:
//!
//! - **[`entities`]** — structs and enums representing domain objects
//!   (users, workspaces, documents, etc.) with no I/O dependencies.
//! - **[`ids`]** — strongly-typed [`uuid::Uuid`] aliases for every entity so
//!   that identifiers cannot be accidentally mixed up at compile time.
//! - **[`permission`]** — role-to-action mappings for workspace and document
//!   access control, plus [`permission::fixup_doc_role`].
//! - **[`repositories`]** — `async_trait` repository port definitions that the
//!   infrastructure layer must implement.
//!
//! This crate intentionally has **no runtime dependencies** beyond `uuid`,
//! `chrono`, `serde`, and `async-trait`.  It must never import code from the
//! `application` or `infrastructure` crates.

pub mod assistant_package;
pub mod audit;
pub mod calendar_scheduling;
pub mod captcha;
pub mod color;
pub mod copilot_turn;
pub mod database;
pub mod database_activity;
pub mod database_change;
pub mod document_graph;
pub mod document_key;
pub mod entities;
pub mod feature_bundle;
pub mod git_sync;
pub mod ids;
pub mod metrics;
pub mod pdf_template_manifest;
pub mod permission;
pub mod recurrence;
pub mod repositories;
pub mod scheduling;
pub mod telemetry;
pub mod template_registry;
pub mod transcription;
pub mod workspace_automation;
pub mod workspace_content_operation;
pub mod workspace_import;
pub mod workspace_overview;
pub mod workspace_tags;
