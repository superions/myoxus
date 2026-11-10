//! Myoxus API crate — Axum HTTP layer and GraphQL schema.
//!
//! This crate assembles the complete Axum [`Router`], GraphQL schema
//! (async-graphql), REST blob/storage routes, health/metrics endpoints,
//! socketioxide real-time layer, and the background `WorkerRuntime`.
//! The sub-modules are: [`auth`] (session & OAuth routes), [`graphql`]
//! (schema resolvers), [`websocket`] (storage Socket.IO handlers), [`state`]
//! (shared `ApiState`), [`config`] (config loading), and supporting utilities.

pub mod admin_queue;
pub mod admin_runtime_status;
pub mod auth;
pub mod cache;
pub mod cache_bus;
pub mod cache_tuning;
pub mod client_context;
pub mod client_update_runtime;
pub mod comment_notification;
pub mod config;
pub mod config_reload;
pub mod copilot_context_parser;
pub(crate) mod document_access;
pub mod document_broadcast_outbox;
pub mod document_graph_worker;
pub mod work_queue;

pub use cache::{CacheMetricsSnapshot, QueryCache};
pub mod database_reminder_notification;
pub mod database_task_notification;
pub mod database_worker;
pub mod error;
pub mod git_sync_engine;
pub mod graphql;
pub mod handlers;
pub mod logging;
pub mod metrics_worker;
pub mod organization;
pub mod pdf_export_adapter;
pub mod pdf_export_cleanup;
pub mod preview;
pub mod request_id;
pub mod search;
pub mod startup_checks;
pub mod state;
pub mod telemetry_worker;
pub mod transcription_runtime;
pub mod websocket;
pub mod workspace_automation_worker;
pub mod workspace_content_coordination;
pub mod workspace_content_worker;
pub mod workspace_import;

use std::sync::{Arc, OnceLock};

use async_graphql::{BatchResponse, EmptySubscription, Schema, http::GraphQLPlaygroundConfig, http::playground_source};

/// Type alias for the compiled GraphQL schema.
type ApiSchema = Schema<crate::graphql::ApiQueryRoot, crate::graphql::ApiMutationRoot, EmptySubscription>;

/// Global singleton: schema is stateless (state is injected per-request via `.data()`),
/// so it is safe and correct to build it exactly once at first use.
static GRAPHQL_SCHEMA: OnceLock<ApiSchema> = OnceLock::new();

fn get_or_init_schema() -> &'static ApiSchema {
  GRAPHQL_SCHEMA.get_or_init(|| {
    Schema::build(
      crate::graphql::ApiQueryRoot,
      crate::graphql::ApiMutationRoot,
      EmptySubscription,
    )
    .limit_depth(32) // Prevent deeply nested query attacks (P84-C)
    .limit_complexity(2000) // Prevent wide queries resolving thousands of fields (P84-C)
    // CVE-2024-47614: depth/complexity do not bound directives on one field.
    // Both standard executable field directives (@skip and @include) remain valid.
    .limit_directives(2)
    .finish()
  })
}

/// Export the production GraphQL contract without configuration or backing services.
pub fn export_graphql_schema() -> String {
  get_or_init_schema().sdl()
}

#[cfg(test)]
mod graphql_admission_tests {
  use super::get_or_init_schema;
  use async_graphql::{Request, Variables};

  #[tokio::test]
  async fn standard_conditional_directives_preserve_client_behavior() {
    let request = Request::new(
      "query Conditional($skip: Boolean!, $include: Boolean!) { __schema { \
       visible: queryType @skip(if: $skip) @include(if: $include) { name } \
       hidden: queryType @skip(if: true) { name } } }",
    )
    .variables(Variables::from_json(
      serde_json::json!({"skip": false, "include": true}),
    ));
    let response = get_or_init_schema().execute(request).await;
    assert!(response.errors.is_empty(), "{:?}", response.errors);
    let data = response.data.into_json().expect("JSON response");
    assert_eq!(data["__schema"]["visible"]["name"], "ApiQueryRoot");
    assert!(data["__schema"].get("hidden").is_none());
  }

  #[tokio::test]
  async fn directive_overload_is_rejected_by_admission_before_validation() {
    // Require the admission error, not merely duplicate-directive validation:
    // removing limit_directives must make this regression test fail.
    let overloaded = format!("__typename {}", "@skip(if: false) ".repeat(64));
    for query in [
      format!("{{ {overloaded} }}"),
      format!("{{ ... on ApiQueryRoot {{ {overloaded} }} }}"),
      format!("{{ ...Overload }} fragment Overload on ApiQueryRoot {{ {overloaded} }}"),
      format!("mutation {{ {overloaded} }}"),
    ] {
      let response = get_or_init_schema().execute(query).await;
      assert_eq!(response.errors.len(), 1, "{:?}", response.errors);
      assert!(
        response.errors[0].message.contains("number of directives"),
        "unexpected rejection: {:?}",
        response.errors
      );
      assert!(response.data.into_json().expect("JSON response").is_null());
    }
  }
}

