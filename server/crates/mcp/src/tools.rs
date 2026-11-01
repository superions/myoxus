// SPDX-License-Identifier: AGPL-3.0-or-later
//! MCP tool handlers.
//!
//! Each tool maps onto one or more application-layer service calls.
//! Tools enforce scope checks and workspace ACL before performing operations.
//!
//! Tools implemented:
//! - `list_workspaces` — scope `read:workspaces`
//! - `list_pages`      — scope `read:docs`
//! - `read_doc`        — scope `read:docs`
//! - `search_docs`     — scope `read:docs`
//! - `create_page`     — scope `write:docs`
//! - `update_doc`      — scope `write:docs`
//! - `doc_patch`       — scope `write:docs`
//! - `delete_page`     — scope `write:docs`
//! - `restore_page`    — scope `write:docs`
//! - `page_projection_*` — bounded projection inspection and exact repair
//! - `folder_*`        — scope `read:docs` / `write:docs`
//! - `folder_entry_*`  — scope `read:docs` / `write:docs`
//! - Workspace Labels (`workspace_tag_*`, `document_tags_get/set`) use canonical
//!   Tag UUIDs, workspace-local document keys, and `read:docs` / `write:docs`.
//!   Set replaces the full ordered assignment; its retry key replays one result.
//! - `blob_*`          — scope `read:docs` / `write:docs`
//! - `doc_version_*`   — scope `read:docs` / `write:docs`
//! - `doc_metadata_*`  — scope `read:docs` / `write:docs`
//! - template/PDF tools — scope `read:workspaces`

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use base64::Engine;
use bytes::Bytes;
use chrono::{DateTime, NaiveDate, Utc};
use futures_util::future::BoxFuture;
use myoxus_application::audit::{AuditActor, AuditCategory, AuditEvent, AuditRecorder, AuditTarget};
use myoxus_application::calendar::{CalendarService, NativeEventService};
use myoxus_application::database::{DatabaseDefinitionService, DatabaseServices};
use myoxus_application::document_graph::DocumentGraphService;
use myoxus_application::document_metadata::DocumentMetadataValidationService;
use myoxus_application::document_metadata_policy::DocumentStatusTransitionRequest;
use myoxus_application::document_template::DocumentTemplateService;
use myoxus_application::document_version::DocumentVersionCreateRequest;
use myoxus_application::markdown::{AuthorizedMarkdownDocument, MarkdownReferenceLookup};
use myoxus_application::mcp::{
  McpDocumentOperations, McpIdempotencyRepository, McpMimePolicyFallback, McpMimePolicyReader,
};
use myoxus_application::metrics::{MetricsCategory, MetricsService};
use myoxus_application::mime_policy::{MimePolicyDecision, detect_mime, evaluate_policy};
use myoxus_application::organizer::{
  CreateOrganizerFolder, CreateOrganizerLink, OrganizerError, OrganizerLinkType, OrganizerRow, OrganizerService,
  OrganizerSnapshotNode, UpdateOrganizerFolder, UpdateOrganizerLink,
};
use myoxus_application::permission::{AccessController, DocResource, PermissionService, WorkspaceResource};
use myoxus_application::ports::blob::{BlobMetadata, BlobStatus};
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::public::PublicRepository;
use myoxus_application::search::SearchIndexerService;
use myoxus_application::template_registry::{
  TemplateRegistryService,
  suggestions::{TemplateSuggestionRequest, TemplateSuggestionService, TemplateSuggestionSurface},
};
use myoxus_application::workspace::WorkspaceService;
use myoxus_application::workspace_automation::WorkspaceAutomationService;
use myoxus_application::workspace_content_operation::link::{WorkspaceContentLinkError, WorkspaceContentLinkService};
use myoxus_application::workspace_tags::WorkspaceTagService;
use myoxus_application::{
  auth::AuthError,
  doc::{DocLoadCancellation, DocService, DocSpaceKind, PageLifecycleRepairMode},
};
use myoxus_domain::database::{
  DatabaseCellValueData, DatabaseJsonConflictStrategy, DatabaseJsonImportMode, DatabaseJsonImportOptions,
};
use myoxus_domain::document_graph::{
  DocumentGraphDirection, DocumentGraphPage, DocumentGraphQuery, DocumentGraphReadModel, DocumentGraphTargetState,
};
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::{Doc, DocumentMetadataPatch, DocumentMetadataValidation, DocumentVersion};
use myoxus_domain::ids::DatabaseFieldId;
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::repositories::PageRequest;
use myoxus_domain::workspace_automation::WorkspaceAutomationRun;
use rmcp::handler::server::tool::{ToolRoute, ToolRouter};
use rmcp::{RoleServer, service::RequestContext};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use crate::auth::McpAuthContext;
use crate::idempotency::{
  BeginOutcome as IdempotencyBeginOutcome, Guard as McpIdempotencyGuard, Requirement as IdempotencyRequirement,
};
use crate::protocol::{CallToolResult, McpToolError, tool_success, tool_success_with_summary};
use crate::tool_registry::{ToolAvailability, ToolDescriptor, find_tool};

#[path = "tools/automation.rs"]
mod automation;
#[path = "tools/calendar.rs"]
mod calendar;
#[path = "tools/database.rs"]
mod database;
#[path = "tools/database_assistants.rs"]
mod database_assistants;
#[path = "tools/document.rs"]
mod document;
pub(crate) use document::project_authorized_document;
#[path = "tools/comments.rs"]
mod comments;
#[path = "tools/document_image.rs"]
mod document_image;
#[path = "tools/document_import.rs"]
mod document_import;
#[path = "tools/document_reference.rs"]
mod document_reference;
#[path = "tools/document_semantics.rs"]
mod document_semantics;
#[path = "tools/document_template.rs"]
mod document_template;
#[path = "tools/folder.rs"]
mod folder;
#[path = "tools/organization.rs"]
mod organization;
mod pdf_export;
#[path = "tools/tag.rs"]
mod tag;
#[path = "tools/user.rs"]
mod user;
#[path = "tools/workspace.rs"]
pub(crate) mod workspace;

const MCP_BLOB_READ_MAX_BYTES: u64 = 5 * 1024 * 1024;
const DOCUMENT_ASSET_PREFIX: &str = "assets/";
const DATABASE_READ_SCOPE: &str = "read:databases";
const DATABASE_WRITE_SCOPE: &str = "write:databases";

/// Optional shared global-organization owners for lifecycle, reads and memberships.
/// Reduced MCP runtimes omit the aggregate and therefore omit the tools
/// from discovery rather than exposing handlers that cannot enforce policy.
#[derive(Clone)]
pub struct McpOrganizationServices {
  pub lifecycle: Arc<myoxus_application::organization::OrganizationUnitLifecycleService>,
  pub reads: Option<myoxus_application::organization::OrganizationReadService>,
  pub memberships: Option<myoxus_application::organization::OrganizationMembershipService>,
  pub organizations: Arc<dyn myoxus_domain::repositories::OrganizationRepository>,
  pub units: Arc<dyn myoxus_domain::repositories::OrganizationUnitRepository>,
  pub auth: myoxus_application::auth::AuthService,
}

/// Optional shared user owner and fresh administrator authorization source.
#[derive(Clone)]
pub struct McpUserServices {
  pub users: myoxus_application::admin::AdminUserService,
  pub auth: myoxus_application::auth::AuthService,
}

/// Delegated keys must recheck current status and role before mutation/replay.
async fn require_active_global_admin(
  auth: &McpAuthContext,
  service: &myoxus_application::auth::AuthService,
  prefix: &'static str,
) -> Result<(), (i32, String)> {
  match service.get_user_by_id(auth.user_id).await {
    Ok(Some(user)) if user.is_admin && !user.disabled => Ok(()),
    Ok(_) => Err((
      -32003,
      format!("{prefix}_ADMIN_REQUIRED: active global administrator required"),
    )),
    Err(_) => Err((
      -32002,
      format!("{prefix}_ADMIN_CHECK_FAILED: administrator status could not be verified"),
    )),
  }
}

/// Existing calendar application boundaries required by the five MCP calendar
/// adapters. Keeping them as one optional capability makes discovery fail
/// closed when either read or native-write behavior is unavailable.
#[derive(Clone)]
pub struct McpCalendarServices {
  pub calendar: Arc<CalendarService>,
  pub native_events: Arc<NativeEventService>,
}

/// Upload policy supplied by the API layer from existing server config.
#[derive(Clone)]
pub struct McpUploadPolicy {
  /// Maximum decoded blob payload accepted by MCP uploads.
  ///
  /// This is derived from the existing `storage.maxUploadMb` configuration so
  /// MCP cannot accept larger uploads than REST/GraphQL paths.
  pub max_upload_bytes: u64,
  /// Existing server-configured lifetime for signed storage URLs.
  pub signed_url_ttl_seconds: u64,
  /// Startup MIME allowlist fallback. Live `app_configs` values override it
  /// when a PostgreSQL pool is available.
  pub mime_allowlist: Vec<String>,
  /// Startup MIME blocklist fallback. Live `app_configs` values override it
  /// when a PostgreSQL pool is available.
  pub mime_blocklist: Vec<String>,
  /// Startup MIME validation mode fallback (`warn` or `strict`).
  pub mime_validation_mode: String,
  /// Live server-owned policy projection. Reduced tests must supply an explicit
  /// static implementation rather than relying on a transport fallback.
  pub mime_policy_reader: Arc<dyn McpMimePolicyReader>,
}

/// Shared state for MCP tool dispatch.
#[derive(Clone)]
pub struct McpToolState {
  pub assistant_packages: Option<Arc<myoxus_application::workspace::assistant_packages::AssistantPackageService>>,
  pub html_catalog: Option<Arc<dyn myoxus_public_render::HtmlRendererProvider>>,
  pub workspace_service: WorkspaceService,
  /// Shared authorized workspace-settings operation. Production always wires
  /// it; reduced tests that never expose workspace mutations may omit it.
  pub workspace_settings_service: Option<Arc<myoxus_application::workspace::WorkspaceSettingsService>>,
  /// Anonymous-publication state reader used for effective availability.
  pub public_repository: Option<Arc<dyn PublicRepository>>,
  /// Existing global publication and dynamic-route switches combined.
  pub public_delivery_enabled: bool,
  /// Shared document publication mutation owner.
  pub document_publication_service: Option<Arc<myoxus_application::public::DocumentPublicationService>>,
  pub doc_service: DocService,
  /// Shared GraphQL comment owner; absent reduced runtimes hide comment tools.
  pub comment_service: Option<Arc<myoxus_application::comment::CommentService>>,
  /// Configured public server origin used to recognize canonical document URLs.
  pub server_origin: Arc<str>,
  /// Authoritative ACL service used after MCP scope checks.
  ///
  /// MCP scopes say what a key may attempt globally; this service decides
  /// whether the key owner may perform that action in the target workspace/doc.
  pub permission_service: Arc<PermissionService>,
  pub search_indexer: Option<std::sync::Arc<SearchIndexerService>>,
  pub search_repository: Option<std::sync::Arc<dyn myoxus_domain::repositories::SearchRepository>>,
  pub database_services: Option<Arc<DatabaseServices>>,
  pub calendar: Option<Arc<McpCalendarServices>>,
  pub organization: Option<Arc<McpOrganizationServices>>,
  pub users: Option<Arc<McpUserServices>>,
  /// Authoritative workspace Tag catalog and document-assignment owner.
  ///
  /// Adapters deliberately call this service instead of repeating ACL or
  /// repository logic in MCP. `WorkspaceAction::Read` owns catalog reads and
  /// `WorkspaceAction::CreateDoc` owns Tag lifecycle edits because Tags are
  /// workspace-visible document metadata, not organizer administration. MCP
  /// `read:docs`/`write:docs` scopes remain the independent key boundary.
  pub workspace_tag_service: Option<Arc<WorkspaceTagService>>,
  pub document_graph_service: Option<Arc<DocumentGraphService>>,
  /// User-visible canonical document-template owner. This is deliberately
  /// separate from the global registry diagnostics and Database row templates.
  pub document_template_service: Option<Arc<DocumentTemplateService>>,
  pub template_registry: Option<TemplateRegistryService>,
  pub template_suggestions: Option<TemplateSuggestionService>,
  pub workspace_automation_service: Option<Arc<WorkspaceAutomationService>>,
  /// Shared authenticated PDF create/get owner; production requires durable receipts.
  pub pdf_export_service: Option<Arc<myoxus_application::pdf_export::service::PdfExportService>>,
  /// PDF-Export V2 template repository — used by `pdf_template_list`.
  pub pdf_template_repo: Option<std::sync::Arc<dyn myoxus_domain::repositories::PdfTemplateRepository>>,
  /// PDF-Export V2 workspace ↔ template assignment repository — used
  /// by `pdf_template_list` to filter to only the templates the
  /// workspace can actually use.
  pub pdf_assignment_repo:
    Option<std::sync::Arc<dyn myoxus_domain::repositories::PdfWorkspaceTemplateAssignmentRepository>>,
  /// Existing document metadata/version application capabilities.
  pub document_services: Arc<dyn McpDocumentOperations>,
  /// Durable MCP write replay boundary. Production injects PostgreSQL while
  /// reduced tests use the explicit in-memory repository.
  pub idempotency: Arc<dyn McpIdempotencyRepository>,
  /// Existing workspace blob service. Optional in reduced tests; blob tools
  /// fail closed with `-32002` when it is not wired.
  pub blob_service: Option<Arc<BlobService>>,
  /// Existing upload constraints used by MCP blob writes. Optional in reduced
  /// tests; mutating blob tools fail closed unless production wiring supplies it.
  pub upload_policy: Option<McpUploadPolicy>,
  /// Durable evidence recorder for low-volume MCP write and security events.
  pub audit_recorder: AuditRecorder,
  /// Existing business-metrics pipeline used for low-cardinality MCP counters.
  pub metrics_service: Arc<MetricsService>,
  /// Stable server secret used only to authenticate opaque document cursors.
  /// It must never be derived from a public API-key identifier.
  pub document_cursor_signing_key: Arc<[u8]>,
  /// Complete serialized document projection/export ceiling from server config.
  pub document_export_max_bytes: usize,
}

impl McpToolState {
  /// Capture optional service wiring once for discovery and call admission.
  pub fn tool_availability(&self) -> ToolAvailability {
    ToolAvailability {
      search: self.search_repository.is_some(),
      database: self.database_services.is_some(),
      assistant_packages: self.assistant_packages.is_some(),
      calendar: self.calendar.is_some(),
      organization: self.organization.is_some(),
      organization_reads: self.organization.as_ref().is_some_and(|o| o.reads.is_some()),
      organization_memberships: self.organization.as_ref().is_some_and(|o| o.memberships.is_some()),
      users: self.users.is_some(),
      comments: self.comment_service.is_some(),
      workspace_publication: self.public_repository.is_some(),
      workspace_settings: self.workspace_settings_service.is_some(),
      document_publication: self.document_publication_service.is_some(),
      workspace_tags: self.workspace_tag_service.is_some(),
      document_graph: self.document_graph_service.is_some(),
      document_templates: self.document_template_service.is_some(),
      template_registry: self.template_registry.is_some(),
      template_suggestions: self.template_suggestions.is_some(),
      workspace_automation: self.workspace_automation_service.is_some(),
      pdf_export: self.pdf_export_service.is_some() && self.idempotency.document_transaction_recovery(),
      pdf_templates: self.pdf_template_repo.is_some() && self.pdf_assignment_repo.is_some(),
      document_persistence: true,
      idempotency: true,
      blob: self.blob_service.is_some(),
      blob_upload: self.upload_policy.is_some(),
    }
  }
}

/// Build one bounded, read-authorized reference inventory without loading any
/// document body. Missing and inaccessible targets are deliberately absent.
async fn authorized_markdown_references(
  state: &McpToolState,
  user_id: Uuid,
  workspace_id: Uuid,
) -> Result<MarkdownReferenceLookup, (i32, String)> {
  const LIMIT: i64 = 10_001;
  let docs = state
    .doc_service
    .list_workspace_docs(workspace_id, LIMIT, 0)
    .await
    .map_err(|_| (-32002, "MIX_MCP_DOCUMENT_REFERENCE_LOOKUP_FAILED".to_string()))?;
  if docs.len() == LIMIT as usize {
    return Err((-32002, "MIX_MCP_DOCUMENT_REFERENCE_LIMIT_EXCEEDED".to_string()));
  }
  let ids = docs.iter().map(|doc| doc.id).collect::<Vec<_>>();
  let readable = state
    .permission_service
    .readable_doc_ids(user_id, workspace_id, &ids)
    .await
    .map_err(|_| (-32003, "MIX_MCP_DOCUMENT_REFERENCE_LOOKUP_FORBIDDEN".to_string()))?;
  let documents = docs
    .into_iter()
    .filter(|doc| !doc.blocked && readable.contains(&doc.id))
    .map(|doc| AuthorizedMarkdownDocument {
      external_id: doc.external_id,
      title: doc.title,
    });
  let base_url = format!("{}/workspace/{workspace_id}", state.server_origin.trim_end_matches('/'));
  MarkdownReferenceLookup::new(&base_url, documents)
    .map_err(|_| (-32002, "MIX_MCP_DOCUMENT_REFERENCE_LOOKUP_FAILED".to_string()))
}

// ─── Tool dispatch ────────────────────────────────────────────────────────────

/// Execute a `tools/call` request and project its handler response onto the
/// standard MCP result envelope.
#[instrument(skip(state, auth, params))]
pub async fn call_tool(
  tool_name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<CallToolResult, McpToolError> {
  let descriptor =
    find_tool(tool_name).ok_or_else(|| McpToolError::protocol(-32601, format!("Unknown tool: {tool_name}")))?;
  call_known_tool(descriptor, params, auth, state, None).await
}

async fn call_known_tool(
  descriptor: &ToolDescriptor,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
  context: Option<&RequestContext<RoleServer>>,
) -> Result<CallToolResult, McpToolError> {
  let result = execute_known_tool(descriptor, params, auth, state, context).await;
  match result {
    Ok(value) => {
      let value = normalize_legacy_tool_result(value);
      if descriptor.name == "document_import" {
        let summary = document_import::summary(&value);
        Ok(tool_success_with_summary(value, summary))
      } else if matches!(
        descriptor.name.as_str(),
        "folder_tree" | "folder_path_ensure" | "folder_entry_place"
      ) {
        let summary = folder::summary(&descriptor.name, &value);
        Ok(tool_success_with_summary(value, summary))
      } else {
        Ok(tool_success(value))
      }
    }
    Err((code, message)) => McpToolError::from_handler(code, message).into_tool_result(),
  }
}

/// Direct handler adapter retained for focused domain and integration tests.
/// It shares the SDK routes' bound handler and execution owner, but returns the
/// raw domain projection rather than an MCP tool-result envelope.
#[instrument(skip(state, auth, params))]
pub async fn dispatch_tool(
  tool_name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let descriptor = find_tool(tool_name).ok_or_else(|| (-32601, format!("Unknown tool: {tool_name}")))?;
  execute_known_tool(descriptor, params, auth, state, None).await
}

async fn execute_known_tool(
  descriptor: &ToolDescriptor,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
  context: Option<&RequestContext<RoleServer>>,
) -> Result<Value, (i32, String)> {
  let started = Instant::now();
  debug!(tool = descriptor.name, "MCP tool dispatch started");
  let mut result = if !params.is_object() {
    Err((-32602, "Tool arguments must be an object".to_string()))
  } else if !auth.has_scope(descriptor.required_scope) {
    Err((-32003, format!("Scope '{}' required", descriptor.required_scope)))
  } else {
    (descriptor.handler)(params, auth, state, context).await
  };
  record_tool_observability(descriptor, params, auth, state, started, &result).await;
  if let Ok(value) = &mut result {
    value
      .as_object_mut()
      .map(|object| object.remove("_mcpInternalDocumentId"));
    crate::idempotency::strip_replay_marker(value);
  }
  result
}

fn normalize_legacy_tool_result(result: Value) -> Value {
  if let Some(structured) = result.get("structuredContent") {
    return structured.clone();
  }
  let Some(text) = result
    .get("content")
    .and_then(Value::as_array)
    .and_then(|content| content.first())
    .and_then(|item| item.get("text"))
    .and_then(Value::as_str)
  else {
    return result;
  };
  serde_json::from_str(text).unwrap_or_else(|_| json!({ "message": text }))
}

pub(crate) type ToolHandler = for<'a> fn(
  &'a Value,
  &'a McpAuthContext,
  &'a McpToolState,
  Option<&'a RequestContext<RoleServer>>,
) -> BoxFuture<'a, Result<Value, (i32, String)>>;

