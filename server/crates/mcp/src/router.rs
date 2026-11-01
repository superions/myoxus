// SPDX-License-Identifier: AGPL-3.0-or-later
//! SDK-owned MCP HTTP transport with Myoxus authentication and policy adapters.

use std::{borrow::Cow, sync::Arc};

use axum::{
  Router,
  extract::{Extension, Request, State},
  http::StatusCode,
  middleware::{self, Next},
  response::{IntoResponse, Response, Sse, sse::Event as SseEvent},
  routing::post_service,
};
use futures_util::stream;
use rmcp::{
  ErrorData, RoleServer, ServerHandler,
  handler::server::tool::ToolCallContext,
  model::{
    CallToolRequestParams, CallToolResponse, CompleteRequestParams, CompleteResult, DiscoverResult, ErrorCode,
    Implementation, InitializeRequestParams, InitializeResult, ListResourceTemplatesResult, ListResourcesResult,
    ListToolsResult, PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams, ReadResourceResponse,
    ServerCapabilities, ServerConfig, UnsubscribeRequestParams,
  },
  service::{NotificationContext, RequestContext},
  transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::never::NeverSessionManager,
  },
};
use serde_json::json;
use tracing::instrument;

use myoxus_application::api_key::ApiKeyService;
use myoxus_application::metrics::MetricsCategory;

use crate::auth::{McpAuthContext, mcp_auth_middleware};
use crate::protocol::McpToolError;
use crate::resources;
use crate::subscriptions::SubscriptionHub;
use crate::tool_registry::list_tools;
use crate::tools::{McpToolState, tool_router};

// ─── State ────────────────────────────────────────────────────────────────────

/// Resolves whether MCP is currently available for transport and auth gates.
///
/// The API adapter implements this against the canonical live configuration
/// snapshot. Tests and narrow embedders may use [`StaticMcpAvailability`].
#[async_trait::async_trait]
pub trait McpAvailability: Send + Sync {
  /// Returns the current effective value of `mcp.enabled`.
  async fn enabled(&self) -> bool;
}

/// Fixed availability policy for tests and non-reloading embedders.
pub struct StaticMcpAvailability(
  /// Value returned by [`McpAvailability::enabled`].
  pub bool,
);

#[async_trait::async_trait]
impl McpAvailability for StaticMcpAvailability {
  async fn enabled(&self) -> bool {
    self.0
  }
}

/// State shared across all MCP route handlers.
#[derive(Clone)]
pub struct McpState {
  /// Authenticates hashed MCP API keys.
  pub key_service: ApiKeyService,
  /// Server services exposed to authorized MCP tools.
  pub tool_state: McpToolState,
  /// Resource-subscription fanout owner.
  pub subscriptions: SubscriptionHub,
  /// Live feature policy; disabled MCP endpoints return 404 before auth.
  pub availability: Arc<dyn McpAvailability>,
}

impl McpState {
  /// Reads the current feature policy without retaining a startup-only copy.
  pub(crate) async fn enabled(&self) -> bool {
    self.availability.enabled().await
  }

  /// Record low-cardinality MCP transport metrics through the existing
  /// business-metrics pipeline. Labels are intentionally enum-like strings;
  /// request bodies, bearer tokens and client-supplied error messages never
  /// become labels.
  pub(crate) fn record_transport_request(&self, outcome: &'static str, method_family: &'static str) {
    self.tool_state.metrics_service.record(
      MetricsCategory::Mcp,
      "transport_request",
      &[("outcome", outcome), ("method_family", method_family)],
    );
  }

  /// Record MCP authentication denials without exposing token material.
  pub(crate) fn record_auth_denied(&self, reason: &'static str) {
    self
      .tool_state
      .metrics_service
      .record(MetricsCategory::Mcp, "auth_denied", &[("reason", reason)]);
  }

  /// Record malformed JSON-RPC or schema-level request failures.
  pub(crate) fn record_invalid_request(&self, reason: &'static str) {
    self
      .tool_state
      .metrics_service
      .record(MetricsCategory::Mcp, "invalid_request", &[("reason", reason)]);
  }
}

/// Per-request SDK service. It retains services, never an opening caller's auth.
#[derive(Clone)]
struct McpServer {
  state: Arc<McpState>,
}

impl McpServer {
  fn finish<T>(&self, family: &'static str, result: Result<T, ErrorData>) -> Result<T, ErrorData> {
    if result
      .as_ref()
      .is_err_and(|error| error.code == ErrorCode::INVALID_PARAMS)
    {
      self.state.record_invalid_request("schema");
    }
    self
      .state
      .record_transport_request(if result.is_ok() { "success" } else { "error" }, family);
    result
  }
}