use axum::{
  Router,
  body::Bytes,
  extract::{DefaultBodyLimit, State},
  http::{HeaderMap, HeaderValue, Method, StatusCode},
  middleware,
  response::IntoResponse,
  routing::{get, post, put},
};
use futures_util::io::Cursor;
use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_domain::permission::WorkspaceAction;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

use crate::state::ApiState;

/// Runtime behavior for router-owned background services.
///
/// The production default intentionally starts every background loop. Integration
/// tests use `build_router_for_integration_tests()` so repeated in-process router
/// construction does not keep stale `ApiState`/PgPool instances alive after a
/// test completes. HTTP routes and Socket.IO handlers remain mounted in both
/// modes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RouterRuntimeOptions {
  pub spawn_websocket_background_tasks: bool,
  pub spawn_client_update_listener: bool,
  pub retain_socket_io_handle: bool,
}

impl Default for RouterRuntimeOptions {
  fn default() -> Self {
    Self {
      spawn_websocket_background_tasks: true,
      spawn_client_update_listener: true,
      retain_socket_io_handle: true,
    }
  }
}

// Re-export handler functions for the router.
use handlers::blob::{
  blob_upload_part_handler, comment_attachment_handler, download_blob_handler, storage_multipart_part_handler,
  storage_upload_handler,
};
use handlers::branding::{
  branding_app_server_handler, branding_favicon_32_png_handler, branding_favicon_36_png_handler,
  branding_favicon_48_png_handler, branding_favicon_72_png_handler, branding_favicon_96_png_handler,
  branding_favicon_144_png_handler, branding_favicon_192_png_handler, branding_favicon_handler,
  branding_style_asset_handler, branding_theme_css_handler, branding_upload_handler,
};
use handlers::calendar::{
  calendar_google_webhook_handler, calendar_rsvp_handler, create_calendar_event_handler, delete_calendar_event_handler,
  list_calendar_events_handler, update_calendar_event_handler, update_calendar_reminder_status_handler,
};
use handlers::captcha_admin::captcha_status;
use handlers::config::{check_production_readiness, export_config, import_config};
use handlers::copilot::{copilot_blob_handler, copilot_chat_sse_handler, copilot_unsplash_photos_handler};
use handlers::docx::{export_docx_handler, import_docx_handler};
use handlers::fonts::{fonts_file_handler, fonts_list_handler};
use handlers::git_sync::git_sync_webhook_handler;
use handlers::health::{health, info_handler, live, ready};
use handlers::logs::{download_handler as logs_download_handler, tail_handler as logs_tail_handler};
use handlers::metrics::{metrics, metrics_prometheus};
use handlers::middleware::{logger_middleware, throttle_middleware};
use handlers::misc::{
  current_user_alias, i18n_config_get_handler, i18n_config_put_handler, mcp_handler, mcp_method_not_allowed,
  telemetry_collect_handler, telemetry_status_handler, worker_image_proxy_handler, worker_link_preview_handler,
  worker_questionnaire_get_handler, worker_questionnaire_post_handler,
};
use handlers::pdf_export::{
  pdf_export_admin_jobs_events_handler, pdf_export_download_handler, pdf_export_job_events_handler,
};
use handlers::public::{
  legacy_share_redirect_handler, public_asset_handler, public_document_handler, public_workspace_handler,
};
use handlers::rpc::{
  rpc_get_doc_content_handler, rpc_get_doc_diff_handler, rpc_get_doc_handler, rpc_get_doc_markdown_handler,
  rpc_get_workspace_content_handler,
};
use handlers::search::search_docs_handler;
use handlers::template_export::{
  MAX_WORKSPACE_SOURCE_EXPORT_REQUEST_BYTES, template_export_handler, workspace_template_source_export_handler,
};
use handlers::workspace_doc::{
  workspace_doc_handler, workspace_doc_history_by_id_handler, workspace_doc_history_handler,
  workspace_doc_preview_handler, workspace_renderer_handler, workspace_renderer_root_handler,
};
use handlers::workspace_export::obsidian_vault_export_handler;
use handlers::workspace_import::workspace_import_part_upload_handler;
use myoxus_application::{
  mcp::{InMemoryMcpIdempotencyRepository, UnavailableMcpDocumentOperations},
  template_registry::suggestions::TemplateSuggestionService,
};
use myoxus_mcp::{
  mcp_router,
  router::{McpAvailability, McpState},
  subscriptions::SubscriptionHub,
  tools::{McpToolState, McpUploadPolicy},
};

/// Adapts the canonical live configuration snapshot to the MCP feature gate.
struct LiveMcpAvailability {
  baseline_default: bool,
  overrides: Arc<tokio::sync::RwLock<crate::config_reload::ConfigOverrides>>,
}