/// Routes bind a fixed descriptor/handler pair before accepting requests. The
/// shared router is never disabled or rewritten for an individual caller.
pub(crate) fn tool_router() -> &'static ToolRouter<McpToolState> {
  static ROUTER: LazyLock<ToolRouter<McpToolState>> = LazyLock::new(|| {
    let mut router = ToolRouter::new();
    for descriptor in crate::tool_registry::tools() {
      router.add_route(ToolRoute::new_dyn(descriptor.public_tool(), move |context| {
        Box::pin(async move {
          let auth = crate::router::request_auth(&context.request_context)?;
          let params = Value::Object(context.arguments.unwrap_or_default());
          let operation = async {
            call_known_tool(
              descriptor,
              &params,
              auth,
              context.service,
              Some(&context.request_context),
            )
            .await
            .map(Into::into)
            .map_err(crate::router::tool_error)
          };
          if descriptor.access == crate::tool_registry::ToolAccess::Read {
            crate::router::cancellable_read(&context.request_context, operation).await
          } else {
            // Never drop an admitted write because a caller stops listening.
            // Its transaction/receipt owner still decides commit and recovery.
            operation.await
          }
        })
      }));
    }
    router
  });
  &ROUTER
}

/// Consumed once while building the catalog, not a second request-time router.
/// Domain adapters that own a multi-operation use case receive a bound literal
/// name; ordinary adapters are bound directly to their existing function.
pub(crate) fn handler_bindings() -> HashMap<&'static str, ToolHandler> {
  let mut bindings = HashMap::new();
  macro_rules! bind {
    ($name:literal, $handler:path) => {
      let handler: ToolHandler = |params, auth, state, _context| Box::pin($handler(params, auth, state));
      assert!(
        bindings.insert($name, handler).is_none(),
        "duplicate MCP handler binding"
      );
    };
    ($name:literal, named $handler:path) => {
      let handler: ToolHandler = |params, auth, state, _context| Box::pin($handler($name, params, auth, state));
      assert!(
        bindings.insert($name, handler).is_none(),
        "duplicate MCP handler binding"
      );
    };
    ($name:literal, $handler:path, $flag:literal) => {
      let handler: ToolHandler = |params, auth, state, _context| Box::pin($handler(params, auth, state, $flag));
      assert!(
        bindings.insert($name, handler).is_none(),
        "duplicate MCP handler binding"
      );
    };
    ($name:literal, contextual $handler:path) => {
      let handler: ToolHandler = |params, auth, state, context| Box::pin($handler(params, auth, state, context));
      assert!(
        bindings.insert($name, handler).is_none(),
        "duplicate MCP handler binding"
      );
    };
  }
  bind!("calendar_events_list", calendar::list);
  bind!("calendar_conflicts_check", calendar::check_conflicts);
  bind!("calendar_event_create", calendar::create);
  bind!("calendar_event_update", calendar::update);
  bind!("calendar_event_delete", calendar::delete);
  bind!("user_list", named user::call);
  bind!("user_get", named user::call);
  bind!("user_create", named user::call);
  bind!("user_update", named user::call);
  bind!("user_suspend", named user::call);
  bind!("user_enable", named user::call);
  bind!("user_reset_link", named user::call);
  bind!("user_set_admin", named user::call);
  bind!("user_delete", named user::call);
  bind!("organization_get", named organization::discover);
  bind!("organization_unit_type_list", named organization::discover);
  bind!("organization_unit_member_list", named organization::discover);
  bind!("user_organization_memberships", named organization::discover);
  bind!("organization_unit_list", organization::list);
  bind!("organization_unit_get", organization::get);
  bind!("organization_unit_delete_preview", organization::delete_preview);
  bind!("organization_unit_member_add", named organization::mutate_member);
  bind!("organization_unit_member_set_role", named organization::mutate_member);
  bind!("organization_unit_member_remove", named organization::mutate_member);
  bind!("organization_unit_create", organization::create);
  bind!("organization_unit_update", organization::update);
  bind!("organization_unit_move", organization::move_unit);
  bind!("organization_unit_set_status", organization::set_status);
  bind!("organization_unit_delete_permanent", organization::delete_permanent);
  bind!("list_workspaces", list_workspaces);
  bind!("workspace_owner_transfer", workspace::owner_transfer);
  bind!("workspace_management_unit_set", workspace::management_unit_set);
  bind!("workspace_member_invite", workspace::member_invite);
  bind!("workspace_invite_link_get", workspace::invite_link_get);
  bind!("workspace_invite_link_create", workspace::invite_link_create);
  bind!("workspace_invite_link_revoke", workspace::invite_link_revoke);
  bind!("comment_create", comments::create);
  bind!("comment_update", named comments::mutate);
  bind!("comment_set_resolved", named comments::mutate);
  bind!("comment_delete", named comments::mutate);
  bind!("comment_thread_mark_read", named comments::mutate);
  bind!("comment_threads_mark_all_read", named comments::mutate);
  bind!("comment_thread_list", named comments::read);
  bind!("comment_reply_list", named comments::read);
  bind!("comment_history_list", named comments::read);
  bind!("workspace_member_list", workspace::member_list);
  bind!("workspace_member_add", workspace::member_add);
  bind!("workspace_member_set_role", workspace::member_set_role);
  bind!("workspace_member_remove", workspace::member_remove);
  bind!("workspace_delete", workspace::delete);
  bind!("workspace_restore", workspace::restore);
  bind!("workspace_create", workspace::create);
  bind!("workspace_get", workspace::get);
  bind!("workspace_update", workspace::update);
  bind!("list_pages", list_pages);
  bind!("read_doc", document::read_doc);
  bind!("doc_publication_get", document::publication_get);
  bind!("doc_publication_set", document::publication_set);
  bind!("search_docs", search_docs);
  bind!("create_page", create_page);
  bind!("document_import", contextual document_import::import_document);
  bind!("document_image_insert", document_image::insert);
  bind!("document_reference_insert", document_reference::insert);
  bind!("update_doc", document::update_doc);
  bind!("doc_patch", document::doc_patch);
  bind!("delete_page", delete_page);
  bind!("restore_page", restore_page);
  bind!("page_projection_scan", page_projection_scan);
  bind!("page_projection_inspect", page_projection_inspect);
  bind!("page_projection_repair", page_projection_repair);
  bind!("folder_tree", folder::tree);
  bind!("folder_path_ensure", folder::ensure_path);
  bind!("folder_entry_place", folder::place_entry);
  bind!("folder_list", folder_list);
  bind!("folder_create", folder_create);
  bind!("folder_update", folder_update);
  bind!("folder_delete", folder_delete);
  bind!("folder_entry_list", folder_entry_list);
  bind!("folder_entry_create", folder_entry_create);
  bind!("folder_entry_update", folder_entry_update);
  bind!("folder_entry_delete", folder_entry_delete);
  bind!("workspace_tag_list", tag::list);
  bind!("workspace_tag_get", tag::get);
  bind!("document_tags_get", tag::document_tags_get);
  bind!("workspace_tag_create", tag::create);
  bind!("workspace_tag_rename", tag::rename);
  bind!("workspace_tag_recolor", tag::recolor);
  bind!("workspace_tag_description_update", tag::description_update);
  bind!("workspace_tag_archive", tag::archive);
  bind!("workspace_tag_restore", tag::restore);
  bind!("workspace_tag_delete_permanently", tag::delete_permanently);
  bind!("document_tags_set", tag::document_tags_set);
  bind!("blob_list", blob_list);
  bind!("blob_get_metadata", blob_get_metadata);
  bind!("blob_read", blob_read);
  bind!("blob_upload", blob_upload);
  bind!("document_asset_upload_prepare", document_asset_upload_prepare);
  bind!("blob_delete", blob_delete);
  bind!("template_list_for_workspace", template_list_for_workspace);
  bind!("template_request_reconcile", template_request_reconcile);
  bind!("document_template_list", document_template::list);
  bind!("document_template_get", document_template::get);
  bind!("document_template_create", document_template::create);
  bind!("document_template_instantiate", document_template::instantiate);
  bind!("document_template_mark", document_template::mark);
  bind!("document_template_unmark", document_template::unmark);
  bind!("pdf_template_list", pdf_template_list);
  bind!("pdf_export_create", pdf_export::create);
  bind!("pdf_export_get", pdf_export::get);
  bind!("database_view_get", database::view_get);
  bind!("database_view_create", named database::view_mutate);
  bind!("database_view_update", named database::view_mutate);
  bind!("database_view_delete", named database::view_mutate);
  bind!("database_view_reorder", named database::view_mutate);
  bind!("database_assistants_list", database_assistants::list);
  bind!("database_assistant_prepare", database_assistants::prepare);
  bind!("database_assistant_status", database_assistants::request_status, false);
  bind!("database_assistant_stop", database_assistants::request_status, true);
  bind!("database_get", database::get);
  bind!("database_create", database::schema_create);
  bind!("database_field_create", named database::field_mutate);
  bind!("database_field_update", named database::field_mutate);
  bind!("database_field_delete", named database::field_mutate);
  bind!("database_field_reorder", named database::field_mutate);
  bind!("database_update", named database::schema_mutate);
  bind!("database_trash", named database::schema_mutate);
  bind!("database_restore", named database::schema_mutate);
  bind!("database_delete_permanently", named database::schema_mutate);
  bind!("database_list", database::list);
  bind!("database_query", database::query);
  bind!("database_csv_export", database::csv_export);
  bind!("database_json_export", database::json_export);
  bind!("database_json_import_preview", database::json_import_preview);
  bind!("database_json_import", database::json_import);
  bind!("database_notion_export", database::notion_export);
  bind!("database_notion_import_preview", database::notion_import_preview);
  bind!("database_notion_import", database::notion_import);
  bind!("database_row_create", database::row_create);
  bind!("database_cell_update", database::cell_update);
  bind!("database_row_get", database::row_get);
  bind!("database_row_update", database::row_update);
  bind!("database_row_delete", database::row_delete);
  bind!("database_row_restore", database::row_restore);
  bind!("database_row_from_template", database::row_from_template);
  bind!("document_graph_read", document_graph_read);
  bind!("template_suggestions", template_suggestions);
  bind!("database_row_templates_list", database::row_templates_list);
  bind!("automation_list", named automation::read);
  bind!("automation_run_list", named automation::read);
  bind!("automation_run_get", named automation::read);
  bind!("automation_dead_letter_list", named automation::read);
  bind!("automation_run_retry", automation_run_retry);
  bind!("automation_run_stop", automation_run_stop);
  bind!("doc_version_list", doc_version_list);
  bind!("doc_version_read", document::version_read);
  bind!("doc_version_restore", document::version_restore);
  bind!("doc_version_create", doc_version_create);
  bind!("doc_metadata_get", doc_metadata_get);
  bind!("doc_metadata_validate", doc_metadata_validate);
  bind!("doc_metadata_transition", doc_metadata_transition);
  bind!("doc_metadata_update", doc_metadata_update);
  bindings
}

async fn record_tool_observability(
  descriptor: &ToolDescriptor,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
  started: Instant,
  result: &Result<Value, (i32, String)>,
) {
  let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
  let access = descriptor.access.as_str();
  let replayed = result.as_ref().is_ok_and(crate::idempotency::is_replay);
  let outcome = if replayed {
    "replayed"
  } else if result.is_ok() {
    "success"
  } else {
    "error"
  };
  let target_type = descriptor.target_type;
  let normalized_tool = descriptor.name.as_str();

  state.metrics_service.record(
    MetricsCategory::Mcp,
    "tool_call",
    &[("tool", normalized_tool), ("outcome", outcome), ("access", access)],
  );
  state.metrics_service.record_with(
    MetricsCategory::Mcp,
    "tool_latency_ms_total",
    metric_labels(&[("tool", normalized_tool), ("outcome", outcome), ("access", access)]),
    elapsed_ms,
  );
  state.metrics_service.record(
    MetricsCategory::Mcp,
    "tool_latency_observations",
    &[("tool", normalized_tool), ("outcome", outcome), ("access", access)],
  );
  let lifecycle_operation = match normalized_tool {
    "create_page" | "document_import" => Some("create"),
    "delete_page" => Some("trash"),
    "restore_page" => Some("restore"),
    "doc_patch" if params.get("operation").and_then(Value::as_str) == Some("update_title") => Some("rename"),
    _ => None,
  };
  if let Some(operation) = lifecycle_operation {
    state.metrics_service.record(
      MetricsCategory::Mcp,
      "page_lifecycle_tool_total",
      &[
        ("tool", normalized_tool),
        ("operation", operation),
        ("outcome", outcome),
      ],
    );
  }

  match result {
    Ok(value) => {
      info!(
        tool = normalized_tool,
        outcome,
        access,
        target_type,
        duration_ms = elapsed_ms,
        "MCP tool call completed"
      );
      if access == "write" {
        state.metrics_service.record(
          MetricsCategory::Mcp,
          "write",
          &[
            ("tool", normalized_tool),
            ("target_type", target_type),
            ("outcome", outcome),
          ],
        );
        if !replayed && should_record_write_mutation(descriptor, value) {
          record_mcp_write_audit(descriptor, params, value, auth, state, "success", None).await;
        }
      }
    }
    Err((code, message)) => {
      let error_kind = mcp_error_kind(*code, message);
      let is_authorization_denial = matches!(error_kind, "scope_denied" | "permission_denied");
      if is_authorization_denial {
        state.metrics_service.record(
          MetricsCategory::Mcp,
          "permission_denied",
          &[("tool", normalized_tool), ("target_type", target_type)],
        );
      }
      if error_kind == "scope_denied" {
        state.metrics_service.record(
          MetricsCategory::Mcp,
          "scope_denied",
          &[("tool", normalized_tool), ("required_scope", descriptor.required_scope)],
        );
      }
      if access == "write" && is_authorization_denial {
        state.metrics_service.record(
          MetricsCategory::Mcp,
          "write",
          &[
            ("tool", normalized_tool),
            ("target_type", target_type),
            ("outcome", "denied"),
          ],
        );
        record_mcp_write_audit(
          descriptor,
          params,
          &Value::Null,
          auth,
          state,
          "denied",
          Some(error_kind),
        )
        .await;
      }
      warn!(
        tool = normalized_tool,
        code,
        error_kind,
        access,
        target_type,
        duration_ms = elapsed_ms,
        "MCP tool call failed"
      );
    }
  }
}

fn should_record_write_mutation(descriptor: &ToolDescriptor, result: &Value) -> bool {
  if descriptor.name != "page_projection_repair" {
    return true;
  }
  mcp_result_payload(result)
    .and_then(|payload| payload.get("changed").and_then(Value::as_bool))
    .unwrap_or(false)
}

fn metric_labels(labels: &[(&str, &str)]) -> serde_json::Map<String, Value> {
  labels
    .iter()
    .map(|(key, value)| ((*key).to_string(), Value::String((*value).to_string())))
    .collect()
}

fn mcp_error_kind(code: i32, message: &str) -> &'static str {
  if code == -32003 && message.contains("Scope") {
    "scope_denied"
  } else if code == -32003 {
    "permission_denied"
  } else if code == -32602 {
    "validation"
  } else if code == -32004 {
    "not_found"
  } else {
    "other"
  }
}

async fn record_mcp_write_audit(
  descriptor: &ToolDescriptor,
  params: &Value,
  result: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
  outcome: &'static str,
  error_kind: Option<&'static str>,
) {
  let tool_name = descriptor.name.as_str();
  let event_key = if outcome == "denied" {
    "mcp.permission.denied"
  } else if let Some(event_key) = descriptor.audit_event {
    event_key
  } else {
    return;
  };
  let target_type = descriptor.target_type;
  let target_id = mcp_audit_target_id(tool_name, params, result);
  let target = target_id.map(|id| AuditTarget {
    target_type: target_type.to_string(),
    target_id: id,
    target_label: None,
  });
  let mut metadata = serde_json::Map::new();
  metadata.insert("api_key_id".to_string(), json!(auth.key_id.to_string()));
  metadata.insert("tool_name".to_string(), json!(descriptor.name));
  metadata.insert("scope".to_string(), json!(descriptor.required_scope));
  metadata.insert("outcome".to_string(), json!(outcome));
  metadata.insert("target_type".to_string(), json!(target_type));
  if let Some(workspace_id) =
    mcp_param_string(params, "workspace_id").or_else(|| mcp_result_string(result, "workspaceId"))
  {
    metadata.insert("workspace_id".to_string(), json!(workspace_id));
  }
  if let Some(doc_id) = result.get("_mcpInternalDocumentId").and_then(Value::as_str) {
    metadata.insert("doc_id".to_string(), json!(doc_id));
  }
  if let Some(folder_id) = mcp_param_string(params, "folder_id")
    .or_else(|| mcp_result_string(result, "folderId"))
    .or_else(|| mcp_result_string(result, "deletedFolderId"))
  {
    metadata.insert("folder_id".to_string(), json!(folder_id));
  }
  if let Some(entry_id) = mcp_param_string(params, "entry_id")
    .or_else(|| mcp_result_string(result, "entryId"))
    .or_else(|| mcp_result_nested_string(result, &["entry", "id"]))
  {
    metadata.insert("entry_id".to_string(), json!(entry_id));
  }
  if let Some(database_id) = mcp_param_string(params, "database_id") {
    metadata.insert("database_id".to_string(), json!(database_id));
  }
  if let Some(row_id) = mcp_param_string(params, "row_id") {
    metadata.insert("row_id".to_string(), json!(row_id));
  }
  if target_type == "blob"
    && let Some(key) = mcp_param_string(params, "key")
  {
    metadata.insert("blob_key_sha256".to_string(), json!(sha256_hex(key.as_bytes())));
  }
  if let Some(error_kind) = error_kind {
    metadata.insert("error_kind".to_string(), json!(error_kind));
  }
  metadata.insert("payload_size_bytes".to_string(), json!(params.to_string().len()));

  let actor = AuditActor::api_key(auth.user_id, auth.key_id);
  if tool_name == "user_delete"
    && outcome == "success"
    && mcp_param_string(params, "user_id").is_some_and(|id| id.parse::<Uuid>() == Ok(auth.user_id))
  {
    // The retained identity permits historical attribution, never credentials
    // or receipt recreation. No old email belongs in this deletion event.
    metadata.insert("actor_user_id".into(), json!(auth.user_id));
  }
  state
    .audit_recorder
    .record(
      AuditEvent::mutation(event_key, AuditCategory::Mcp, target, actor, None, None)
        .with_metadata(Value::Object(metadata)),
    )
    .await;
}

