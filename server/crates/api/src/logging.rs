//! Modular runtime-configurable logging service.
//!
//! Maps functional log groups (api, websocket, auth, ...) to Rust module
//! paths, builds EnvFilter directive strings, and supports runtime level
//! changes via tracing_subscriber::reload::Handle.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::str::FromStr;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// LogLevel enum
// ---------------------------------------------------------------------------

/// Tracing log level for a module group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
  Trace,
  Debug,
  Info,
  Warn,
  Error,
}

impl fmt::Display for LogLevel {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    let s = match self {
      LogLevel::Trace => "trace",
      LogLevel::Debug => "debug",
      LogLevel::Info => "info",
      LogLevel::Warn => "warn",
      LogLevel::Error => "error",
    };
    f.write_str(s)
  }
}

impl FromStr for LogLevel {
  type Err = String;

  fn from_str(s: &str) -> Result<Self, Self::Err> {
    match s.to_ascii_lowercase().as_str() {
      "trace" => Ok(LogLevel::Trace),
      "debug" => Ok(LogLevel::Debug),
      "info" => Ok(LogLevel::Info),
      "warn" | "warning" => Ok(LogLevel::Warn),
      "error" => Ok(LogLevel::Error),
      other => Err(format!("unknown log level: {other}")),
    }
  }
}

// ---------------------------------------------------------------------------
// LogGroup — static definition of each functional log group
// ---------------------------------------------------------------------------

/// Static definition of a functional log group.
pub struct LogGroup {
  /// Short machine-readable key: `"api"`, `"websocket"`, etc.
  pub group: &'static str,
  /// Human-readable display name.
  pub display_name: &'static str,
  /// Brief description of what this group covers.
  pub description: &'static str,
  /// Rust module path prefixes whose log output belongs to this group.
  pub rust_modules: &'static [&'static str],
  /// Recommended default level for production use.
  pub recommended_default: LogLevel,
  /// `true` for groups that are extremely verbose at trace/debug level.
  pub high_volume_warning: bool,
}