#[async_trait::async_trait]
impl McpAvailability for LiveMcpAvailability {
  async fn enabled(&self) -> bool {
    self
      .overrides
      .read()
      .await
      .overrides
      .get("mcp.enabled")
      .and_then(serde_json::Value::as_bool)
      .unwrap_or(self.baseline_default)
  }
}

struct RequiredMcpCapabilities {
  document_services: Arc<dyn myoxus_application::mcp::McpDocumentOperations>,
  idempotency: Arc<dyn myoxus_application::mcp::McpIdempotencyRepository>,
}

fn production_mcp_capabilities(state: &ApiState) -> RequiredMcpCapabilities {
  let document_services = Arc::new(
    myoxus_application::mcp::ApplicationMcpDocumentOperations::new(
      state
        .document_metadata_service()
        .expect("MCP router requires the canonical document metadata service"),
      state
        .document_metadata_policy_repo()
        .expect("MCP router requires the canonical document metadata policy repository"),
      state
        .document_version_repo()
        .expect("MCP router requires the canonical document version repository"),
      Arc::new(state.doc().clone()),
    )
    .with_field_context_source(Arc::new(state.clone())),
  );
  let pool = state
    .metrics_pool()
    .expect("MCP router requires PostgreSQL idempotency storage");
  let idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool));

  RequiredMcpCapabilities {
    document_services,
    idempotency,
  }
}

fn reduced_integration_mcp_capabilities() -> RequiredMcpCapabilities {
  RequiredMcpCapabilities {
    document_services: Arc::new(UnavailableMcpDocumentOperations),
    idempotency: Arc::new(InMemoryMcpIdempotencyRepository::default()),
  }
}

/// Construct the complete Axum [`Router`] from the given application state.
///
/// Mounts GraphQL, REST blob/storage, health, metrics, MCP, and
/// Socket.IO routes.
pub fn build_router(state: ApiState) -> Result<Router, state::ProductionCompositionError> {
  state.validate_production_composition()?;
  let mcp_capabilities = production_mcp_capabilities(&state);
  Ok(build_router_with_options(
    state,
    RouterRuntimeOptions::default(),
    mcp_capabilities,
  ))
}

/// Construct the full router for integration tests without long-lived loops.
///
/// This is deliberately not `#[cfg(test)]`: Rust integration tests compile this
/// crate as a normal dependency, so they need a public helper. The route surface
/// stays identical to `build_router()`; only router-owned background loops that
/// outlive an individual test are suppressed.
pub fn build_router_for_integration_tests(state: ApiState) -> Router {
  build_router_with_options(
    state,
    RouterRuntimeOptions {
      spawn_websocket_background_tasks: false,
      spawn_client_update_listener: false,
      retain_socket_io_handle: false,
    },
    reduced_integration_mcp_capabilities(),
  )
}

/// Exercise production MCP capability composition without process-long router
/// tasks. The supplied fixture must include the normal metadata/version owners
/// and PostgreSQL pool; reduced fixtures keep their existing separate helper.
pub fn build_router_for_mcp_integration_tests(state: ApiState) -> Router {
  let capabilities = production_mcp_capabilities(&state);
  build_router_with_options(
    state,
    RouterRuntimeOptions {
      spawn_websocket_background_tasks: false,
      spawn_client_update_listener: false,
      retain_socket_io_handle: false,
    },
    capabilities,
  )
}

/// Construct the full router for Socket.IO integration tests.
///
/// Use this only when a test asserts server-side Socket.IO fan-out. It keeps the
/// `SocketIo` handle available to WebSocket handlers while still disabling
/// process-long analytics/Redis loops; ordinary HTTP/GraphQL tests should use
/// `build_router_for_integration_tests()` so their PgPools can drop promptly.
pub fn build_router_for_websocket_integration_tests(state: ApiState) -> Router {
  build_router_with_options(
    state,
    RouterRuntimeOptions {
      spawn_websocket_background_tasks: false,
      spawn_client_update_listener: false,
      retain_socket_io_handle: true,
    },
    reduced_integration_mcp_capabilities(),
  )
}