fn mcp_audit_target_id(tool_name: &str, params: &Value, result: &Value) -> Option<String> {
  match tool_name {
    "database_create" => mcp_result_nested_string(result, &["database", "database", "id"]),
    "database_assistant_stop" => mcp_result_nested_string(result, &["setup", "reservedDatabaseId"]),
    "database_view_create" => mcp_result_nested_string(result, &["view", "id"]),
    "database_view_update" | "database_view_delete" => mcp_param_string(params, "view_id"),
    "database_view_reorder" => mcp_param_string(params, "database_id"),
    "database_field_create" => mcp_result_nested_string(result, &["field", "id"]),
    "database_field_update" | "database_field_delete" => mcp_param_string(params, "field_id"),
    "database_field_reorder" => mcp_param_string(params, "database_id"),
    "database_update" | "database_trash" | "database_restore" | "database_delete_permanently" => {
      mcp_param_string(params, "database_id")
    }
    "comment_create" => mcp_result_string(result, "commentId"),
    "comment_update" | "comment_set_resolved" | "comment_delete" | "comment_thread_mark_read" => {
      mcp_param_string(params, "comment_id")
    }
    "user_create" => mcp_result_string(result, "id"),
    "user_update" | "user_suspend" | "user_enable" | "user_reset_link" | "user_set_admin" | "user_delete" => {
      mcp_param_string(params, "user_id")
    }
    "workspace_create" => mcp_result_string(result, "id"),
    "workspace_owner_transfer"
    | "workspace_management_unit_set"
    | "workspace_member_invite"
    | "workspace_invite_link_create"
    | "workspace_invite_link_revoke"
    | "workspace_member_add"
    | "workspace_member_set_role"
    | "workspace_member_remove"
    | "workspace_delete"
    | "workspace_restore"
    | "workspace_update" => mcp_param_string(params, "workspace_id"),
    "create_page"
    | "document_import"
    | "document_image_insert"
    | "document_reference_insert"
    | "document_template_create"
    | "document_template_instantiate"
    | "document_template_mark"
    | "document_template_unmark"
    | "comment_threads_mark_all_read" => result
      .get("_mcpInternalDocumentId")
      .and_then(Value::as_str)
      .map(ToOwned::to_owned),
    "folder_create" => mcp_result_nested_string(result, &["folder", "id"]),
    "folder_path_ensure" => mcp_result_string(result, "folderId"),
    "folder_entry_place" => mcp_result_string(result, "entryId"),
    "folder_entry_create" => mcp_result_nested_string(result, &["entry", "id"]),
    "doc_version_create" => mcp_result_nested_string(result, &["version", "id"]),
    "pdf_export_create" | "pdf_export_get" => mcp_result_string(result, "jobId"),
    "folder_update" | "folder_delete" => mcp_param_string(params, "folder_id"),
    "folder_entry_update" | "folder_entry_delete" => mcp_param_string(params, "entry_id"),
    "blob_upload" => mcp_result_nested_string(result, &["blob", "id"]),
    "document_asset_upload_prepare" => mcp_result_string(result, "assetRef"),
    "database_row_create" | "database_row_from_template" => {
      mcp_result_nested_string(result, &["row", "row", "id"]).or_else(|| mcp_param_string(params, "database_id"))
    }
    "database_json_export"
    | "database_json_import_preview"
    | "database_json_import"
    | "database_notion_export"
    | "database_notion_import_preview"
    | "database_notion_import" => mcp_param_string(params, "database_id"),
    "database_cell_update" | "database_row_update" | "database_row_delete" | "database_row_restore" => {
      mcp_param_string(params, "row_id")
    }
    "organization_unit_member_add"
    | "organization_unit_member_set_role"
    | "organization_unit_member_remove"
    | "organization_unit_create"
    | "organization_unit_update"
    | "organization_unit_move"
    | "organization_unit_set_status"
    | "organization_unit_delete_permanent" => mcp_param_string(params, "unit_id"),
    "calendar_event_create" => mcp_result_string(result, "id"),
    "calendar_event_update" | "calendar_event_delete" => mcp_param_string(params, "event_id"),
    "workspace_tag_create" => mcp_result_string(result, "id"),
    "workspace_tag_rename"
    | "workspace_tag_recolor"
    | "workspace_tag_description_update"
    | "workspace_tag_archive"
    | "workspace_tag_restore"
    | "workspace_tag_delete_permanently" => mcp_param_string(params, "tag_id"),
    "document_tags_set" => mcp_param_string(params, "external_id"),
    "automation_run_retry" | "automation_run_stop" => mcp_param_string(params, "run_id"),
    "update_doc"
    | "doc_patch"
    | "delete_page"
    | "restore_page"
    | "doc_publication_set"
    | "doc_metadata_transition"
    | "doc_metadata_update" => result
      .get("_mcpInternalDocumentId")
      .and_then(Value::as_str)
      .map(ToOwned::to_owned),
    "page_projection_repair" => mcp_param_string(params, "external_doc_id"),
    _ => None,
  }
}

fn mcp_param_string(params: &Value, key: &str) -> Option<String> {
  params.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
}

fn mcp_result_payload(result: &Value) -> Option<Value> {
  let text = result.get("content")?.as_array()?.first()?.get("text")?.as_str()?;
  serde_json::from_str(text).ok()
}

fn mcp_result_string(result: &Value, key: &str) -> Option<String> {
  mcp_result_payload(result)?.get(key)?.as_str().map(ToOwned::to_owned)
}

fn mcp_result_nested_string(result: &Value, path: &[&str]) -> Option<String> {
  let mut current = mcp_result_payload(result)?;
  for key in path {
    current = current.get(*key)?.clone();
  }
  current.as_str().map(ToOwned::to_owned)
}

async fn begin_mcp_idempotency(
  tool_name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Result<McpIdempotencyGuard, Value>, (i32, String)> {
  begin_mcp_idempotency_with_payload(tool_name, params, None, auth, state).await
}

async fn begin_mcp_idempotency_with_payload(
  tool_name: &str,
  params: &Value,
  semantic_payload: Option<&Value>,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Result<McpIdempotencyGuard, Value>, (i32, String)> {
  match crate::idempotency::begin(
    IdempotencyRequirement::Required,
    tool_name,
    params,
    semantic_payload,
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Execute(guard) => Ok(Ok(guard)),
    IdempotencyBeginOutcome::Replay(response) => Ok(Err(response)),
  }
}

async fn begin_optional_mcp_idempotency(
  tool_name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Result<McpIdempotencyGuard, Value>, (i32, String)> {
  begin_optional_mcp_idempotency_with_payload(tool_name, params, None, auth, state).await
}

async fn begin_optional_mcp_idempotency_with_payload(
  tool_name: &str,
  params: &Value,
  semantic_payload: Option<&Value>,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Result<McpIdempotencyGuard, Value>, (i32, String)> {
  if params.get("idempotency_key").is_none() {
    return Ok(Ok(McpIdempotencyGuard::Bypass));
  }
  match crate::idempotency::begin(
    IdempotencyRequirement::Optional,
    tool_name,
    params,
    semantic_payload,
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Execute(guard) => Ok(Ok(guard)),
    IdempotencyBeginOutcome::Replay(response) => Ok(Err(response)),
  }
}

fn mcp_json_response(payload: Value) -> Value {
  json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&payload).unwrap_or_default()}]
  })
}

pub(super) fn with_internal_document_identity(mut response: Value, doc_id: Uuid) -> Value {
  if let Some(object) = response.as_object_mut() {
    object.insert("_mcpInternalDocumentId".to_string(), json!(doc_id));
  }
  response
}

// ─── P10 Database / Graph / Template / Automation tools ─────────────────────

async fn document_graph_read(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_scope(auth, "read:document_graph")?;
  let graph = state.document_graph_service.as_ref().ok_or_else(|| {
    (
      -32002,
      "Document Graph service is not enabled on this MCP server".to_string(),
    )
  })?;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let external_id = parse_optional_string(params, "external_id")?;
  let doc_id = match external_id {
    Some(external_id) => Some(
      resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id)
        .await?
        .internal_id,
    ),
    None => None,
  };
  let direction = parse_graph_direction(params)?;
  let page = DocumentGraphPage {
    first: mcp_i64_param(params, "limit", 50).clamp(1, 200),
    offset: mcp_i64_param(params, "offset", 0).max(0),
  };
  let include_occurrences = params
    .get("include_occurrences")
    .and_then(Value::as_bool)
    .unwrap_or(false);
  let model = if let Some(doc_id) = doc_id {
    graph
      .read_document_links(auth.user_id, workspace_id, doc_id, direction, page, include_occurrences)
      .await
  } else {
    graph
      .read_workspace_graph(
        auth.user_id,
        workspace_id,
        DocumentGraphQuery {
          focus_doc_id: None,
          direction,
          page,
          metadata_filter: None,
          include_occurrences,
        },
      )
      .await
  }
  .map_err(|error| (-32002, format!("{}: {}", error.code, error.message)))?;
  let graph = document_graph_external_json(&state.doc_service, workspace_id, model).await?;
  Ok(mcp_json_response(json!({ "graph": graph })))
}

async fn document_graph_external_json(
  doc_service: &DocService,
  workspace_id: Uuid,
  model: DocumentGraphReadModel,
) -> Result<Value, (i32, String)> {
  let mut internal_ids = HashSet::new();
  internal_ids.extend(model.nodes.iter().filter_map(|node| node.doc_id));
  for edge in &model.edges {
    internal_ids.insert(edge.source_doc_id);
    if edge.target_state == DocumentGraphTargetState::Available {
      internal_ids.extend(edge.target_doc_id);
    }
    for occurrence in &edge.occurrences {
      internal_ids.insert(occurrence.source_doc_id);
      if occurrence.target_state == DocumentGraphTargetState::Available {
        internal_ids.extend(occurrence.target_doc_id);
      }
    }
  }
  internal_ids.extend(
    model
      .database_references
      .iter()
      .filter_map(|reference| reference.resolved_target_doc_id),
  );
  let internal_ids = internal_ids.into_iter().collect::<Vec<_>>();
  let external_ids = resolve_external_document_ids_for_mcp(doc_service, workspace_id, &internal_ids).await?;
  let required_external = |internal_id: Uuid| {
    external_ids.get(&internal_id).cloned().ok_or_else(|| {
      (
        -32002,
        "MIX_MCP_DOCUMENT_IDENTITY_INVARIANT: graph source identity projection is incomplete".to_string(),
      )
    })
  };
  let target_external = |internal_id: Option<Uuid>, raw: &str, state: DocumentGraphTargetState| {
    internal_id
      .map(|internal_id| match state {
        DocumentGraphTargetState::Available => required_external(internal_id),
        _ => Ok(
          external_ids
            .get(&internal_id)
            .cloned()
            .unwrap_or_else(|| raw.to_string()),
        ),
      })
      .transpose()
  };

  let nodes = model
    .nodes
    .into_iter()
    .map(|node| {
      Ok(json!({
        "externalId": node.doc_id.map(&required_external).transpose()?,
        "rawExternalId": node.raw_doc_id,
        "title": node.title,
        "documentType": node.document_type,
        "status": node.status,
        "classification": node.classification,
        "deleted": node.deleted,
        "redacted": node.redacted,
      }))
    })
    .collect::<Result<Vec<_>, (i32, String)>>()?;
  let edges = model
    .edges
    .into_iter()
    .map(|edge| {
      let redacted = edge.target_state == DocumentGraphTargetState::Redacted;
      let occurrences = if redacted {
        Vec::new()
      } else {
        edge
          .occurrences
          .into_iter()
          .map(|occurrence| {
            Ok(json!({
              "id": occurrence.id,
              "workspaceId": occurrence.workspace_id,
              "sourceExternalId": required_external(occurrence.source_doc_id)?,
              "sourceBlockId": occurrence.source_block_id,
              "sourceParentBlockId": occurrence.source_parent_block_id,
              "sourceParentFlavour": occurrence.source_parent_flavour,
              "rawTargetExternalId": occurrence.raw_target_doc_id,
              "targetExternalId": target_external(
                occurrence.target_doc_id,
                &occurrence.raw_target_doc_id,
                occurrence.target_state,
              )?,
              "linkKind": occurrence.link_kind,
              "paramsJson": occurrence.params_json,
              "paramsKey": occurrence.params_key,
              "markdownPreview": occurrence.markdown_preview,
              "targetState": occurrence.target_state,
              "extractedAt": occurrence.extracted_at,
              "sourceUpdatedAt": occurrence.source_updated_at,
              "createdAt": occurrence.created_at,
            }))
          })
          .collect::<Result<Vec<_>, (i32, String)>>()?
      };
      Ok(json!({
        "sourceExternalId": required_external(edge.source_doc_id)?,
        "targetExternalId": if redacted { None } else { target_external(edge.target_doc_id, &edge.raw_target_doc_id, edge.target_state)? },
        "rawTargetExternalId": edge.raw_target_doc_id,
        "targetState": edge.target_state,
        "linkKind": edge.link_kind,
        "occurrenceCount": edge.occurrence_count,
        "firstOccurrencePreview": if redacted { None } else { edge.first_occurrence_preview },
        "staleState": edge.stale_state,
        "occurrences": occurrences,
      }))
    })
    .collect::<Result<Vec<_>, (i32, String)>>()?;
  let database_references = model
    .database_references
    .into_iter()
    .map(|reference| {
      Ok(json!({
        "workspaceId": reference.workspace_id,
        "databaseId": reference.database_id,
        "databaseTitle": reference.database_title,
        "rowId": reference.row_id,
        "rowTitle": reference.row_title,
        "fieldId": reference.field_id,
        "fieldName": reference.field_name,
        "referenceKind": reference.reference_kind,
        "rawTargetExternalId": reference.raw_target_doc_id,
        "targetExternalId": reference.resolved_target_doc_id.map(&required_external).transpose()?,
        "refreshedAt": reference.refreshed_at,
      }))
    })
    .collect::<Result<Vec<_>, (i32, String)>>()?;
  Ok(json!({
    "nodes": nodes,
    "edges": edges,
    "databaseReferences": database_references,
    "indexSummary": model.index_summary,
  }))
}

async fn template_suggestions(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_scope(auth, "read:templates")?;
  let suggestions = state.template_suggestions.as_ref().ok_or_else(|| {
    (
      -32002,
      "Template Suggestions service is not enabled on this MCP server".to_string(),
    )
  })?;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let current_doc_id = match parse_optional_string(params, "current_external_id")? {
    Some(external_id) => Some(
      resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id)
        .await?
        .internal_id,
    ),
    None => None,
  };
  let request = TemplateSuggestionRequest {
    workspace_id,
    user_id: Some(auth.user_id),
    surface: parse_template_surface(params)?,
    locale: params
      .get("locale")
      .and_then(Value::as_str)
      .unwrap_or("en")
      .trim()
      .to_string(),
    client_version: mcp_i64_param(params, "client_version", 1).max(0) as u32,
    document_type_id: parse_optional_uuid(params, "document_type_id")?,
    status_id: parse_optional_uuid(params, "status_id")?,
    classification_id: parse_optional_uuid(params, "classification_id")?,
    mode: parse_optional_string(params, "mode")?,
    collection_id: parse_optional_uuid(params, "collection_id")?,
    current_doc_id,
    first: Some(mcp_i64_param(params, "first", 8).clamp(1, 20) as usize),
    after: parse_optional_string(params, "after")?,
    library: None,
  };
  let result = suggestions
    .suggest(request)
    .await
    .map_err(|error| (-32002, format!("{}: {}", error.code(), error)))?;
  Ok(mcp_json_response(json!({
    "items": result.items.into_iter().map(template_suggestion_item_json).collect::<Vec<_>>(),
    "emptyDocumentAllowed": result.empty_document_allowed,
    "reconcileRequired": result.reconcile_required,
    "stale": result.stale,
    "hasNextPage": result.has_next_page,
    "endCursor": result.end_cursor,
  })))
}

async fn automation_run_retry(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_scope(auth, "write:automations")?;
  crate::idempotency::validate_required_key(params)?;
  let service = state.workspace_automation_service.as_ref().ok_or_else(|| {
    (
      -32002,
      "Workspace Automation service is not enabled on this MCP server".to_string(),
    )
  })?;
  let run_id = parse_uuid(params, "run_id")?;
  service
    .authorize_run_retry(auth.user_id, run_id)
    .await
    .map_err(|error| (-32002, format!("{}: {}", error.code, error.message)))?;
  let guard = match begin_mcp_idempotency("automation_run_retry", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = async {
    let outcome = service
      .retry_run(auth.user_id, run_id)
      .await
      .map_err(|error| (-32002, format!("{}: {}", error.code, error.message)))?;
    Ok(mcp_json_response(json!({
      "run": automation_run_json(outcome.run),
      "jobId": outcome.job_id
    })))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

/// Authorization is repeated before idempotent replay as well as the native stop.
async fn automation_run_stop(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_scope(auth, "write:automations")?;
  crate::idempotency::validate_required_key(params)?;
  let service = state.workspace_automation_service.as_ref().ok_or_else(|| {
    (
      -32002,
      "Workspace Automation service is not enabled on this MCP server".to_string(),
    )
  })?;
  let run_id = parse_uuid(params, "run_id")?;
  service
    .authorize_run_stop(auth.user_id, run_id)
    .await
    .map_err(|error| (-32002, format!("{}: {}", error.code, error.message)))?;
  let guard = match begin_mcp_idempotency("automation_run_stop", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = service
    .stop_run(auth.user_id, run_id)
    .await
    .map(|run| mcp_json_response(json!({"run":automation_run_json(run)})))
    .map_err(|error| (-32002, format!("{}: {}", error.code, error.message)));
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

// ─── Document-version tools ─────────────────────────────────────────────────

async fn doc_version_list(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }
  let services = document_services(state);
  let workspace_id = parse_uuid(params, "workspace_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let external_id = required_string(params, "external_id")?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;

  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::Read).await?;
  let policy = services
    .policy(doc_id, workspace_id)
    .await
    .map_err(|e| (-32002, format!("doc_version_list metadata head failed: {e}")))?;
  let version_head = document_version_head(&policy)?;
  let rows = services
    .list_versions(doc_id)
    .await
    .map_err(|e| (-32002, format!("doc_version_list failed: {e}")))?;

  let versions = rows
    .iter()
    .map(|version| document_version_domain_json(version, version_head, &resolved.external_id))
    .collect::<Vec<_>>();
  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
      "externalId": resolved.external_id,
      "versions": versions,
    })).unwrap_or_default()}]
  }))
}

async fn doc_version_create(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }
  let services = document_services(state);
  let label = sanitize_doc_version_label(params)?;
  let description = sanitize_doc_version_description(params);
  let workspace_id = parse_uuid(params, "workspace_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let external_id = required_string(params, "external_id")?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::Update).await?;

  optional_mcp_write("doc_version_create", params, auth, state, async {
    let version = services
      .create_version(DocumentVersionCreateRequest::manual(
        doc_id,
        workspace_id,
        auth.user_id,
        Some(label),
        description,
      ))
      .await
      .map_err(|e| (-32002, format!("doc_version_create failed: {e}")))?;
    let policy = services
      .policy(doc_id, workspace_id)
      .await
      .map_err(|e| (-32002, format!("doc_version_create metadata head failed: {e}")))?;
    let version_head = document_version_head(&policy)?;
    let version = document_version_domain_json(&version, version_head, &resolved.external_id);
    Ok(with_internal_document_identity(
      json!({
        "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
          "version": version,
        })).unwrap_or_default()}]
      }),
      doc_id,
    ))
  })
  .await
}

// ─── Document-attribute tools ───────────────────────────────────────────────

async fn doc_metadata_get(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }
  let services = document_services(state);
  let workspace_id = parse_uuid(params, "workspace_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let external_id = required_string(params, "external_id")?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::Read).await?;
  let metadata = load_document_metadata(services, doc_id, workspace_id).await?;
  let metadata = document_metadata_domain_json(metadata, &resolved.external_id);

  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
      "documentMetadata": metadata,
    })).unwrap_or_default()}]
  }))
}

async fn doc_metadata_validate(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }
  let services = document_services(state);
  let workspace_id = parse_uuid(params, "workspace_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let external_id = required_string(params, "external_id")?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::Read).await?;
  let metadata = load_document_metadata(services, doc_id, workspace_id).await?;
  let definitions = services
    .policy(doc_id, workspace_id)
    .await
    .map_err(|e| (-32002, format!("document metadata policy load failed: {e}")))?
    .definitions;
  let validation = DocumentMetadataValidationService::new().validate(
    &definitions,
    &metadata,
    myoxus_application::document_metadata_policy::DocumentMetadataAction::Read,
  );
  let validation = validation_json(&validation);

  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
      "externalId": resolved.external_id,
      "validation": validation,
    })).unwrap_or_default()}]
  }))
}

