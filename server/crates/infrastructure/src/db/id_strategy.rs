//! Compile-time documentation of the primary-key strategy used across the
//! Myoxus database schema.
//!
//! These constants are not executed at runtime; they serve as an authoritative
//! reference for schema reviewers and migration tooling.

/// High-level rules governing primary-key selection.
///
/// These guidelines apply to all new tables added to the Myoxus schema.
pub const ID_STRATEGY_SUMMARY: &[&str] = &[
  "Use UUID primary keys for externally referenced entities.",
  "Use BIGINT identity keys for append-only high-volume streams where ordering matters.",
  "Preserve imported legacy IDs where migration safety requires stable references.",
  "Do not encode pricing, quota, plan, or billing state in identifier semantics.",
];

/// Tables that use UUID primary keys.
///
/// UUIDs are preferred for entities that are referenced by external systems
/// (clients, webhooks, public APIs) so that IDs do not leak internal
/// sequencing information.
pub const UUID_TABLES: &[&str] = &[
  "users",
  "sessions",
  "verification_tokens",
  "access_tokens",
  "connected_accounts",
  "magic_link_otps",
  "workspaces",
  "workspace_invite_links",
  "docs",
  "blobs",
  "multipart_uploads",
  "comment_attachments",
  "comments",
  "notifications",
  "calendar_accounts",
  "calendar_subscriptions",
  "calendar_events",
  "calendar_event_instances",
  "copilot_sessions",
  "copilot_messages",
  "copilot_contexts",
  "copilot_context_items",
  "copilot_jobs",
];

/// Tables that use BIGINT (identity/serial) primary keys.
///
/// BIGINT keys are used for high-volume append-only streams (e.g. Yjs update
/// logs and document history) where compact integer ordering is valuable and
/// IDs are never exposed to external clients.
pub const BIGINT_STREAM_TABLES: &[&str] = &["doc_updates", "doc_histories"];