/// HTTP extensions are supplied anew by the SDK for every request. In
/// particular, peer initialization must never cache a key's authority.
pub(crate) fn request_auth(context: &RequestContext<RoleServer>) -> Result<&McpAuthContext, ErrorData> {
  context
    .extensions
    .get::<axum::http::request::Parts>()
    .and_then(|parts| parts.extensions.get::<McpAuthContext>())
    .ok_or_else(|| ErrorData::internal_error("Missing MCP request authentication", None))
}

fn resource_error((code, message): (i32, String)) -> ErrorData {
  ErrorData::new(ErrorCode(code), message, None)
}

/// SDK disconnect/cancel tokens bound only work without a durable write owner.
/// Dropping a read future releases its pending lookups; it promises no rollback.
pub(crate) async fn cancellable_read<T>(
  context: &RequestContext<RoleServer>,
  operation: impl std::future::Future<Output = Result<T, ErrorData>>,
) -> Result<T, ErrorData> {
  tokio::select! {
    biased;
    _ = context.ct.cancelled() => Err(ErrorData::new(ErrorCode(-32800), "Request cancelled", None)),
    result = operation => result,
  }
}

pub(crate) fn tool_error(error: McpToolError) -> ErrorData {
  match error {
    McpToolError::Protocol { code, message } => resource_error((code, message)),
    McpToolError::Execution { .. } => ErrorData::internal_error("Internal MCP error boundary violation", None),
  }
}

