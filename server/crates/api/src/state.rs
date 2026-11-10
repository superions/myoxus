//! Shared Axum application state wired at startup.
//!
//! [`ApiState`] is the single `Arc`-wrapped state object injected into every
//! Axum handler and middleware via `State<ApiState>`. It aggregates all
//! application services (auth, workspace, doc, blob, search, copilot,
//! calendar, notification), infrastructure adapters (Redis, storage, mail),
//! runtime metrics, and startup-check snapshots.
//!
//! Internally, fields are split into [`ServiceRegistry`] (all service
//! dependencies) and [`RuntimeState`] (config, metrics, health). All public
//! getters remain on [`ApiState`] so callers are unaffected.

use std::{
  sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
  },
  time::{Duration, Instant},
};

use async_trait::async_trait;
use chrono::Utc;
use myoxus_application::admin::{AdminService, AdminUserService, InMemoryAdminStore};
use myoxus_application::api_key::{ApiKeyService, InMemoryApiKeyStore};
use myoxus_application::audit::{DocumentAuditProjectionStore, UnavailableDocumentAuditProjectionStore};
use myoxus_application::auth::{AuthService, InMemoryAuthStore};
use myoxus_application::branding::{BrandingAssetRepository, UnavailableBrandingAssetRepository};
use myoxus_application::calendar::{CalendarService, NativeEventService};
use myoxus_application::captcha::{Algorithm as CaptchaAlgorithm, CaptchaService, CaptchaSettings};
use myoxus_application::comment::{AuthStoreCommentAdapter, CommentService, InMemoryCommentStore};
use myoxus_application::copilot::provider::LlmProviderRegistry;
use myoxus_application::copilot::{CopilotService, InMemoryCopilotRepository};
use myoxus_application::database::DatabaseServices;
use myoxus_application::doc::DocService;
use myoxus_application::document_graph::DocumentGraphService;
use myoxus_application::git_sync::GitTokenRotationService;
use myoxus_application::metrics::MetricsService;
use myoxus_application::notification::{InMemoryNotificationStore, NotificationService};
use myoxus_application::organization::ManagerCapabilityWriter;
use myoxus_application::pdf_export::jobs::{PdfExportJobStore, UnavailablePdfExportJobStore};
use myoxus_application::permission::PermissionService;
use myoxus_application::ports::blob::NullBlobStore;
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::ports::{BlobStoragePort, DistributedLockPort, NullBlobStorage, RedisPort};
use myoxus_application::public::PublicRepository;
use myoxus_application::search::SearchIndexerService;
use myoxus_application::setup::{InMemorySetupStateStore, SetupStateService};
use myoxus_application::telemetry::TelemetryService;
use myoxus_application::template_registry::TemplateRegistryService;
use myoxus_application::workspace::{WorkspaceService, WorkspaceSettingsInvalidation, WorkspaceSettingsService};
use myoxus_application::workspace_automation::WorkspaceAutomationService;
use myoxus_application::workspace_content_operation::coordination::WorkspaceContentClusterCoordinator;
use myoxus_application::workspace_export::ObsidianVaultExportService;
use myoxus_application::workspace_import::WorkspaceImportService;
use myoxus_application::workspace_tags::WorkspaceTagService;
use myoxus_domain::repositories::{CopilotEmbeddingRepository, SearchRepository};
use myoxus_infrastructure::captcha::{RedisCaptchaRateLimiter, RedisSolvedChallengeRegistry};
use myoxus_infrastructure::copilot::SqlxCopilotRepository;
use myoxus_infrastructure::copilot::embedding_store::SqlxCopilotEmbeddingRepository;
use myoxus_infrastructure::doc_cache::DocCacheTuningHandles;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::redis::InMemoryRedisAdapter;
use serde::Serialize;
use tokio::sync::RwLock;
use tracing::{instrument, warn};

use crate::cache::QueryCache;
use crate::cache_bus::CacheInvalidationBus;
use crate::client_update_runtime::ClientUpdateRuntime;
use crate::config::{AppConfig, CaptchaConfig};
use crate::config_reload::{ConfigOverrides, EffectiveConfig};
use crate::git_sync_engine::{GitRepositoryBuilder, PolicyBoundGitRepositoryBuilder};
use crate::logging::LoggingService;
use crate::preview::PreviewRuntime;
use crate::startup_checks::StartupCheckCategory;
use crate::websocket::redis_adapter::RedisWsAdapter;

/// Opaque error type returned by cache loader closures via `try_get_with()`.
///
/// Wraps a string message.  `try_get_with()` requires the error type to
/// implement `Send + Sync + 'static`; using a simple newtype avoids pulling
/// in a heavier error crate.
#[derive(Debug, Clone)]
pub struct CacheLoadError(pub String);

impl std::fmt::Display for CacheLoadError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.0)
  }
}

impl std::error::Error for CacheLoadError {}

pub(crate) fn feature_override_result(features: &[String]) -> Option<bool> {
  if features.iter().any(|feature| feature == "unlimited_copilot") {
    Some(true)
  } else if features.iter().any(|feature| feature == "__disabled") {
    Some(false)
  } else {
    None
  }
}

// The existing Vec payload retains the explicit copilot-disable sentinel.
// This marker distinguishes cache entries populated before Manager projection;
// they must be reloaded rather than hiding a pre-existing capability until TTL.
const MANAGER_PROJECTION_MARKER: &str = "__manager_projection";

async fn load_user_feature_override(auth: &AuthService, user_id: uuid::Uuid) -> Result<Vec<String>, CacheLoadError> {
  let override_value = auth
    .user_feature_override(user_id, "unlimited_copilot")
    .await
    .map_err(|error| CacheLoadError(error.to_string()))?;
  let mut features = match override_value {
    Some(true) => vec!["unlimited_copilot".to_string()],
    Some(false) => vec!["__disabled".to_string()],
    None => Vec::new(),
  };
  if auth
    .user_feature_override(user_id, "manager")
    .await
    .map_err(|error| CacheLoadError(error.to_string()))?
    == Some(true)
  {
    features.push("manager".to_string());
  }
  features.push(MANAGER_PROJECTION_MARKER.to_string());
  Ok(features)
}

async fn load_workspace_settings(
  workspace: &WorkspaceService,
  workspace_id: uuid::Uuid,
) -> Result<crate::cache::WorkspaceSettingsCached, CacheLoadError> {
  let row = workspace
    .get_workspace(workspace_id)
    .await
    .map_err(|error| CacheLoadError(error.to_string()))?
    .ok_or_else(|| CacheLoadError("workspace not found".to_string()))?;
  Ok(crate::cache::WorkspaceSettingsCached {
    enable_ai: row.enable_ai,
    enable_sharing: row.enable_sharing,
    enable_url_preview: row.enable_url_preview,
    enable_doc_embedding: row.enable_doc_embedding,
  })
}

/// Serialisable point-in-time result of a single startup check, exposed by
/// the `/health` and `/ready` endpoints.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupCheckSnapshot {
  /// Human-readable check name.
  pub name: String,
  /// `"pass"` for completed checks recorded by the startup composition root.
  pub status: String,
  /// Broad category (e.g. `Database`, `Cache`).
  pub category: StartupCheckCategory,
  /// Machine-readable status code.
  pub code: String,
  /// Diagnostic message.
  pub detail: String,
  /// Timestamp when the check was last evaluated.
  pub checked_at: chrono::DateTime<Utc>,
}

/// Typed failure returned when the production composition root is incomplete.
///
/// The field names are stable technical identifiers only. Configuration,
/// connection strings, credentials, and request payloads are deliberately not
/// retained in this error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductionCompositionError {
  missing_capabilities: Vec<&'static str>,
}

impl ProductionCompositionError {
  /// Return every missing production capability in stable sorted order.
  pub fn missing_capabilities(&self) -> &[&'static str] {
    &self.missing_capabilities
  }
}

impl std::fmt::Display for ProductionCompositionError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(
      formatter,
      "production API composition is incomplete: {}",
      self.missing_capabilities.join(", ")
    )
  }
}

impl std::error::Error for ProductionCompositionError {}

/// All `Arc`-wrapped service dependencies injected at startup.
///
/// This struct groups the application-level services (auth, workspace, doc,
/// blob, copilot, etc.) and infrastructure adapters (Redis, storage,
/// distributed lock, search) that [`ApiState`] delegates to.
#[derive(Clone)]
pub struct ServiceRegistry {
  pub(crate) feature_sources: Option<Arc<myoxus_infrastructure::feature_bundles::CapturedFeatureSourceSet>>,
  pub(crate) auth_service: AuthService,
  /// Shared immutable startup catalog for normal sending and SMTP tests.
  pub(crate) html_catalog: Option<Arc<dyn myoxus_public_render::HtmlRendererProvider>>,
  pub(crate) mail_template_renderer: Option<Arc<myoxus_infrastructure::mail::MailTemplateRenderer>>,
  pub(crate) workspace_service: WorkspaceService,
  pub(crate) admin_service: AdminService,
  pub(crate) doc_service: DocService,
  pub(crate) comment_service: Arc<CommentService>,
  pub(crate) notification_service: Arc<NotificationService>,
  pub(crate) copilot_service: Arc<CopilotService>,
  pub(crate) transcription_results: Arc<myoxus_application::transcription::results::TranscriptionResultsService>,
  /// P101-RAG-01: embedding repository for RAG context retrieval.
  pub(crate) copilot_embedding_repo: Option<Arc<dyn CopilotEmbeddingRepository>>,
  /// One startup-bound embedding transport, independent of chat circuit state.
  pub(crate) copilot_embedding_provider:
    Arc<std::sync::OnceLock<Option<Arc<dyn myoxus_application::copilot::provider::LlmProvider>>>>,
  pub(crate) public_repository: Arc<dyn PublicRepository>,
  pub(crate) manager_capability_writer: Arc<dyn ManagerCapabilityWriter>,
  pub(crate) blob_service: Arc<BlobService>,
  pub(crate) permission_service: Arc<PermissionService>,
  pub(crate) storage: Arc<dyn BlobStoragePort>,
  pub(crate) redis_port: Arc<dyn RedisPort>,
  pub(crate) distributed_lock: Arc<dyn DistributedLockPort>,
  pub(crate) search_repository: Option<Arc<dyn SearchRepository>>,
  pub(crate) search_indexer: Option<Arc<SearchIndexerService>>,
  pub(crate) calendar_service: Option<Arc<CalendarService>>,
  pub(crate) native_event_service: Option<Arc<NativeEventService>>,
  pub(crate) telemetry_service: Arc<TelemetryService>,
  pub(crate) metrics_service: Arc<MetricsService>,
  pub(crate) setup_state_service: SetupStateService,
  pub(crate) branding_asset_repository: Arc<dyn BrandingAssetRepository>,
  /// Authoritative PDF export job projection and transition owner. Narrow
  /// tests receive an explicit fail-fast adapter; PostgreSQL composition
  /// replaces it as soon as the application pool is installed.
  pub(crate) pdf_export_job_store: Arc<dyn PdfExportJobStore>,
  pub(crate) document_audit_projection_store: Arc<dyn DocumentAuditProjectionStore>,
  pub(crate) api_key_service: ApiKeyService,
  /// LLM provider registry for copilot AI completions.
  pub(crate) llm_provider_registry: LlmProviderRegistry,
  /// Shared HTTP client for outbound requests (link-preview, image-proxy, OAuth, etc.).
  /// `reqwest::Client` is internally `Arc`-wrapped and cheap to clone.
  pub(crate) http_client: reqwest::Client,
  /// Required builder for policy-bound Git-Sync profile lifecycle transports.
  pub(crate) git_sync_repository_builder: Arc<dyn GitRepositoryBuilder>,
  /// Shared provider-neutral token-rotation owner used by AdminRoot and the
  /// existing Git-Sync queue worker. Optional only in narrow test states.
  pub(crate) git_token_rotation_service: Option<Arc<GitTokenRotationService>>,
  /// Template registry service (optional — only present when template_registry is enabled).
  pub(crate) template_registry_service: Option<TemplateRegistryService>,
  /// Server-authoritative Database capability owners. Optional only for narrow
  /// tests that do not execute the GraphQL surface.
  pub(crate) database_services: Option<Arc<DatabaseServices>>,
  /// Same native owner as scheduling, independent of optional Automations.
  pub(crate) task_recurrence_service: Option<Arc<myoxus_application::recurrence::TaskRecurrenceService>>,
  pub(crate) assistant_packages:
    Option<Arc<myoxus_application::workspace::assistant_packages::AssistantPackageService>>,
  /// Workspace-visible Database activity reader. It is retained separately
  /// from the mutation services so GraphQL queries do not depend on mutable
  /// service wiring.
  pub(crate) database_activity_recorder: Option<myoxus_application::database::activity::DatabaseActivityRecorder>,
  /// Durable full-workspace import orchestration. Optional only in narrow
  /// tests that do not mount the account import API.
  pub(crate) workspace_import_service: Option<Arc<WorkspaceImportService>>,
  /// Server-owned Obsidian vault projection used by every download caller.
  pub(crate) workspace_export_service: Option<Arc<ObsidianVaultExportService>>,
  /// Server-authoritative workspace tag catalog shared by document metadata
  /// and Database tag cells.
  pub(crate) workspace_tag_service: Option<Arc<WorkspaceTagService>>,
  /// Server-authoritative Workspace Automation service. Optional only for
  /// narrow tests that do not execute automation GraphQL or worker handlers.
  pub(crate) workspace_automation_service: Option<Arc<WorkspaceAutomationService>>,
  /// Server-authoritative Document Graph service. Optional only for narrow
  /// tests that do not execute graph/link resolvers or worker handlers.
  pub(crate) document_graph_service: Option<Arc<DocumentGraphService>>,
  /// PDF-Export V2 ICC profile repository (P-PDF-TPL-COLOR-01). Optional —
  /// `None` in unit tests / in-memory paths that do not need PDF color
  /// management.
  pub(crate) pdf_icc_repo: Option<Arc<dyn myoxus_domain::repositories::PdfIccProfileRepository>>,
  /// PDF-Export V2 font library repository (P-PDF-TPL-FONT-01). Optional for
  /// the same reason as `pdf_icc_repo`.
  pub(crate) pdf_font_repo: Option<Arc<dyn myoxus_domain::repositories::PdfFontRepository>>,
  /// PDF-Export V2 blob store (templates/brand/fonts/icc). Optional for the
  /// same reason as `pdf_icc_repo`.
  pub(crate) pdf_blob_store: Option<Arc<myoxus_infrastructure::pdf_export::PdfBlobStore>>,
  /// PDF-Export V2 template registry (P-PDF-TPL-08). Backs both admin
  /// templated CRUD and the workspace-scoped read-only listing
  /// (`P-PDF-TPL-10`). Optional for the same reason as `pdf_icc_repo`.
  pub(crate) pdf_template_repo: Option<Arc<dyn myoxus_domain::repositories::PdfTemplateRepository>>,
  /// PDF-Export V2 workspace ↔ template assignments (P-PDF-TPL-09). The
  /// workspace-scoped GraphQL surface filters templates through this repo
  /// so non-assigned templates never leak across workspaces.
  pub(crate) pdf_assignment_repo:
    Option<Arc<dyn myoxus_domain::repositories::PdfWorkspaceTemplateAssignmentRepository>>,
  /// PDF-Export V2 workspace brand assets (P-PDF-TPL-09). Reads back the
  /// per-workspace defaults (locale, paper size, color profile, …) consumed
  /// by the workspace-scoped read-only API.
  pub(crate) pdf_brand_repo: Option<Arc<dyn myoxus_domain::repositories::PdfWorkspaceBrandAssetRepository>>,
  /// PDF-Export V2 render-audit log (P-PDF-TPL-AUDIT-01). Synchronous
  /// write target on every export call — a failure aborts the render so
  /// a missing audit entry never goes unnoticed.
  pub(crate) pdf_render_audit_repo: Option<Arc<dyn myoxus_domain::repositories::PdfExportRenderAuditRepository>>,
  /// Document-Versioning label repository (P-DOC-VER-02). Optional in tests
  /// that do not expose the versioning GraphQL surface.
  pub(crate) document_version_repo: Option<Arc<dyn myoxus_domain::repositories::DocumentVersionRepository>>,
  /// Document-Versioning settings repository (P-DOC-VER-02). Optional in
  /// tests that do not expose the versioning GraphQL surface.
  pub(crate) document_version_settings_repo:
    Option<Arc<dyn myoxus_domain::repositories::DocumentVersioningSettingsRepository>>,
  /// Canonical document metadata repository. Required for the document
  /// document metadata GraphQL contract; optional only for narrow legacy tests.
  pub(crate) document_metadata_policy_repo:
    Option<Arc<dyn myoxus_domain::repositories::DocumentMetadataPolicyRepository>>,
  /// Application owner for the versioned, actor-independent list index.
  pub(crate) document_metadata_policy_service:
    Option<myoxus_application::document_metadata_policy::DocumentMetadataPolicyService>,
  /// Canonical document metadata service backed by the `docs` metadata head.
  /// Required for the native metadata GraphQL contract; optional only for
  /// narrow schema tests that do not execute the resolver.
  pub(crate) document_metadata_service: Option<myoxus_application::document_metadata::DocumentMetadataService>,
  /// Admin audit recorder — fire-and-forget facade for the admin audit log.
  pub(crate) audit_recorder: myoxus_application::audit::AuditRecorder,
  /// P-Captcha-B: ALTCHA-backed CAPTCHA service. Always present — when the
  /// feature is disabled in config, the service's handlers return
  /// [`CaptchaError::Disabled`] which the HTTP layer maps to 503.
  pub(crate) captcha_service: Arc<CaptchaService>,
  /// Organization repositories (delivery packages B/C/D infrastructure). Optional for narrow
  /// legacy tests; production wiring (`server.rs`) sets all seven.
  pub(crate) organization_repo: Option<Arc<dyn myoxus_domain::repositories::OrganizationRepository>>,
  pub(crate) organization_template_context_service:
    Option<Arc<myoxus_application::organization::OrganizationTemplateContextService>>,
  pub(crate) organization_unit_type_repo: Option<Arc<dyn myoxus_domain::repositories::OrganizationUnitTypeRepository>>,
  pub(crate) organization_unit_repo: Option<Arc<dyn myoxus_domain::repositories::OrganizationUnitRepository>>,
  pub(crate) organization_unit_member_repo:
    Option<Arc<dyn myoxus_domain::repositories::OrganizationUnitMemberRepository>>,
  pub(crate) organization_unit_workspace_repo:
    Option<Arc<dyn myoxus_domain::repositories::OrganizationUnitWorkspaceRepository>>,
  pub(crate) organization_policy_repo: Option<Arc<dyn myoxus_domain::repositories::OrganizationPolicyRepository>>,
  pub(crate) organization_project_request_repo:
    Option<Arc<dyn myoxus_domain::repositories::OrganizationProjectRequestRepository>>,
  /// Aggregate service over all OU repositories and user-feature lookup.
  /// Every permission-relevant resolver consults this service.
  pub(crate) organization_permission_service:
    Option<Arc<myoxus_application::organization::OrganizationPermissionService>>,
  /// Policy-gated service for Manager-created project requests.
  pub(crate) organization_project_request_service: Option<Arc<myoxus_application::organization::ProjectRequestService>>,
  /// JSON/CSV import/export pipeline. Optional in tests that don't need it;
  /// production wiring (`server.rs`) always sets it.
  pub(crate) organization_import_export_service:
    Option<Arc<myoxus_application::organization::OrganizationImportExportService>>,
  /// Authoritative OU create/update/move/status/delete boundary shared by
  /// GraphQL, Admin and MCP adapters.
  pub(crate) organization_unit_lifecycle_service:
    Option<Arc<myoxus_application::organization::OrganizationUnitLifecycleService>>,
  /// Optional only in narrow fixtures. Production registers the bounded
  /// read adapter; constructing it never contacts a provider or needs its token.
  pub(crate) oidc_group_directory:
    Option<Arc<dyn myoxus_application::organization::oidc_directory::OidcGroupDirectoryPort>>,
  /// Shared Queue/outbox coordination for cross-workspace content operations.
  /// `None` exists only in narrow tests or incomplete startup state; regular
  /// server-backed operation requires the configured Redis roles.
  pub(crate) workspace_content_cluster_coordinator: Option<Arc<WorkspaceContentClusterCoordinator>>,
  /// Server-authoritative XWS admission/control boundary. It remains absent in
  /// narrow tests and until every production dependency is wired.
  pub(crate) workspace_content_control_service:
    Option<Arc<myoxus_application::workspace_content_operation::control::WorkspaceContentControlService>>,
  pub(crate) workspace_content_redirect_service:
    Option<Arc<myoxus_application::workspace_content_operation::redirect::WorkspaceContentRedirectService>>,
}