/// All functional log groups exposed through the Admin logging API.
pub static LOG_GROUPS: &[LogGroup] = &[
  LogGroup {
    group: "api",
    display_name: "API & Handlers",
    description: "REST/GraphQL request handling",
    rust_modules: &["myoxus_api::handlers", "myoxus_api::graphql"],
    recommended_default: LogLevel::Info,
    high_volume_warning: false,
  },
  LogGroup {
    group: "websocket",
    display_name: "WebSocket / Sync",
    description: "Socket.IO real-time layer and storage sync",
    rust_modules: &[
      "myoxus_api::websocket",
      "myoxus_application::doc",
      "myoxus_infrastructure::doc",
      "yjs",
    ],
    recommended_default: LogLevel::Info,
    high_volume_warning: true,
  },
  LogGroup {
    group: "auth",
    display_name: "Authentication",
    description: "Authentication, sessions, OAuth",
    rust_modules: &[
      "myoxus_application::auth",
      "myoxus_api::auth",
      "myoxus_application::organization::oidc_sync",
    ],
    recommended_default: LogLevel::Info,
    high_volume_warning: false,
  },
  LogGroup {
    group: "database",
    display_name: "Database",
    description: "SQL query logging (sqlx)",
    rust_modules: &["sqlx::query"],
    recommended_default: LogLevel::Warn,
    high_volume_warning: true,
  },
  LogGroup {
    group: "sync_protocol",
    display_name: "Sync Protocol",
    description: "Low-level WebSocket transport (tungstenite)",
    rust_modules: &["tungstenite", "tokio_tungstenite"],
    recommended_default: LogLevel::Warn,
    high_volume_warning: true,
  },
  LogGroup {
    group: "workers",
    display_name: "Worker & Jobs",
    description: "Background job processing (BullMQ-compatible)",
    rust_modules: &[
      "myoxus_worker",
      "myoxus_application::transcription",
      "myoxus_infrastructure::transcription",
      "myoxus_application::workspace_content_operation",
      "myoxus_infrastructure::workspace_content_operation",
      "myoxus_api::workspace_content_worker",
      "myoxus_api::workspace_content_coordination",
    ],
    recommended_default: LogLevel::Info,
    high_volume_warning: false,
  },
  LogGroup {
    group: "copilot",
    display_name: "Copilot",
    description: "AI copilot service and sessions",
    rust_modules: &["myoxus_api::graphql::auth::copilot"],
    recommended_default: LogLevel::Info,
    high_volume_warning: false,
  },
  LogGroup {
    group: "mcp",
    display_name: "MCP Server",
    description: "Model Context Protocol server",
    rust_modules: &["myoxus_mcp"],
    recommended_default: LogLevel::Info,
    high_volume_warning: false,
  },
  LogGroup {
    group: "public_publishing",
    display_name: "Public Publishing",
    description: "Anonymous public routes, static export, public rendering, search and social previews",
    rust_modules: &[
      "myoxus_api::handlers::public",
      "myoxus_application::public",
      "myoxus_infrastructure::public",
      "myoxus_public_render",
      "myoxus_cli::public",
    ],
    recommended_default: LogLevel::Info,
    high_volume_warning: false,
  },
  LogGroup {
    group: "git_sync",
    display_name: "Git Sync",
    description: "Git synchronization engine",
    rust_modules: &["myoxus_api::git_sync_engine", "myoxus_infrastructure::git_sync"],
    recommended_default: LogLevel::Info,
    high_volume_warning: false,
  },
  LogGroup {
    group: "storage",
    display_name: "Storage",
    description: "Blob storage (opendal, local/S3)",
    rust_modules: &[
      "opendal",
      "myoxus_infrastructure::storage",
      "myoxus_infrastructure::blob",
    ],
    recommended_default: LogLevel::Info,
    high_volume_warning: false,
  },
  LogGroup {
    group: "http_internals",
    display_name: "HTTP Internals",
    description: "Low-level HTTP transport (hyper, h2, tower, TLS)",
    rust_modules: &["hyper", "h2", "tower_http", "axum::serve", "rustls", "reqwest"],
    recommended_default: LogLevel::Warn,
    high_volume_warning: true,
  },
  LogGroup {
    group: "template_registry",
    display_name: "Template Registry",
    description: "Template import, publish, reconcile, drift scan",
    rust_modules: &[
      "myoxus_application::template_registry",
      "myoxus_infrastructure::template_registry",
      "myoxus_api::graphql::template_registry",
    ],
    recommended_default: LogLevel::Info,
    high_volume_warning: false,
  },
];

// ---------------------------------------------------------------------------
// LogChangeEntry — audit trail for level changes
// ---------------------------------------------------------------------------

/// One entry in the change history ring buffer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogChangeEntry {
  pub timestamp: DateTime<Utc>,
  pub group: String,
  pub previous_level: LogLevel,
  pub new_level: LogLevel,
  pub changed_by: String,
  pub auto_revert_at: Option<DateTime<Utc>>,
}

// ---------------------------------------------------------------------------
// LogModuleLevelInfo — returned by current_levels()
// ---------------------------------------------------------------------------

/// Current state of a single log group, returned by `current_levels()`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogModuleLevelInfo {
  pub group: String,
  pub display_name: String,
  pub description: String,
  pub current_level: LogLevel,
  pub recommended_default: LogLevel,
  pub high_volume_warning: bool,
}

// ---------------------------------------------------------------------------
// ReloadFn — type-erased handle to reload the EnvFilter
// ---------------------------------------------------------------------------

/// Type-erased function that reloads the tracing EnvFilter at runtime.
///
/// The concrete closure captures the `reload::Handle<EnvFilter, S>` and calls
/// `handle.reload(new_filter)`. This decouples `LoggingService` from the
/// concrete subscriber layer stack type.
pub type ReloadFn = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

// ---------------------------------------------------------------------------
// LoggingService
// ---------------------------------------------------------------------------

/// Default maximum number of change history entries to keep.
const DEFAULT_MAX_HISTORY: usize = 20;