impl ServerHandler for McpServer {
  fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
    Cow::Owned(vec![
      ProtocolVersion::V_2024_11_05,
      ProtocolVersion::V_2025_06_18,
      ProtocolVersion::V_2025_11_25,
      ProtocolVersion::V_2026_07_28,
    ])
  }

  fn get_info(&self) -> ServerConfig {
    let mut capabilities = ServerCapabilities::builder()
      .enable_tools()
      .enable_resources()
      .enable_completions()
      .build();
    capabilities.tools.as_mut().expect("tools enabled").list_changed = Some(false);
    let resources = capabilities.resources.as_mut().expect("resources enabled");
    resources.subscribe = Some(true);
    resources.list_changed = Some(false);
    ServerConfig::new(capabilities)
      .with_protocol_version(ProtocolVersion::V_2025_11_25)
      .with_server_info(Implementation::new("myoxus", env!("CARGO_PKG_VERSION")))
      .with_instructions("Access is limited by API-key scopes and the key owner's workspace/object permissions. Discover resource URI templates with resources/templates/list; completion/complete suggests readable workspace IDs and document keys using workspace_id context. Encode canonical myoxus-document keys as one RFC 6570 path component. Reuse idempotency keys for retryable writes; cancellation does not promise write rollback. Supply _meta.progressToken for real document_import progress; replay reports an existing outcome, not another creation. Read documents through structured content, prefer targeted server-side document mutations over full replacement, and preview destructive operations before applying them.")
  }

  #[instrument(skip_all)]
  async fn initialize(
    &self,
    request: InitializeRequestParams,
    context: RequestContext<RoleServer>,
  ) -> Result<InitializeResult, ErrorData> {
    request_auth(&context)?;
    context.peer.set_peer_info(request.clone());
    let result = self.negotiate_initialize(&request).map(|mut info| {
      // All initialize versions are retained legacy callers. Modern listen is
      // discovered through server/discover, never advertised as legacy subscribe.
      info
        .capabilities
        .resources
        .as_mut()
        .expect("resources enabled")
        .subscribe = Some(false);
      info
    });
    self.finish("health", result)
  }

  async fn discover(&self, context: RequestContext<RoleServer>) -> Result<DiscoverResult, ErrorData> {
    request_auth(&context)?;
    self.finish(
      "health",
      Ok(DiscoverResult::from_server_info(
        self.supported_protocol_versions().into_owned(),
        self.get_info(),
      )),
    )
  }

  async fn ping(&self, context: RequestContext<RoleServer>) -> Result<(), ErrorData> {
    request_auth(&context)?;
    self.finish("health", Ok(()))
  }

  async fn on_initialized(&self, _context: NotificationContext<RoleServer>) {
    self.state.record_transport_request("success", "health");
  }

  async fn on_custom_request(
    &self,
    request: rmcp::model::CustomRequest,
    context: RequestContext<RoleServer>,
  ) -> Result<rmcp::model::CustomResult, ErrorData> {
    request_auth(&context)?;
    self.finish(
      "unknown",
      Err(ErrorData::new(ErrorCode::METHOD_NOT_FOUND, request.method, None)),
    )
  }

  #[instrument(skip_all)]
  async fn list_tools(
    &self,
    request: Option<PaginatedRequestParams>,
    context: RequestContext<RoleServer>,
  ) -> Result<ListToolsResult, ErrorData> {
    let auth = request_auth(&context)?;
    let params = json!({ "cursor": request.and_then(|request| request.cursor) });
    self.finish(
      "json_rpc",
      list_tools(&params, auth, self.state.tool_state.tool_availability()).map_err(tool_error),
    )
  }

  #[instrument(skip_all)]
  async fn call_tool(
    &self,
    request: CallToolRequestParams,
    context: RequestContext<RoleServer>,
  ) -> Result<CallToolResponse, ErrorData> {
    request_auth(&context)?;
    if !tool_router().has_route(&request.name) {
      return self.finish(
        "json_rpc",
        Err(tool_error(McpToolError::protocol(
          -32601,
          format!("Unknown tool: {}", request.name),
        ))),
      );
    }
    self.finish(
      "json_rpc",
      tool_router()
        .call(ToolCallContext::new(&self.state.tool_state, request, context))
        .await,
    )
  }

  fn get_tool(&self, name: &str) -> Option<rmcp::model::Tool> {
    tool_router().get(name).cloned()
  }

  #[instrument(skip_all)]
  async fn list_resources(
    &self,
    _request: Option<PaginatedRequestParams>,
    context: RequestContext<RoleServer>,
  ) -> Result<ListResourcesResult, ErrorData> {
    let auth = request_auth(&context)?;
    self.finish(
      "resource",
      cancellable_read(&context, async {
        resources::list_resources(&self.state.tool_state.workspace_service, auth)
          .await
          .map_err(resource_error)
      })
      .await,
    )
  }

  #[instrument(skip_all)]
  async fn list_resource_templates(
    &self,
    _request: Option<PaginatedRequestParams>,
    context: RequestContext<RoleServer>,
  ) -> Result<ListResourceTemplatesResult, ErrorData> {
    let auth = request_auth(&context)?;
    self.finish("resource", Ok(resources::list_resource_templates(auth)))
  }

  #[instrument(skip_all)]
  async fn complete(
    &self,
    request: CompleteRequestParams,
    context: RequestContext<RoleServer>,
  ) -> Result<CompleteResult, ErrorData> {
    let auth = request_auth(&context)?;
    self.finish(
      "resource",
      cancellable_read(&context, async {
        resources::complete(request, &self.state.tool_state, auth)
          .await
          .map_err(resource_error)
      })
      .await,
    )
  }

  #[instrument(skip_all)]
  async fn read_resource(
    &self,
    request: ReadResourceRequestParams,
    context: RequestContext<RoleServer>,
  ) -> Result<ReadResourceResponse, ErrorData> {
    let auth = request_auth(&context)?;
    self.finish(
      "resource",
      cancellable_read(&context, async {
        resources::read_resource(&request.uri, &self.state.tool_state, auth)
          .await
          .map(Into::into)
          .map_err(resource_error)
      })
      .await,
    )
  }

  #[allow(deprecated)]
  async fn subscribe(
    &self,
    _request: rmcp::model::SubscribeRequestParams,
    context: RequestContext<RoleServer>,
  ) -> Result<(), ErrorData> {
    request_auth(&context)?;
    self.finish(
      "resource",
      Err(ErrorData::method_not_found::<rmcp::model::SubscribeRequestMethod>()),
    )
  }

  #[allow(deprecated)]
  async fn unsubscribe(
    &self,
    request: UnsubscribeRequestParams,
    context: RequestContext<RoleServer>,
  ) -> Result<(), ErrorData> {
    let auth = request_auth(&context)?;
    let result = resources::resolve_document_resource_uri(
      &request.uri,
      &self.state.tool_state.workspace_service,
      &self.state.tool_state.doc_service,
      auth,
    )
    .await;
    self.finish("resource", result.map(|_| ()).map_err(resource_error))
  }

  async fn listen(&self, context: rmcp::service::SubscriptionContext) -> Result<(), ErrorData> {
    // Admission/revalidation only reads authoritative state. SDK cancellation
    // drops pending lookups and every observation lease immediately.
    tokio::select! {
      _ = context.cancelled() => Ok(()),
      result = self.state.subscriptions.listen(&context, &self.state.key_service, &self.state.tool_state) => result,
    }
  }

  fn accepted_subscription_filter(
    &self,
    requested: &rmcp::model::SubscriptionFilter,
  ) -> Option<rmcp::model::SubscriptionFilter> {
    Some(SubscriptionHub::accepted_filter(requested))
  }
}