/// Build a [`CaptchaService`] from the API-layer config and a Redis port.
///
/// Extracted so that [`ApiState::new`], [`ApiState::with_services_and_comment`]
/// and [`ApiState::with_redis_port`] all produce identical wiring.
fn build_captcha_service(config: &CaptchaConfig, redis: Arc<dyn RedisPort>) -> Arc<CaptchaService> {
  // The algorithm string was validated at config-load time
  // (validate_captcha_config), so an unparseable value here is a bug —
  // fall back to SHA-256 with a warning rather than panic.
  let algorithm = config.algorithm.parse::<CaptchaAlgorithm>().unwrap_or_else(|_| {
    warn!(
      value = %config.algorithm,
      "captcha.algorithm did not parse as AltchaAlgorithm; falling back to SHA-256"
    );
    CaptchaAlgorithm::Sha256
  });
  let settings = CaptchaSettings {
    enabled: config.enabled,
    algorithm,
    hmac_key: config.hmac_key.clone(),
    challenge_expires_seconds: config.challenge_expires_seconds,
    max_number: config.max_number,
    rate_limit_per_ip_per_min: config.rate_limit_per_ip_per_min,
    rate_limit_per_account_per_hour: config.rate_limit_per_account_per_hour,
    honeypot_field_name: config.honeypot_field_name.clone(),
  };
  Arc::new(CaptchaService::new(
    settings,
    Arc::new(RedisSolvedChallengeRegistry::new(redis.clone())),
    Arc::new(RedisCaptchaRateLimiter::new(redis)),
  ))
}

/// Runtime configuration, metrics counters, health state, and database pool.
///
/// These fields are not service dependencies but runtime concerns: startup
/// config, uptime tracking, request metrics, readiness flag, and the
/// optional metrics/admin PostgreSQL pool.
#[derive(Clone)]
pub struct RuntimeState {
  pub(crate) start_time: Instant,
  pub(crate) is_ready: Arc<AtomicBool>,
  pub(crate) requests_total: Arc<AtomicU64>,
  pub(crate) requests_error_total: Arc<AtomicU64>,
  pub(crate) request_latency_total_micros: Arc<AtomicU64>,
  pub(crate) request_latency_max_micros: Arc<AtomicU64>,
  pub(crate) metrics_pool: Option<sqlx::PgPool>,
  pub(crate) client_update_runtime: Option<Arc<ClientUpdateRuntime>>,
  pub(crate) redis_queue: Option<myoxus_worker::RedisQueue>,
  pub(crate) startup_checks: Arc<RwLock<Vec<StartupCheckSnapshot>>>,
  /// P104-C: TTL atomics and hit/miss counters for the three tunable Redis doc-caches.
  /// `None` when no cache Redis adapter is configured.
  pub(crate) doc_cache_tuning: Option<DocCacheTuningHandles>,
  /// P-Captcha-C: successful captcha verifications since startup.
  /// Exposed as `myoxus_captcha_verified_total` on the Prometheus endpoint.
  pub(crate) captcha_verified_total: Arc<AtomicU64>,
  /// P-Captcha-C: rejected captcha verifications since startup — not labeled
  /// by reason in the atomic itself (labels live in the Prometheus export).
  /// Counts every reason: `captcha_invalid_*`, `captcha_replay`,
  /// `captcha_rate_limited_*`, `captcha_expired`.
  pub(crate) captcha_rejected_total: Arc<AtomicU64>,
  /// P-Captcha-C: honeypot trap triggered — a bot filled the hidden field.
  pub(crate) captcha_honeypot_total: Arc<AtomicU64>,
}

/// Shared state injected into every Axum handler via `State<ApiState>`.
///
/// All fields are cloned cheaply (inner references are `Arc`-wrapped) so
/// the state can be passed through Axum's extractor machinery without copying
/// heavyweight objects.
///
/// Internally split into [`ServiceRegistry`] (service dependencies) and
/// [`RuntimeState`] (config, metrics, health). All public getters delegate
/// to the appropriate sub-struct so callers are unaffected.
#[derive(Clone)]
pub struct ApiState {
  /// Full application configuration loaded at startup.
  ///
  /// Kept as a top-level field for backward compatibility (`state.config.…`).
  pub config: AppConfig,
  /// All application services and infrastructure adapters.
  pub services: ServiceRegistry,
  /// Runtime metrics, health state, and database pool.
  pub runtime: RuntimeState,
  /// Socket.IO server instance for broadcasting to rooms.
  ///
  /// Wrapped in `Arc<RwLock<>>` so it can be set AFTER `websocket::init()`
  /// and shared between the HTTP router and WebSocket handlers.
  /// NestJS uses `this.server.to(room).emit()` for broadcasts — we need
  /// the `SocketIo` instance for the same pattern (P28 sync fix).
  pub socket_io: Arc<std::sync::RwLock<Option<socketioxide::SocketIo>>>,
  /// In-process moka query caches (P84-H) — replaces the temporary
  /// `RwLock`/`DashMap` caches from P84-D.
  pub query_cache: QueryCache,
  /// Bounded private Page-preview caches and admission controls. Construction-
  /// bound capacities are captured from the startup configuration.
  pub preview_runtime: Arc<PreviewRuntime>,
  /// Runtime-configurable logging service (P33-B).
  ///
  /// `None` only in minimal test configurations where no reload handle
  /// is available.
  pub logging: Option<Arc<LoggingService>>,
  /// SC-M-01: Optional Redis-backed cross-instance WebSocket state adapter.
  ///
  /// Role-specific Socket adapter for cross-instance WebSocket coordination.
  ///
  /// `None` means only that the optional Socket role was not configured in
  /// this constructed state; Redis itself remains a hard server dependency.
  /// XWS must retain durable fanout work instead of using local notification
  /// delivery as a fallback.
  pub redis_ws_adapter: Option<Arc<RedisWsAdapter>>,
  /// P84-I: Unique identifier for this server instance, used to distinguish
  /// cache invalidation messages from this instance vs. other instances.
  pub instance_id: uuid::Uuid,
  /// Committed content/structure wakeups shared with the MCP resource observer.
  pub resource_updates: myoxus_application::events::WorkspaceResourceUpdates,
  /// P84-I: Optional Redis Pub/Sub cache invalidation bus for cross-instance
  /// cache sync. When `None` (no cache Redis adapter), invalidation is local-only.
  pub cache_bus: Option<Arc<CacheInvalidationBus>>,
  /// P84-I-II: Optional Redis cache adapter for three-tier caching
  /// (moka L1 → Redis L2 → PostgreSQL L3).  When `None`, the L2 layer is
  /// skipped and lookups fall through directly from moka to PostgreSQL.
  pub cache_redis: Option<Arc<dyn RedisPort>>,
  /// Current validated live-configuration snapshot.
  ///
  /// Local commits, Redis wake-ups, and the bounded recovery poll all update
  /// this same lock. Restart-bound values never enter the snapshot.
  pub config_overrides: Arc<tokio::sync::RwLock<ConfigOverrides>>,
  /// Typed file/ENV baseline used when a live database row is removed.
  pub config_file_baseline: Arc<AppConfig>,
  pub transcription_runtime: Arc<crate::transcription_runtime::TranscriptionRuntime>,
}

#[async_trait]
impl WorkspaceSettingsInvalidation for ApiState {
  async fn invalidate_workspace_settings(&self, workspace_id: uuid::Uuid) {
    self.invalidate_ws_settings_cache(workspace_id).await;
  }
}

/// Fail-fast adapter used only by in-memory API states.
///
/// Production startup replaces this adapter with `PgPublicRepository` before
/// serving requests. Keeping the dependency non-optional prevents publication
/// invalidation from being silently skipped when the composition root is
/// incomplete.
struct PanicPublicRepository;

#[async_trait]
impl PublicRepository for PanicPublicRepository {
  async fn list_public_workspaces(
    &self,
  ) -> myoxus_application::public::PublicResult<Vec<myoxus_application::public::PublicWorkspaceProjection>> {
    panic!("PanicPublicRepository: list_public_workspaces called without a configured publication repository")
  }