fn build_router_with_options(
  state: ApiState,
  runtime_options: RouterRuntimeOptions,
  mcp_capabilities: RequiredMcpCapabilities,
) -> Router {
  let state_arc = Arc::new(state.clone());
  let (io_layer, io) = websocket::init_with_options(
    state_arc.clone(),
    websocket::RuntimeOptions {
      spawn_background_tasks: runtime_options.spawn_websocket_background_tasks,
      spawn_client_update_listener: runtime_options.spawn_client_update_listener,
    },
  );
  // Set the SocketIo instance AFTER init — both the HTTP router and
  // WebSocket handlers share the same Arc<ApiState>, so both see it.
  //
  // Integration-test routers deliberately skip this back-reference. SocketIo
  // already owns the state Arc through `.with_state(...)`; storing SocketIo back
  // inside that state creates a production-lifetime cycle. That is fine for the
  // real server, but a full integration binary builds hundreds of routers and
  // would otherwise retain every test PgPool until process exit.
  if runtime_options.retain_socket_io_handle {
    *state_arc.socket_io.write().unwrap_or_else(|e| e.into_inner()) = Some(io);
  }

  // Build the MCP router (POST /mcp, GET /mcp for SSE)
  let mcp_pool = state.metrics_pool();
  let document_template_service = state.document_template_service();
  let mcp_state = McpState {
    key_service: state.api_key_service().clone(),
    tool_state: McpToolState {
      html_catalog: state.html_catalog(),
      workspace_service: state.workspace().clone(),
      workspace_settings_service: Some(Arc::new(state.workspace_settings_service())),
      public_repository: Some(state.public_repository()),
      public_delivery_enabled: state.config.public_publishing.enabled
        && state.config.public_publishing.dynamic_routes_enabled,
      document_publication_service: Some(Arc::new(state.document_publication_service())),
      doc_service: state.doc().clone(),
      comment_service: Some(Arc::new(state.comment().clone())),
      server_origin: Arc::from(state.config.server.origin.clone()),
      permission_service: state.permission_service(),
      search_indexer: state.search_indexer(),
      search_repository: state.search_repository(),
      assistant_packages: state.assistant_packages(),
      database_services: state.database_services(),
      calendar: match (state.calendar(), state.native_event_service()) {
        (Some(calendar), Some(native_events)) => Some(Arc::new(myoxus_mcp::tools::McpCalendarServices {
          calendar,
          native_events,
        })),
        _ => None,
      },
      users: Some(Arc::new(myoxus_mcp::tools::McpUserServices {
        users: state.admin_users(),
        auth: state.auth().clone(),
      })),
      organization: match (
        state.organization_unit_lifecycle_service(),
        state.organization_repo(),
        state.organization_unit_repo(),
      ) {
        (Some(lifecycle), Some(organizations), Some(units)) => {
          Some(Arc::new(myoxus_mcp::tools::McpOrganizationServices {
            lifecycle,
            reads: state.organization_reads(),
            memberships: state_arc.organization_memberships(),
            organizations,
            units,
            auth: state.auth().clone(),
          }))
        }
        _ => None,
      },
      workspace_tag_service: state.workspace_tag_service(),
      document_graph_service: state.document_graph_service(),
      document_template_service,
      template_registry: state.template_registry().cloned(),
      template_suggestions: state.template_registry().cloned().map(|registry| {
        TemplateSuggestionService::new(
          std::sync::Arc::new(registry),
          state.document_metadata_policy_repo(),
          Some(state.permission_service()),
        )
      }),
      workspace_automation_service: state.workspace_automation_service(),
      pdf_export_service: Some(Arc::new(crate::pdf_export_adapter::create_get_service(
        state_arc.clone(),
      ))),
      pdf_template_repo: state.pdf_template_repo(),
      pdf_assignment_repo: state.pdf_assignment_repo(),
      document_services: mcp_capabilities.document_services,
      idempotency: mcp_capabilities.idempotency,
      blob_service: Some(state.services.blob_service.clone()),
      upload_policy: mcp_pool.map(|pool| McpUploadPolicy {
        max_upload_bytes: state.config.storage.max_upload_bytes(),
        signed_url_ttl_seconds: state.config.storage.signed_url_ttl_seconds,
        mime_allowlist: state.config.git_sync.mime_allowlist_admin.clone(),
        mime_blocklist: state.config.git_sync.mime_blocklist_admin.clone(),
        mime_validation_mode: state.config.git_sync.mime_validation_mode.clone(),
        mime_policy_reader: Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpMimePolicyReader::new(
          pool,
        )),
      }),
      audit_recorder: state.audit_recorder().clone(),
      metrics_service: state.metrics_arc(),
      document_cursor_signing_key: Arc::from(state.config.crypto.private_key.as_bytes()),
      document_export_max_bytes: state.config.mcp.document_export_max_bytes,
    },
    subscriptions: SubscriptionHub::with_updates(state.resource_updates.clone()),
    availability: Arc::new(LiveMcpAvailability {
      baseline_default: state.config_file_baseline.mcp.enabled,
      overrides: Arc::clone(&state.config_overrides),
    }),
  };
  let mcp_sub_router: Router<ApiState> = mcp_router(mcp_state);

  // Health, readiness, liveness, and metrics endpoints bypass the full
  // middleware stack (throttle, logger, compression).  Load-balancer probes
  // hit these at high frequency; running them through Redis throttle lookups,
  // tracing spans, and gzip compression is pure overhead.
  //
  // The lightweight router is merged into the final router *after* the main
  // router has its middleware applied, so these routes are served directly
  // by Axum with only CORS (required for browser-based health checks).
  let health_router = Router::new()
    .route("/health", get(health))
    .route("/ready", get(ready))
    .route("/live", get(live))
    .route("/metrics", get(metrics))
    .route("/metrics/prometheus", get(metrics_prometheus))
    .with_state(state.clone());

  let mut router = Router::new()
    .route("/info", get(info_handler))
    .route("/api/auth/preflight", post(auth::preflight))
    .route("/api/auth/sign-in", post(auth::sign_in))
    .route("/api/auth/magic-link", post(auth::magic_link_sign_in))
    .route("/api/auth/open-app/sign-in-code", post(auth::open_app_sign_in_code))
    .route("/api/auth/open-app/sign-in", post(auth::open_app_sign_in))
    .route("/api/auth/challenge", get(auth::get_challenge))
    .route(
      "/api/auth/sign-out",
      get(auth::sign_out_deprecated).post(auth::sign_out),
    )
    .route("/session", get(auth::current_session))
    .route("/user", get(current_user_alias))
    .route("/api/auth/session", get(auth::current_session))
    .route("/api/auth/sessions", get(auth::current_sessions))
    .route("/api/avatars/{id}", get(auth::get_avatar))
    .route("/api/setup/create-admin-user", post(auth::create_admin_user))
    .route("/api/oauth/preflight", post(auth::oauth::oauth_preflight))
    .route("/api/calendar/oauth/preflight", post(auth::oauth::oauth_preflight))
    .route(
      "/api/oauth/callback",
      get(auth::oauth::oauth_callback_frontend_redirect).post(auth::oauth::oauth_callback),
    )
    .route(
      "/api/calendar/oauth/callback",
      get(auth::oauth::oauth_callback_get).post(auth::oauth::oauth_callback),
    )
    .route("/api/blob-upload/part", put(blob_upload_part_handler))
    .route(
      "/api/workspace-import/upload-part",
      put(workspace_import_part_upload_handler).layer(DefaultBodyLimit::max(
        myoxus_application::workspace_import::WORKSPACE_IMPORT_PART_BYTES,
      )),
    )
    .route(
      "/api/workspaces/{workspace_id}/export/obsidian-vault",
      get(obsidian_vault_export_handler),
    )
    .route("/api/storage/upload", put(storage_upload_handler))
    .route("/api/storage/multipart", put(storage_multipart_part_handler))
    .route(
      "/api/workspaces/{workspace_id}/blobs/{*key}",
      get(download_blob_handler),
    )
    .route("/api/workspaces/{workspace_id}/docs/{guid}", get(workspace_doc_handler))
    .route(
      "/api/workspaces/{workspace_id}/docs/import/docx",
      post(import_docx_handler).layer(DefaultBodyLimit::max(104_858_624)),
    )
    .route(
      "/api/workspaces/{workspace_id}/docs/{guid}/export/docx",
      post(export_docx_handler),
    )
    .route(
      "/api/workspaces/{workspace_id}/docs/{guid}/preview",
      get(workspace_doc_preview_handler),
    )
    .route(
      "/api/workspaces/{workspace_id}/docs/{guid}/histories/by-id/{history_id}",
      get(workspace_doc_history_by_id_handler),
    )
    .route(
      "/api/workspaces/{workspace_id}/docs/{guid}/histories/{timestamp}",
      get(workspace_doc_history_handler),
    )
    .route(
      "/api/workspaces/{workspace_id}/docs/{doc_id}/comment-attachments/{key}",
      get(comment_attachment_handler),
    )
    .route("/api/workspaces/{workspace_id}/search", get(search_docs_handler))
    .route(
      "/api/workspaces/{workspace_id}/calendar/events",
      get(list_calendar_events_handler).post(create_calendar_event_handler),
    )
    .route(
      "/api/workspaces/{workspace_id}/calendar/events/{event_id}",
      put(update_calendar_event_handler).delete(delete_calendar_event_handler),
    )
    .route(
      "/api/workspaces/{workspace_id}/calendar/reminders/{reminder_id}/status",
      put(update_calendar_reminder_status_handler),
    )
    .route(
      "/api/workspaces/{workspace_id}/mcp/",
      get(mcp_method_not_allowed)
        .delete(mcp_method_not_allowed)
        .post(mcp_handler),
    )
    .route("/rpc/workspaces/{workspace_id}/docs/{doc_id}", get(rpc_get_doc_handler))
    .route(
      "/rpc/workspaces/{workspace_id}/docs/{doc_id}/content",
      get(rpc_get_doc_content_handler),
    )
    .route(
      "/rpc/workspaces/{workspace_id}/docs/{doc_id}/markdown",
      get(rpc_get_doc_markdown_handler),
    )
    .route(
      "/rpc/workspaces/{workspace_id}/docs/{doc_id}/diff",
      post(rpc_get_doc_diff_handler),
    )
    .route(
      "/rpc/workspaces/{workspace_id}/content",
      get(rpc_get_workspace_content_handler),
    )
    .route("/api/telemetry/collect", post(telemetry_collect_handler))
    .route("/api/telemetry/status", get(telemetry_status_handler))
    .route("/api/worker/image-proxy", get(worker_image_proxy_handler))
    .route("/api/worker/link-preview", post(worker_link_preview_handler))
    .route(
      "/api/i18n/config",
      get(i18n_config_get_handler).put(i18n_config_put_handler),
    )
    .route(
      "/api/worker/questionnaire",
      get(worker_questionnaire_get_handler).post(worker_questionnaire_post_handler),
    )
    .route(
      "/api/copilot/blob/{user_id}/{workspace_id}/{key}",
      get(copilot_blob_handler),
    )
    .route("/api/copilot/unsplash/photos", get(copilot_unsplash_photos_handler))
    .route(
      "/api/copilot/messages/{message_id}/files/{file_id}",
      get(handlers::copilot::download_generated_file),
    )
    .route(
      "/api/copilot/chat/{session_id}/{endpoint}",
      get(copilot_chat_sse_handler),
    )
    .route("/api/calendar/webhook/google", post(calendar_google_webhook_handler))
    .route("/api/git-sync/webhook/{profile_id}", post(git_sync_webhook_handler))
    .route("/api/calendar/rsvp/{token}", get(calendar_rsvp_handler))
    .route("/api/admin/branding/upload", post(branding_upload_handler))
    .route("/api/admin/logs/download", get(logs_download_handler))
    .route("/api/admin/logs/tail", get(logs_tail_handler))
    .route(
      "/api/admin/templates/export/{revision_id}",
      get(template_export_handler),
    )
    .route(
      "/api/admin/templates/workspace-source/export",
      post(workspace_template_source_export_handler)
        .layer(DefaultBodyLimit::max(MAX_WORKSPACE_SOURCE_EXPORT_REQUEST_BYTES)),
    )
    .route(
      "/api/templates/features/{bundle}/{version}/{archive_digest}/{component}",
      get(handlers::feature_assets::feature_artwork_handler),
    )
    .route(
      "/api/admin/pdf-export/jobs/events",
      get(pdf_export_admin_jobs_events_handler),
    )
    .route("/api/pdf-export/{job_id}/events", get(pdf_export_job_events_handler))
    .route("/api/pdf-export/{job_id}/download", get(pdf_export_download_handler))
    // P91-CFG-B: Config export/import endpoints
    .route("/api/admin/config/export", get(export_config))
    .route("/api/admin/config/import", post(import_config))
    .route("/api/admin/config/check", get(check_production_readiness))
    .route("/api/admin/captcha/status", get(captcha_status))
    .route("/api/branding/app-server.json", get(branding_app_server_handler))
    .route("/api/branding/theme.css", get(branding_theme_css_handler))
    .route("/api/fonts", get(fonts_list_handler))
    .route("/api/fonts/{filename}", get(fonts_file_handler))
    .route("/public/{workspace_id}", get(public_workspace_handler))
    .route("/public/{workspace_id}/{doc_id}", get(public_document_handler))
    .route(
      "/public-assets/{workspace_id}/{doc_id}/{asset_hash}/{filename}",
      get(public_asset_handler),
    )
    .route("/share/{workspace_id}/{doc_id}", get(legacy_share_redirect_handler))
    .route("/style/{filename}", get(branding_style_asset_handler))
    .route("/favicon.svg", get(branding_favicon_handler))
    .route("/favicon-32.png", get(branding_favicon_32_png_handler))
    .route("/favicon-36.png", get(branding_favicon_36_png_handler))
    .route("/favicon-48.png", get(branding_favicon_48_png_handler))
    .route("/favicon-72.png", get(branding_favicon_72_png_handler))
    .route("/favicon-96.png", get(branding_favicon_96_png_handler))
    .route("/favicon-144.png", get(branding_favicon_144_png_handler))
    .route("/favicon-192.png", get(branding_favicon_192_png_handler))
    .route("/workspace", get(workspace_renderer_root_handler))
    .route("/workspace/{*path}", get(workspace_renderer_handler))
    .route(
      "/graphql",
      post(graphql_handler).layer(DefaultBodyLimit::max(10 * 1024 * 1024)),
    )
    .nest("/mcp", mcp_sub_router)
    // A catch-all fallback is required so the socketioxide layer (io_layer)
    // fires for `/socket.io/` requests.  In Axum 0.8, `Router::layer()`
    // only runs middleware when a route (or fallback) matches; without this,
    // requests to paths that have no explicit `.route()` bypass the entire
    // layer stack and return 404 before io_layer can intercept them.
    .fallback(|| async { axum::http::StatusCode::NOT_FOUND })
    .layer(io_layer)
    .layer(middleware::from_fn_with_state(state_arc.clone(), throttle_middleware))
    .layer(middleware::from_fn_with_state(state_arc, logger_middleware))
    .layer(middleware::from_fn(request_id::attach_request_id))
    .layer(CompressionLayer::new().quality(tower_http::CompressionLevel::Default))
    .layer(build_cors_layer(&state))
    .with_state(state);

  // Only expose the GraphQL playground in non-production environments.
  // This prevents leaking schema introspection UI to external users.
  let run_mode = std::env::var("RUN_MODE").unwrap_or_else(|_| "development".into());
  if run_mode != "production" {
    router = router.route("/graphql/playground", get(graphql_playground));
  }

  // Merge the lightweight health router AFTER the main router's middleware
  // layers are applied.  Routes registered on health_router are matched
  // first by Axum's merge semantics and skip throttle/logger/compression.
  router = router.merge(health_router);

  router
}