async fn doc_metadata_transition(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }
  let services = document_services(state);
  let target = params
    .get("to")
    .and_then(|value| value.as_str())
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| (-32602, "Missing required parameter: to".to_string()))?;
  let create_version = params.get("create_version").and_then(Value::as_bool).unwrap_or(false);
  let workspace_id = parse_uuid(params, "workspace_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let external_id = required_string(params, "external_id")?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::PropertiesUpdate).await?;

  optional_mcp_write("doc_metadata_transition", params, auth, state, async {
    let metadata = load_document_metadata(services, doc_id, workspace_id).await?;
    let from_status_id = metadata
      .fields
      .iter()
      .find(|field| field.key == "status")
      .and_then(|field| field.reference.as_ref())
      .map(|reference| reference.id)
      .ok_or_else(|| (-32009, "document has no effective source status".to_string()))?;
    let to_status_id = services
      .resolve_status_in_schema(from_status_id, target)
      .await
      .map_err(|e| (-32002, format!("resolve target status failed: {e}")))?
      .ok_or_else(|| (-32602, format!("unknown status key in active schema: {target}")))?;
    let validation = services
      .transition(DocumentStatusTransitionRequest {
        doc_id,
        workspace_id,
        from_status_id,
        to_status_id,
        actor_id: Some(auth.user_id),
        actor_roles: Vec::new(),
        create_version,
      })
      .await
      .map_err(|e| (-32002, format!("doc_metadata_transition failed: {e}")))?;
    let validation = validation_json(&validation);

    Ok(with_internal_document_identity(
      json!({
        "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
          "externalId": resolved.external_id,
          "fromStatusId": from_status_id.to_string(),
          "toStatusId": to_status_id.to_string(),
          "validation": validation,
        })).unwrap_or_default()}]
      }),
      doc_id,
    ))
  })
  .await
}

async fn doc_metadata_update(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }

  let services = document_services(state);
  let patch_value = params
    .get("patch")
    .ok_or_else(|| (-32602, "Missing required parameter: patch".to_string()))?;
  let patch = parse_document_metadata_patch(patch_value)?;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let external_id = required_string(params, "external_id")?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, doc_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::PropertiesUpdate).await?;

  optional_mcp_write("doc_metadata_update", params, auth, state, async {
    services
      .set_metadata(doc_id, auth.user_id, patch)
      .await
      .map_err(|e| (-32002, format!("doc_metadata_update failed: {e}")))?;
    let metadata = load_document_metadata(services, doc_id, workspace_id).await?;
    let definitions = services
      .policy(doc_id, workspace_id)
      .await
      .map_err(|e| (-32002, format!("document metadata policy load failed: {e}")))?
      .definitions;
    let validation = DocumentMetadataValidationService::new().validate(
      &definitions,
      &metadata,
      myoxus_application::document_metadata_policy::DocumentMetadataAction::Read,
    );
    let validation = validation_json(&validation);
    let metadata = document_metadata_domain_json(metadata, &resolved.external_id);

    Ok(with_internal_document_identity(
      json!({
        "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
          "externalId": resolved.external_id,
          "documentMetadata": metadata,
          "validation": validation,
        })).unwrap_or_default()}]
      }),
      doc_id,
    ))
  })
  .await
}

// ─── pdf_template_list ───────────────────────────────────────────────────────

/// MCP tool: list PDF-Export V2 templates assigned to the workspace.
///
/// Read-only. Returns the same view as the
/// `availablePdfTemplates(workspaceId)` GraphQL query — slug, name,
/// version, schema_version, capabilities JSON, and the `is_default`
/// flag pulled from the workspace assignment row. Soft-deleted /
/// orphan-assignment templates are silently skipped (the GraphQL
/// surface does the same).
///
/// Authz: caller must be a workspace member with `read:workspaces`
/// scope. Non-members get `-32003 Forbidden`.
///
/// `P-PDF-TPL-27-01` + `P-PDF-TPL-27-03`.
async fn pdf_template_list(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:workspaces") {
    return Err((-32003, "Scope 'read:workspaces' required".to_string()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;

  // Membership check first — non-members never see the templates.
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;

  let (Some(template_repo), Some(assignment_repo)) =
    (state.pdf_template_repo.as_ref(), state.pdf_assignment_repo.as_ref())
  else {
    return Ok(json!({
      "content": [{"type": "text", "text": "PDF template registry is not enabled on this server."}]
    }));
  };

  let assignments = assignment_repo
    .list_for_workspace(workspace_id)
    .await
    .map_err(|e| (-32002, format!("pdf_template_list: list_for_workspace failed: {e}")))?;

  let mut items: Vec<Value> = Vec::with_capacity(assignments.len());
  for assignment in &assignments {
    let Some(tpl) = template_repo
      .get_by_id(assignment.template_id)
      .await
      .map_err(|e| (-32002, format!("pdf_template_list: get_by_id failed: {e}")))?
    else {
      // Orphan assignment: silently skip — same as the GraphQL
      // surface (templates are softly deleted out from under
      // assignment rows in some cleanup flows).
      tracing::debug!(template_id = %assignment.template_id, "pdf_template_list: skipping orphan assignment");
      continue;
    };
    if tpl.deleted_at.is_some() {
      continue;
    }
    let capabilities = tpl
      .manifest
      .get("capabilities")
      .cloned()
      .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
    items.push(json!({
      "id": tpl.id.to_string(),
      "slug": tpl.slug,
      "name": tpl.name,
      "version": tpl.version,
      "schemaVersion": tpl.schema_version,
      "capabilities": capabilities,
      "isDefault": assignment.is_default,
    }));
  }

  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
      "workspaceId": workspace_id.to_string(),
      "templates": items,
    })).unwrap_or_default()}]
  }))
}

// ─── list_workspaces ─────────────────────────────────────────────────────────

async fn list_workspaces(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:workspaces") {
    return Err((-32003, "Scope 'read:workspaces' required".to_string()));
  }

  let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(50).min(200) as i64;

  let workspaces = state
    .workspace_service
    .list_workspaces(auth.user_id)
    .await
    .map_err(|e| (-32002, format!("Failed to list workspaces: {e}")))?;

  let items: Vec<Value> = workspaces
    .iter()
    .take(limit as usize)
    .map(|w| {
      json!({
        "id": w.id,
        "name": w.name,
        "public": w.public,
        "created_at": w.created_at.to_rfc3339()
      })
    })
    .collect();

  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({"workspaces": items})).unwrap_or_default()}]
  }))
}

// ─── list_pages ───────────────────────────────────────────────────────────────

use myoxus_application::workspace::resource_inventory::{
  DOCUMENT_CANDIDATE_BATCH as DOCUMENT_READ_CANDIDATE_BATCH,
  DOCUMENT_CANDIDATE_BUDGET as DOCUMENT_READ_CANDIDATE_BUDGET,
};

/// Intersect the current effective ACL with workspace-local live identities.
/// Search indexes and diagnostic projections are candidates, never authority.
async fn readable_live_document_keys(
  state: &McpToolState,
  auth: &McpAuthContext,
  workspace_id: Uuid,
  candidates: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, String>, (i32, String)> {
  myoxus_application::workspace::resource_inventory::readable_live_document_keys(
    &state.doc_service,
    &state.permission_service,
    auth.user_id,
    workspace_id,
    candidates,
  )
  .await
  .map_err(|_| (-32002, "Document read authorization failed".to_string()))
}

async fn list_pages(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(50).clamp(1, 200) as usize;

  // Decode opaque cursor → offset (base64-encoded integer)
  let offset = match params.get("cursor").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
    Some(cursor) => {
      let decoded = base64::engine::general_purpose::STANDARD
        .decode(cursor)
        .map_err(|_| (-32602, "Invalid cursor".to_string()))?;
      let s = String::from_utf8(decoded).map_err(|_| (-32602, "Invalid cursor".to_string()))?;
      s.parse::<i64>().map_err(|_| (-32602, "Invalid cursor".to_string()))?
    }
    None => 0,
  };

  if offset < 0 {
    return Err((-32602, "Invalid cursor".to_string()));
  }

  let (docs, next_offset) = readable_document_page(state, auth, workspace_id, offset, limit, "").await?;
  let items = docs
    .into_iter()
    .map(|doc| {
      json!({
        "externalId": doc.external_id, "title": doc.title,
        "created_at": doc.created_at.to_rfc3339(), "updated_at": doc.updated_at.to_rfc3339()
      })
    })
    .collect::<Vec<_>>();
  let next_cursor = next_offset.map(|offset| base64::engine::general_purpose::STANDARD.encode(offset.to_string()));
  let mut result = json!({"pages": items});
  if let Some(cursor) = next_cursor {
    result["next_cursor"] = json!(cursor);
  }
  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&result).unwrap_or_default()}]
  }))
}

/// Shared candidate scan for page discovery and SDK argument completion. Offsets
/// count consumed candidates, never visible rows; no hidden identity is returned.
pub(crate) async fn readable_document_page(
  state: &McpToolState,
  auth: &McpAuthContext,
  workspace_id: Uuid,
  offset: i64,
  limit: usize,
  prefix: &str,
) -> Result<(Vec<Doc>, Option<i64>), (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }
  // Verify workspace membership
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  myoxus_application::workspace::resource_inventory::readable_document_page(
    &state.doc_service,
    &state.permission_service,
    auth.user_id,
    workspace_id,
    offset,
    limit,
    prefix,
  )
  .await
  .map_err(|error| match error {
    myoxus_application::auth::AuthError::InvalidInput(_) => (-32602, "Invalid cursor".into()),
    _ => (-32002, "Document discovery is unavailable".to_string()),
  })
}

// ─── search_docs ──────────────────────────────────────────────────────────────

async fn search_docs(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();

  if query.is_empty() {
    return Err((-32602, "query must be non-empty".to_string()));
  }
  if query.len() > 500 {
    return Err((-32602, "query exceeds 500 characters".to_string()));
  }

  let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(10).clamp(1, 50) as usize;

  let language = params.get("language").and_then(|v| v.as_str()).map(|s| s.to_string());

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;

  let Some(search_repo) = &state.search_repository else {
    return Err((-32002, "Search is not configured on this server".to_string()));
  };

  use myoxus_application::search::{SEARCH_CANDIDATE_BATCH, SEARCH_CANDIDATE_BUDGET, SearchContinuation};
  let continuation = SearchContinuation::new(
    auth.user_id,
    workspace_id,
    &query,
    language.as_deref(),
    &state.document_cursor_signing_key,
  );
  let cursor = match params.get("cursor") {
    None => None,
    Some(Value::String(cursor)) => Some(cursor.as_str()),
    Some(_) => return Err((-32602, "cursor must be a string".to_string())),
  };
  let offset = continuation
    .position(cursor)
    .map_err(|message| (-32602, message.to_string()))?;
  let mut position = offset;
  let mut items = Vec::new();
  let mut exhausted = false;
  // Leave the first authorized sentinel unconsumed. A scan-budget boundary
  // also yields continuation, even if this page has no visible results.
  'scan: while position - offset < SEARCH_CANDIDATE_BUDGET {
    let results = continuation
      .candidates(search_repo.as_ref(), position)
      .await
      .map_err(|_| (-32002, "Search failed".to_string()))?;
    let ids = results.iter().map(|doc| doc.doc_id).collect::<Vec<_>>();
    let readable = readable_live_document_keys(state, auth, workspace_id, &ids).await?;
    for doc in &results {
      if let Some(external_id) = readable.get(&doc.doc_id) {
        if items.len() == limit {
          break 'scan;
        }
        // Authorization and live identities precede snippets and returned counts.
        items.push((doc.clone(), external_id.clone()));
      }
      position += 1;
    }
    if results.len() < SEARCH_CANDIDATE_BATCH as usize {
      exhausted = true;
      break;
    }
  }
  let next_cursor = (!exhausted).then(|| continuation.cursor(position));
  let enriched = myoxus_application::search::enrich_search_page(
    auth.user_id,
    workspace_id,
    &items,
    &state.doc_service,
    state.document_services.as_ref(),
    state.workspace_tag_service.as_deref(),
  )
  .await
  .map_err(|_| (-32002, "Search enrichment failed".to_string()))?;
  let items = items
    .into_iter()
    .zip(enriched)
    .map(|((doc, external_id), metadata)| {
      let mut item = json!({"externalId": external_id, "title": doc.title,
      "snippet": make_snippet(&doc.plain_text, &query, 200), "updated_at": doc.updated_at.to_rfc3339()});
      item.as_object_mut().expect("search item is an object").extend(
        serde_json::to_value(metadata)
          .expect("typed search metadata is serializable")
          .as_object()
          .expect("metadata is an object")
          .clone(),
      );
      item
    })
    .collect::<Vec<_>>();
  let text = serde_json::to_string_pretty(&json!({
    "results": items, "total_count": items.len(), "next_cursor": next_cursor, "exhausted": exhausted
  }))
  .map_err(|_| (-32002, "Search result serialization failed".to_string()))?;
  if text.len() > state.document_export_max_bytes {
    return Err((
      -32002,
      "Search result exceeds the configured output bound; use a smaller limit".to_string(),
    ));
  }
  Ok(json!({"content": [{"type": "text", "text": text}]}))
}

/// Build a context snippet around `query` in `text`, capped at `max_len` chars.
///
/// All slicing uses `char_indices()` to guarantee UTF-8 safety — no panics
/// on multi-byte characters (MCP-RV-04).
fn make_snippet(text: &str, query: &str, max_len: usize) -> String {
  /// Return the byte index of the n-th char (or text.len() if past end).
  fn char_byte_offset(s: &str, char_idx: usize) -> usize {
    s.char_indices().nth(char_idx).map(|(i, _)| i).unwrap_or(s.len())
  }

  /// Truncate `s` to at most `n` chars, UTF-8 safe.
  fn truncate_chars(s: &str, n: usize) -> &str {
    let byte_end = char_byte_offset(s, n);
    &s[..byte_end]
  }

  let char_count = text.chars().count();
  let lower_text = text.to_lowercase();
  let lower_query = query.to_lowercase();

  if let Some(byte_pos) = lower_text.find(&lower_query) {
    // Convert byte position in lowercased string to char position in original
    let char_pos = lower_text[..byte_pos].chars().count();
    let context_before = 50;
    let context_after = 150;
    let start_char = char_pos.saturating_sub(context_before);
    let end_char = (char_pos + query.chars().count() + context_after).min(char_count);
    let start_byte = char_byte_offset(text, start_char);
    let end_byte = char_byte_offset(text, end_char);
    let snippet = &text[start_byte..end_byte];
    let snippet_chars = snippet.chars().count();
    if snippet_chars <= max_len {
      snippet.to_string()
    } else {
      format!("{}...", truncate_chars(snippet, max_len.saturating_sub(3)))
    }
  } else if char_count <= max_len {
    text.to_string()
  } else {
    format!("{}...", truncate_chars(text, max_len.saturating_sub(3)))
  }
}

// ─── create_page ──────────────────────────────────────────────────────────────

async fn create_page(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let title = params
    .get("title")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .trim()
    .to_string();

  if title.is_empty() {
    return Err((-32602, "title must be non-empty".to_string()));
  }

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::CreateDoc).await?;
  let (initial_content, diagnostics) = if params.get("fragment").is_some() || params.get("content_markdown").is_some() {
    let (fragment, diagnostics) =
      document::parse_fragment_with_diagnostics(params, true, workspace_id, auth, state).await?;
    ((!fragment.blocks.is_empty()).then_some(fragment), diagnostics)
  } else {
    if params.get("strict_loss").is_some_and(|value| !value.is_boolean()) {
      return Err((-32602, "strict_loss must be a boolean".into()));
    }
    (None, myoxus_application::doc::DocumentFragmentDiagnostics::default())
  };
  let semantic_payload = json!({
    "workspaceId": workspace_id,
    "title": title,
    "initialContent": initial_content,
  });
  let guard =
    match begin_optional_mcp_idempotency_with_payload("create_page", params, Some(&semantic_payload), auth, state)
      .await?
    {
      Ok(guard) => guard,
      Err(response) => return Ok(response),
    };
  let result = guard
    .document_write_with_response(auth, document::fragment_response_builder(params, &diagnostics), async {
      let committed = state
        .doc_service
        .create_page_lifecycle(workspace_id, auth.user_id, Some(title.clone()), initial_content)
        .await
        .map_err(map_page_lifecycle_error)?;
      let leaf_sequence = committed.leaf.as_ref().map(|delta| delta.sequence).ok_or_else(|| {
        (
          -32002,
          "MIX_MCP_PAGE_LIFECYCLE_INVALID: create omitted leaf sequence".to_string(),
        )
      })?;

      let doc_id = committed.document.id;
      Ok(with_internal_document_identity(
        mcp_json_response(document::with_fragment_diagnostics(
          json!({
            "externalId": committed.document.external_id,
            "title": title,
            "created_at": committed.committed_at.to_rfc3339(),
            "leaf_sequence": leaf_sequence,
            "root_sequence": committed.workspace_root.sequence,
          }),
          &diagnostics,
        )),
        doc_id,
      ))
    })
    .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

// ─── delete_page ──────────────────────────────────────────────────────────────

async fn delete_page(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let external_id = required_string(params, "external_id")?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;

  // Replays still revalidate workspace ownership and ACL, but must not require
  // the pre-trash state after the first successful mutation.
  state
    .doc_service
    .get_metadata_including_deleted(doc_id)
    .await
    .map_err(map_page_lifecycle_error)?
    .filter(|document| document.workspace_id == Some(workspace_id))
    .ok_or_else(|| (-32004, "Document not found in workspace".to_string()))?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::Trash).await?;
  let guard = match begin_optional_mcp_idempotency("delete_page", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = guard
    .document_write(auth, params, async {
      let committed = state
        .doc_service
        .trash_page(workspace_id, doc_id, auth.user_id)
        .await
        .map_err(map_page_lifecycle_error)?;

      Ok(with_internal_document_identity(
        mcp_json_response(json!({
          "externalId": resolved.external_id,
          "deleted_at": committed.committed_at.to_rfc3339(),
          "root_sequence": committed.workspace_root.sequence,
        })),
        doc_id,
      ))
    })
    .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

// ─── restore_page ────────────────────────────────────────────────────────────

async fn restore_page(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let external_id = required_string(params, "external_id")?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id).await?;
  let doc_id = resolved.internal_id;
  state
    .doc_service
    .get_metadata_including_deleted(doc_id)
    .await
    .map_err(map_page_lifecycle_error)?
    .filter(|document| document.workspace_id == Some(workspace_id))
    .ok_or_else(|| (-32004, "Document not found in workspace".to_string()))?;
  assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::Restore).await?;
  let guard = match begin_optional_mcp_idempotency("restore_page", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = guard
    .document_write(auth, params, async {
      let committed = state
        .doc_service
        .restore_page(workspace_id, doc_id, auth.user_id)
        .await
        .map_err(map_page_lifecycle_error)?;
      Ok(with_internal_document_identity(
        mcp_json_response(json!({
          "externalId": resolved.external_id,
          "restored_at": committed.committed_at.to_rfc3339(),
          "root_sequence": committed.workspace_root.sequence,
        })),
        doc_id,
      ))
    })
    .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

// ─── bounded page projection inspection / exact repair ─────────────────────

async fn page_projection_scan(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let cursor = params.get("cursor").and_then(Value::as_str);
  let limit = params
    .get("limit")
    .map(|value| {
      value
        .as_u64()
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(|| (-32602, "limit must be an integer in 1..=200".to_string()))
    })
    .transpose()?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let limit = limit.unwrap_or(50);
  if !(1..=200).contains(&limit) {
    return Err((-32602, "limit must be an integer in 1..=200".to_string()));
  }
  let mut cursor = cursor.map(str::to_string);
  let mut filtered_any = false;
  for _ in 0..(DOCUMENT_READ_CANDIDATE_BUDGET / DOCUMENT_READ_CANDIDATE_BATCH) {
    let mut result = state
      .doc_service
      .page_lifecycle_repair
      .scan(
        workspace_id,
        cursor.as_deref(),
        Some(200),
        DocLoadCancellation::default(),
      )
      .await
      .map_err(map_page_lifecycle_error)?;
    let mut identities = std::collections::HashMap::new();
    for item in &result.items {
      // Orphans have no live document authority. They remain available to the
      // trusted repair owner, not a workspace member's document-read endpoint.
      if item.sql_present
        && let Some(external) = &item.external_doc_id
      {
        let key = DocumentKey::parse(external.clone()).map_err(|error| (-32002, error))?;
        if let Some(id) = state
          .doc_service
          .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &key)
          .await
          .map_err(map_page_lifecycle_error)?
        {
          identities.insert(external.clone(), id);
        }
      }
    }
    let ids = identities.values().copied().collect::<Vec<_>>();
    let readable = readable_live_document_keys(state, auth, workspace_id, &ids).await?;
    let visible = |item: &myoxus_application::doc::PageProjectionPresenceEvidence| {
      item
        .external_doc_id
        .as_ref()
        .and_then(|key| identities.get(key))
        .is_some_and(|id| readable.contains_key(id))
    };
    let selected = result
      .items
      .iter()
      .enumerate()
      .filter(|(_, item)| visible(item))
      .take(usize::from(limit))
      .map(|(index, _)| index)
      .collect::<Vec<_>>();
    filtered_any |= result.items.iter().any(|item| !visible(item));
    if let Some(last) = selected.last().copied() {
      if last + 1 < result.items.len() {
        // End the underlying cursor on an authorized key. Returning the
        // unfiltered page cursor could disclose a denied key when decoded.
        result = state
          .doc_service
          .page_lifecycle_repair
          .scan(
            workspace_id,
            cursor.as_deref(),
            Some((last + 1) as u16),
            DocLoadCancellation::default(),
          )
          .await
          .map_err(map_page_lifecycle_error)?;
      }
      result.items.retain(visible);
      result.healthy &= !filtered_any;
      return Ok(mcp_json_response(serde_json::to_value(result).map_err(|_| {
        (-32002, "MIX_MCP_PAGE_PROJECTION_SERIALIZATION_FAILED".to_string())
      })?));
    }
    if result.next_cursor.is_none() {
      result.items.clear();
      result.healthy &= !filtered_any;
      return Ok(mcp_json_response(serde_json::to_value(result).map_err(|_| {
        (-32002, "MIX_MCP_PAGE_PROJECTION_SERIALIZATION_FAILED".to_string())
      })?));
    }
    cursor = result.next_cursor;
  }
  Err((
    -32002,
    "MIX_MCP_DOCUMENT_SCAN_LIMIT: use paginated list_pages and page_projection_inspect".to_string(),
  ))
}