/// Runtime-configurable logging service.
///
/// Manages per-group log levels, builds EnvFilter directive strings, and
/// pushes changes to the tracing subscriber via a type-erased reload handle.
pub struct LoggingService {
  /// Current level per group key.
  levels: RwLock<HashMap<String, LogLevel>>,
  /// Type-erased reload function.
  reload_fn: ReloadFn,
  /// Change history (ring buffer, max [`max_history`] entries).
  history: RwLock<VecDeque<LogChangeEntry>>,
  /// Global fallback level (used for modules not covered by any group).
  global_level: LogLevel,
  /// Maximum number of change history entries to keep.
  max_history: usize,
}

impl LoggingService {
  /// Create a new `LoggingService` with default max history.
  ///
  /// Initializes per-group levels from `config_modules` (a map of group
  /// name to level string from config). Groups not present in the map fall
  /// back to their `recommended_default`.
  pub fn new(config_modules: &HashMap<String, String>, global_level: LogLevel, reload_fn: ReloadFn) -> Self {
    Self::new_with_max_history(config_modules, global_level, reload_fn, DEFAULT_MAX_HISTORY)
  }

  /// Create a new `LoggingService` with explicit max history size.
  pub fn new_with_max_history(
    config_modules: &HashMap<String, String>,
    global_level: LogLevel,
    reload_fn: ReloadFn,
    max_history: usize,
  ) -> Self {
    let mut levels = HashMap::new();
    for group in LOG_GROUPS {
      let level = config_modules
        .get(group.group)
        .and_then(|s| LogLevel::from_str(s).ok())
        .unwrap_or(group.recommended_default);
      levels.insert(group.group.to_string(), level);
    }
    Self {
      levels: RwLock::new(levels),
      reload_fn,
      history: RwLock::new(VecDeque::new()),
      global_level,
      max_history,
    }
  }

  /// Build the complete EnvFilter directive string from current levels.
  pub async fn build_env_filter_string(&self) -> String {
    let levels = self.levels.read().await;
    let mut directives: Vec<String> = Vec::new();

    // Global fallback first
    directives.push(self.global_level.to_string());

    // Per-group module directives
    for group in LOG_GROUPS {
      let level = levels.get(group.group).copied().unwrap_or(group.recommended_default);
      for module_path in group.rust_modules {
        directives.push(format!("{module_path}={level}"));
      }
    }

    directives.join(",")
  }

  /// Apply the current levels to the tracing subscriber.
  async fn apply(&self) -> Result<(), String> {
    let filter_str = self.build_env_filter_string().await;
    (self.reload_fn)(&filter_str)
  }

  /// Apply a complete canonical `logging.level` filter received from the
  /// consolidated configuration refresh and synchronize the group projection
  /// shown by Admin. No history entry is created for cross-instance refreshes.
  pub async fn apply_canonical_filter(&self, filter: &str) -> Result<(), String> {
    (self.reload_fn)(filter)?;
    let directives = filter.split(',').map(str::trim).collect::<Vec<_>>();
    let mut levels = self.levels.write().await;
    for group in LOG_GROUPS {
      let level = group.rust_modules.iter().find_map(|module| {
        directives.iter().find_map(|directive| {
          directive
            .strip_prefix(module)
            .and_then(|suffix| suffix.strip_prefix('='))
            .and_then(|level| LogLevel::from_str(level).ok())
        })
      });
      if let Some(level) = level {
        levels.insert(group.group.to_string(), level);
      }
    }
    Ok(())
  }