// --- CORS layer builder ---

/// Build a [`CorsLayer`] that mirrors the NestJS upstream CORS configuration.
///
/// Allowed origins:
/// - `file://` (Electron Desktop client — always allowed)
/// - `server.origin` from config
/// - Any additional origins from `cors.allowed_origins`
///
/// Build the CORS middleware layer from startup config.
///
/// ## Documented Limitation (API L-05): CORS changes require server restart
///
/// The CORS layer is built **once** at startup from the static config snapshot.
/// tower-http's `CorsLayer` captures allowed origins, headers, and max-age at
/// construction time — Axum layers are immutable after the router is built.
///
/// If an admin changes `cors.allowedOrigins` or `cors.maxAgeSeconds` via
/// `adminUpdateConfig`, the changes will **NOT** take effect until the server is
/// restarted. This contrasts with DB-backed feature flags (e.g. `copilot.enabled`)
/// which are read per-request.
///
/// A periodic reload (e.g. every 60s) was considered but rejected because:
/// 1. Axum layers are immutable after router construction — replacing the CORS
///    layer requires rebuilding the entire router, which is not supported at runtime.
/// 2. Using `tower_http::cors::AllowOrigin::predicate` already gives us dynamic
///    evaluation per-request, but the predicate's captured state (the origin lists)
///    cannot be swapped without Arc<RwLock<>> which adds latency to every request.
/// 3. CORS config changes are rare (deployment-time, not runtime) — a restart
///    is an acceptable operational requirement.
///
/// Config: `cors.reloadable` is intentionally not provided. All CORS changes
/// require a server restart.
fn build_cors_layer(state: &ApiState) -> CorsLayer {
  let server_origin = state.config.server.origin.clone();
  let extra_origins: Vec<String> = state.config.cors.allowed_origins.clone();
  let app_origins: Vec<String> = state.config.cors.app_origins.clone();
  let custom_headers: Vec<String> = state.config.cors.allowed_custom_headers.clone();
  let max_age_secs = state.config.cors.max_age_seconds;

  // Build the allowed-headers list: always include the three standard headers,
  // then append any custom headers from config.
  let mut headers: Vec<axum::http::HeaderName> = vec![
    axum::http::header::CONTENT_TYPE,
    axum::http::header::AUTHORIZATION,
    axum::http::header::COOKIE,
  ];
  for h in &custom_headers {
    match axum::http::HeaderName::from_bytes(h.as_bytes()) {
      Ok(name) => headers.push(name),
      Err(e) => {
        tracing::warn!(header = %h, error = %e, "ignoring invalid custom CORS header name");
      }
    }
  }

  CorsLayer::new()
    .allow_origin(tower_http::cors::AllowOrigin::predicate(
      move |origin: &HeaderValue, _parts: &axum::http::request::Parts| {
        let Ok(origin_str) = origin.to_str() else {
          return false;
        };
        // Check configurable app origins (Desktop/Electron/Tauri/Capacitor)
        for app_origin in &app_origins {
          if origin_str == app_origin || origin_str.starts_with(app_origin.as_str()) {
            return true;
          }
        }
        // Allow server's own origin
        if origin_str == server_origin {
          return true;
        }
        // Allow any configured extra origins
        extra_origins.iter().any(|o| o == origin_str)
      },
    ))
    .allow_credentials(true)
    .allow_methods([
      Method::GET,
      Method::HEAD,
      Method::PUT,
      Method::PATCH,
      Method::POST,
      Method::DELETE,
      Method::OPTIONS,
    ])
    .allow_headers(headers)
    .expose_headers([
      axum::http::header::ETAG,
      axum::http::header::SET_COOKIE,
      axum::http::header::CONTENT_DISPOSITION,
      axum::http::HeaderName::from_static("x-myoxus-conversion-warnings"),
      axum::http::HeaderName::from_static("x-doc-revision"),
      axum::http::HeaderName::from_static("x-preview-width"),
      axum::http::HeaderName::from_static("x-preview-height"),
      axum::http::HeaderName::from_static("x-preview-content-height"),
      axum::http::HeaderName::from_static("x-preview-partial"),
      axum::http::HeaderName::from_static("x-preview-truncated"),
      axum::http::HeaderName::from_static("x-preview-cache"),
    ])
    .max_age(std::time::Duration::from_secs(max_age_secs))
}