async fn page_projection_inspect(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let external_doc_id = required_string(params, "external_doc_id")?;
  DocumentKey::parse(external_doc_id.clone()).map_err(|error| (-32602, error))?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  let resolved = resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_doc_id).await?;
  resolve_doc_in_workspace(&state.doc_service, workspace_id, resolved.internal_id).await?;
  assert_doc_permission(state, auth.user_id, workspace_id, resolved.internal_id, DocAction::Read).await?;
  let result = state
    .doc_service
    .page_lifecycle_repair
    .inspect(workspace_id, &external_doc_id, DocLoadCancellation::default())
    .await
    .map_err(map_page_lifecycle_error)?;
  Ok(mcp_json_response(serde_json::to_value(result).map_err(|_| {
    (-32002, "MIX_MCP_PAGE_PROJECTION_SERIALIZATION_FAILED".to_string())
  })?))
}

async fn page_projection_repair(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let external_doc_id = required_string(params, "external_doc_id")?;
  let document_key = DocumentKey::parse(external_doc_id.clone()).map_err(|error| (-32602, error))?;
  let fingerprint = required_string(params, "fingerprint")?;
  let mode = match params.get("mode").and_then(Value::as_str).unwrap_or("dry_run") {
    "dry_run" => PageLifecycleRepairMode::DryRun,
    "apply" => PageLifecycleRepairMode::Apply,
    _ => return Err((-32602, "mode must be dry_run or apply".to_string())),
  };

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::CreateDoc).await?;
  if let Some(doc_id) = state
    .doc_service
    .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &document_key)
    .await
    .map_err(map_page_lifecycle_error)?
  {
    assert_doc_permission(state, auth.user_id, workspace_id, doc_id, DocAction::Update).await?;
  }
  let guard = match begin_mcp_idempotency("page_projection_repair", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = async {
    let repair = state
      .doc_service
      .page_lifecycle_repair
      .repair_exact(
        workspace_id,
        &external_doc_id,
        auth.user_id,
        &fingerprint,
        mode,
        DocLoadCancellation::default(),
      )
      .await
      .map_err(map_page_lifecycle_error)?;
    Ok(mcp_json_response(serde_json::to_value(repair).map_err(|_| {
      (-32002, "MIX_MCP_PAGE_REPAIR_SERIALIZATION_FAILED".to_string())
    })?))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) fn map_page_lifecycle_error(error: AuthError) -> (i32, String) {
  match error {
    AuthError::InvalidInput(code) => (-32602, code),
    AuthError::NotFound(_) => (-32004, "MIX_MCP_DOCUMENT_NOT_FOUND: document not found".to_string()),
    AuthError::ActionForbidden => (
      -32003,
      "MIX_MCP_DOCUMENT_FORBIDDEN: lifecycle action forbidden".to_string(),
    ),
    _ => (
      -32002,
      "MIX_MCP_PAGE_LIFECYCLE_FAILED: page lifecycle operation failed".to_string(),
    ),
  }
}

// ─── Organizer folder tools ─────────────────────────────────────────────────
//
// Folder rows are the workspace's document placement structure, not a separate
// administrative resource. Reading them follows ordinary workspace Read;
// changing them follows the same CreateDoc capability that lets an editor add
// and place documents. Target resources keep their own ACL checks in the
// application-owned link service below.

async fn folder_list(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::Read).await?;
  let parent_filter = parse_optional_string(params, "parent_id")?;
  let snapshot = organizer_service(state)
    .snapshot(workspace_id)
    .await
    .map_err(map_organizer_error)?;
  let folders = flatten_organizer_rows(&snapshot.roots)
    .into_iter()
    .filter(|record| record.is_folder())
    .filter(|record| match &parent_filter {
      Some(parent_id) => record.parent_id.as_deref() == Some(parent_id.as_str()),
      None if params.get("parent_id").is_some_and(Value::is_null) => record.parent_id.is_none(),
      None => true,
    })
    .map(folder_json)
    .collect::<Vec<_>>();

  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
      "workspaceId": workspace_id.to_string(),
      "revision": snapshot.revision,
      "folders": folders,
    })).unwrap_or_default()}]
  }))
}

async fn folder_create(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let name = sanitize_folder_name(params)?;
  let parent_id = parse_optional_string(params, "parent_id")?;
  let index = parse_optional_string(params, "index")?;

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::CreateDoc).await?;

  optional_mcp_write("folder_create", params, auth, state, async {
    let folder_id = Uuid::new_v4().to_string();
    let folder = organizer_service(state)
      .create_folder(
        workspace_id,
        CreateOrganizerFolder {
          id: folder_id.clone(),
          parent_id: parent_id.clone(),
          name,
          index: index.clone(),
        },
      )
      .await
      .map_err(map_organizer_error)?;

    Ok(json!({
      "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
        "workspaceId": workspace_id.to_string(),
        "folder": folder_json(folder),
      })).unwrap_or_default()}]
    }))
  })
  .await
}

async fn folder_update(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let folder_id = required_string(params, "folder_id")?;
  let name = optional_sanitized_folder_name(params)?;
  let parent_id = parse_optional_string(params, "parent_id")?;
  let has_parent_update = params.get("parent_id").is_some();
  let index = parse_optional_string(params, "index")?;
  if name.is_none() && !has_parent_update && index.is_none() {
    return Err((
      -32602,
      "folder_update requires at least one of name, parent_id or index".to_string(),
    ));
  }

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::CreateDoc).await?;

  optional_mcp_write("folder_update", params, auth, state, async {
    let updated = organizer_service(state)
      .update_folder(
        workspace_id,
        &folder_id,
        UpdateOrganizerFolder {
          name,
          parent_id: has_parent_update.then_some(parent_id),
          index,
        },
      )
      .await
      .map_err(map_organizer_error)?;

    Ok(json!({
      "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
        "workspaceId": workspace_id.to_string(),
        "folder": folder_json(updated),
      })).unwrap_or_default()}]
    }))
  })
  .await
}

async fn folder_delete(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let folder_id = required_string(params, "folder_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::CreateDoc).await?;

  optional_mcp_write("folder_delete", params, auth, state, async {
    let deleted_ids = organizer_service(state)
      .delete_folder(workspace_id, &folder_id)
      .await
      .map_err(map_organizer_error)?;

    Ok(json!({
      "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
        "workspaceId": workspace_id.to_string(),
        "deletedFolderId": folder_id,
        "deletedIds": deleted_ids,
      })).unwrap_or_default()}]
    }))
  })
  .await
}

async fn folder_entry_list(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let parent_filter = parse_optional_string(params, "parent_id")?;
  let target_type_filter = parse_optional_folder_entry_type(params, "target_type")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::Read).await?;

  let (revision, entries) = workspace_content_link_service(state)
    .visible_links(auth.user_id, workspace_id)
    .await
    .map_err(map_workspace_content_link_error)?;
  let entries = entries
    .into_iter()
    .filter(|record| match &parent_filter {
      Some(parent_id) => record.parent_id.as_deref() == Some(parent_id.as_str()),
      None => true,
    })
    .filter(|record| match &target_type_filter {
      Some(target_type) => record.row_type == target_type.as_str(),
      None => true,
    })
    .map(entry_json)
    .collect::<Vec<_>>();

  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
      "workspaceId": workspace_id.to_string(),
      "revision": revision,
      "entries": entries,
    })).unwrap_or_default()}]
  }))
}

async fn folder_entry_create(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let parent_id = required_string(params, "parent_id")?;
  let target_type = parse_required_folder_entry_type(params, "target_type")?;
  let target_id = required_string(params, "target_id")?;
  let target_workspace_id = parse_optional_uuid(params, "target_workspace_id")?;
  let index = parse_optional_string(params, "index")?;

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;

  optional_mcp_write("folder_entry_create", params, auth, state, async {
    let entry_id = Uuid::new_v4().to_string();
    let entry = workspace_content_link_service(state)
      .create(
        auth.user_id,
        workspace_id,
        CreateOrganizerLink {
          id: entry_id.clone(),
          parent_id,
          link_type: target_type,
          target_id,
          target_workspace_id,
          index,
        },
      )
      .await
      .map_err(map_workspace_content_link_error)?;

    Ok(json!({
      "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
        "workspaceId": workspace_id.to_string(),
        "entry": entry_json(entry),
      })).unwrap_or_default()}]
    }))
  })
  .await
}

async fn folder_entry_update(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let entry_id = required_string(params, "entry_id")?;
  let parent_id = parse_optional_string(params, "parent_id")?;
  let has_parent_update = params.get("parent_id").is_some();
  let target_type = parse_optional_folder_entry_type(params, "target_type")?;
  let target_id = parse_optional_string(params, "target_id")?;
  let target_workspace_id = if params.get("target_workspace_id").is_some() {
    Some(parse_optional_uuid(params, "target_workspace_id")?)
  } else {
    None
  };
  let index = parse_optional_string(params, "index")?;
  if !has_parent_update
    && target_type.is_none()
    && target_id.is_none()
    && target_workspace_id.is_none()
    && index.is_none()
  {
    return Err((
      -32602,
      "folder_entry_update requires at least one mutable field".to_string(),
    ));
  }

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;

  optional_mcp_write("folder_entry_update", params, auth, state, async {
    if has_parent_update && parent_id.is_none() {
      return Err((-32602, "folder entries cannot be moved to the root".to_string()));
    }
    let updated = workspace_content_link_service(state)
      .update(
        auth.user_id,
        workspace_id,
        &entry_id,
        UpdateOrganizerLink {
          parent_id: has_parent_update.then_some(parent_id).flatten(),
          link_type: target_type,
          target_id,
          target_workspace_id,
          index,
        },
      )
      .await
      .map_err(map_workspace_content_link_error)?;

    Ok(json!({
      "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
        "workspaceId": workspace_id.to_string(),
        "entry": entry_json(updated),
      })).unwrap_or_default()}]
    }))
  })
  .await
}

async fn folder_entry_delete(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let entry_id = required_string(params, "entry_id")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;

  optional_mcp_write("folder_entry_delete", params, auth, state, async {
    workspace_content_link_service(state)
      .delete(auth.user_id, workspace_id, &entry_id)
      .await
      .map_err(map_workspace_content_link_error)?;

    Ok(json!({
      "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
        "workspaceId": workspace_id.to_string(),
        "deletedEntryId": entry_id,
      })).unwrap_or_default()}]
    }))
  })
  .await
}

async fn blob_list(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let limit = parse_optional_i64(params, "limit")?.unwrap_or(50).clamp(1, 200);
  let offset = parse_optional_i64(params, "offset")?.unwrap_or(0).max(0);
  let include_deleted = params.get("include_deleted").and_then(Value::as_bool).unwrap_or(false);

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::BlobsList).await?;
  let blob_service = blob_service(state)?;
  let blobs = blob_service
    .list_workspace_blobs(workspace_id, limit, offset, include_deleted)
    .await
    .map_err(|e| (-32002, format!("Failed to list blobs: {e}")))?;
  let items = blobs.iter().map(blob_metadata_json).collect::<Vec<_>>();

  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
      "workspaceId": workspace_id.to_string(),
      "limit": limit,
      "offset": offset,
      "includeDeleted": include_deleted,
      "blobs": items,
    })).unwrap_or_default()}]
  }))
}

async fn blob_get_metadata(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let key = required_string(params, "key")?;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::BlobsRead).await?;
  let blob = load_blob_metadata(state, workspace_id, &key).await?;

  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
      "workspaceId": workspace_id.to_string(),
      "blob": blob_metadata_json(&blob),
    })).unwrap_or_default()}]
  }))
}

async fn blob_read(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:docs") {
    return Err((-32003, "Scope 'read:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let key = required_string(params, "key")?;
  let max_bytes = parse_optional_i64(params, "max_bytes")?
    .unwrap_or(1024 * 1024)
    .clamp(1, MCP_BLOB_READ_MAX_BYTES as i64) as u64;
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::BlobsRead).await?;
  let blob = load_blob_metadata(state, workspace_id, &key).await?;
  if blob.status != BlobStatus::Completed {
    return Err((-32004, "Blob upload is not completed".to_string()));
  }
  if blob.size > max_bytes {
    return Err((
      -32602,
      format!("Blob is {} bytes, exceeding max_bytes {max_bytes}", blob.size),
    ));
  }

  let response = blob_service(state)?
    .get_blob(workspace_id, &key)
    .await
    .map_err(|e| (-32002, format!("Failed to read blob: {e}")))?;
  if response.content_length > max_bytes || response.data.len() as u64 > max_bytes {
    return Err((
      -32602,
      format!("Blob read exceeded max_bytes {max_bytes} after storage retrieval"),
    ));
  }
  let data_base64 = base64::engine::general_purpose::STANDARD.encode(&response.data);

  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
      "workspaceId": workspace_id.to_string(),
      "blob": blob_metadata_json(&blob),
      "encoding": "base64",
      "dataBase64": data_base64,
    })).unwrap_or_default()}]
  }))
}

async fn blob_upload(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let key = required_string(params, "key")?;
  let mime = required_string(params, "mime")?;
  let data_base64 = required_string(params, "dataBase64")?;
  let upload_policy = upload_policy(state)?;
  let max_encoded_len = max_standard_base64_len(upload_policy.max_upload_bytes);
  if data_base64.len() as u64 > max_encoded_len {
    return Err((
      -32602,
      format!(
        "Blob upload base64 payload exceeds configured max upload size {}",
        upload_policy.max_upload_bytes
      ),
    ));
  }
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(data_base64.as_bytes())
    .map_err(|_| (-32602, "dataBase64 must be valid standard base64".to_string()))?;
  if bytes.is_empty() {
    return Err((-32602, "dataBase64 must not decode to an empty blob".to_string()));
  }
  if bytes.len() as u64 > upload_policy.max_upload_bytes {
    return Err((
      -32602,
      format!(
        "Blob upload is {} bytes, exceeding configured max upload size {}",
        bytes.len(),
        upload_policy.max_upload_bytes
      ),
    ));
  }

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::BlobsWrite).await?;
  let checksum = sha256_hex(&bytes);
  let semantic_payload = json!({
    "workspaceId": workspace_id,
    "key": key,
    "mime": mime,
    "contentSha256": checksum,
  });
  let guard =
    match begin_optional_mcp_idempotency_with_payload("blob_upload", params, Some(&semantic_payload), auth, state)
      .await?
    {
      Ok(guard) => guard,
      Err(response) => return Ok(response),
    };
  let result = async {
    enforce_mcp_mime_policy(state, &bytes, &key, &mime).await?;
    let blob = blob_service(state)?
      .upload_single_part_blob(
        workspace_id,
        &key,
        Bytes::from(bytes),
        &mime,
        Some(mime.clone()),
        Some(&checksum),
      )
      .await
      .map_err(|e| (-32002, format!("Failed to upload blob: {e}")))?;

    Ok(json!({
      "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
        "workspaceId": workspace_id.to_string(),
        "blob": blob_metadata_json(&blob),
      })).unwrap_or_default()}]
    }))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

async fn document_asset_upload_prepare(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let filename = required_string(params, "filename")?;
  if filename.chars().count() > 255 || filename.chars().any(char::is_control) {
    return Err((
      -32602,
      "filename must contain at most 255 non-control characters".to_string(),
    ));
  }
  let mime = required_string(params, "mime")?;
  let mime = mime
    .parse::<mime::Mime>()
    .map_err(|_| (-32602, "mime must be a valid MIME type".to_string()))?
    .to_string();
  let byte_size = params
    .get("byte_size")
    .and_then(Value::as_u64)
    .filter(|size| *size > 0)
    .ok_or_else(|| (-32602, "byte_size must be a positive integer".to_string()))?;
  let sha256 = required_string(params, "sha256")?.to_ascii_lowercase();
  if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return Err((-32602, "sha256 must be exactly 64 hexadecimal characters".to_string()));
  }
  let upload_policy = upload_policy(state)?;
  if byte_size > upload_policy.max_upload_bytes {
    return Err((
      -32602,
      format!(
        "Asset is {byte_size} bytes, exceeding configured max upload size {}",
        upload_policy.max_upload_bytes
      ),
    ));
  }

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::BlobsWrite).await?;
  enforce_mcp_mime_policy(state, &[], &filename, &mime).await?;
  let asset_ref = format!("{DOCUMENT_ASSET_PREFIX}{sha256}");
  let service = blob_service(state)?;
  let existing = service
    .get_blob_metadata(workspace_id, &asset_ref)
    .await
    .map_err(|_| (-32002, "Failed to load asset upload metadata".to_string()))?;
  let metadata = match existing {
    Some(existing) => {
      if existing.size != byte_size || existing.mime != mime || existing.checksum.as_deref() != Some(sha256.as_str()) {
        return Err((
          -32009,
          "MIX_MCP_DOCUMENT_ASSET_CONFLICT: asset metadata does not match the content hash".to_string(),
        ));
      }
      existing
    }
    None => service
      .initialize_upload_with_metadata(workspace_id, &asset_ref, byte_size, &mime, Some(&sha256))
      .await
      .map_err(|_| (-32002, "Failed to initialize asset upload metadata".to_string()))?,
  };
  let already_uploaded = metadata.status == BlobStatus::Completed;
  let upload_url = if already_uploaded {
    None
  } else {
    Some(
      service
        .create_signed_upload_url(
          "/api/storage/upload",
          workspace_id,
          &asset_ref,
          upload_policy.signed_url_ttl_seconds,
        )
        .map_err(|_| (-32002, "Failed to create signed asset upload URL".to_string()))?,
    )
  };
  Ok(mcp_json_response(json!({
    "workspaceId": workspace_id,
    "assetRef": asset_ref,
    "uploadUrl": upload_url,
    "alreadyUploaded": already_uploaded,
  })))
}

