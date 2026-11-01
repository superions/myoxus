//! GraphQL resolvers for admin-only workspace and user management.
//!
//! Exposes [`AdminRoot`] as a sub-root resolver nested under the main query
//! and mutation roots (accessed via `{ admin { ... } }`). Operations include
//! listing/creating/deleting workspaces and users, changing user roles, and
//! toggling feature flags — all gated behind an `is_admin` check on the
//! session user.
//!
//! Template registry operations, previously exposed through a separate
//! `templateRegistry { ... }` sub-root, are also unified under `admin { ... }`.

use async_graphql::{Context, ID, InputObject, Object, Result, SimpleObject, Upload};
use axum::http::HeaderMap;
use chrono::{DateTime, Utc};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::str::FromStr;
use std::sync::Arc;
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use crate::config::OAuthCustomProviderConfig;
use crate::graphql::workspace_types::AdminWorkspaceType;
use crate::request_id::REQUEST_ID_HEADER;
use crate::state::ApiState;

use myoxus_application::auth::AuthError;
use myoxus_application::workspace::QuotaUpdate;
use myoxus_domain::entities::{
  AutoVersionTrigger, DocumentMetadataFieldDefinitionPatch, DocumentMetadataValueDefinition,
  DocumentRuntimeAggregateBucket, DocumentRuntimeOverview, DocumentStatusSchema, DocumentStatusTransition,
  DocumentStatusValue, DocumentTypeDefinition, DocumentVersionKind, DocumentVersionPolicy,
  WorkspaceRole as DomainWorkspaceRole,
};

async fn persist_logging_config(
  state: &ApiState,
  updated_by: Uuid,
  mutations: Vec<myoxus_infrastructure::app_config::ConfigMutation>,
) -> Result<()> {
  let pool = state
    .metrics_pool()
    .ok_or_else(|| async_graphql::Error::new("database pool unavailable"))?;
  let result = myoxus_infrastructure::app_config::write_config_batch(
    &pool,
    &mutations,
    myoxus_infrastructure::app_config::ConfigBatchMode::Partial,
    Some(updated_by),
    &crate::config::AppConfigStartupValidator,
  )
  .await
  .map_err(|error| async_graphql::Error::new(error.to_string()))?;
  crate::graphql::admin_config::record_committed_config_changes(state, &result.changes, updated_by).await;
  if let Err(error) = state.refresh_config_overrides().await {
    // The database commit is authoritative. A transient refresh failure must
    // not turn a successful durable write into an error response; Redis and
    // the bounded recovery poll will retry the same canonical snapshot.
    warn!(%error, "logging config committed but local live refresh failed");
  }
  state.publish_cache_invalidation("app_config", "all").await;
  Ok(())
}

// ─── Admin-only server info type ─────────────────────────────────────────────