  /// Update the log level of a single group.
  ///
  /// Validates the group name, updates the level, rebuilds and reloads
  /// the EnvFilter, records history, and optionally spawns an auto-revert
  /// task.
  pub async fn update_level(
    &self,
    group: &str,
    level: LogLevel,
    changed_by: &str,
    auto_revert_minutes: Option<u32>,
  ) -> Result<LogModuleLevelInfo, String> {
    // Validate group name
    let group_def = LOG_GROUPS
      .iter()
      .find(|g| g.group == group)
      .ok_or_else(|| format!("unknown log group: {group}"))?;

    let previous_level;
    {
      let mut levels = self.levels.write().await;
      previous_level = levels.get(group).copied().unwrap_or(group_def.recommended_default);
      levels.insert(group.to_string(), level);
    }

    // Rebuild and reload the filter
    self.apply().await?;

    // Record in history
    let auto_revert_at = auto_revert_minutes.map(|mins| Utc::now() + chrono::Duration::minutes(i64::from(mins)));
    {
      let mut history = self.history.write().await;
      if history.len() >= self.max_history {
        history.pop_front();
      }
      history.push_back(LogChangeEntry {
        timestamp: Utc::now(),
        group: group.to_string(),
        previous_level,
        new_level: level,
        changed_by: changed_by.to_string(),
        auto_revert_at,
      });
    }

    info!(
        group,
        %previous_level,
        %level,
        changed_by,
        "log level updated"
    );

    // Spawn auto-revert task if requested
    if let Some(mins) = auto_revert_minutes
      && mins > 0
    {
      let group_name = group.to_string();
      // We need a reference to self for the revert — since LoggingService
      // is always behind Arc in ApiState, the caller should use
      // `spawn_auto_revert` separately. For now, log the intent.
      info!(
          group = group_name,
          revert_to = %previous_level,
          minutes = mins,
          "auto-revert scheduled"
      );
    }

    Ok(LogModuleLevelInfo {
      group: group.to_string(),
      display_name: group_def.display_name.to_string(),
      description: group_def.description.to_string(),
      current_level: level,
      recommended_default: group_def.recommended_default,
      high_volume_warning: group_def.high_volume_warning,
    })
  }

  /// Spawn a tokio task that reverts a group's level after `minutes`.
  ///
  /// Must be called with an `Arc<LoggingService>` reference so the task
  /// can hold a handle to the service.
  pub fn spawn_auto_revert(self: &Arc<Self>, group: String, minutes: u32, previous_level: LogLevel) {
    let svc = Arc::clone(self);

    tokio::spawn(async move {
      tokio::time::sleep(std::time::Duration::from_secs(u64::from(minutes) * 60)).await;
      match svc
        .update_level(&group, previous_level, "system/auto-revert", None)
        .await
      {
        Ok(_) => info!(group, %previous_level, "auto-revert applied"),
        Err(e) => warn!(group, error = %e, "auto-revert failed"),
      }
    });
  }

  /// Read the current level before scheduling a temporary override.
  pub async fn current_level(&self, group: &str) -> Result<LogLevel, String> {
    let definition = LOG_GROUPS
      .iter()
      .find(|definition| definition.group == group)
      .ok_or_else(|| format!("unknown log group: {group}"))?;
    Ok(
      self
        .levels
        .read()
        .await
        .get(group)
        .copied()
        .unwrap_or(definition.recommended_default),
    )
  }

  /// Reset all groups to their recommended defaults.
  pub async fn reset_all(&self, changed_by: &str) -> Result<(), String> {
    {
      let mut levels = self.levels.write().await;
      let mut history = self.history.write().await;

      for group in LOG_GROUPS {
        let previous = levels.get(group.group).copied().unwrap_or(group.recommended_default);
        levels.insert(group.group.to_string(), group.recommended_default);

        if previous != group.recommended_default {
          if history.len() >= self.max_history {
            history.pop_front();
          }
          history.push_back(LogChangeEntry {
            timestamp: Utc::now(),
            group: group.group.to_string(),
            previous_level: previous,
            new_level: group.recommended_default,
            changed_by: changed_by.to_string(),
            auto_revert_at: None,
          });
        }
      }
    }

    self.apply().await?;
    info!(changed_by, "all log levels reset to defaults");
    Ok(())
  }