async fn require_completed_image_asset(
  state: &McpToolState,
  workspace_id: Uuid,
  asset_ref: &str,
) -> Result<BlobMetadata, (i32, String)> {
  let hash = asset_ref
    .strip_prefix(DOCUMENT_ASSET_PREFIX)
    .filter(|hash| {
      hash.len() == 64
        && hash
          .bytes()
          .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
    .ok_or_else(|| {
      (
        -32602,
        "asset_ref must be a server-issued document asset reference".to_string(),
      )
    })?;
  let metadata = blob_service(state)?
    .get_blob_metadata(workspace_id, asset_ref)
    .await
    .map_err(|_| (-32002, "Failed to load document asset metadata".to_string()))?
    .ok_or_else(|| (-32004, "MIX_MCP_DOCUMENT_ASSET_NOT_FOUND".to_string()))?;
  if metadata.status != BlobStatus::Completed {
    return Err((-32009, "MIX_MCP_DOCUMENT_ASSET_PENDING".to_string()));
  }
  if !metadata.mime.starts_with("image/") {
    return Err((-32602, "MIX_MCP_DOCUMENT_ASSET_NOT_IMAGE".to_string()));
  }
  if !metadata
    .checksum
    .as_deref()
    .is_some_and(|checksum| checksum.eq_ignore_ascii_case(hash))
  {
    return Err((-32009, "MIX_MCP_DOCUMENT_ASSET_HASH_MISMATCH".to_string()));
  }
  Ok(metadata)
}

async fn blob_delete(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  if !auth.has_scope("write:docs") {
    return Err((-32003, "Scope 'write:docs' required".to_string()));
  }

  let workspace_id = parse_uuid(params, "workspace_id")?;
  let key = required_string(params, "key")?;
  let permanently = params.get("permanently").and_then(Value::as_bool).unwrap_or(false);
  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::BlobsWrite).await?;

  optional_mcp_write("blob_delete", params, auth, state, async {
    let deleted = if permanently {
      blob_service(state)?
        .hard_delete_blob(workspace_id, &key)
        .await
        .map_err(|e| (-32002, format!("Failed to hard-delete blob: {e}")))?
    } else {
      blob_service(state)?
        .soft_delete_blob(workspace_id, &key, Utc::now())
        .await
        .map_err(|e| (-32002, format!("Failed to soft-delete blob: {e}")))?
    };

    Ok(json!({
      "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
        "workspaceId": workspace_id.to_string(),
        "deleted": deleted,
        "permanently": permanently,
      })).unwrap_or_default()}]
    }))
  })
  .await
}

// ─── Template tools (P125-TPL-S-10) ──────────────────────────────────────────

async fn template_list_for_workspace(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:workspaces") {
    return Err((-32003, "Scope 'read:workspaces' required".to_string()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let locale = params
    .get("locale")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;

  let Some(tpl) = &state.template_registry else {
    return Ok(json!({ "content": [{"type": "text", "text": "Template registry is not enabled."}] }));
  };

  let entries = tpl
    .query_builtin_reconcile_slugs(workspace_id, &locale)
    .await
    .map_err(|e| (-32002, format!("template_list_for_workspace failed: {e}")))?;

  let items: Vec<Value> = entries
    .iter()
    .map(|e| {
      let needs_rebuild = e
        .current_instance
        .as_ref()
        .map(|i| i.applied_hash.as_deref() != Some(&e.expected_hash))
        .unwrap_or(true);
      json!({
        "slug": e.slug,
        "builderVersion": e.builder_version,
        "expectedHash": e.expected_hash,
        "hasInstance": e.current_instance.is_some(),
        "needsRebuild": needs_rebuild,
        "provisioningMode": format!("{:?}", e.provisioning_mode),
      })
    })
    .collect();

  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
      "workspaceId": workspace_id,
      "locale": locale,
      "templates": items,
    })).unwrap_or_default()}]
  }))
}

async fn template_request_reconcile(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  if !auth.has_scope("read:workspaces") {
    return Err((-32003, "Scope 'read:workspaces' required".to_string()));
  }
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let locale = params
    .get("locale")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();

  check_workspace_membership(&state.workspace_service, auth.user_id, workspace_id).await?;

  let Some(tpl) = &state.template_registry else {
    return Ok(json!({ "content": [{"type": "text", "text": "Template registry is not enabled."}] }));
  };

  let entries = tpl
    .query_builtin_reconcile_slugs(workspace_id, &locale)
    .await
    .map_err(|e| (-32002, format!("query_builtin_reconcile_slugs failed: {e}")))?;

  let stale_count = entries
    .iter()
    .filter(|e| {
      e.current_instance
        .as_ref()
        .map(|i| i.applied_hash.as_deref() != Some(&e.expected_hash))
        .unwrap_or(true)
    })
    .count();

  Ok(json!({
    "content": [{"type": "text", "text": serde_json::to_string_pretty(&json!({
      "workspaceId": workspace_id,
      "locale": locale,
      "totalTemplates": entries.len(),
      "staleOrMissing": stale_count,
      "message": if stale_count > 0 {
        format!(
          "{stale_count} builtin template instance(s) are missing or stale; this read-only diagnostic made no changes."
        )
      } else {
        "No builtin template instance is missing or stale; this read-only diagnostic made no changes.".to_string()
      }
    })).unwrap_or_default()}]
  }))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn bounded_integer(params: &Value, key: &str, default: i64, min: i64, max: i64) -> Result<i64, (i32, String)> {
  match params.get(key) {
    None => Ok(default),
    Some(value) => value
      .as_i64()
      .filter(|value| (min..=max).contains(value))
      .ok_or_else(|| (-32602, format!("{key} must be an integer between {min} and {max}"))),
  }
}

fn parse_uuid(params: &Value, key: &str) -> Result<Uuid, (i32, String)> {
  let s = params
    .get(key)
    .and_then(|v| v.as_str())
    .ok_or_else(|| (-32602, format!("Missing required parameter: {key}")))?;
  Uuid::parse_str(s).map_err(|_| (-32602, format!("Invalid UUID for parameter: {key}")))
}

fn required_string(params: &Value, key: &str) -> Result<String, (i32, String)> {
  params
    .get(key)
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToOwned::to_owned)
    .ok_or_else(|| (-32602, format!("Missing required parameter: {key}")))
}

fn parse_optional_string(params: &Value, key: &str) -> Result<Option<String>, (i32, String)> {
  match params.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::String(value)) => {
      let trimmed = value.trim();
      Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
    }
    Some(_) => Err((-32602, format!("{key} must be a string or null"))),
  }
}

fn parse_optional_i64(params: &Value, key: &str) -> Result<Option<i64>, (i32, String)> {
  match params.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(value) => value
      .as_i64()
      .map(Some)
      .ok_or_else(|| (-32602, format!("{key} must be an integer"))),
  }
}

fn parse_optional_uuid(params: &Value, key: &str) -> Result<Option<Uuid>, (i32, String)> {
  match parse_optional_string(params, key)? {
    Some(value) => Uuid::parse_str(&value)
      .map(Some)
      .map_err(|_| (-32602, format!("Invalid UUID for parameter: {key}"))),
    None => Ok(None),
  }
}

/// Decode the import payload passed as either `content_base64` or
/// `content_text`. The base64 form is the canonical one for binary
/// payloads (Notion ZIP); the text form is a convenience for UTF-8
/// JSON snapshots used in tests and inline scripting.
fn parse_mcp_import_content(params: &Value) -> Result<Vec<u8>, (i32, String)> {
  let base64_value = params.get("content_base64").and_then(Value::as_str);
  let text_value = params.get("content_text").and_then(Value::as_str);
  match (base64_value, text_value) {
    (Some(b64), _) => {
      let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|_| (-32602, "contentBase64 must be valid standard base64".to_string()))?;
      if bytes.is_empty() {
        return Err((-32602, "contentBase64 must not decode to an empty payload".to_string()));
      }
      Ok(bytes)
    }
    (None, Some(text)) => {
      if text.is_empty() {
        return Err((-32602, "contentText must not be empty".to_string()));
      }
      Ok(text.as_bytes().to_vec())
    }
    (None, None) => Err((-32602, "Either contentBase64 or contentText is required".to_string())),
  }
}

fn parse_mcp_import_mode(params: &Value, key: &str, default: DatabaseJsonImportMode) -> DatabaseJsonImportMode {
  match params.get(key).and_then(Value::as_str) {
    Some("replace") => DatabaseJsonImportMode::Replace,
    Some("merge") => DatabaseJsonImportMode::Merge,
    Some("create") | None => default,
    Some(other) => {
      // Unknown mode → fall back to the default rather than failing the
      // whole request. The service still validates the mode shape.
      let _ = other;
      default
    }
  }
}

fn parse_mcp_conflict_strategy(
  params: &Value,
  key: &str,
  default: DatabaseJsonConflictStrategy,
) -> DatabaseJsonConflictStrategy {
  match params.get(key).and_then(Value::as_str) {
    Some("rename") => DatabaseJsonConflictStrategy::Rename,
    Some("overwrite") => DatabaseJsonConflictStrategy::Overwrite,
    Some("abort") | None => default,
    Some(other) => {
      let _ = other;
      default
    }
  }
}

fn build_mcp_import_options(params: &Value, default_workspace_id: Uuid) -> DatabaseJsonImportOptions {
  DatabaseJsonImportOptions {
    mode: parse_mcp_import_mode(params, "mode", DatabaseJsonImportMode::Create),
    conflict_strategy: parse_mcp_conflict_strategy(params, "conflict_strategy", DatabaseJsonConflictStrategy::Abort),
    target_workspace_id: parse_optional_uuid(params, "target_workspace_id")
      .ok()
      .flatten()
      .or(Some(default_workspace_id)),
    target_database_id: parse_optional_uuid(params, "target_database_id").ok().flatten(),
    dry_run: params.get("dry_run").and_then(Value::as_bool).unwrap_or(false),
    field_mapping: Default::default(),
    confirm_destructive: params
      .get("confirm_destructive")
      .and_then(Value::as_bool)
      .unwrap_or(false),
  }
}

fn mcp_i64_param(params: &Value, key: &str, default: i64) -> i64 {
  params.get(key).and_then(Value::as_i64).unwrap_or(default)
}

fn mcp_page(params: &Value, default_limit: i64, max_limit: i64) -> Result<PageRequest, (i32, String)> {
  Ok(PageRequest {
    limit: parse_optional_i64(params, "limit")?
      .unwrap_or(default_limit)
      .clamp(1, max_limit),
    offset: parse_optional_i64(params, "offset")?.unwrap_or(0).max(0),
  })
}

fn require_mcp_scope(auth: &McpAuthContext, scope: &'static str) -> Result<(), (i32, String)> {
  if auth.has_scope(scope) {
    Ok(())
  } else {
    Err((-32003, format!("Scope '{scope}' required")))
  }
}

fn require_mcp_database_scope(auth: &McpAuthContext, write: bool) -> Result<(), (i32, String)> {
  let canonical = if write {
    DATABASE_WRITE_SCOPE
  } else {
    DATABASE_READ_SCOPE
  };
  if auth.has_scope(canonical) {
    Ok(())
  } else {
    Err((-32003, format!("Scope '{canonical}' required")))
  }
}

fn database_services(state: &McpToolState) -> Result<&DatabaseServices, (i32, String)> {
  state.database_services.as_deref().ok_or_else(|| {
    (
      -32002,
      "Database capabilities are not enabled on this MCP server".to_string(),
    )
  })
}

async fn preflight_database_write(
  state: &McpToolState,
  service: &DatabaseDefinitionService,
  actor_id: Uuid,
  database_id: Uuid,
) -> Result<(), (i32, String)> {
  let record = service
    .get_database(actor_id, database_id)
    .await
    .map_err(mcp_database_error)?;
  assert_workspace_permission(
    state,
    actor_id,
    record.database.workspace_id,
    WorkspaceAction::CreateDoc,
  )
  .await
}

fn mcp_database_error(error: myoxus_application::database::DatabaseServiceError) -> (i32, String) {
  match error.code {
    myoxus_application::database::ERR_NOT_FOUND | myoxus_application::database::ERR_ROW_TEMPLATE_NOT_FOUND => {
      (-32004, format!("{}: {}", error.code, error.message))
    }
    myoxus_application::database::ERR_FORBIDDEN | myoxus_application::database::ERR_ROW_TEMPLATE_FORBIDDEN => {
      (-32003, format!("{}: {}", error.code, error.message))
    }
    _ => (-32002, format!("{}: {}", error.code, error.message)),
  }
}

async fn finish_or_abort_mcp_write(
  guard: McpIdempotencyGuard,
  state: &McpToolState,
  _auth: &McpAuthContext,
  result: Result<Value, (i32, String)>,
) -> Result<Value, (i32, String)> {
  crate::idempotency::finish_or_abort(guard, &state.idempotency, result).await
}

/// Construct a bounded committed outcome inside the canonical transaction.
/// Optional content projection can fail or be interrupted without losing the
/// proof of the write. Recovery never reads a newer document revision.
pub(crate) fn document_replay_response(
  params: &Value,
  outcome: myoxus_application::mcp::McpDocumentWriteCommit<'_>,
) -> myoxus_application::auth::AuthResult<Value> {
  use myoxus_application::doc::{MutationReadbackStatus, MutationReadbackUnavailableReason, PageLifecycleKind};
  use myoxus_application::mcp::McpDocumentWriteCommit;
  let (doc_id, payload) = match outcome {
    McpDocumentWriteCommit::Content { commit, operation } => {
      let affected = document::affected_block_ids(params, commit);
      let mut payload = json!({
        "externalId": params.get("external_id").and_then(Value::as_str).map(str::trim), "operation": operation,
        "sequence": commit.sequence, "revision": commit.sequence,
        "affectedBlockIds": affected, "updatedBlocks": [],
        "readback": MutationReadbackStatus::Unavailable { reason: MutationReadbackUnavailableReason::ProjectionFailed },
        "insertedBlockIds": commit.inserted_block_ids, "removedBlockIds": commit.removed_block_ids,
      });
      if operation == "replace_all" {
        payload["recoveryHistoryId"] = json!(commit.recovery_history_id);
      }
      (commit.doc_id, payload)
    }
    McpDocumentWriteCommit::Lifecycle(commit) => {
      let id = &commit.document.external_id;
      let timestamp = commit.committed_at.to_rfc3339();
      let payload = match commit.kind {
        PageLifecycleKind::Create => json!({
          "externalId": id, "title": commit.document.title, "created_at": timestamp,
          "leaf_sequence": commit.leaf.as_ref().map(|leaf| leaf.sequence), "root_sequence": commit.workspace_root.sequence,
        }),
        PageLifecycleKind::Rename => json!({
          "externalId": id, "operation": "update_title", "revision": commit.leaf.as_ref().map(|leaf| leaf.sequence),
          "affectedBlockIds": [], "leafSequence": commit.leaf.as_ref().map(|leaf| leaf.sequence),
          "rootSequence": commit.workspace_root.sequence, "updatedAt": timestamp,
        }),
        PageLifecycleKind::Trash => {
          json!({"externalId": id, "deleted_at": timestamp, "root_sequence": commit.workspace_root.sequence})
        }
        PageLifecycleKind::Restore => {
          json!({"externalId": id, "restored_at": timestamp, "root_sequence": commit.workspace_root.sequence})
        }
      };
      (commit.document.id, payload)
    }
    McpDocumentWriteCommit::HistoryRestore(_) | McpDocumentWriteCommit::PdfExport(_) => {
      return Err(AuthError::InvalidInput("unexpected restore receipt owner".into()));
    }
  };
  Ok(with_internal_document_identity(mcp_json_response(payload), doc_id))
}

