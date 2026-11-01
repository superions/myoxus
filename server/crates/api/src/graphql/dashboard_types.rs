//! GraphQL types for the admin dashboard.

use chrono::{DateTime, Utc};

use super::auth;

/// Bucket granularity for time-windowed analytics.
#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum TimeBucket {
  Day,
  Minute,
}

impl std::fmt::Display for TimeBucket {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      TimeBucket::Day => write!(f, "Day"),
      TimeBucket::Minute => write!(f, "Minute"),
    }
  }
}

impl TimeBucket {
  pub fn from_str_lossy(s: &str) -> Self {
    match s.to_lowercase().as_str() {
      "minute" => TimeBucket::Minute,
      _ => TimeBucket::Day,
    }
  }
}

#[derive(async_graphql::InputObject, Clone, Default)]
pub struct AdminDashboardInput {
  pub shared_link_window_days: Option<i32>,
  pub storage_history_days: Option<i32>,
  pub sync_history_hours: Option<i32>,
  pub timezone: Option<String>,
}

#[derive(async_graphql::InputObject, Clone)]
pub struct AdminAllSharedLinksFilterInput {
  pub analytics_window_days: Option<i32>,
  pub include_total: Option<bool>,
  pub keyword: Option<String>,
  pub updated_after: Option<DateTime<Utc>>,
  pub workspace_id: Option<String>,
}

#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "TimeWindow")]
pub struct TimeWindowType {
  pub from: DateTime<Utc>,
  pub to: DateTime<Utc>,
  pub timezone: String,
  pub bucket: TimeBucket,
  pub requested_size: i32,
  pub effective_size: i32,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminDashboardMinutePointType {
  pub minute: DateTime<Utc>,
  pub active_users: i32,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminDashboardValueDayPointType {
  pub date: DateTime<Utc>,
  pub value: i64,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminSharedLinkTopItemType {
  pub workspace_id: String,
  pub doc_id: String,
  pub title: Option<String>,
  pub share_url: String,
  pub published_at: Option<DateTime<Utc>>,
  pub views: i64,
  pub unique_views: i64,
  pub guest_views: i64,
  pub last_accessed_at: Option<DateTime<Utc>>,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminDashboardRuntimeType {
  pub process_uptime_seconds: i64,
  pub requests_total: i64,
  pub requests_error_total: i64,
  pub request_error_rate: f64,
  pub request_throughput_rps: f64,
  pub request_latency_avg_ms: f64,
  pub request_latency_max_ms: f64,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminDashboardQueueMetricType {
  pub queue: String,
  pub pending_ready: i64,
  pub failed: i64,
  pub dead_letter: i64,
  pub queue_lag_seconds: f64,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminDashboardQueueSummaryType {
  pub pending_ready_total: i64,
  pub failed_total: i64,
  pub queues: Vec<AdminDashboardQueueMetricType>,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminDashboardMetricsPipelineType {
  pub enabled: bool,
  pub prometheus_enabled: bool,
  pub persistence_enabled: bool,
  pub active_series: i64,
  pub persisted_24h: Option<i64>,
  pub daily_rollups_7d: Option<i64>,
  pub last_flush_at: Option<DateTime<Utc>>,
  pub last_flush_count: i64,
  pub flush_interval_seconds: i64,
  pub offered_total: i64,
  pub accepted_total: i64,
  pub rejected_disabled_total: i64,
  pub cardinality_drops_total: i64,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminDashboardTelemetryPipelineType {
  pub enabled: bool,
  pub hot_buffer_len: i64,
  pub persisted_24h: Option<i64>,
  pub daily_rollups_7d: Option<i64>,
  pub last_flush_at: Option<DateTime<Utc>>,
  pub last_flush_count: i64,
  pub offered_total: i64,
  pub accepted_total: i64,
  pub rejected_total: i64,
  pub buffer_overflow_total: i64,
  pub dedupe_hit_rate: f64,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminDashboardCaptchaType {
  pub enabled: bool,
  pub hmac_key_configured: bool,
  pub verified_total: i64,
  pub rejected_total: i64,
  pub honeypot_total: i64,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminDashboardDbPoolType {
  pub active: i64,
  pub idle: i64,
  pub max: i64,
  pub user_count: Option<i64>,
  pub workspace_count: Option<i64>,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminDashboardCacheMetricType {
  pub name: String,
  pub hits_total: i64,
  pub misses_total: i64,
  pub hit_rate: f64,
  pub invalidations_local_total: i64,
  pub invalidations_remote_total: i64,
  pub entry_count: i64,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminDashboardType {
  pub sync_active_users: i32,
  pub sync_active_users_timeline: Vec<AdminDashboardMinutePointType>,
  pub sync_window: TimeWindowType,
  pub copilot_conversations: i64,
  pub workspace_storage_bytes: i64,
  pub blob_storage_bytes: i64,
  pub workspace_storage_history: Vec<AdminDashboardValueDayPointType>,
  pub blob_storage_history: Vec<AdminDashboardValueDayPointType>,
  pub storage_window: TimeWindowType,
  pub top_shared_links: Vec<AdminSharedLinkTopItemType>,
  pub top_shared_links_window: TimeWindowType,
  pub runtime: AdminDashboardRuntimeType,
  pub queue_summary: AdminDashboardQueueSummaryType,
  pub metrics_pipeline: AdminDashboardMetricsPipelineType,
  pub telemetry_pipeline: AdminDashboardTelemetryPipelineType,
  pub captcha: AdminDashboardCaptchaType,
  pub db_pool: Option<AdminDashboardDbPoolType>,
  pub cache_metrics: Vec<AdminDashboardCacheMetricType>,
  pub generated_at: DateTime<Utc>,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminAllSharedLinkType {
  pub workspace_id: String,
  pub doc_id: String,
  pub title: Option<String>,
  pub published_at: Option<DateTime<Utc>>,
  pub doc_updated_at: Option<DateTime<Utc>>,
  pub workspace_owner_id: Option<String>,
  pub last_updater_id: Option<String>,
  pub share_url: String,
  pub views: Option<i64>,
  pub unique_views: Option<i64>,
  pub guest_views: Option<i64>,
  pub last_accessed_at: Option<DateTime<Utc>>,
}

#[derive(async_graphql::SimpleObject)]
pub struct AdminAllSharedLinkEdgeType {
  pub cursor: String,
  pub node: AdminAllSharedLinkType,
}

#[derive(async_graphql::SimpleObject)]
pub struct PaginatedAdminAllSharedLinkType {
  pub total_count: i32,
  pub analytics_window: TimeWindowType,
  pub page_info: auth::PageInfoType,
  pub edges: Vec<AdminAllSharedLinkEdgeType>,
}