  async fn decide_workspace(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::public::PublicResult<myoxus_application::public::PublicAclDecision> {
    panic!("PanicPublicRepository: decide_workspace called without a configured publication repository")
  }

  async fn decide_document(
    &self,
    _workspace_id: uuid::Uuid,
    _doc_id: uuid::Uuid,
    _source_hash: String,
  ) -> myoxus_application::public::PublicResult<myoxus_application::public::PublicAclDecision> {
    panic!("PanicPublicRepository: decide_document called without a configured publication repository")
  }

  async fn list_public_workspace_docs(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::public::PublicResult<Vec<myoxus_application::public::PublicWorkspaceDoc>> {
    panic!("PanicPublicRepository: list_public_workspace_docs called without a configured publication repository")
  }

  async fn upsert_artifact(
    &self,
    _artifact: &myoxus_application::public::PublicArtifact,
  ) -> myoxus_application::public::PublicResult<()> {
    panic!("PanicPublicRepository: upsert_artifact called without a configured publication repository")
  }

  async fn invalidate_document(
    &self,
    _workspace_id: uuid::Uuid,
    _doc_id: uuid::Uuid,
  ) -> myoxus_application::public::PublicResult<()> {
    panic!("PanicPublicRepository: invalidate_document called without a configured publication repository")
  }

  async fn invalidate_workspace(&self, _workspace_id: uuid::Uuid) -> myoxus_application::public::PublicResult<()> {
    panic!("PanicPublicRepository: invalidate_workspace called without a configured publication repository")
  }

  async fn replace_asset_manifest(
    &self,
    _workspace_id: uuid::Uuid,
    _doc_id: uuid::Uuid,
    _assets: &[myoxus_application::public::PublicAssetManifestEntry],
  ) -> myoxus_application::public::PublicResult<()> {
    panic!("PanicPublicRepository: replace_asset_manifest called without a configured publication repository")
  }

  async fn get_asset(
    &self,
    _workspace_id: uuid::Uuid,
    _doc_id: uuid::Uuid,
    _asset_hash: &str,
    _filename: &str,
  ) -> myoxus_application::public::PublicResult<Option<myoxus_application::public::PublicAssetManifestEntry>> {
    panic!("PanicPublicRepository: get_asset called without a configured publication repository")
  }
}

/// Fail-fast manager capability writer for in-memory API states.
struct PanicManagerCapabilityWriter;

#[async_trait]
impl ManagerCapabilityWriter for PanicManagerCapabilityWriter {
  async fn ensure_manager_capability(&self, _user_id: myoxus_domain::ids::UserId) -> Result<bool, String> {
    panic!("PanicManagerCapabilityWriter: ensure called without a configured manager capability writer")
  }

  async fn revoke_manager_capability_if_no_more(&self, _user_id: myoxus_domain::ids::UserId) -> Result<bool, String> {
    panic!("PanicManagerCapabilityWriter: revoke called without a configured manager capability writer")
  }
}

#[async_trait::async_trait]
impl myoxus_application::document_template::DocumentTemplateAccount for ApiState {
  async fn effective_preferences(
    &self,
    actor_id: uuid::Uuid,
  ) -> Result<myoxus_application::auth::EffectiveUserPreferences, myoxus_application::auth::AuthError> {
    let record = self.auth().get_user_preferences(actor_id).await?;
    Ok(record.values.resolve(&self.user_preference_defaults().await))
  }

  async fn applying_actor(
    &self,
    actor_id: uuid::Uuid,
  ) -> Result<Option<myoxus_application::document_template::DocumentTemplateActor>, myoxus_application::auth::AuthError>
  {
    Ok(
      self
        .auth()
        .get_user_by_id(actor_id)
        .await?
        .filter(|user| !user.disabled && user.registered)
        .map(|user| myoxus_application::document_template::DocumentTemplateActor {
          name: user.name,
          email: user.email,
        }),
    )
  }
}

#[async_trait]
impl myoxus_application::document_fields::context::DocumentFieldContextSource for ApiState {
  async fn resolve_authorized(
    &self,
    workspace_id: uuid::Uuid,
    doc_id: uuid::Uuid,
    content_revision: String,
    fields: &[yjs::document_field::DocumentField],
    actor_id: Option<uuid::Uuid>,
  ) -> myoxus_application::auth::AuthResult<myoxus_application::document_fields::context::DocumentFieldContext> {
    self
      .document_field_resolver()
      .await
      .ok_or_else(|| myoxus_application::auth::AuthError::Storage("document field context unavailable".into()))?
      .resolve_authorized(workspace_id, doc_id, content_revision, fields, actor_id)
      .await
  }
}

impl ApiState {
  /// Construct an `ApiState` backed entirely by in-memory adapters.
  ///
  /// Used in tests and as the starting point before calling the builder
  /// methods (`with_services`, `with_redis_port`, ...) that swap in real
  /// production implementations.
  pub fn new(config: AppConfig) -> Self {
    let query_cache = QueryCache::new(&config.cache);
    let preview_runtime = Arc::new(PreviewRuntime::new(&config.preview));
    let store = Arc::new(InMemoryAuthStore::default());
    let mailer = Arc::new(LogMailAdapter);
    let storage: Arc<dyn BlobStoragePort> = Arc::new(NullBlobStorage);
    let auth_service = AuthService::new_with_token_ttls(
      store.clone(),
      mailer,
      storage.clone(),
      config.server.session_ttl,
      config.server.session_ttr,
      config.server.magic_link_ttl_seconds,
      config.auth.password_reset_ttl_seconds,
    )
    .expect("ApiState requires validated auth token TTL configuration")
    .with_mail_defaults(myoxus_application::auth::UserPreferenceDefaults {
      locale: config.i18n.default_locale.clone(),
      ..Default::default()
    });
    let workspace_service = WorkspaceService::new(store.clone());
    let admin_service = AdminService::new(Arc::new(InMemoryAdminStore));
    let doc_service = DocService::new(Arc::new(myoxus_application::doc::PanicDocStore));
    let notification_service = Arc::new(NotificationService::new(Arc::new(InMemoryNotificationStore::default())));
    let auth_adapter = Arc::new(AuthStoreCommentAdapter::new(auth_service.store.clone()));
    let comment_service = Arc::new(CommentService::new_with_mentions(
      Arc::new(InMemoryCommentStore::default()),
      auth_adapter.clone(),
      auth_adapter,
    ));
    let blob_service = Arc::new(BlobService::new(
      Arc::new(NullBlobStore),
      storage.clone(),
      "test-key".to_string(),
    ));
    let permission_service = Arc::new(PermissionService::new(store.clone()));
    let copilot_repository = Arc::new(InMemoryCopilotRepository::default());
    let copilot_service = Arc::new(CopilotService::new(copilot_repository.clone()));
    let transcription_results = Arc::new(
      myoxus_application::transcription::results::TranscriptionResultsService::new(Arc::new(
        myoxus_application::transcription::results::InMemoryTranscriptionResultRepository::new(copilot_repository),
      )),
    );
    let redis_port: Arc<dyn RedisPort> = Arc::new(InMemoryRedisAdapter::new("myoxus"));
    let captcha_service = build_captcha_service(&config.captcha, redis_port.clone());
    Self {
      config: config.clone(),
      services: ServiceRegistry {
        feature_sources: None,
        auth_service,
        mail_template_renderer: None,
        html_catalog: None,
        workspace_service,
        admin_service,
        doc_service,
        comment_service,
        notification_service,
        copilot_service,
        transcription_results,
        copilot_embedding_repo: None,
        copilot_embedding_provider: Arc::new(std::sync::OnceLock::new()),
        public_repository: Arc::new(PanicPublicRepository),
        manager_capability_writer: Arc::new(PanicManagerCapabilityWriter),
        blob_service,
        permission_service,
        storage,
        redis_port,
        distributed_lock: Arc::new(InMemoryRedisAdapter::new("myoxus")),
        search_repository: None,
        search_indexer: None,
        calendar_service: None,
        native_event_service: None,
        telemetry_service: Arc::new(TelemetryService::in_memory_stub()),
        metrics_service: Arc::new(MetricsService::in_memory_stub()),
        setup_state_service: SetupStateService::new(Arc::new(InMemorySetupStateStore::default())),
        branding_asset_repository: Arc::new(UnavailableBrandingAssetRepository),
        pdf_export_job_store: Arc::new(UnavailablePdfExportJobStore),
        document_audit_projection_store: Arc::new(UnavailableDocumentAuditProjectionStore),
        api_key_service: ApiKeyService::new(Arc::new(InMemoryApiKeyStore::default())),
        llm_provider_registry: LlmProviderRegistry::new(),
        // API-RV-01: Disable automatic redirects to prevent SSRF bypass.
        // Proxy handlers must manually follow redirects with re-validation.
        // Fail closed: a default client would silently restore redirects and
        // discard both bounded timeouts and the process trust snapshot.
        http_client: myoxus_infrastructure::tls::build_http_client(
          reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10)),
          config.additional_ca.as_ref(),
        )
        .expect("ApiState requires a constructible policy-bound TLS client"),
        template_registry_service: None,
        database_services: None,
        task_recurrence_service: None,
        assistant_packages: None,
        database_activity_recorder: None,
        workspace_import_service: None,
        workspace_export_service: None,
        workspace_tag_service: None,
        workspace_automation_service: None,
        document_graph_service: None,
        pdf_icc_repo: None,
        pdf_font_repo: None,
        pdf_blob_store: None,
        pdf_template_repo: None,
        pdf_assignment_repo: None,
        pdf_brand_repo: None,
        pdf_render_audit_repo: None,
        document_version_repo: None,
        document_version_settings_repo: None,
        document_metadata_policy_repo: None,
        document_metadata_policy_service: None,
        document_metadata_service: None,
        audit_recorder: myoxus_application::audit::AuditRecorder::noop(),
        captcha_service,
        organization_repo: None,
        organization_template_context_service: None,
        organization_unit_type_repo: None,
        organization_unit_repo: None,
        organization_unit_member_repo: None,
        organization_unit_workspace_repo: None,
        organization_policy_repo: None,
        organization_project_request_repo: None,
        organization_unit_lifecycle_service: None,
        oidc_group_directory: None,
        organization_permission_service: None,
        organization_project_request_service: None,
        organization_import_export_service: None,
        workspace_content_cluster_coordinator: None,
        workspace_content_control_service: None,
        workspace_content_redirect_service: None,
        git_sync_repository_builder: Arc::new(PolicyBoundGitRepositoryBuilder::new(&config.git_sync)),
        git_token_rotation_service: None,
      },
      runtime: RuntimeState {
        start_time: Instant::now(),
        is_ready: Arc::new(AtomicBool::new(false)),
        requests_total: Arc::new(AtomicU64::new(0)),
        requests_error_total: Arc::new(AtomicU64::new(0)),
        request_latency_total_micros: Arc::new(AtomicU64::new(0)),
        request_latency_max_micros: Arc::new(AtomicU64::new(0)),
        metrics_pool: None,
        client_update_runtime: None,
        redis_queue: None,
        startup_checks: Arc::new(RwLock::new(Vec::new())),
        doc_cache_tuning: None,
        captcha_verified_total: Arc::new(AtomicU64::new(0)),
        captcha_rejected_total: Arc::new(AtomicU64::new(0)),
        captcha_honeypot_total: Arc::new(AtomicU64::new(0)),
      },
      query_cache,
      preview_runtime,
      socket_io: Arc::new(std::sync::RwLock::new(None)),
      logging: None,
      redis_ws_adapter: None,
      instance_id: uuid::Uuid::new_v4(),
      resource_updates: myoxus_application::events::WorkspaceResourceUpdates::default(),
      cache_bus: None,
      cache_redis: None,
      config_overrides: Arc::new(tokio::sync::RwLock::new(ConfigOverrides::default())),
      transcription_runtime: Arc::default(),
      config_file_baseline: Arc::new(config.clone()),
    }
  }

  /// Construct an `ApiState` with production services.  Remaining adapters
  /// (Redis, distributed lock, search, calendar) default to in-memory stubs
  /// and must be swapped via the builder methods.
  pub fn with_services(
    config: AppConfig,
    auth_service: AuthService,
    workspace_service: WorkspaceService,
    admin_service: AdminService,
    doc_service: DocService,
    blob_service: Arc<BlobService>,
    storage: Arc<dyn BlobStoragePort>,
  ) -> Self {
    let notification_service = Arc::new(NotificationService::new(Arc::new(InMemoryNotificationStore::default())));
    let auth_adapter = Arc::new(AuthStoreCommentAdapter::new(auth_service.store.clone()));
    let comment_service = Arc::new(CommentService::new_with_mentions(
      Arc::new(InMemoryCommentStore::default()),
      auth_adapter.clone(),
      auth_adapter,
    ));
    Self::with_services_and_comment(
      config,
      auth_service,
      workspace_service,
      admin_service,
      doc_service,
      comment_service,
      notification_service,
      blob_service,
      storage,
    )
  }

  /// Extended constructor that additionally accepts pre-built `comment` and
  /// `notification` services.
  #[allow(clippy::too_many_arguments)]
  pub fn with_services_and_comment(
    config: AppConfig,
    auth_service: AuthService,
    workspace_service: WorkspaceService,
    admin_service: AdminService,
    doc_service: DocService,
    comment_service: Arc<CommentService>,
    notification_service: Arc<NotificationService>,
    blob_service: Arc<BlobService>,
    storage: Arc<dyn BlobStoragePort>,
  ) -> Self {
    let permission_service = Arc::new(PermissionService::new(auth_service.store.clone()));
    Self::with_services_comment_and_permission(
      config,
      auth_service,
      workspace_service,
      admin_service,
      doc_service,
      comment_service,
      notification_service,
      blob_service,
      storage,
      permission_service,
    )
  }