/// Keep availability live even for callers that embed the transport with their
/// own authentication. SDK parse failures are measured without parsing again.
async fn transport_boundary(State(state): State<Arc<McpState>>, request: Request, next: Next) -> Response {
  if !state.enabled().await {
    state.record_transport_request("disabled", "unknown");
    return StatusCode::NOT_FOUND.into_response();
  }
  let response = next.run(request).await;
  if response.status().is_client_error() {
    state.record_invalid_request("sdk_http");
    state.record_transport_request("error", "unknown");
  }
  response
}

/// Retained legacy GET keep-alive; it is not a subscription delivery channel.
async fn mcp_sse_handler(
  Extension(state): Extension<Arc<McpState>>,
  Extension(_auth): Extension<McpAuthContext>,
) -> Response {
  if !state.enabled().await {
    state.record_transport_request("disabled", "resource");
    return axum::response::Response::builder()
      .status(StatusCode::NOT_FOUND)
      .body(axum::body::Body::empty())
      .expect("static: valid response builder with no custom headers");
  }

  state.record_transport_request("success", "resource");
  let stream = stream::pending::<Result<SseEvent, std::convert::Infallible>>();
  Sse::new(stream)
    .keep_alive(
      axum::response::sse::KeepAlive::new()
        .interval(std::time::Duration::from_secs(15))
        .text("ping"),
    )
    .into_response()
}

/// DELETE /mcp — session termination (no-op in stateless mode).
async fn mcp_delete_handler(Extension(state): Extension<Arc<McpState>>) -> Response {
  if !state.enabled().await {
    state.record_transport_request("disabled", "health");
    return axum::response::Response::builder()
      .status(StatusCode::NOT_FOUND)
      .body(axum::body::Body::empty())
      .expect("static: valid response builder with no custom headers");
  }
  state.record_transport_request("success", "health");
  StatusCode::NO_CONTENT.into_response()
}

/// Bound SDK HTTP validation to the deployment's existing server origin. Keep
/// loopback access for direct operations, and retain Axum's former 2 MiB bound.
fn http_config(server_origin: &str) -> StreamableHttpServerConfig {
  let mut config = StreamableHttpServerConfig::default();
  config.legacy_session_mode = false;
  config.json_response = true;
  config.max_request_body_bytes = 2 * 1024 * 1024;
  if let Ok(origin) = url::Url::parse(server_origin)
    && let Some(host) = origin.host_str()
  {
    config.allowed_hosts.push(host.to_owned());
    config
      .allowed_hosts
      .push(origin[url::Position::BeforeHost..url::Position::AfterPort].to_owned());
    if let Some(port) = origin.port_or_known_default() {
      config.allowed_origins.push(format!(
        "{}://{}:{port}",
        origin.scheme(),
        &origin[url::Position::BeforeHost..url::Position::AfterHost]
      ));
    }
  }
  // An invalid configured origin must not silently disable browser validation.
  config.enforce_origin_validation()
}

fn transport_router<S>(state: Arc<McpState>) -> Router<S>
where
  S: Clone + Send + Sync + 'static,
{
  let config = http_config(&state.tool_state.server_origin);
  let handler_state = state.clone();
  let service = StreamableHttpService::new(
    move || {
      Ok(McpServer {
        state: handler_state.clone(),
      })
    },
    Arc::new(NeverSessionManager::default()),
    config,
  );
  Router::new()
    .route(
      "/",
      post_service(service).get(mcp_sse_handler).delete(mcp_delete_handler),
    )
    .layer(middleware::from_fn_with_state(state.clone(), transport_boundary))
    .layer(Extension(state))
}

// ─── Router builder ───────────────────────────────────────────────────────────