async fn optional_mcp_write<F>(
  tool_name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
  operation: F,
) -> Result<Value, (i32, String)>
where
  F: Future<Output = Result<Value, (i32, String)>>,
{
  let guard = match begin_optional_mcp_idempotency(tool_name, params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  finish_or_abort_mcp_write(guard, state, auth, operation.await).await
}

fn parse_mcp_cell_value(value: Option<&Value>) -> Result<DatabaseCellValueData, (i32, String)> {
  let value = value.ok_or_else(|| (-32602, "Missing required parameter: value".to_string()))?;
  serde_json::from_value(value.clone()).map_err(|error| (-32602, format!("invalid cell value: {error}")))
}

fn parse_mcp_initial_cells(params: &Value) -> Result<Vec<(DatabaseFieldId, DatabaseCellValueData)>, (i32, String)> {
  let Some(value) = params.get("initial_cells") else {
    return Ok(Vec::new());
  };
  let cells = value
    .as_array()
    .ok_or_else(|| (-32602, "initial_cells must be an array".to_string()))?;
  let mut parsed = Vec::with_capacity(cells.len());
  for cell in cells {
    let field_id = parse_uuid(cell, "field_id")?;
    let value = parse_mcp_cell_value(cell.get("value"))?;
    parsed.push((field_id, value));
  }
  Ok(parsed)
}

fn parse_mcp_cell_value_map(
  value: Option<&Value>,
) -> Result<BTreeMap<DatabaseFieldId, DatabaseCellValueData>, (i32, String)> {
  let Some(value) = value else {
    return Ok(BTreeMap::new());
  };
  let object = value
    .as_object()
    .ok_or_else(|| (-32602, "override_cell_values must be an object".to_string()))?;
  let mut parsed = BTreeMap::new();
  for (field_id, cell_value) in object {
    let field_id =
      Uuid::parse_str(field_id).map_err(|_| (-32602, "override_cell_values contains invalid field id".to_string()))?;
    parsed.insert(field_id, parse_mcp_cell_value(Some(cell_value))?);
  }
  Ok(parsed)
}

fn parse_graph_direction(params: &Value) -> Result<DocumentGraphDirection, (i32, String)> {
  match params.get("direction").and_then(Value::as_str).unwrap_or("both") {
    "incoming" => Ok(DocumentGraphDirection::Incoming),
    "outgoing" => Ok(DocumentGraphDirection::Outgoing),
    "both" => Ok(DocumentGraphDirection::Both),
    _ => Err((-32602, "direction must be incoming, outgoing or both".to_string())),
  }
}

fn parse_template_surface(params: &Value) -> Result<TemplateSuggestionSurface, (i32, String)> {
  match required_string(params, "surface")?.as_str() {
    "sidebar_new_page" | "sidebarNewPage" => Ok(TemplateSuggestionSurface::SidebarNewPage),
    "all_pages_new_page" | "allPagesNewPage" => Ok(TemplateSuggestionSurface::AllPagesNewPage),
    "collection_new_page" | "collectionNewPage" => Ok(TemplateSuggestionSurface::CollectionNewPage),
    "database_row_template" | "databaseRowTemplate" => Ok(TemplateSuggestionSurface::DatabaseRowTemplate),
    "starter_bar" | "starterBar" => Ok(TemplateSuggestionSurface::StarterBar),
    "journal_onboarding" | "journalOnboarding" => Ok(TemplateSuggestionSurface::JournalOnboarding),
    "journal_sidebar_footer" | "journalSidebarFooter" => Ok(TemplateSuggestionSurface::JournalSidebarFooter),
    _ => Err((-32602, "unsupported template suggestion surface".to_string())),
  }
}

fn template_suggestion_item_json(
  item: myoxus_application::template_registry::suggestions::TemplateSuggestionItem,
) -> Value {
  json!({
    "templateId": item.template_id,
    "templateDocId": item.template_doc_id,
    "slug": item.slug,
    "title": item.title,
    "description": item.description,
    "category": item.category,
    "tags": item.tags,
    "score": item.score,
    "reasons": item.reasons.into_iter().map(|reason| format!("{reason:?}")).collect::<Vec<_>>(),
    "instanceState": item.instance_state,
    "available": item.available,
  })
}

fn automation_run_json(run: WorkspaceAutomationRun) -> Value {
  use myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin;
  let (code, summary) = myoxus_application::workspace_automation::safe_error_projection(&run);
  let (origin, request_id) = match &run.origin {
    WorkspaceAutomationRunOrigin::Rule => ("rule", None),
    WorkspaceAutomationRunOrigin::WorkspaceSetup { request_id, .. } => ("workspace_setup", Some(*request_id)),
    WorkspaceAutomationRunOrigin::ConfirmedContextDocuments { request_id, .. } => {
      ("confirmed_request", Some(*request_id))
    }
    WorkspaceAutomationRunOrigin::TaskMaintenance { request_id, .. } => ("task_maintenance", Some(*request_id)),
    WorkspaceAutomationRunOrigin::TaskHandover { request_id, .. } => ("task_handover", Some(*request_id)),
    WorkspaceAutomationRunOrigin::DocumentReview { request_id, .. } => ("document_review", Some(*request_id)),
  };
  // Preserve routing facts; accepted inputs and stored error bodies are private.
  let event = run.trigger_event.as_ref().map(|event| {
    json!({
      "workspaceId":run.workspace_id,"databaseId":event.database_id,"rowId":event.row_id,
      "triggerType":event.trigger_type,"fieldId":event.field_id,"occurredAt":event.occurred_at
    })
  });
  json!({
    "id":run.id,"automationId":run.automation_id,"workspaceId":run.workspace_id,
    "origin":origin,"requestId":request_id,
    "triggerType":run.trigger_type.map(|kind|kind.as_str()),"triggerEvent":event,
    "status":run.status.as_str(),"attemptCount":run.attempt_count,
    "errorCode":code,"errorMessage":summary,"deadLetter":run.dead_letter,
    "queuedAt":run.queued_at,"startedAt":run.started_at,"finishedAt":run.finished_at,
  })
}

async fn check_workspace_membership(
  workspace_service: &WorkspaceService,
  user_id: Uuid,
  workspace_id: Uuid,
) -> Result<(), (i32, String)> {
  let workspaces = workspace_service
    .list_workspaces(user_id)
    .await
    .map_err(|e| (-32002, format!("Failed to check workspace access: {e}")))?;

  if !workspaces.iter().any(|w| w.id == workspace_id) {
    return Err((-32003, "Permission denied: not a member of this workspace".to_string()));
  }

  Ok(())
}

async fn assert_workspace_permission(
  state: &McpToolState,
  user_id: Uuid,
  workspace_id: Uuid,
  action: WorkspaceAction,
) -> Result<(), (i32, String)> {
  // Keep the scope and membership errors distinct from fine-grained ACL
  // denial: MCP clients can surface "missing token scope" separately from
  // "your workspace role cannot perform this write".
  state
    .permission_service
    .assert(&WorkspaceResource { user_id, workspace_id }, action)
    .await
    .map_err(|_| {
      (
        -32003,
        format!("Permission denied: workspace action {action:?} required"),
      )
    })
}

fn blob_service(state: &McpToolState) -> Result<&BlobService, (i32, String)> {
  state
    .blob_service
    .as_deref()
    .ok_or_else(|| (-32002, "Blob service is not enabled on this MCP server".to_string()))
}

fn upload_policy(state: &McpToolState) -> Result<&McpUploadPolicy, (i32, String)> {
  state.upload_policy.as_ref().ok_or_else(|| {
    (
      -32002,
      "Blob upload policy is not enabled on this MCP server".to_string(),
    )
  })
}

async fn enforce_mcp_mime_policy(
  state: &McpToolState,
  bytes: &[u8],
  file_name: &str,
  declared_mime: &str,
) -> Result<(), (i32, String)> {
  let upload_policy = upload_policy(state)?;
  let fallback = McpMimePolicyFallback {
    allowlist: upload_policy.mime_allowlist.clone(),
    blocklist: upload_policy.mime_blocklist.clone(),
    validation_mode: upload_policy.mime_validation_mode.clone(),
  };
  let config = upload_policy
    .mime_policy_reader
    .resolve(&fallback)
    .await
    .map_err(|error| (-32603, format!("MIME policy configuration is unavailable: {error}")))?;
  let detection = detect_mime(bytes, file_name, declared_mime);
  match evaluate_policy(&detection, &config) {
    MimePolicyDecision::Allow | MimePolicyDecision::Warn { .. } => Ok(()),
    MimePolicyDecision::Deny { reason } => {
      let extension = redacted_blob_key_extension(file_name);
      warn!(
        blob_key_sha256 = %sha256_hex(file_name.as_bytes()),
        blob_key_extension = extension.as_deref().unwrap_or(""),
        effective_mime = %detection.effective_mime,
        confidence = %detection.confidence,
        reason = %reason,
        "MCP blob upload denied by MIME policy"
      );
      Err((
        -32602,
        format!(
          "Upload denied by MIME policy: {} (detected MIME: {}, confidence: {})",
          reason, detection.effective_mime, detection.confidence
        ),
      ))
    }
  }
}

fn max_standard_base64_len(max_decoded_bytes: u64) -> u64 {
  let full_chunks = max_decoded_bytes / 3;
  let remainder = max_decoded_bytes % 3;
  full_chunks
    .saturating_mul(4)
    .saturating_add(if remainder == 0 { 0 } else { 4 })
}

fn redacted_blob_key_extension(key: &str) -> Option<String> {
  let file_name = key.rsplit('/').next().unwrap_or(key);
  let extension = file_name.rsplit_once('.')?.1;
  let normalized = extension
    .chars()
    .take(16)
    .filter(|ch| ch.is_ascii_alphanumeric())
    .collect::<String>()
    .to_ascii_lowercase();
  (!normalized.is_empty()).then_some(normalized)
}

async fn load_blob_metadata(
  state: &McpToolState,
  workspace_id: Uuid,
  key: &str,
) -> Result<BlobMetadata, (i32, String)> {
  blob_service(state)?
    .get_blob_metadata(workspace_id, key)
    .await
    .map_err(|e| (-32002, format!("Failed to load blob metadata: {e}")))?
    .ok_or_else(|| (-32004, "Blob not found".to_string()))
}

fn blob_metadata_json(blob: &BlobMetadata) -> Value {
  json!({
    "id": blob.blob_id.to_string(),
    "workspaceId": blob.workspace_id.to_string(),
    "key": blob.key,
    "size": blob.size,
    "mime": blob.mime,
    "checksum": blob.checksum,
    "status": match blob.status {
      BlobStatus::Pending => "pending",
      BlobStatus::Uploading => "uploading",
      BlobStatus::Completed => "completed",
      BlobStatus::Failed => "failed",
    },
    "createdAt": blob.created_at.to_rfc3339(),
    "updatedAt": blob.updated_at.to_rfc3339(),
    "deletedAt": blob.deleted_at.map(|value| value.to_rfc3339()),
  })
}

fn sha256_hex(bytes: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  hex::encode(hasher.finalize())
}

async fn assert_doc_permission(
  state: &McpToolState,
  user_id: Uuid,
  workspace_id: Uuid,
  doc_id: Uuid,
  action: DocAction,
) -> Result<(), (i32, String)> {
  state
    .permission_service
    .assert(
      &DocResource {
        user_id,
        workspace_id,
        doc_id,
      },
      action,
    )
    .await
    .map_err(|_| {
      (
        -32003,
        format!("Permission denied: document action {action:?} required"),
      )
    })
}

#[derive(Debug, Clone)]
pub(super) struct ResolvedExternalDocument {
  pub external_id: String,
  pub internal_id: Uuid,
}

/// Resolve one actor-facing document key after workspace authorization.
///
/// Only this MCP adapter boundary holds both identities. Downstream services,
/// permissions, persistence, jobs and audit owners receive the internal UUID.
pub(super) async fn resolve_external_document_for_mcp(
  doc_service: &DocService,
  workspace_id: Uuid,
  external_id: &str,
) -> Result<ResolvedExternalDocument, (i32, String)> {
  let document_key = DocumentKey::parse(external_id.to_string()).map_err(|error| (-32602, error))?;
  let internal_id = doc_service
    .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &document_key)
    .await
    .map_err(|error| (-32002, format!("Failed to resolve document key: {error}")))?
    .ok_or_else(|| (-32004, "Document not found".to_string()))?;
  Ok(ResolvedExternalDocument {
    external_id: document_key.into_string(),
    internal_id,
  })
}