  /// Apply a named preset.
  ///
  /// Supported presets:
  /// - `"production"` — all groups at their recommended defaults
  /// - `"debug"` — api/websocket/auth at DEBUG, rest at defaults
  /// - `"trace"` — all groups at TRACE
  pub async fn apply_preset(&self, preset: &str, changed_by: &str) -> Result<(), String> {
    let overrides: HashMap<&str, LogLevel> = match preset {
      "production" => {
        // Just use recommended defaults — no overrides needed
        HashMap::new()
      }
      "debug" => {
        let mut m = HashMap::new();
        m.insert("api", LogLevel::Debug);
        m.insert("websocket", LogLevel::Debug);
        m.insert("auth", LogLevel::Debug);
        m
      }
      "trace" => LOG_GROUPS.iter().map(|g| (g.group, LogLevel::Trace)).collect(),
      other => return Err(format!("unknown preset: {other}")),
    };

    {
      let mut levels = self.levels.write().await;
      let mut history = self.history.write().await;

      for group in LOG_GROUPS {
        let new_level = overrides.get(group.group).copied().unwrap_or(group.recommended_default);
        let previous = levels.get(group.group).copied().unwrap_or(group.recommended_default);
        levels.insert(group.group.to_string(), new_level);

        if previous != new_level {
          if history.len() >= self.max_history {
            history.pop_front();
          }
          history.push_back(LogChangeEntry {
            timestamp: Utc::now(),
            group: group.group.to_string(),
            previous_level: previous,
            new_level,
            changed_by: changed_by.to_string(),
            auto_revert_at: None,
          });
        }
      }
    }

    self.apply().await?;
    info!(preset, changed_by, "log preset applied");
    Ok(())
  }

  /// Return all groups with their current levels.
  pub async fn current_levels(&self) -> Vec<LogModuleLevelInfo> {
    let levels = self.levels.read().await;
    LOG_GROUPS
      .iter()
      .map(|g| {
        let current_level = levels.get(g.group).copied().unwrap_or(g.recommended_default);
        LogModuleLevelInfo {
          group: g.group.to_string(),
          display_name: g.display_name.to_string(),
          description: g.description.to_string(),
          current_level,
          recommended_default: g.recommended_default,
          high_volume_warning: g.high_volume_warning,
        }
      })
      .collect()
  }

