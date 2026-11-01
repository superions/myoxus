//! GraphQL types for runtime logging configuration (P33-C).

use chrono::{DateTime, Utc};

/// GraphQL enum for log levels — exposed so the frontend can enumerate valid values.
/// The level field in GqlLogModuleLevel uses String for backward compatibility,
/// but this enum is registered in the schema for introspection (P33-F-03).
#[derive(async_graphql::Enum, Clone, Copy, PartialEq, Eq, Debug)]
#[graphql(name = "LogLevel", rename_items = "PascalCase")]
pub enum GqlLogLevel {
  Trace,
  Debug,
  Info,
  Warn,
  Error,
}

/// GraphQL enum for log output rotation policy.
#[derive(async_graphql::Enum, Clone, Copy, PartialEq, Eq, Debug)]
#[graphql(name = "LogRotation", rename_items = "PascalCase")]
pub enum GqlLogRotation {
  Never,
  Hourly,
  Daily,
  Weekly,
}

#[derive(async_graphql::SimpleObject)]
pub struct GqlLogModuleLevel {
  pub group: String,
  pub display_name: String,
  pub level: String,
  pub recommended_default: String,
  pub description: String,
  pub high_volume_warning: bool,
}

#[derive(async_graphql::SimpleObject)]
pub struct GqlLogOutputConfig {
  pub file_path: Option<String>,
  pub rotation: GqlLogRotation,
  pub max_files: i32,
  pub path_valid: bool,
  pub path_error: Option<String>,
  /// Whether a server restart is required for the output changes to take effect.
  pub requires_restart: bool,
}

#[derive(async_graphql::SimpleObject)]
pub struct GqlLogDiskUsage {
  pub total_bytes: i64,
  pub file_count: i32,
  pub free_bytes: i64,
}

#[derive(async_graphql::SimpleObject)]
pub struct GqlLogChangeEntry {
  pub timestamp: DateTime<Utc>,
  pub group: String,
  pub previous_level: String,
  pub new_level: String,
  pub changed_by: String,
  pub auto_revert_at: Option<DateTime<Utc>>,
}

#[derive(async_graphql::SimpleObject)]
pub struct GqlLoggingConfig {
  pub modules: Vec<GqlLogModuleLevel>,
  pub output: GqlLogOutputConfig,
  pub recent_changes: Vec<GqlLogChangeEntry>,
  pub disk_usage: GqlLogDiskUsage,
  /// Available log level values for frontend dropdowns. Registers LogLevel enum in schema.
  pub available_levels: Vec<GqlLogLevel>,
}

#[derive(async_graphql::InputObject, Debug)]
pub struct UpdateLogModuleLevelInput {
  pub group: String,
  pub level: String,
  #[graphql(name = "autoRevertMinutes")]
  pub auto_revert_minutes: Option<i32>,
}

#[derive(async_graphql::InputObject, Debug)]
pub struct UpdateLogOutputInput {
  #[graphql(name = "filePath")]
  pub file_path: Option<String>,
  pub rotation: Option<String>,
  #[graphql(name = "maxFiles")]
  pub max_files: Option<i32>,
}