/// Builds the MCP Axum sub-router for an arbitrary outer application state.
///
/// `McpState` is injected as an `Extension` so the returned router is
/// compatible with any outer `Router<S>` without a state-type conflict.
/// Mount it at `/mcp`; authentication middleware covers every route.
pub fn mcp_router<S>(state: McpState) -> Router<S>
where
  S: Clone + Send + Sync + 'static,
{
  let state_arc = Arc::new(state);

  transport_router(state_arc.clone()).layer(middleware::from_fn_with_state(state_arc.clone(), mcp_auth_middleware))
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use crate::auth::McpAuthContext;
  use crate::subscriptions::SubscriptionHub;
  use crate::tools::McpToolState;
  use axum::body::Bytes;
  use myoxus_application::api_key::{ApiKeyService, InMemoryApiKeyStore};
  use myoxus_application::audit::AuditRecorder;
  use myoxus_application::auth::InMemoryAuthStore;
  use myoxus_application::doc::{DocService, PanicDocStore};
  use myoxus_application::mcp::{InMemoryMcpIdempotencyRepository, UnavailableMcpDocumentOperations};
  use myoxus_application::metrics::{METRICS_CATEGORIES, MetricsPolicy, MetricsService};
  use myoxus_application::permission::PermissionService;
  use myoxus_application::workspace::WorkspaceService;
  use serde_json::Value;
  use std::sync::atomic::{AtomicBool, Ordering};
  use tower::ServiceExt;

  fn test_metrics_service() -> Arc<MetricsService> {
    let policy = MetricsPolicy {
      enabled: true,
      categories: METRICS_CATEGORIES
        .iter()
        .map(|category| ((*category).to_string(), true))
        .collect(),
      label_workspace_id_enabled: false,
      cardinality_limit_per_metric: 10_000,
    };
    let service = Arc::new(MetricsService::in_memory_stub());
    service.set_policy(policy);
    service
  }

  /// Build an `McpState` with in-memory stores for unit tests.
  fn test_mcp_state(enabled: bool) -> McpState {
    let key_store = Arc::new(InMemoryApiKeyStore::default());
    let ws_store = Arc::new(InMemoryAuthStore::default());
    let doc_store = Arc::new(PanicDocStore);
    McpState {
      key_service: ApiKeyService::new(key_store),
      tool_state: McpToolState {
        html_catalog: None,
        workspace_service: WorkspaceService::new(ws_store.clone()),
        workspace_settings_service: None,
        public_repository: None,
        public_delivery_enabled: false,
        document_publication_service: None,
        doc_service: DocService::new(doc_store),
        comment_service: None,
        server_origin: Arc::from("https://myoxus.test"),
        permission_service: Arc::new(PermissionService::new(ws_store)),
        search_indexer: None,
        search_repository: None,
        assistant_packages: None,
        database_services: None,
        calendar: None,
        organization: None,
        users: None,
        workspace_tag_service: None,
        document_graph_service: None,
        document_template_service: None,
        template_registry: None,
        template_suggestions: None,
        workspace_automation_service: None,
        pdf_export_service: None,
        pdf_template_repo: None,
        pdf_assignment_repo: None,
        document_services: Arc::new(UnavailableMcpDocumentOperations),
        idempotency: Arc::new(InMemoryMcpIdempotencyRepository::default()),
        blob_service: None,
        upload_policy: None,
        audit_recorder: AuditRecorder::noop(),
        metrics_service: test_metrics_service(),
        document_cursor_signing_key: Arc::from(&b"mcp-router-test-cursor-key"[..]),
        document_export_max_bytes: 8 * 1024 * 1024,
      },
      subscriptions: SubscriptionHub::new(),
      availability: Arc::new(StaticMcpAvailability(enabled)),
    }
  }

  struct MutableMcpAvailability(AtomicBool);

  #[async_trait::async_trait]
  impl McpAvailability for MutableMcpAvailability {
    async fn enabled(&self) -> bool {
      self.0.load(Ordering::Acquire)
    }
  }

  fn test_auth() -> McpAuthContext {
    McpAuthContext {
      user_id: uuid::Uuid::new_v4(),
      scopes: vec!["read:workspaces".into(), "read:docs".into(), "write:docs".into()],
      key_id: uuid::Uuid::new_v4(),
    }
  }

  fn json_rpc_request(method: &str) -> Value {
    let params = if method == "initialize" {
      json!({"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "fixture", "version": "1"}})
    } else {
      json!({})
    };
    json!({"jsonrpc": "2.0", "method": method, "id": 1, "params": params})
  }

  fn json_rpc_body(req: Value) -> Bytes {
    Bytes::from(serde_json::to_vec(&req).expect("serialize test JSON-RPC request"))
  }

  async fn response_json(response: Response) -> Value {
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
      .await
      .expect("read response body");
    serde_json::from_slice(&body).expect("parse JSON-RPC response")
  }

  // Inject an authenticated request context, but exercise the actual SDK HTTP
  // service. Bearer admission itself is covered by the full-router fixture.
  async fn mcp_post_handler(
    Extension(state): Extension<Arc<McpState>>,
    Extension(auth): Extension<McpAuthContext>,
    body: Bytes,
  ) -> Response {
    post_body(state, auth, body, None).await
  }

  async fn post_body(state: Arc<McpState>, auth: McpAuthContext, body: Bytes, version: Option<&str>) -> Response {
    let mut request = axum::http::Request::builder()
      .method("POST")
      .uri("/")
      .header("host", "myoxus.test")
      .header("accept", "application/json, text/event-stream")
      .header("content-type", "application/json");
    if let Some(version) = version {
      request = request.header("mcp-protocol-version", version);
      if version == "2026-07-28" {
        let fixture: Value = serde_json::from_slice(&body).expect("valid versioned HTTP fixture");
        request = request.header("mcp-method", fixture["method"].as_str().expect("fixture method"));
        if let Some(name) = fixture["params"]["name"].as_str() {
          request = request.header("mcp-name", name);
        }
      }
    }
    transport_router::<()>(state)
      .layer(Extension(auth))
      .oneshot(
        request
          .body(axum::body::Body::from(body))
          .expect("HTTP fixture request"),
      )
      .await
      .expect("HTTP fixture response")
  }

  async fn http_json_rpc(state: McpState, auth: McpAuthContext, request: Value) -> Response {
    mcp_post_handler(Extension(Arc::new(state)), Extension(auth), json_rpc_body(request)).await
  }

  async fn versioned_http_json_rpc(request: Value, version: &str) -> Response {
    let mut request = request;
    if version == "2026-07-28" {
      request["params"]["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": {},
      });
    }
    post_body(
      Arc::new(test_mcp_state(true)),
      test_auth(),
      json_rpc_body(request),
      Some(version),
    )
    .await
  }

  // ─── MCP-RV-03d-01: enabled=false → 404 for all MCP POST requests ─────────

  #[tokio::test]
  async fn inv_mcp_rv03d_disabled_returns_404() {
    let state = Arc::new(test_mcp_state(false));
    let auth = test_auth();
    let req = json_rpc_request("ping");

    let response = mcp_post_handler(Extension(state), Extension(auth), json_rpc_body(req)).await;

    assert_eq!(
      response.status(),
      StatusCode::NOT_FOUND,
      "MCP endpoints must return 404 when mcp.enabled=false"
    );
  }

  // ─── MCP-RV-03d-02: enabled=false blocks all methods, not just ping ────────

  #[tokio::test]
  async fn inv_mcp_rv03d_disabled_blocks_tools_call() {
    let state = Arc::new(test_mcp_state(false));
    let auth = test_auth();
    let req = json!({"jsonrpc": "2.0", "method": "tools/call", "id": 2, "params": {"name": "list_workspaces"}});

    let response = mcp_post_handler(Extension(state), Extension(auth), json_rpc_body(req)).await;

    assert_eq!(
      response.status(),
      StatusCode::NOT_FOUND,
      "tools/call must be blocked when MCP is disabled"
    );
  }

  // ─── MCP-RV-03d-03: enabled=true allows requests through ──────────────────

  #[tokio::test]
  async fn inv_mcp_rv03d_enabled_allows_ping() {
    let state = Arc::new(test_mcp_state(true));
    let auth = test_auth();
    let req = json_rpc_request("ping");

    let response = mcp_post_handler(Extension(state), Extension(auth), json_rpc_body(req)).await;

    assert_eq!(
      response.status(),
      StatusCode::OK,
      "MCP ping must succeed when mcp.enabled=true"
    );
  }

  #[tokio::test]
  async fn live_availability_changes_apply_without_rebuilding_the_router() {
    let availability = Arc::new(MutableMcpAvailability(AtomicBool::new(true)));
    let mut state = test_mcp_state(true);
    state.availability = availability.clone();
    let state = Arc::new(state);
    let auth = test_auth();

    let enabled = mcp_post_handler(
      Extension(Arc::clone(&state)),
      Extension(auth.clone()),
      json_rpc_body(json_rpc_request("ping")),
    )
    .await;
    assert_eq!(enabled.status(), StatusCode::OK);

    availability.0.store(false, Ordering::Release);
    let disabled = mcp_post_handler(
      Extension(state),
      Extension(auth),
      json_rpc_body(json_rpc_request("ping")),
    )
    .await;
    assert_eq!(disabled.status(), StatusCode::NOT_FOUND);
  }

  // ─── MCP-RV-03d-04: enabled=true → initialize returns protocol info ───────

  #[tokio::test]
  async fn inv_mcp_rv03d_enabled_initialize_returns_protocol() {
    let state = Arc::new(test_mcp_state(true));
    let auth = test_auth();
    let req = json_rpc_request("initialize");

    let response = mcp_post_handler(Extension(state), Extension(auth), json_rpc_body(req)).await;

    assert_eq!(response.status(), StatusCode::OK);

    // Parse response body to verify it's valid JSON-RPC with protocol version
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
      .await
      .expect("read body");
    let json: serde_json::Value = serde_json::from_slice(&body).expect("parse JSON");
    assert_eq!(json["jsonrpc"], "2.0");
    assert!(
      json["result"]["protocolVersion"].is_string(),
      "initialize must return protocolVersion when enabled"
    );
  }

  // ─── MCP-RV-05c-01: initialize reports subscribe=false ──────────────────

  #[tokio::test]
  async fn inv_mcp_rv05c_initialize_reports_subscribe_disabled() {
    let state = Arc::new(test_mcp_state(true));
    let auth = test_auth();
    let req = json_rpc_request("initialize");

    let response = mcp_post_handler(Extension(state), Extension(auth), json_rpc_body(req)).await;

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
      .await
      .expect("read body");
    let json: serde_json::Value = serde_json::from_slice(&body).expect("parse JSON");
    let subscribe = &json["result"]["capabilities"]["resources"]["subscribe"];
    assert_eq!(
      subscribe,
      &serde_json::json!(false),
      "initialize must advertise resources.subscribe=false (subscriptions not supported)"
    );
  }

  // ─── MCP-RV-05c-02: resources/subscribe returns JSON-RPC -32601 ─────────

  #[tokio::test]
  async fn inv_mcp_rv05c_resources_subscribe_returns_not_found() {
    let state = test_mcp_state(true);
    let auth = test_auth();
    let response = http_json_rpc(state, auth, json!({"jsonrpc": "2.0", "id": 1, "method": "resources/subscribe", "params": {"uri": "myoxus://00000000-0000-0000-0000-000000000000/test"}})).await;
    let result = response_json(response).await;
    assert_eq!(
      result["error"]["code"], -32601,
      "unsupported subscription must remain a protocol error"
    );
  }

  #[tokio::test]
  async fn inv_mcp_core_initialize_negotiates_all_verified_versions_and_falls_back() {
    for (requested, expected) in [
      ("2024-11-05", "2024-11-05"),
      ("2025-06-18", "2025-06-18"),
      ("2025-11-25", "2025-11-25"),
      ("2099-01-01", "2025-11-25"),
      ("2026-07-28", "2026-07-28"),
    ] {
      let response = if requested == "2026-07-28" {
        versioned_http_json_rpc(
          json!({"jsonrpc": "2.0", "method": "server/discover", "id": requested, "params": {}}),
          requested,
        )
        .await
      } else {
        http_json_rpc(
          test_mcp_state(true),
          test_auth(),
          json!({
            "jsonrpc": "2.0", "method": "initialize", "id": requested,
            "params": {
              "protocolVersion": requested,
              "capabilities": {},
              "clientInfo": {"name": "fixture", "version": "1"}
            },
          }),
        )
        .await
      };
      let wire = response_json(response).await;
      if requested == "2026-07-28" {
        assert!(
          wire["result"]["supportedVersions"]
            .as_array()
            .unwrap_or_else(|| panic!("SDK discovery versions missing: {wire}"))
            .contains(&json!(expected))
        );
        assert_eq!(
          wire["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
          "myoxus"
        );
      } else {
        assert_eq!(wire["result"]["protocolVersion"], expected, "requested {requested}");
      }
      assert_eq!(wire["result"]["capabilities"]["tools"]["listChanged"], false);
      assert_eq!(
        wire["result"]["capabilities"]["resources"]["subscribe"],
        requested == "2026-07-28"
      );
      assert!(wire["result"]["instructions"].as_str().unwrap().contains("scopes"));

      let listed = versioned_http_json_rpc(
        json!({"jsonrpc": "2.0", "method": "tools/list", "id": format!("list-{requested}"), "params": {}}),
        expected,
      )
      .await;
      let listed = response_json(listed).await;
      let tools = listed["result"]["tools"]
        .as_array()
        .expect("versioned tools/list fixture");
      assert!(!tools.is_empty());
      assert!(tools.iter().all(|tool| tool["inputSchema"]["type"] == "object"));
      assert!(tools.iter().all(|tool| tool["outputSchema"]["type"] == "object"));

      let called = versioned_http_json_rpc(
        json!({"jsonrpc": "2.0", "method": "tools/call", "id": format!("call-{requested}"), "params": {"name": "list_workspaces", "arguments": {}}}),
        expected,
      )
      .await;
      let called = response_json(called).await;
      assert!(called["result"]["structuredContent"].is_object());
      assert!(called["result"]["content"].is_array());
      if requested == "2026-07-28" {
        assert_eq!(listed["result"]["resultType"], "complete");
        assert_eq!(listed["result"]["cacheScope"], "private");
        assert_eq!(listed["result"]["ttlMs"], 0);
        assert_eq!(called["result"]["resultType"], "complete");
      } else {
        assert!(listed["result"].get("resultType").is_none());
        assert!(called["result"].get("resultType").is_none());
      }
    }
  }

  #[tokio::test]
  async fn inv_mcp_core_initialized_notification_returns_accepted_without_body() {
    let response = mcp_post_handler(
      Extension(Arc::new(test_mcp_state(true))),
      Extension(test_auth()),
      json_rpc_body(json!({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})),
    )
    .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(body.is_empty());
  }

  #[tokio::test]
  async fn inv_mcp_core_tools_call_has_structured_and_text_results_and_typed_errors() {
    let state = Arc::new(test_mcp_state(true));
    let success = mcp_post_handler(
      Extension(state.clone()),
      Extension(test_auth()),
      json_rpc_body(json!({"jsonrpc": "2.0", "method": "tools/call", "id": 1, "params": {"name": "list_workspaces", "arguments": {}}})),
    )
    .await;
    let success = response_json(success).await;
    let structured = success["result"]["structuredContent"].clone();
    let text = success["result"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(serde_json::from_str::<Value>(text).unwrap(), structured);
    assert!(success.get("error").is_none());

    let invalid_arguments = mcp_post_handler(
      Extension(state.clone()),
      Extension(test_auth()),
      json_rpc_body(
        json!({"jsonrpc": "2.0", "method": "tools/call", "id": 2, "params": {"name": "list_pages", "arguments": {}}}),
      ),
    )
    .await;
    let invalid_arguments = response_json(invalid_arguments).await;
    assert_eq!(invalid_arguments["result"]["isError"], true);
    assert_eq!(
      invalid_arguments["result"]["structuredContent"]["code"],
      "INVALID_ARGUMENT"
    );
    assert!(invalid_arguments.get("error").is_none());

    let unknown = mcp_post_handler(
      Extension(state),
      Extension(test_auth()),
      json_rpc_body(
        json!({"jsonrpc": "2.0", "method": "tools/call", "id": 3, "params": {"name": "not_a_tool", "arguments": {}}}),
      ),
    )
    .await;
    let unknown = response_json(unknown).await;
    assert_eq!(unknown["error"]["code"], -32601);
    assert!(unknown.get("result").is_none());
  }

  #[tokio::test]
  async fn inv_mcp_transport_metrics_record_success_and_malformed_json_without_payload() {
    let state = Arc::new(test_mcp_state(true));
    let auth = test_auth();

    let ok = mcp_post_handler(
      Extension(state.clone()),
      Extension(auth.clone()),
      json_rpc_body(json_rpc_request("ping")),
    )
    .await;
    assert_eq!(ok.status(), StatusCode::OK);

    let malformed = mcp_post_handler(
      Extension(state.clone()),
      Extension(auth),
      Bytes::from_static(b"{not json"),
    )
    .await;
    assert_eq!(malformed.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

    let prometheus = state.tool_state.metrics_service.render_prometheus();
    assert!(
      prometheus.contains("myoxus_metric_mcp_transport_request"),
      "MCP POST handling must emit transport_request metrics: {prometheus}"
    );
    assert!(
      prometheus.contains("method_family=\"health\""),
      "successful ping must be classified as health traffic: {prometheus}"
    );
    assert!(
      prometheus.contains("myoxus_metric_mcp_invalid_request"),
      "malformed JSON-RPC must emit invalid_request metrics: {prometheus}"
    );
    assert!(
      !prometheus.contains("not json"),
      "metrics must not include raw request payloads"
    );
  }

  #[tokio::test]
  async fn inv_mcp_disabled_get_and_delete_return_404_and_emit_transport_metrics() {
    let state = Arc::new(test_mcp_state(false));
    let auth = test_auth();

    let get = mcp_sse_handler(Extension(state.clone()), Extension(auth)).await;
    assert_eq!(get.status(), StatusCode::NOT_FOUND);

    let delete = mcp_delete_handler(Extension(state.clone())).await;
    assert_eq!(delete.status(), StatusCode::NOT_FOUND);

    let prometheus = state.tool_state.metrics_service.render_prometheus();
    assert!(
      prometheus.contains("outcome=\"disabled\""),
      "disabled MCP routes must emit transport_request disabled metrics: {prometheus}"
    );
  }

  #[tokio::test]
  async fn inv_mcp_disabled_router_returns_404_before_authentication() {
    let state = test_mcp_state(false);
    let metrics = state.tool_state.metrics_service.clone();
    let app = mcp_router::<()>(state);

    let response = app
      .oneshot(
        axum::http::Request::builder()
          .method("POST")
          .uri("/")
          .body(axum::body::Body::from(r#"{"jsonrpc":"2.0","method":"ping","id":1}"#))
          .expect("request"),
      )
      .await
      .expect("router response");

    assert_eq!(
      response.status(),
      StatusCode::NOT_FOUND,
      "disabled MCP router must return 404 before Authorization is required"
    );
    let prometheus = metrics.render_prometheus();
    assert!(
      prometheus.contains("outcome=\"disabled\""),
      "disabled pre-auth route must still emit disabled transport metrics: {prometheus}"
    );
    assert!(
      !prometheus.contains("auth_denied"),
      "disabled feature gate must not report auth denials before token validation: {prometheus}"
    );
  }
}
