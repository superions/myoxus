//! Compile-time manifest of the Myoxus core database schema.
//!
//! [`CORE_SCHEMA_TABLES`] lists required tables across core features. The migration
//! runner checks the full product table count.  [`EXPLICITLY_EXCLUDED_BILLING_TABLE_HINTS`] documents
//! table-name patterns that must never appear, providing a machine-readable
//! guard against accidental reintroduction of billing infrastructure.

/// Required core PostgreSQL tables covered by the schema manifest.
///
/// This list is used by migration verification tooling and integration tests.
pub const CORE_SCHEMA_TABLES: &[&str] = &[
  "users",
  "user_preferences",
  "sessions",
  "verification_tokens",
  "access_tokens",
  "connected_accounts",
  "magic_link_otps",
  "workspaces",
  "workspace_memberships",
  "workspace_invite_links",
  "docs",
  "doc_user_permissions",
  "doc_updates",
  "doc_histories",
  "blobs",
  "comment_attachments",
  "comments",
  "notifications",
  "metrics_raw",
  "metrics_daily",
  "search_content",
  "calendar_accounts",
  "calendar_subscriptions",
  "workspace_calendars",
  "calendar_events",
  "calendar_event_instances",
  "calendar_event_participants",
  "calendar_reminders",
  "copilot_sessions",
  "copilot_messages",
  "copilot_contexts",
  "copilot_context_items",
  "copilot_jobs",
  "copilot_workspaces",
  "outbox_events",
  "search_reindex_runs",
];

/// Table-name substrings that are explicitly banned from the Myoxus schema.
///
/// Any migration that introduces a table whose name contains one of these
/// strings should be rejected — these names belong to the billing subsystem
/// that is permanently out of scope.
pub const EXPLICITLY_EXCLUDED_BILLING_TABLE_HINTS: &[&str] = &[
  "subscription",
  "invoice",
  "payment",
  "price",
  "license",
  "workspace_seat",
  "quota",
  "customer_portal",
];