// --- GraphQL handlers (kept in lib.rs due to Schema builder complexity) ---

async fn graphql_handler(
  State(state): State<ApiState>,
  headers: HeaderMap,
  body: Bytes,
) -> Result<impl IntoResponse, StatusCode> {
  // P101-FF-AUTH-01: Extract diagnostic fields before headers are consumed.
  let parsed_cookies_for_diagnostics = crate::graphql::utils::parse_cookies(&headers);
  let has_session_cookie = crate::graphql::utils::has_session_cookie(&parsed_cookies_for_diagnostics);
  let user_agent = headers
    .get(axum::http::header::USER_AGENT)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("-")
    .to_string();

  let content_type = headers
    .get(axum::http::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok());
  let request = async_graphql::http::receive_batch_body(
    content_type,
    Cursor::new(body.to_vec()),
    async_graphql::http::MultipartOptions::default(),
  )
  .await
  .map_err(|_| StatusCode::BAD_REQUEST)?
  .into_single()
  .map_err(|_| StatusCode::BAD_REQUEST)?;

  let operation_name = request.operation_name.clone().unwrap_or_default();

  let request = request
    .data::<Arc<ApiState>>(Arc::new(state))
    .data::<crate::client_context::ClientContext>(crate::client_context::ClientContext::from_headers(&headers))
    .data::<HeaderMap>(headers);

  let response = get_or_init_schema().execute(request).await;

  if !response.errors.is_empty() {
    for err in &response.errors {
      tracing::error!(
        message = %err.message,
        operation = %operation_name,
        has_session_cookie,
        user_agent = %user_agent,
        "graphql error"
      );
    }
  }

  let batch = BatchResponse::Single(response);
  let json = serde_json::to_string(&batch).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  Ok((
    StatusCode::OK,
    [("content-type", "application/json"), ("cache-control", "no-store")],
    json,
  ))
}