  /// Return the change history (most recent last).
  pub async fn history(&self) -> Vec<LogChangeEntry> {
    self.history.read().await.iter().cloned().collect()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn noop_reload() -> ReloadFn {
    Arc::new(|_filter: &str| Ok(()))
  }

  #[tokio::test]
  async fn build_filter_string_uses_defaults() {
    let svc = LoggingService::new(&HashMap::new(), LogLevel::Info, noop_reload());
    let filter = svc.build_env_filter_string().await;
    // Global fallback
    assert!(filter.starts_with("info,"));
    // Check a few module directives
    assert!(filter.contains("myoxus_api::handlers=info"));
    assert!(filter.contains("sqlx::query=warn"));
    assert!(filter.contains("hyper=warn"));
  }

  #[tokio::test]
  async fn build_filter_string_respects_config_overrides() {
    let mut config = HashMap::new();
    config.insert("database".to_string(), "debug".to_string());
    let svc = LoggingService::new(&config, LogLevel::Info, noop_reload());
    let filter = svc.build_env_filter_string().await;
    assert!(filter.contains("sqlx::query=debug"));
  }

  #[tokio::test]
  async fn update_level_validates_group() {
    let svc = LoggingService::new(&HashMap::new(), LogLevel::Info, noop_reload());
    let result = svc.update_level("nonexistent", LogLevel::Debug, "test", None).await;
    assert!(result.is_err());
  }

  #[tokio::test]
  async fn update_level_changes_and_records_history() {
    let svc = LoggingService::new(&HashMap::new(), LogLevel::Info, noop_reload());
    let info = svc
      .update_level("api", LogLevel::Debug, "admin@test", None)
      .await
      .unwrap();
    assert_eq!(info.current_level, LogLevel::Debug);
    assert_eq!(info.group, "api");

    let hist = svc.history().await;
    assert_eq!(hist.len(), 1);
    assert_eq!(hist[0].group, "api");
    assert_eq!(hist[0].previous_level, LogLevel::Info);
    assert_eq!(hist[0].new_level, LogLevel::Debug);
  }

  #[tokio::test]
  async fn reset_all_restores_defaults() {
    let svc = LoggingService::new(&HashMap::new(), LogLevel::Info, noop_reload());
    svc.update_level("api", LogLevel::Trace, "test", None).await.unwrap();
    svc
      .update_level("database", LogLevel::Debug, "test", None)
      .await
      .unwrap();

    svc.reset_all("admin").await.unwrap();

    let levels = svc.current_levels().await;
    let api = levels.iter().find(|l| l.group == "api").unwrap();
    assert_eq!(api.current_level, LogLevel::Info);
    let db = levels.iter().find(|l| l.group == "database").unwrap();
    assert_eq!(db.current_level, LogLevel::Warn);
  }

  #[tokio::test]
  async fn apply_preset_debug() {
    let svc = LoggingService::new(&HashMap::new(), LogLevel::Info, noop_reload());
    svc.apply_preset("debug", "test").await.unwrap();

    let levels = svc.current_levels().await;
    let api = levels.iter().find(|l| l.group == "api").unwrap();
    assert_eq!(api.current_level, LogLevel::Debug);
    let ws = levels.iter().find(|l| l.group == "websocket").unwrap();
    assert_eq!(ws.current_level, LogLevel::Debug);
    // database should remain at recommended default (warn)
    let db = levels.iter().find(|l| l.group == "database").unwrap();
    assert_eq!(db.current_level, LogLevel::Warn);
  }

  #[tokio::test]
  async fn apply_preset_unknown_returns_error() {
    let svc = LoggingService::new(&HashMap::new(), LogLevel::Info, noop_reload());
    let result = svc.apply_preset("nonexistent", "test").await;
    assert!(result.is_err());
  }

  #[tokio::test]
  async fn history_ring_buffer_caps_at_max() {
    let svc = LoggingService::new(&HashMap::new(), LogLevel::Info, noop_reload());
    for i in 0..25 {
      let level = if i % 2 == 0 { LogLevel::Debug } else { LogLevel::Info };
      svc.update_level("api", level, "test", None).await.unwrap();
    }
    let hist = svc.history().await;
    assert_eq!(hist.len(), DEFAULT_MAX_HISTORY);
  }

  #[test]
  fn log_level_display_and_from_str_roundtrip() {
    for level in [
      LogLevel::Trace,
      LogLevel::Debug,
      LogLevel::Info,
      LogLevel::Warn,
      LogLevel::Error,
    ] {
      let s = level.to_string();
      let parsed: LogLevel = s.parse().unwrap();
      assert_eq!(parsed, level);
    }
  }

  #[test]
  fn log_groups_count() {
    assert_eq!(LOG_GROUPS.len(), 13);
  }

  #[test]
  fn public_publishing_group_covers_delivery_renderer_and_cli_modules() {
    let group = LOG_GROUPS
      .iter()
      .find(|group| group.group == "public_publishing")
      .expect("public_publishing log group must exist");

    assert_eq!(group.recommended_default, LogLevel::Info);
    assert!(!group.high_volume_warning);
    for expected_module in [
      "myoxus_api::handlers::public",
      "myoxus_application::public",
      "myoxus_infrastructure::public",
      "myoxus_public_render",
      "myoxus_cli::public",
    ] {
      assert!(
        group.rust_modules.contains(&expected_module),
        "public_publishing log group must include {expected_module}"
      );
    }
  }

  #[tokio::test]
  async fn current_levels_exposes_public_publishing_for_admin_graphql() {
    let svc = LoggingService::new(&HashMap::new(), LogLevel::Info, noop_reload());
    let levels = svc.current_levels().await;
    let public_group = levels
      .iter()
      .find(|level| level.group == "public_publishing")
      .expect("public_publishing level must be exposed to Admin logging resolvers");

    assert_eq!(public_group.display_name, "Public Publishing");
    assert_eq!(public_group.current_level, LogLevel::Info);
    assert_eq!(public_group.recommended_default, LogLevel::Info);
    assert!(!public_group.high_volume_warning);
    assert!(
      public_group.description.contains("public"),
      "description should explain the public publishing scope"
    );
  }
}