/// Admin-only server information type. Superset of `ServerConfigType`,
/// additionally exposing fields that should not be visible to unauthenticated users.
/// Accessible only via `admin { serverInfo { ... } }`.
#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminServerInfoType {
  /// All public server config fields (inlined via flatten).
  #[graphql(flatten)]
  pub base: crate::graphql::auth::ServerConfigType,
  /// Available server upgrade (admin-only — not exposed on public serverConfig).
  pub available_upgrade: Option<crate::graphql::auth::ReleaseVersionType>,
  /// Available user feature flags (admin-only).
  pub available_user_features: Vec<crate::graphql::auth::FeatureType>,
  /// Available workspace feature flags (admin-only).
  pub available_workspace_features: Vec<crate::graphql::auth::FeatureType>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminMetricsTopSeriesType {
  pub category: String,
  pub name: String,
  pub labels: JsonValue,
  pub value: f64,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminMetricsCountersType {
  pub offered_total: i64,
  pub accepted_total: i64,
  pub rejected_disabled_total: i64,
  pub cardinality_drops_total: i64,
  pub snapshots_total: i64,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminMetricsStatusType {
  pub enabled: bool,
  pub prometheus_enabled: bool,
  pub persistence_enabled: bool,
  pub categories: JsonValue,
  pub flush_interval_seconds: i64,
  pub retention_raw_days: i32,
  pub retention_daily_days: i32,
  pub cardinality_limit_per_metric: i32,
  pub label_workspace_id_enabled: bool,
  pub active_series: i64,
  #[graphql(name = "persisted24h")]
  pub persisted_24h: Option<i64>,
  #[graphql(name = "dailyRollups7d")]
  pub daily_rollups_7d: Option<i64>,
  pub last_flush_at: Option<DateTime<Utc>>,
  pub last_flush_count: i64,
  pub counters: AdminMetricsCountersType,
  pub top_series: Vec<AdminMetricsTopSeriesType>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminOidcProviderTestResult {
  pub discovery_ok: bool,
  pub jwks_ok: bool,
  pub issuer: Option<String>,
  pub authorization_endpoint_present: bool,
  pub token_endpoint_present: bool,
  pub userinfo_endpoint_present: bool,
  pub jwks_key_count: i32,
  pub groups_claim_present: bool,
  pub groups_count: i32,
  pub mapped_groups_count: i32,
  pub unknown_groups_count: i32,
  pub warnings: Vec<String>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminMetricsFlushResultType {
  pub buffered: i64,
  pub inserted: i64,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminTelemetryCountersType {
  pub offered_total: i64,
  pub accepted_total: i64,
  pub rejected_disabled_total: i64,
  pub rejected_category_total: i64,
  pub rejected_sampled_total: i64,
  pub rejected_duplicate_total: i64,
  pub rejected_invalid_total: i64,
  pub buffer_overflow_total: i64,
  pub flushed_total: i64,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminTelemetryStatusType {
  pub enabled: bool,
  pub categories: JsonValue,
  pub sampling_rates: JsonValue,
  pub retention_raw_days: i32,
  pub retention_daily_days: i32,
  pub flush_interval_seconds: i64,
  pub batch_max_events: i32,
  pub dedupe_ttl_hours: i64,
  pub ingest_rate_limit_per_ip_per_min: i32,
  pub counters: AdminTelemetryCountersType,
  pub hot_buffer_len: i64,
  #[graphql(name = "persisted24h")]
  pub persisted_24h: Option<i64>,
  #[graphql(name = "dailyRollups7d")]
  pub daily_rollups_7d: Option<i64>,
  pub last_flush_at: Option<DateTime<Utc>>,
  pub last_flush_count: i64,
  pub dedupe_hit_rate: f64,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminTelemetryFlushResultType {
  pub buffered: i64,
  pub inserted: i64,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminQueueCountsType {
  pub waiting: i64,
  pub active: i64,
  pub completed: i64,
  pub failed: i64,
  pub delayed: i64,
  pub stalled: i64,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminQueueHistoryPointType {
  pub timestamp: i64,
  pub pending: i64,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminQueueType {
  pub name: String,
  pub display_name: String,
  pub paused: bool,
  pub degraded: bool,
  pub counts: AdminQueueCountsType,
  pub history: Option<Vec<AdminQueueHistoryPointType>>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminQueueStatusType {
  pub redis_available: bool,
  pub degraded: bool,
  pub queues: Vec<AdminQueueType>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminQueueJobType {
  pub id: String,
  pub name: String,
  pub timestamp: Option<i64>,
  pub attempts_made: i32,
  pub finished_on: Option<i64>,
  pub failed_reason: Option<String>,
  pub data: JsonValue,
  pub return_value: Option<JsonValue>,
  pub workspace_content_operation: Option<crate::graphql::auth::WorkspaceContentOperationType>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminQueueJobsType {
  pub total_count: i64,
  pub num_of_pages: i64,
  pub next_cursor: Option<i64>,
  pub jobs: Vec<AdminQueueJobType>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminQueueMutationResultType {
  pub ok: bool,
  pub name: Option<String>,
  pub job_id: Option<String>,
  pub removed: Option<i64>,
  pub failed: Option<i64>,
  pub error: Option<String>,
}

fn bool_map_to_json(map: std::collections::BTreeMap<String, bool>) -> JsonValue {
  JsonValue::Object(
    map
      .into_iter()
      .map(|(key, value)| (key, JsonValue::Bool(value)))
      .collect::<JsonMap<_, _>>(),
  )
}

fn f32_map_to_json(map: std::collections::BTreeMap<String, f32>) -> JsonValue {
  JsonValue::Object(
    map
      .into_iter()
      .filter_map(|(key, value)| serde_json::Number::from_f64(f64::from(value)).map(|n| (key, JsonValue::Number(n))))
      .collect::<JsonMap<_, _>>(),
  )
}

fn u64_to_i64(value: u64, field: &'static str) -> Result<i64> {
  i64::try_from(value).map_err(|_| async_graphql::Error::new(format!("{field} exceeds GraphQL Int range")))
}

fn opt_u64_to_i64(value: Option<u64>, field: &'static str) -> Result<Option<i64>> {
  value.map(|v| u64_to_i64(v, field)).transpose()
}

impl TryFrom<crate::admin_runtime_status::AdminMetricsStatusResponse> for AdminMetricsStatusType {
  type Error = async_graphql::Error;

  fn try_from(value: crate::admin_runtime_status::AdminMetricsStatusResponse) -> Result<Self> {
    Ok(Self {
      enabled: value.enabled,
      prometheus_enabled: value.prometheus_enabled,
      persistence_enabled: value.persistence_enabled,
      categories: bool_map_to_json(value.categories),
      flush_interval_seconds: u64_to_i64(value.flush_interval_seconds, "flushIntervalSeconds")?,
      retention_raw_days: i32::try_from(value.retention_raw_days)
        .map_err(|_| async_graphql::Error::new("retentionRawDays exceeds GraphQL Int range"))?,
      retention_daily_days: i32::try_from(value.retention_daily_days)
        .map_err(|_| async_graphql::Error::new("retentionDailyDays exceeds GraphQL Int range"))?,
      cardinality_limit_per_metric: i32::try_from(value.cardinality_limit_per_metric)
        .map_err(|_| async_graphql::Error::new("cardinalityLimitPerMetric exceeds GraphQL Int range"))?,
      label_workspace_id_enabled: value.label_workspace_id_enabled,
      active_series: u64_to_i64(value.active_series, "activeSeries")?,
      persisted_24h: opt_u64_to_i64(value.persisted_24h, "persisted24h")?,
      daily_rollups_7d: opt_u64_to_i64(value.daily_rollups_7d, "dailyRollups7d")?,
      last_flush_at: value.last_flush_at,
      last_flush_count: u64_to_i64(value.last_flush_count, "lastFlushCount")?,
      counters: AdminMetricsCountersType {
        offered_total: u64_to_i64(value.counters.offered_total, "offeredTotal")?,
        accepted_total: u64_to_i64(value.counters.accepted_total, "acceptedTotal")?,
        rejected_disabled_total: u64_to_i64(value.counters.rejected_disabled_total, "rejectedDisabledTotal")?,
        cardinality_drops_total: u64_to_i64(value.counters.cardinality_drops_total, "cardinalityDropsTotal")?,
        snapshots_total: u64_to_i64(value.counters.snapshots_total, "snapshotsTotal")?,
      },
      top_series: value
        .top_series
        .into_iter()
        .map(|series| AdminMetricsTopSeriesType {
          category: series.category,
          name: series.name,
          labels: series.labels,
          value: series.value,
        })
        .collect(),
    })
  }
}

impl TryFrom<crate::admin_runtime_status::AdminMetricsFlushResponse> for AdminMetricsFlushResultType {
  type Error = async_graphql::Error;

  fn try_from(value: crate::admin_runtime_status::AdminMetricsFlushResponse) -> Result<Self> {
    Ok(Self {
      buffered: u64_to_i64(value.buffered, "buffered")?,
      inserted: u64_to_i64(value.inserted, "inserted")?,
    })
  }
}

impl TryFrom<crate::admin_runtime_status::AdminTelemetryStatusResponse> for AdminTelemetryStatusType {
  type Error = async_graphql::Error;

  fn try_from(value: crate::admin_runtime_status::AdminTelemetryStatusResponse) -> Result<Self> {
    Ok(Self {
      enabled: value.enabled,
      categories: bool_map_to_json(value.categories),
      sampling_rates: f32_map_to_json(value.sampling_rates),
      retention_raw_days: i32::try_from(value.retention_raw_days)
        .map_err(|_| async_graphql::Error::new("retentionRawDays exceeds GraphQL Int range"))?,
      retention_daily_days: i32::try_from(value.retention_daily_days)
        .map_err(|_| async_graphql::Error::new("retentionDailyDays exceeds GraphQL Int range"))?,
      flush_interval_seconds: u64_to_i64(value.flush_interval_seconds, "flushIntervalSeconds")?,
      batch_max_events: i32::try_from(value.batch_max_events)
        .map_err(|_| async_graphql::Error::new("batchMaxEvents exceeds GraphQL Int range"))?,
      dedupe_ttl_hours: u64_to_i64(value.dedupe_ttl_hours, "dedupeTtlHours")?,
      ingest_rate_limit_per_ip_per_min: i32::try_from(value.ingest_rate_limit_per_ip_per_min)
        .map_err(|_| async_graphql::Error::new("ingestRateLimitPerIpPerMin exceeds GraphQL Int range"))?,
      counters: AdminTelemetryCountersType {
        offered_total: u64_to_i64(value.counters.offered_total, "offeredTotal")?,
        accepted_total: u64_to_i64(value.counters.accepted_total, "acceptedTotal")?,
        rejected_disabled_total: u64_to_i64(value.counters.rejected_disabled_total, "rejectedDisabledTotal")?,
        rejected_category_total: u64_to_i64(value.counters.rejected_category_total, "rejectedCategoryTotal")?,
        rejected_sampled_total: u64_to_i64(value.counters.rejected_sampled_total, "rejectedSampledTotal")?,
        rejected_duplicate_total: u64_to_i64(value.counters.rejected_duplicate_total, "rejectedDuplicateTotal")?,
        rejected_invalid_total: u64_to_i64(value.counters.rejected_invalid_total, "rejectedInvalidTotal")?,
        buffer_overflow_total: u64_to_i64(value.counters.buffer_overflow_total, "bufferOverflowTotal")?,
        flushed_total: u64_to_i64(value.counters.flushed_total, "flushedTotal")?,
      },
      hot_buffer_len: u64_to_i64(value.hot_buffer_len, "hotBufferLen")?,
      persisted_24h: opt_u64_to_i64(value.persisted_24h, "persisted24h")?,
      daily_rollups_7d: opt_u64_to_i64(value.daily_rollups_7d, "dailyRollups7d")?,
      last_flush_at: value.last_flush_at,
      last_flush_count: u64_to_i64(value.last_flush_count, "lastFlushCount")?,
      dedupe_hit_rate: f64::from(value.dedupe_hit_rate),
    })
  }
}

impl TryFrom<crate::admin_runtime_status::AdminTelemetryFlushResponse> for AdminTelemetryFlushResultType {
  type Error = async_graphql::Error;

  fn try_from(value: crate::admin_runtime_status::AdminTelemetryFlushResponse) -> Result<Self> {
    Ok(Self {
      buffered: u64_to_i64(value.buffered, "buffered")?,
      inserted: u64_to_i64(value.inserted, "inserted")?,
    })
  }
}

impl From<crate::admin_queue::AdminQueueCounts> for AdminQueueCountsType {
  fn from(value: crate::admin_queue::AdminQueueCounts) -> Self {
    Self {
      waiting: value.waiting,
      active: value.active,
      completed: value.completed,
      failed: value.failed,
      delayed: value.delayed,
      stalled: value.stalled,
    }
  }
}

impl From<crate::admin_queue::AdminQueue> for AdminQueueType {
  fn from(value: crate::admin_queue::AdminQueue) -> Self {
    Self {
      name: value.name,
      display_name: value.display_name,
      paused: value.paused,
      degraded: value.degraded,
      counts: value.counts.into(),
      history: value.history.map(|points| {
        points
          .into_iter()
          .map(|point| AdminQueueHistoryPointType {
            timestamp: point.timestamp,
            pending: point.pending,
          })
          .collect()
      }),
    }
  }
}

impl From<crate::admin_queue::AdminQueueStatus> for AdminQueueStatusType {
  fn from(value: crate::admin_queue::AdminQueueStatus) -> Self {
    Self {
      redis_available: value.redis_available,
      degraded: value.degraded,
      queues: value.queues.into_iter().map(Into::into).collect(),
    }
  }
}

impl From<crate::admin_queue::AdminQueueJob> for AdminQueueJobType {
  fn from(value: crate::admin_queue::AdminQueueJob) -> Self {
    Self {
      id: value.id,
      name: value.name,
      timestamp: value.timestamp,
      attempts_made: value.attempts_made,
      finished_on: value.finished_on,
      failed_reason: value.failed_reason,
      data: value.data,
      return_value: value.return_value,
      workspace_content_operation: value
        .workspace_content_operation
        .map(|record| crate::graphql::auth::WorkspaceContentOperationType::from_record(record, None)),
    }
  }
}

impl From<crate::admin_queue::AdminQueueJobs> for AdminQueueJobsType {
  fn from(value: crate::admin_queue::AdminQueueJobs) -> Self {
    Self {
      total_count: value.total_count,
      num_of_pages: value.num_of_pages,
      next_cursor: value.next_cursor,
      jobs: value.jobs.into_iter().map(Into::into).collect(),
    }
  }
}

impl From<crate::admin_queue::AdminQueueMutationResult> for AdminQueueMutationResultType {
  fn from(value: crate::admin_queue::AdminQueueMutationResult) -> Self {
    Self {
      ok: value.ok,
      name: value.name,
      job_id: value.job_id,
      removed: value.removed,
      failed: value.failed,
      error: value.error,
    }
  }
}

#[derive(async_graphql::SimpleObject, Clone, Debug)]
pub struct AdminDocumentVersioningDefaultsType {
  pub default_enabled: bool,
  pub default_auto_version_on_pdf_export: bool,
  pub default_retention_count: i32,
  pub default_edit_capture_enabled: bool,
  pub default_edit_capture_interval_ms: i64,
}

#[derive(async_graphql::SimpleObject, Clone, Debug)]
pub struct AdminDocumentVersioningWorkspaceSettingsType {
  pub workspace_id: ID,
  pub workspace_name: Option<String>,
  pub enabled: Option<bool>,
  pub auto_version_on_pdf_export: Option<bool>,
  pub retention_count: Option<i32>,
  pub effective_enabled: bool,
  pub effective_auto_version_on_pdf_export: bool,
  pub effective_retention_count: i32,
  pub edit_capture_enabled: Option<bool>,
  pub edit_capture_interval_ms: Option<i64>,
  pub effective_edit_capture_enabled: bool,
  pub effective_edit_capture_interval_ms: i64,
  pub legacy_interval_normalized: bool,
  pub edit_capture_runtime_available: bool,
  pub updated_at: Option<DateTime<Utc>>,
}

#[derive(async_graphql::SimpleObject, Clone, Debug)]
pub struct AdminDocumentRuntimeAggregateBucketType {
  /// Technical bucket key. `null` means the document has no value for that axis.
  pub key: Option<String>,
  /// Server-managed display label for configured values; synthetic buckets are localized by clients.
  pub label: Option<String>,
  pub count: i64,
}

impl From<DocumentRuntimeAggregateBucket> for AdminDocumentRuntimeAggregateBucketType {
  fn from(bucket: DocumentRuntimeAggregateBucket) -> Self {
    Self {
      key: bucket.key,
      label: bucket.label,
      count: bucket.count,
    }
  }
}

#[derive(async_graphql::SimpleObject, Clone, Debug)]
pub struct AdminDocumentRuntimeOverviewType {
  pub total_documents: i64,
  pub by_status: Vec<AdminDocumentRuntimeAggregateBucketType>,
  pub by_document_type: Vec<AdminDocumentRuntimeAggregateBucketType>,
  pub by_classification: Vec<AdminDocumentRuntimeAggregateBucketType>,
  pub by_review_due: Vec<AdminDocumentRuntimeAggregateBucketType>,
  pub by_version_state: Vec<AdminDocumentRuntimeAggregateBucketType>,
}

impl From<DocumentRuntimeOverview> for AdminDocumentRuntimeOverviewType {
  fn from(overview: DocumentRuntimeOverview) -> Self {
    Self {
      total_documents: overview.total_documents,
      by_status: overview.by_status.into_iter().map(Into::into).collect(),
      by_document_type: overview.by_document_type.into_iter().map(Into::into).collect(),
      by_classification: overview.by_classification.into_iter().map(Into::into).collect(),
      by_review_due: overview.by_review_due.into_iter().map(Into::into).collect(),
      by_version_state: overview.by_version_state.into_iter().map(Into::into).collect(),
    }
  }
}

#[derive(InputObject, Clone, Debug)]
pub struct AdminUpdateDocumentVersioningWorkspaceSettingsInput {
  pub workspace_id: ID,
  /// `null` clears the workspace override and inherits the global default.
  pub enabled: Option<bool>,
  /// `null` inherits; `false` persists an empty trigger list for this workspace.
  pub auto_version_on_pdf_export: Option<bool>,
  /// `null` inherits; values must be in the same 1..=50 envelope as per-doc settings.
  pub retention_count: Option<i32>,
}

#[derive(InputObject, Clone, Debug)]
pub struct AdminUpdateDocumentMetadataFieldDefinitionInput {
  pub key: String,
  pub label: Option<String>,
  pub enabled: Option<bool>,
  pub required_mode: Option<String>,
  pub editable_by: Option<String>,
  pub visible_in_header: Option<bool>,
  pub visible_in_properties: Option<bool>,
  pub visible_in_lists: Option<bool>,
  pub export_mode: Option<String>,
  pub validation_config: Option<serde_json::Value>,
  pub metadata: Option<serde_json::Value>,
}

#[derive(InputObject, Clone, Debug)]
pub struct AdminUpsertDocumentMetadataValueDefinitionInput {
  pub id: Option<ID>,
  pub field_key: String,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub color: Option<String>,
  pub icon: Option<String>,
  pub sort_order: Option<i32>,
  pub is_active: Option<bool>,
  pub metadata: Option<serde_json::Value>,
}

#[derive(InputObject, Clone, Debug)]
pub struct AdminUpsertDocumentStatusSchemaInput {
  pub id: Option<ID>,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub complexity: String,
  pub is_preset: Option<bool>,
  pub is_active: Option<bool>,
  pub metadata: Option<serde_json::Value>,
}

#[derive(InputObject, Clone, Debug)]
pub struct AdminUpsertDocumentStatusValueInput {
  pub id: Option<ID>,
  pub schema_id: ID,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub color: Option<String>,
  pub icon: Option<String>,
  pub sort_order: Option<i32>,
  pub terminal: Option<bool>,
  pub is_active: Option<bool>,
  pub metadata: Option<serde_json::Value>,
  pub okf_status: Option<String>,
}

#[derive(InputObject, Clone, Debug)]
pub struct AdminUpsertDocumentStatusTransitionInput {
  pub from_status_id: ID,
  pub to_status_id: ID,
  pub required_roles: Option<Vec<String>>,
  pub required_metadata_fields: Option<Vec<String>>,
  pub creates_version: Option<String>,
  pub sets_version_kind: Option<String>,
  pub date_enforcement: Option<String>,
  pub metadata: Option<serde_json::Value>,
}

#[derive(InputObject, Clone, Debug)]
pub struct AdminUpsertDocumentTypeInput {
  pub id: Option<ID>,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub icon: Option<String>,
  pub color: Option<String>,
  pub is_active: Option<bool>,
  pub is_suggested: Option<bool>,
}

#[derive(InputObject, Clone, Debug)]
pub struct AdminUpsertDocumentVersionPolicyInput {
  pub id: Option<ID>,
  pub scope: String,
  pub workspace_id: Option<ID>,
  pub name: String,
  pub is_default: Option<bool>,
  pub enabled_by_default: Option<bool>,
  pub scheme_preset: Option<String>,
  pub custom_pattern: Option<String>,
  pub timezone_mode: Option<String>,
  pub auto_version_on: Option<Vec<String>>,
  pub retention_count: Option<i32>,
  pub pin_manual_versions: Option<bool>,
  pub pin_publish_versions: Option<bool>,
  pub published_versions_protected: Option<bool>,
  pub export_versions_protected: Option<bool>,
  pub metadata_schema: Option<serde_json::Value>,
}

// ─── User search result (P-AR-0-S02) ─────────────────────────────────────────

/// Admin-surface user search hit returned by `adminSearchUsers`.
///
/// Powers the admin user-picker (`P-AR-0-S02`). Includes the activated
/// user-feature names plus the `is_admin` / `disabled` flags so the admin
/// UI can render badges. The manager surface uses a different output type
/// ([`ManagerUserSearchResult`]) that omits these fields.
#[derive(Debug, async_graphql::SimpleObject)]
pub struct UserSearchResult {
  /// User id.
  pub id: ID,
  /// Email snapshot.
  pub email: String,
  /// Display name.
  pub name: String,
  /// Activated user features (e.g. `manager`, `early_access`).
  pub features: Vec<String>,
  /// Whether the user holds server-admin privileges.
  pub is_admin: bool,
  /// Whether the account is disabled (status = 'disabled').
  pub disabled: bool,
}

// ─── User OU memberships (P-AR-2-S02) ────────────────────────────────────────

/// One OU-membership row for a single user — returned by
/// `userOrganizationMemberships`.
///
/// Powers the admin-surface user-detail panel (`P-AR-2-S02`). Carries the
/// OU identity snapshot (id, display name, slug), the membership role
/// (`reader` / `member` / `manager`), the membership source
/// (`manual` / `import` / `oidc` / `ldap` / `scim`) and the join
/// timestamp (=`organization_unit_member.created_at`).
#[derive(Debug, async_graphql::SimpleObject)]
pub struct UserOrganizationMembershipResult {
  /// OU id.
  pub unit_id: ID,
  /// OU display name.
  pub unit_name: String,
  /// OU slug.
  pub unit_slug: String,
  /// Membership role: `reader` / `member` / `manager`.
  pub role: String,
  /// Membership source: `manual` / `import` / `oidc` / `ldap` / `scim`.
  pub source: String,
  /// Timestamp when the membership row was created.
  pub joined_at: DateTime<Utc>,
}

// ─── Workspace search result (P-AR-0-S03) ────────────────────────────────────

/// Lightweight workspace search hit returned by `adminSearchWorkspaces`.
///
/// Powers the admin workspace-picker (`P-AR-0-S03`). Includes the owner
/// snapshot (id + email) and every OU id this workspace is linked to —
/// regardless of relationship (`owner` / `managed` / `linked`).
#[derive(Debug, async_graphql::SimpleObject)]
pub struct WorkspaceSearchResult {
  /// Workspace id.
  pub id: ID,
  /// Workspace display name.
  pub name: String,
  /// Owner user id (nullable for orphaned/system-owned workspaces).
  pub owner_user_id: Option<ID>,
  /// Owner email snapshot (nullable when the owner user row was deleted).
  pub owner_email: Option<String>,
  /// All OU ids this workspace is linked to (any relationship).
  pub linked_ou_ids: Vec<ID>,
}

// ─── Server directory info ────────────────────────────────────────────────────

/// Info about a server-managed directory (storage, logs, git-sync repos, etc.).
#[derive(Debug, async_graphql::SimpleObject)]
pub struct ServerDirectory {
  /// Human-readable name, e.g. "Blob Storage".
  pub name: String,
  /// Absolute path on the server filesystem.
  pub path: String,
  /// Whether the directory currently exists.
  pub exists: bool,
  /// Total size of all files under this directory in bytes (0 if not exists).
  pub total_bytes: i64,
  /// Number of immediate subdirectories under this path (0 if not exists).
  pub entry_count: i64,
  /// Free bytes on the filesystem partition containing this path (0 if not exists).
  pub free_bytes: i64,
  /// Total capacity of the partition in bytes (0 if not exists).
  pub capacity_bytes: i64,
}

/// Collect disk usage information for a single directory path.
///
/// Calls `myoxus_infrastructure::disk::compute_usage` (which already
/// runs blocking I/O in `spawn_blocking` internally).  Returns zeroed
/// fields when the path does not exist.
async fn collect_directory_info(name: &str, path: impl AsRef<std::path::Path>) -> ServerDirectory {
  let path_ref = path.as_ref();
  let path_str = path_ref.to_string_lossy().to_string();

  if !path_ref.exists() {
    return ServerDirectory {
      name: name.to_string(),
      path: path_str,
      exists: false,
      total_bytes: 0,
      entry_count: 0,
      free_bytes: 0,
      capacity_bytes: 0,
    };
  }

  let usage = myoxus_infrastructure::disk::compute_usage(path_ref, 0).await;

  ServerDirectory {
    name: name.to_string(),
    path: path_str,
    exists: true,
    total_bytes: usage.total_bytes as i64,
    entry_count: usage.entry_count as i64,
    free_bytes: usage.free_bytes as i64,
    capacity_bytes: usage.capacity_bytes as i64,
  }
}

async fn test_oidc_provider_config(
  config: OAuthCustomProviderConfig,
  sample_claims: Option<JsonValue>,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> AdminOidcProviderTestResult {
  let trust_snapshot_id = myoxus_infrastructure::tls::snapshot_id(additional_ca);
  tracing::info!(
    event = "sso.diagnostic.started",
    trust_snapshot_id,
    "Admin OIDC diagnostic started"
  );
  let mut result = AdminOidcProviderTestResult {
    discovery_ok: false,
    jwks_ok: false,
    issuer: None,
    authorization_endpoint_present: false,
    token_endpoint_present: false,
    userinfo_endpoint_present: false,
    jwks_key_count: 0,
    groups_claim_present: false,
    groups_count: 0,
    mapped_groups_count: 0,
    unknown_groups_count: 0,
    warnings: Vec::new(),
  };

  let Some(discovery_url) = config.discovery_url.clone().or_else(|| {
    config
      .issuer_url
      .as_ref()
      .map(|issuer| format!("{}/.well-known/openid-configuration", issuer.trim_end_matches('/')))
  }) else {
    result
      .warnings
      .push("Discovery URL or issuer URL is required.".to_string());
    return result;
  };

  let client = match myoxus_infrastructure::tls::build_http_client(
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)),
    additional_ca,
  ) {
    Ok(client) => client,
    Err(error) => {
      result
        .warnings
        .push(format!("Failed to initialize OIDC test client: {error}"));
      return result;
    }
  };

  let discovery = match fetch_oidc_test_json(&client, &discovery_url, "oidc_discovery", trust_snapshot_id).await {
    Ok(value) => value,
    Err(message) => {
      result.warnings.push(message);
      return result;
    }
  };
  if serde_json::from_value::<crate::auth::oidc::OidcDiscoveryDocument>(discovery.clone()).is_err() {
    result.warnings.push("oidc_discovery failed: invalid_response".into());
    return result;
  }
  let issuer_is_safe = discovery
    .get("issuer")
    .and_then(JsonValue::as_str)
    .and_then(|issuer| parse_safe_oidc_test_url(issuer).ok())
    .is_some_and(|issuer| issuer.query().is_none() && issuer.fragment().is_none());
  if !issuer_is_safe {
    result.warnings.push("oidc_discovery failed: invalid_issuer".into());
    return result;
  }
  result.discovery_ok = true;
  result.issuer = discovery.get("issuer").and_then(JsonValue::as_str).map(str::to_string);
  result.authorization_endpoint_present = discovery
    .get("authorization_endpoint")
    .and_then(JsonValue::as_str)
    .is_some();
  result.token_endpoint_present = discovery.get("token_endpoint").and_then(JsonValue::as_str).is_some();
  result.userinfo_endpoint_present = discovery.get("userinfo_endpoint").and_then(JsonValue::as_str).is_some();

  let jwks_url = config
    .jwks_url
    .as_deref()
    .or_else(|| discovery.get("jwks_uri").and_then(JsonValue::as_str));
  if let Some(jwks_url) = jwks_url {
    match fetch_oidc_test_json(&client, jwks_url, "oidc_jwks", trust_snapshot_id).await {
      Ok(value) => {
        if serde_json::from_value::<jsonwebtoken::jwk::JwkSet>(value.clone()).is_err() {
          result.warnings.push("oidc_jwks failed: invalid_response".into());
          return result;
        }
        result.jwks_ok = true;
        result.jwks_key_count = value
          .get("keys")
          .and_then(JsonValue::as_array)
          .map(|keys| keys.len() as i32)
          .unwrap_or_default();
        if result.jwks_key_count == 0 {
          result.warnings.push("JWKS document contains no keys.".to_string());
        }
      }
      Err(message) => result.warnings.push(message),
    }
  } else {
    result.warnings.push("JWKS URL is missing.".to_string());
  }

  if let Some(sample_claims) = sample_claims {
    apply_oidc_claim_sample(&mut result, &config, &sample_claims);
  }

  result
}

async fn fetch_oidc_test_json(
  client: &reqwest::Client,
  raw_url: &str,
  label: &'static str,
  trust_snapshot_id: &str,
) -> std::result::Result<JsonValue, String> {
  let url = parse_safe_oidc_test_url(raw_url).map_err(|message| format!("{label} URL rejected: {message}"))?;
  let response = client
    .get(url)
    .send()
    .await
    .map_err(|error| crate::auth::oidc::provider_http_diagnosis(&error, label, trust_snapshot_id))?;
  let status = response.status();
  if !status.is_success() {
    return Err(crate::auth::oidc::provider_http_rejection_diagnosis(
      status,
      label,
      trust_snapshot_id,
    ));
  }
  response
    .json::<JsonValue>()
    .await
    .map_err(|error| crate::auth::oidc::provider_http_diagnosis(&error, label, trust_snapshot_id))
}

#[derive(async_graphql::Enum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdminOidcDirectoryEntryState {
  Available,
  Ambiguous,
  Unavailable,
}

#[derive(SimpleObject)]
pub struct AdminOidcDirectoryEntry {
  /// Provider catalog identity, not the persisted providerGroup claim value.
  pub id: String,
  pub display_name: String,
  pub path: Option<String>,
  pub claim_value: Option<String>,
  pub state: AdminOidcDirectoryEntryState,
}

/// Entire catalog visible to the read account, not an audit of its permissions.
#[derive(SimpleObject)]
pub struct AdminOidcGroupDirectory {
  pub entries: Vec<AdminOidcDirectoryEntry>,
}

fn oidc_directory_error(
  error: myoxus_application::organization::oidc_directory::OidcDirectoryError,
) -> async_graphql::Error {
  use async_graphql::ErrorExtensions;
  use myoxus_application::organization::oidc_directory::OidcDirectoryError;
  let code = match &error {
    OidcDirectoryError::Unconfigured => "OIDC_GROUP_DIRECTORY_UNCONFIGURED",
    OidcDirectoryError::InvalidConfiguration => "OIDC_GROUP_DIRECTORY_INVALID_CONFIGURATION",
    OidcDirectoryError::AccessDenied(_) => "OIDC_GROUP_DIRECTORY_ACCESS_DENIED",
    OidcDirectoryError::HttpStatus(_) => "OIDC_GROUP_DIRECTORY_HTTP_ERROR",
    OidcDirectoryError::Transport(_) => "OIDC_GROUP_DIRECTORY_UNAVAILABLE",
    OidcDirectoryError::Timeout => "OIDC_GROUP_DIRECTORY_TIMEOUT",
    OidcDirectoryError::LimitExceeded => "OIDC_GROUP_DIRECTORY_LIMIT_EXCEEDED",
    OidcDirectoryError::InvalidResponse => "OIDC_GROUP_DIRECTORY_INVALID_RESPONSE",
    OidcDirectoryError::RedirectRejected => "OIDC_GROUP_DIRECTORY_REDIRECT_REJECTED",
  };
  async_graphql::Error::new(error.to_string()).extend_with(|_, extensions| {
    extensions.set("code", code);
    if let OidcDirectoryError::AccessDenied(status) | OidcDirectoryError::HttpStatus(status) = error {
      extensions.set("httpStatus", status);
    }
  })
}

fn parse_safe_oidc_test_url(raw_url: &str) -> std::result::Result<reqwest::Url, String> {
  myoxus_contracts::oauth_config::parse_safe_oidc_config_url(raw_url).map_err(|error| error.to_string())
}

fn apply_oidc_claim_sample(
  result: &mut AdminOidcProviderTestResult,
  config: &OAuthCustomProviderConfig,
  claims: &JsonValue,
) {
  let groups_path = config.claims.groups.as_deref().unwrap_or("groups");
  let Some(groups_value) = json_path(claims, groups_path) else {
    result
      .warnings
      .push(format!("Sample claims do not contain '{groups_path}'."));
    return;
  };

  let groups = match groups_value {
    JsonValue::Array(values) => values
      .iter()
      .filter_map(JsonValue::as_str)
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(str::to_string)
      .collect::<Vec<_>>(),
    JsonValue::String(value) if !value.trim().is_empty() => vec![value.trim().to_string()],
    _ => Vec::new(),
  };

  result.groups_claim_present = true;
  result.groups_count = groups.len() as i32;
  let mapped = config
    .group_mapping
    .mappings
    .iter()
    .map(|rule| rule.provider_group.trim())
    .filter(|group| !group.is_empty())
    .collect::<std::collections::HashSet<_>>();
  result.mapped_groups_count = groups.iter().filter(|group| mapped.contains(group.as_str())).count() as i32;
  result.unknown_groups_count = groups.iter().filter(|group| !mapped.contains(group.as_str())).count() as i32;
}

fn json_path<'a>(root: &'a JsonValue, path: &str) -> Option<&'a JsonValue> {
  let mut current = root;
  for segment in path.split('.') {
    if segment.is_empty() {
      return None;
    }
    current = current.get(segment)?;
  }
  Some(current)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[tokio::test]
  async fn ca_administration_authenticates_before_touching_bootstrap_or_uploads() {
    let config = yaml_serde::from_str(
      r#"
server: {port: 3001, host: "127.0.0.1", origin: "http://localhost:3001", session_ttl: 3600, session_ttr: 3600}
database: {url: "postgres://localhost/test"}
redis: {enabled: false, url: null, namespace: "myoxus"}
mail: {sender: "noreply@test.local", smtp_port: 587}
storage: {backend: "local", root: "./test-storage"}
oauth: {google_client_id: null, google_client_secret: null, github_client_id: null, github_client_secret: null}
"#,
    )
    .expect("in-memory config");
    let schema = async_graphql::Schema::build(AdminRoot, AdminRoot, async_graphql::EmptySubscription)
      .data(Arc::new(crate::state::ApiState::new(config)))
      .data(axum::http::HeaderMap::new())
      .finish();
    let mut upload = async_graphql::Request::new("mutation($file: Upload!){adminApplyCaBundle(file:$file){path}}")
      .variables(async_graphql::Variables::from_json(json!({"file": null})));
    upload.set_upload(
      "variables.file",
      async_graphql::UploadValue {
        filename: "invalid.pem".into(),
        content_type: None,
        content: tempfile::tempfile().expect("isolated upload"),
      },
    );
    for request in [
      async_graphql::Request::new("{adminCaBundleStatus{path}}"),
      async_graphql::Request::new("mutation{adminRestoreCaBundle{path}}"),
      async_graphql::Request::new("mutation{adminRemoveCaBundle{path}}"),
      upload,
    ] {
      let response = schema.execute(request).await;
      assert_eq!(response.errors.len(), 1);
      assert_eq!(
        response.errors[0]
          .extensions
          .as_ref()
          .and_then(|extensions| extensions.get("code")),
        Some(&async_graphql::Value::from("UNAUTHORIZED"))
      );
    }
  }

  fn oidc_test_config() -> OAuthCustomProviderConfig {
    serde_json::from_value(json!({
      "clientId": "client",
      "clientSecret": "secret",
      "authUrl": "https://issuer.example.test/auth",
      "tokenUrl": "https://issuer.example.test/token",
      "userinfoUrl": "https://issuer.example.test/userinfo",
      "claims": { "groups": "realm.groups" },
      "groupMapping": {
        "enabled": true,
        "defaultRole": "member",
        "mappings": [
          { "providerGroup": "finance", "targetUnitId": "unit-finance" },
          { "providerGroup": "engineering", "targetUnitId": "unit-engineering" }
        ]
      }
    }))
    .expect("valid OIDC test config")
  }

  #[test]
  fn oidc_diagnostic_url_guard_allows_https_and_localhost_only() {
    assert!(parse_safe_oidc_test_url("https://issuer.example.test/.well-known/openid-configuration").is_ok());
    assert!(parse_safe_oidc_test_url("http://localhost:9000/.well-known/openid-configuration").is_ok());
    assert!(parse_safe_oidc_test_url("http://127.0.0.1:9000/.well-known/openid-configuration").is_ok());
    assert!(parse_safe_oidc_test_url("http://issuer.example.test/.well-known/openid-configuration").is_err());
    assert!(parse_safe_oidc_test_url("file:///etc/passwd").is_err());
    let error = parse_safe_oidc_test_url("https://operator:credential-marker@issuer.test/?code=code-marker")
      .expect_err("URL credentials rejected");
    assert!(!error.contains("credential-marker"));
    assert!(!error.contains("code-marker"));
  }

  #[tokio::test]
  async fn oidc_diagnostics_keep_phases_and_snapshot_but_never_echo_provider_secrets() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tracing::instrument::WithSubscriber;

    let log = tempfile::NamedTempFile::new().expect("temporary log capture");
    let writer = log.reopen().expect("log writer");
    let subscriber = tracing_subscriber::fmt()
      .with_ansi(false)
      .without_time()
      .with_max_level(tracing::Level::WARN)
      .with_writer(move || writer.try_clone().expect("clone log writer"))
      .finish();
    async {
      for (status, body, phase, expected) in [
        ("401 Unauthorized", "token-marker cookie-marker credential-marker", "oidc_discovery", "http_rejected"),
        ("200 OK", "not-json PEM-marker token-marker", "oidc_jwks", "invalid_response"),
      ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("fixture listener");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
          let (mut stream, _) = listener.accept().await.expect("fixture connection");
          let mut request = [0u8; 4096];
          assert!(stream.read(&mut request).await.expect("fixture request") > 0);
          let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
          stream.write_all(response.as_bytes()).await.expect("fixture response");
        });
        let client = myoxus_infrastructure::tls::build_http_client(reqwest::Client::builder().timeout(std::time::Duration::from_secs(2)), None).expect("diagnostic client");
        let error = fetch_oidc_test_json(&client, &format!("http://{address}/?code=code-marker&token=token-marker"), phase, "snapshot-fixture").await.expect_err("provider failure");
        assert!(error.contains(phase));
        assert!(error.contains(expected));
        for secret in ["token-marker", "cookie-marker", "credential-marker", "PEM-marker", "code-marker"] {
          assert!(!error.contains(secret), "public error leaked fixture secret");
        }
        server.await.expect("fixture complete");
      }
    }.with_subscriber(subscriber).await;
    let logs = std::fs::read_to_string(log.path()).expect("captured logs");
    assert!(logs.contains("snapshot-fixture"));
    assert!(logs.contains("oidc_discovery"));
    assert!(logs.contains("oidc_jwks"));
    for secret in [
      "token-marker",
      "cookie-marker",
      "credential-marker",
      "PEM-marker",
      "code-marker",
    ] {
      assert!(!logs.contains(secret), "log leaked fixture secret");
    }
  }

  #[test]
  fn oidc_diagnostic_sample_counts_groups_without_returning_raw_claims() {
    let config = oidc_test_config();
    let mut result = AdminOidcProviderTestResult {
      discovery_ok: true,
      jwks_ok: true,
      issuer: Some("https://issuer.example.test".to_string()),
      authorization_endpoint_present: true,
      token_endpoint_present: true,
      userinfo_endpoint_present: true,
      jwks_key_count: 1,
      groups_claim_present: false,
      groups_count: 0,
      mapped_groups_count: 0,
      unknown_groups_count: 0,
      warnings: Vec::new(),
    };

    apply_oidc_claim_sample(
      &mut result,
      &config,
      &json!({ "realm": { "groups": ["finance", "unknown", "engineering"] } }),
    );

    assert!(result.groups_claim_present);
    assert_eq!(result.groups_count, 3);
    assert_eq!(result.mapped_groups_count, 2);
    assert_eq!(result.unknown_groups_count, 1);
    assert!(result.warnings.is_empty());
  }
}

// ─── Admin Root ───────────────────────────────────────────────────────────────

/// Sub-root resolver for admin-only GraphQL queries and mutations.
///
/// All methods check [`AdminRoot::ensure_admin`] before executing.
/// The resolver is accessible via `{ admin { ... } }` on the main root.
pub struct AdminRoot;

#[Object]
impl AdminRoot {
  #[graphql(name = "gitTokenRotationProviders")]
  async fn git_token_rotation_providers(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<crate::graphql::git_sync::GitTokenRotationProviderType>> {
    self.ensure_admin(ctx).await?;
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let service = state
      .git_token_rotation_service()
      .ok_or_else(|| async_graphql::Error::new("Git token rotation is not configured"))?;
    Ok(
      service
        .available_providers()
        .into_iter()
        .map(crate::graphql::git_sync::map_token_rotation_provider)
        .collect(),
    )
  }

  #[graphql(name = "gitTokenRotationStatus")]
  async fn git_token_rotation_status(
    &self,
    ctx: &Context<'_>,
    profile_id: String,
  ) -> Result<Option<crate::graphql::git_sync::GitTokenRotationStatusType>> {
    self.ensure_admin(ctx).await?;
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let profile_id = Uuid::parse_str(&profile_id).map_err(|_| async_graphql::Error::new("invalid profileId"))?;
    let service = state
      .git_token_rotation_service()
      .ok_or_else(|| async_graphql::Error::new("Git token rotation is not configured"))?;
    service
      .status(profile_id)
      .await
      .map(|status| status.map(crate::graphql::git_sync::map_token_rotation_status))
      .map_err(|error| async_graphql::Error::new(error.to_string()))
  }

  #[graphql(name = "configureGitTokenRotation")]
  async fn configure_git_token_rotation(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::git_sync::ConfigureGitTokenRotationInput,
  ) -> Result<crate::graphql::git_sync::GitTokenRotationStatusType> {
    self.ensure_admin(ctx).await?;
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let profile_id = Uuid::parse_str(&input.profile_id).map_err(|_| async_graphql::Error::new("invalid profileId"))?;
    let renew_before_days = u16::try_from(input.renew_before_days)
      .map_err(|_| async_graphql::Error::new("renewBeforeDays is outside the supported range"))?;
    let requested_lifetime_days = u16::try_from(input.requested_lifetime_days)
      .map_err(|_| async_graphql::Error::new("requestedLifetimeDays is outside the supported range"))?;
    let service = state
      .git_token_rotation_service()
      .ok_or_else(|| async_graphql::Error::new("Git token rotation is not configured"))?;
    service
      .configure(
        profile_id,
        myoxus_application::git_sync::GitTokenRotationConfiguration {
          provider: crate::graphql::git_sync::map_token_rotation_provider_to_application(input.provider),
          enabled: input.enabled,
          renew_before_days,
          requested_lifetime_days,
        },
      )
      .await
      .map(crate::graphql::git_sync::map_token_rotation_status)
      .map_err(|error| async_graphql::Error::new(error.to_string()))
  }

  #[graphql(name = "runGitTokenRotationNow")]
  async fn run_git_token_rotation_now(
    &self,
    ctx: &Context<'_>,
    profile_id: String,
  ) -> Result<crate::graphql::git_sync::GitTokenRotationStatusType> {
    self.ensure_admin(ctx).await?;
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let profile_id = Uuid::parse_str(&profile_id).map_err(|_| async_graphql::Error::new("invalid profileId"))?;
    let service = state
      .git_token_rotation_service()
      .ok_or_else(|| async_graphql::Error::new("Git token rotation is not configured"))?;
    service
      .rotate(profile_id, chrono::Utc::now(), true)
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?
      .map(crate::graphql::git_sync::map_token_rotation_status)
      .ok_or_else(|| async_graphql::Error::new("Git token rotation is disabled or requires manual intervention"))
  }

  // ── Workspace queries (compat/rich) ────────────────────────────────────────

  /// List workspaces with full admin metadata (replaces flat-root `adminWorkspaces`).
  #[graphql(name = "adminWorkspaces")]
  async fn admin_workspaces(
    &self,
    ctx: &Context<'_>,
    filter: crate::graphql::workspace_types::ListWorkspaceInput,
  ) -> Result<Vec<AdminWorkspaceType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let admin_filter = myoxus_application::admin::AdminWorkspaceFilter {
      skip: i64::from(filter.skip.unwrap_or(0)),
      take: i64::from(filter.first.unwrap_or(20)).clamp(1, 100),
      query: filter.keyword.clone(),
      public: filter.public,
      enable_ai: filter.enable_ai,
      enable_sharing: filter.enable_sharing,
      enable_url_preview: filter.enable_url_preview,
      enable_doc_embedding: filter.enable_doc_embedding,
      is_personal: filter.is_personal,
      workspace_type: filter.workspace_type.map(|value| value.as_str().to_string()),
      member_count_min: filter.member_count_min.map(i64::from),
      member_count_max: filter.member_count_max.map(i64::from),
      git_sync_enabled: filter.git_sync_enabled,
      git_sync_last_status: filter
        .git_sync_last_status
        .map(crate::graphql::git_sync::map_run_status_to_domain)
        .map(|s| s.to_string()),
      order_by: filter.order_by.map(|o| format!("{:?}", o)),
    };
    let workspaces = state
      .admin()
      .list_workspaces(admin_filter)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;
    let mut out = Vec::with_capacity(workspaces.len());
    for ws in workspaces {
      out.push(crate::graphql::build_admin_workspace_compat(state, ws).await?);
    }
    Ok(out)
  }

  /// Count workspaces matching filter (replaces flat-root `adminWorkspacesCount`).
  #[graphql(name = "adminWorkspacesCount")]
  async fn admin_workspaces_count(
    &self,
    ctx: &Context<'_>,
    filter: crate::graphql::workspace_types::ListWorkspaceInput,
  ) -> Result<i64> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let count_filter = myoxus_application::admin::AdminWorkspaceFilter {
      skip: 0,
      take: 0,
      query: filter.keyword,
      public: filter.public,
      enable_ai: filter.enable_ai,
      enable_sharing: filter.enable_sharing,
      enable_url_preview: filter.enable_url_preview,
      enable_doc_embedding: filter.enable_doc_embedding,
      is_personal: filter.is_personal,
      workspace_type: filter.workspace_type.map(|value| value.as_str().to_string()),
      member_count_min: filter.member_count_min.map(i64::from),
      member_count_max: filter.member_count_max.map(i64::from),
      git_sync_enabled: filter.git_sync_enabled,
      git_sync_last_status: filter
        .git_sync_last_status
        .map(crate::graphql::git_sync::map_run_status_to_domain)
        .map(|s| s.to_string()),
      order_by: None,
    };
    state
      .admin()
      .count_workspaces(&count_filter)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))
  }

  /// Get a single workspace by ID with full admin metadata (replaces flat-root `adminWorkspace`).
  #[graphql(name = "adminWorkspace")]
  async fn admin_workspace(&self, ctx: &Context<'_>, id: String) -> Result<Option<AdminWorkspaceType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let workspace_id = uuid::Uuid::parse_str(&id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let Some(ws) = state
      .admin()
      .get_workspace(workspace_id)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?
    else {
      return Ok(None);
    };
    Ok(Some(crate::graphql::build_admin_workspace_compat(state, ws).await?))
  }

  /// List orphaned workspaces (owner deleted) (replaces flat-root `orphanedWorkspaces`).
  #[graphql(name = "orphanedWorkspaces")]
  async fn orphaned_workspaces(
    &self,
    ctx: &Context<'_>,
    skip: Option<i32>,
    take: Option<i32>,
  ) -> Result<Vec<AdminWorkspaceType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let skip = skip.unwrap_or(0).max(0) as i64;
    let take = take.unwrap_or(20).clamp(1, 100) as i64;
    let workspaces = state
      .workspace()
      .list_orphaned(skip, take)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let mut result = Vec::with_capacity(workspaces.len());
    for ws in workspaces {
      result.push(crate::graphql::build_admin_workspace_compat(state, ws).await?);
    }
    Ok(result)
  }

  /// Count orphaned workspaces (replaces flat-root `orphanedWorkspacesCount`).
  #[graphql(name = "orphanedWorkspacesCount")]
  async fn orphaned_workspaces_count(&self, ctx: &Context<'_>) -> Result<i32> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let count = state
      .workspace()
      .count_orphaned()
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(count as i32)
  }

  /// List all shared/published docs (replaces flat-root `adminAllSharedLinks`).
  #[graphql(name = "adminAllSharedLinks")]
  async fn admin_all_shared_links(
    &self,
    ctx: &Context<'_>,
    pagination: crate::graphql::auth::PaginationInputType,
    filter: Option<crate::graphql::AdminAllSharedLinksFilterInput>,
  ) -> Result<crate::graphql::PaginatedAdminAllSharedLinkType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;

    let now = Utc::now();
    let first = pagination.first.unwrap_or(20).clamp(0, 100) as i64;
    let skip = pagination.offset.unwrap_or(0).max(0) as i64;
    let window_days = filter.as_ref().and_then(|f| f.analytics_window_days).unwrap_or(28) as i64;
    let workspace_filter = filter.as_ref().and_then(|f| f.workspace_id.clone());
    let keyword_filter = filter.as_ref().and_then(|f| f.keyword.clone());

    use crate::graphql::{AdminAllSharedLinkEdgeType, AdminAllSharedLinkType, TimeBucket, TimeWindowType};

    let analytics_window = TimeWindowType {
      from: now - chrono::Duration::days(window_days),
      to: now,
      timezone: "UTC".to_string(),
      bucket: TimeBucket::Day,
      requested_size: window_days as i32,
      effective_size: window_days as i32,
    };

    let ws_uuid: Option<uuid::Uuid> = workspace_filter.as_deref().and_then(|s| s.parse::<uuid::Uuid>().ok());
    let shared_link_filter = myoxus_application::admin::AdminSharedLinkFilter {
      workspace_id: ws_uuid,
      keyword: keyword_filter,
      limit: first,
      offset: skip,
    };
    let total_count = state.admin().count_shared_links(&shared_link_filter).await.unwrap_or(0);
    let rows = state
      .admin()
      .list_shared_links(shared_link_filter)
      .await
      .unwrap_or_default();

    let origin = &state.config.server.origin;
    let edges: Vec<AdminAllSharedLinkEdgeType> = rows
      .iter()
      .enumerate()
      .map(|(i, row)| {
        let doc_id = row.doc_id.clone();
        let workspace_id = row.workspace_id.to_string();
        let share_url = format!("{}/public/{}/{}", origin.trim_end_matches('/'), workspace_id, doc_id);
        let cursor = base64::Engine::encode(
          &base64::engine::general_purpose::STANDARD,
          format!("shared_link:{}", skip + i as i64),
        );
        AdminAllSharedLinkEdgeType {
          cursor,
          node: AdminAllSharedLinkType {
            workspace_id,
            doc_id,
            title: (!row.title.is_empty()).then_some(row.title.clone()),
            published_at: row.published_at,
            doc_updated_at: row.doc_updated_at,
            workspace_owner_id: row.workspace_owner_id.map(|id| id.to_string()),
            last_updater_id: row.last_updater_id.map(|id| id.to_string()),
            share_url,
            views: Some(row.total_views),
            unique_views: Some(row.unique_views),
            guest_views: Some(row.guest_views),
            last_accessed_at: row.last_viewed_at.or(row.doc_updated_at),
          },
        }
      })
      .collect();

    let has_next_page = (skip + first) < total_count;
    Ok(crate::graphql::PaginatedAdminAllSharedLinkType {
      total_count: total_count as i32,
      analytics_window,
      page_info: crate::graphql::auth::PageInfoType {
        start_cursor: edges.first().map(|e| e.cursor.clone()),
        end_cursor: edges.last().map(|e| e.cursor.clone()),
        has_next_page,
        has_previous_page: skip > 0,
      },
      edges,
    })
  }

  /// List users with rich filter (replaces flat-root `users` admin version).
  #[graphql(name = "users")]
  async fn users_list(
    &self,
    ctx: &Context<'_>,
    filter: crate::graphql::ListUserInput,
  ) -> Result<Vec<crate::graphql::auth::UserType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let skip = i64::from(filter.skip.unwrap_or(0)).max(0) as usize;
    let take = i64::from(filter.first.unwrap_or(20)).clamp(1, 100) as usize;
    if filter.features.as_ref().is_some_and(|v| !v.is_empty()) {
      let users = crate::graphql::list_users_with_feature_filter(state, filter.keyword, filter.features).await?;
      return Ok(
        users
          .into_iter()
          .skip(skip)
          .take(take)
          .map(crate::graphql::auth::UserType::from)
          .collect(),
      );
    }
    let users = state
      .admin_users()
      .list(skip as i64, take as i64, filter.keyword)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;
    Ok(users.into_iter().map(crate::graphql::auth::UserType::from).collect())
  }

  /// Count users matching filter (replaces flat-root `usersCount` admin version).
  #[graphql(name = "usersCount")]
  async fn users_count_filter(&self, ctx: &Context<'_>, filter: crate::graphql::ListUserInput) -> Result<i64> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    if let Some(features) = filter.features
      && !features.is_empty()
    {
      let users = crate::graphql::list_users_with_feature_filter(state, filter.keyword, Some(features)).await?;
      return Ok(users.len() as i64);
    }
    state
      .admin_users()
      .count(filter.keyword)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))
  }

  /// Find a user by email (replaces flat-root `userByEmail`).
  #[graphql(name = "userByEmail")]
  async fn user_by_email(&self, ctx: &Context<'_>, email: String) -> Result<Option<crate::graphql::auth::UserType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let snapshot = crate::graphql::ensure_admin_snapshot_fn(ctx, state).await?;
    let user = state
      .admin_users()
      .get_by_email_for_requester(&email, snapshot.user.id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(user.map(crate::graphql::auth::UserType::from))
  }

  /// Find a user by ID (replaces flat-root `userById`).
  #[graphql(name = "userById")]
  async fn user_by_id(&self, ctx: &Context<'_>, id: String) -> Result<crate::graphql::auth::UserType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let user_id = uuid::Uuid::parse_str(&id).map_err(|_| async_graphql::Error::new("invalid user id"))?;
    let user = state
      .admin_users()
      .get_by_id(user_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .ok_or_else(|| async_graphql::Error::new("user not found"))?;
    Ok(crate::graphql::auth::UserType::from(user))
  }

  // ── Config queries ────────────────────────────────────────────────────────

  /// Admin config schema (replaces flat-root `adminConfigSchema`).
  #[graphql(name = "adminConfigSchema")]
  async fn admin_config_schema(
    &self,
    ctx: &Context<'_>,
  ) -> Result<crate::graphql::admin_config::AdminConfigSnapshotType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    // Schema defaults must remain independent from runtime database overlays.
    // A partial or pre-upgrade values response can therefore recover a newly
    // introduced field from the startup-owned descriptor projection, while
    // `adminConfigValues` continues to carry the current effective DB value.
    let config = crate::graphql::config::typed_app_config_json(state);
    crate::graphql::admin_config::attach_effective_config_fields(
      state,
      crate::graphql::admin_config::build_admin_config_schema_snapshot(&config),
    )
    .await
  }

  /// Admin config values (replaces flat-root `adminConfigValues`).
  #[graphql(name = "adminConfigValues")]
  async fn admin_config_values(
    &self,
    ctx: &Context<'_>,
  ) -> Result<crate::graphql::admin_config::AdminConfigSnapshotType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    // The shared app-config cache also serves sparse effective-config
    // projections and therefore cannot represent this complete Admin
    // contract. Always compose startup values with canonical DB overrides at
    // this boundary so stale or partial cache entries cannot become fake
    // modules and disable the entire settings surface.
    let config = crate::graphql::admin_config::load_admin_config_json(state).await?;
    let snapshot = crate::graphql::admin_config::build_admin_config_values_snapshot(&config);
    crate::graphql::admin_config::attach_effective_config_fields(state, snapshot).await
  }

  /// Read the saved effective directory only. No draft URL/credential inputs,
  /// provider side effects, membership mutation or login dependency.
  #[tracing::instrument(skip_all)]
  async fn oidc_group_directory(&self, ctx: &Context<'_>) -> Result<AdminOidcGroupDirectory> {
    use myoxus_application::organization::oidc_directory::{OidcDirectoryEntryState, OidcDirectoryError};
    use myoxus_contracts::oauth_config::{OAuthProviderConfig, decode_oauth_provider_named};
    let state = ctx.data::<Arc<ApiState>>()?;
    let snapshot = crate::graphql::ensure_admin_snapshot_fn(ctx, state).await?;
    // Match auth::oauth::get_provider: use the live effective provider object,
    // not startup-only config, raw DB rows, or browser-supplied drafts.
    let value = state
      .effective_config()
      .await
      .value("oauth.providers.oidc")
      .filter(|value| !value.is_null())
      .ok_or_else(|| oidc_directory_error(OidcDirectoryError::Unconfigured))?;
    let provider = decode_oauth_provider_named("oidc", value)
      .map_err(|_| oidc_directory_error(OidcDirectoryError::InvalidConfiguration))?;
    let OAuthProviderConfig::Custom(provider) = provider else {
      return Err(oidc_directory_error(OidcDirectoryError::InvalidConfiguration));
    };
    let connection = provider
      .group_directory
      .as_ref()
      .ok_or_else(|| oidc_directory_error(OidcDirectoryError::Unconfigured))?;
    let directory = state
      .oidc_group_directory()
      .ok_or_else(|| oidc_directory_error(OidcDirectoryError::Transport("adapter_unavailable")))?;
    let catalog = directory.retrieve(connection).await.map_err(oidc_directory_error)?;
    tracing::info!(admin_user_id = %snapshot.user.id, group_count = catalog.entries.len(), "admin OIDC group directory retrieved");
    Ok(AdminOidcGroupDirectory {
      entries: catalog
        .entries
        .into_iter()
        .map(|entry| AdminOidcDirectoryEntry {
          id: entry.id,
          display_name: entry.display_name,
          path: entry.path,
          claim_value: entry.claim_value,
          state: match entry.state {
            OidcDirectoryEntryState::Available => AdminOidcDirectoryEntryState::Available,
            OidcDirectoryEntryState::Ambiguous => AdminOidcDirectoryEntryState::Ambiguous,
            OidcDirectoryEntryState::Unavailable => AdminOidcDirectoryEntryState::Unavailable,
          },
        })
        .collect(),
    })
  }

  /// Inspect current CA file bytes and the separately loaded startup snapshot.
  async fn admin_ca_bundle_status(&self, ctx: &Context<'_>) -> Result<super::admin_config::AdminCaBundleStatus> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>()?;
    super::admin_config::ca_bundle_status(state).await
  }

  /// Validate and atomically apply additional trust. This never reloads running transports.
  async fn admin_apply_ca_bundle(
    &self,
    ctx: &Context<'_>,
    file: Upload,
  ) -> Result<super::admin_config::AdminCaBundleStatus> {
    self.ensure_admin(ctx).await?;
    use myoxus_infrastructure::tls::bundle_management::{BundleAction, MAX_BUNDLE_BYTES};
    use std::io::Read;
    let upload = file.value(ctx)?;
    let bytes = tokio::task::spawn_blocking(move || {
      let mut bytes = Vec::new();
      upload
        .content
        .take((MAX_BUNDLE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
      Ok::<_, std::io::Error>(bytes)
    })
    .await
    .map_err(|_| "CA_OPERATION_FAILED")?
    .map_err(|_| "CA_UPLOAD_FAILED")?;
    let state = ctx.data::<Arc<ApiState>>()?;
    super::admin_config::manage_ca_bundle(ctx, state, BundleAction::Apply(bytes), "config.tls.ca.apply").await
  }

  async fn admin_restore_ca_bundle(&self, ctx: &Context<'_>) -> Result<super::admin_config::AdminCaBundleStatus> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>()?;
    super::admin_config::manage_ca_bundle(
      ctx,
      state,
      myoxus_infrastructure::tls::bundle_management::BundleAction::Restore,
      "config.tls.ca.restore",
    )
    .await
  }

  async fn admin_remove_ca_bundle(&self, ctx: &Context<'_>) -> Result<super::admin_config::AdminCaBundleStatus> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>()?;
    super::admin_config::manage_ca_bundle(
      ctx,
      state,
      myoxus_infrastructure::tls::bundle_management::BundleAction::Remove,
      "config.tls.ca.remove",
    )
    .await
  }

  /// Server-owned theme/font/branding catalog. Admin-only.
  #[graphql(name = "themeCatalog")]
  async fn theme_catalog(&self, ctx: &Context<'_>) -> Result<crate::graphql::branding::ThemeCatalogType> {
    crate::graphql::branding::BrandingAdminQueryRoot
      .theme_catalog(ctx)
      .await
  }

  /// Effective theme profile for global scope or a workspace override.
  /// Admin-only.
  #[graphql(name = "effectiveThemeProfile")]
  async fn effective_theme_profile(
    &self,
    ctx: &Context<'_>,
    workspace_id: Option<ID>,
  ) -> Result<crate::graphql::branding::ThemeProfileType> {
    crate::graphql::branding::BrandingAdminQueryRoot
      .effective_theme_profile(ctx, workspace_id)
      .await
  }

  /// Global app/server brand assets for shell, auth, setup and favicon usage.
  /// Admin-only authoring surface; public runtime projection is exposed
  /// separately so unauthenticated shells do not depend on AdminRoot.
  #[graphql(name = "appServerBranding")]
  async fn app_server_branding(&self, ctx: &Context<'_>) -> Result<crate::graphql::branding::AppServerBrandingType> {
    crate::graphql::branding::BrandingAdminQueryRoot
      .app_server_branding(ctx)
      .await
  }

  /// Global organisation identity. This is intentionally not workspace
  /// overrideable; document branding may consume it but must not redefine it.
  #[graphql(name = "organizationIdentity")]
  async fn organization_identity(
    &self,
    ctx: &Context<'_>,
  ) -> Result<crate::graphql::branding::OrganizationIdentityType> {
    crate::graphql::branding::BrandingAdminQueryRoot
      .organization_identity(ctx)
      .await
  }

  /// Set the global or workspace-specific effective theme.
  /// Admin-only and backed by `theme_profiles`, not `app_configs`.
  #[graphql(name = "setThemeProfile")]
  async fn set_theme_profile(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::branding::SetThemeProfileInput,
  ) -> Result<crate::graphql::branding::ThemeProfileType> {
    crate::graphql::branding::BrandingAdminMutationRoot
      .set_theme_profile(ctx, input)
      .await
  }

  /// Update typography styles through the typed Theme DB model.
  /// Admin-only and clone-on-write for locked system presets.
  #[graphql(name = "setTypographyStyles")]
  async fn set_typography_styles(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::branding::SetTypographyStylesInput,
  ) -> Result<crate::graphql::branding::ThemeProfileType> {
    crate::graphql::branding::BrandingAdminMutationRoot
      .set_typography_styles(ctx, input)
      .await
  }

  /// Update color schema values through the typed Theme DB model.
  /// Admin-only and clone-on-write for locked system presets.
  #[graphql(name = "setColorSchemaValues")]
  async fn set_color_schema_values(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::branding::SetColorSchemaValuesInput,
  ) -> Result<crate::graphql::branding::ThemeProfileType> {
    crate::graphql::branding::BrandingAdminMutationRoot
      .set_color_schema_values(ctx, input)
      .await
  }

  /// Remove the workspace-specific theme profile so the workspace inherits
  /// the current global profile again. Admin-only.
  #[graphql(name = "resetWorkspaceThemeProfile")]
  async fn reset_workspace_theme_profile(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::branding::ResetWorkspaceThemeProfileInput,
  ) -> Result<crate::graphql::branding::ThemeProfileType> {
    crate::graphql::branding::BrandingAdminMutationRoot
      .reset_workspace_theme_profile(ctx, input)
      .await
  }

  /// Update global organisation identity. This is not workspace-overridable
  /// and does not own the product/server display name.
  #[graphql(name = "updateOrganizationIdentity")]
  async fn update_organization_identity(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::branding::UpdateOrganizationIdentityInput,
  ) -> Result<crate::graphql::branding::OrganizationIdentityType> {
    crate::graphql::branding::BrandingAdminMutationRoot
      .update_organization_identity(ctx, input)
      .await
  }

  /// Update global app/server brand asset references. Binary upload remains
  /// the REST transport; this mutation only selects already-persisted assets.
  #[graphql(name = "updateAppServerBranding")]
  async fn update_app_server_branding(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::branding::UpdateAppServerBrandingInput,
  ) -> Result<crate::graphql::branding::AppServerBrandingType> {
    crate::graphql::branding::BrandingAdminMutationRoot
      .update_app_server_branding(ctx, input)
      .await
  }

  /// Validate config updates (replaces flat-root `validateAppConfig`).
  #[graphql(name = "validateAppConfig")]
  async fn validate_app_config(
    &self,
    ctx: &Context<'_>,
    updates: Vec<crate::graphql::UpdateAppConfigInput>,
  ) -> Result<Vec<crate::graphql::AppConfigValidateResultType>> {
    let _state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    Ok(
      updates
        .into_iter()
        .map(crate::graphql::config::validate_update)
        .collect(),
    )
  }

  /// Cache tuning status (replaces flat-root `adminCacheTuningStatus`).
  #[graphql(name = "adminCacheTuningStatus")]
  async fn admin_cache_tuning_status(&self, ctx: &Context<'_>) -> Result<Vec<crate::graphql::CacheTuningStatusType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::graphql::resolve_admin_cache_tuning_status(state).await
  }

  /// Cache tuning history (replaces flat-root `adminCacheTuningHistory`).
  #[graphql(name = "adminCacheTuningHistory")]
  async fn admin_cache_tuning_history(
    &self,
    ctx: &Context<'_>,
    cache_name: String,
    hours: Option<i32>,
  ) -> Result<Vec<crate::graphql::CacheTuningHistoryPoint>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::graphql::resolve_admin_cache_tuning_history(state, cache_name, hours).await
  }

  // ── Logging queries ───────────────────────────────────────────────────────

  /// Admin logging config (replaces flat-root `loggingConfig`).
  #[graphql(name = "loggingConfig")]
  async fn logging_config(&self, ctx: &Context<'_>) -> Result<crate::graphql::GqlLoggingConfig> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::graphql::resolve_logging_config(state).await
  }

  // ── Storage quota ─────────────────────────────────────────────────────────

  /// Storage quota config (replaces flat-root `storageQuotaConfig`).
  #[graphql(name = "storageQuotaConfig")]
  async fn storage_quota_config(
    &self,
    ctx: &Context<'_>,
  ) -> Result<crate::graphql::workspace_types::StorageQuotaConfigType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    Ok(crate::graphql::workspace_types::StorageQuotaConfigType {
      default_workspace_quota_mb: state.config.storage.default_workspace_quota_mb as i32,
    })
  }

  // ── Workspace quota details ───────────────────────────────────────────────

  /// Full quota breakdown for a single workspace (admin inspector).
  ///
  /// Returns the raw values at every level of the 4-level priority hierarchy
  /// alongside the resolved effective quota and current usage.  Returns `null`
  /// if the workspace does not exist or the DB is unavailable.
  #[graphql(name = "adminWorkspaceQuotaDetails")]
  #[instrument(skip(self, ctx))]
  async fn admin_workspace_quota_details(
    &self,
    ctx: &Context<'_>,
    workspace_id: async_graphql::ID,
  ) -> Result<Option<crate::graphql::workspace_types::WorkspaceQuotaDetailsType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;

    let wid =
      uuid::Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let Some(pool) = state.metrics_pool() else {
      return Ok(None);
    };

    let snap = myoxus_infrastructure::quota_resolver::resolve_workspace_quota_full(
      &pool,
      wid,
      state.config.storage.default_workspace_quota_mb,
    )
    .await;

    let Some(snap) = snap else {
      debug!(%wid, "adminWorkspaceQuotaDetails: workspace not found or DB error — returning null");
      return Ok(None);
    };

    let source = myoxus_application::quota::QuotaSource::resolve(snap.workspace_override_bytes, snap.config_default_mb);

    debug!(
      workspace_id = %wid,
      effective_bytes = snap.effective_bytes,
      used_bytes = snap.used_bytes(),
      ?source,
      "adminWorkspaceQuotaDetails: snapshot resolved"
    );

    Ok(Some(crate::graphql::workspace_types::WorkspaceQuotaDetailsType {
      workspace_override_bytes: snap.workspace_override_bytes,
      config_default_mb: snap.config_default_mb as i64,
      effective_bytes: snap.effective_bytes,
      used_bytes: snap.used_bytes(),
      source: source.into(),
    }))
  }

  // ── Server info (admin-authenticated) ────────────────────────────────────

  /// Server info — same data as the public `serverConfig` query, exposed under
  /// `admin { serverInfo }` for the admin frontend bootstrap.
  ///
  /// **Not gated behind admin auth.** The admin frontend's `RootRoutes` calls
  /// this on every page load (including the unauthenticated `/auth` page) to
  /// determine whether the server is initialised. Adding `ensure_admin` here
  /// breaks the login bootstrap — the React tree throws "authentication
  /// required" before the auth form can render. The fields returned are
  /// identical to the public `serverConfig` query (P95-API-03's intent to
  /// hide `availableUpgrade`/`availableUserFeatures`/`availableWorkspaceFeatures`
  /// from the public endpoint was never actually wired up — the `#[graphql(skip)]`
  /// attributes are absent from `ServerConfigType`), so gating this resolver
  /// provides zero additional confidentiality.
  #[graphql(name = "serverInfo")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn server_info(&self, ctx: &Context<'_>) -> Result<AdminServerInfoType> {
    // Re-use the caching logic from the public server_config resolver.
    let base = crate::graphql::auth::QueryRoot.server_config(ctx).await?;
    // Extract admin fields from base before move
    let available_upgrade = base.available_upgrade.clone();
    let available_user_features = base.available_user_features.clone();
    let available_workspace_features = base.available_workspace_features.clone();
    Ok(AdminServerInfoType {
      base,
      available_upgrade,
      available_user_features,
      available_workspace_features,
    })
  }

  /// Metrics runtime state for the System > Metrics admin tab.
  #[graphql(name = "metricsStatus")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn metrics_status(&self, ctx: &Context<'_>) -> Result<AdminMetricsStatusType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::admin_runtime_status::metrics_status_snapshot(state.as_ref())
      .await
      .try_into()
  }

  /// Trigger an immediate metrics flush in the running API process.
  #[graphql(name = "flushMetrics")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn flush_metrics(&self, ctx: &Context<'_>) -> Result<AdminMetricsFlushResultType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let result = crate::admin_runtime_status::flush_metrics_now(state.as_ref())
      .await
      .map_err(async_graphql::Error::new)?;
    result.try_into()
  }

  /// Telemetry runtime state for the System > Telemetry admin tab.
  #[graphql(name = "telemetryStatus")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn telemetry_status(&self, ctx: &Context<'_>) -> Result<AdminTelemetryStatusType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::admin_runtime_status::telemetry_status_snapshot(state.as_ref())
      .await
      .try_into()
  }

  /// Trigger an immediate telemetry flush in the running API process.
  #[graphql(name = "flushTelemetry")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn flush_telemetry(&self, ctx: &Context<'_>) -> Result<AdminTelemetryFlushResultType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let result = crate::admin_runtime_status::flush_telemetry_now(state.as_ref())
      .await
      .map_err(async_graphql::Error::new)?;
    result.try_into()
  }

  /// Queue runtime state for the Admin Queue page.
  #[graphql(name = "queueStatus")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn queue_status(&self, ctx: &Context<'_>) -> Result<AdminQueueStatusType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    Ok(crate::admin_queue::queue_status_snapshot(state.as_ref()).await.into())
  }

  /// Paginated jobs for one queue/status.
  #[graphql(name = "queueJobs")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn queue_jobs(
    &self,
    ctx: &Context<'_>,
    queue_name: String,
    status: String,
    cursor: i32,
    limit: i32,
  ) -> Result<AdminQueueJobsType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::admin_queue::queue_jobs(
      state.as_ref(),
      &queue_name,
      &status,
      i64::from(cursor),
      i64::from(limit),
    )
    .await
    .map(Into::into)
    .map_err(async_graphql::Error::new)
  }

  /// Pause one queue.
  #[graphql(name = "pauseQueue")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn pause_queue(&self, ctx: &Context<'_>, queue_name: String) -> Result<AdminQueueMutationResultType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::admin_queue::pause_queue(state.as_ref(), &queue_name)
      .await
      .map(Into::into)
      .map_err(async_graphql::Error::new)
  }

  /// Resume one queue.
  #[graphql(name = "resumeQueue")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn resume_queue(&self, ctx: &Context<'_>, queue_name: String) -> Result<AdminQueueMutationResultType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::admin_queue::resume_queue(state.as_ref(), &queue_name)
      .await
      .map(Into::into)
      .map_err(async_graphql::Error::new)
  }

  /// Pause every known queue.
  #[graphql(name = "pauseAllQueues")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn pause_all_queues(&self, ctx: &Context<'_>) -> Result<AdminQueueMutationResultType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    Ok(crate::admin_queue::pause_all_queues(state.as_ref()).await.into())
  }

  /// Resume every known queue.
  #[graphql(name = "resumeAllQueues")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn resume_all_queues(&self, ctx: &Context<'_>) -> Result<AdminQueueMutationResultType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    Ok(crate::admin_queue::resume_all_queues(state.as_ref()).await.into())
  }

  /// Clean completed/failed jobs for one queue.
  #[graphql(name = "cleanQueue")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn clean_queue(
    &self,
    ctx: &Context<'_>,
    queue_name: String,
    status: String,
    #[graphql(default = 3600000)] grace_period_ms: i32,
  ) -> Result<AdminQueueMutationResultType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::admin_queue::clean_queue(state.as_ref(), &queue_name, &status, i64::from(grace_period_ms))
      .await
      .map(Into::into)
      .map_err(async_graphql::Error::new)
  }

  /// Empty waiting and delayed jobs for one queue.
  #[graphql(name = "emptyQueue")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn empty_queue(&self, ctx: &Context<'_>, queue_name: String) -> Result<AdminQueueMutationResultType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::admin_queue::empty_queue(state.as_ref(), &queue_name)
      .await
      .map(Into::into)
      .map_err(async_graphql::Error::new)
  }

  /// Retry a failed job.
  #[graphql(name = "retryJob")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn retry_job(
    &self,
    ctx: &Context<'_>,
    queue_name: String,
    job_id: String,
  ) -> Result<AdminQueueMutationResultType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::admin_queue::retry_job(state.as_ref(), &queue_name, &job_id)
      .await
      .map(Into::into)
      .map_err(async_graphql::Error::new)
  }

  /// Promote a delayed job.
  #[graphql(name = "promoteJob")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn promote_job(
    &self,
    ctx: &Context<'_>,
    queue_name: String,
    job_id: String,
  ) -> Result<AdminQueueMutationResultType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::admin_queue::promote_job(state.as_ref(), &queue_name, &job_id)
      .await
      .map(Into::into)
      .map_err(async_graphql::Error::new)
  }

  // ── PDF export admin surface ─────────────────────────────────────────────

  /// Admin-only render-job list for the PDF Export diagnostics tab.
  ///
  /// The user-facing PDF export lifecycle remains on the public root
  /// (`exportPdf`, `pdfExportJob`, `documentPdfExportHistory`) because regular
  /// workspace members start and poll their own jobs. Operator diagnostics and
  /// configuration data live here so the admin frontend has one auth/cache
  /// contract for business data.
  #[graphql(name = "pdfExportJobs")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn pdf_export_jobs(
    &self,
    ctx: &Context<'_>,
    filter: Option<crate::graphql::pdf_export::AdminPdfExportJobsFilterInput>,
  ) -> Result<Vec<crate::graphql::pdf_export::PdfExportAdminJobType>> {
    crate::graphql::pdf_export::PdfExportQueryRoot
      .admin_pdf_export_jobs(ctx, filter)
      .await
  }

  /// Render an admin-side template preview PDF with representative document content.
  #[graphql(name = "pdfTemplatePreviewPdf")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn pdf_template_preview_pdf(
    &self,
    ctx: &Context<'_>,
    template_id: String,
    locale: Option<String>,
  ) -> Result<String> {
    crate::graphql::pdf_export::PdfExportQueryRoot
      .pdf_template_preview_pdf(ctx, template_id, locale, None)
      .await
  }

  /// List all ICC color profiles configured for PDF export. Admin-only.
  #[graphql(name = "pdfIccProfiles")]
  async fn pdf_icc_profiles(&self, ctx: &Context<'_>) -> Result<Vec<crate::graphql::pdf_icc::PdfIccProfileType_>> {
    crate::graphql::pdf_icc::PdfIccQueryRoot.pdf_icc_profiles(ctx).await
  }

  /// Fetch a single ICC color profile by id. Admin-only.
  #[graphql(name = "pdfIccProfile")]
  async fn pdf_icc_profile(
    &self,
    ctx: &Context<'_>,
    id: ID,
  ) -> Result<Option<crate::graphql::pdf_icc::PdfIccProfileType_>> {
    crate::graphql::pdf_icc::PdfIccQueryRoot.pdf_icc_profile(ctx, id).await
  }

  /// List fonts in the PDF export font library, optionally filtered by
  /// license status. Admin-only.
  #[graphql(name = "pdfFonts")]
  async fn pdf_fonts(
    &self,
    ctx: &Context<'_>,
    status: Option<crate::graphql::pdf_font::PdfFontLicenseStatusEnum>,
  ) -> Result<Vec<crate::graphql::pdf_font::PdfFontType>> {
    crate::graphql::pdf_font::PdfFontQueryRoot.pdf_fonts(ctx, status).await
  }

  /// Fetch a single font by id. Admin-only.
  #[graphql(name = "pdfFont")]
  async fn pdf_font(&self, ctx: &Context<'_>, id: ID) -> Result<Option<crate::graphql::pdf_font::PdfFontType>> {
    crate::graphql::pdf_font::PdfFontQueryRoot.pdf_font(ctx, id).await
  }

  /// List all PDF template assignments for a workspace. Admin-only.
  #[graphql(name = "pdfWorkspaceAssignments")]
  async fn pdf_workspace_assignments(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<crate::graphql::pdf_workspace::PdfWorkspaceTemplateAssignmentType>> {
    crate::graphql::pdf_workspace::PdfWorkspaceAdminQueryRoot
      .pdf_workspace_assignments(ctx, workspace_id)
      .await
  }

  /// List every workspace that currently has `templateId` assigned.
  /// Admin-only.
  #[graphql(name = "pdfTemplateAssignedWorkspaces")]
  async fn pdf_template_assigned_workspaces(
    &self,
    ctx: &Context<'_>,
    template_id: ID,
  ) -> Result<Vec<crate::graphql::pdf_workspace::PdfWorkspaceTemplateAssignmentType>> {
    crate::graphql::pdf_workspace::PdfWorkspaceAdminQueryRoot
      .pdf_template_assigned_workspaces(ctx, template_id)
      .await
  }

  /// Document-branding profile (including audit fields) for one workspace.
  /// Admin-only.
  #[graphql(name = "documentBrandingProfile")]
  async fn document_branding_profile(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<crate::graphql::pdf_workspace::DocumentBrandingProfileType> {
    crate::graphql::pdf_workspace::PdfWorkspaceBrandAdminQueryRoot
      .document_branding_profile(ctx, workspace_id)
      .await
  }

  /// Document-safe color palettes for the workspace's effective theme.
  /// Admin-only.
  #[graphql(name = "documentBrandColorPalettes")]
  async fn document_brand_color_palettes(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<crate::graphql::pdf_workspace::DocumentBrandColorPaletteType>> {
    crate::graphql::pdf_workspace::PdfWorkspaceBrandAdminQueryRoot
      .document_brand_color_palettes(ctx, workspace_id)
      .await
  }

  /// PDF export settings for one workspace. Admin-only.
  #[graphql(name = "pdfExportSettings")]
  async fn pdf_export_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<crate::graphql::pdf_workspace::PdfExportSettings> {
    crate::graphql::pdf_workspace::PdfWorkspaceBrandAdminQueryRoot
      .pdf_export_settings(ctx, workspace_id)
      .await
  }

  /// List every registered PDF template. Admin-only.
  #[graphql(name = "pdfTemplates")]
  async fn pdf_templates(
    &self,
    ctx: &Context<'_>,
    #[graphql(default = false)] include_deleted: bool,
  ) -> Result<Vec<crate::graphql::pdf_template_admin::PdfTemplateAdminType>> {
    crate::graphql::pdf_template_admin::PdfTemplateAdminQueryRoot
      .pdf_templates(ctx, include_deleted)
      .await
  }

  /// Fetch a single PDF template by id. Admin-only.
  #[graphql(name = "pdfTemplate")]
  async fn pdf_template(
    &self,
    ctx: &Context<'_>,
    id: ID,
  ) -> Result<Option<crate::graphql::pdf_template_admin::PdfTemplateAdminType>> {
    crate::graphql::pdf_template_admin::PdfTemplateAdminQueryRoot
      .pdf_template(ctx, id)
      .await
  }

  /// List every bundle file row for a PDF template. Admin-only.
  #[graphql(name = "pdfTemplateFiles")]
  async fn pdf_template_files(
    &self,
    ctx: &Context<'_>,
    template_id: ID,
  ) -> Result<Vec<crate::graphql::pdf_template_admin::PdfTemplateFileType>> {
    crate::graphql::pdf_template_admin::PdfTemplateAdminQueryRoot
      .pdf_template_files(ctx, template_id)
      .await
  }

  /// Cancel a queued PDF export job from the admin diagnostics view.
  #[graphql(name = "cancelPdfExportJob")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn cancel_pdf_export_job(&self, ctx: &Context<'_>, job_id: String) -> Result<bool> {
    self.ensure_admin(ctx).await?;
    crate::graphql::pdf_export::PdfExportMutationRoot
      .cancel_pdf_export_job(ctx, job_id)
      .await
  }

  /// Upload a new ICC color profile for PDF export. Admin-only.
  #[graphql(name = "uploadIccProfile")]
  #[instrument(skip(self, ctx, file), level = "debug")]
  async fn upload_icc_profile(
    &self,
    ctx: &Context<'_>,
    name: String,
    profile_type: crate::graphql::pdf_icc::PdfIccProfileTypeEnum,
    file: Upload,
  ) -> Result<crate::graphql::pdf_icc::PdfIccProfileType_> {
    crate::graphql::pdf_icc::PdfIccMutationRoot
      .upload_icc_profile(ctx, name, profile_type, file)
      .await
  }

  /// Delete an ICC color profile by id. Admin-only.
  #[graphql(name = "deleteIccProfile")]
  async fn delete_icc_profile(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    crate::graphql::pdf_icc::PdfIccMutationRoot
      .delete_icc_profile(ctx, id)
      .await
  }

  /// Upload a new font to the PDF export font library. Admin-only.
  #[graphql(name = "uploadPdfFont")]
  #[instrument(skip(self, ctx, file), level = "debug")]
  async fn upload_pdf_font(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    license: Option<String>,
  ) -> Result<crate::graphql::pdf_font::PdfFontType> {
    crate::graphql::pdf_font::PdfFontMutationRoot
      .upload_pdf_font(ctx, file, license)
      .await
  }

  /// Approve a font for use in PDF exports. Admin-only.
  #[graphql(name = "approvePdfFont")]
  async fn approve_pdf_font(&self, ctx: &Context<'_>, id: ID) -> Result<crate::graphql::pdf_font::PdfFontType> {
    crate::graphql::pdf_font::PdfFontMutationRoot
      .approve_pdf_font(ctx, id)
      .await
  }

  /// Reject a font for use in PDF exports. Admin-only.
  #[graphql(name = "rejectPdfFont")]
  async fn reject_pdf_font(
    &self,
    ctx: &Context<'_>,
    id: ID,
    reason: String,
  ) -> Result<crate::graphql::pdf_font::PdfFontType> {
    crate::graphql::pdf_font::PdfFontMutationRoot
      .reject_pdf_font(ctx, id, reason)
      .await
  }

  /// Delete a font from the library. Admin-only.
  #[graphql(name = "deletePdfFont")]
  async fn delete_pdf_font(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    crate::graphql::pdf_font::PdfFontMutationRoot
      .delete_pdf_font(ctx, id)
      .await
  }

  /// Grant a workspace access to a PDF template. Admin-only.
  #[graphql(name = "assignPdfTemplateToWorkspace")]
  async fn assign_pdf_template_to_workspace(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    template_id: ID,
  ) -> Result<crate::graphql::pdf_workspace::PdfWorkspaceTemplateAssignmentType> {
    crate::graphql::pdf_workspace::PdfWorkspaceAdminMutationRoot
      .assign_pdf_template_to_workspace(ctx, workspace_id, template_id)
      .await
  }

  /// Revoke a workspace's access to a PDF template. Admin-only.
  #[graphql(name = "unassignPdfTemplateFromWorkspace")]
  async fn unassign_pdf_template_from_workspace(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    template_id: ID,
  ) -> Result<bool> {
    crate::graphql::pdf_workspace::PdfWorkspaceAdminMutationRoot
      .unassign_pdf_template_from_workspace(ctx, workspace_id, template_id)
      .await
  }

  /// Set a workspace's default PDF template. Admin-only.
  #[graphql(name = "setWorkspaceDefaultPdfTemplate")]
  async fn set_workspace_default_pdf_template(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    template_id: ID,
  ) -> Result<crate::graphql::pdf_workspace::PdfExportSettings> {
    crate::graphql::pdf_workspace::PdfWorkspaceAdminMutationRoot
      .set_workspace_default_pdf_template(ctx, workspace_id, template_id)
      .await
  }

  /// Upload a document-branding logo (PNG or SVG). Admin-only.
  #[graphql(name = "uploadDocumentBrandLogo")]
  #[instrument(skip(self, ctx, file), level = "debug")]
  async fn upload_document_brand_logo(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    kind: crate::graphql::pdf_workspace::BrandLogoKind,
    file: Upload,
  ) -> Result<crate::graphql::pdf_workspace::DocumentBrandingProfileType> {
    crate::graphql::pdf_workspace::PdfWorkspaceBrandAdminMutationRoot
      .upload_document_brand_logo(ctx, workspace_id, kind, file)
      .await
  }

  /// Clear a document-branding logo slot. Admin-only.
  #[graphql(name = "deleteDocumentBrandLogo")]
  async fn delete_document_brand_logo(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    kind: crate::graphql::pdf_workspace::BrandLogoKind,
  ) -> Result<crate::graphql::pdf_workspace::DocumentBrandingProfileType> {
    crate::graphql::pdf_workspace::PdfWorkspaceBrandAdminMutationRoot
      .delete_document_brand_logo(ctx, workspace_id, kind)
      .await
  }

  /// Reset workspace document branding to global inheritance. Admin-only.
  #[graphql(name = "resetWorkspaceDocumentBranding")]
  async fn reset_workspace_document_branding(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<crate::graphql::pdf_workspace::DocumentBrandingProfileType> {
    crate::graphql::pdf_workspace::PdfWorkspaceBrandAdminMutationRoot
      .reset_workspace_document_branding(ctx, workspace_id)
      .await
  }

  /// Update document-facing branding text. Admin-only.
  #[graphql(name = "updateDocumentBrandingText")]
  async fn update_document_branding_text(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    footer_text: Option<String>,
  ) -> Result<crate::graphql::pdf_workspace::DocumentBrandingProfileType> {
    crate::graphql::pdf_workspace::PdfWorkspaceBrandAdminMutationRoot
      .update_document_branding_text(ctx, workspace_id, footer_text)
      .await
  }

  /// Update document branding colors. Admin-only.
  #[graphql(name = "updateDocumentBrandingColors")]
  async fn update_document_branding_colors(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    primary: Option<String>,
    accent: Option<String>,
  ) -> Result<crate::graphql::pdf_workspace::DocumentBrandingProfileType> {
    crate::graphql::pdf_workspace::PdfWorkspaceBrandAdminMutationRoot
      .update_document_branding_colors(ctx, workspace_id, primary, accent)
      .await
  }

  /// Select a server-owned document colour policy. Admin-only.
  #[graphql(name = "setDocumentBrandingColorPolicy")]
  async fn set_document_branding_color_policy(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    policy: crate::graphql::pdf_workspace::DocumentBrandColorPolicy,
    palette_key: String,
  ) -> Result<crate::graphql::pdf_workspace::DocumentBrandingProfileType> {
    crate::graphql::pdf_workspace::PdfWorkspaceBrandAdminMutationRoot
      .set_document_branding_color_policy(ctx, workspace_id, policy, palette_key)
      .await
  }

  /// Update workspace-default render parameters. Admin-only.
  #[graphql(name = "updatePdfExportSettings")]
  #[allow(clippy::too_many_arguments)]
  async fn update_pdf_export_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    paper_size: Option<String>,
    locale: Option<String>,
    color_profile: Option<String>,
    image_quality: Option<String>,
    ligatures_enabled: Option<bool>,
  ) -> Result<crate::graphql::pdf_workspace::PdfExportSettings> {
    crate::graphql::pdf_workspace::PdfWorkspaceBrandAdminMutationRoot
      .update_pdf_export_settings(
        ctx,
        workspace_id,
        paper_size,
        locale,
        color_profile,
        image_quality,
        ligatures_enabled,
      )
      .await
  }

  /// Upload a new PDF template bundle. Admin-only.
  #[graphql(name = "uploadPdfTemplate")]
  #[instrument(skip(self, ctx, manifest, file_paths, files), level = "debug")]
  async fn upload_pdf_template(
    &self,
    ctx: &Context<'_>,
    manifest: serde_json::Value,
    file_paths: Vec<String>,
    files: Vec<Upload>,
    rights_confirmed: bool,
  ) -> Result<crate::graphql::pdf_template_admin::PdfTemplateAdminType> {
    crate::graphql::pdf_template_admin::PdfTemplateAdminMutationRoot
      .upload_pdf_template(ctx, manifest, file_paths, files, rights_confirmed)
      .await
  }

  /// Atomically replace an administrator-owned PDF template bundle.
  #[graphql(name = "replacePdfTemplateBundle")]
  #[instrument(skip(self, ctx, manifest, file_paths, files), level = "debug")]
  async fn replace_pdf_template_bundle(
    &self,
    ctx: &Context<'_>,
    id: ID,
    manifest: serde_json::Value,
    file_paths: Vec<String>,
    files: Vec<Upload>,
    rights_confirmed: bool,
  ) -> Result<crate::graphql::pdf_template_admin::PdfTemplateAdminType> {
    crate::graphql::pdf_template_admin::PdfTemplateAdminMutationRoot
      .replace_pdf_template_bundle(ctx, id, manifest, file_paths, files, rights_confirmed)
      .await
  }

  /// Soft-delete a PDF template. Admin-only.
  #[graphql(name = "deletePdfTemplate")]
  async fn delete_pdf_template(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    crate::graphql::pdf_template_admin::PdfTemplateAdminMutationRoot
      .delete_pdf_template(ctx, id)
      .await
  }

  /// Update display metadata of an existing PDF template. Admin-only.
  #[graphql(name = "updatePdfTemplateMetadata")]
  async fn update_pdf_template_metadata(
    &self,
    ctx: &Context<'_>,
    id: ID,
    name: Option<String>,
    description: Option<String>,
  ) -> Result<crate::graphql::pdf_template_admin::PdfTemplateAdminType> {
    crate::graphql::pdf_template_admin::PdfTemplateAdminMutationRoot
      .update_pdf_template_metadata(ctx, id, name, description)
      .await
  }

  // ── Document-versioning admin defaults ───────────────────────────────────

  /// Global document-versioning defaults, used only when a document has no
  /// explicit settings row and its workspace has no override for a field.
  #[graphql(name = "documentVersioningDefaults")]
  #[instrument(skip(self, ctx))]
  async fn document_versioning_defaults(&self, ctx: &Context<'_>) -> Result<AdminDocumentVersioningDefaultsType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let defaults = load_document_versioning_defaults(state).await?;
    debug!(?defaults, "admin document-versioning defaults loaded");
    Ok(defaults)
  }

  /// Workspace override matrix for document-versioning defaults.
  ///
  /// Null override fields mean the workspace currently inherits the global
  /// default. Effective fields are materialised so the UI can show the actual
  /// runtime policy without duplicating inheritance rules.
  #[graphql(name = "documentVersioningWorkspaceSettings")]
  #[instrument(skip(self, ctx))]
  async fn document_versioning_workspace_settings(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<AdminDocumentVersioningWorkspaceSettingsType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let defaults = load_document_versioning_defaults(state).await?;
    let settings_repo = state
      .document_version_settings_repo()
      .ok_or_else(|| async_graphql::Error::new("document version settings repository missing"))?;
    let rows = settings_repo
      .list_workspace_overrides()
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?;
    let runtime_available = match rows.first() {
      Some(row) => {
        settings_repo
          .edit_capture_runtime_status(row.workspace_id)
          .await
          .map_err(|error| async_graphql::Error::new(error.to_string()))?
          .available
      }
      None => false,
    };

    let settings = rows
      .into_iter()
      .map(|row| map_document_versioning_workspace_row(row, &defaults, runtime_available))
      .collect::<Result<Vec<_>>>()?;
    debug!(
      count = settings.len(),
      "admin document-versioning workspace settings loaded"
    );
    Ok(settings)
  }

  /// Replace the Admin-owned workspace overrides without changing Web-owned
  /// edit-capture fields or non-PDF event triggers.
  #[graphql(name = "updateDocumentVersioningWorkspaceSettings")]
  #[instrument(skip(self, ctx, input))]
  async fn update_document_versioning_workspace_settings(
    &self,
    ctx: &Context<'_>,
    input: AdminUpdateDocumentVersioningWorkspaceSettingsInput,
  ) -> Result<AdminDocumentVersioningWorkspaceSettingsType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let actor_id = self.ensure_admin_user_id(ctx).await?;
    let workspace_id =
      Uuid::parse_str(input.workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let retention_count = input.retention_count;
    if let Some(n) = retention_count
      && !(1..=50).contains(&n)
    {
      return Err(async_graphql::Error::new("retentionCount must be between 1 and 50"));
    }
    let settings_repo = state
      .document_version_settings_repo()
      .ok_or_else(|| async_graphql::Error::new("document version settings repository missing"))?;
    let current = settings_repo
      .get_workspace_override(workspace_id)
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?
      .ok_or_else(|| async_graphql::Error::new("workspace not found"))?;
    let mut triggers = current.auto_version_on.unwrap_or_default();
    triggers.retain(|trigger| *trigger != myoxus_domain::entities::AutoVersionTrigger::OnPdfExport);
    let trigger_override = match input.auto_version_on_pdf_export {
      Some(enabled) => {
        if enabled {
          triggers.push(myoxus_domain::entities::AutoVersionTrigger::OnPdfExport);
        }
        Some(triggers)
      }
      None if triggers.is_empty() => None,
      None => Some(triggers),
    };

    let clears_override = input.enabled.is_none() && trigger_override.is_none() && retention_count.is_none();
    let row = settings_repo
      .set_workspace_override(workspace_id, input.enabled, trigger_override, retention_count, actor_id)
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?
      .ok_or_else(|| async_graphql::Error::new("workspace not found"))?;
    if clears_override {
      info!(%workspace_id, %actor_id, "document-versioning workspace override cleared");
    } else {
      info!(
        %workspace_id,
        %actor_id,
        enabled = ?input.enabled,
        auto_version_on_pdf_export = ?input.auto_version_on_pdf_export,
        retention_count = ?retention_count,
        "document-versioning workspace override updated"
      );
    }
    let workspace_name = row.workspace_name.clone();
    let defaults = load_document_versioning_defaults(state).await?;
    let runtime_available = settings_repo
      .edit_capture_runtime_status(workspace_id)
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?
      .available;
    let result = map_document_versioning_workspace_row(row, &defaults, runtime_available)?;
    let actor = resolve_audit_actor(ctx).await;
    state
      .audit_recorder()
      .record(myoxus_domain::audit::AuditEvent {
        event_key: "document_versioning.workspace_settings.update".to_string(),
        category: myoxus_domain::audit::AuditCategory::Config,
        target: Some(myoxus_domain::audit::AuditTarget::entity(
          "workspace",
          workspace_id,
          workspace_name,
        )),
        old_value: None,
        new_value: Some(serde_json::json!({
          "enabled": input.enabled,
          "autoVersionOnPdfExport": input.auto_version_on_pdf_export,
          "retentionCount": retention_count,
          "effectiveEnabled": result.effective_enabled,
          "effectiveAutoVersionOnPdfExport": result.effective_auto_version_on_pdf_export,
          "effectiveRetentionCount": result.effective_retention_count
        })),
        actor,
        metadata: Some(serde_json::json!({"surface": "admin.pdf-export.settings.document-versioning"})),
        target_unit_id: None,
      })
      .await;
    Ok(result)
  }

  // ── Canonical document metadata (admin-global policy) ──────────────────

  #[graphql(name = "documentMetadataFieldDefinitions")]
  #[instrument(skip(self, ctx))]
  async fn admin_document_metadata_field_definitions(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<crate::graphql::document_metadata_policy::DocumentMetadataFieldDefinitionType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    Ok(
      require_document_metadata_policy_repo_admin(state)?
        .list_metadata_field_definitions()
        .await
        .map_err(map_document_metadata_policy_repo_error)?
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  #[graphql(name = "documentMetadataValueDefinitions")]
  #[instrument(skip(self, ctx))]
  async fn admin_document_metadata_value_definitions(
    &self,
    ctx: &Context<'_>,
    field_key: String,
  ) -> Result<Vec<crate::graphql::document_metadata_policy::DocumentMetadataValueDefinitionType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    Ok(
      require_document_metadata_policy_repo_admin(state)?
        .list_metadata_value_definitions(&field_key)
        .await
        .map_err(map_document_metadata_policy_repo_error)?
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  #[graphql(name = "documentStatusSchemas")]
  #[instrument(skip(self, ctx))]
  async fn admin_document_status_schemas(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<crate::graphql::document_metadata_policy::DocumentStatusSchemaType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    Ok(
      require_document_metadata_policy_repo_admin(state)?
        .list_status_schemas()
        .await
        .map_err(map_document_metadata_policy_repo_error)?
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  #[graphql(name = "documentStatusValues")]
  #[instrument(skip(self, ctx))]
  async fn admin_document_status_values(
    &self,
    ctx: &Context<'_>,
    schema_key: String,
  ) -> Result<Vec<crate::graphql::document_metadata_policy::DocumentStatusValueType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    Ok(
      require_document_metadata_policy_repo_admin(state)?
        .list_status_values(&schema_key)
        .await
        .map_err(map_document_metadata_policy_repo_error)?
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  #[graphql(name = "documentTypes")]
  #[instrument(skip(self, ctx))]
  async fn admin_document_types(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<crate::graphql::document_metadata_policy::DocumentTypeDefinitionType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    Ok(
      require_document_metadata_policy_repo_admin(state)?
        .list_document_types()
        .await
        .map_err(map_document_metadata_policy_repo_error)?
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  #[graphql(name = "documentRuntimeOverview")]
  #[instrument(skip(self, ctx))]
  async fn admin_document_runtime_overview(&self, ctx: &Context<'_>) -> Result<AdminDocumentRuntimeOverviewType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let overview = require_document_metadata_policy_repo_admin(state)?
      .document_runtime_overview()
      .await
      .map_err(map_document_metadata_policy_repo_error)?;
    debug!(
      total_documents = overview.total_documents,
      "loaded admin document runtime overview"
    );
    Ok(overview.into())
  }

  #[graphql(name = "documentVersionPolicies")]
  #[instrument(skip(self, ctx))]
  async fn admin_document_version_policies(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<crate::graphql::document_version::DocumentVersionPolicyType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let repo = state
      .document_version_repo()
      .ok_or_else(|| async_graphql::Error::new("document version repository is not configured on this server"))?;
    Ok(
      repo
        .list_policies()
        .await
        .map_err(|error| async_graphql::Error::new(error.to_string()))?
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  #[graphql(name = "updateDocumentMetadataFieldDefinition")]
  #[instrument(skip(self, ctx, input), fields(key = %input.key))]
  async fn update_document_metadata_field_definition(
    &self,
    ctx: &Context<'_>,
    input: AdminUpdateDocumentMetadataFieldDefinitionInput,
  ) -> Result<crate::graphql::document_metadata_policy::DocumentMetadataFieldDefinitionType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let actor_id = self.ensure_admin_user_id(ctx).await?;
    let key = input.key.clone();
    let patch = input.into_patch(actor_id);
    let definition = require_document_metadata_policy_repo_admin(state)?
      .update_metadata_field_definition(&key, &patch)
      .await
      .map_err(map_document_metadata_policy_repo_error)?;
    record_admin_document_metadata_policy_audit(
      ctx,
      state,
      "document_metadata.policy.update",
      &key,
      serde_json::json!({
        "key": definition.key,
        "label": definition.label,
        "enabled": definition.enabled,
        "visibleInHeader": definition.visible_in_header,
        "visibleInProperties": definition.visible_in_properties,
        "visibleInLists": definition.visible_in_lists,
        "exportMode": definition.export_mode
      }),
    )
    .await;
    Ok(definition.into())
  }

  #[graphql(name = "upsertDocumentMetadataValueDefinition")]
  #[instrument(skip(self, ctx, input), fields(field_key = %input.field_key, key = %input.key))]
  async fn upsert_document_metadata_value_definition(
    &self,
    ctx: &Context<'_>,
    input: AdminUpsertDocumentMetadataValueDefinitionInput,
  ) -> Result<crate::graphql::document_metadata_policy::DocumentMetadataValueDefinitionType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let repo = require_document_metadata_policy_repo_admin(state)?;
    let value = repo
      .upsert_metadata_value_definition(&input.into_value()?)
      .await
      .map_err(map_document_metadata_policy_repo_error)?;
    record_admin_document_metadata_policy_audit(
      ctx,
      state,
      "document_metadata.value.create",
      &format!("{}:{}", value.field_key, value.key),
      serde_json::json!({
        "id": value.id,
        "fieldKey": value.field_key,
        "key": value.key,
        "label": value.label,
        "isActive": value.is_active
      }),
    )
    .await;
    Ok(value.into())
  }

  #[graphql(name = "upsertDocumentStatusSchema")]
  #[instrument(skip(self, ctx, input), fields(key = %input.key))]
  async fn upsert_document_status_schema(
    &self,
    ctx: &Context<'_>,
    input: AdminUpsertDocumentStatusSchemaInput,
  ) -> Result<crate::graphql::document_metadata_policy::DocumentStatusSchemaType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let schema = require_document_metadata_policy_repo_admin(state)?
      .upsert_status_schema(&input.into_schema()?)
      .await
      .map_err(map_document_metadata_policy_repo_error)?;
    record_admin_document_metadata_policy_audit(
      ctx,
      state,
      "document_metadata.status_schema.upsert",
      &schema.key,
      serde_json::json!({
        "id": schema.id,
        "key": schema.key,
        "label": schema.label,
        "complexity": schema.complexity,
        "isActive": schema.is_active
      }),
    )
    .await;
    Ok(schema.into())
  }

  #[graphql(name = "upsertDocumentStatusValue")]
  #[instrument(skip(self, ctx, input), fields(schema_id = ?input.schema_id, key = %input.key))]
  async fn upsert_document_status_value(
    &self,
    ctx: &Context<'_>,
    input: AdminUpsertDocumentStatusValueInput,
  ) -> Result<crate::graphql::document_metadata_policy::DocumentStatusValueType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let okf_status = input
      .okf_status
      .as_ref()
      .map(|value| {
        serde_json::from_value(serde_json::Value::String(value.clone()))
          .map_err(|_| async_graphql::Error::new("okfStatus must be draft, stable or deprecated"))
      })
      .transpose()?;
    let value = require_document_metadata_policy_repo_admin(state)?
      .upsert_status_value(&input.into_value()?, okf_status)
      .await
      .map_err(map_document_metadata_policy_repo_error)?;
    record_admin_document_metadata_policy_audit(
      ctx,
      state,
      "document_metadata.status_value.upsert",
      &value.key,
      serde_json::json!({
        "id": value.id,
        "schemaId": value.schema_id,
        "key": value.key,
        "label": value.label,
        "terminal": value.terminal,
        "okfStatus": value.okf_status,
        "isActive": value.is_active
      }),
    )
    .await;
    Ok(value.into())
  }

  #[graphql(name = "upsertDocumentStatusTransition")]
  #[instrument(skip(self, ctx, input), fields(from_status_id = ?input.from_status_id, to_status_id = ?input.to_status_id))]
  async fn upsert_document_status_transition(
    &self,
    ctx: &Context<'_>,
    input: AdminUpsertDocumentStatusTransitionInput,
  ) -> Result<crate::graphql::document_metadata_policy::DocumentStatusTransitionType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let transition = require_document_metadata_policy_repo_admin(state)?
      .upsert_status_transition(&input.into_transition()?)
      .await
      .map_err(map_document_metadata_policy_repo_error)?;
    record_admin_document_metadata_policy_audit(
      ctx,
      state,
      "document_metadata.status_transition.upsert",
      &format!("{}:{}", transition.from_status_id, transition.to_status_id),
      serde_json::json!({
        "fromStatusId": transition.from_status_id,
        "toStatusId": transition.to_status_id,
        "createsVersion": transition.creates_version,
        "requiredRoles": transition.required_roles,
        "requiredMetadataFields": transition.required_metadata_fields
      }),
    )
    .await;
    Ok(transition.into())
  }

  #[graphql(name = "upsertDocumentType")]
  #[instrument(skip(self, ctx, input), fields(key = %input.key))]
  async fn upsert_document_type(
    &self,
    ctx: &Context<'_>,
    input: AdminUpsertDocumentTypeInput,
  ) -> Result<crate::graphql::document_metadata_policy::DocumentTypeDefinitionType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let doc_type = require_document_metadata_policy_repo_admin(state)?
      .upsert_document_type(&input.into_type()?)
      .await
      .map_err(map_document_metadata_policy_repo_error)?;
    record_admin_document_metadata_policy_audit(
      ctx,
      state,
      "document_metadata.document_type.upsert",
      &doc_type.key,
      serde_json::json!({
        "id": doc_type.id,
        "key": doc_type.key,
        "label": doc_type.label,
        "isActive": doc_type.is_active,
        "isSuggested": doc_type.is_suggested
      }),
    )
    .await;
    Ok(doc_type.into())
  }

  #[graphql(name = "upsertDocumentVersionPolicy")]
  #[instrument(skip(self, ctx, input), fields(scope = %input.scope, name = %input.name))]
  async fn upsert_document_version_policy(
    &self,
    ctx: &Context<'_>,
    input: AdminUpsertDocumentVersionPolicyInput,
  ) -> Result<crate::graphql::document_version::DocumentVersionPolicyType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let actor_id = self.ensure_admin_user_id(ctx).await?;
    let repo = state
      .document_version_repo()
      .ok_or_else(|| async_graphql::Error::new("document version repository is not configured on this server"))?;
    let policy = repo
      .upsert_policy(&input.into_policy(actor_id)?)
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?;
    record_admin_document_metadata_policy_audit(
      ctx,
      state,
      "document_metadata.version_policy.upsert",
      &policy.id.to_string(),
      serde_json::json!({
        "id": policy.id,
        "scope": policy.scope,
        "workspaceId": policy.workspace_id,
        "name": policy.name,
        "isDefault": policy.is_default,
        "enabledByDefault": policy.enabled_by_default
      }),
    )
    .await;
    Ok(policy.into())
  }

  // ── Unified admin audit log ───────────────────────────────────────────────

  /// Redacted operator projection for one XWS operation discovered through
  /// the audit stream.
  #[graphql(name = "workspaceContentOperationStatus")]
  #[instrument(skip(self, ctx))]
  async fn workspace_content_operation_status(
    &self,
    ctx: &Context<'_>,
    operation_id: Uuid,
  ) -> Result<crate::graphql::auth::WorkspaceContentOperationType> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let service = state
      .workspace_content_control_service()
      .ok_or_else(|| async_graphql::Error::new("workspace content operations are unavailable"))?;
    let projection = service
      .operator_status(operation_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(crate::graphql::auth::WorkspaceContentOperationType::from_projection(
      projection,
    ))
  }

  /// Resume the durable semantic step for an operator-reviewed
  /// `cleanup_required` operation.
  #[graphql(name = "resumeWorkspaceContentCleanup")]
  #[instrument(skip(self, ctx))]
  async fn resume_workspace_content_cleanup(
    &self,
    ctx: &Context<'_>,
    operation_id: Uuid,
  ) -> Result<crate::graphql::auth::WorkspaceContentOperationType> {
    let operator_id = self.ensure_admin_user_id(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    state
      .workspace_content_control_service()
      .ok_or_else(|| async_graphql::Error::new("workspace content operations are unavailable"))?
      .resume_cleanup(operation_id, operator_id)
      .await
      .map(|record| crate::graphql::auth::WorkspaceContentOperationType::from_record(record, None))
      .map_err(crate::graphql::utils::map_gql_error)
  }

  /// Retry removal of operation-owned staging after a cancelled operation.
  #[graphql(name = "cleanupCancelledWorkspaceContentOperation")]
  #[instrument(skip(self, ctx))]
  async fn cleanup_cancelled_workspace_content_operation(
    &self,
    ctx: &Context<'_>,
    operation_id: Uuid,
  ) -> Result<crate::graphql::auth::WorkspaceContentOperationType> {
    let operator_id = self.ensure_admin_user_id(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    state
      .workspace_content_control_service()
      .ok_or_else(|| async_graphql::Error::new("workspace content operations are unavailable"))?
      .cleanup_cancelled(operation_id, operator_id)
      .await
      .map(|record| crate::graphql::auth::WorkspaceContentOperationType::from_record(record, None))
      .map_err(crate::graphql::utils::map_gql_error)
  }

  /// Unified admin audit log — lists events across all admin mutation categories.
  ///
  /// Supports filtering by `category`, `actorUserId`, `targetType`, `targetId`,
  /// `eventKeyPrefix`, and time range (`from` / `to`).  Results are ordered
  /// newest-first.
  #[graphql(name = "adminAuditLog")]
  #[instrument(skip(self, ctx))]
  async fn admin_audit_log(
    &self,
    ctx: &Context<'_>,
    filter: Option<crate::graphql::audit_types::AuditLogFilterInput>,
    #[graphql(default = 50)] limit: i32,
    #[graphql(default = 0)] offset: i32,
  ) -> Result<Vec<crate::graphql::audit_types::AdminAuditLogEntryType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;

    let domain_filter = filter.as_ref().map(|f| f.to_domain()).transpose()?.unwrap_or_default();
    let take = limit.clamp(1, 500) as i64;
    let skip = offset.max(0) as i64;

    let entries = state
      .audit_recorder()
      .list(domain_filter, skip, take)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;

    debug!(count = entries.len(), skip, take, "adminAuditLog: listed entries");

    Ok(
      entries
        .into_iter()
        .map(crate::graphql::audit_types::AdminAuditLogEntryType::from)
        .collect(),
    )
  }

  /// Count matching admin audit log entries (for pagination).
  #[graphql(name = "adminAuditLogCount")]
  #[instrument(skip(self, ctx))]
  async fn admin_audit_log_count(
    &self,
    ctx: &Context<'_>,
    filter: Option<crate::graphql::audit_types::AuditLogFilterInput>,
  ) -> Result<i64> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;

    let domain_filter = filter.as_ref().map(|f| f.to_domain()).transpose()?.unwrap_or_default();
    state
      .audit_recorder()
      .count(domain_filter)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))
  }

  /// Document-domain audit projection for the Admin Documents module.
  ///
  /// This is intentionally narrower than `adminAuditLog`: "all groups" means
  /// all document-related evidence, never the complete global audit stream.
  #[graphql(name = "adminDocumentAuditLog")]
  #[instrument(skip(self, ctx, filter))]
  async fn admin_document_audit_log(
    &self,
    ctx: &Context<'_>,
    filter: Option<crate::graphql::document_audit::AdminDocumentAuditFilterInput>,
    #[graphql(default = 50)] limit: i32,
    #[graphql(default = 0)] offset: i32,
  ) -> Result<Vec<crate::graphql::document_audit::AdminDocumentAuditEntryType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::graphql::document_audit::list_document_audit(
      state,
      filter.unwrap_or_default(),
      offset.max(0) as i64,
      limit.clamp(1, 500) as i64,
    )
    .await
  }

  /// Count document-domain audit evidence for the Admin Documents module.
  #[graphql(name = "adminDocumentAuditLogCount")]
  #[instrument(skip(self, ctx, filter))]
  async fn admin_document_audit_log_count(
    &self,
    ctx: &Context<'_>,
    filter: Option<crate::graphql::document_audit::AdminDocumentAuditFilterInput>,
  ) -> Result<i64> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::graphql::document_audit::count_document_audit(state, filter.unwrap_or_default()).await
  }

  // ── Workspace search (P-AR-0-S03) ─────────────────────────────────────────

  /// Search workspaces by name (substring, case-insensitive).
  ///
  /// Powers the admin workspace-picker (`P-AR-0-S03`). When `ouId` is set,
  /// only workspaces linked to that OU are returned. When `excludeUnitId` is
  /// set, workspaces already linked to that OU are removed so add-pickers
  /// cannot offer duplicate links. `ouId` and `excludeUnitId` are mutually
  /// exclusive. `limit` is clamped to `[1, 50]` (default 20).
  ///
  /// Returns `id`, `name`, `ownerUserId`, `ownerEmail` (snapshot), and the
  /// full set of `linkedOuIds`.
  #[graphql(name = "adminSearchWorkspaces")]
  #[instrument(skip(self, ctx))]
  async fn admin_search_workspaces(
    &self,
    ctx: &Context<'_>,
    query: String,
    ou_id: Option<ID>,
    exclude_unit_id: Option<ID>,
    limit: Option<i32>,
  ) -> Result<Vec<WorkspaceSearchResult>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;

    let parsed_ou = match ou_id.as_ref() {
      Some(raw) => {
        Some(Uuid::from_str(raw.as_str()).map_err(|_| async_graphql::Error::new("invalid organization_unit id"))?)
      }
      None => None,
    };
    let parsed_exclude_ou = match exclude_unit_id.as_ref() {
      Some(raw) => {
        Some(Uuid::from_str(raw.as_str()).map_err(|_| async_graphql::Error::new("invalid organization_unit id"))?)
      }
      None => None,
    };
    if parsed_ou.is_some() && parsed_exclude_ou.is_some() {
      return Err(async_graphql::Error::new(
        "ouId and excludeUnitId are mutually exclusive",
      ));
    }
    let take = limit.unwrap_or(20).clamp(1, 50) as i64;

    let rows = state
      .admin()
      .search_workspaces(query.as_str(), parsed_ou, parsed_exclude_ou, take)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;

    debug!(
      count = rows.len(),
      take,
      ?parsed_ou,
      ?parsed_exclude_ou,
      "adminSearchWorkspaces: returning hits"
    );

    Ok(
      rows
        .into_iter()
        .map(|r| WorkspaceSearchResult {
          id: ID(r.id.to_string()),
          name: r.name,
          owner_user_id: r.owner_user_id.map(|u| ID(u.to_string())),
          owner_email: r.owner_email,
          linked_ou_ids: r.linked_ou_ids.into_iter().map(|u| ID(u.to_string())).collect(),
        })
        .collect(),
    )
  }

  // ── User search (P-AR-0-S02) ──────────────────────────────────────────────

  /// Search users by email or name (substring, case-insensitive).
  ///
  /// Powers the admin user-picker (`P-AR-0-S02`). When `features` is set
  /// to a non-empty list, only users that have ALL of the listed
  /// user-features active are returned. `excludeUnitId` removes existing
  /// members of that OU before returning the list, so admin pickers cannot
  /// offer duplicate assignments. `limit` is clamped to `[1, 50]` (default 20).
  ///
  /// Returns `id`, `email`, `name`, `features`, `isAdmin`, `disabled`.
  #[graphql(name = "adminSearchUsers")]
  #[instrument(skip(self, ctx))]
  async fn admin_search_users(
    &self,
    ctx: &Context<'_>,
    query: String,
    features: Option<Vec<String>>,
    exclude_unit_id: Option<ID>,
    limit: Option<i32>,
  ) -> Result<Vec<UserSearchResult>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;

    let take = limit.unwrap_or(20).clamp(1, 50) as i64;
    let feature_slice = features.as_deref();

    let mut rows = state
      .admin()
      .search_users(query.as_str(), feature_slice, take)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;

    if let Some(unit_id) = exclude_unit_id.as_ref() {
      let unit_uuid = uuid::Uuid::parse_str(unit_id.as_str())
        .map_err(|_| async_graphql::Error::new("invalid organization_unit id"))?;
      let members_repo = state
        .organization_unit_member_repo()
        .ok_or_else(|| async_graphql::Error::new("organization_unit_member repo not configured"))?;
      let members = members_repo
        .list_members(unit_uuid, None)
        .await
        .map_err(|e| async_graphql::Error::new(e.to_string()))?;
      let existing: std::collections::HashSet<uuid::Uuid> = members.into_iter().map(|member| member.user_id).collect();
      rows.retain(|row| !existing.contains(&row.id));
    }

    debug!(
      count = rows.len(),
      take,
      ?feature_slice,
      exclude_unit = ?exclude_unit_id,
      "adminSearchUsers: returning hits"
    );

    Ok(
      rows
        .into_iter()
        .map(|r| UserSearchResult {
          id: ID(r.id.to_string()),
          email: r.email,
          name: r.name,
          features: r.features,
          is_admin: r.is_admin,
          disabled: r.disabled,
        })
        .collect(),
    )
  }

  // ── User OU memberships (P-AR-2-S02) ──────────────────────────────────────

  /// List all OU memberships for a single user.
  ///
  /// Powers the admin user-detail panel (`P-AR-2-S02`). Returns one row
  /// per `(unit, user)` membership including the OU snapshot (id, name,
  /// slug), the role within the OU, the membership source (manual / sync
  /// origin) and the join timestamp. Rows are ordered by OU name ASC.
  /// Empty list when the user has no memberships.
  #[graphql(name = "userOrganizationMemberships")]
  #[instrument(skip(self, ctx))]
  async fn user_organization_memberships(
    &self,
    ctx: &Context<'_>,
    user_id: ID,
  ) -> Result<Vec<UserOrganizationMembershipResult>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;

    let parsed_user_id =
      Uuid::parse_str(user_id.as_str()).map_err(|e| async_graphql::Error::new(format!("invalid userId: {e}")))?;

    let rows = state
      .organization_reads()
      .ok_or_else(|| async_graphql::Error::new("organization reads not configured"))?
      .user_memberships(parsed_user_id)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;

    debug!(
      count = rows.len(),
      %parsed_user_id,
      "userOrganizationMemberships: returning hits"
    );

    Ok(
      rows
        .into_iter()
        .map(|r| UserOrganizationMembershipResult {
          unit_id: ID(r.unit.id.to_string()),
          unit_name: r.unit.name,
          unit_slug: r.unit.slug,
          role: r.membership.role.as_str().to_string(),
          source: r.membership.source.as_str().to_string(),
          joined_at: r.membership.created_at,
        })
        .collect(),
    )
  }

  /// Last known login timestamp for one user, derived from the auth session
  /// table. This intentionally stays read-only and admin-scoped because the
  /// Organization members tab only needs stale-login diagnostics.
  #[graphql(name = "userLastLoginAt")]
  #[instrument(skip(self, ctx))]
  async fn user_last_login_at(&self, ctx: &Context<'_>, user_id: ID) -> Result<Option<DateTime<Utc>>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let parsed_user_id =
      Uuid::parse_str(user_id.as_str()).map_err(|e| async_graphql::Error::new(format!("invalid userId: {e}")))?;
    let last_login = state
      .auth()
      .last_login_at(parsed_user_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;

    debug!(
      %parsed_user_id,
      has_last_login = last_login.is_some(),
      "userLastLoginAt: resolved last login timestamp"
    );

    Ok(last_login)
  }

  // ── Config changelog (legacy alias — backed by admin_audit_log) ───────────

  /// Configuration changelog.
  ///
  /// **Deprecated** — use `adminAuditLog(filter: { category: "config" })` instead.
  /// This resolver is kept for backwards compatibility with the existing admin UI.
  /// Internally it reads from `admin_audit_log` filtered to `category = "config"`.
  #[instrument(skip(self, ctx))]
  async fn config_changelog(
    &self,
    ctx: &Context<'_>,
    #[graphql(default = 50)] limit: i32,
    #[graphql(default = 0)] offset: i32,
  ) -> Result<Vec<crate::graphql::admin_config::ConfigChangelogEntryType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::graphql::admin_config::load_config_changelog(state, Some(limit), Some(offset)).await
  }

  // ── Admin dashboard ───────────────────────────────────────────────────────

  /// Admin dashboard metrics (replaces flat-root `adminDashboard`).
  #[graphql(name = "adminDashboard")]
  async fn admin_dashboard(
    &self,
    ctx: &Context<'_>,
    input: Option<crate::graphql::AdminDashboardInput>,
  ) -> Result<crate::graphql::AdminDashboardType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::graphql::resolve_admin_dashboard(state, input).await
  }

  // ── Template registry queries ─────────────────────────────────────────────

  /// Read native workspace templates without importing or materializing sources.
  #[graphql(name = "workspaceTemplateSources")]
  #[instrument(skip_all)]
  async fn workspace_template_sources(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    #[graphql(default = 0)] skip: i32,
    #[graphql(default = 50)] take: i32,
  ) -> Result<crate::graphql::template_registry::WorkspaceTemplateSourcePageType> {
    use myoxus_application::document_template::{DocumentTemplateError, DocumentTemplateSourceRequest};

    let actor_id = self.ensure_admin_user_id(ctx).await?;
    let workspace_id = Uuid::parse_str(workspace_id.as_str())
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspaceId".into())))?;
    let offset =
      usize::try_from(skip).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid source offset".into())))?;
    let limit =
      usize::try_from(take).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid source limit".into())))?;
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let service = state
      .document_template_service()
      .ok_or("Workspace template discovery is unavailable")?;
    let metadata = state
      .document_metadata_service()
      .ok_or("Document metadata is unavailable")?;
    let registry = state.template_registry();
    let page = service
      .list_sources(
        DocumentTemplateSourceRequest {
          actor_id,
          workspace_id,
          limit,
          offset,
        },
        &metadata,
        registry.as_deref(),
      )
      .await
      .map_err(|error| match error {
        // Admin authentication has passed. Hide unavailable workspace/document
        // grants behind the existing missing-resource contract, preserving the session.
        DocumentTemplateError::Forbidden => {
          map_gql_error(AuthError::NotFound("workspace template sources unavailable".into()))
        }
        DocumentTemplateError::InvalidPagination => {
          map_gql_error(AuthError::InvalidInput("invalid source pagination".into()))
        }
        error => async_graphql::Error::new(error.to_string()),
      })?;
    Ok(crate::graphql::template_registry::WorkspaceTemplateSourcePageType {
      sources: page.sources.into_iter().map(Into::into).collect(),
      next_offset: page.next_offset.map(|offset| offset as i64),
    })
  }

  /// List template catalog entries (replaces `templateRegistry { templateCatalog(...) }`).
  #[graphql(name = "templateCatalog")]
  async fn template_catalog(
    &self,
    ctx: &Context<'_>,
    #[graphql(default = 0)] skip: i64,
    #[graphql(default = 20)] take: i64,
    status: Option<crate::graphql::template_registry::TemplateStatusType>,
  ) -> Result<Vec<crate::graphql::template_registry::TemplateCatalogEntryType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let Some(service) = crate::graphql::template_registry::optional_template_registry(state).await else {
      return Ok(vec![]);
    };
    let domain_status = status.map(|s| s.into());
    let entries = service
      .store()
      .list_catalog_entries(domain_status, skip, take)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    debug!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      skip = skip,
      take = take,
      status = ?status,
      count = entries.len(),
      "template catalog listed via GraphQL"
    );
    Ok(
      entries
        .into_iter()
        .map(crate::graphql::template_registry::TemplateCatalogEntryType::from)
        .collect(),
    )
  }

  /// Count template catalog entries (replaces `templateRegistry { templateCatalogCount(...) }`).
  #[graphql(name = "templateCatalogCount")]
  async fn template_catalog_count(
    &self,
    ctx: &Context<'_>,
    status: Option<crate::graphql::template_registry::TemplateStatusType>,
  ) -> Result<i64> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let Some(service) = crate::graphql::template_registry::optional_template_registry(state).await else {
      return Ok(0);
    };
    let domain_status = status.map(|s| s.into());
    let count = service
      .store()
      .count_catalog_entries(domain_status)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    debug!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      status = ?status,
      count = count,
      "template catalog count listed via GraphQL"
    );
    Ok(count)
  }

  /// List revisions for a template (replaces `templateRegistry { templateRevisions(...) }`).
  #[graphql(name = "templateRevisions")]
  async fn template_revisions(
    &self,
    ctx: &Context<'_>,
    template_id: ID,
    #[graphql(default = 0)] skip: i64,
    #[graphql(default = 20)] take: i64,
  ) -> Result<Vec<crate::graphql::template_registry::TemplateRevisionType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let Some(service) = crate::graphql::template_registry::optional_template_registry(state).await else {
      return Ok(vec![]);
    };
    let tid = Uuid::parse_str(template_id.as_str()).map_err(|_| async_graphql::Error::new("invalid template ID"))?;
    let revisions = service
      .store()
      .list_revisions(tid, skip, take)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    debug!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      template_id = %tid,
      skip = skip,
      take = take,
      count = revisions.len(),
      "template revisions listed via GraphQL"
    );
    Ok(
      revisions
        .into_iter()
        .map(crate::graphql::template_registry::TemplateRevisionType::from)
        .collect(),
    )
  }

  /// List template assignments for a workspace (replaces `templateRegistry { templateAssignments(...) }`).
  #[graphql(name = "templateAssignments")]
  async fn template_assignments(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    #[graphql(default = 0)] skip: i64,
    #[graphql(default = 20)] take: i64,
  ) -> Result<Vec<crate::graphql::template_registry::WorkspaceTemplatePolicyType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let Some(service) = crate::graphql::template_registry::optional_template_registry(state).await else {
      return Ok(vec![]);
    };
    let ws_id = Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace ID"))?;
    let policies = service
      .store()
      .list_policies_for_workspace(ws_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let paginated: Vec<_> = policies
      .into_iter()
      .skip(skip.max(0) as usize)
      .take(take.clamp(1, 100) as usize)
      .map(crate::graphql::template_registry::WorkspaceTemplatePolicyType::from)
      .collect();
    debug!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      workspace_id = %ws_id,
      skip = skip,
      take = take,
      count = paginated.len(),
      "template assignments listed via GraphQL"
    );
    Ok(paginated)
  }

  /// List template instances for a workspace (replaces `templateRegistry { workspaceTemplateInstances(...) }`).
  #[graphql(name = "workspaceTemplateInstances")]
  async fn workspace_template_instances(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
  ) -> Result<Vec<crate::graphql::template_registry::WorkspaceTemplateInstanceType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let Some(service) = crate::graphql::template_registry::optional_template_registry(state).await else {
      return Ok(vec![]);
    };
    let ws_id = Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace ID"))?;
    let instances = service
      .store()
      .list_instances_for_workspace(ws_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    debug!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      workspace_id = %ws_id,
      count = instances.len(),
      "workspace template instances listed via GraphQL"
    );
    Ok(
      instances
        .into_iter()
        .map(crate::graphql::template_registry::WorkspaceTemplateInstanceType::from)
        .collect(),
    )
  }

  /// List template jobs (replaces `templateRegistry { templateJobs(...) }`).
  #[graphql(name = "templateJobs")]
  async fn template_jobs(
    &self,
    ctx: &Context<'_>,
    #[graphql(default = 0)] skip: i64,
    #[graphql(default = 40)] take: i64,
  ) -> Result<Vec<crate::graphql::template_registry::TemplateJobType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let Some(service) = crate::graphql::template_registry::optional_template_registry(state).await else {
      return Ok(vec![]);
    };
    let import_jobs = service
      .store()
      .list_import_jobs(0, take + skip)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let import_job_count = import_jobs.len();
    let reconcile_jobs = service
      .store()
      .list_reconcile_jobs(0, take + skip)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let reconcile_job_count = reconcile_jobs.len();
    let mut unified: Vec<crate::graphql::template_registry::TemplateJobType> =
      Vec::with_capacity(import_jobs.len() + reconcile_jobs.len());
    for j in import_jobs {
      let template_id_str = if let Some(rev_id) = j.result_revision_id {
        if let Ok(Some(rev)) = service.store().get_revision(rev_id).await {
          debug!(
            request_id = %request_id.as_deref().unwrap_or("unavailable"),
            request_id_available = request_id.is_some(),
            job_id = %j.id,
            revision_id = %rev.id,
            template_id = %rev.template_id,
            "import template job resolved revision correlation via GraphQL"
          );
          Some(rev.template_id.to_string())
        } else {
          None
        }
      } else {
        None
      };
      let summary = j.validation_report.map(|v| v.to_string());
      debug!(
        request_id = %request_id.as_deref().unwrap_or("unavailable"),
        request_id_available = request_id.is_some(),
        job_id = %j.id,
        template_id = ?template_id_str,
        "template import job listed via GraphQL"
      );
      unified.push(crate::graphql::template_registry::TemplateJobType {
        id: ID::from(j.id),
        job_type: crate::graphql::template_registry::TemplateJobKind::Import,
        state: j.state.into(),
        template_id: template_id_str,
        workspace_id: None,
        started_at: j.started_at,
        finished_at: j.finished_at,
        summary_json: summary,
      });
    }
    for j in reconcile_jobs {
      let summary = j.summary.map(|v| v.to_string());
      debug!(
        request_id = %request_id.as_deref().unwrap_or("unavailable"),
        request_id_available = request_id.is_some(),
        job_id = %j.id,
        template_id = ?j.template_id,
        workspace_id = ?j.workspace_id,
        "template reconcile job listed via GraphQL"
      );
      unified.push(crate::graphql::template_registry::TemplateJobType {
        id: ID::from(j.id),
        job_type: crate::graphql::template_registry::TemplateJobKind::Reconcile,
        state: j.state.into(),
        template_id: j.template_id.map(|id| id.to_string()),
        workspace_id: j.workspace_id.map(|id| id.to_string()),
        started_at: j.started_at,
        finished_at: j.finished_at,
        summary_json: summary,
      });
    }
    unified.sort_by_key(|job| std::cmp::Reverse(job.started_at));
    let paginated: Vec<_> = unified
      .into_iter()
      .skip(skip.max(0) as usize)
      .take(take.clamp(1, 100) as usize)
      .collect();
    debug!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      job_count = paginated.len(),
      import_job_count = import_job_count,
      reconcile_job_count = reconcile_job_count,
      "template jobs listed via GraphQL"
    );
    Ok(paginated)
  }

  /// List all template default policies (admin only).
  ///
  /// Returns every row in `template_default_policies`. Used by the
  /// Default-Policies admin tab (P125-TPL-A-06).
  #[graphql(name = "templateDefaultPolicies")]
  #[instrument(skip(self, ctx))]
  async fn template_default_policies(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<crate::graphql::template_registry::TemplateDefaultPolicyType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let Some(service) = crate::graphql::template_registry::optional_template_registry(state).await else {
      return Ok(vec![]);
    };
    let policies = service
      .list_default_policies()
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    info!(count = policies.len(), "template default policies listed via GraphQL");
    Ok(policies.into_iter().map(|p| p.into()).collect())
  }

  // ── Server directories ────────────────────────────────────────────────────

  /// Returns disk usage information for all server-managed directories.
  ///
  /// Each entry contains the path, whether it exists on the server filesystem,
  /// and current size/free-space metrics.  I/O is performed in blocking threads
  /// via `myoxus_infrastructure::disk` so this is safe under the async runtime.
  #[graphql(name = "serverDirectories")]
  #[instrument(skip(self, ctx))]
  pub async fn server_directories(&self, ctx: &Context<'_>) -> Result<Vec<ServerDirectory>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;

    let config = &state.config;
    let mut dirs: Vec<ServerDirectory> = Vec::new();

    // Blob storage root (optional in config — skipped when not set)
    if let Some(ref root) = config.storage.root {
      dirs.push(collect_directory_info("Blob Storage", root).await);
    }

    // Log directory (parent of the log file path, if configured)
    if let Some(ref log_file) = config.logging.file_path
      && let Some(log_dir) = std::path::Path::new(log_file)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
      dirs.push(collect_directory_info("Logs", log_dir).await);
    }

    // Git-Sync repository base directory
    dirs.push(collect_directory_info("Git Sync", &config.git_sync.repo_base_dir).await);

    debug!(count = dirs.len(), "collected server directory info");
    Ok(dirs)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MUTATIONS
  // ─────────────────────────────────────────────────────────────────────────

  // ── User mutations ────────────────────────────────────────────────────────

  /// Set/unset admin privilege for a user.
  #[instrument(skip(self, ctx))]
  async fn set_user_admin(&self, ctx: &Context<'_>, user_id: ID, is_admin: bool) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let user_uuid = Uuid::parse_str(user_id.as_str()).map_err(|_| "Invalid user ID")?;
    state
      .admin_users()
      .set_admin(user_uuid, is_admin, resolve_audit_actor(ctx).await, "graphql")
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(true)
  }

  /// Create a user (replaces flat-root `createUser`).
  #[graphql(name = "createUser")]
  async fn create_user(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::CreateUserInput,
  ) -> Result<crate::graphql::auth::UserType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let actor = resolve_audit_actor(ctx).await;
    let user = state
      .admin_users()
      .create(
        &input.email,
        input.name.as_deref(),
        input.password.as_deref(),
        actor,
        "graphql",
      )
      .await
      .map_err(|error| match error {
        myoxus_application::admin::AdminUserCreationError::DuplicateEmail => {
          async_graphql::Error::new("email already used")
        }
        myoxus_application::admin::AdminUserCreationError::Auth(myoxus_application::auth::AuthError::InvalidEmail) => {
          async_graphql::Error::new("invalid email")
        }
        myoxus_application::admin::AdminUserCreationError::Auth(error) => crate::graphql::utils::map_gql_error(error),
        error => crate::graphql::utils::map_gql_error(myoxus_application::auth::AuthError::Storage(error.to_string())),
      })?;

    Ok(crate::graphql::auth::UserType::from(user))
  }

  /// Update a user (replaces flat-root `updateUser`).
  #[graphql(name = "updateUser")]
  async fn update_user(
    &self,
    ctx: &Context<'_>,
    id: String,
    input: crate::graphql::ManageUserInput,
  ) -> Result<crate::graphql::auth::UserType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let user_id = uuid::Uuid::parse_str(&id).map_err(|_| async_graphql::Error::new("invalid user id"))?;
    let update = myoxus_application::auth::UpdateAuthUser {
      name: input.name.map(Some),
      email: input.email,
      avatar_url: None,
    };
    let actor = resolve_audit_actor(ctx).await;
    let user = state
      .admin_users()
      .update(user_id, update, actor, "graphql")
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(crate::graphql::auth::UserType::from(user))
  }

  /// Delete a user (replaces flat-root `deleteUser`).
  #[graphql(name = "deleteUser")]
  #[instrument(skip(self, ctx))]
  async fn delete_user(&self, ctx: &Context<'_>, id: String) -> Result<crate::graphql::auth::DeleteAccount> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let user_id = uuid::Uuid::parse_str(&id).map_err(|_| async_graphql::Error::new("invalid user id"))?;
    state
      .admin_users()
      .delete(user_id, resolve_audit_actor(ctx).await, "graphql")
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(crate::graphql::auth::DeleteAccount { success: true })
  }

  /// Ban a user (replaces flat-root `banUser`).
  ///
  /// Delegates to the atomic auth suspension use-case; the resolver never
  /// composes user/session/API-key writes itself.
  #[graphql(name = "banUser")]
  #[instrument(skip(self, ctx))]
  async fn ban_user(&self, ctx: &Context<'_>, id: String) -> Result<crate::graphql::auth::UserType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let user_id = uuid::Uuid::parse_str(&id).map_err(|_| async_graphql::Error::new("invalid user id"))?;
    let actor = resolve_audit_actor(ctx).await;
    let user = state
      .admin_users()
      .suspend(user_id, actor, "graphql")
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(crate::graphql::auth::UserType::from(user))
  }

  /// Enable a user (replaces flat-root `enableUser`).
  ///
  /// The shared owner changes status without restoring revoked credentials.
  #[graphql(name = "enableUser")]
  #[instrument(skip(self, ctx))]
  async fn enable_user(&self, ctx: &Context<'_>, id: String) -> Result<crate::graphql::auth::UserType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let user_id = uuid::Uuid::parse_str(&id).map_err(|_| async_graphql::Error::new("invalid user id"))?;
    let actor = resolve_audit_actor(ctx).await;
    let user = state
      .admin_users()
      .enable(user_id, actor, "graphql")
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(crate::graphql::auth::UserType::from(user))
  }

  /// Import multiple users (replaces flat-root `importUsers`).
  #[graphql(name = "importUsers")]
  async fn import_users(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::ImportUsersInput,
  ) -> Result<Vec<crate::graphql::UserImportResultType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    crate::graphql::perform_import_users(state, input).await
  }

  /// Update user features/roles (replaces flat-root `updateUserFeatures`).
  #[graphql(name = "updateUserFeatures")]
  async fn update_user_features(
    &self,
    ctx: &Context<'_>,
    id: String,
    features: Vec<crate::graphql::auth::FeatureType>,
  ) -> Result<Vec<crate::graphql::auth::FeatureType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let user_id = uuid::Uuid::parse_str(&id).map_err(|_| async_graphql::Error::new("invalid user id"))?;
    let user_exists = state
      .auth()
      .get_user_by_id(user_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .is_some();
    if !user_exists {
      return Err(async_graphql::Error::new("user not found"));
    }
    let wants_admin = features.contains(&crate::graphql::auth::FeatureType::Admin);
    state
      .admin_users()
      .set_admin(user_id, wants_admin, resolve_audit_actor(ctx).await, "graphql-features")
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;
    let wants_unlimited_copilot = features.contains(&crate::graphql::auth::FeatureType::UnlimitedCopilot);
    crate::graphql::persist_user_feature_override(
      state,
      user_id,
      crate::graphql::USER_FEATURE_UNLIMITED_COPILOT,
      wants_unlimited_copilot,
    )
    .await?;
    state.invalidate_user_feature_cache_l2(user_id).await;
    tracing::info!(cache_name = "user_features", reason = "updateUserFeatures", %user_id, "cache invalidated (L1+L2+PubSub)");
    // P113-AUDIT: record feature.updateUser event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      let feature_names: Vec<String> = features.iter().map(|f| format!("{f:?}")).collect();
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "feature.updateUser",
          AuditCategory::Feature,
          Some(AuditTarget::entity("user", user_id, None)),
          actor,
          None,
          Some(serde_json::json!({ "userId": user_id.to_string(), "features": feature_names })),
        ))
        .await;
    }
    Ok(features)
  }

  /// Create a change-password URL for a user (replaces flat-root `createChangePasswordUrl`).
  #[graphql(name = "createChangePasswordUrl")]
  async fn create_change_password_url(
    &self,
    ctx: &Context<'_>,
    callback_url: Option<String>,
    user_id: String,
  ) -> Result<String> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let user_uuid = uuid::Uuid::parse_str(&user_id).map_err(|_| async_graphql::Error::new("invalid user id"))?;
    let server_origin = state.effective_config().await.server_origin();
    let actor = resolve_audit_actor(ctx).await;
    state
      .admin_users()
      .reset_link(user_uuid, &server_origin, callback_url.as_deref(), actor, "graphql")
      .await
      .map(|link| link.url)
      .map_err(crate::graphql::utils::map_gql_error)
  }

  // ── Workspace mutations ───────────────────────────────────────────────────

  /// Add a user to a workspace directly with `Accepted` status (admin bypass — no invite flow).
  ///
  /// Owner changes remain a separate operation.
  #[graphql(name = "addWorkspaceMember")]
  #[instrument(skip(self, ctx))]
  async fn add_workspace_member(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    user_id: ID,
    role: Option<String>,
  ) -> Result<crate::graphql::auth::WorkspaceMemberType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let admin_id = self.ensure_admin_user_id(ctx).await?;
    let ws_id = parse_uuid(&workspace_id)?;
    let uid = parse_uuid(&user_id)?;

    let user_exists = state
      .auth()
      .get_user_by_id(uid)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .is_some();
    if !user_exists {
      return Err(async_graphql::Error::new("user not found"));
    }

    let ws_role = workspace_role_string_to_domain(role.as_deref())?;
    state
      .workspace()
      .add_member_direct(ws_id, uid, ws_role, admin_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    info!(
      admin_id = %admin_id,
      workspace_id = %ws_id,
      user_id = %uid,
      role = ?ws_role,
      "workspace member added via admin mutation"
    );

    let member = state
      .workspace()
      .get_member(ws_id, uid)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .ok_or_else(|| async_graphql::Error::new("workspace member sync failed"))?;

    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "workspace.member.add",
          AuditCategory::Workspace,
          Some(AuditTarget::entity("workspace", ws_id, None)),
          actor,
          None,
          Some(serde_json::json!({"userId": uid, "role": format!("{:?}", member.role)})),
        ))
        .await;
    }

    Ok(crate::graphql::auth::WorkspaceMemberType::from_model(member))
  }

  /// Change a workspace member role from the admin surface.
  ///
  /// This is deliberately workspace-centric: the admin frontend only knows the
  /// workspace currently displayed in the drawer.
  #[graphql(name = "adminUpdateWorkspaceMemberRole")]
  #[instrument(skip(self, ctx))]
  async fn admin_update_workspace_member_role(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    user_id: ID,
    role: crate::graphql::auth::WorkspaceRole,
  ) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let admin_id = self.ensure_admin_user_id(ctx).await?;
    let ws_id = parse_uuid(&workspace_id)?;
    let uid = parse_uuid(&user_id)?;
    let next_role = graphql_workspace_role_to_domain(role)?;
    let before = state
      .workspace()
      .get_member(ws_id, uid)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .ok_or_else(|| async_graphql::Error::new("workspace member not found"))?;
    if before.role == DomainWorkspaceRole::Owner {
      return Err(async_graphql::Error::new(
        "workspace owner changes must use reassignWorkspaceOwner",
      ));
    }

    state
      .workspace()
      .update_member_role(ws_id, uid, next_role)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    info!(
      admin_id = %admin_id,
      workspace_id = %ws_id,
      user_id = %uid,
      old_role = ?before.role,
      new_role = ?next_role,
      "workspace member role updated via admin workspace drawer"
    );

    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "workspace.member.role-change",
          AuditCategory::Workspace,
          Some(AuditTarget::entity("workspace", ws_id, None)),
          actor,
          Some(serde_json::json!({"userId": uid, "role": format!("{:?}", before.role)})),
          Some(serde_json::json!({"userId": uid, "role": format!("{:?}", next_role)})),
        ))
        .await;
    }

    Ok(true)
  }

  /// Remove a workspace member from the admin surface.
  ///
  /// Owners must be reassigned before they can disappear.
  #[graphql(name = "adminRemoveWorkspaceMember")]
  #[instrument(skip(self, ctx))]
  async fn admin_remove_workspace_member(&self, ctx: &Context<'_>, workspace_id: ID, user_id: ID) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let admin_id = self.ensure_admin_user_id(ctx).await?;
    let ws_id = parse_uuid(&workspace_id)?;
    let uid = parse_uuid(&user_id)?;

    if admin_id == uid {
      return Err(async_graphql::Error::new(
        "admins cannot remove themselves from a workspace",
      ));
    }

    let before = state
      .workspace()
      .get_member(ws_id, uid)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .ok_or_else(|| async_graphql::Error::new("workspace member not found"))?;
    if before.role == DomainWorkspaceRole::Owner {
      return Err(async_graphql::Error::new(
        "workspace owner must be reassigned before removal",
      ));
    }

    state
      .workspace()
      .revoke_member(ws_id, uid)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    info!(
      admin_id = %admin_id,
      workspace_id = %ws_id,
      user_id = %uid,
      old_role = ?before.role,
      "workspace member removed via admin workspace drawer"
    );

    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "workspace.member.remove",
          AuditCategory::Workspace,
          Some(AuditTarget::entity("workspace", ws_id, None)),
          actor,
          Some(serde_json::json!({"userId": uid, "role": format!("{:?}", before.role)})),
          None,
        ))
        .await;
    }

    Ok(true)
  }

  /// Reassign workspace ownership to another user (admin-only).
  #[graphql(name = "reassignWorkspaceOwner")]
  #[instrument(skip(self, ctx))]
  async fn reassign_workspace_owner(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    new_owner_id: String,
  ) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let ws_id = Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let owner_id = Uuid::parse_str(&new_owner_id).map_err(|_| async_graphql::Error::new("invalid user id"))?;
    state
      .workspace()
      .reassign_owner(ws_id, owner_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    info!(workspace_id = %ws_id, new_owner_id = %owner_id, "workspace owner reassigned via admin panel");
    Ok(true)
  }

  /// Delete a workspace.
  #[instrument(skip(self, ctx))]
  async fn delete_workspace(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let workspace_id = Uuid::parse_str(id.as_str()).map_err(|_| "Invalid workspace ID")?;

    // Snapshot workspace name for audit before CASCADE DELETE removes the row.
    let ws_name: Option<String> = state
      .admin()
      .get_workspace(workspace_id)
      .await
      .ok()
      .flatten()
      .map(|w| w.name);

    // P100-SRV-A: Collect blob keys BEFORE the CASCADE DELETE wipes the blobs table.
    let blob_keys = state
      .blob()
      .list_all_workspace_blob_keys(workspace_id)
      .await
      .unwrap_or_default();
    let blob_count = blob_keys.len();

    state
      .admin()
      .delete_workspace(workspace_id)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;

    info!(workspace_id = %workspace_id, blob_count, "workspace deleted via admin panel");
    // P113-AUDIT: record workspace.delete event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "workspace.delete",
          AuditCategory::Workspace,
          Some(AuditTarget::entity("workspace", workspace_id, ws_name.clone())),
          actor,
          Some(serde_json::json!({"workspaceId": workspace_id.to_string(), "name": ws_name, "blobCount": blob_count})),
          None,
        ))
        .await;
    }

    // Enqueue async blob file cleanup job so OpenDAL files are deleted even after
    // the blobs table rows are gone via CASCADE.
    if blob_count > 0
      && let Some(queue) = state.redis_queue()
    {
      let payload = serde_json::json!({
        "workspaceId": workspace_id.to_string(),
        "blobKeys": blob_keys,
      });
      if let Err(e) = queue
        .enqueue(
          "workspace",
          "workspace.cleanupBlobs",
          payload,
          myoxus_worker::JobOptions::default(),
        )
        .await
      {
        tracing::warn!(
          workspace_id = %workspace_id,
          blob_count,
          error = %e,
          "failed to enqueue workspace.cleanupBlobs job — blob files may be orphaned"
        );
      } else {
        tracing::debug!(workspace_id = %workspace_id, blob_count, "workspace.cleanupBlobs job enqueued");
      }
    }

    Ok(true)
  }

  /// Update workspace metadata (replaces flat-root `adminUpdateWorkspace`).
  ///
  /// P112-QUOTA-C-05: Supports `storageQuotaMb` (primary, MB units) +
  /// `clearStorageQuota` flag with tri-state semantics that correctly handles
  /// clearing the override back to NULL.  The deprecated `storageQuotaBytes`
  /// field remains functional for backwards compatibility.
  ///
  /// A-04: Delegates persistence to the workspace service (Application layer)
  /// instead of executing raw SQL in the API resolver.
  #[graphql(name = "adminUpdateWorkspace")]
  #[instrument(skip_all)]
  async fn admin_update_workspace(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::workspace_types::AdminUpdateWorkspaceInput,
  ) -> Result<AdminWorkspaceType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;

    // --- Input validation (P112-QUOTA-C-05) ---
    if let Some(mb) = input.storage_quota_mb
      && mb < 0
    {
      return Err(async_graphql::Error::new("storageQuotaMb must be >= 0"));
    }
    if let Some(quota) = input.storage_quota_bytes
      && quota < 0
    {
      return Err(async_graphql::Error::new(
        "storageQuotaBytes must be >= 0 (use 0 for unlimited, null to inherit)",
      ));
    }
    if input.clear_storage_quota == Some(true) && input.storage_quota_mb.is_some() {
      warn!(
        workspace_id = %input.id,
        "adminUpdateWorkspace: clearStorageQuota=true and storageQuotaMb both set; clear takes precedence"
      );
    }

    let workspace_id =
      uuid::Uuid::parse_str(&input.id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;

    // --- Resolve storage quota tri-state ---
    // MB field has priority over deprecated bytes field.
    let storage_quota_update = if input.storage_quota_mb.is_some() || input.clear_storage_quota.is_some() {
      QuotaUpdate::from_gql_inputs(input.storage_quota_mb, input.clear_storage_quota)
    } else {
      QuotaUpdate::from_bytes(input.storage_quota_bytes)
    };

    debug!(
      %workspace_id,
      ?storage_quota_update,
      name = ?input.name,
      "adminUpdateWorkspace: applying update via workspace service"
    );

    let publication_boundary_changed = input.public.is_some() || input.enable_sharing.is_some();

    // A-04: delegate to workspace service — no raw SQL in the API layer.
    let update = myoxus_application::workspace::UpdateWorkspace {
      name: input
        .name
        .as_deref()
        .map(myoxus_application::workspace::WorkspaceName::parse)
        .transpose()
        .map_err(|error| {
          crate::graphql::utils::map_gql_error(myoxus_application::auth::AuthError::InvalidInput(error.to_string()))
        })?,
      description: None,
      avatar_key: input.avatar_key,
      public: input.public,
      enable_ai: input.enable_ai,
      enable_sharing: input.enable_sharing,
      enable_url_preview: input.enable_url_preview,
      enable_doc_embedding: input.enable_doc_embedding,
      storage_quota_update: storage_quota_update.clone(),
      overview: None,
    };

    state
      .workspace()
      .update_workspace(workspace_id, update)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;

    if publication_boundary_changed
      && let Err(error) = state.public_repository().invalidate_workspace(workspace_id).await
    {
      warn!(%workspace_id, %error, "admin workspace publication artifact invalidation failed");
    }

    // Invalidate blob quota cache so next upload sees the new limit immediately.
    if !storage_quota_update.is_unchanged() {
      state.invalidate_workspace_quota_cache(workspace_id).await;
      info!(
        cache_name = "quota",
        reason = "adminUpdateWorkspace",
        %workspace_id,
        "quota cache invalidated after workspace storage quota change"
      );
    }

    let ws = state
      .admin()
      .get_workspace(workspace_id)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?
      .ok_or_else(|| async_graphql::Error::new("workspace not found"))?;
    // P113-AUDIT: record workspace.update event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      let ws_label = Some(ws.name.clone());
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "workspace.update",
          AuditCategory::Workspace,
          Some(AuditTarget::entity("workspace", workspace_id, ws_label)),
          actor,
          None,
          Some(serde_json::json!({"storageQuotaUpdate": format!("{:?}", storage_quota_update)})),
        ))
        .await;
    }
    crate::graphql::build_admin_workspace_compat(state, ws).await
  }

  /// Add a feature to a workspace (replaces flat-root `addWorkspaceFeature`).
  #[graphql(name = "addWorkspaceFeature")]
  async fn add_workspace_feature(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    feature: crate::graphql::auth::FeatureType,
  ) -> Result<bool> {
    let result =
      crate::graphql::copilot_helpers::update_workspace_feature(ctx, workspace_id.clone(), feature, true).await?;
    // P113-AUDIT: record feature.addWorkspace event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
      let actor = resolve_audit_actor(ctx).await;
      if let Ok(ws_id) = Uuid::parse_str(&workspace_id) {
        state
          .audit_recorder()
          .record(AuditEvent::mutation(
            "feature.addWorkspace",
            AuditCategory::Feature,
            Some(AuditTarget::entity("workspace", ws_id, None)),
            actor,
            None,
            Some(serde_json::json!({ "workspaceId": workspace_id, "feature": format!("{feature:?}") })),
          ))
          .await;
      }
    }
    Ok(result)
  }

  /// Remove a feature from a workspace (replaces flat-root `removeWorkspaceFeature`).
  #[graphql(name = "removeWorkspaceFeature")]
  async fn remove_workspace_feature(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    feature: crate::graphql::auth::FeatureType,
  ) -> Result<bool> {
    let result =
      crate::graphql::copilot_helpers::update_workspace_feature(ctx, workspace_id.clone(), feature, false).await?;
    // P113-AUDIT: record feature.removeWorkspace event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
      let actor = resolve_audit_actor(ctx).await;
      if let Ok(ws_id) = Uuid::parse_str(&workspace_id) {
        state
          .audit_recorder()
          .record(AuditEvent::mutation(
            "feature.removeWorkspace",
            AuditCategory::Feature,
            Some(AuditTarget::entity("workspace", ws_id, None)),
            actor,
            None,
            Some(serde_json::json!({ "workspaceId": workspace_id, "feature": format!("{feature:?}") })),
          ))
          .await;
      }
    }
    Ok(result)
  }

  // ── Search/reindex mutations ───────────────────────────────────────────────

  /// Trigger search reindex for a workspace (replaces flat-root `triggerWorkspaceReindex`).
  #[graphql(name = "triggerWorkspaceReindex")]
  #[instrument(skip(self, ctx))]
  async fn trigger_workspace_reindex(&self, ctx: &Context<'_>, workspace_id: ID) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let ws_uuid =
      Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("Invalid workspace ID"))?;
    let indexer = state
      .search_indexer()
      .ok_or_else(|| async_graphql::Error::new("search indexer is not configured"))?;
    let run_id = indexer
      .start_full_reindex(Some(ws_uuid), 50)
      .await
      .map_err(|e| async_graphql::Error::new(format!("failed to enqueue reindex: {e}")))?;
    let database_service = state
      .database_services()
      .ok_or_else(|| async_graphql::Error::new("database service is not configured"))?;
    let mut offset = 0;
    loop {
      let databases = database_service
        .views
        .list_database_scopes(
          Some(ws_uuid),
          myoxus_domain::repositories::PageRequest { limit: 200, offset },
        )
        .await
        .map_err(|error| async_graphql::Error::new(format!("failed to enumerate Databases for reindex: {error}")))?;
      if databases.is_empty() {
        break;
      }
      for (_, database_id) in &databases {
        database_service
          .projection
          .enqueue_reindex_search(ws_uuid, *database_id)
          .await
          .map_err(|error| async_graphql::Error::new(format!("failed to enqueue Database reindex: {error}")))?;
      }
      if databases.len() < 200 {
        break;
      }
      offset += databases.len() as i64;
    }
    info!(workspace_id = %ws_uuid, %run_id, "workspace reindex triggered via admin panel");
    Ok(true)
  }

  /// Trigger a full search reindex (replaces flat-root `triggerFullReindex`).
  #[graphql(name = "triggerFullReindex")]
  #[instrument(skip(self, ctx))]
  async fn trigger_full_reindex(&self, ctx: &Context<'_>) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let indexer = state
      .search_indexer()
      .ok_or_else(|| async_graphql::Error::new("search indexer is not configured"))?;
    let run_id = indexer
      .start_full_reindex(None, 50)
      .await
      .map_err(|e| async_graphql::Error::new(format!("failed to enqueue reindex: {e}")))?;
    let database_service = state
      .database_services()
      .ok_or_else(|| async_graphql::Error::new("database service is not configured"))?;
    let mut offset = 0;
    loop {
      let databases = database_service
        .views
        .list_database_scopes(None, myoxus_domain::repositories::PageRequest { limit: 500, offset })
        .await
        .map_err(|error| {
          async_graphql::Error::new(format!("failed to enumerate Databases for full reindex: {error}"))
        })?;
      if databases.is_empty() {
        break;
      }
      for (workspace_id, database_id) in &databases {
        database_service
          .projection
          .enqueue_reindex_search(*workspace_id, *database_id)
          .await
          .map_err(|error| async_graphql::Error::new(format!("failed to enqueue Database reindex: {error}")))?;
      }
      if databases.len() < 500 {
        break;
      }
      offset += databases.len() as i64;
    }
    info!(%run_id, "global search reindex triggered via admin panel");
    Ok(true)
  }

  /// Clean up search embeddings for deleted (trashed) documents.
  ///
  /// Removes stale entries from `search_content` for docs whose `deleted_at`
  /// is set in the `docs` table.
  #[graphql(name = "triggerCleanupTrashedDocEmbeddings")]
  #[instrument(skip(self, ctx), level = "debug")]
  async fn trigger_cleanup_trashed_doc_embeddings(&self, ctx: &Context<'_>) -> Result<i32> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    self.ensure_admin(ctx).await?;
    let search = state
      .search_repository()
      .ok_or_else(|| async_graphql::Error::new("search repository not configured"))?;
    let deleted = search
      .cleanup_trashed_documents()
      .await
      .map_err(|error| async_graphql::Error::new(format!("failed to clean search content: {error}")))?;

    info!(deleted, "cleaned up trashed document search content");
    Ok(deleted as i32)
  }

  // ── Config mutations ──────────────────────────────────────────────────────

  async fn transcription_status(
    &self,
    ctx: &Context<'_>,
  ) -> Result<crate::graphql::transcription::AdminTranscriptionStatusType> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<crate::state::ApiState>>()?;
    Ok(crate::graphql::transcription::admin_status(state).await)
  }

  /// Checks only saved configuration. No caller-selected endpoint or credential
  /// can make this privileged server operation probe a different destination.
  async fn check_transcription_connection(
    &self,
    ctx: &Context<'_>,
  ) -> Result<crate::graphql::transcription::AdminTranscriptionConnectionCheckType> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<crate::state::ApiState>>()?;
    let service = state
      .transcription_service()
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?;
    Ok(service.check_connection().await.into())
  }

  /// Update admin config (replaces flat-root `adminUpdateConfig`).
  #[graphql(name = "adminUpdateConfig")]
  async fn admin_update_config(
    &self,
    ctx: &Context<'_>,
    updates: Vec<crate::graphql::UpdateAppConfigInput>,
  ) -> Result<crate::graphql::admin_config::AdminConfigUpdateResultType> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let snapshot = crate::graphql::ensure_admin_snapshot_fn(ctx, state).await?;
    crate::graphql::admin_config::admin_update_config_result(state, snapshot.user.id, updates).await
  }

  /// Send a test email (replaces flat-root `sendTestEmail`).
  #[graphql(name = "sendTestEmail")]
  async fn send_test_email(&self, ctx: &Context<'_>, config: serde_json::Value) -> Result<bool> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let snapshot = crate::graphql::ensure_admin_snapshot_fn(ctx, state).await?;
    let smtp = crate::graphql::config::parse_smtp_test_config(config, state.config.mail.sender.clone())?;
    let preferences = state
      .auth()
      .store
      .get_user_preferences(snapshot.user.id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let locale = preferences
      .values
      .resolve(&myoxus_application::auth::UserPreferenceDefaults {
        locale: state.config.i18n.default_locale.clone(),
        ..Default::default()
      })
      .locale;
    let effective = state.effective_config().await;
    let renderer = state
      .services
      .mail_template_renderer
      .clone()
      .ok_or_else(|| async_graphql::Error::new("Startup mail template catalog is unavailable"))?;
    crate::graphql::config::send_test_email_with_templates(
      &smtp,
      &snapshot.user.email,
      state.config.additional_ca.as_ref(),
      renderer,
      &locale,
      &effective.server_origin(),
    )
    .await?;
    Ok(true)
  }

  /// Test a generic OIDC provider config without returning secrets or raw claims.
  #[graphql(name = "testOidcProvider")]
  async fn test_oidc_provider(
    &self,
    ctx: &Context<'_>,
    config: serde_json::Value,
    #[graphql(name = "sampleClaims")] sample_claims: Option<serde_json::Value>,
  ) -> Result<AdminOidcProviderTestResult> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let snapshot = crate::graphql::ensure_admin_snapshot_fn(ctx, state).await?;
    let provider_config: OAuthCustomProviderConfig = myoxus_contracts::oauth_config::decode_oauth_provider(config)
      .map_err(|error| async_graphql::Error::new(format!("invalid OIDC provider config: {error}")))?;
    tracing::info!(
      admin_user_id = %snapshot.user.id,
      "admin OIDC provider diagnostic test requested"
    );
    Ok(test_oidc_provider_config(provider_config, sample_claims, state.config.additional_ca.as_ref()).await)
  }

  // ── Logging mutations ─────────────────────────────────────────────────────

  /// Update log module level (replaces flat-root `updateLogModuleLevel`).
  #[graphql(name = "updateLogModuleLevel")]
  async fn update_log_module_level(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::UpdateLogModuleLevelInput,
  ) -> Result<crate::graphql::GqlLogModuleLevel> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let snapshot = crate::graphql::ensure_admin_snapshot_fn(ctx, state).await?;
    let logging = state
      .logging()
      .ok_or_else(|| async_graphql::Error::new("logging service not available"))?;
    let level = crate::logging::LogLevel::from_str(&input.level).map_err(async_graphql::Error::new)?;
    let auto_revert = input.auto_revert_minutes.map(|m| m.max(0) as u32);
    let previous_level = logging
      .current_level(&input.group)
      .await
      .map_err(async_graphql::Error::new)?;
    let info_level = logging
      .update_level(&input.group, level, &snapshot.user.email, auto_revert)
      .await
      .map_err(async_graphql::Error::new)?;
    if let Some(mins) = auto_revert
      && mins > 0
    {
      logging.spawn_auto_revert(input.group.clone(), mins, previous_level);
    } else {
      persist_logging_config(
        state,
        snapshot.user.id,
        vec![myoxus_infrastructure::app_config::ConfigMutation::Set {
          path: "logging.level".to_string(),
          value: serde_json::Value::String(logging.build_env_filter_string().await),
        }],
      )
      .await?;
    }
    // P113-AUDIT: record logging.updateLevel event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "logging.updateLevel",
          AuditCategory::Logging,
          None,
          actor,
          None,
          Some(serde_json::json!({
            "group": input.group,
            "level": input.level,
            "autoRevertMinutes": input.auto_revert_minutes,
          })),
        ))
        .await;
    }
    Ok(crate::graphql::GqlLogModuleLevel {
      group: info_level.group,
      display_name: info_level.display_name,
      level: info_level.current_level.to_string(),
      recommended_default: info_level.recommended_default.to_string(),
      description: info_level.description,
      high_volume_warning: info_level.high_volume_warning,
    })
  }

  /// Reset all log levels (replaces flat-root `resetLogLevels`).
  #[graphql(name = "resetLogLevels")]
  async fn reset_log_levels(&self, ctx: &Context<'_>) -> Result<Vec<crate::graphql::GqlLogModuleLevel>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let snapshot = crate::graphql::ensure_admin_snapshot_fn(ctx, state).await?;
    let logging = state
      .logging()
      .ok_or_else(|| async_graphql::Error::new("logging service not available"))?;
    logging
      .reset_all(&snapshot.user.email)
      .await
      .map_err(async_graphql::Error::new)?;
    persist_logging_config(
      state,
      snapshot.user.id,
      vec![myoxus_infrastructure::app_config::ConfigMutation::Set {
        path: "logging.level".to_string(),
        value: serde_json::Value::String(logging.build_env_filter_string().await),
      }],
    )
    .await?;
    // P113-AUDIT: record logging.resetAll event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "logging.resetAll",
          AuditCategory::Logging,
          None,
          actor,
          None,
          None,
        ))
        .await;
    }
    let levels = logging.current_levels().await;
    Ok(
      levels
        .into_iter()
        .map(|l| crate::graphql::GqlLogModuleLevel {
          group: l.group,
          display_name: l.display_name,
          level: l.current_level.to_string(),
          recommended_default: l.recommended_default.to_string(),
          description: l.description,
          high_volume_warning: l.high_volume_warning,
        })
        .collect(),
    )
  }

  /// Apply a log preset (replaces flat-root `applyLogPreset`).
  #[graphql(name = "applyLogPreset")]
  async fn apply_log_preset(
    &self,
    ctx: &Context<'_>,
    preset: String,
  ) -> Result<Vec<crate::graphql::GqlLogModuleLevel>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let snapshot = crate::graphql::ensure_admin_snapshot_fn(ctx, state).await?;
    let logging = state
      .logging()
      .ok_or_else(|| async_graphql::Error::new("logging service not available"))?;
    logging
      .apply_preset(&preset, &snapshot.user.email)
      .await
      .map_err(async_graphql::Error::new)?;
    persist_logging_config(
      state,
      snapshot.user.id,
      vec![myoxus_infrastructure::app_config::ConfigMutation::Set {
        path: "logging.level".to_string(),
        value: serde_json::Value::String(logging.build_env_filter_string().await),
      }],
    )
    .await?;
    // P113-AUDIT: record logging.applyPreset event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "logging.applyPreset",
          AuditCategory::Logging,
          None,
          actor,
          None,
          Some(serde_json::json!({ "preset": preset })),
        ))
        .await;
    }
    let levels = logging.current_levels().await;
    Ok(
      levels
        .into_iter()
        .map(|l| crate::graphql::GqlLogModuleLevel {
          group: l.group,
          display_name: l.display_name,
          level: l.current_level.to_string(),
          recommended_default: l.recommended_default.to_string(),
          description: l.description,
          high_volume_warning: l.high_volume_warning,
        })
        .collect(),
    )
  }

  /// Update log output config (replaces flat-root `updateLogOutput`).
  #[graphql(name = "updateLogOutput")]
  async fn update_log_output(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::UpdateLogOutputInput,
  ) -> Result<crate::graphql::GqlLogOutputConfig> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let snapshot = crate::graphql::ensure_admin_snapshot_fn(ctx, state).await?;
    let configured = crate::graphql::admin_config::load_admin_config_json(state).await?;
    let logging_config = configured.get("logging").cloned().unwrap_or_default();
    let file_path = input.file_path.or_else(|| {
      logging_config
        .get("file_path")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
    });
    let rotation_str = input
      .rotation
      .unwrap_or_else(|| {
        logging_config
          .get("rotation")
          .and_then(serde_json::Value::as_str)
          .unwrap_or("daily")
          .to_string()
      })
      .to_ascii_lowercase();
    let max_files = input.max_files.unwrap_or_else(|| {
      logging_config
        .get("max_files")
        .and_then(serde_json::Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .unwrap_or(state.config.logging.max_files as i32)
    });
    let (path_valid, path_error) = if let Some(ref path) = file_path {
      crate::graphql::validate_log_path(path)
    } else {
      (true, None)
    };
    if path_valid {
      let mut mutations = vec![
        myoxus_infrastructure::app_config::ConfigMutation::Set {
          path: "logging.rotation".to_string(),
          value: serde_json::Value::String(rotation_str.clone()),
        },
        myoxus_infrastructure::app_config::ConfigMutation::Set {
          path: "logging.max_files".to_string(),
          value: serde_json::json!(max_files),
        },
      ];
      mutations.push(myoxus_infrastructure::app_config::ConfigMutation::Set {
        path: "logging.file_path".to_string(),
        value: file_path
          .as_ref()
          .map_or(serde_json::Value::Null, |path| serde_json::Value::String(path.clone())),
      });
      persist_logging_config(state, snapshot.user.id, mutations).await?;
    }
    let rotation_gql = match rotation_str.as_str() {
      "hourly" => crate::graphql::GqlLogRotation::Hourly,
      "daily" => crate::graphql::GqlLogRotation::Daily,
      "weekly" => crate::graphql::GqlLogRotation::Weekly,
      _ => crate::graphql::GqlLogRotation::Never,
    };
    // P113-AUDIT: record logging.updateOutput event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "logging.updateOutput",
          AuditCategory::Logging,
          None,
          actor,
          None,
          Some(serde_json::json!({
            "filePath": file_path.as_deref(),
            "rotation": rotation_str.as_str(),
            "maxFiles": max_files,
          })),
        ))
        .await;
    }
    Ok(crate::graphql::GqlLogOutputConfig {
      file_path,
      rotation: rotation_gql,
      max_files,
      path_valid,
      path_error,
      requires_restart: true,
    })
  }

  // ── Template registry mutations ───────────────────────────────────────────

  /// Import a template bundle (replaces `templateRegistry { importTemplate(...) }`).
  #[graphql(name = "importTemplate")]
  #[instrument(skip(self, ctx, file))]
  async fn import_template(
    &self,
    ctx: &Context<'_>,
    file: Upload,
  ) -> Result<crate::graphql::template_registry::TemplateImportResultType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    let user_id = self.ensure_admin_user_id(ctx).await?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let max_size_bytes = state.config.template_registry.import_max_bundle_size_mb * 1024 * 1024;
    let upload = file
      .value(ctx)
      .map_err(|e| async_graphql::Error::new(format!("invalid upload: {e}")))?;
    let mut data = Vec::new();
    use std::io::Read;
    let mut reader = upload.content.take(max_size_bytes.saturating_add(1));
    reader
      .read_to_end(&mut data)
      .map_err(|e| async_graphql::Error::new(format!("failed to read uploaded file: {e}")))?;
    if data.len() as u64 > max_size_bytes {
      return Err(async_graphql::Error::new(format!(
        "bundle exceeds maximum size of {} MB",
        state.config.template_registry.import_max_bundle_size_mb
      )));
    }
    let result = service
      .import_from_bundle_with_filename_detailed(&data, &upload.filename, user_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let detected_format = result.detected_format.as_str();
    info!(request_id = %request_id.as_deref().unwrap_or("unavailable"),
      template_id = %result.entry.id, revision_id = %result.revision.id,
      detected_format, "template document imported via GraphQL");
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      let target = Some(AuditTarget::entity(
        "template",
        result.entry.id,
        result.entry.title.clone(),
      ));
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "template.import",
          AuditCategory::Template,
          target,
          actor,
          None,
          Some(serde_json::json!({
            "templateId": result.entry.id.to_string(), "revisionId": result.revision.id.to_string(),
            "format": detected_format,
          })),
        ))
        .await;
    }
    Ok(crate::graphql::template_registry::TemplateImportResultType {
      entry: Some(result.entry.clone().into()),
      revision: Some(result.revision.clone().into()),
      documents: vec![crate::graphql::template_registry::TemplateImportedDocumentType {
        entry: result.entry.into(),
        revision: result.revision.into(),
      }],
      warnings: result
        .warnings
        .into_iter()
        .map(crate::graphql::template_registry::ValidationErrorType::from)
        .collect(),
      detected_format: detected_format.to_string(),
      normalized: result.normalized,
      ignored_entries_count: result.ignored_entries_count as i32,
      error_catalog_version: myoxus_application::template_registry::TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION.to_string(),
      package: None,
      job_id: None,
      error: None,
    })
  }

  /// Publish a template revision (replaces `templateRegistry { publishRevision(...) }`).
  #[graphql(name = "publishRevision")]
  #[instrument(skip(self, ctx))]
  async fn publish_revision(
    &self,
    ctx: &Context<'_>,
    revision_id: ID,
  ) -> Result<crate::graphql::template_registry::TemplateRevisionType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let user_id = self.ensure_admin_user_id(ctx).await?;
    let rid = Uuid::parse_str(revision_id.as_str()).map_err(|_| async_graphql::Error::new("invalid revision ID"))?;
    let revision = service
      .publish_revision_with_actor(rid, Some(user_id))
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    info!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      actor_user_id = %user_id,
      template_id = %revision.template_id,
      revision_id = %revision.id,
      "template revision published via GraphQL"
    );
    // P113-AUDIT: record template.publish event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "template.publish",
          AuditCategory::Template,
          Some(AuditTarget::entity("template", revision.template_id, None)),
          actor,
          None,
          Some(serde_json::json!({
            "templateId": revision.template_id.to_string(),
            "revisionId": revision.id.to_string(),
          })),
        ))
        .await;
    }
    Ok(revision.into())
  }

  /// Assign a template to a workspace (replaces `templateRegistry { assignTemplateToWorkspace(...) }`).
  #[graphql(name = "assignTemplateToWorkspace")]
  #[instrument(skip(self, ctx))]
  async fn assign_template_to_workspace(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    template_id: ID,
    selection_mode: crate::graphql::template_registry::SelectionModeType,
    selected_revision_id: Option<ID>,
    provisioning_mode: crate::graphql::template_registry::ProvisioningModeType,
  ) -> Result<crate::graphql::template_registry::WorkspaceTemplatePolicyType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let user_id = self.ensure_admin_user_id(ctx).await?;
    let ws_id = Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace ID"))?;
    let tid = Uuid::parse_str(template_id.as_str()).map_err(|_| async_graphql::Error::new("invalid template ID"))?;
    let selected_revision_id = selected_revision_id
      .map(|id| Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid revision ID")))
      .transpose()?;
    let policy = service
      .assign_template_to_workspace_with_actor(
        ws_id,
        tid,
        selection_mode.into(),
        selected_revision_id,
        provisioning_mode.into(),
        Some(user_id),
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let entry = service
      .get_catalog_entry_for_binding(tid)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    if entry.is_some_and(|entry| entry.source != myoxus_domain::template_registry::TemplateSource::Builtin) {
      // A successful bundle assignment must leave a usable source. Keep the
      // policy when materialization fails so the existing reconcile operation
      // can retry it, but surface the failure to the administrator.
      let instances = service
        .reconcile_workspace_templates(ws_id)
        .await
        .map_err(crate::graphql::utils::map_gql_error)?;
      if !instances
        .iter()
        .any(|instance| instance.template_id == tid && instance.workspace_doc_key.is_some())
      {
        return Err(async_graphql::Error::new(
          "template assignment was retained, but workspace source materialization failed; trigger reconcile to retry",
        ));
      }
    }
    info!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      actor_user_id = %user_id,
      workspace_id = %ws_id,
      template_id = %tid,
      policy_id = %policy.id,
      selected_revision_id = ?policy.selected_revision_id,
      selection_mode = ?policy.selection_mode,
      provisioning_mode = ?policy.provisioning_mode,
      "template assigned to workspace via GraphQL"
    );
    // P113-AUDIT: record template.assign event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "template.assign",
          AuditCategory::Template,
          Some(AuditTarget::entity("workspace", ws_id, None)),
          actor,
          None,
          Some(serde_json::json!({
            "templateId": tid.to_string(),
            "workspaceId": ws_id.to_string(),
            "policyId": policy.id.to_string(),
          })),
        ))
        .await;
    }
    Ok(policy.into())
  }

  /// Apply a selected usable revision to an existing manual-update assignment.
  #[graphql(name = "applyTemplateManualUpdate")]
  #[instrument(skip(self, ctx))]
  async fn apply_template_manual_update(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    template_id: ID,
    revision_id: ID,
  ) -> Result<crate::graphql::template_registry::WorkspaceTemplateInstanceType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let user_id = self.ensure_admin_user_id(ctx).await?;
    let ws_id = Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace ID"))?;
    let tid = Uuid::parse_str(template_id.as_str()).map_err(|_| async_graphql::Error::new("invalid template ID"))?;
    let rid = Uuid::parse_str(revision_id.as_str()).map_err(|_| async_graphql::Error::new("invalid revision ID"))?;
    let instance = service
      .apply_manual_update(ws_id, tid, rid)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    info!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      actor_user_id = %user_id,
      workspace_id = %ws_id,
      template_id = %tid,
      revision_id = %rid,
      instance_id = %instance.id,
      "manual template update applied via GraphQL"
    );
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "template.manual_update",
          AuditCategory::Template,
          Some(AuditTarget::entity("workspace", ws_id, None)),
          actor,
          None,
          Some(serde_json::json!({
            "templateId": tid.to_string(),
            "revisionId": rid.to_string(),
            "instanceId": instance.id.to_string(),
          })),
        ))
        .await;
    }
    Ok(instance.into())
  }

  /// Remove a template assignment (replaces `templateRegistry { removeTemplateAssignment(...) }`).
  #[graphql(name = "removeTemplateAssignment")]
  #[instrument(skip(self, ctx))]
  async fn remove_template_assignment(&self, ctx: &Context<'_>, policy_id: ID) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let user_id = self.ensure_admin_user_id(ctx).await?;
    let pid = Uuid::parse_str(policy_id.as_str()).map_err(|_| async_graphql::Error::new("invalid policy ID"))?;
    service
      .remove_template_assignment_with_actor(pid, Some(user_id))
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    info!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      actor_user_id = %user_id,
      policy_id = %pid,
      "template assignment removed via GraphQL"
    );
    // P113-AUDIT: record template.unassign event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "template.unassign",
          AuditCategory::Template,
          Some(AuditTarget::entity("policy", pid, None)),
          actor,
          None,
          Some(serde_json::json!({ "policyId": pid.to_string() })),
        ))
        .await;
    }
    Ok(true)
  }

  /// Trigger template reconcile for a workspace (replaces `templateRegistry { triggerReconcile(...) }`).
  #[graphql(name = "triggerReconcile")]
  #[instrument(skip(self, ctx))]
  async fn trigger_reconcile(&self, ctx: &Context<'_>, workspace_id: String) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let _service = crate::graphql::template_registry::require_template_registry(state).await?;
    let ws_id = Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace ID"))?;
    let queue = state
      .redis_queue()
      .ok_or_else(|| async_graphql::Error::new("job queue not available"))?;
    let job_id = queue
      .enqueue(
        "template-registry",
        "template-registry.reconcileWorkspace",
        serde_json::json!({ "workspaceId": ws_id.to_string() }),
        myoxus_worker::JobOptions::default(),
      )
      .await
      .map_err(|e| async_graphql::Error::new(format!("failed to enqueue reconcile job: {e}")))?;
    info!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      workspace_id = %ws_id,
      job_id = %job_id,
      "reconcile job enqueued via GraphQL"
    );
    Ok(true)
  }

  /// Retire a template assignment (replaces `templateRegistry { retireTemplateAssignment(...) }`).
  #[graphql(name = "retireTemplateAssignment")]
  #[instrument(skip(self, ctx))]
  async fn retire_template_assignment(&self, ctx: &Context<'_>, policy_id: ID) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let user_id = self.ensure_admin_user_id(ctx).await?;
    let pid = Uuid::parse_str(policy_id.as_str()).map_err(|_| async_graphql::Error::new("invalid policy ID"))?;
    service
      .retire_template_assignment_with_actor(pid, Some(user_id))
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    info!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      actor_user_id = %user_id,
      policy_id = %pid,
      "template assignment retired via GraphQL"
    );
    // P113-AUDIT: record template.retire event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "template.retire",
          AuditCategory::Template,
          Some(AuditTarget::entity("policy", pid, None)),
          actor,
          None,
          Some(serde_json::json!({ "policyId": pid.to_string() })),
        ))
        .await;
    }
    Ok(true)
  }

  /// Archive a template (replaces `templateRegistry { archiveTemplate(...) }`).
  #[graphql(name = "archiveTemplate")]
  #[instrument(skip(self, ctx))]
  async fn archive_template(
    &self,
    ctx: &Context<'_>,
    template_id: ID,
  ) -> Result<crate::graphql::template_registry::TemplateCatalogEntryType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let tid = Uuid::parse_str(template_id.as_str()).map_err(|_| async_graphql::Error::new("invalid template ID"))?;
    let actor = resolve_audit_actor(ctx).await;
    let entry = service
      .transition_catalog(
        tid,
        myoxus_domain::template_registry::TemplateStatus::Archived,
        false,
        actor,
        state.audit_recorder(),
        "graphql",
      )
      .await
      .map_err(map_template_transition_error)?;
    info!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      template_id = %tid,
      "template archived via GraphQL"
    );
    Ok(entry.into())
  }

  /// Disable a template (replaces `templateRegistry { disableTemplate(...) }`).
  #[graphql(name = "disableTemplate")]
  #[instrument(skip(self, ctx))]
  async fn disable_template(
    &self,
    ctx: &Context<'_>,
    template_id: ID,
  ) -> Result<crate::graphql::template_registry::TemplateCatalogEntryType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let tid = Uuid::parse_str(template_id.as_str()).map_err(|_| async_graphql::Error::new("invalid template ID"))?;
    let actor = resolve_audit_actor(ctx).await;
    let entry = service
      .transition_catalog(
        tid,
        myoxus_domain::template_registry::TemplateStatus::Disabled,
        false,
        actor,
        state.audit_recorder(),
        "graphql",
      )
      .await
      .map_err(map_template_transition_error)?;
    info!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      template_id = %tid,
      "template disabled via GraphQL"
    );
    Ok(entry.into())
  }

  /// Enable a template (replaces `templateRegistry { enableTemplate(...) }`).
  #[graphql(name = "enableTemplate")]
  #[instrument(skip(self, ctx))]
  async fn enable_template(
    &self,
    ctx: &Context<'_>,
    template_id: ID,
  ) -> Result<crate::graphql::template_registry::TemplateCatalogEntryType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let tid = Uuid::parse_str(template_id.as_str()).map_err(|_| async_graphql::Error::new("invalid template ID"))?;
    let actor = resolve_audit_actor(ctx).await;
    let entry = service
      .transition_catalog(
        tid,
        myoxus_domain::template_registry::TemplateStatus::Active,
        false,
        actor,
        state.audit_recorder(),
        "graphql",
      )
      .await
      .map_err(map_template_transition_error)?;
    info!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      template_id = %tid,
      "template enabled via GraphQL"
    );
    Ok(entry.into())
  }

  /// Export a revision's metadata (replaces `templateRegistry { exportRevision(...) }`).
  #[graphql(name = "exportRevision")]
  #[instrument(skip(self, ctx))]
  async fn export_revision(
    &self,
    ctx: &Context<'_>,
    revision_id: ID,
  ) -> Result<crate::graphql::template_registry::TemplateRevisionType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let rid = Uuid::parse_str(revision_id.as_str()).map_err(|_| async_graphql::Error::new("invalid revision ID"))?;
    let revision = service
      .store()
      .get_revision(rid)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?
      .ok_or_else(|| async_graphql::Error::new("revision not found"))?;
    if revision.state != myoxus_domain::template_registry::RevisionState::Published
      && revision.state != myoxus_domain::template_registry::RevisionState::Deprecated
    {
      return Err(async_graphql::Error::new(format!(
        "cannot export revision in state '{}' — only Published or Deprecated revisions can be exported",
        revision.state
      )));
    }
    info!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      template_id = %revision.template_id,
      revision_id = %revision.id,
      revision_state = ?revision.state,
      "template revision metadata exported via GraphQL"
    );
    Ok(revision.into())
  }

  /// Trigger drift scan for a workspace (replaces `templateRegistry { triggerDriftScan(...) }`).
  #[graphql(name = "triggerDriftScan")]
  #[instrument(skip(self, ctx))]
  async fn trigger_drift_scan(&self, ctx: &Context<'_>, workspace_id: String) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let request_id = template_registry_request_id(ctx);
    self.ensure_admin(ctx).await?;
    let _service = crate::graphql::template_registry::require_template_registry(state).await?;
    let ws_id = Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace ID"))?;
    let queue = state
      .redis_queue()
      .ok_or_else(|| async_graphql::Error::new("job queue not available"))?;
    let job_id = queue
      .enqueue(
        "template-registry",
        "template-registry.driftScanWorkspace",
        serde_json::json!({ "workspaceId": ws_id.to_string() }),
        myoxus_worker::JobOptions::default(),
      )
      .await
      .map_err(|e| async_graphql::Error::new(format!("failed to enqueue drift scan job: {e}")))?;
    info!(
      request_id = %request_id.as_deref().unwrap_or("unavailable"),
      request_id_available = request_id.is_some(),
      workspace_id = %ws_id,
      job_id = %job_id,
      "drift scan job enqueued via GraphQL"
    );
    Ok(true)
  }

  // ── P103-B-04: Doc cache flush mutations ──────────────────────────────────

  /// Flush the doc snapshot Redis cache.
  ///
  /// Deletes all `doc_snapshot:*` keys in Redis. Returns the number of
  /// deleted keys (or 0 when the cache is not configured). Requires admin.
  #[graphql(name = "adminFlushDocSnapshotCache")]
  async fn admin_flush_doc_snapshot_cache(&self, ctx: &Context<'_>) -> Result<i32> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>()?.clone();
    let count = if let Some(cache) = state.doc().doc_cache() {
      cache.flush_snapshot_cache().await as i32
    } else {
      0
    };
    // P113-AUDIT: record cache.flushDocSnapshot event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "cache.flushDocSnapshot",
          AuditCategory::Cache,
          None,
          actor,
          None,
          Some(serde_json::json!({ "deletedKeys": count })),
        ))
        .await;
    }
    Ok(count)
  }

  /// Flush the doc metadata Redis cache.
  ///
  /// Deletes all `doc_meta:*` keys in Redis. Returns the number of deleted
  /// keys. Requires admin.
  #[graphql(name = "adminFlushDocMetadataCache")]
  async fn admin_flush_doc_metadata_cache(&self, ctx: &Context<'_>) -> Result<i32> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>()?.clone();
    let count = if let Some(cache) = state.doc().doc_cache() {
      cache.flush_metadata_cache().await as i32
    } else {
      0
    };
    // P113-AUDIT: record cache.flushDocMetadata event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "cache.flushDocMetadata",
          AuditCategory::Cache,
          None,
          actor,
          None,
          Some(serde_json::json!({ "deletedKeys": count })),
        ))
        .await;
    }
    Ok(count)
  }

  /// Flush the canonical document metadata projection Redis cache.
  ///
  /// Deletes all `doc_metadata_projection:*` keys in Redis. Returns the number
  /// of deleted keys. Requires admin.
  #[graphql(name = "adminFlushDocMetadataProjectionCache")]
  async fn admin_flush_doc_metadata_projection_cache(&self, ctx: &Context<'_>) -> Result<i32> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>()?.clone();
    let count = if let Some(cache) = state.doc().doc_cache() {
      cache.flush_metadata_projection_cache().await as i32
    } else {
      0
    };
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "cache.flushDocMetadataProjection",
          AuditCategory::Cache,
          None,
          actor,
          None,
          Some(serde_json::json!({ "deletedKeys": count })),
        ))
        .await;
    }
    Ok(count)
  }

  /// Flush all doc Redis caches (snapshot, metadata, timestamps, compaction
  /// locks). Returns the total number of deleted keys. Requires admin.
  #[graphql(name = "adminFlushAllDocCaches")]
  async fn admin_flush_all_doc_caches(&self, ctx: &Context<'_>) -> Result<i32> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>()?.clone();
    let count = if let Some(cache) = state.doc().doc_cache() {
      cache.flush_all_doc_caches().await as i32
    } else {
      0
    };
    // P113-AUDIT: record cache.flushAllDoc event
    {
      use myoxus_domain::audit::{AuditCategory, AuditEvent};
      let actor = resolve_audit_actor(ctx).await;
      state
        .audit_recorder()
        .record(AuditEvent::mutation(
          "cache.flushAllDoc",
          AuditCategory::Cache,
          None,
          actor,
          None,
          Some(serde_json::json!({ "deletedKeys": count })),
        ))
        .await;
    }
    Ok(count)
  }

  // ─── Builtin Template Bridge admin mutations (P125-TPL-S-04) ────────────

  /// Bump the builder_version of a builtin template slug.
  ///
  /// The shared owner commits one increment and attempts a reconcile hint.
  /// Returns the current version and target count, not delivery acknowledgements.
  #[graphql(name = "bumpBuilderVersion")]
  #[instrument(skip(self, ctx))]
  async fn bump_builder_version(
    &self,
    ctx: &Context<'_>,
    slug: String,
  ) -> Result<crate::graphql::template_registry::BumpBuilderVersionResult> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let (new_version, workspace_ids) = service
      .bump_builder_version(&slug)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;

    // The shared owner already attempted fanout; this is a target count.
    let workspaces_notified = workspace_ids.len() as i32;

    info!(slug = %slug, new_version, workspaces_notified, "builder version bumped via admin GQL");
    Ok(crate::graphql::template_registry::BumpBuilderVersionResult {
      slug,
      new_version: new_version as i32,
      workspaces_notified,
    })
  }

  /// Set a template default policy (admin only).
  ///
  /// Creates or updates the row in `template_default_policies` that drives
  /// automatic seeding of new workspaces.
  #[graphql(name = "setTemplateDefaultPolicy")]
  #[instrument(skip(self, ctx))]
  async fn set_template_default_policy(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::template_registry::SetTemplateDefaultPolicyInput,
  ) -> Result<bool> {
    self.ensure_admin(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let template_id = Uuid::parse_str(&input.template_id).map_err(|_| "invalid template_id")?;
    let now = chrono::Utc::now();
    let policy = myoxus_domain::template_registry::TemplateDefaultPolicy {
      template_id,
      apply_to_new_workspaces: input.apply_to_new_workspaces,
      selection_mode: myoxus_domain::template_registry::SelectionMode::from(input.selection_mode),
      provisioning_mode: myoxus_domain::template_registry::ProvisioningMode::from(input.provisioning_mode),
      created_at: now,
      updated_at: now,
    };
    service
      .set_default_policy(policy)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(true)
  }

  /// Set a per-workspace builtin-template override from the admin surface.
  ///
  /// The workspace-facing mutation is intentionally not used by the
  /// adminfrontend: operator actions must run through the AdminRoot auth
  /// contract and must not depend on the admin user being a member of the
  /// target workspace.
  #[graphql(name = "setWorkspaceTemplateOverride")]
  #[instrument(skip(self, ctx, input))]
  async fn set_workspace_template_override(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::template_registry::SetWorkspaceTemplateOverrideInput,
  ) -> Result<bool> {
    let admin_user_id = self.ensure_admin_user_id(ctx).await?;
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let workspace_uuid = Uuid::parse_str(&input.workspace_id).map_err(|_| "invalid workspace_id")?;
    let template_uuid = Uuid::parse_str(&input.template_id).map_err(|_| "invalid template_id")?;
    let provisioning_mode = input
      .provisioning_mode
      .map(myoxus_domain::template_registry::ProvisioningMode::from);

    service
      .set_workspace_template_override(
        workspace_uuid,
        template_uuid,
        input.is_enabled,
        provisioning_mode,
        Some(admin_user_id),
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    info!(
      workspace_id = %workspace_uuid,
      template_id = %template_uuid,
      enabled = input.is_enabled,
      admin_user_id = %admin_user_id,
      "admin set workspace template override"
    );
    Ok(true)
  }

  /// Update category/tags of a builtin template (admin only).
  ///
  /// Title/description/slug are locked for builtins — only category and tags
  /// are writable (§6.4 of the design doc).
  #[graphql(name = "updateBuiltinTemplateMetadata")]
  #[instrument(skip(self, ctx))]
  async fn update_builtin_template_metadata(
    &self,
    ctx: &Context<'_>,
    template_id: ID,
    category: Option<String>,
    tags: Option<Vec<String>>,
  ) -> Result<crate::graphql::template_registry::TemplateCatalogEntryType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let user_id = self.ensure_admin_user_id(ctx).await?;
    let service = crate::graphql::template_registry::require_template_registry(state).await?;
    let tid = Uuid::parse_str(template_id.as_str()).map_err(|_| "invalid template_id")?;
    let entry = service
      .update_builtin_metadata(tid, category, tags, Some(user_id))
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(entry.into())
  }

  // ── Organization (admin surface) ───────────────────────────────────────────
  // All methods delegate to the dedicated `OrganizationQueryRoot` /
  // `OrganizationMutationRoot` implementations in
  // `crate::graphql::organization`. They are mounted here so the admin sub-
  // root remains the single GraphQL entry-point for the organization
  // management surface (§Paket D of `docs/dev/server/organization-management.md`).

  async fn organization(&self, ctx: &Context<'_>) -> Result<crate::graphql::organization::OrganizationType> {
    crate::graphql::organization::OrganizationQueryRoot
      .organization(ctx)
      .await
  }

  async fn organization_units(
    &self,
    ctx: &Context<'_>,
    status: Option<crate::graphql::organization::OrganizationUnitStatusEnum>,
  ) -> Result<Vec<crate::graphql::organization::OrganizationUnitTypeOutput>> {
    crate::graphql::organization::OrganizationQueryRoot
      .organization_units(ctx, status)
      .await
  }

  async fn organization_unit(
    &self,
    ctx: &Context<'_>,
    id: ID,
  ) -> Result<Option<crate::graphql::organization::OrganizationUnitTypeOutput>> {
    crate::graphql::organization::OrganizationQueryRoot
      .organization_unit(ctx, id)
      .await
  }

  async fn organization_unit_types(
    &self,
    ctx: &Context<'_>,
    include_inactive: Option<bool>,
  ) -> Result<Vec<crate::graphql::organization::OrganizationUnitTypeType>> {
    crate::graphql::organization::OrganizationQueryRoot
      .organization_unit_types(ctx, include_inactive)
      .await
  }

  async fn organization_unit_members(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    role: Option<crate::graphql::organization::OrganizationUnitRoleEnum>,
  ) -> Result<Vec<crate::graphql::organization::OrganizationUnitMemberType>> {
    crate::graphql::organization::OrganizationQueryRoot
      .organization_unit_members(ctx, unit_id, role)
      .await
  }

  async fn organization_unit_workspaces(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
  ) -> Result<Vec<crate::graphql::organization::OrganizationUnitWorkspaceType>> {
    crate::graphql::organization::OrganizationQueryRoot
      .organization_unit_workspaces(ctx, unit_id)
      .await
  }

  async fn workspace_organization_unit_workspaces(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<crate::graphql::organization::OrganizationUnitWorkspaceType>> {
    crate::graphql::organization::OrganizationQueryRoot
      .workspace_organization_unit_workspaces(ctx, workspace_id)
      .await
  }

  async fn organization_policy(
    &self,
    ctx: &Context<'_>,
  ) -> Result<crate::graphql::organization::OrganizationPolicyType> {
    crate::graphql::organization::OrganizationQueryRoot
      .organization_policy(ctx)
      .await
  }

  async fn organization_project_requests(
    &self,
    ctx: &Context<'_>,
    status: Option<crate::graphql::organization::ProjectRequestStatusEnum>,
  ) -> Result<Vec<crate::graphql::organization::OrganizationProjectRequestType>> {
    crate::graphql::organization::OrganizationQueryRoot
      .organization_project_requests(ctx, status)
      .await
  }

  async fn update_organization(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::organization::UpdateOrganizationInput,
  ) -> Result<crate::graphql::organization::OrganizationType> {
    crate::graphql::organization::OrganizationMutationRoot
      .update_organization(ctx, input)
      .await
  }

  async fn upsert_organization_unit_type(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::organization::UpsertOrganizationUnitTypeInput,
  ) -> Result<crate::graphql::organization::OrganizationUnitTypeType> {
    crate::graphql::organization::OrganizationMutationRoot
      .upsert_organization_unit_type(ctx, input)
      .await
  }

  async fn deactivate_organization_unit_type(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    crate::graphql::organization::OrganizationMutationRoot
      .deactivate_organization_unit_type(ctx, id)
      .await
  }

  async fn upsert_organization_unit(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::organization::UpsertOrganizationUnitInput,
  ) -> Result<crate::graphql::organization::OrganizationUnitTypeOutput> {
    crate::graphql::organization::OrganizationMutationRoot
      .upsert_organization_unit(ctx, input)
      .await
  }

  async fn set_organization_unit_parent(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    parent_unit_id: Option<ID>,
  ) -> Result<bool> {
    crate::graphql::organization::OrganizationMutationRoot
      .set_organization_unit_parent(ctx, unit_id, parent_unit_id)
      .await
  }

  async fn deactivate_organization_unit(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    crate::graphql::organization::OrganizationMutationRoot
      .deactivate_organization_unit(ctx, id)
      .await
  }

  async fn set_organization_unit_status(
    &self,
    ctx: &Context<'_>,
    id: ID,
    status: crate::graphql::organization::OrganizationUnitStatusEnum,
  ) -> Result<crate::graphql::organization::OrganizationUnitTypeOutput> {
    crate::graphql::organization::OrganizationMutationRoot
      .set_organization_unit_status(ctx, id, status)
      .await
  }

  async fn organization_unit_deletion_preview(
    &self,
    ctx: &Context<'_>,
    id: ID,
  ) -> Result<crate::graphql::organization_lifecycle::OrganizationUnitDeletionPreviewType> {
    crate::graphql::organization::OrganizationMutationRoot
      .organization_unit_deletion_preview(ctx, id)
      .await
  }

  async fn delete_organization_unit_permanently(
    &self,
    ctx: &Context<'_>,
    id: ID,
    confirmed_name: String,
    preview_revision: DateTime<Utc>,
  ) -> Result<bool> {
    crate::graphql::organization::OrganizationMutationRoot
      .delete_organization_unit_permanently(ctx, id, confirmed_name, preview_revision)
      .await
  }

  async fn update_organization_policy(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::organization::UpdateOrganizationPolicyInput,
  ) -> Result<crate::graphql::organization::OrganizationPolicyType> {
    crate::graphql::organization::OrganizationMutationRoot
      .update_organization_policy(ctx, input)
      .await
  }

  async fn set_user_manager_feature(&self, ctx: &Context<'_>, user_id: ID, enabled: bool) -> Result<bool> {
    crate::graphql::organization::OrganizationMutationRoot
      .set_user_manager_feature(ctx, user_id, enabled)
      .await
  }

  async fn assign_organization_manager(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::organization::AssignOrganizationManagerInput,
  ) -> Result<crate::graphql::organization::OrganizationUnitMemberType> {
    crate::graphql::organization::OrganizationMutationRoot
      .assign_organization_manager(ctx, input)
      .await
  }

  async fn unassign_organization_manager(&self, ctx: &Context<'_>, unit_id: ID, user_id: ID) -> Result<bool> {
    crate::graphql::organization::OrganizationMutationRoot
      .unassign_organization_manager(ctx, unit_id, user_id)
      .await
  }

  async fn assign_organization_unit_workspace(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::organization::AssignOrganizationUnitWorkspaceInput,
  ) -> Result<bool> {
    crate::graphql::organization::OrganizationMutationRoot
      .assign_organization_unit_workspace(ctx, input)
      .await
  }

  async fn unassign_organization_unit_workspace(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    workspace_id: ID,
    relationship: crate::graphql::organization::OrganizationUnitWorkspaceRelationshipEnum,
  ) -> Result<bool> {
    crate::graphql::organization::OrganizationMutationRoot
      .unassign_organization_unit_workspace(ctx, unit_id, workspace_id, relationship)
      .await
  }

  async fn decide_organization_project_request(
    &self,
    ctx: &Context<'_>,
    id: ID,
    new_status: crate::graphql::organization::ProjectRequestStatusEnum,
  ) -> Result<bool> {
    crate::graphql::organization::OrganizationMutationRoot
      .decide_organization_project_request(ctx, id, new_status)
      .await
  }

  // ── Organization Import / Export ───────────────────────────────────────────

  async fn organization_export(
    &self,
    ctx: &Context<'_>,
  ) -> Result<crate::graphql::organization::OrganizationExportType> {
    crate::graphql::organization::OrganizationImportExportRoot
      .organization_export(ctx)
      .await
  }

  async fn organization_import_dry_run(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::organization::OrganizationImportInput,
  ) -> Result<crate::graphql::organization::OrganizationImportPreviewType> {
    crate::graphql::organization::OrganizationImportExportRoot
      .organization_import_dry_run(ctx, input)
      .await
  }

  async fn organization_import_apply(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::organization::OrganizationImportInput,
  ) -> Result<crate::graphql::organization::OrganizationImportPreviewType> {
    crate::graphql::organization::OrganizationImportExportRoot
      .organization_import_apply(ctx, input)
      .await
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

use crate::graphql::utils::{map_gql_error, require_session};

impl AdminRoot {
  /// Verify that the session user is an admin; return `ActionForbidden` otherwise.
  pub async fn ensure_admin(&self, ctx: &Context<'_>) -> Result<()> {
    let (_, snapshot) = require_session(ctx).await?;
    if !snapshot.user.is_admin {
      tracing::warn!(user_id = %snapshot.user.id, "unauthorized admin access attempt");
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    Ok(())
  }

  /// Verify admin and return user ID.
  async fn ensure_admin_user_id(&self, ctx: &Context<'_>) -> Result<Uuid> {
    let (_, snapshot) = require_session(ctx).await?;
    if !snapshot.user.is_admin {
      tracing::warn!(user_id = %snapshot.user.id, "unauthorized admin access attempt");
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    Ok(snapshot.user.id)
  }
}

impl AdminUpdateDocumentMetadataFieldDefinitionInput {
  fn into_patch(self, actor_id: Uuid) -> DocumentMetadataFieldDefinitionPatch {
    DocumentMetadataFieldDefinitionPatch {
      label: self.label,
      enabled: self.enabled,
      required_mode: self.required_mode,
      editable_by: self.editable_by,
      visible_in_header: self.visible_in_header,
      visible_in_properties: self.visible_in_properties,
      visible_in_lists: self.visible_in_lists,
      export_mode: self.export_mode,
      validation_config: self.validation_config,
      metadata: self.metadata,
      updated_by: Some(actor_id),
    }
  }
}

impl AdminUpsertDocumentMetadataValueDefinitionInput {
  fn into_value(self) -> Result<DocumentMetadataValueDefinition> {
    Ok(DocumentMetadataValueDefinition {
      id: parse_admin_optional_uuid(self.id, "id")?.unwrap_or_else(Uuid::new_v4),
      field_key: self.field_key,
      key: self.key,
      label: self.label,
      description: self.description,
      color: self.color,
      icon: self.icon,
      sort_order: self.sort_order.unwrap_or(0),
      is_active: self.is_active.unwrap_or(true),
      metadata: self.metadata.unwrap_or_else(|| serde_json::json!({})),
    })
  }
}

impl AdminUpsertDocumentStatusSchemaInput {
  fn into_schema(self) -> Result<DocumentStatusSchema> {
    Ok(DocumentStatusSchema {
      id: parse_admin_optional_uuid(self.id, "id")?.unwrap_or_else(Uuid::new_v4),
      key: self.key,
      label: self.label,
      description: self.description,
      complexity: self.complexity,
      // Admin-created schemas are custom unless explicitly marked as preset by seed/migration tooling.
      is_preset: self.is_preset.unwrap_or(false),
      is_active: self.is_active.unwrap_or(true),
      metadata: self.metadata.unwrap_or_else(|| serde_json::json!({})),
    })
  }
}

impl AdminUpsertDocumentStatusValueInput {
  fn into_value(self) -> Result<DocumentStatusValue> {
    Ok(DocumentStatusValue {
      id: parse_admin_optional_uuid(self.id, "id")?.unwrap_or_else(Uuid::new_v4),
      schema_id: parse_admin_uuid(&self.schema_id, "schemaId")?,
      key: self.key,
      label: self.label,
      description: self.description,
      color: self.color,
      icon: self.icon,
      sort_order: self.sort_order.unwrap_or(0),
      terminal: self.terminal.unwrap_or(false),
      is_active: self.is_active.unwrap_or(true),
      okf_status: Default::default(),
      metadata: self.metadata.unwrap_or_else(|| serde_json::json!({})),
    })
  }
}

impl AdminUpsertDocumentStatusTransitionInput {
  fn into_transition(self) -> Result<DocumentStatusTransition> {
    let sets_version_kind = self.sets_version_kind.as_deref().map(DocumentVersionKind::from);
    Ok(DocumentStatusTransition {
      from_status_id: parse_admin_uuid(&self.from_status_id, "fromStatusId")?,
      to_status_id: parse_admin_uuid(&self.to_status_id, "toStatusId")?,
      required_roles: self.required_roles.unwrap_or_default(),
      required_metadata_fields: self.required_metadata_fields.unwrap_or_default(),
      creates_version: self.creates_version.unwrap_or_else(|| "never".to_string()),
      sets_version_kind,
      date_enforcement: self.date_enforcement.unwrap_or_else(|| "warn".to_string()),
      metadata: self.metadata.unwrap_or_else(|| serde_json::json!({})),
    })
  }
}

impl AdminUpsertDocumentTypeInput {
  fn into_type(self) -> Result<DocumentTypeDefinition> {
    Ok(DocumentTypeDefinition {
      id: parse_admin_optional_uuid(self.id, "id")?.unwrap_or_else(Uuid::new_v4),
      key: self.key,
      label: self.label,
      description: self.description,
      icon: self.icon,
      color: self.color,
      is_active: self.is_active.unwrap_or(true),
      is_suggested: self.is_suggested.unwrap_or(false),
    })
  }
}

impl AdminUpsertDocumentVersionPolicyInput {
  fn into_policy(self, actor_id: Uuid) -> Result<DocumentVersionPolicy> {
    let workspace_id = parse_admin_optional_uuid(self.workspace_id, "workspaceId")?;
    if self.scope == "global" && workspace_id.is_some() {
      return Err(async_graphql::Error::new(
        "global document version policies must not set workspaceId",
      ));
    }
    if self.scope == "workspace" && workspace_id.is_none() {
      return Err(async_graphql::Error::new(
        "workspace document version policies require workspaceId",
      ));
    }
    let auto_version_on = self
      .auto_version_on
      .unwrap_or_default()
      .into_iter()
      .map(parse_admin_auto_version_trigger)
      .collect::<Result<Vec<_>>>()?;
    Ok(DocumentVersionPolicy {
      id: parse_admin_optional_uuid(self.id, "id")?.unwrap_or_else(Uuid::new_v4),
      scope: self.scope,
      workspace_id,
      name: self.name,
      is_default: self.is_default.unwrap_or(false),
      enabled_by_default: self.enabled_by_default.unwrap_or(false),
      scheme_preset: self.scheme_preset.unwrap_or_else(|| "simple_counter".to_string()),
      custom_pattern: self.custom_pattern,
      timezone_mode: self.timezone_mode.unwrap_or_else(|| "utc".to_string()),
      auto_version_on,
      retention_count: self.retention_count.unwrap_or(10),
      pin_manual_versions: self.pin_manual_versions.unwrap_or(false),
      pin_publish_versions: self.pin_publish_versions.unwrap_or(true),
      published_versions_protected: self.published_versions_protected.unwrap_or(true),
      export_versions_protected: self.export_versions_protected.unwrap_or(false),
      metadata_schema: self.metadata_schema.unwrap_or_else(|| serde_json::json!({})),
      created_by: Some(actor_id),
      created_at: Utc::now(),
      updated_by: Some(actor_id),
      updated_at: Utc::now(),
    })
  }
}

fn parse_admin_uuid(id: &ID, field: &'static str) -> Result<Uuid> {
  Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new(format!("invalid {field}")))
}

fn parse_admin_optional_uuid(id: Option<ID>, field: &'static str) -> Result<Option<Uuid>> {
  id.as_ref().map(|id| parse_admin_uuid(id, field)).transpose()
}

fn parse_admin_auto_version_trigger(value: String) -> Result<AutoVersionTrigger> {
  match value.as_str() {
    "on-publish" | "on_publish" => Ok(AutoVersionTrigger::OnPublish),
    "on-pdf-export" | "on_pdf_export" => Ok(AutoVersionTrigger::OnPdfExport),
    "daily" => Ok(AutoVersionTrigger::Daily),
    _ => Err(async_graphql::Error::new(format!(
      "invalid autoVersionOn trigger '{value}'"
    ))),
  }
}

fn require_document_metadata_policy_repo_admin(
  state: &ApiState,
) -> Result<Arc<dyn myoxus_domain::repositories::DocumentMetadataPolicyRepository>> {
  state
    .document_metadata_policy_repo()
    .ok_or_else(|| async_graphql::Error::new("document metadata repository is not configured on this server"))
}

fn map_document_metadata_policy_repo_error(
  error: myoxus_domain::repositories::RepositoryError,
) -> async_graphql::Error {
  async_graphql::Error::new(error.to_string())
}

async fn record_admin_document_metadata_policy_audit(
  ctx: &Context<'_>,
  state: &ApiState,
  event_key: &'static str,
  key: &str,
  value: serde_json::Value,
) {
  let actor = resolve_audit_actor(ctx).await;
  state
    .audit_recorder()
    .record(myoxus_domain::audit::AuditEvent::mutation(
      event_key,
      myoxus_domain::audit::AuditCategory::Config,
      Some(myoxus_domain::audit::AuditTarget {
        target_type: "document_metadata_policy".to_string(),
        target_id: key.to_string(),
        target_label: Some(key.to_string()),
      }),
      actor,
      None,
      Some(serde_json::json!({ "key": key, "value": value })),
    ))
    .await;
}

async fn load_document_versioning_defaults(state: &ApiState) -> Result<AdminDocumentVersioningDefaultsType> {
  let effective = state.effective_config().await;
  Ok(AdminDocumentVersioningDefaultsType {
    default_enabled: effective.bool("document_versioning.default_enabled").unwrap_or(true),
    default_auto_version_on_pdf_export: effective
      .bool("document_versioning.default_auto_version_on_pdf_export")
      .unwrap_or(true),
    default_retention_count: effective
      .value("document_versioning.default_retention_count")
      .and_then(|value| value.as_i64())
      .and_then(|value| i32::try_from(value).ok())
      .filter(|value| (1..=50).contains(value))
      .unwrap_or(10),
    default_edit_capture_enabled: effective.bool("doc.history.enabled").unwrap_or(true),
    default_edit_capture_interval_ms: effective
      .value("doc.history.interval")
      .and_then(|value| value.as_i64())
      .unwrap_or(myoxus_application::document_version::DEFAULT_EDIT_CAPTURE_INTERVAL_MS),
  })
}

fn map_document_versioning_workspace_row(
  row: myoxus_domain::entities::WorkspaceDocumentVersioningSettings,
  defaults: &AdminDocumentVersioningDefaultsType,
  runtime_available: bool,
) -> Result<AdminDocumentVersioningWorkspaceSettingsType> {
  let auto_version_on_pdf_export = row
    .auto_version_on
    .as_ref()
    .map(|triggers| triggers.contains(&myoxus_domain::entities::AutoVersionTrigger::OnPdfExport));

  let effective = myoxus_application::document_version::resolve_effective_workspace_history_settings(
    row.clone(),
    myoxus_application::document_version::GlobalEditCaptureSettings {
      named_versioning_enabled: defaults.default_enabled,
      auto_version_on: if defaults.default_auto_version_on_pdf_export {
        vec![myoxus_domain::entities::AutoVersionTrigger::OnPdfExport]
      } else {
        Vec::new()
      },
      retention_count: defaults.default_retention_count,
      enabled: defaults.default_edit_capture_enabled,
      interval_ms: defaults.default_edit_capture_interval_ms,
    },
    myoxus_domain::entities::DocumentEditCaptureRuntimeStatus {
      available: runtime_available,
      last_success_at: None,
    },
  )
  .map_err(|error| async_graphql::Error::new(error.to_string()))?;

  Ok(AdminDocumentVersioningWorkspaceSettingsType {
    workspace_id: ID::from(row.workspace_id.to_string()),
    workspace_name: row.workspace_name,
    enabled: row.enabled,
    auto_version_on_pdf_export,
    retention_count: row.retention_count,
    effective_enabled: row.enabled.unwrap_or(defaults.default_enabled),
    effective_auto_version_on_pdf_export: auto_version_on_pdf_export
      .unwrap_or(defaults.default_auto_version_on_pdf_export),
    effective_retention_count: row.retention_count.unwrap_or(defaults.default_retention_count),
    edit_capture_enabled: row.edit_capture_enabled,
    edit_capture_interval_ms: row.edit_capture_interval_ms,
    effective_edit_capture_enabled: effective.effective_edit_capture_enabled,
    effective_edit_capture_interval_ms: effective.effective_edit_capture_interval_ms,
    legacy_interval_normalized: effective.legacy_interval_normalized,
    edit_capture_runtime_available: effective.runtime_available,
    updated_at: row.updated_at,
  })
}

/// Extract an [`AuditActor`] from the current admin session.
///
/// Returns the admin's `user_id` and email (as `label`) for audit event recording.
/// Falls back to `AuditActor::system()` if session is unavailable.
pub(crate) async fn resolve_audit_actor(ctx: &Context<'_>) -> myoxus_domain::audit::AuditActor {
  match require_session(ctx).await {
    Ok((_, snapshot)) => myoxus_domain::audit::AuditActor::user(snapshot.user.id, snapshot.user.email.clone()),
    Err(_) => myoxus_domain::audit::AuditActor::system(),
  }
}

fn map_template_transition_error(error: myoxus_application::auth::AuthError) -> async_graphql::Error {
  use myoxus_application::auth::AuthError;
  match error {
    AuthError::NotFound(_) => async_graphql::Error::new("template not found"),
    AuthError::InvalidInput(message) if message.starts_with("template is already ") => {
      async_graphql::Error::new(message)
    }
    error => crate::graphql::utils::map_gql_error(error),
  }
}

fn template_registry_request_id(ctx: &Context<'_>) -> Option<String> {
  ctx
    .data_opt::<HeaderMap>()
    .and_then(|headers| headers.get(REQUEST_ID_HEADER))
    .and_then(|value| value.to_str().ok())
    .filter(|value| !value.is_empty())
    .map(|value| value.to_string())
}

/// Parse a GraphQL [`ID`] as a [`Uuid`], returning an error for malformed values.
fn parse_uuid(id: &ID) -> Result<Uuid> {
  Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid UUID"))
}

fn workspace_role_string_to_domain(role: Option<&str>) -> Result<DomainWorkspaceRole> {
  match role.unwrap_or("Collaborator").trim() {
    "Admin" => Ok(DomainWorkspaceRole::Admin),
    "Manager" => Ok(DomainWorkspaceRole::Manager),
    "Collaborator" => Ok(DomainWorkspaceRole::Collaborator),
    "Commenter" => Ok(DomainWorkspaceRole::Commenter),
    "Reader" => Ok(DomainWorkspaceRole::Reader),
    "Owner" => Err(async_graphql::Error::new(
      "workspace owner changes must use reassignWorkspaceOwner",
    )),
    "External" => Err(async_graphql::Error::new(
      "External is not an assignable workspace member role",
    )),
    other => Err(async_graphql::Error::new(format!(
      "unsupported workspace role: {other}"
    ))),
  }
}

fn graphql_workspace_role_to_domain(role: crate::graphql::auth::WorkspaceRole) -> Result<DomainWorkspaceRole> {
  match role {
    crate::graphql::auth::WorkspaceRole::Admin => Ok(DomainWorkspaceRole::Admin),
    crate::graphql::auth::WorkspaceRole::Manager => Ok(DomainWorkspaceRole::Manager),
    crate::graphql::auth::WorkspaceRole::Collaborator => Ok(DomainWorkspaceRole::Collaborator),
    crate::graphql::auth::WorkspaceRole::Commenter => Ok(DomainWorkspaceRole::Commenter),
    crate::graphql::auth::WorkspaceRole::Reader => Ok(DomainWorkspaceRole::Reader),
    crate::graphql::auth::WorkspaceRole::Owner => Err(async_graphql::Error::new(
      "workspace owner changes must use reassignWorkspaceOwner",
    )),
    crate::graphql::auth::WorkspaceRole::External => Err(async_graphql::Error::new(
      "External is not an assignable workspace member role",
    )),
  }
}