async fn graphql_playground() -> impl IntoResponse {
  (
    StatusCode::OK,
    [("content-type", "text/html")],
    playground_source(GraphQLPlaygroundConfig::new("/graphql")),
  )
}

// --- Shared cross-cutting helpers (used by multiple handler modules) ---

pub(crate) async fn require_workspace_read_user(
  state: &ApiState,
  headers: &HeaderMap,
  workspace_uuid: Uuid,
) -> Result<Uuid, StatusCode> {
  let cookies = crate::graphql::utils::parse_cookies(headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?;
  state
    .permission_service()
    .assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::Read,
    )
    .await
    .map_err(|_| StatusCode::FORBIDDEN)?;
  Ok(snapshot.user.id)
}

pub(crate) async fn require_admin_user(state: &ApiState, headers: &HeaderMap) -> Result<Uuid, StatusCode> {
  let cookies = crate::graphql::utils::parse_cookies(headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?;
  if !snapshot.user.is_admin {
    return Err(StatusCode::FORBIDDEN);
  }
  Ok(snapshot.user.id)
}

#[cfg(test)]
mod mcp_composition_tests {
  use myoxus_application::mcp::McpIdempotencyAdmission;
  use uuid::Uuid;

  use super::{build_router, reduced_integration_mcp_capabilities};
  use crate::{config::AppConfig, state::ApiState};

  #[test]
  fn production_router_returns_a_typed_error_for_incomplete_state() {
    let state = ApiState::new(AppConfig::load().expect("load test configuration"));
    let error = match build_router(state) {
      Ok(_) => panic!("production router must reject an incomplete ApiState"),
      Err(error) => error,
    };
    assert!(
      error.missing_capabilities().contains(&"document_metadata_service"),
      "unexpected production composition failure: {error}"
    );
  }

  #[tokio::test]
  async fn reduced_composition_is_explicitly_fail_closed_and_deterministic() {
    let capabilities = reduced_integration_mcp_capabilities();
    let error = capabilities
      .document_services
      .projection(Uuid::new_v4(), Uuid::new_v4())
      .await
      .expect_err("reduced routers must not expose document operations");
    assert_eq!(
      error.to_string(),
      "MCP document operations are unavailable in this reduced runtime"
    );

    let row_id = Uuid::new_v4();
    let admission = capabilities
      .idempotency
      .begin(
        row_id,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "documents.update",
        "deterministic-key",
        "payload-sha256",
        0,
      )
      .await
      .expect("reduced idempotency repository must accept the first request");
    assert!(matches!(admission, McpIdempotencyAdmission::Started { row_id: id } if id == row_id));
  }
}