  /// Construct production state with one shared permission authority.
  ///
  /// Callers that build permission-aware services before `ApiState` exists
  /// must pass the same `Arc` here. Organization wiring enriches this instance
  /// in place, so early services cannot retain a direct-membership-only copy.
  #[expect(
    clippy::too_many_arguments,
    reason = "this compatibility constructor keeps mandatory service capabilities explicit"
  )]
  pub fn with_services_comment_and_permission(
    config: AppConfig,
    auth_service: AuthService,
    workspace_service: WorkspaceService,
    admin_service: AdminService,
    doc_service: DocService,
    comment_service: Arc<CommentService>,
    notification_service: Arc<NotificationService>,
    blob_service: Arc<BlobService>,
    storage: Arc<dyn BlobStoragePort>,
    permission_service: Arc<PermissionService>,
  ) -> Self {
    let query_cache = QueryCache::new(&config.cache);
    let preview_runtime = Arc::new(PreviewRuntime::new(&config.preview));
    let redis_port: Arc<dyn RedisPort> = Arc::new(InMemoryRedisAdapter::new("myoxus"));
    let captcha_service = build_captcha_service(&config.captcha, redis_port.clone());
    let copilot_repository = Arc::new(InMemoryCopilotRepository::default());
    Self {
      config: config.clone(),
      services: ServiceRegistry {
        feature_sources: None,
        auth_service,
        mail_template_renderer: None,
        html_catalog: None,
        workspace_service,
        admin_service,
        doc_service,
        comment_service,
        notification_service,
        copilot_service: Arc::new(CopilotService::new(copilot_repository.clone())),
        transcription_results: Arc::new(
          myoxus_application::transcription::results::TranscriptionResultsService::new(Arc::new(
            myoxus_application::transcription::results::InMemoryTranscriptionResultRepository::new(copilot_repository),
          )),
        ),
        copilot_embedding_repo: None,
        copilot_embedding_provider: Arc::new(std::sync::OnceLock::new()),
        public_repository: Arc::new(PanicPublicRepository),
        manager_capability_writer: Arc::new(PanicManagerCapabilityWriter),
        blob_service,
        permission_service,
        storage,
        redis_port,
        distributed_lock: Arc::new(InMemoryRedisAdapter::new("myoxus")),
        search_repository: None,
        search_indexer: None,
        calendar_service: None,
        native_event_service: None,
        telemetry_service: Arc::new(TelemetryService::in_memory_stub()),
        metrics_service: Arc::new(MetricsService::in_memory_stub()),
        setup_state_service: SetupStateService::new(Arc::new(InMemorySetupStateStore::default())),
        branding_asset_repository: Arc::new(UnavailableBrandingAssetRepository),
        pdf_export_job_store: Arc::new(UnavailablePdfExportJobStore),
        document_audit_projection_store: Arc::new(UnavailableDocumentAuditProjectionStore),
        api_key_service: ApiKeyService::new(Arc::new(InMemoryApiKeyStore::default())),
        llm_provider_registry: LlmProviderRegistry::new(),
        // API-RV-01: Disable automatic redirects to prevent SSRF bypass.
        // Proxy handlers must manually follow redirects with re-validation.
        // Fail closed: a default client would silently restore redirects and
        // discard both bounded timeouts and the process trust snapshot.
        http_client: myoxus_infrastructure::tls::build_http_client(
          reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10)),
          config.additional_ca.as_ref(),
        )
        .expect("ApiState requires a constructible policy-bound TLS client"),
        template_registry_service: None,
        database_services: None,
        task_recurrence_service: None,
        assistant_packages: None,
        database_activity_recorder: None,
        workspace_import_service: None,
        workspace_export_service: None,
        workspace_tag_service: None,
        workspace_automation_service: None,
        document_graph_service: None,
        pdf_icc_repo: None,
        pdf_font_repo: None,
        pdf_blob_store: None,
        pdf_template_repo: None,
        pdf_assignment_repo: None,
        pdf_brand_repo: None,
        pdf_render_audit_repo: None,
        document_version_repo: None,
        document_version_settings_repo: None,
        document_metadata_policy_repo: None,
        document_metadata_policy_service: None,
        document_metadata_service: None,
        audit_recorder: myoxus_application::audit::AuditRecorder::noop(),
        captcha_service,
        organization_repo: None,
        organization_template_context_service: None,
        organization_unit_type_repo: None,
        organization_unit_repo: None,
        organization_unit_member_repo: None,
        organization_unit_workspace_repo: None,
        organization_policy_repo: None,
        organization_project_request_repo: None,
        organization_unit_lifecycle_service: None,
        oidc_group_directory: None,
        organization_permission_service: None,
        organization_project_request_service: None,
        organization_import_export_service: None,
        workspace_content_cluster_coordinator: None,
        workspace_content_control_service: None,
        workspace_content_redirect_service: None,
        git_sync_repository_builder: Arc::new(PolicyBoundGitRepositoryBuilder::new(&config.git_sync)),
        git_token_rotation_service: None,
      },
      runtime: RuntimeState {
        start_time: Instant::now(),
        is_ready: Arc::new(AtomicBool::new(false)),
        requests_total: Arc::new(AtomicU64::new(0)),
        requests_error_total: Arc::new(AtomicU64::new(0)),
        request_latency_total_micros: Arc::new(AtomicU64::new(0)),
        request_latency_max_micros: Arc::new(AtomicU64::new(0)),
        metrics_pool: None,
        client_update_runtime: None,
        redis_queue: None,
        startup_checks: Arc::new(RwLock::new(Vec::new())),
        doc_cache_tuning: None,
        captcha_verified_total: Arc::new(AtomicU64::new(0)),
        captcha_rejected_total: Arc::new(AtomicU64::new(0)),
        captcha_honeypot_total: Arc::new(AtomicU64::new(0)),
      },
      query_cache,
      preview_runtime,
      socket_io: Arc::new(std::sync::RwLock::new(None)),
      logging: None,
      redis_ws_adapter: None,
      instance_id: uuid::Uuid::new_v4(),
      resource_updates: myoxus_application::events::WorkspaceResourceUpdates::default(),
      cache_bus: None,
      cache_redis: None,
      config_overrides: Arc::new(tokio::sync::RwLock::new(ConfigOverrides::default())),
      transcription_runtime: Arc::default(),
      config_file_baseline: Arc::new(config),
    }
  }

  /// Return `true` when the server has completed startup checks and is
  /// accepting traffic.
  pub fn is_ready(&self) -> bool {
    self.runtime.is_ready.load(Ordering::Relaxed)
  }

  /// Flip the readiness flag (used by the startup-check task).
  pub fn set_ready(&self, ready: bool) {
    self.runtime.is_ready.store(ready, Ordering::Relaxed);
  }

  /// Validate the complete capability inventory required by the production
  /// router and its workers.
  ///
  /// Narrow integration-test states intentionally remain partial and use the
  /// reduced router builders. The production composition root calls this
  /// before starting any long-lived task, and [`crate::build_router`] repeats
  /// the check before initializing router-owned runtime state.
  pub fn validate_production_composition(&self) -> Result<(), ProductionCompositionError> {
    let mut missing_capabilities = [
      ("html_catalog", self.services.html_catalog.is_none()),
      ("mail_template_renderer", self.services.mail_template_renderer.is_none()),
      ("calendar_service", self.services.calendar_service.is_none()),
      ("client_update_runtime", self.runtime.client_update_runtime.is_none()),
      ("copilot_embedding_repo", self.services.copilot_embedding_repo.is_none()),
      (
        "database_activity_recorder",
        self.services.database_activity_recorder.is_none(),
      ),
      ("database_services", self.services.database_services.is_none()),
      (
        "task_recurrence_service",
        self.services.task_recurrence_service.is_none(),
      ),
      ("document_graph_service", self.services.document_graph_service.is_none()),
      (
        "document_metadata_policy_repo",
        self.services.document_metadata_policy_repo.is_none(),
      ),
      (
        "document_metadata_policy_service",
        self.services.document_metadata_policy_service.is_none(),
      ),
      (
        "document_metadata_service",
        self.services.document_metadata_service.is_none(),
      ),
      ("document_version_repo", self.services.document_version_repo.is_none()),
      (
        "document_version_settings_repo",
        self.services.document_version_settings_repo.is_none(),
      ),
      ("logging", self.logging.is_none()),
      (
        "git_token_rotation_service",
        self.services.git_token_rotation_service.is_none(),
      ),
      ("metrics_pool", self.runtime.metrics_pool.is_none()),
      ("native_event_service", self.services.native_event_service.is_none()),
      (
        "organization_import_export_service",
        self.services.organization_import_export_service.is_none(),
      ),
      (
        "organization_permission_service",
        self.services.organization_permission_service.is_none(),
      ),
      (
        "organization_policy_repo",
        self.services.organization_policy_repo.is_none(),
      ),
      (
        "organization_project_request_repo",
        self.services.organization_project_request_repo.is_none(),
      ),
      (
        "organization_project_request_service",
        self.services.organization_project_request_service.is_none(),
      ),
      ("organization_repo", self.services.organization_repo.is_none()),
      (
        "organization_template_context_service",
        self.services.organization_template_context_service.is_none(),
      ),
      (
        "organization_unit_lifecycle_service",
        self.services.organization_unit_lifecycle_service.is_none(),
      ),
      (
        "organization_unit_member_repo",
        self.services.organization_unit_member_repo.is_none(),
      ),
      ("organization_unit_repo", self.services.organization_unit_repo.is_none()),
      (
        "organization_unit_type_repo",
        self.services.organization_unit_type_repo.is_none(),
      ),
      (
        "organization_unit_workspace_repo",
        self.services.organization_unit_workspace_repo.is_none(),
      ),
      ("pdf_assignment_repo", self.services.pdf_assignment_repo.is_none()),
      ("pdf_blob_store", self.services.pdf_blob_store.is_none()),
      ("pdf_brand_repo", self.services.pdf_brand_repo.is_none()),
      ("pdf_font_repo", self.services.pdf_font_repo.is_none()),
      ("pdf_icc_repo", self.services.pdf_icc_repo.is_none()),
      ("pdf_render_audit_repo", self.services.pdf_render_audit_repo.is_none()),
      ("pdf_template_repo", self.services.pdf_template_repo.is_none()),
      ("redis_queue", self.runtime.redis_queue.is_none()),
      ("search_indexer", self.services.search_indexer.is_none()),
      ("search_repository", self.services.search_repository.is_none()),
      (
        "template_registry_service",
        self.services.template_registry_service.is_none(),
      ),
      (
        "workspace_automation_service",
        self.services.workspace_automation_service.is_none(),
      ),
      (
        "workspace_content_cluster_coordinator",
        self.services.workspace_content_cluster_coordinator.is_none(),
      ),
      (
        "workspace_content_control_service",
        self.services.workspace_content_control_service.is_none(),
      ),
      (
        "workspace_content_redirect_service",
        self.services.workspace_content_redirect_service.is_none(),
      ),
      (
        "workspace_import_service",
        self.services.workspace_import_service.is_none(),
      ),
      (
        "workspace_export_service",
        self.services.workspace_export_service.is_none(),
      ),
      ("workspace_tag_service", self.services.workspace_tag_service.is_none()),
    ]
    .into_iter()
    .filter_map(|(name, missing)| missing.then_some(name))
    .collect::<Vec<_>>();
    missing_capabilities.sort_unstable();

    if missing_capabilities.is_empty() {
      Ok(())
    } else {
      Err(ProductionCompositionError { missing_capabilities })
    }
  }

  /// Returns the effective live configuration snapshot.
  ///
  /// The immutable file/ENV baseline is deliberately distinct from `config`,
  /// which includes database overrides materialized at process startup. Using
  /// the latter would resurrect a removed override until the next restart.
  pub async fn effective_config(&self) -> EffectiveConfig {
    // Waiting for the short-lived writer preserves a coherent snapshot. A
    // transient reload must never masquerade as an empty override set.
    let overrides = self.config_overrides.read().await.clone();
    EffectiveConfig::new(Arc::clone(&self.config_file_baseline), Arc::new(overrides))
  }

  pub async fn transcription_service(
    &self,
  ) -> Result<
    Arc<myoxus_application::transcription::TranscriptionService>,
    myoxus_application::transcription::ProviderError,
  > {
    self.transcription_snapshot().await.1
  }

  /// Hold the snapshot lock through adapter selection, in the same lock order
  /// as reload publication. An old reader must not repopulate the cache after
  /// a configuration change has invalidated its last connection outcome.
  pub async fn transcription_snapshot(
    &self,
  ) -> (
    crate::config::TranscriptionConfig,
    Result<
      Arc<myoxus_application::transcription::TranscriptionService>,
      myoxus_application::transcription::ProviderError,
    >,
  ) {
    let overrides = self.config_overrides.read().await;
    let config =
      EffectiveConfig::new(Arc::clone(&self.config_file_baseline), Arc::new(overrides.clone())).transcription();
    let service = self
      .transcription_runtime
      .service(config.clone(), self.config.additional_ca.as_ref())
      .await;
    drop(overrides);
    (config, service)
  }

  /// Resolve Git-Sync policy from the same coherent live configuration
  /// snapshot used by every other request and worker consumer.
  pub async fn effective_git_sync_policy(
    &self,
  ) -> Result<crate::git_sync_engine::policy::EffectiveGitSyncPolicy, String> {
    let effective = self.effective_config().await;
    crate::git_sync_engine::policy::resolve_effective_git_sync_policy(&effective)
  }

  /// Resolve the connection-admission limit from a coherent runtime snapshot.
  /// Unlike the generic synchronous view, this hot security boundary waits for
  /// a concurrent reload writer instead of temporarily falling back to a
  /// potentially weaker startup value.
  pub async fn websocket_connection_admission_limit(&self) -> u32 {
    let overrides = self.config_overrides.read().await;
    crate::config_reload::resolve_websocket_connection_admission_limit(
      self
        .config_file_baseline
        .websocket
        .max_connections_per_second_per_client,
      &overrides.overrides,
    )
  }

  pub fn uptime_seconds(&self) -> u64 {
    self.runtime.start_time.elapsed().as_secs()
  }

  pub fn request_count(&self) -> u64 {
    self.runtime.requests_total.load(Ordering::Relaxed)
  }

  pub fn increment_request_count(&self) {
    self.runtime.requests_total.fetch_add(1, Ordering::Relaxed);
  }

  /// Update all atomic metrics counters for a single completed request.
  ///
  /// Updates total request count, error count (when `status_code >= 400`),
  /// cumulative latency, and max observed latency using a compare-exchange loop.
  pub fn record_request_metrics(&self, status_code: u16, latency: Duration) {
    self.increment_request_count();
    if status_code >= 400 {
      self.runtime.requests_error_total.fetch_add(1, Ordering::Relaxed);
    }
    let micros = latency.as_micros().min(u64::MAX as u128) as u64;
    self
      .runtime
      .request_latency_total_micros
      .fetch_add(micros, Ordering::Relaxed);
    let mut current_max = self.runtime.request_latency_max_micros.load(Ordering::Relaxed);
    while micros > current_max {
      match self.runtime.request_latency_max_micros.compare_exchange_weak(
        current_max,
        micros,
        Ordering::Relaxed,
        Ordering::Relaxed,
      ) {
        Ok(_) => break,
        Err(observed) => current_max = observed,
      }
    }
  }

  pub fn request_error_count(&self) -> u64 {
    self.runtime.requests_error_total.load(Ordering::Relaxed)
  }

  pub fn request_latency_total_micros(&self) -> u64 {
    self.runtime.request_latency_total_micros.load(Ordering::Relaxed)
  }

  pub fn request_latency_max_micros(&self) -> u64 {
    self.runtime.request_latency_max_micros.load(Ordering::Relaxed)
  }

  pub fn auth(&self) -> &AuthService {
    &self.services.auth_service
  }

  pub fn workspace(&self) -> &WorkspaceService {
    &self.services.workspace_service
  }

  /// Build the shared user-settings operation with this state's live cache
  /// and publication adapters.
  pub fn workspace_settings_service(&self) -> WorkspaceSettingsService {
    WorkspaceSettingsService::new(
      self.workspace().clone(),
      self.permission_service(),
      Arc::new(self.clone()),
      self.public_repository(),
      self.doc().clone(),
      self.document_metadata_policy_service(),
    )
  }

  /// Public and authenticated adapters share the native operation-local reader.
  pub fn workspace_overview_service(&self) -> Option<myoxus_application::workspace_overview::WorkspaceOverviewService> {
    Some(myoxus_application::workspace_overview::WorkspaceOverviewService::new(
      self.workspace().clone(),
      self.doc().clone(),
      self.document_metadata_policy_service()?,
      self.workspace_tag_service()?,
      self.auth().clone(),
    ))
  }

  /// Bind the current auth/cache wiring, including adapters attached after bootstrap.
  pub fn admin_users(&self) -> AdminUserService {
    AdminUserService::new(
      self.admin().clone(),
      self.auth().clone(),
      self.workspace().clone(),
      self.audit_recorder().clone(),
    )
  }

  pub fn admin(&self) -> &AdminService {
    &self.services.admin_service
  }

  pub fn doc(&self) -> &DocService {
    &self.services.doc_service
  }

  pub fn blob(&self) -> &BlobService {
    &self.services.blob_service
  }

  pub fn blob_service(&self) -> Arc<BlobService> {
    self.services.blob_service.clone()
  }

  pub fn comment(&self) -> &CommentService {
    &self.services.comment_service
  }

  pub fn notification(&self) -> &NotificationService {
    &self.services.notification_service
  }

  pub fn notification_service(&self) -> Arc<NotificationService> {
    self.services.notification_service.clone()
  }

  pub fn copilot(&self) -> Arc<CopilotService> {
    self.services.copilot_service.clone()
  }

  pub fn transcription_results(&self) -> Arc<myoxus_application::transcription::results::TranscriptionResultsService> {
    self.services.transcription_results.clone()
  }

  pub async fn context_ingestion(
    &self,
  ) -> myoxus_application::auth::AuthResult<myoxus_application::copilot::context_ingest::ContextIngestion> {
    use myoxus_application::{
      auth::AuthError,
      copilot::context_ingest::{ContextIngestion, ContextIngestionLimits},
    };
    use myoxus_infrastructure::mime_policy_config::{MimePolicyFallback, resolve_mime_policy_config};
    let queue = self
      .redis_queue()
      .ok_or_else(|| AuthError::Storage("context worker is unavailable".into()))?;
    let effective = self.effective_config().await;
    let fallback = MimePolicyFallback {
      allowlist: &effective.base.git_sync.mime_allowlist_admin,
      blocklist: &effective.base.git_sync.mime_blocklist_admin,
      validation_mode: &effective.base.git_sync.mime_validation_mode,
    };
    Ok(ContextIngestion {
      copilot: self.copilot(),
      blobs: self.blob_service(),
      permissions: self.permission_service(),
      queue: Arc::new(crate::work_queue::RedisQueueAdapter { queue }),
      parser: Arc::new(crate::copilot_context_parser::SubprocessContextParser {
        executable: std::env::current_exe().map_err(|_| AuthError::Storage("context parser unavailable".into()))?,
      }),
      limits: ContextIngestionLimits {
        max_input_bytes: effective.base.storage.max_upload_bytes(),
        max_output_bytes: effective.base.mcp.document_export_max_bytes,
        timeout_ms: effective.base.copilot.request_timeout_ms.max(1),
        dispatch_ms: myoxus_worker::RuntimeConfig::default().stall_check_interval_ms.max(1),
        max_attempts: effective.base.job.queue.attempts.max(1),
      },
      mime_policy: resolve_mime_policy_config(&effective.overrides.overrides, &fallback),
    })
  }

  pub fn transcription_pipeline(
    &self,
  ) -> myoxus_application::auth::AuthResult<myoxus_application::transcription::pipeline::TranscriptionPipeline> {
    let queue = self
      .redis_queue()
      .ok_or_else(|| myoxus_application::auth::AuthError::Storage("transcription worker is unavailable".into()))?;
    Ok(myoxus_application::transcription::pipeline::TranscriptionPipeline::new(
      self.transcription_results().repository(),
      self.blob_service(),
      self.permission_service(),
      Arc::new(myoxus_infrastructure::transcription::input::EncodedAudioInspector),
      Arc::new(crate::work_queue::RedisQueueAdapter { queue }),
    ))
  }

  pub fn transcription_job_policy(&self) -> myoxus_application::transcription::pipeline::TranscriptionJobPolicy {
    myoxus_application::transcription::pipeline::TranscriptionJobPolicy {
      max_attempts: self.config.job.queue.attempts.max(1),
      dispatch_seconds: myoxus_worker::RuntimeConfig::default()
        .stall_check_interval_ms
        .div_ceil(1000)
        .max(1)
        .min(u64::from(u32::MAX)) as u32,
    }
  }

  pub fn copilot_embedding_provider(
    &self,
  ) -> Result<
    Arc<dyn myoxus_application::copilot::provider::LlmProvider>,
    myoxus_application::copilot::provider::LlmProviderError,
  > {
    self
      .services
      .copilot_embedding_provider
      .get_or_init(|| {
        let cfg = &self.config.copilot.embedding;
        let endpoint = cfg.endpoint.as_ref()?;
        let key = cfg
          .api_key
          .as_ref()
          .map(|key| {
            if let Some(name) = key.strip_prefix("env:") {
              std::env::var(name).unwrap_or_default()
            } else {
              key.clone()
            }
          })
          .unwrap_or_default();
        myoxus_infrastructure::copilot::openai_provider::OpenAiProvider::new(
          "copilot-embedding".into(),
          key,
          endpoint.clone(),
          cfg.model.clone(),
          vec![cfg.model.clone()],
          Default::default(),
          std::time::Duration::from_millis(self.config.copilot.request_timeout_ms.max(1)),
          self.config.additional_ca.as_ref(),
        )
        .ok()
        .map(|provider| {
          Arc::new(
            provider
              .with_embedding_dimensions(cfg.dimensions)
              .with_embedding_task_type(cfg.send_task_type),
          ) as Arc<dyn myoxus_application::copilot::provider::LlmProvider>
        })
      })
      .clone()
      .ok_or_else(|| {
        myoxus_application::copilot::provider::LlmProviderError::Unavailable(
          "workspace retrieval embedding transport is unavailable".into(),
        )
      })
  }

  pub async fn embed_copilot_query(
    &self,
    text: &str,
  ) -> Result<Vec<f32>, myoxus_application::copilot::provider::LlmProviderError> {
    let provider = self.copilot_embedding_provider()?;
    let mut vectors = myoxus_application::copilot::embedding::embed_checked(
      provider.as_ref(),
      &[text.into()],
      &self.config.copilot.embedding.model,
      self.config.copilot.embedding.dimensions,
      myoxus_application::copilot::provider::EmbeddingPurpose::Query,
    )
    .await?;
    vectors.pop().ok_or_else(|| {
      myoxus_application::copilot::provider::LlmProviderError::Upstream("query embedding is missing".into())
    })
  }

  pub async fn embedding_indexer(
    &self,
  ) -> myoxus_application::auth::AuthResult<myoxus_application::copilot::embedding::EmbeddingIndexer> {
    use myoxus_application::auth::AuthError;
    let context = self.context_ingestion().await?;
    Ok(myoxus_application::copilot::embedding::EmbeddingIndexer {
      copilot: self.copilot(),
      repository: self
        .copilot_embedding_repo()
        .ok_or_else(|| AuthError::Storage("embedding repository unavailable".into()))?,
      docs: Arc::new(self.doc().clone()),
      blobs: self.blob_service(),
      permissions: self.permission_service(),
      queue: context.queue,
      parser: context.parser,
      limits: context.limits,
      provider: self
        .copilot_embedding_provider()
        .map_err(|_| AuthError::Storage("embedding transport unavailable".into()))?,
      model: self.config.copilot.embedding.model.clone(),
      dimensions: self.config.copilot.embedding.dimensions,
      batch_size: self.config.copilot.embedding.batch_size,
      mime_policy: context.mime_policy,
    })
  }

  /// P101-RAG-01: optional embedding repository for RAG similarity search.
  pub fn copilot_embedding_repo(&self) -> Option<Arc<dyn CopilotEmbeddingRepository>> {
    self.services.copilot_embedding_repo.clone()
  }

  pub fn permission_service(&self) -> Arc<PermissionService> {
    self.services.permission_service.clone()
  }

  pub fn telemetry(&self) -> &TelemetryService {
    &self.services.telemetry_service
  }

  pub fn telemetry_arc(&self) -> Arc<TelemetryService> {
    self.services.telemetry_service.clone()
  }

  /// Derive a [`TelemetryPolicy`] from the current effective telemetry
  /// configuration.  Callers invoke this once per request (cheap clone of
  /// HashMaps) and pass the snapshot to [`TelemetryService::ingest`] so the
  /// policy stays consistent across the call.
  pub fn telemetry_policy(&self) -> myoxus_application::telemetry::TelemetryPolicy {
    let t = &self.config.telemetry;
    myoxus_application::telemetry::TelemetryPolicy {
      enabled: t.enabled,
      categories: t.categories.clone(),
      sampling_rates: t.sampling_rates.clone(),
      dedupe_ttl_hours: t.dedupe_ttl_hours,
      dedupe_max_entries: t.dedupe_max_entries,
      batch_max_events: t.batch_max_events,
    }
  }

  /// P-Metrics-B: business-metrics service.  Always present; check
  /// [`MetricsConfig::enabled`] before emitting a hook.
  pub fn metrics(&self) -> &MetricsService {
    &self.services.metrics_service
  }

  pub fn metrics_arc(&self) -> Arc<MetricsService> {
    self.services.metrics_service.clone()
  }

  /// P-Captcha-B: ALTCHA CAPTCHA service. Always present; check
  /// [`CaptchaService::is_enabled`] before gating a request.
  pub fn captcha(&self) -> Arc<CaptchaService> {
    self.services.captcha_service.clone()
  }

  /// P-Captcha-C: successful captcha verifications since startup.
  pub fn captcha_verified_count(&self) -> u64 {
    self.runtime.captcha_verified_total.load(Ordering::Relaxed)
  }

  pub fn increment_captcha_verified(&self) {
    self.runtime.captcha_verified_total.fetch_add(1, Ordering::Relaxed);
    self.metrics().record(
      myoxus_application::metrics::MetricsCategory::Auth,
      "captcha_verified",
      &[],
    );
  }

  /// P-Captcha-C: rejected captcha verifications since startup.
  pub fn captcha_rejected_count(&self) -> u64 {
    self.runtime.captcha_rejected_total.load(Ordering::Relaxed)
  }

  pub fn increment_captcha_rejected(&self) {
    self.runtime.captcha_rejected_total.fetch_add(1, Ordering::Relaxed);
    self.metrics().record(
      myoxus_application::metrics::MetricsCategory::Auth,
      "captcha_rejected",
      &[],
    );
  }

  pub fn increment_captcha_rejected_with_reason(&self, reason: &str) {
    self.runtime.captcha_rejected_total.fetch_add(1, Ordering::Relaxed);
    self.metrics().record(
      myoxus_application::metrics::MetricsCategory::Auth,
      "captcha_rejected",
      &[("reason", reason)],
    );
  }

  /// P-Captcha-C: honeypot traps triggered since startup.
  pub fn captcha_honeypot_count(&self) -> u64 {
    self.runtime.captcha_honeypot_total.load(Ordering::Relaxed)
  }

  pub fn increment_captcha_honeypot(&self) {
    self.runtime.captcha_honeypot_total.fetch_add(1, Ordering::Relaxed);
    self.metrics().record(
      myoxus_application::metrics::MetricsCategory::Auth,
      "captcha_honeypot",
      &[],
    );
  }

  pub fn storage(&self) -> &Arc<dyn BlobStoragePort> {
    &self.services.storage
  }

  /// Attach a Redis adapter.  When session-cache is enabled in config, the
  /// auth service is also wired to use Redis for session caching.
  ///
  /// P-Captcha-B: the CAPTCHA service is also rebuilt so replay-registry and
  /// rate-limiter run against the same Redis as the rest of the stack.
  pub fn with_redis_port(mut self, redis_port: Arc<dyn RedisPort>) -> Self {
    if self.config.redis.session_cache.enabled {
      self.services.auth_service = self
        .services
        .auth_service
        .clone()
        .with_session_cache(redis_port.clone(), self.config.redis.session_cache.ttl_seconds);
    }
    self.services.captcha_service = build_captcha_service(&self.config.captcha, redis_port.clone());
    self.services.redis_port = redis_port;
    self
  }

  pub fn redis_port(&self) -> Arc<dyn RedisPort> {
    self.services.redis_port.clone()
  }

  pub fn with_distributed_lock(mut self, distributed_lock: Arc<dyn DistributedLockPort>) -> Self {
    self.services.distributed_lock = distributed_lock;
    self
  }

  pub fn distributed_lock(&self) -> Arc<dyn DistributedLockPort> {
    self.services.distributed_lock.clone()
  }

  pub fn with_search_repository(mut self, search_repository: Arc<dyn SearchRepository>) -> Self {
    self.services.search_repository = Some(search_repository);
    self
  }

  pub fn with_git_sync_repository_builder(mut self, builder: Arc<dyn GitRepositoryBuilder>) -> Self {
    self.services.git_sync_repository_builder = builder;
    self
  }

  pub fn git_sync_repository_builder(&self) -> Arc<dyn GitRepositoryBuilder> {
    self.services.git_sync_repository_builder.clone()
  }

  pub fn with_git_token_rotation_service(mut self, service: Arc<GitTokenRotationService>) -> Self {
    self.services.git_token_rotation_service = Some(service);
    self
  }

  pub fn git_token_rotation_service(&self) -> Option<Arc<GitTokenRotationService>> {
    self.services.git_token_rotation_service.clone()
  }

  pub fn search_repository(&self) -> Option<Arc<dyn SearchRepository>> {
    self.services.search_repository.clone()
  }

  pub fn with_search_indexer(mut self, indexer: Arc<SearchIndexerService>) -> Self {
    self.services.search_indexer = Some(indexer);
    self
  }

  pub fn search_indexer(&self) -> Option<Arc<SearchIndexerService>> {
    self.services.search_indexer.clone()
  }

  /// Install a fully-wired telemetry ingest service (Postgres repo + Redis
  /// dedupe).  The default `ApiState::new` path uses an in-memory stub; the
  /// production binary swaps in the real service via this builder after the
  /// DB pool has been constructed.
  pub fn with_telemetry_service(mut self, telemetry: Arc<TelemetryService>) -> Self {
    self.services.telemetry_service = telemetry;
    self
  }

  /// P-Metrics-B: install a fully-wired business-metrics service.  Parallel
  /// to [`Self::with_telemetry_service`] — the default stub keeps counters
  /// in process memory; production swaps in the Postgres-backed variant once
  /// the pool is ready.
  pub fn with_metrics_service(mut self, metrics: Arc<MetricsService>) -> Self {
    self.services.metrics_service = metrics;
    self
  }

  /// Attach a PostgreSQL pool for the metrics/admin dashboard, and wire up
  /// the copilot service backed by the same pool.
  pub fn with_metrics_pool(mut self, pool: sqlx::PgPool) -> Self {
    self.services.copilot_service = Arc::new(CopilotService::new(Arc::new(SqlxCopilotRepository::new(pool.clone()))));
    self.services.transcription_results = Arc::new(
      myoxus_application::transcription::results::TranscriptionResultsService::new(Arc::new(
        myoxus_infrastructure::transcription::results::PgTranscriptionResultRepository::new(pool.clone()),
      )),
    );
    // P101-RAG-01: wire embedding repo so the SSE handler can call similarity_search().
    self.services.copilot_embedding_repo = Some(Arc::new(SqlxCopilotEmbeddingRepository::new(pool.clone())));
    self.services.public_repository = Arc::new(myoxus_infrastructure::public::PgPublicRepository::new(pool.clone()));
    self.services.manager_capability_writer = Arc::new(
      myoxus_infrastructure::organization::PgManagerCapabilityWriter::new(pool.clone()),
    );
    self.services.setup_state_service = SetupStateService::new(Arc::new(
      myoxus_infrastructure::app_config::PgSetupStateStore::new(pool.clone()),
    ));
    self.services.branding_asset_repository = Arc::new(
      myoxus_infrastructure::branding::PgBrandingAssetRepository::new(pool.clone()),
    );
    self.services.pdf_export_job_store = Arc::new(myoxus_infrastructure::pdf_export::PgPdfExportJobStore::new(
      pool.clone(),
    ));
    self.services.document_audit_projection_store =
      Arc::new(myoxus_infrastructure::audit::PgAuditLogStore::new(pool.clone()));
    self.runtime.client_update_runtime = Some(Arc::new(ClientUpdateRuntime::new(pool.clone())));
    self.runtime.metrics_pool = Some(pool);
    self
  }

  pub fn metrics_pool(&self) -> Option<sqlx::PgPool> {
    self.runtime.metrics_pool.clone()
  }

  /// One application owner for template facts consumed by GraphQL and MCP.
  pub fn document_template_service(
    &self,
  ) -> Option<Arc<myoxus_application::document_template::DocumentTemplateService>> {
    let pool = self.metrics_pool()?;
    let repo = Arc::new(myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository::new(pool));
    let permission = self.permission_service();
    Some(Arc::new(
      myoxus_application::document_template::DocumentTemplateService::new(
        repo.clone(),
        Arc::new(self.doc().clone()),
        permission.clone(),
      )
      .with_mutations(
        myoxus_application::document_metadata::DocumentMetadataService::new(repo),
        Arc::new(
          myoxus_application::document_template::OrganizerDocumentTemplatePlacement::new(
            self.doc().clone(),
            permission,
          ),
        ),
      )
      .with_instantiation_assets(self.blob_service())
      .with_organization_context(self.organization_template_context_service())
      .with_workspace_context(self.workspace().clone())
      .with_account(Arc::new(self.clone())),
    ))
  }

  /// One live defaults projection shared by account UI and server operations.
  pub async fn user_preference_defaults(&self) -> myoxus_application::auth::UserPreferenceDefaults {
    let config = self.effective_config().await;
    myoxus_application::auth::UserPreferenceDefaults {
      locale: config
        .string("i18n.default_locale")
        .unwrap_or_else(|| config.base.i18n.default_locale.clone()),
      journal_first_day_of_week: config
        .string("journal.first_day_of_week")
        .unwrap_or_else(|| config.base.journal.first_day_of_week.clone()),
      journal_show_calendar_weeks: config
        .bool("journal.show_calendar_weeks")
        .unwrap_or(config.base.journal.show_calendar_weeks),
      ..Default::default()
    }
  }

  pub fn public_repository(&self) -> Arc<dyn PublicRepository> {
    self.services.public_repository.clone()
  }

  /// Build the shared document publication operation from the live server
  /// configuration and optional versioning capabilities.
  pub fn document_publication_service(&self) -> myoxus_application::public::DocumentPublicationService {
    let mut service = myoxus_application::public::DocumentPublicationService::new(
      self.permission_service(),
      Arc::new(self.doc().clone()),
      self.public_repository(),
      self.config.public_publishing.enabled && self.config.public_publishing.dynamic_routes_enabled,
    );
    if let (Some(version_repo), Some(settings_repo)) =
      (self.document_version_repo(), self.document_version_settings_repo())
    {
      service = service.with_versioning(
        myoxus_application::document_version::DocumentVersionAutoTriggerService::new(
          Arc::new(self.doc().clone()),
          version_repo.clone(),
          settings_repo,
        ),
        version_repo,
      );
    }
    service
  }

  pub fn manager_capability_writer(&self) -> Arc<dyn ManagerCapabilityWriter> {
    self.services.manager_capability_writer.clone()
  }

  pub fn setup_state(&self) -> &SetupStateService {
    &self.services.setup_state_service
  }

  pub fn branding_assets(&self) -> Arc<dyn BrandingAssetRepository> {
    self.services.branding_asset_repository.clone()
  }

  pub fn pdf_export_jobs(&self) -> Arc<dyn PdfExportJobStore> {
    self.services.pdf_export_job_store.clone()
  }

  pub fn document_audit_projection(&self) -> Arc<dyn DocumentAuditProjectionStore> {
    self.services.document_audit_projection_store.clone()
  }

  pub fn with_config_overrides(mut self, overrides: ConfigOverrides) -> Self {
    self.config_overrides = Arc::new(tokio::sync::RwLock::new(overrides));
    self
  }

  pub fn with_config_overrides_handle(mut self, overrides: Arc<tokio::sync::RwLock<ConfigOverrides>>) -> Self {
    self.config_overrides = overrides;
    self
  }

  pub fn with_config_file_baseline(mut self, config: AppConfig) -> Self {
    self.config_file_baseline = Arc::new(config);
    self
  }

  /// Refreshes the one live override snapshot after a local write or Redis
  /// wake-up. Restart-bound worker settings deliberately remain unchanged.
  pub async fn refresh_config_overrides(&self) -> Result<(), myoxus_infrastructure::app_config::AppConfigLoadError> {
    let Some(pool) = self.metrics_pool() else {
      return Ok(());
    };
    crate::config_reload::refresh_config_overrides(
      &pool,
      &self.config_file_baseline,
      &self.config_overrides,
      Some(self.transcription_runtime.as_ref()),
      self.logging().map(Arc::as_ref),
      Some(self.metrics()),
    )
    .await?;
    Ok(())
  }

  pub fn client_update_runtime(&self) -> Option<Arc<ClientUpdateRuntime>> {
    self.runtime.client_update_runtime.clone()
  }

  /// P104-C: TTL atomics and hit/miss counters for Redis doc-caches.
  /// `None` when no cache Redis adapter is configured (dev/test without Redis).
  pub fn doc_cache_tuning(&self) -> Option<&DocCacheTuningHandles> {
    self.runtime.doc_cache_tuning.as_ref()
  }

  pub fn with_redis_queue(mut self, queue: myoxus_worker::RedisQueue) -> Self {
    self.runtime.redis_queue = Some(queue);
    self
  }

  pub fn redis_queue(&self) -> Option<myoxus_worker::RedisQueue> {
    self.runtime.redis_queue.clone()
  }

  pub fn with_calendar_service(mut self, calendar_service: Arc<CalendarService>) -> Self {
    self.services.calendar_service = Some(calendar_service);
    self
  }

  pub fn with_native_event_service(mut self, svc: Arc<NativeEventService>) -> Self {
    self.services.native_event_service = Some(svc);
    self
  }

  pub fn native_event_service(&self) -> Option<Arc<NativeEventService>> {
    self.services.native_event_service.clone()
  }

  /// Serve only the exact immutable source set admitted before startup.
  pub fn with_feature_sources(
    mut self,
    sources: Arc<myoxus_infrastructure::feature_bundles::CapturedFeatureSourceSet>,
  ) -> Self {
    self.services.feature_sources = Some(sources);
    self
  }

  pub fn feature_sources(&self) -> Option<&myoxus_infrastructure::feature_bundles::CapturedFeatureSourceSet> {
    self.services.feature_sources.as_deref()
  }

  /// Inject the same captured catalog used by the production mail adapter.
  pub fn with_html_catalog(mut self, catalog: Arc<dyn myoxus_public_render::HtmlRendererProvider>) -> Self {
    self.services.html_catalog = Some(catalog);
    self
  }

  pub fn html_catalog(&self) -> Option<Arc<dyn myoxus_public_render::HtmlRendererProvider>> {
    self.services.html_catalog.clone()
  }

  pub fn html_renderer(&self) -> Result<&myoxus_public_render::HtmlRenderer, String> {
    self
      .services
      .html_catalog
      .as_ref()
      .ok_or("HTML catalog is not configured")?
      .renderer()
  }

  pub fn with_mail_template_renderer(
    mut self,
    renderer: Arc<myoxus_infrastructure::mail::MailTemplateRenderer>,
  ) -> Self {
    self.services.mail_template_renderer = Some(renderer);
    self
  }

  pub fn with_template_registry_service(mut self, service: TemplateRegistryService) -> Self {
    // Also wire into WorkspaceService so create_workspace auto-seeds (P125-TPL-S-03).
    self.services.workspace_service.set_template_registry(service.clone());
    self.services.template_registry_service = Some(service);
    self
  }

  pub fn template_registry(&self) -> Option<&TemplateRegistryService> {
    self.services.template_registry_service.as_ref()
  }

  pub fn with_assistant_packages(
    mut self,
    service: Arc<myoxus_application::workspace::assistant_packages::AssistantPackageService>,
  ) -> Self {
    self.services.assistant_packages = Some(service);
    self
  }
  pub fn assistant_packages(
    &self,
  ) -> Option<Arc<myoxus_application::workspace::assistant_packages::AssistantPackageService>> {
    self.services.assistant_packages.clone()
  }

  pub fn with_database_services(mut self, services: Arc<DatabaseServices>) -> Self {
    self.services.database_services = Some(services);
    self
  }

  pub fn database_services(&self) -> Option<Arc<DatabaseServices>> {
    self.services.database_services.clone()
  }

  pub fn with_task_recurrence_service(
    mut self,
    service: Arc<myoxus_application::recurrence::TaskRecurrenceService>,
  ) -> Self {
    self.services.task_recurrence_service = Some(service);
    self
  }

  pub fn task_recurrence_service(&self) -> Option<Arc<myoxus_application::recurrence::TaskRecurrenceService>> {
    self.services.task_recurrence_service.clone()
  }

  pub fn with_workspace_import_service(mut self, service: Arc<WorkspaceImportService>) -> Self {
    self.services.workspace_import_service = Some(service);
    self
  }

  pub fn workspace_import_service(&self) -> Option<Arc<WorkspaceImportService>> {
    self.services.workspace_import_service.clone()
  }

  pub fn with_workspace_export_service(mut self, service: Arc<ObsidianVaultExportService>) -> Self {
    self.services.workspace_export_service = Some(service);
    self
  }

  pub fn workspace_export_service(&self) -> Option<Arc<ObsidianVaultExportService>> {
    self.services.workspace_export_service.clone()
  }

  pub fn with_workspace_tag_service(mut self, service: Arc<WorkspaceTagService>) -> Self {
    self.services.workspace_tag_service = Some(service);
    self
  }

  pub fn workspace_tag_service(&self) -> Option<Arc<WorkspaceTagService>> {
    self.services.workspace_tag_service.clone()
  }

  pub fn with_workspace_automation_service(mut self, service: Arc<WorkspaceAutomationService>) -> Self {
    self.services.workspace_service = self.services.workspace_service.clone().with_automation(service.clone());
    self.services.workspace_automation_service = Some(service);
    self
  }

  pub fn workspace_automation_service(&self) -> Option<Arc<WorkspaceAutomationService>> {
    self.services.workspace_automation_service.clone()
  }

  pub fn with_document_graph_service(mut self, service: Arc<DocumentGraphService>) -> Self {
    self.services.document_graph_service = Some(service);
    self
  }

  pub fn document_graph_service(&self) -> Option<Arc<DocumentGraphService>> {
    self.services.document_graph_service.clone()
  }

  /// P-PDF-TPL-COLOR-01: wire the ICC profile repository.
  pub fn with_pdf_icc_repo(mut self, repo: Arc<dyn myoxus_domain::repositories::PdfIccProfileRepository>) -> Self {
    self.services.pdf_icc_repo = Some(repo);
    self
  }

  /// P-PDF-TPL-FONT-01: wire the font library repository.
  pub fn with_pdf_font_repo(mut self, repo: Arc<dyn myoxus_domain::repositories::PdfFontRepository>) -> Self {
    self.services.pdf_font_repo = Some(repo);
    self
  }

  /// P-PDF-TPL-COLOR-01: wire the PDF blob store.
  pub fn with_pdf_blob_store(mut self, store: Arc<myoxus_infrastructure::pdf_export::PdfBlobStore>) -> Self {
    self.services.pdf_blob_store = Some(store);
    self
  }

  pub fn pdf_icc_repo(&self) -> Option<Arc<dyn myoxus_domain::repositories::PdfIccProfileRepository>> {
    self.services.pdf_icc_repo.clone()
  }

  pub fn pdf_font_repo(&self) -> Option<Arc<dyn myoxus_domain::repositories::PdfFontRepository>> {
    self.services.pdf_font_repo.clone()
  }

  pub fn pdf_blob_store(&self) -> Option<Arc<myoxus_infrastructure::pdf_export::PdfBlobStore>> {
    self.services.pdf_blob_store.clone()
  }

  /// P-PDF-TPL-08: wire the template registry repository.
  pub fn with_pdf_template_repo(mut self, repo: Arc<dyn myoxus_domain::repositories::PdfTemplateRepository>) -> Self {
    self.services.pdf_template_repo = Some(repo);
    self
  }

  /// P-PDF-TPL-09: wire the workspace ↔ template assignments repository.
  pub fn with_pdf_assignment_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::PdfWorkspaceTemplateAssignmentRepository>,
  ) -> Self {
    self.services.pdf_assignment_repo = Some(repo);
    self
  }

  /// P-PDF-TPL-09: wire the workspace brand asset repository.
  pub fn with_pdf_brand_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::PdfWorkspaceBrandAssetRepository>,
  ) -> Self {
    self.services.pdf_brand_repo = Some(repo);
    self
  }

  pub fn pdf_template_repo(&self) -> Option<Arc<dyn myoxus_domain::repositories::PdfTemplateRepository>> {
    self.services.pdf_template_repo.clone()
  }

  pub fn pdf_assignment_repo(
    &self,
  ) -> Option<Arc<dyn myoxus_domain::repositories::PdfWorkspaceTemplateAssignmentRepository>> {
    self.services.pdf_assignment_repo.clone()
  }

  pub fn pdf_brand_repo(&self) -> Option<Arc<dyn myoxus_domain::repositories::PdfWorkspaceBrandAssetRepository>> {
    self.services.pdf_brand_repo.clone()
  }

  pub fn with_pdf_render_audit_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::PdfExportRenderAuditRepository>,
  ) -> Self {
    self.services.pdf_render_audit_repo = Some(repo);
    self
  }

  pub fn pdf_render_audit_repo(&self) -> Option<Arc<dyn myoxus_domain::repositories::PdfExportRenderAuditRepository>> {
    self.services.pdf_render_audit_repo.clone()
  }

  // ── Organization repositories (delivery packages B/C/D infrastructure) ───────────────────────
  pub fn with_organization_template_context_service(
    mut self,
    service: Arc<myoxus_application::organization::OrganizationTemplateContextService>,
  ) -> Self {
    self.services.organization_template_context_service = Some(service);
    self
  }

  pub fn organization_template_context_service(
    &self,
  ) -> Option<Arc<myoxus_application::organization::OrganizationTemplateContextService>> {
    self.services.organization_template_context_service.clone()
  }

  // Convenience builder and accessors. Production wiring installs all seven repositories;
  // server wiring and the corresponding service methods live in `server.rs`.

  pub fn with_organization_repo(mut self, repo: Arc<dyn myoxus_domain::repositories::OrganizationRepository>) -> Self {
    self.services.organization_repo = Some(repo);
    self
  }
  pub fn organization_repo(&self) -> Option<Arc<dyn myoxus_domain::repositories::OrganizationRepository>> {
    self.services.organization_repo.clone()
  }

  pub fn with_organization_unit_type_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitTypeRepository>,
  ) -> Self {
    self.services.organization_unit_type_repo = Some(repo);
    self
  }
  pub fn organization_unit_type_repo(
    &self,
  ) -> Option<Arc<dyn myoxus_domain::repositories::OrganizationUnitTypeRepository>> {
    self.services.organization_unit_type_repo.clone()
  }

  pub fn with_organization_unit_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitRepository>,
  ) -> Self {
    self.services.organization_unit_repo = Some(repo);
    self
  }
  pub fn organization_unit_repo(&self) -> Option<Arc<dyn myoxus_domain::repositories::OrganizationUnitRepository>> {
    self.services.organization_unit_repo.clone()
  }

  pub fn with_organization_unit_member_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitMemberRepository>,
  ) -> Self {
    self.services.organization_unit_member_repo = Some(repo);
    self
  }
  pub fn organization_unit_member_repo(
    &self,
  ) -> Option<Arc<dyn myoxus_domain::repositories::OrganizationUnitMemberRepository>> {
    self.services.organization_unit_member_repo.clone()
  }

  pub fn with_organization_unit_workspace_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitWorkspaceRepository>,
  ) -> Self {
    self.services.organization_unit_workspace_repo = Some(repo);
    self
  }
  pub fn organization_unit_workspace_repo(
    &self,
  ) -> Option<Arc<dyn myoxus_domain::repositories::OrganizationUnitWorkspaceRepository>> {
    self.services.organization_unit_workspace_repo.clone()
  }

  pub fn with_organization_policy_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::OrganizationPolicyRepository>,
  ) -> Self {
    self.services.organization_policy_repo = Some(repo);
    self
  }
  pub fn organization_policy_repo(&self) -> Option<Arc<dyn myoxus_domain::repositories::OrganizationPolicyRepository>> {
    self.services.organization_policy_repo.clone()
  }

  pub fn with_organization_project_request_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::OrganizationProjectRequestRepository>,
  ) -> Self {
    self.services.organization_project_request_repo = Some(repo);
    self
  }
  pub fn organization_project_request_repo(
    &self,
  ) -> Option<Arc<dyn myoxus_domain::repositories::OrganizationProjectRequestRepository>> {
    self.services.organization_project_request_repo.clone()
  }

  pub fn with_organization_permission_service(
    mut self,
    svc: Arc<myoxus_application::organization::OrganizationPermissionService>,
  ) -> Self {
    self.services.organization_permission_service = Some(svc.clone());
    // Services such as Database and workspace tags may already hold this Arc.
    // Enrich the shared authority in place so no consumer keeps a stale
    // direct-membership-only permission service.
    if !self.services.permission_service.set_organization_permissions(svc) {
      tracing::warn!("organization permission service was already attached; retaining the first authority");
    }
    self
  }
  pub fn organization_permission_service(
    &self,
  ) -> Option<Arc<myoxus_application::organization::OrganizationPermissionService>> {
    self.services.organization_permission_service.clone()
  }

  pub fn with_organization_project_request_service(
    mut self,
    svc: Arc<myoxus_application::organization::ProjectRequestService>,
  ) -> Self {
    self.services.organization_project_request_service = Some(svc);
    self
  }
  pub fn organization_project_request_service(
    &self,
  ) -> Option<Arc<myoxus_application::organization::ProjectRequestService>> {
    self.services.organization_project_request_service.clone()
  }

  pub fn with_organization_import_export_service(
    mut self,
    svc: Arc<myoxus_application::organization::OrganizationImportExportService>,
  ) -> Self {
    self.services.organization_import_export_service = Some(svc);
    self
  }

  pub fn with_organization_unit_lifecycle_service(
    mut self,
    service: Arc<myoxus_application::organization::OrganizationUnitLifecycleService>,
  ) -> Self {
    self.services.organization_unit_lifecycle_service = Some(service);
    self
  }

  pub fn with_oidc_group_directory(
    mut self,
    directory: Arc<dyn myoxus_application::organization::oidc_directory::OidcGroupDirectoryPort>,
  ) -> Self {
    self.services.oidc_group_directory = Some(directory);
    self
  }

  pub fn oidc_group_directory(
    &self,
  ) -> Option<Arc<dyn myoxus_application::organization::oidc_directory::OidcGroupDirectoryPort>> {
    self.services.oidc_group_directory.clone()
  }

  pub fn organization_memberships(
    self: &Arc<Self>,
  ) -> Option<myoxus_application::organization::OrganizationMembershipService> {
    Some(myoxus_application::organization::OrganizationMembershipService::new(
      Arc::new(myoxus_infrastructure::organization::PgOrganizationMembershipWriter::new(self.metrics_pool()?)),
      Arc::new(crate::organization::MembershipEffectsAdapter(self.clone())),
      self.audit_recorder().clone(),
    ))
  }

  pub fn organization_reads(&self) -> Option<myoxus_application::organization::OrganizationReadService> {
    Some(myoxus_application::organization::OrganizationReadService::new(
      self.organization_repo()?,
      self.organization_unit_type_repo()?,
      self.organization_unit_repo()?,
      self.organization_unit_member_repo()?,
      self.auth().clone(),
    ))
  }

  pub fn organization_unit_lifecycle_service(
    &self,
  ) -> Option<Arc<myoxus_application::organization::OrganizationUnitLifecycleService>> {
    self.services.organization_unit_lifecycle_service.clone()
  }
  pub fn organization_import_export_service(
    &self,
  ) -> Option<Arc<myoxus_application::organization::OrganizationImportExportService>> {
    self.services.organization_import_export_service.clone()
  }

  pub fn with_workspace_content_cluster_coordinator(
    mut self,
    coordinator: Arc<WorkspaceContentClusterCoordinator>,
  ) -> Self {
    self.services.workspace_content_cluster_coordinator = Some(coordinator);
    self
  }

  pub fn workspace_content_cluster_coordinator(&self) -> Option<Arc<WorkspaceContentClusterCoordinator>> {
    self.services.workspace_content_cluster_coordinator.clone()
  }

  pub fn with_workspace_content_control_service(
    mut self,
    service: Arc<myoxus_application::workspace_content_operation::control::WorkspaceContentControlService>,
  ) -> Self {
    self.services.workspace_content_control_service = Some(service);
    self
  }

  pub fn workspace_content_control_service(
    &self,
  ) -> Option<Arc<myoxus_application::workspace_content_operation::control::WorkspaceContentControlService>> {
    self.services.workspace_content_control_service.clone()
  }

  pub fn with_workspace_content_redirect_service(
    mut self,
    service: Arc<myoxus_application::workspace_content_operation::redirect::WorkspaceContentRedirectService>,
  ) -> Self {
    self.services.workspace_content_redirect_service = Some(service);
    self
  }

  pub fn workspace_content_redirect_service(
    &self,
  ) -> Option<Arc<myoxus_application::workspace_content_operation::redirect::WorkspaceContentRedirectService>> {
    self.services.workspace_content_redirect_service.clone()
  }

  /// P-DOC-VER-02: wire named document-version rows.
  pub fn with_document_version_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::DocumentVersionRepository>,
  ) -> Self {
    self.services.document_version_repo = Some(repo);
    self
  }

  /// P-DOC-VER-02: wire per-document versioning settings.
  pub fn with_document_version_settings_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::DocumentVersioningSettingsRepository>,
  ) -> Self {
    self.services.document_version_settings_repo = Some(repo);
    self
  }

  pub fn document_version_repo(&self) -> Option<Arc<dyn myoxus_domain::repositories::DocumentVersionRepository>> {
    self.services.document_version_repo.clone()
  }

  pub fn document_version_settings_repo(
    &self,
  ) -> Option<Arc<dyn myoxus_domain::repositories::DocumentVersioningSettingsRepository>> {
    self.services.document_version_settings_repo.clone()
  }

  pub fn with_document_metadata_policy_repo(
    mut self,
    repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataPolicyRepository>,
  ) -> Self {
    self.services.document_metadata_policy_repo = Some(repo);
    self
  }

  pub fn document_metadata_policy_repo(
    &self,
  ) -> Option<Arc<dyn myoxus_domain::repositories::DocumentMetadataPolicyRepository>> {
    self.services.document_metadata_policy_repo.clone()
  }

  pub fn with_document_metadata_policy_service(
    mut self,
    service: myoxus_application::document_metadata_policy::DocumentMetadataPolicyService,
  ) -> Self {
    self.services.document_metadata_policy_service = Some(service);
    self
  }

  pub fn document_metadata_policy_service(
    &self,
  ) -> Option<myoxus_application::document_metadata_policy::DocumentMetadataPolicyService> {
    self.services.document_metadata_policy_service.clone()
  }

  pub fn with_document_metadata_service(
    mut self,
    service: myoxus_application::document_metadata::DocumentMetadataService,
  ) -> Self {
    self.services.document_metadata_service = Some(service);
    self
  }

  pub fn document_metadata_service(&self) -> Option<myoxus_application::document_metadata::DocumentMetadataService> {
    self.services.document_metadata_service.clone()
  }

  /// Built from existing service owners and live formatting defaults. Callers
  /// must authorize their exact document before resolving its field context.
  pub async fn document_field_resolver(
    &self,
  ) -> Option<myoxus_application::document_fields::context::DocumentFieldResolver> {
    Some(
      myoxus_application::document_fields::context::DocumentFieldResolver::new(
        self.document_metadata_service()?,
        self.document_version_repo()?,
        self.auth().store.clone(),
        self.doc().clone(),
        self.user_preference_defaults().await,
      ),
    )
  }

  /// Replace the no-op audit recorder with a real `PgAuditLogStore`-backed one.
  /// Called at startup after the DB pool is available.
  pub fn with_audit_recorder(mut self, recorder: myoxus_application::audit::AuditRecorder) -> Self {
    self.services.audit_recorder = recorder;
    self
  }

  /// Access the audit recorder for recording admin mutations.
  pub fn audit_recorder(&self) -> &myoxus_application::audit::AuditRecorder {
    &self.services.audit_recorder
  }

  /// P-DB-24: wire the database-specific activity recorder. The recorder is
  /// exposed through the database service so row/cell mutations can record
  /// workspace-visible activity events.
  pub fn with_database_activity_recorder(
    mut self,
    recorder: myoxus_application::database::activity::DatabaseActivityRecorder,
  ) -> Self {
    self.services.database_activity_recorder = Some(recorder);
    self
  }

  /// P-DB-24: return a fresh handle to the database activity recorder, or
  /// `None` if the recorder has not been wired. Used by GraphQL queries that
  /// expose the workspace-visible activity log to UI consumers.
  pub fn database_activity_recorder(&self) -> Option<myoxus_application::database::activity::DatabaseActivityRecorder> {
    self.services.database_activity_recorder.clone()
  }

  pub fn calendar(&self) -> Option<Arc<CalendarService>> {
    self.services.calendar_service.clone()
  }

  pub fn api_key_service(&self) -> &ApiKeyService {
    &self.services.api_key_service
  }

  pub fn with_api_key_service(mut self, service: ApiKeyService) -> Self {
    self.services.api_key_service = service;
    self
  }

  /// LLM provider registry for copilot completions.
  pub fn llm_provider_registry(&self) -> &LlmProviderRegistry {
    &self.services.llm_provider_registry
  }

  /// Replace the LLM provider registry (called during startup wiring).
  pub fn with_llm_provider_registry(mut self, registry: LlmProviderRegistry) -> Self {
    self.services.llm_provider_registry = registry;
    self
  }

  /// Shared HTTP client for outbound requests (proxy endpoints, OAuth, etc.).
  pub fn http_client(&self) -> &reqwest::Client {
    &self.services.http_client
  }

  // -- P84-H-10: throttle.enabled cache (moka try_get_with for stampede protection + graceful degradation)

  /// Read the cached `throttle.enabled` value via moka `try_get_with()` for
  /// stampede protection.  Uses `try_get_with()` (H-18) so DB errors are
  /// never cached.  Falls back to the YAML config value on any error.
  pub async fn throttle_enabled_cached(&self) -> bool {
    let config_default = self.config_file_baseline.throttle.enabled;
    let metrics = self.query_cache.metrics_throttle_config.clone();

    // Check if the value is already cached (hit path — no DB query).
    if let Some(val) = self
      .query_cache
      .throttle_config
      .get(&"throttle.enabled".to_string())
      .await
    {
      metrics.record_hit();
      return val;
    }
    metrics.record_miss();

    // Cache miss — use try_get_with() for stampede protection.
    // DB errors propagate as Err and are NOT cached.
    let result: Result<bool, Arc<CacheLoadError>> = self
      .query_cache
      .throttle_config
      .try_get_with("throttle.enabled".to_string(), async {
        tracing::debug!("throttle_config cache MISS — reading effective configuration");
        Ok(
          self
            .effective_config()
            .await
            .bool("throttle.enabled")
            .unwrap_or(config_default),
        )
      })
      .await;

    match result {
      Ok(val) => val,
      Err(e) => {
        tracing::warn!(error = %e, "throttle_config cache load failed — using config default");
        config_default
      }
    }
  }

  /// Replace the stored startup-check results (called by the check task).
  #[instrument(skip(self, checks))]
  pub async fn set_startup_checks(&self, checks: Vec<StartupCheckSnapshot>) {
    *self.runtime.startup_checks.write().await = checks;
  }

  /// Read the latest startup-check results.
  #[instrument(skip(self))]
  pub async fn startup_checks(&self) -> Vec<StartupCheckSnapshot> {
    self.runtime.startup_checks.read().await.clone()
  }

  /// Attach a [`LoggingService`] for runtime-configurable log levels.
  pub fn with_logging(mut self, logging: Arc<LoggingService>) -> Self {
    self.logging = Some(logging);
    self
  }

  /// Access the runtime-configurable logging service, if available.
  pub fn logging(&self) -> Option<&Arc<LoggingService>> {
    self.logging.as_ref()
  }

  /// SC-M-01: Attach a Redis-backed WebSocket state adapter for cross-instance
  /// coordination.
  pub fn with_redis_ws_adapter(mut self, adapter: Arc<RedisWsAdapter>) -> Self {
    self.redis_ws_adapter = Some(adapter);
    self
  }

  /// SC-M-01: Access the role-specific Redis WebSocket adapter, if wired.
  pub fn redis_ws_adapter(&self) -> Option<&Arc<RedisWsAdapter>> {
    self.redis_ws_adapter.as_ref()
  }

  pub fn cache_bus(&self) -> Option<&Arc<CacheInvalidationBus>> {
    self.cache_bus.as_ref()
  }

  /// P84-I: Set the instance UUID (called during startup wiring).
  pub fn with_instance_id(mut self, id: uuid::Uuid) -> Self {
    self.instance_id = id;
    self
  }

  /// P84-I: Attach a cache invalidation bus for cross-instance cache sync.
  pub fn with_cache_bus(mut self, bus: Arc<CacheInvalidationBus>) -> Self {
    self.cache_bus = Some(bus);
    self
  }

  /// P84-I: Publish a cache invalidation to the Redis Pub/Sub bus (if present).
  ///
  /// Call this after invalidating local caches in mutation handlers.  When no
  /// bus is configured (single-instance or no cache Redis adapter), this is a
  /// no-op.
  pub async fn publish_cache_invalidation(&self, cache_name: &str, key: &str) {
    if let Some(bus) = &self.cache_bus {
      bus.publish(cache_name, key).await;
    }
  }

  /// P84-I-II: Attach a Redis cache adapter for three-tier caching.
  pub fn with_cache_redis(mut self, adapter: Arc<dyn RedisPort>) -> Self {
    self.cache_redis = Some(adapter);
    self
  }

  /// P104-C: Attach the DocCache tuning handles so auto-tuning and admin TTL
  /// overrides can update the Redis doc-cache TTLs at runtime.
  pub fn with_doc_cache_tuning(mut self, handles: DocCacheTuningHandles) -> Self {
    self.runtime.doc_cache_tuning = Some(handles);
    self
  }

  // ═══════════════════════════════════════════════════════════════════════
  // P84-I-II: Three-tier cache helpers (moka L1 → Redis L2 → PostgreSQL L3)
  // ═══════════════════════════════════════════════════════════════════════

  // -- I-08: User feature overrides three-tier cache ──────────────────────

  /// Preserve the copilot override's explicit false/absent distinction for
  /// existing boolean consumers; all flags share the same cache population.
  pub async fn user_feature_overrides_cached_l2(&self, user_id: uuid::Uuid) -> Option<bool> {
    self
      .user_feature_flags_cached_l2(user_id)
      .await
      .as_deref()
      .and_then(feature_override_result)
  }

  /// Return persisted feature flags via the existing three-tier cache.
  /// Flow: moka L1 → Redis L2 → DB L3.
  ///
  /// Retains the copilot-disable sentinel and cache projection marker; callers
  /// expose only supported flags. None denotes a failed load.
  pub async fn user_feature_flags_cached_l2(&self, user_id: uuid::Uuid) -> Option<Vec<String>> {
    let metrics = &self.query_cache.metrics_user_features;
    for _ in 0..3 {
      let cache_key = self.query_cache.user_features_key(user_id);
      if let Some(features) = self.query_cache.user_features.get(&cache_key).await {
        metrics.record_hit();
        return Some(features);
      }
      metrics.record_miss();

      let redis = self.cache_redis.clone();
      let auth = self.auth().clone();
      let query_cache = self.query_cache.clone();
      let ttl = self.config.cache.user_features_redis_ttl_seconds;
      let result: Result<Vec<String>, Arc<CacheLoadError>> = self
        .query_cache
        .user_features
        .try_get_with(cache_key, async move {
          query_cache.record_user_feature_population_load();
          let redis_key = format!("cache:features:{user_id}");
          let features = if let Some(redis) = &redis {
            match redis.get_string(&redis_key).await {
              Ok(Some(value)) => match serde_json::from_str::<Vec<String>>(&value) {
                Ok(features) if features.iter().any(|flag| flag == MANAGER_PROJECTION_MARKER) => features,
                Ok(_) => load_user_feature_override(&auth, user_id).await?,
                Err(error) => {
                  tracing::warn!(user_id = %user_id, %error, "user_features L2 deserialization failed");
                  load_user_feature_override(&auth, user_id).await?
                }
              },
              Ok(None) => load_user_feature_override(&auth, user_id).await?,
              Err(error) => {
                tracing::warn!(user_id = %user_id, %error, "user_features L2 Redis error — using DB");
                load_user_feature_override(&auth, user_id).await?
              }
            }
          } else {
            load_user_feature_override(&auth, user_id).await?
          };

          let global_guard = query_cache.user_features_global_fill_guard();
          let _global_guard = global_guard.read().await;
          let guard = query_cache.user_features_fill_guard(user_id);
          let _guard = guard.lock().await;
          if query_cache.user_features_key(user_id) != cache_key {
            return Err(CacheLoadError(
              "user feature cache invalidated while loading".to_string(),
            ));
          }
          if let Some(redis) = &redis
            && let Ok(json) = serde_json::to_string(&features)
            && let Err(error) = redis.set_string(&redis_key, &json, Some(ttl)).await
          {
            tracing::warn!(user_id = %user_id, %error, "user_features L2 Redis SET failed");
          }
          Ok(features)
        })
        .await;

      match result {
        Ok(features) if self.query_cache.user_features_key(user_id) == cache_key => {
          return Some(features);
        }
        Ok(_) => continue,
        Err(error) if error.0 == "user feature cache invalidated while loading" => continue,
        Err(error) => {
          tracing::warn!(user_id = %user_id, %error, "user_features cache load failed");
          return None;
        }
      }
    }
    None
  }

  /// I-08: Invalidate the user feature cache across all tiers.
  pub async fn invalidate_user_feature_cache_l2(&self, user_id: uuid::Uuid) {
    let guard = self.query_cache.user_features_fill_guard(user_id);
    let _guard = guard.lock().await;
    self.query_cache.invalidate_user_features(user_id).await;
    self.query_cache.metrics_user_features.record_invalidation_local();
    if let Some(redis) = &self.cache_redis {
      let redis_key = format!("cache:features:{user_id}");
      if let Err(e) = redis.delete_key(&redis_key).await {
        tracing::warn!(user_id = %user_id, error = %e, "user_features L2 Redis DEL failed");
      }
    }
    self
      .publish_cache_invalidation("user_features", &user_id.to_string())
      .await;
  }

  // -- I-09: Workspace settings three-tier cache ──────────────────────────

  /// I-09: Return cached workspace settings via three-tier caching.
  /// Flow: moka L1 → Redis L2 → DB L3.
  ///
  /// Returns `None` on errors (graceful degradation).
  pub async fn workspace_settings_cached(
    &self,
    workspace_id: uuid::Uuid,
  ) -> Option<crate::cache::WorkspaceSettingsCached> {
    let metrics = &self.query_cache.metrics_ws_settings;

    for _ in 0..3 {
      let cache_key = self.query_cache.ws_settings_key(workspace_id);
      if let Some(settings) = self.query_cache.ws_settings.get(&cache_key).await {
        metrics.record_hit();
        return Some(settings);
      }
      metrics.record_miss();

      let redis = self.cache_redis.clone();
      let workspace = self.workspace().clone();
      let query_cache = self.query_cache.clone();
      let ttl = self.config.cache.ws_settings_redis_ttl_seconds;
      let result: Result<crate::cache::WorkspaceSettingsCached, Arc<CacheLoadError>> = self
        .query_cache
        .ws_settings
        .try_get_with(cache_key, async move {
          query_cache.record_ws_settings_population_load();
          let redis_key = format!("cache:ws_settings:{workspace_id}");
          let settings = if let Some(redis) = &redis {
            match redis.get_string(&redis_key).await {
              Ok(Some(value)) => match serde_json::from_str::<crate::cache::WorkspaceSettingsCached>(&value) {
                Ok(settings) => settings,
                Err(error) => {
                  tracing::warn!(workspace_id = %workspace_id, %error, "ws_settings L2 deserialization failed");
                  load_workspace_settings(&workspace, workspace_id).await?
                }
              },
              Ok(None) => load_workspace_settings(&workspace, workspace_id).await?,
              Err(error) => {
                tracing::warn!(workspace_id = %workspace_id, %error, "ws_settings L2 Redis error — using DB");
                load_workspace_settings(&workspace, workspace_id).await?
              }
            }
          } else {
            load_workspace_settings(&workspace, workspace_id).await?
          };

          let global_guard = query_cache.ws_settings_global_fill_guard();
          let _global_guard = global_guard.read().await;
          let guard = query_cache.ws_settings_fill_guard(workspace_id);
          let _guard = guard.lock().await;
          if query_cache.ws_settings_key(workspace_id) != cache_key {
            return Err(CacheLoadError(
              "workspace settings cache invalidated while loading".to_string(),
            ));
          }
          if let Some(redis) = &redis
            && let Ok(json) = serde_json::to_string(&settings)
            && let Err(error) = redis.set_string(&redis_key, &json, Some(ttl)).await
          {
            tracing::warn!(workspace_id = %workspace_id, %error, "ws_settings L2 Redis SET failed");
          }
          Ok(settings)
        })
        .await;

      match result {
        Ok(settings) if self.query_cache.ws_settings_key(workspace_id) == cache_key => return Some(settings),
        Ok(_) => continue,
        Err(error) if error.0 == "workspace settings cache invalidated while loading" => continue,
        Err(error) => {
          tracing::warn!(workspace_id = %workspace_id, %error, "ws_settings cache load failed");
          return None;
        }
      }
    }
    None
  }

  /// I-09: Invalidate workspace settings cache across all tiers.
  pub async fn invalidate_ws_settings_cache(&self, workspace_id: uuid::Uuid) {
    let guard = self.query_cache.ws_settings_fill_guard(workspace_id);
    let _guard = guard.lock().await;
    self.query_cache.invalidate_ws_settings(workspace_id).await;
    self.query_cache.metrics_ws_settings.record_invalidation_local();
    if let Some(redis) = &self.cache_redis {
      let redis_key = format!("cache:ws_settings:{workspace_id}");
      if let Err(e) = redis.delete_key(&redis_key).await {
        tracing::warn!(workspace_id = %workspace_id, error = %e, "ws_settings L2 Redis DEL failed");
      }
    }
    self
      .publish_cache_invalidation("ws_settings", &workspace_id.to_string())
      .await;
  }

  // -- P112-QUOTA: Quota cache invalidation ──────────────────────────────

  /// P112-QUOTA: Invalidate the blob/doc quota cache for a workspace.
  ///
  /// Must be called after any mutation that changes the effective quota for a
  /// workspace, currently `adminUpdateWorkspace` when `storageQuotaMb` or
  /// `clearStorageQuota` changes.
  ///
  /// Without invalidation the upload enforcement paths (`SqlxBlobStore`,
  /// `SqlxDocStore`) would continue serving the stale cached value for up to
  /// 5 minutes (the default `QUOTA_TTL_SECONDS`).
  pub async fn invalidate_workspace_quota_cache(&self, workspace_id: uuid::Uuid) {
    let cache = myoxus_infrastructure::quota_cache::QuotaCache::new(self.redis_port(), &self.config.redis.namespace);
    cache.invalidate(workspace_id).await;
    tracing::debug!(
      workspace_id = %workspace_id,
      "workspace quota cache invalidated after quota mutation"
    );
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_application::organization::OrganizationPermissionService;
  use myoxus_infrastructure::organization::{
    PgOrganizationPolicyRepository, PgOrganizationUnitMemberRepository, PgOrganizationUnitRepository,
    PgOrganizationUnitWorkspaceRepository, PgUserFeatureLookup,
  };
  use myoxus_infrastructure::redis::InMemoryRedisAdapter;
  use sqlx::postgres::PgPoolOptions;

  fn config_fixture() -> AppConfig {
    yaml_serde::from_str(
      r#"
server:
  port: 3001
  host: "127.0.0.1"
  origin: "http://localhost:3001"
  session_ttl: 3600
  session_ttr: 3600
database:
  url: "postgres://localhost/test"
redis:
  enabled: false
  url: null
  namespace: "myoxus"
mail:
  sender: "noreply@test.local"
  smtp_port: 587
storage:
  backend: "local"
  root: "./test-storage"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#,
    )
    .expect("config parse")
  }

  #[test]
  fn production_composition_reports_the_complete_sorted_capability_inventory() {
    let state = ApiState::new(config_fixture());
    let error = state
      .validate_production_composition()
      .expect_err("a new in-memory state must not satisfy production composition");

    assert_eq!(
      error.missing_capabilities(),
      [
        "calendar_service",
        "client_update_runtime",
        "copilot_embedding_repo",
        "database_activity_recorder",
        "database_services",
        "document_graph_service",
        "document_metadata_policy_repo",
        "document_metadata_policy_service",
        "document_metadata_service",
        "document_version_repo",
        "document_version_settings_repo",
        "git_token_rotation_service",
        "html_catalog",
        "logging",
        "mail_template_renderer",
        "metrics_pool",
        "native_event_service",
        "organization_import_export_service",
        "organization_permission_service",
        "organization_policy_repo",
        "organization_project_request_repo",
        "organization_project_request_service",
        "organization_repo",
        "organization_template_context_service",
        "organization_unit_lifecycle_service",
        "organization_unit_member_repo",
        "organization_unit_repo",
        "organization_unit_type_repo",
        "organization_unit_workspace_repo",
        "pdf_assignment_repo",
        "pdf_blob_store",
        "pdf_brand_repo",
        "pdf_font_repo",
        "pdf_icc_repo",
        "pdf_render_audit_repo",
        "pdf_template_repo",
        "redis_queue",
        "search_indexer",
        "search_repository",
        "task_recurrence_service",
        "template_registry_service",
        "workspace_automation_service",
        "workspace_content_cluster_coordinator",
        "workspace_content_control_service",
        "workspace_content_redirect_service",
        "workspace_export_service",
        "workspace_import_service",
        "workspace_tag_service",
      ]
    );

    for intentionally_optional in [
      "doc_cache_tuning",
      "redis_ws_adapter",
      "cache_bus",
      "cache_redis",
      "socket_io",
    ] {
      assert!(
        !error.missing_capabilities().contains(&intentionally_optional),
        "{intentionally_optional} must remain outside the production capability inventory"
      );
    }
  }

  #[tokio::test]
  async fn organization_wiring_enriches_the_existing_permission_authority() {
    let state = ApiState::new(config_fixture());
    let original = state.permission_service();
    let pool = PgPoolOptions::new()
      .connect_lazy("postgres://myoxus:myoxus@127.0.0.1/myoxus")
      .expect("valid lazy PostgreSQL URL");
    let organization_permission = Arc::new(OrganizationPermissionService::new(
      Arc::new(PgOrganizationUnitMemberRepository::new(pool.clone())),
      Arc::new(PgOrganizationUnitRepository::new(pool.clone())),
      Arc::new(PgOrganizationUnitWorkspaceRepository::new(pool.clone())),
      Arc::new(PgOrganizationPolicyRepository::new(pool.clone())),
      Arc::new(PgUserFeatureLookup::new(pool)),
    ));

    let state = state.with_organization_permission_service(organization_permission);

    assert!(
      Arc::ptr_eq(&original, &state.permission_service()),
      "already wired workspace services must retain the enriched permission authority"
    );
  }

  #[tokio::test]
  async fn api_state_defaults_to_in_memory_redis_ports() {
    let state = ApiState::new(config_fixture());
    state
      .redis_port()
      .set_string("health", "ok", None)
      .await
      .expect("set redis value");
    assert_eq!(
      state.redis_port().get_string("health").await.expect("get redis value"),
      Some("ok".to_string())
    );
    assert!(state.distributed_lock().acquire("a", 10).await.expect("lock"));
  }

  #[tokio::test]
  async fn api_state_accepts_explicit_redis_port_overrides() {
    let redis = Arc::new(InMemoryRedisAdapter::new("override"));
    let lock = Arc::new(InMemoryRedisAdapter::new("override"));
    let state = ApiState::new(config_fixture())
      .with_redis_port(redis.clone())
      .with_distributed_lock(lock.clone());

    state
      .redis_port()
      .set_string("k", "v", None)
      .await
      .expect("set redis value");
    assert_eq!(
      state.redis_port().get_string("k").await.expect("get redis value"),
      Some("v".to_string())
    );
    assert!(state.distributed_lock().acquire("key", 10).await.expect("acquire"));
    assert!(
      !state
        .distributed_lock()
        .acquire("key", 10)
        .await
        .expect("second acquire")
    );
  }

  #[tokio::test]
  async fn removing_a_live_override_reveals_the_file_baseline() {
    let mut startup_config = config_fixture();
    startup_config.mcp.enabled = true;
    let mut file_baseline = startup_config.clone();
    file_baseline.mcp.enabled = false;
    let state = ApiState::new(startup_config).with_config_file_baseline(file_baseline);

    assert_eq!(
      state.effective_config().await.bool("mcp.enabled"),
      Some(false),
      "an absent live override must not resurrect the value materialized at startup"
    );
  }

  #[tokio::test]
  async fn three_tier_ws_settings_cache_uses_redis_l2() {
    use crate::cache::WorkspaceSettingsCached;
    let redis = Arc::new(InMemoryRedisAdapter::new("cache"));
    let state = ApiState::new(config_fixture()).with_cache_redis(redis.clone());

    let ws_id = uuid::Uuid::parse_str("00000000-0000-0000-0000-000000000003").unwrap();
    let settings = WorkspaceSettingsCached {
      enable_ai: true,
      enable_sharing: false,
      enable_url_preview: true,
      enable_doc_embedding: false,
    };

    // Pre-populate Redis L2.
    let json = serde_json::to_string(&settings).unwrap();
    redis
      .set_string(&format!("cache:ws_settings:{ws_id}"), &json, Some(300))
      .await
      .expect("seed L2");

    // L1 is empty, L2 has value → should return the settings.
    let result = state.workspace_settings_cached(ws_id).await;
    assert_eq!(result, Some(settings.clone()));

    // After L2 hit, L1 should be populated.
    assert_eq!(
      state
        .query_cache
        .ws_settings
        .get(&state.query_cache.ws_settings_key(ws_id))
        .await,
      Some(settings)
    );
  }

  #[tokio::test]
  async fn three_tier_user_features_cache_uses_redis_l2() {
    let redis = Arc::new(InMemoryRedisAdapter::new("cache"));
    let state = ApiState::new(config_fixture()).with_cache_redis(redis.clone());

    let user_id = uuid::Uuid::parse_str("00000000-0000-0000-0000-000000000004").unwrap();

    // Pre-populate Redis L2 with feature list.
    let features = vec!["unlimited_copilot".to_string(), MANAGER_PROJECTION_MARKER.to_string()];
    let json = serde_json::to_string(&features).unwrap();
    redis
      .set_string(&format!("cache:features:{user_id}"), &json, Some(300))
      .await
      .expect("seed L2");

    // L2 is independent from the concrete persistence adapter and backfills L1.
    let result = state.user_feature_flags_cached_l2(user_id).await;
    assert_eq!(result, Some(features.clone()));
    assert_eq!(
      state
        .query_cache
        .user_features
        .get(&state.query_cache.user_features_key(user_id))
        .await,
      Some(features)
    );
  }
}