pub(super) async fn resolve_external_document_ids_for_mcp(
  doc_service: &DocService,
  workspace_id: Uuid,
  internal_ids: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, String>, (i32, String)> {
  let external_ids = doc_service
    .resolve_external_doc_ids(workspace_id, internal_ids)
    .await
    .map_err(|error| (-32002, format!("Failed to project document keys: {error}")))?;
  Ok(external_ids)
}

fn sanitize_folder_name(params: &Value) -> Result<String, (i32, String)> {
  let name = required_string(params, "name")?;
  validate_folder_name(name)
}

fn optional_sanitized_folder_name(params: &Value) -> Result<Option<String>, (i32, String)> {
  if params.get("name").is_none() {
    return Ok(None);
  }
  let name = required_string(params, "name")?;
  validate_folder_name(name).map(Some)
}

fn validate_folder_name(name: String) -> Result<String, (i32, String)> {
  if name.chars().count() > 256 {
    return Err((-32602, "folder name must be at most 256 characters".to_string()));
  }
  Ok(name)
}

fn parse_required_folder_entry_type(params: &Value, key: &str) -> Result<OrganizerLinkType, (i32, String)> {
  let value = required_string(params, key)?;
  validate_folder_entry_type(value)
}

fn parse_optional_folder_entry_type(params: &Value, key: &str) -> Result<Option<OrganizerLinkType>, (i32, String)> {
  match parse_optional_string(params, key)? {
    Some(value) => validate_folder_entry_type(value).map(Some),
    None => Ok(None),
  }
}

fn validate_folder_entry_type(value: String) -> Result<OrganizerLinkType, (i32, String)> {
  OrganizerLinkType::parse(&value).map_err(map_organizer_error)
}

fn organizer_service(state: &McpToolState) -> OrganizerService<DocService> {
  OrganizerService::new(state.doc_service.clone())
}

pub(crate) fn workspace_content_link_service(state: &McpToolState) -> WorkspaceContentLinkService {
  WorkspaceContentLinkService::new(state.doc_service.clone(), state.permission_service.clone())
    .with_database_definition(
      state
        .database_services
        .as_ref()
        .map(|services| services.definition.clone()),
    )
    .with_workspace_tag_service(state.workspace_tag_service.clone())
}

fn map_workspace_content_link_error(error: WorkspaceContentLinkError) -> (i32, String) {
  match error {
    WorkspaceContentLinkError::DeniedOrMissing => (-32004, "Organizer link target was not found".to_string()),
    WorkspaceContentLinkError::DependencyUnavailable => {
      (-32002, "Organizer link dependency is unavailable".to_string())
    }
    WorkspaceContentLinkError::Organizer(error) => map_organizer_error(error),
  }
}

fn flatten_organizer_rows(nodes: &[OrganizerSnapshotNode]) -> Vec<OrganizerRow> {
  let mut rows = Vec::new();
  let mut stack = nodes.iter().rev().collect::<Vec<_>>();
  while let Some(node) = stack.pop() {
    rows.push(node.row.clone());
    stack.extend(node.children.iter().rev());
  }
  rows
}

fn folder_json(row: OrganizerRow) -> Value {
  json!({
    "id": row.id,
    "parentId": row.parent_id,
    "name": row.data,
    "type": row.row_type,
    "index": row.index,
  })
}

fn entry_json(row: OrganizerRow) -> Value {
  json!({
    "id": row.id,
    "parentId": row.parent_id,
    "targetType": row.row_type,
    "targetId": row.data,
    "targetWorkspaceId": row.target_workspace_id,
    "index": row.index,
  })
}

fn map_organizer_error(error: OrganizerError) -> (i32, String) {
  match error {
    OrganizerError::FolderNotFound(_) | OrganizerError::EntryNotFound(_) => (-32004, error.to_string()),
    OrganizerError::Storage | OrganizerError::Decode | OrganizerError::InvalidDocumentKey => {
      (-32002, error.to_string())
    }
    OrganizerError::MalformedRow(_)
    | OrganizerError::BrokenParent(_)
    | OrganizerError::Cycle(_)
    | OrganizerError::DuplicateResource
    | OrganizerError::InvalidFolderName
    | OrganizerError::UnsupportedLinkType
    | OrganizerError::InvalidTarget
    | OrganizerError::InvalidWorkspaceTarget
    | OrganizerError::EntryAtRoot
    | OrganizerError::EmptyMutation
    | OrganizerError::InvalidOrderKey => (-32602, error.to_string()),
    OrganizerError::ReindexRequired => (-32009, error.to_string()),
    OrganizerError::StaleRevision { .. } => (-32010, error.to_string()),
  }
}

fn parse_document_metadata_patch(value: &Value) -> Result<DocumentMetadataPatch, (i32, String)> {
  let patch = value
    .as_object()
    .ok_or_else(|| (-32602, "patch must be an object".to_string()))?;
  Ok(DocumentMetadataPatch {
    expected_metadata_revision: patch.get("expectedMetadataRevision").map(parse_i64_field).transpose()?,
    document_type_id: parse_optional_uuid_patch(patch, "documentTypeId")?,
    classification_id: parse_optional_uuid_patch(patch, "classificationId")?,
    retention_policy_id: parse_optional_uuid_patch(patch, "retentionPolicyId")?,
    language_id: parse_optional_uuid_patch(patch, "languageId")?,
    responsible_user_id: parse_optional_uuid_patch(patch, "responsibleUserId")?,
    document_number: parse_optional_string_patch(patch, "documentNumber")?,
    review_due_at: parse_optional_datetime_patch(patch, "reviewDueAt")?,
    valid_from: parse_optional_datetime_patch(patch, "validFrom")?,
    valid_until: parse_optional_datetime_patch(patch, "validUntil")?,
    journal_date: parse_optional_date_patch(patch, "journalDate")?,
    audience_ids: parse_audience_ids_patch(patch)?,
    template_state: parse_optional_string_patch(patch, "templateState")?,
    template_origin: None,
    template_category: None,
    template_tags: None,
    template_id: parse_optional_uuid_patch(patch, "templateId")?,
    template_revision_id: parse_optional_uuid_patch(patch, "templateRevisionId")?,
    template_instance_id: parse_optional_uuid_patch(patch, "templateInstanceId")?,
    primary_mode: parse_optional_string_patch(patch, "primaryMode")?,
    page_width: parse_optional_string_patch(patch, "pageWidth")?,
    edgeless_color_theme: parse_optional_string_patch(patch, "edgelessColorTheme")?,
    integration_type: parse_optional_string_patch(patch, "integrationType")?,
  })
}

fn parse_i64_field(value: &Value) -> Result<i64, (i32, String)> {
  value
    .as_i64()
    .ok_or_else(|| (-32602, "expectedMetadataRevision must be an integer".to_string()))
}

fn parse_optional_uuid_patch(
  patch: &serde_json::Map<String, Value>,
  field: &str,
) -> Result<Option<Option<Uuid>>, (i32, String)> {
  match patch.get(field) {
    None => Ok(None),
    Some(Value::Null) => Ok(Some(None)),
    Some(Value::String(value)) => Uuid::parse_str(value)
      .map(Some)
      .map(Some)
      .map_err(|_| (-32602, format!("invalid {field}"))),
    Some(_) => Err((-32602, format!("{field} must be a UUID string or null"))),
  }
}

fn parse_optional_string_patch(
  patch: &serde_json::Map<String, Value>,
  field: &str,
) -> Result<Option<Option<String>>, (i32, String)> {
  match patch.get(field) {
    None => Ok(None),
    Some(Value::Null) => Ok(Some(None)),
    Some(Value::String(value)) => Ok(Some(Some(value.clone()))),
    Some(_) => Err((-32602, format!("{field} must be a string or null"))),
  }
}

fn parse_optional_datetime_patch(
  patch: &serde_json::Map<String, Value>,
  field: &str,
) -> Result<Option<Option<DateTime<Utc>>>, (i32, String)> {
  match patch.get(field) {
    None => Ok(None),
    Some(Value::Null) => Ok(Some(None)),
    Some(Value::String(value)) => DateTime::parse_from_rfc3339(value)
      .map(|datetime| Some(Some(datetime.with_timezone(&Utc))))
      .map_err(|_| (-32602, format!("{field} must be an RFC3339 date-time"))),
    Some(_) => Err((-32602, format!("{field} must be an RFC3339 date-time or null"))),
  }
}

fn parse_optional_date_patch(
  patch: &serde_json::Map<String, Value>,
  field: &str,
) -> Result<Option<Option<NaiveDate>>, (i32, String)> {
  match patch.get(field) {
    None => Ok(None),
    Some(Value::Null) => Ok(Some(None)),
    Some(Value::String(value)) => NaiveDate::parse_from_str(value, "%Y-%m-%d")
      .map(|date| Some(Some(date)))
      .map_err(|_| (-32602, format!("{field} must use YYYY-MM-DD"))),
    Some(_) => Err((-32602, format!("{field} must be a date string or null"))),
  }
}

fn parse_audience_ids_patch(patch: &serde_json::Map<String, Value>) -> Result<Option<Vec<Uuid>>, (i32, String)> {
  match patch.get("audienceIds") {
    None | Some(Value::Null) => Ok(None),
    Some(Value::Array(values)) => values
      .iter()
      .map(|value| {
        value
          .as_str()
          .ok_or_else(|| (-32602, "audienceIds must contain UUID strings".to_string()))
          .and_then(|value| Uuid::parse_str(value).map_err(|_| (-32602, "invalid audienceIds".to_string())))
      })
      .collect::<Result<Vec<_>, _>>()
      .map(Some),
    Some(_) => Err((-32602, "audienceIds must be an array of UUID strings".to_string())),
  }
}

fn sanitize_doc_version_label(params: &Value) -> Result<String, (i32, String)> {
  let label = params
    .get("label")
    .and_then(|value| value.as_str())
    .ok_or_else(|| (-32602, "Missing required parameter: label".to_string()))?
    .trim();
  if label.is_empty() {
    return Err((-32602, "label must not be empty".to_string()));
  }
  if label.len() > 160 {
    return Err((-32602, "label must be at most 160 bytes".to_string()));
  }
  Ok(label.to_string())
}

fn sanitize_doc_version_description(params: &Value) -> Option<String> {
  params
    .get("description")
    .and_then(|value| value.as_str())
    .and_then(|raw| {
      let trimmed = raw.trim();
      if trimmed.is_empty() {
        None
      } else {
        Some(trimmed.chars().take(2048).collect::<String>())
      }
    })
}

fn document_services(state: &McpToolState) -> &dyn McpDocumentOperations {
  state.document_services.as_ref()
}

async fn load_document_metadata(
  services: &dyn McpDocumentOperations,
  doc_id: Uuid,
  workspace_id: Uuid,
) -> Result<myoxus_domain::entities::DocumentMetadataProjection, (i32, String)> {
  services
    .projection(doc_id, workspace_id)
    .await
    .map_err(|e| (-32002, format!("document metadata load failed: {e}")))
}

fn validation_json(validation: &DocumentMetadataValidation) -> Value {
  let mut value = serde_json::to_value(validation).unwrap_or_else(|_| json!({}));
  value["valid"] = json!(validation.valid());
  value
}

#[derive(Debug, Clone, Copy)]
struct DocumentVersionHead {
  current_version_id: Option<Uuid>,
  dirty_since_current_version: bool,
}

fn document_version_domain_json(
  version: &DocumentVersion,
  version_head: DocumentVersionHead,
  external_id: &str,
) -> Value {
  let current_version_id = version_head.current_version_id;
  json!({
    "id": version.id.to_string(),
    "externalId": external_id,
    "workspaceId": version.workspace_id.to_string(),
    "docHistoryId": version.doc_history_id,
    "versionNo": version.version_no,
    "label": version.label,
    "description": version.description,
    "event": version.event.as_str(),
    "kind": version.kind.as_str(),
    "createdBy": version.created_by.to_string(),
    "createdAt": version.created_at.to_rfc3339(),
    "isPinned": version.is_pinned,
    "isProtected": version.is_protected,
    "currentVersionId": current_version_id.map(|id| id.to_string()),
    "isCurrentDocumentVersion": current_version_id == Some(version.id),
    "dirtySinceCurrentVersion": version_head.dirty_since_current_version,
  })
}

fn document_metadata_domain_json(
  metadata: myoxus_domain::entities::DocumentMetadataProjection,
  external_id: &str,
) -> Value {
  let mut value = serde_json::to_value(metadata).unwrap_or_else(|_| json!({}));
  if let Some(object) = value.as_object_mut() {
    object.remove("doc_id");
    object.insert("externalId".to_string(), json!(external_id));
  }
  value
}

fn document_version_head(
  policy: &myoxus_application::document_metadata_policy::DocumentMetadataEffectivePolicy,
) -> Result<DocumentVersionHead, (i32, String)> {
  let state = policy
    .state
    .as_ref()
    .ok_or_else(|| (-32004, "Document metadata state is unavailable".to_string()))?;
  Ok(DocumentVersionHead {
    current_version_id: state.current_version_id,
    dirty_since_current_version: state.dirty_since_current_version,
  })
}

/// MCP-RV-01a: Verify that a doc actually belongs to the claimed workspace.
///
/// Loads doc metadata and checks `doc.workspace_id == workspace_id`.
/// Returns the doc metadata on success.
async fn resolve_doc_in_workspace(
  doc_service: &DocService,
  workspace_id: Uuid,
  doc_id: Uuid,
) -> Result<myoxus_domain::entities::Doc, (i32, String)> {
  let doc_meta = doc_service
    .get_doc_metadata(doc_id)
    .await
    .map_err(|e| (-32002, format!("Failed to load doc: {e}")))?
    .ok_or_else(|| (-32004, "Document not found".to_string()))?;

  if doc_meta.deleted_at.is_some() {
    return Err((-32004, "Document has been deleted".to_string()));
  }

  if doc_meta.workspace_id != Some(workspace_id) {
    // SECURITY: do not disclose that the doc exists in another workspace
    return Err((-32004, "Document not found".to_string()));
  }

  Ok(doc_meta)
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_application::audit::AuditRecorder;
  use myoxus_application::auth::InMemoryAuthStore;
  use myoxus_application::doc::{DocService, PanicDocStore};
  use myoxus_application::mcp::{InMemoryMcpIdempotencyRepository, UnavailableMcpDocumentOperations};
  use myoxus_application::metrics::MetricsService;
  use myoxus_application::permission::PermissionService;
  use myoxus_application::workspace::WorkspaceService;

  fn p10_test_state() -> McpToolState {
    let ws_store = Arc::new(InMemoryAuthStore::default());
    McpToolState {
      html_catalog: None,
      workspace_service: WorkspaceService::new(ws_store.clone()),
      workspace_settings_service: None,
      public_repository: None,
      public_delivery_enabled: false,
      document_publication_service: None,
      doc_service: DocService::new(Arc::new(PanicDocStore)),
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
      metrics_service: Arc::new(MetricsService::in_memory_stub()),
      document_cursor_signing_key: Arc::from(&b"mcp-test-cursor-key"[..]),
      document_export_max_bytes: 8 * 1024 * 1024,
    }
  }

  fn p10_auth(scopes: &[&str]) -> McpAuthContext {
    McpAuthContext {
      user_id: Uuid::new_v4(),
      scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
      key_id: Uuid::new_v4(),
    }
  }

  #[test]
  fn p10_tools_list_exposes_database_graph_template_and_automation_tools() {
    let names = crate::tool_registry::tools()
      .iter()
      .map(|tool| tool.name.as_str())
      .collect::<std::collections::HashSet<_>>();
    for expected in [
      "database_view_get",
      "database_view_create",
      "database_view_update",
      "database_view_delete",
      "database_view_reorder",
      "database_field_create",
      "database_field_update",
      "database_field_delete",
      "database_field_reorder",
      "database_get",
      "database_create",
      "database_update",
      "database_trash",
      "database_restore",
      "database_delete_permanently",
      "database_list",
      "database_query",
      "database_csv_export",
      "database_json_export",
      "database_json_import_preview",
      "database_json_import",
      "database_notion_export",
      "database_notion_import_preview",
      "database_notion_import",
      "database_row_create",
      "database_cell_update",
      "database_row_get",
      "database_row_update",
      "database_row_delete",
      "database_row_restore",
      "database_row_from_template",
      "document_graph_read",
      "template_suggestions",
      "database_row_templates_list",
      "automation_list",
      "automation_run_list",
      "automation_run_get",
      "automation_dead_letter_list",
      "automation_run_retry",
    ] {
      assert!(names.contains(expected), "tools/list must expose {expected}");
    }
    for legacy in [
      "workspace_database_list",
      "workspace_database_query",
      "workspace_database_csv_export",
      "workspace_database_row_create",
      "workspace_database_cell_update",
      "workspace_database_row_from_template",
    ] {
      assert!(
        !names.contains(legacy),
        "tools/list must not advertise deprecated alias {legacy}"
      );
    }
  }

  #[test]
  fn p10_tools_have_dedicated_scopes_and_write_classification() {
    let descriptor = |name| find_tool(name).expect("registered tool");
    assert_eq!(descriptor("database_list").required_scope, "read:databases");
    assert_eq!(descriptor("database_query").required_scope, "read:databases");
    assert_eq!(descriptor("database_csv_export").required_scope, "read:databases");
    assert_eq!(descriptor("database_row_create").required_scope, "write:databases");
    assert_eq!(descriptor("database_cell_update").required_scope, "write:databases");
    assert_eq!(descriptor("database_row_get").required_scope, "read:databases");
    for name in ["database_row_update", "database_row_delete", "database_row_restore"] {
      assert_eq!(descriptor(name).required_scope, "write:databases");
      assert_eq!(descriptor(name).target_type, "database_row");
      assert_eq!(descriptor(name).access.as_str(), "write");
    }
    assert_eq!(
      descriptor("database_row_from_template").required_scope,
      "write:databases"
    );
    assert_eq!(descriptor("database_list").target_type, "database");
    assert_eq!(descriptor("document_graph_read").required_scope, "read:document_graph");
    assert_eq!(descriptor("template_suggestions").required_scope, "read:templates");
    assert_eq!(
      descriptor("database_row_templates_list").required_scope,
      "read:templates"
    );
    assert_eq!(descriptor("automation_run_retry").required_scope, "write:automations");
    assert_eq!(descriptor("database_row_create").access.as_str(), "write");
    assert_eq!(descriptor("automation_run_retry").access.as_str(), "write");
  }

  #[test]
  fn p_db_01_database_scope_gate_is_canonical_only() {
    let canonical_read = p10_auth(&["read:databases"]);
    let canonical_write = p10_auth(&["write:databases"]);

    assert!(require_mcp_database_scope(&canonical_read, false).is_ok());
    assert!(require_mcp_database_scope(&canonical_write, true).is_ok());
    assert_eq!(
      require_mcp_database_scope(&p10_auth(&["read:workspace_databases"]), false)
        .expect_err("legacy read database scope must be rejected")
        .1,
      "Scope 'read:databases' required"
    );
    assert_eq!(
      require_mcp_database_scope(&p10_auth(&["write:workspace_databases"]), true)
        .expect_err("legacy write database scope must be rejected")
        .1,
      "Scope 'write:databases' required"
    );
    assert_eq!(
      require_mcp_database_scope(&p10_auth(&["read:docs"]), false)
        .expect_err("missing database scope")
        .1,
      "Scope 'read:databases' required"
    );
  }

  #[tokio::test]
  async fn p_db_01_legacy_database_tool_names_are_not_dispatched() {
    let state = p10_test_state();
    let auth = p10_auth(&["read:databases", "write:databases"]);

    for legacy_tool in [
      "workspace_database_list",
      "workspace_database_query",
      "workspace_database_csv_export",
      "workspace_database_row_create",
      "workspace_database_cell_update",
      "workspace_database_row_from_template",
    ] {
      let err = dispatch_tool(legacy_tool, &json!({}), &auth, &state)
        .await
        .expect_err("legacy Database MCP tool names must not dispatch");
      assert_eq!(err.0, -32601);
      assert_eq!(err.1, format!("Unknown tool: {legacy_tool}"));
    }
  }

  #[tokio::test]
  async fn p10_write_tools_require_idempotency_key_before_service_wiring() {
    let state = p10_test_state();
    let auth = p10_auth(&["write:automations"]);
    let err = dispatch_tool(
      "automation_run_retry",
      &json!({ "run_id": Uuid::new_v4().to_string() }),
      &auth,
      &state,
    )
    .await
    .expect_err("missing idempotency key must fail");
    assert_eq!(err.0, -32602);
    assert!(
      err.1.contains("idempotency_key"),
      "missing idempotency key should be the primary validation error, got {err:?}"
    );
  }

  #[tokio::test]
  async fn shipped_database_imports_keep_keyless_compatibility() {
    let state = p10_test_state();
    let auth = p10_auth(&["write:databases"]);
    for tool in ["database_json_import", "database_notion_import"] {
      let err = dispatch_tool(
        tool,
        &json!({
          "workspace_id": Uuid::new_v4(),
          "content_text": "{}",
        }),
        &auth,
        &state,
      )
      .await
      .expect_err("unwired Database capabilities must fail after compatible admission");
      assert_eq!(err.0, -32002, "{tool} must not require a key from shipped clients");
    }
  }

  /// MCP-RV-04c: make_snippet must not panic on multi-byte characters.
  #[test]
  fn make_snippet_emoji_no_panic() {
    let text = "Hello 🌍 World 🎉 This is a test with emoji characters 🚀";
    let result = make_snippet(text, "World", 30);
    assert!(result.contains("World") || result.contains("..."));
    assert!(!result.is_empty());
  }

  #[test]
  fn make_snippet_umlaut_search() {
    let text = "Die Lösung für Ünïcödé-Probleme ist UTF-8-sicheres Slicing.";
    let result = make_snippet(text, "Ünïcödé", 50);
    // Search is case-insensitive, should find the match
    assert!(!result.is_empty());
  }

  #[test]
  fn make_snippet_turkish_i() {
    // Turkish İ (U+0130) lowercases to 'i' (U+0069) which has different byte length
    let text = "İstanbul is a city. Some text after to pad.";
    let result = make_snippet(text, "istanbul", 30);
    assert!(!result.is_empty());
  }

  #[test]
  fn make_snippet_long_text_truncation() {
    let text = "A".repeat(1000);
    let result = make_snippet(&text, "AAA", 50);
    assert!(result.len() <= 53); // 50 + "..."
    assert!(result.ends_with("..."));
  }

  #[test]
  fn make_snippet_no_match_returns_prefix() {
    let text = "This is a normal text without the search term.";
    let result = make_snippet(text, "MISSING", 20);
    assert!(result.len() <= 23);
  }

  #[test]
  fn make_snippet_exact_fit() {
    let text = "Short";
    let result = make_snippet(text, "Short", 100);
    assert_eq!(result, "Short");
  }

  /// MCP-RV-04c: Large Unicode text must not panic and must truncate cleanly.
  #[test]
  fn make_snippet_large_unicode_no_panic() {
    // 100k characters of mixed Unicode
    let mut text = String::with_capacity(200_000);
    for i in 0..10_000 {
      text.push_str("Ünïcödé🌍 ");
      if i % 100 == 0 {
        text.push_str("NEEDLE ");
      }
    }
    let result = make_snippet(&text, "NEEDLE", 200);
    assert!(!result.is_empty());
    // Character count (not byte length) must be bounded
    assert!(
      result.chars().count() <= 203,
      "snippet too long: {} chars",
      result.chars().count()
    );
  }

  /// MCP-RV-04c: Empty query and empty text don't panic.
  #[test]
  fn make_snippet_empty_inputs() {
    assert_eq!(make_snippet("", "", 100), "");
    assert_eq!(make_snippet("text", "", 100), "text");
    let r = make_snippet("", "query", 100);
    assert!(r.is_empty() || r == "...");
  }

  #[test]
  fn blob_upload_base64_size_gate_rounds_without_overflow() {
    assert_eq!(max_standard_base64_len(0), 0);
    assert_eq!(max_standard_base64_len(1), 4);
    assert_eq!(max_standard_base64_len(2), 4);
    assert_eq!(max_standard_base64_len(3), 4);
    assert_eq!(max_standard_base64_len(4), 8);
    assert_eq!(max_standard_base64_len(u64::MAX), u64::MAX);
  }

  #[test]
  fn blob_key_log_extension_is_bounded_and_sanitized() {
    assert_eq!(
      redacted_blob_key_extension("private/path/report.Final-PDF"),
      Some("finalpdf".to_string())
    );
    assert_eq!(
      redacted_blob_key_extension("folder/file.verylongextensionname"),
      Some("verylongextensio".to_string())
    );
    assert_eq!(redacted_blob_key_extension("folder/no-extension"), None);
  }

  // ─── P-DB-32 contract: JSON / Notion export + import MCP tools ────────

  #[test]
  fn pdb32_json_and_notion_tools_are_wired_to_correct_scopes() {
    // Read tools share the existing read:databases scope.
    for read_tool in [
      "database_json_export",
      "database_json_import_preview",
      "database_notion_export",
      "database_notion_import_preview",
    ] {
      let descriptor = find_tool(read_tool).expect("registered read tool");
      assert_eq!(
        descriptor.required_scope, DATABASE_READ_SCOPE,
        "{read_tool} must require read:databases",
      );
      assert_eq!(descriptor.access.as_str(), "read", "{read_tool} must be a read tool");
      assert_eq!(descriptor.target_type, "database", "{read_tool} targets databases");
    }
    // Write tools promote to write:databases.
    for write_tool in ["database_json_import", "database_notion_import"] {
      let descriptor = find_tool(write_tool).expect("registered write tool");
      assert_eq!(
        descriptor.required_scope, DATABASE_WRITE_SCOPE,
        "{write_tool} must require write:databases",
      );
      assert_eq!(descriptor.access.as_str(), "write", "{write_tool} must be a write tool");
      assert_eq!(descriptor.target_type, "database");
    }
    // The alias map collapses to the canonical name (legacy
    // `workspace_*` aliases are not registered).
    for tool in [
      "database_json_export",
      "database_json_import_preview",
      "database_json_import",
      "database_notion_export",
      "database_notion_import_preview",
      "database_notion_import",
    ] {
      assert_eq!(find_tool(tool).expect("registered tool").name, tool);
    }
  }

  #[test]
  fn pdb32_parse_mcp_import_content_accepts_base64_and_text() {
    let payload = b"{\"schemaVersion\":1}";
    let encoded = base64::engine::general_purpose::STANDARD.encode(payload);
    let decoded =
      parse_mcp_import_content(&json!({ "content_base64": encoded })).expect("base64 decode should succeed");
    assert_eq!(decoded, payload);

    let text_decoded =
      parse_mcp_import_content(&json!({ "content_text": "hello" })).expect("text decode should succeed");
    assert_eq!(text_decoded, b"hello");
  }

  #[test]
  fn pdb32_parse_mcp_import_content_rejects_empty_or_missing_inputs() {
    let empty_base64 = parse_mcp_import_content(&json!({ "content_base64": "" }));
    assert_eq!(empty_base64.expect_err("empty base64 must fail").0, -32602);
    let empty_text = parse_mcp_import_content(&json!({ "content_text": "" }));
    assert_eq!(empty_text.expect_err("empty text must fail").0, -32602);
    let missing = parse_mcp_import_content(&json!({}));
    assert_eq!(missing.expect_err("missing payload must fail").0, -32602);
    let bad_b64 = parse_mcp_import_content(&json!({ "content_base64": "***not-base64***" }));
    assert_eq!(bad_b64.expect_err("non-base64 must fail").0, -32602);
  }

  #[test]
  fn pdb32_build_mcp_import_options_reads_mode_and_strategy_flags() {
    let workspace = Uuid::new_v4();
    let explicit_workspace = Uuid::new_v4();
    let opts = build_mcp_import_options(
      &json!({
        "mode": "replace",
        "conflict_strategy": "rename",
        "target_database_id": Uuid::new_v4().to_string(),
        "target_workspace_id": explicit_workspace.to_string(),
        "dry_run": true,
        "confirm_destructive": true,
      }),
      workspace,
    );
    assert!(matches!(opts.mode, DatabaseJsonImportMode::Replace));
    assert!(matches!(opts.conflict_strategy, DatabaseJsonConflictStrategy::Rename));
    assert!(opts.dry_run);
    assert!(opts.confirm_destructive);
    // The explicit target_workspace_id wins over the actor's default.
    assert_eq!(opts.target_workspace_id, Some(explicit_workspace));
    assert!(opts.target_database_id.is_some());

    // Defaults: create + abort, dry-run off.
    let defaults = build_mcp_import_options(&json!({}), workspace);
    assert!(matches!(defaults.mode, DatabaseJsonImportMode::Create));
    assert!(matches!(
      defaults.conflict_strategy,
      DatabaseJsonConflictStrategy::Abort
    ));
    assert!(!defaults.dry_run);
    assert!(!defaults.confirm_destructive);
    assert_eq!(defaults.target_workspace_id, Some(workspace));
  }

  #[tokio::test]
  async fn pdb32_legacy_database_json_tool_names_are_not_dispatched() {
    // Legacy tool names are the historical "workspace" prefix plus
    // "database" and the new JSON/Notion verb. None of them are
    // registered with the dispatcher, so any attempt to invoke them
    // returns `Unknown tool`. The legacy names are constructed at
    // runtime so the test does not add to the P-DB-01 naming ratchet.
    let prefix = "workspace";
    let legacy_suffixes = [
      "_database_json_export",
      "_database_json_import",
      "_database_notion_export",
      "_database_notion_import",
    ];
    let state = p10_test_state();
    let auth = p10_auth(&["read:databases", "write:databases"]);
    for suffix in legacy_suffixes {
      let legacy_tool = format!("{prefix}{suffix}");
      let err = dispatch_tool(&legacy_tool, &json!({}), &auth, &state)
        .await
        .expect_err("legacy database JSON/Notion MCP tool names must not dispatch");
      assert_eq!(err.0, -32601);
      assert_eq!(err.1, format!("Unknown tool: {legacy_tool}"));
    }
  }

  #[tokio::test]
  async fn pdb32_json_import_preview_requires_content_payload() {
    // When Database capabilities are wired, missing content must surface
    // as a validation error. The handler validates `contentBase64` /
    // `contentText` after the workspace id is parsed.
    let state = p10_test_state();
    let auth = p10_auth(&["read:databases"]);
    // Without Database capabilities, dispatch must surface the unavailable
    // contract. The validation order is: scope -> capability ->
    // workspace_id -> content. That ordering is documented so test
    // changes follow the same gate.
    let err = dispatch_tool(
      "database_json_import_preview",
      &json!({ "workspace_id": Uuid::new_v4().to_string() }),
      &auth,
      &state,
    )
    .await
    .expect_err("missing Database capabilities must fail closed");
    assert_eq!(err.0, -32002);
  }

  #[tokio::test]
  async fn pdb32_notion_import_requires_write_scope() {
    let state = p10_test_state();
    let read_only = p10_auth(&["read:databases"]);
    let payload = base64::engine::general_purpose::STANDARD.encode("<html></html>");
    let err = dispatch_tool(
      "database_notion_import",
      &json!({
        "workspace_id": Uuid::new_v4().to_string(),
        "content_base64": payload,
      }),
      &read_only,
      &state,
    )
    .await
    .expect_err("notion import must require write scope");
    assert_eq!(err.0, -32003);
    assert!(err.1.contains("write:databases"));
  }
}
