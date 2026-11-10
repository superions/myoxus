//! Causal MCP coverage for readable canonical document templates.

use std::{
  collections::BTreeSet,
  sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
  },
};

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::FutureExt;
use myoxus_application::auth::{AuthError, AuthStore, EffectiveUserPreferences, UserPreferenceDefaults};
use myoxus_application::doc::{DocService, DocumentMutation, document_fragment_from_markdown};
use myoxus_application::document_metadata::DocumentMetadataService;
use myoxus_application::document_template::{
  DocumentTemplateAccount, DocumentTemplateActor, DocumentTemplateDestination, DocumentTemplateError,
  DocumentTemplateFolderSelector, DocumentTemplateMetadata, DocumentTemplatePlacement, DocumentTemplateService,
  OrganizerDocumentTemplatePlacement,
};
use myoxus_application::organizer::{CreateOrganizerFolder, OrganizerService, OrganizerSnapshotNode};
use myoxus_application::permission::PermissionService;
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest};
use myoxus_application::workspace::WorkspaceService;
use myoxus_application::workspace_content_operation::link::WorkspaceContentLinkError;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::blob::SqlxBlobStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::tools::{McpToolState, dispatch_tool};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::helpers;

fn build_tool_state(pool: &sqlx::PgPool) -> (McpToolState, DocService) {
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let permission = Arc::new(PermissionService::new(auth_store.clone()));
  let docs = DocService::new(doc_store);
  let metadata_repo = Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  let templates = Arc::new(
    DocumentTemplateService::new(metadata_repo.clone(), Arc::new(docs.clone()), permission.clone())
      .with_mutations(
        DocumentMetadataService::new(metadata_repo),
        Arc::new(OrganizerDocumentTemplatePlacement::new(
          docs.clone(),
          permission.clone(),
        )),
      )
      .with_workspace_context(WorkspaceService::new(workspace_store.clone()))
      .with_account(Arc::new(TemplateAccountPreferences(auth_store))),
  );
  (
    McpToolState {
      html_catalog: Some(Arc::new(
        myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
          std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html"),
        ),
      )),
      workspace_service: WorkspaceService::new(workspace_store),
      workspace_settings_service: None,
      public_repository: None,
      public_delivery_enabled: false,
      document_publication_service: None,
      doc_service: docs.clone(),
      comment_service: None,
      server_origin: Arc::from("https://myoxus.test"),
      permission_service: permission,
      search_indexer: None,
      search_repository: None,
      assistant_packages: None,
      database_services: None,
      calendar: None,
      organization: None,
      users: None,
      workspace_tag_service: None,
      document_graph_service: None,
      document_template_service: Some(templates),
      template_registry: None,
      template_suggestions: None,
      workspace_automation_service: None,
      pdf_export_service: None,
      pdf_template_repo: None,
      pdf_assignment_repo: None,
      document_services: Arc::new(myoxus_application::mcp::UnavailableMcpDocumentOperations),
      idempotency: Arc::new(myoxus_application::mcp::InMemoryMcpIdempotencyRepository::default()),
      blob_service: None,
      upload_policy: None,
      audit_recorder: myoxus_application::audit::AuditRecorder::noop(),
      metrics_service: Arc::new(myoxus_application::metrics::MetricsService::in_memory_stub()),
      document_cursor_signing_key: Arc::from(&b"mcp-document-template-test-cursor-key"[..]),
      document_export_max_bytes: 8 * 1024 * 1024,
    },
    docs,
  )
}

struct TemplateAccountPreferences(Arc<SqlxAuthStore>);

#[async_trait]
impl DocumentTemplateAccount for TemplateAccountPreferences {
  async fn effective_preferences(&self, actor: Uuid) -> Result<EffectiveUserPreferences, AuthError> {
    Ok(
      self
        .0
        .get_user_preferences(actor)
        .await?
        .values
        .resolve(&UserPreferenceDefaults::default()),
    )
  }
  async fn applying_actor(&self, actor: Uuid) -> Result<Option<DocumentTemplateActor>, AuthError> {
    Ok(
      self
        .0
        .get_user_by_id(actor)
        .await?
        .filter(|user| !user.disabled && user.registered)
        .map(|user| DocumentTemplateActor {
          name: user.name,
          email: user.email,
        }),
    )
  }
}

#[tokio::test]
async fn inv_mcp_omitted_template_facts_use_committed_target_capture_and_stable_replay() {
  use chrono::Datelike;
  use myoxus_application::auth::UserPreferencesPatch;
  use std::collections::HashMap;
  let pool = helpers::setup_pool().await;
  let store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (creator, _) = helpers::seed_user_with_name(&pool, &store, "mcp-facts-source", "Original creator").await;
  let (actor, _) = helpers::seed_user_with_name(&pool, &store, "mcp-facts-actor", "Applying actor").await;
  let workspace = helpers::create_workspace(&pool, creator).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    helpers::add_workspace_member(&pool, workspace, actor).await;
    store.patch_user_preferences(actor, UserPreferencesPatch {
      locale: Some(Some("de-DE".into())), timezone: Some(Some("Pacific/Kiritimati".into())),
      date_format: Some(Some("year-month-day".into())), time_format: Some(Some("24-hour".into())),
      ..Default::default()
    }).await.expect("effective regional preferences");
    let (mut state, docs) = build_tool_state(&pool);
    state.workspace_service.seed_root_doc(workspace, creator,
      yjs::create_initial_workspace_doc("Authoritative facts workspace")).await.expect("root");
    let (assets, _, _temporary_storage) = blob_test_services(&pool);
    state.document_template_service = Some(Arc::new(state.document_template_service.as_ref().unwrap()
      .as_ref().clone().with_instantiation_assets(assets.clone())));
    let service = state.document_template_service.as_ref().unwrap();
    let top = OrganizerService::new(docs.clone()).create_folder(workspace, CreateOrganizerFolder {
      id:Uuid::new_v4().to_string(), parent_id:None, name:"Top".into(), index:None,
    }).await.expect("ancestor");
    let folder = OrganizerService::new(docs.clone()).create_folder(workspace, CreateOrganizerFolder {
      id:Uuid::new_v4().to_string(), parent_id:Some(top.id), name:"Facts".into(), index:None,
    }).await.expect("destination");
    let blocks = serde_json::from_value::<Vec<yjs::PortableSnapshotBlock>>(json!([
      {"id":"page","flavour":"myoxus:page","children":["note"],"props":{"title":"Handover {{creator.name}}"}},
      {"id":"note","flavour":"myoxus:note","children":["body","repeat"]},
      {"id":"body","flavour":"myoxus:paragraph","props":{"text":"{{workspace.name}} | {{creator.name}} | {{creator.email}} | {{document.created_at.date}} {{document.created_at.time}} | {{date}} | {{actor.name}} | {{actor.email}} | {{folder.path}} | {{week}}/{{calendar.iso_week_year}}"}},
      {"id":"repeat","flavour":"myoxus:list","props":{"type":"todo","checked":false,
        "text":"{{member.name}} · {{member.email}}","repeat":{"source":"workspace.members","alias":"member"}}}
    ])).expect("native source");
    let (source, _) = docs.create_page_from_snapshot_with_sync_updates(workspace, creator,
      Some("Handover {{creator.name}}".into()), yjs::snapshot_blocks_to_yjs(&blocks).unwrap()).await.unwrap();
    sqlx::query("INSERT INTO document_template_state(doc_id,state,source,materialized_at,updated_by) VALUES($1,'managed','document',now(),$2)")
      .bind(source.id).bind(creator).execute(&pool).await.unwrap();
    let source_before = docs.load_full_doc(workspace, source.id).await.unwrap();
    let params = json!({"workspace_id":workspace,"template_external_id":source.external_id,
      "folder_id":folder.id,"idempotency_key":"omitted-automatic"});
    let credential = auth(actor, &["read:docs","write:docs"]);
    let result = payload(dispatch_tool("document_template_instantiate", &params, &credential, &state).await.unwrap());
    let (target, created_by, created_at): (Uuid, Option<Uuid>, chrono::DateTime<chrono::Utc>) =
      sqlx::query_as("SELECT id,created_by,created_at FROM docs WHERE workspace_id=$1 AND external_id=$2")
      .bind(workspace).bind(result["externalId"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(created_by, Some(actor));
    let snapshot = docs.load_full_doc(workspace, target).await.unwrap();
    let content = yjs::extract_text_from_yjs(&snapshot).unwrap();
    let email: String = sqlx::query_scalar("SELECT email FROM users WHERE id=$1").bind(actor).fetch_one(&pool).await.unwrap();
    assert_eq!(content.title.as_deref(), Some("Handover Applying actor"));
    // Markdown correctly escapes the underscore in the fixture email. Check
    // the actual native body, not unescaped text against an export projection.
    let body = yjs::extract_blocks_from_yjs(&snapshot).unwrap().blocks.into_iter()
      .find(|block| block.id == "body").expect("preserved native body").text;
    assert!(body.contains(&format!("Applying actor | {email} | {}",
      created_at.with_timezone(&chrono_tz::Pacific::Kiritimati).format("%Y-%m-%d %H:%M"))), "{body}");
    let application_day = chrono::NaiveDate::parse_from_str(body.split(" | ").nth(4).expect("actual application date"), "%Y-%m-%d").unwrap();
    assert!(body.ends_with(&format!(" | Applying actor | {email} | Top/Facts | {}/{}", application_day.iso_week().week(), application_day.iso_week().year())), "{body}");
    assert_eq!(result["folderPath"], json!(["Top", "Facts"]));
    assert!(content.markdown.contains("- [ ] Original creator"));
    assert!(content.markdown.contains("- [ ] Applying actor"));
    assert!(yjs::instantiate_native_template(&snapshot, &HashMap::new()).unwrap().unresolved_variables.is_empty(),
      "expanded target must contain no active repeat bindings or unresolved names");
    assert_eq!(docs.load_full_doc(workspace, source.id).await.unwrap(), source_before);

    // Caller records remain literal and ordered, even though creation facts
    // force the late path. Braces inserted in preflight are never re-evaluated.
    let mut explicit = params.clone();
    explicit["idempotency_key"] = json!("literal-records-with-late-creator");
    explicit["variables"] = json!({"workspace.name":"Authored {{literal}}", "date":"Caller date",
      "creator.name":"Caller-supplied creator", "creator.email":"caller@example.test",
      "workspace.members":[{"name":"Z {{member.name}}","email":"z@example.test"},
        {"name":"A","email":"a@example.test"}]});
    let explicit_result = payload(dispatch_tool("document_template_instantiate", &explicit, &credential, &state).await.unwrap());
    let explicit_id: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2")
      .bind(workspace).bind(explicit_result["externalId"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
    let text = yjs::extract_text_from_yjs(&docs.load_full_doc(workspace, explicit_id).await.unwrap()).unwrap().markdown;
    assert!(text.contains("Authored {{literal}}") && text.contains("Caller date"));
    assert!(text.contains("Caller-supplied creator") && text.contains("Applying actor"), "explicit creator does not override authenticated actor: {text}");
    assert!(text.find("Z {{member.name}}").expect("literal first record")
      < text.find("A · a@example.test").expect("literal second record"));
    assert!(!text.contains("Original creator"));

    docs.rename_page(workspace, target, actor, "Edited ordinary target".into(), None).await.unwrap();
    let edited = docs.load_full_doc(workspace, target).await.unwrap();
    sqlx::query("UPDATE users SET name='Changed actor' WHERE id=$1").bind(actor).execute(&pool).await.unwrap();
    store.patch_user_preferences(actor, UserPreferencesPatch {
      timezone: Some(Some("America/Los_Angeles".into())), ..Default::default()
    }).await.unwrap();
    assert_eq!(payload(dispatch_tool("document_template_instantiate", &params, &credential, &state).await.unwrap()), result);
    assert_eq!(docs.load_full_doc(workspace, target).await.unwrap(), edited);

    let static_source = create_template(&pool, &docs, workspace, creator, "Static protected names", "Literal content", "managed", "document").await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
    for reserved in ["organization_name","organization_unit_name","parent_page_title","folder_name", "actor.name", "actor.email", "folder.path", "calendar.iso_week_year"] {
      let mut denied = params.clone(); denied["idempotency_key"] = json!(reserved);
      denied["template_external_id"] = json!(static_source.external_id);
      denied["variables"] = json!({reserved:"Unused forged value"});
      assert!(dispatch_tool("document_template_instantiate", &denied, &credential, &state).await.is_err());
    }
    let mut unknown = params.clone(); unknown["title"] = json!("{{unknown}}"); unknown["idempotency_key"] = json!("unknown-zero-write");
    assert!(dispatch_tool("document_template_instantiate", &unknown, &credential, &state).await.is_err());
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap(), count);

    // Optional Project context belongs to the same ordinary native owner:
    // manual Library use has no inferred Project, people or dates.
    let optional_source = create_template(&pool, &docs, workspace, creator, "Optional Project context",
      "{{project.title}}|{{project.goal}}|{{project.scope}}|{{project.start_date}}|{{project.end_date}}|{{project.people}}",
      "managed", "document").await;
    let selector = DocumentTemplateFolderSelector::Id(folder.id.clone());
    let prepared = service.preflight_instantiate(actor, workspace, &optional_source.external_id, &selector,
      None, &HashMap::new(), None).await.unwrap();
    let empty = service.instantiate(actor, workspace, prepared).await.unwrap();
    let body = yjs::extract_blocks_from_yjs(&docs.load_full_doc(workspace, empty.doc_id).await.unwrap()).unwrap().blocks
      .into_iter().find(|block| block.flavour == "myoxus:paragraph").expect("ordinary native body").plain_text;
    assert_eq!(body, "|||||", "manual application must not invent Project context");
    let explicit_values = HashMap::from([
      ("project.title".into(), myoxus_application::document_template::DocumentTemplateVariable::String("Literal {{workspace.name}}".into())),
      ("project.goal".into(), myoxus_application::document_template::DocumentTemplateVariable::String("Goal".into())),
      ("project.scope".into(), myoxus_application::document_template::DocumentTemplateVariable::String("Scope".into())),
      ("project.start_date".into(), myoxus_application::document_template::DocumentTemplateVariable::String("2026-10-17".into())),
      ("project.end_date".into(), myoxus_application::document_template::DocumentTemplateVariable::String("2026-10-20".into())),
      ("project.people".into(), myoxus_application::document_template::DocumentTemplateVariable::String("Named accepted member".into())),
    ]);
    let prepared = service.preflight_instantiate(actor, workspace, &optional_source.external_id, &selector,
      None, &explicit_values, None).await.unwrap();
    let explicit_copy = service.instantiate(actor, workspace, prepared).await.unwrap();
    let body = yjs::extract_blocks_from_yjs(&docs.load_full_doc(workspace, explicit_copy.doc_id).await.unwrap()).unwrap().blocks
      .into_iter().find(|block| block.flavour == "myoxus:paragraph").expect("literal native body").plain_text;
    assert_eq!(body, "Literal {{workspace.name}}|Goal|Scope|2026-10-17|2026-10-20|Named accepted member");
    let required_source = create_template(&pool, &docs, workspace, creator, "Required input",
      "{{input.required}}", "managed", "document").await;
    let unknown_source = create_template(&pool, &docs, workspace, creator, "Unknown variable",
      "{{project.unknown}}", "managed", "document").await;
    let before_rejections: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1")
      .bind(workspace).fetch_one(&pool).await.unwrap();
    for source in [&required_source, &unknown_source] {
      assert!(service.preflight_instantiate(actor, workspace, &source.external_id, &selector,
        None, &HashMap::new(), None).await.is_err());
    }
    let mut oversized = explicit_values.clone();
    oversized.insert("project.goal".into(), myoxus_application::document_template::DocumentTemplateVariable::String("x".repeat(8193)));
    assert!(matches!(service.preflight_instantiate(actor, workspace, &optional_source.external_id, &selector,
      None, &oversized, None).await, Err(DocumentTemplateError::InvalidVariables)));
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE workspace_id=$1")
      .bind(workspace).fetch_one(&pool).await.unwrap(), before_rejections);

    // Capture once, then change the source through the ordinary lifecycle.
    // A later source revision must not become the prepared target's content.
    let selector = DocumentTemplateFolderSelector::Id(folder.id.clone());
    let prepared = service.preflight_instantiate(actor, workspace, &source.external_id, &selector,
      None, &HashMap::new(), None).await.unwrap();
    docs.rename_page(workspace, source.id, creator, "Changed source after preflight".into(), None).await.unwrap();
    let captured = service.instantiate(actor, workspace, prepared).await.unwrap();
    assert_eq!(yjs::extract_text_from_yjs(&docs.load_full_doc(workspace, captured.doc_id).await.unwrap()).unwrap()
      .title.as_deref(), Some("Handover Changed actor"));

    // The ordinary ingress limit also applies when a committed creator value
    // expands the late snapshot. A valid account name can grow many tokens.
    let size_source = create_template(&pool, &docs, workspace, creator, "Late size guard",
      &"{{creator.name}} ".repeat(64), "managed", "document").await;
    let initial = docs.load_full_doc(workspace, size_source.id).await.unwrap();
    let unexpanded_size = yjs::instantiate_native_template(&initial, &HashMap::new()).unwrap().snapshot.len();
    let expanded_size = yjs::instantiate_native_template(&initial, &HashMap::from([
      ("creator.name".into(), yjs::NativeTemplateVariable::String("X".repeat(64)))
    ])).unwrap().snapshot.len();
    let max_bytes = (unexpanded_size + expanded_size) / 2;
    assert!(unexpanded_size < max_bytes && max_bytes < expanded_size,
      "fixture must straddle the existing ingress policy, not guess raw source size");
    let limited_docs = docs.clone().with_external_update_ingress_max_bytes(max_bytes);
    let repository = Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
    let limited_service = DocumentTemplateService::new(repository.clone(), Arc::new(limited_docs.clone()), state.permission_service.clone())
      .with_mutations(DocumentMetadataService::new(repository),
        Arc::new(OrganizerDocumentTemplatePlacement::new(limited_docs, state.permission_service.clone())))
      .with_instantiation_assets(assets).with_workspace_context(state.workspace_service.clone());
    let prepared_size = limited_service.preflight_instantiate(actor, workspace, &size_source.external_id,
      &selector, None, &HashMap::new(), None).await.expect("unexpanded source fits ingress limit");
    sqlx::query("UPDATE users SET name=$2 WHERE id=$1").bind(actor).bind("X".repeat(64)).execute(&pool).await.unwrap();
    let alive_before_size: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1 AND deleted_at IS NULL")
      .bind(workspace).fetch_one(&pool).await.unwrap();
    assert!(matches!(limited_service.instantiate(actor, workspace, prepared_size).await, Err(DocumentTemplateError::Compensated)),
      "late expansion must not bypass bounded ingress");
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE workspace_id=$1 AND deleted_at IS NULL")
      .bind(workspace).fetch_one(&pool).await.unwrap(), alive_before_size);
    let prepared = service.preflight_instantiate(actor, workspace, &source.external_id, &selector,
      None, &HashMap::new(), None).await.unwrap();
    sqlx::query("UPDATE users SET name='' WHERE id=$1").bind(actor).execute(&pool).await.unwrap();
    let alive: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1 AND deleted_at IS NULL")
      .bind(workspace).fetch_one(&pool).await.unwrap();
    let organizer_before = OrganizerService::new(docs.clone()).snapshot(workspace).await.unwrap();
    assert!(matches!(service.instantiate(actor, workspace, prepared).await, Err(DocumentTemplateError::Compensated)));
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE workspace_id=$1 AND deleted_at IS NULL")
      .bind(workspace).fetch_one(&pool).await.unwrap(), alive);
    let organizer = OrganizerService::new(docs.clone()).snapshot(workspace).await.unwrap();
    assert_eq!(organizer.roots, organizer_before.roots, "late failure must publish no entry");
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[creator, actor]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

fn auth(user_id: Uuid, scopes: &[&str]) -> McpAuthContext {
  McpAuthContext {
    user_id,
    scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
    key_id: Uuid::new_v4(),
  }
}

struct RejectTemplateMetadata;

#[async_trait]
impl DocumentTemplateMetadata for RejectTemplateMetadata {
  async fn set_template_state(
    &self,
    _doc_id: Uuid,
    _actor_id: Uuid,
    is_template: bool,
  ) -> Result<(), DocumentTemplateError> {
    if is_template {
      Err(DocumentTemplateError::Content)
    } else {
      Ok(())
    }
  }
}

struct RejectFirstNonTemplateMetadata(AtomicBool);

#[async_trait]
impl DocumentTemplateMetadata for RejectFirstNonTemplateMetadata {
  async fn set_template_state(
    &self,
    _doc_id: Uuid,
    _actor_id: Uuid,
    is_template: bool,
  ) -> Result<(), DocumentTemplateError> {
    if !is_template && !self.0.swap(true, Ordering::SeqCst) {
      Err(DocumentTemplateError::Content)
    } else {
      Ok(())
    }
  }
}

struct RejectPlacement {
  delegate: OrganizerDocumentTemplatePlacement,
  reject_cleanup: bool,
}

#[tokio::test]
async fn inv_mcp_document_template_uncertain_placement_retains_live_target_and_replay_proof() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner, _) = helpers::seed_user(&pool, &auth_store, "mcp-template-uncertain-placement").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let outcome=std::panic::AssertUnwindSafe(async {
    let (mut state,docs)=build_tool_state(&pool);
    let auth=McpAuthContext{user_id:owner,key_id:Uuid::new_v4(),scopes:vec!["read:docs".into(),"write:docs".into()]};
    sqlx::query("INSERT INTO api_keys(id,user_id,name,key_hash,scopes) VALUES($1,$2,'owned compensation fixture',$3,$4)")
      .bind(auth.key_id).bind(owner).bind(format!("owned-template-{}",auth.key_id)).bind(&auth.scopes).execute(&pool).await.expect("owned replay identity");
    state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    state.workspace_service.seed_root_doc(workspace,owner,yjs::create_initial_workspace_doc("Template cleanup fixture")).await.expect("workspace root");
    let folder=OrganizerService::new(docs.clone()).create_folder(workspace,CreateOrganizerFolder{id:Uuid::new_v4().to_string(),name:"Templates".into(),parent_id:None,index:None}).await.expect("destination");
    let metadata=Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
    state.document_template_service=Some(Arc::new(DocumentTemplateService::new(metadata.clone(),Arc::new(docs.clone()),state.permission_service.clone())
      .with_mutation_ports(Arc::new(DocumentMetadataService::new(metadata)),Arc::new(RejectPlacement{delegate:OrganizerDocumentTemplatePlacement::new(docs.clone(),state.permission_service.clone()),reject_cleanup:true}))));
    let args=json!({"workspace_id":workspace,"title":"Uncertain cleanup","content_markdown":"Private preserved template content","folder_id":folder.id,"idempotency_key":"uncertain-template-cleanup"});
    let failed=dispatch_tool("document_template_create",&args,&auth,&state).await.expect_err("post-commit placement failure and failed cleanup");
    assert_eq!(failed.1,"MIX_MCP_DOCUMENT_TEMPLATE_COMPENSATION_FAILED");
    let (doc_id,external,deleted):(Uuid,String,Option<chrono::DateTime<chrono::Utc>>)=sqlx::query_as("SELECT id,external_id,deleted_at FROM docs WHERE workspace_id=$1 AND title='Uncertain cleanup'").bind(workspace).fetch_one(&pool).await.expect("retained target");
    assert!(deleted.is_none(),"published placement must retain its live target when removal fails");
    let snapshot=OrganizerService::new(docs.clone()).snapshot(workspace).await.expect("native organizer state");
    assert!(snapshot_contains_target(&snapshot.roots,&external));
    let content=docs.load_full_doc_consistent(workspace,doc_id).await.expect("uncertain compensation preserves native content");
    assert!(yjs::extract_text_from_yjs(&content).expect("native document projection").markdown.contains("Private preserved template content"));
    let counts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM docs WHERE workspace_id=$1),(SELECT count(*) FROM doc_updates WHERE workspace_id=$1)").bind(workspace).fetch_one(&pool).await.expect("durable effects");
    for _ in 0..2 {
      let replay=dispatch_tool("document_template_create",&args,&auth,&state).await.expect_err("uncertain effects must never be replayed as a new mutation");
      assert!(replay.1.starts_with("MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED"));assert!(!replay.1.contains("Private preserved"));
      assert_eq!(sqlx::query_as::<_,(i64,i64)>("SELECT (SELECT count(*) FROM docs WHERE workspace_id=$1),(SELECT count(*) FROM doc_updates WHERE workspace_id=$1)").bind(workspace).fetch_one(&pool).await.expect("replay effects"),counts);
    }
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[async_trait]
impl DocumentTemplatePlacement for RejectPlacement {
  async fn resolve_destination(
    &self,
    workspace_id: Uuid,
    selector: &DocumentTemplateFolderSelector,
  ) -> Result<DocumentTemplateDestination, DocumentTemplateError> {
    self.delegate.resolve_destination(workspace_id, selector).await
  }

  async fn create_entry(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    entry_id: &str,
    destination: &DocumentTemplateDestination,
    external_id: &str,
  ) -> Result<(), DocumentTemplateError> {
    self
      .delegate
      .create_entry(actor_id, workspace_id, entry_id, destination, external_id)
      .await?;
    Err(DocumentTemplateError::Placement(
      WorkspaceContentLinkError::DependencyUnavailable,
    ))
  }

  async fn delete_entry(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    entry_id: &str,
  ) -> Result<(), DocumentTemplateError> {
    if self.reject_cleanup {
      return Err(DocumentTemplateError::Placement(
        WorkspaceContentLinkError::DependencyUnavailable,
      ));
    }
    self.delegate.delete_entry(actor_id, workspace_id, entry_id).await
  }
}

fn payload(response: Value) -> Value {
  serde_json::from_str(response["content"][0]["text"].as_str().expect("MCP content text"))
    .expect("structured MCP response")
}

fn snapshot_contains_target(nodes: &[OrganizerSnapshotNode], external_id: &str) -> bool {
  nodes
    .iter()
    .any(|node| node.row.data == external_id || snapshot_contains_target(&node.children, external_id))
}

fn blob_test_services(pool: &sqlx::PgPool) -> (Arc<BlobService>, Arc<dyn BlobStoragePort>, tempfile::TempDir) {
  let storage_dir = tempfile::tempdir().expect("temporary document-template asset storage");
  let storage = Arc::new(
    StorageAdapter::new_fs(storage_dir.path().to_string_lossy().as_ref()).expect("template asset storage adapter"),
  );
  let storage_port: Arc<dyn BlobStoragePort> = storage;
  let blob_service = Arc::new(BlobService::new(
    Arc::new(SqlxBlobStore::new(pool.clone())),
    storage_port.clone(),
    "mcp-document-template-test".to_string(),
  ));
  (blob_service, storage_port, storage_dir)
}

async fn seed_blob(blob_service: &BlobService, storage: &Arc<dyn BlobStoragePort>, workspace_id: Uuid, key: &str) {
  blob_service
    .initialize_upload(workspace_id, key, 5, "image/png")
    .await
    .expect("initialize template asset");
  storage
    .write_blob(BlobWriteRequest {
      key: format!("{workspace_id}/{key}"),
      content_type: Some("image/png".to_string()),
      body: Bytes::from_static(b"asset"),
    })
    .await
    .expect("write template asset");
  blob_service
    .complete_upload(workspace_id, key)
    .await
    .expect("complete template asset");
}

async fn create_template(
  pool: &sqlx::PgPool,
  docs: &DocService,
  workspace_id: Uuid,
  actor_id: Uuid,
  title: &str,
  markdown: &str,
  state: &str,
  source: &str,
) -> myoxus_domain::entities::Doc {
  let fragment = document_fragment_from_markdown(markdown).expect("valid template Markdown");
  let commit = docs
    .create_page_lifecycle(workspace_id, actor_id, Some(title.to_string()), Some(fragment))
    .await
    .expect("create canonical template document");
  sqlx::query(
    "INSERT INTO document_template_state (doc_id, state, source, materialized_at, updated_by) \
     VALUES ($1, $2, $3, now(), $4)",
  )
  .bind(commit.document.id)
  .bind(state)
  .bind(source)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("mark canonical document template state");
  commit.document
}

#[tokio::test]
async fn inv_mcp_document_templates_are_truthful_acl_filtered_paginated_and_body_free() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-template-owner").await;
  let (external_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-template-external").await;
  let (outsider_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-template-outsider").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let (state, docs) = build_tool_state(&pool);
  state
    .workspace_service
    .seed_root_doc(
      workspace_id,
      owner_id,
      yjs::create_initial_workspace_doc("Document template test workspace"),
    )
    .await
    .expect("seed workspace root");

  let managed = create_template(
    &pool,
    &docs,
    workspace_id,
    owner_id,
    "Plan {{ owner_name }}",
    "Project {{ project.name }} belongs to {{owner_name}}. Secret body marker.",
    "managed",
    "document",
  )
  .await;
  let seeded = create_template(
    &pool,
    &docs,
    workspace_id,
    owner_id,
    "Builtin {{ locale }}",
    "Registry materialized content for {{ project.name }}.",
    "seeded",
    "workspace",
  )
  .await;
  let trashed = create_template(
    &pool,
    &docs,
    workspace_id,
    owner_id,
    "Trashed {{ hidden }}",
    "Must not be discoverable.",
    "managed",
    "document",
  )
  .await;
  let retired = create_template(
    &pool,
    &docs,
    workspace_id,
    owner_id,
    "Retired {{ hidden }}",
    "Must not be discoverable.",
    "retired",
    "workspace",
  )
  .await;
  sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
    .bind(trashed.id)
    .execute(&pool)
    .await
    .expect("trash template fixture");
  // Make the expected page order explicit rather than depending on clock
  // resolution in a shared integration database.
  sqlx::query("UPDATE docs SET created_at = now() - interval '2 seconds' WHERE id = $1")
    .bind(managed.id)
    .execute(&pool)
    .await
    .expect("order managed template fixture");
  sqlx::query("UPDATE docs SET created_at = now() - interval '1 second' WHERE id = $1")
    .bind(seeded.id)
    .execute(&pool)
    .await
    .expect("order seeded template fixture");

  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'External', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(external_id)
  .execute(&pool)
  .await
  .expect("add external workspace member");
  sqlx::query("INSERT INTO doc_user_permissions (user_id, doc_id, role) VALUES ($1, $2, 'Reader')")
    .bind(external_id)
    .bind(managed.id)
    .execute(&pool)
    .await
    .expect("grant one template to external member");

  let owner_auth = auth(owner_id, &["read:docs"]);
  let first_page = payload(
    dispatch_tool(
      "document_template_list",
      &json!({ "workspace_id": workspace_id, "limit": 1 }),
      &owner_auth,
      &state,
    )
    .await
    .expect("list first readable template page"),
  );
  assert_eq!(first_page["offset"], 0);
  assert_eq!(first_page["limit"], 1);
  assert_eq!(first_page["nextOffset"], 1);
  assert_eq!(first_page["templates"][0]["externalId"], seeded.external_id);
  assert_eq!(first_page["templates"][0]["isTemplate"], true);
  assert_eq!(
    first_page["templates"][0]["requiredVariables"],
    json!(["locale", "project.name"])
  );

  let second_page = payload(
    dispatch_tool(
      "document_template_list",
      &json!({ "workspace_id": workspace_id, "offset": 1, "limit": 1 }),
      &owner_auth,
      &state,
    )
    .await
    .expect("list second readable template page"),
  );
  assert_eq!(second_page["templates"][0]["externalId"], managed.external_id);
  assert_eq!(second_page["nextOffset"], Value::Null);
  assert_eq!(
    second_page["templates"][0]["requiredVariables"],
    json!(["owner_name", "project.name"])
  );
  let serialized_page = second_page.to_string();
  assert!(!serialized_page.contains("Secret body marker"));
  assert!(!serialized_page.contains(&trashed.external_id));
  assert!(!serialized_page.contains(&retired.external_id));
  let item_keys = second_page["templates"][0]
    .as_object()
    .expect("compact template object")
    .keys()
    .map(String::as_str)
    .collect::<BTreeSet<_>>();
  assert_eq!(
    item_keys,
    BTreeSet::from(["externalId", "isTemplate", "requiredVariables", "title"]),
    "runtime output must not add body, state or internal-identity fields"
  );

  let external_auth = auth(external_id, &["read:docs"]);
  let denied_catalog = dispatch_tool(
    "document_template_list",
    &json!({ "workspace_id": workspace_id }),
    &external_auth,
    &state,
  )
  .await
  .expect_err("External catalog exclusion ignores document grants");
  assert_eq!(denied_catalog.0, -32003);

  let denied_source = dispatch_tool(
    "document_template_get",
    &json!({ "workspace_id": workspace_id, "external_id": managed.external_id }),
    &external_auth,
    &state,
  )
  .await
  .expect_err("External cannot retrieve a granted catalog source");
  assert_eq!(denied_source.0, -32003);

  let denied_document = dispatch_tool(
    "document_template_get",
    &json!({ "workspace_id": workspace_id, "external_id": seeded.external_id }),
    &external_auth,
    &state,
  )
  .await
  .expect_err("External cannot retrieve any catalog source");
  assert_eq!(denied_document.0, -32003);

  sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2")
    .bind(workspace_id)
    .bind(external_id)
    .execute(&pool)
    .await
    .unwrap();
  let visible = payload(
    dispatch_tool(
      "document_template_list",
      &json!({"workspace_id":workspace_id}),
      &external_auth,
      &state,
    )
    .await
    .expect("Reader sees full native source inventory"),
  );
  assert_eq!(visible["templates"].as_array().unwrap().len(), 2);
  let selected = payload(
    dispatch_tool(
      "document_template_get",
      &json!({"workspace_id":workspace_id,"external_id":seeded.external_id}),
      &external_auth,
      &state,
    )
    .await
    .expect("Reader source retrieval needs no document grant"),
  );
  assert_eq!(selected["externalId"], seeded.external_id);

  let denied_scope = dispatch_tool(
    "document_template_list",
    &json!({ "workspace_id": workspace_id }),
    &auth(owner_id, &["read:workspaces"]),
    &state,
  )
  .await
  .expect_err("MCP credential without read:docs must fail before ACL evaluation");
  assert_eq!(denied_scope.0, -32003);

  let denied_workspace = dispatch_tool(
    "document_template_list",
    &json!({ "workspace_id": workspace_id }),
    &auth(outsider_id, &["read:docs"]),
    &state,
  )
  .await
  .expect_err("read:docs must not grant workspace visibility");
  assert_eq!(denied_workspace.0, -32003);

  helpers::cleanup_users(&pool, &[owner_id, external_id, outsider_id]).await;
}

#[tokio::test]
async fn inv_mcp_document_template_writes_preflight_replay_authorize_and_compensate() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-template-write-owner").await;
  let (reader_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-template-write-reader").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let (mut state, docs) = build_tool_state(&pool);
  state
    .workspace_service
    .seed_root_doc(
      workspace_id,
      owner_id,
      yjs::create_initial_workspace_doc("Document template write workspace"),
    )
    .await
    .expect("seed workspace root");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'Reader', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(reader_id)
  .execute(&pool)
  .await
  .expect("add read-only workspace member");

  let folder = OrganizerService::new(docs.clone())
    .create_folder(
      workspace_id,
      CreateOrganizerFolder {
        id: Uuid::new_v4().to_string(),
        parent_id: None,
        name: "Reusable templates".to_string(),
        index: None,
      },
    )
    .await
    .expect("create existing destination folder");
  let owner_write = auth(owner_id, &["write:docs"]);
  let create_params = json!({
    "workspace_id": workspace_id,
    "title": "Project brief {{ project.name }}",
    "content_markdown": "Owner: {{ owner_name }}",
    "folder_id": folder.id,
    "idempotency_key": "template-create-replay",
  });

  let invalid_destination = dispatch_tool(
    "document_template_create",
    &json!({
      "workspace_id": workspace_id,
      "title": "Must not exist",
      "content_markdown": "No write",
      "folder_id": Uuid::new_v4().to_string(),
      "idempotency_key": "template-create-missing-folder",
    }),
    &owner_write,
    &state,
  )
  .await
  .expect_err("missing destination must fail before page creation");
  assert_eq!(invalid_destination.0, -32004);
  let invalid_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1 AND title = $2")
    .bind(workspace_id)
    .bind("Must not exist")
    .fetch_one(&pool)
    .await
    .expect("count zero-write preflight title");
  assert_eq!(invalid_count, 0);

  let denied = dispatch_tool(
    "document_template_create",
    &json!({
      "workspace_id": workspace_id,
      "title": "Reader must not create",
      "content_markdown": "No write",
      "folder_id": folder.id,
      "idempotency_key": "template-create-reader-denied",
    }),
    &auth(reader_id, &["write:docs"]),
    &state,
  )
  .await
  .expect_err("write scope must not replace Workspace CreateDoc");
  assert_eq!(denied.0, -32003);

  let created_once = payload(
    dispatch_tool("document_template_create", &create_params, &owner_write, &state)
      .await
      .expect("create document template"),
  );
  let created_replay = payload(
    dispatch_tool("document_template_create", &create_params, &owner_write, &state)
      .await
      .expect("replay document template create"),
  );
  assert_eq!(created_once, created_replay);
  assert_eq!(created_once["isTemplate"], true);
  assert_eq!(created_once["folderId"], folder.id);
  assert!(created_once.get("templateState").is_none());
  let created_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL")
      .bind(workspace_id)
      .bind("Project brief {{ project.name }}")
      .fetch_one(&pool)
      .await
      .expect("count replay-safe created template");
  assert_eq!(created_count, 1);

  let plain = docs
    .create_page_lifecycle(workspace_id, owner_id, Some("Mark me".to_string()), None)
    .await
    .expect("create ordinary canonical document")
    .document;
  let mark_params = json!({
    "workspace_id": workspace_id,
    "external_id": plain.external_id,
    "idempotency_key": "template-mark-replay",
  });
  let denied_mark = dispatch_tool(
    "document_template_mark",
    &json!({
      "workspace_id": workspace_id,
      "external_id": plain.external_id,
      "idempotency_key": "template-mark-reader-denied",
    }),
    &auth(reader_id, &["write:docs"]),
    &state,
  )
  .await
  .expect_err("write scope must not replace document PropertiesUpdate");
  assert_eq!(denied_mark.0, -32003);
  let marked_once = payload(
    dispatch_tool("document_template_mark", &mark_params, &owner_write, &state)
      .await
      .expect("mark document template"),
  );
  let marked_replay = payload(
    dispatch_tool("document_template_mark", &mark_params, &owner_write, &state)
      .await
      .expect("replay mark document template"),
  );
  assert_eq!(marked_once, marked_replay);
  assert_eq!(
    marked_once,
    json!({ "externalId": plain.external_id, "isTemplate": true })
  );

  let unmark_params = json!({
    "workspace_id": workspace_id,
    "external_id": plain.external_id,
    "idempotency_key": "template-unmark-replay",
  });
  let unmarked_once = payload(
    dispatch_tool("document_template_unmark", &unmark_params, &owner_write, &state)
      .await
      .expect("unmark document template"),
  );
  let unmarked_replay = payload(
    dispatch_tool("document_template_unmark", &unmark_params, &owner_write, &state)
      .await
      .expect("replay unmark document template"),
  );
  assert_eq!(unmarked_once, unmarked_replay);
  assert_eq!(unmarked_once["isTemplate"], false);
  let plain_template_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_template_state WHERE doc_id = $1")
    .bind(plain.id)
    .fetch_one(&pool)
    .await
    .expect("count unmarked template state");
  assert_eq!(plain_template_rows, 0);

  let permission = state.permission_service.clone();
  let metadata_repo = Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  state.document_template_service = Some(Arc::new(
    DocumentTemplateService::new(metadata_repo, Arc::new(docs.clone()), permission.clone()).with_mutation_ports(
      Arc::new(RejectTemplateMetadata),
      Arc::new(OrganizerDocumentTemplatePlacement::new(
        docs.clone(),
        permission.clone(),
      )),
    ),
  ));
  let metadata_failure = dispatch_tool(
    "document_template_create",
    &json!({
      "workspace_id": workspace_id,
      "title": "Metadata failure template",
      "content_markdown": "Compensate me",
      "folder_id": folder.id,
      "idempotency_key": "template-create-metadata-failure",
    }),
    &owner_write,
    &state,
  )
  .await
  .expect_err("metadata failure must not return partial success");
  assert_eq!(metadata_failure.1, "MIX_MCP_DOCUMENT_TEMPLATE_COMPENSATED");
  let metadata_failure_row: (Uuid, Option<chrono::DateTime<chrono::Utc>>) =
    sqlx::query_as("SELECT id, deleted_at FROM docs WHERE workspace_id = $1 AND title = $2")
      .bind(workspace_id)
      .bind("Metadata failure template")
      .fetch_one(&pool)
      .await
      .expect("load compensated metadata-failure page");
  assert!(metadata_failure_row.1.is_some());
  let metadata_failure_state: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM document_template_state WHERE doc_id = $1")
      .bind(metadata_failure_row.0)
      .fetch_one(&pool)
      .await
      .expect("count metadata-failure state");
  assert_eq!(metadata_failure_state, 0);

  let metadata_repo = Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  state.document_template_service = Some(Arc::new(
    DocumentTemplateService::new(metadata_repo.clone(), Arc::new(docs.clone()), permission.clone())
      .with_mutation_ports(
        Arc::new(DocumentMetadataService::new(metadata_repo)),
        Arc::new(RejectPlacement {
          reject_cleanup: false,
          delegate: OrganizerDocumentTemplatePlacement::new(docs.clone(), permission),
        }),
      ),
  ));
  let placement_failure = dispatch_tool(
    "document_template_create",
    &json!({
      "workspace_id": workspace_id,
      "title": "Placement failure template",
      "content_markdown": "Compensate every owner",
      "folder_id": folder.id,
      "idempotency_key": "template-create-placement-failure",
    }),
    &owner_write,
    &state,
  )
  .await
  .expect_err("placement failure must not return partial success");
  assert_eq!(placement_failure.1, "MIX_MCP_DOCUMENT_TEMPLATE_COMPENSATED");
  let placement_failure_row: (Uuid, String, Option<chrono::DateTime<chrono::Utc>>) =
    sqlx::query_as("SELECT id, external_id, deleted_at FROM docs WHERE workspace_id = $1 AND title = $2")
      .bind(workspace_id)
      .bind("Placement failure template")
      .fetch_one(&pool)
      .await
      .expect("load compensated placement-failure page");
  assert!(placement_failure_row.2.is_some());
  let placement_failure_state: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM document_template_state WHERE doc_id = $1")
      .bind(placement_failure_row.0)
      .fetch_one(&pool)
      .await
      .expect("count placement-failure state");
  assert_eq!(placement_failure_state, 0);
  let snapshot = OrganizerService::new(docs)
    .snapshot(workspace_id)
    .await
    .expect("load organizer after compensation");
  assert!(!snapshot_contains_target(&snapshot.roots, &placement_failure_row.1));

  helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
}

#[tokio::test]
async fn inv_mcp_document_template_instantiate_preserves_native_content_and_compensates() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-template-instantiate-owner").await;
  auth_store
    .patch_user_preferences(
      owner_id,
      myoxus_application::auth::UserPreferencesPatch {
        locale: Some(Some("en".into())),
        timezone: Some(Some("Pacific/Kiritimati".into())),
        date_format: Some(Some("year-month-day".into())),
        time_format: Some(Some("24-hour".into())),
        ..Default::default()
      },
    )
    .await
    .expect("explicit calendar presentation preferences");
  let (reader_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-template-instantiate-reader").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let (mut state, docs) = build_tool_state(&pool);
  state
    .workspace_service
    .seed_root_doc(
      workspace_id,
      owner_id,
      yjs::create_initial_workspace_doc("Document template instantiation workspace"),
    )
    .await
    .expect("seed workspace root");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'Reader', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(reader_id)
  .execute(&pool)
  .await
  .expect("add read-only workspace member");

  let folder = OrganizerService::new(docs.clone())
    .create_folder(
      workspace_id,
      CreateOrganizerFolder {
        id: Uuid::new_v4().to_string(),
        parent_id: None,
        name: "Instantiated documents".to_string(),
        index: None,
      },
    )
    .await
    .expect("create instantiation destination");
  let target = docs
    .create_page_lifecycle(workspace_id, owner_id, Some("Native target".to_string()), None)
    .await
    .expect("create linked target")
    .document;
  let asset_key = format!("assets/{}", "a".repeat(64));
  let (blob_service, storage, _storage_dir) = blob_test_services(&pool);
  seed_blob(&blob_service, &storage, workspace_id, &asset_key).await;
  let template = create_template(
    &pool,
    &docs,
    workspace_id,
    owner_id,
    "Brief {{ project }}",
    &format!("Owner {{{{ owner }}}} / {{{{ input.reference }}}} / {{{{ input.reference }}}}\n\nCalendar {{{{input.date.day}}}} / {{{{input.datetime.meeting}}}}\n\n- {{{{ steps }}}}\n\n![Native asset]({asset_key})"),
    "managed",
    "document",
  )
  .await;
  docs
    .mutate_content(
      workspace_id,
      template.id,
      Some(owner_id),
      DocumentMutation::InsertLinkedPageReference {
        target_external_id: target.external_id.clone(),
        label: "Native target".to_string(),
        after_block_id: None,
      },
      false,
      None,
    )
    .await
    .expect("insert native document reference into template");

  let permission = state.permission_service.clone();
  let metadata_repo = Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  state.document_template_service = Some(Arc::new(
    DocumentTemplateService::new(metadata_repo.clone(), Arc::new(docs.clone()), permission.clone())
      .with_mutations(
        DocumentMetadataService::new(metadata_repo),
        Arc::new(OrganizerDocumentTemplatePlacement::new(
          docs.clone(),
          permission.clone(),
        )),
      )
      .with_instantiation_assets(blob_service.clone())
      .with_account(Arc::new(TemplateAccountPreferences(auth_store.clone())))
      .with_organization_context(Some(Arc::new(
        myoxus_application::organization::OrganizationTemplateContextService::new(
          Arc::new(SqlxWorkspaceStore::new(
            pool.clone(),
            crate::helpers::database_starter_catalog(),
          )),
          Arc::new(myoxus_infrastructure::organization::PgOrganizationRepository::new(
            pool.clone(),
          )),
          Arc::new(myoxus_infrastructure::organization::PgOrganizationUnitWorkspaceRepository::new(pool.clone())),
          Arc::new(myoxus_infrastructure::organization::PgOrganizationUnitRepository::new(
            pool.clone(),
          )),
        ),
      ))),
  ));
  state.blob_service = Some(blob_service.clone());
  let owner_write = auth(owner_id, &["write:docs"]);
  let params = json!({
    "workspace_id": workspace_id,
    "template_external_id": template.external_id.clone(),
    "title": "Atlas brief",
    "variables": {
      "project": "Atlas",
      "input.reference": "  R-1 {{project}}  ",
      "input.date.day": "2026-11-12",
      "input.datetime.meeting": "2026-11-13 09:30:00",
      "owner": "Ada",
      "steps": ["Discover", "Deliver"]
    },
    "folder_id": folder.id,
    "idempotency_key": "template-instantiate-replay"
  });

  let before_inputs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  for (name, value) in [
    ("input.reference", serde_json::Value::Null),
    ("input.reference", json!("   ")),
    ("input.reference", json!(["R-1"])),
    ("input.date.day", json!("2026-02-30")),
    ("input.datetime.meeting", json!("2026-11-13T09:30:00Z")),
  ] {
    let mut invalid = params.clone();
    invalid["idempotency_key"] = json!(format!("invalid-manual-{}", Uuid::new_v4()));
    if value.is_null() {
      invalid["variables"].as_object_mut().unwrap().remove(name);
    } else {
      invalid["variables"][name] = value;
    }
    assert!(
      dispatch_tool("document_template_instantiate", &invalid, &owner_write, &state)
        .await
        .is_err()
    );
  }
  let after_inputs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    after_inputs, before_inputs,
    "invalid manual input publishes no document"
  );

  let unresolved = dispatch_tool(
    "document_template_instantiate",
    &json!({
      "workspace_id": workspace_id,
      "template_external_id": template.external_id.clone(),
      "variables": { "project": "Atlas" },
      "folder_id": folder.id,
      "idempotency_key": "template-instantiate-unresolved"
    }),
    &owner_write,
    &state,
  )
  .await
  .expect_err("unresolved variables fail before publication");
  assert_eq!(unresolved.1, "MIX_MCP_DOCUMENT_TEMPLATE_VARIABLES_UNRESOLVED");
  let unresolved_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1 AND title = $2")
    .bind(workspace_id)
    .bind("Brief Atlas")
    .fetch_one(&pool)
    .await
    .expect("count unresolved zero-write result");
  assert_eq!(unresolved_count, 0);

  let denied = dispatch_tool(
    "document_template_instantiate",
    &params,
    &auth(reader_id, &["write:docs"]),
    &state,
  )
  .await
  .expect_err("write scope does not replace destination CreateDoc");
  assert_eq!(denied.0, -32003);

  let created_once = payload(
    dispatch_tool("document_template_instantiate", &params, &owner_write, &state)
      .await
      .expect("instantiate native template"),
  );
  let created_replay = payload(
    dispatch_tool("document_template_instantiate", &params, &owner_write, &state)
      .await
      .expect("replay native template instantiation"),
  );
  assert_eq!(created_once, created_replay);
  assert_eq!(created_once["folderId"], folder.id);
  assert_eq!(
    created_once
      .as_object()
      .expect("bounded instantiation response")
      .keys()
      .map(String::as_str)
      .collect::<BTreeSet<_>>(),
    BTreeSet::from([
      "documentRevision",
      "entryId",
      "externalId",
      "folderId",
      "folderPath",
      "rootRevision"
    ])
  );
  let created_doc_id: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id = $1 AND external_id = $2")
    .bind(workspace_id)
    .bind(created_once["externalId"].as_str().expect("created external id"))
    .fetch_one(&pool)
    .await
    .expect("resolve instantiated document");
  let snapshot = docs
    .load_full_doc(workspace_id, created_doc_id)
    .await
    .expect("load instantiated native snapshot");
  let extracted = yjs::extract_text_from_yjs(&snapshot).expect("extract instantiated text");
  assert_eq!(extracted.title.as_deref(), Some("Atlas brief"));
  assert!(
    extracted
      .markdown
      .contains("Owner Ada / R-1 {{project}} / R-1 {{project}}")
  );
  assert!(extracted.markdown.contains("Discover"));
  assert!(extracted.markdown.contains("Calendar 2026-11-12 / 2026-11-13, 09:30"));
  assert!(extracted.markdown.contains("Deliver"));
  assert_eq!(
    yjs::extract_portable_asset_references(&snapshot)
      .expect("extract cloned asset")
      .first()
      .map(|reference| reference.source_key.as_str()),
    Some(asset_key.as_str())
  );
  assert_eq!(
    yjs::extract_document_references_from_yjs(&snapshot)
      .expect("extract cloned document reference")
      .occurrences
      .first()
      .map(|reference| reference.raw_target_doc_id.as_str()),
    Some(target.external_id.as_str())
  );
  let template_state_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_template_state WHERE doc_id = $1")
    .bind(created_doc_id)
    .fetch_one(&pool)
    .await
    .expect("count clone template state");
  assert_eq!(template_state_rows, 0);

  let organization_template = create_template(
    &pool, &docs, workspace_id, owner_id, "{{organization_name}} meeting",
    "Organization: {{organization_name}}\n\n| Context | Value |\n| --- | --- |\n| Organization | {{organization_name}} |",
    "managed", "document",
  ).await;
  let source_before = docs
    .load_full_doc(workspace_id, organization_template.id)
    .await
    .expect("source before");
  let base = json!({
    "workspace_id": workspace_id, "template_external_id": organization_template.external_id,
    "folder_id": folder.id, "title": "Meeting {{organization_name}}",
    "idempotency_key": "organization-personal-success"
  });
  let organization_result = payload(
    dispatch_tool("document_template_instantiate", &base, &owner_write, &state)
      .await
      .expect("personal organization-only application"),
  );
  let organization_doc: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id = $1 AND external_id = $2")
    .bind(workspace_id)
    .bind(organization_result["externalId"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .expect("organization target");
  let organization_snapshot = docs
    .load_full_doc(workspace_id, organization_doc)
    .await
    .expect("organization snapshot");
  let organization_content = yjs::extract_text_from_yjs(&organization_snapshot).expect("native organization text");
  let organization_name: String = sqlx::query_scalar("SELECT name FROM organization WHERE key = 'myoxus'")
    .fetch_one(&pool)
    .await
    .expect("authoritative organization");
  assert_eq!(
    organization_content.title,
    Some(format!("Meeting {}", organization_name.trim()))
  );
  assert!(
    organization_content
      .markdown
      .contains(&format!("Organization: {}", organization_name.trim()))
  );
  assert!(
    organization_content
      .markdown
      .contains(&format!("| Organization | {} |", organization_name.trim()))
  );
  assert!(!organization_content.markdown.contains("{{organization_name}}"));
  let before_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("before preflight count");
  for (key, value, code) in [
    (
      "title",
      json!("{{organization_unit_name}}"),
      "MIX_MCP_DOCUMENT_TEMPLATE_OWNER_UNIT_UNAVAILABLE",
    ),
    (
      "variables",
      json!({"organization_name": "forged"}),
      "MIX_MCP_DOCUMENT_TEMPLATE_VARIABLES_INVALID",
    ),
    (
      "variables",
      json!({"organization_unit_name": "forged"}),
      "MIX_MCP_DOCUMENT_TEMPLATE_VARIABLES_INVALID",
    ),
  ] {
    let mut rejected = base.clone();
    rejected[key] = value;
    rejected["idempotency_key"] = json!(Uuid::new_v4().to_string());
    let error = dispatch_tool("document_template_instantiate", &rejected, &owner_write, &state)
      .await
      .expect_err("atomic organization preflight");
    assert_eq!(error.1, code);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("after preflight count");
    assert_eq!(
      count, before_count,
      "failed preflight must not even create a trashed target"
    );
  }
  assert_eq!(
    docs
      .load_full_doc(workspace_id, organization_template.id)
      .await
      .expect("source after"),
    source_before
  );

  // Context names are point-in-time content, while canonical identities own
  // retries. Exercise the real adapter/preflight/Yjs path, not a hash-only test.
  let context_template = create_template(
    &pool, &docs, workspace_id, owner_id,
    "{{parent_page_title}} · {{folder_name}}",
    "Parent: {{parent_page_title}}\n\nFolder: {{folder_name}}\n\n| Context | Value |\n| --- | --- |\n| Parent | {{parent_page_title}} |\n| Folder | {{folder_name}} |",
    "managed", "document",
  ).await;
  let context_source_before = docs
    .load_full_doc(workspace_id, context_template.id)
    .await
    .expect("context source");
  let context_params = json!({
    "workspace_id": workspace_id, "template_external_id": context_template.external_id,
    "folder_id": folder.id, "context_parent_external_id": target.external_id,
    "idempotency_key": "creation-context-replay"
  });
  let context_result = payload(
    dispatch_tool("document_template_instantiate", &context_params, &owner_write, &state)
      .await
      .expect("context application"),
  );
  let context_id: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id = $1 AND external_id = $2")
    .bind(workspace_id)
    .bind(context_result["externalId"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .expect("context target identity");
  let context_snapshot = docs
    .load_full_doc(workspace_id, context_id)
    .await
    .expect("context target");
  let content = yjs::extract_text_from_yjs(&context_snapshot).expect("native context text");
  assert_eq!(content.title.as_deref(), Some("Native target · Instantiated documents"));
  for text in [
    "Parent: Native target",
    "Folder: Instantiated documents",
    "| Parent | Native target |",
    "| Folder | Instantiated documents |",
  ] {
    assert!(content.markdown.contains(text), "missing native context {text}");
  }
  dispatch_tool(
    "doc_patch",
    &json!({
      "workspace_id": workspace_id, "external_id": target.external_id,
      "operation": "update_title", "title": "Renamed parent", "idempotency_key": "context-parent-rename"
    }),
    &owner_write,
    &state,
  )
  .await
  .expect("rename parent through existing operation");
  OrganizerService::new(docs.clone())
    .update_folder(
      workspace_id,
      &folder.id,
      myoxus_application::organizer::UpdateOrganizerFolder {
        name: Some("Renamed folder".into()),
        ..Default::default()
      },
    )
    .await
    .expect("rename destination");
  assert_eq!(
    payload(
      dispatch_tool("document_template_instantiate", &context_params, &owner_write, &state)
        .await
        .expect("context replay after rename")
    ),
    context_result
  );
  assert_eq!(
    docs
      .load_full_doc(workspace_id, context_id)
      .await
      .expect("unchanged replay snapshot"),
    context_snapshot
  );

  let foreign_workspace = helpers::create_workspace(&pool, owner_id).await;
  state
    .workspace_service
    .seed_root_doc(
      foreign_workspace,
      owner_id,
      yjs::create_initial_workspace_doc("Foreign context fixture"),
    )
    .await
    .expect("foreign workspace root");
  let foreign_parent = docs
    .create_page_lifecycle(foreign_workspace, owner_id, Some("Foreign".into()), None)
    .await
    .expect("foreign parent")
    .document;
  let trash_parent = docs
    .create_page_lifecycle(workspace_id, owner_id, Some("Trash".into()), None)
    .await
    .expect("trash parent")
    .document;
  sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
    .bind(trash_parent.id)
    .execute(&pool)
    .await
    .expect("isolated trash fixture");
  let blocked_parent = docs
    .create_page_lifecycle(workspace_id, owner_id, Some("Blocked".into()), None)
    .await
    .expect("blocked parent")
    .document;
  sqlx::query("UPDATE docs SET blocked = true WHERE id = $1")
    .bind(blocked_parent.id)
    .execute(&pool)
    .await
    .expect("isolated blocked fixture");
  let count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("before invalid contexts");
  for parent in [
    Value::Null,
    json!(context_template.external_id),
    json!(foreign_parent.external_id),
    json!(trash_parent.external_id),
    json!(blocked_parent.external_id),
  ] {
    let mut rejected = context_params.clone();
    rejected["context_parent_external_id"] = parent;
    rejected["idempotency_key"] = json!(Uuid::new_v4().to_string());
    let error = dispatch_tool("document_template_instantiate", &rejected, &owner_write, &state)
      .await
      .expect_err("invalid parent is atomic");
    assert_eq!(error.1, "MIX_MCP_DOCUMENT_TEMPLATE_PARENT_UNAVAILABLE");
  }
  for token in ["parent_page_title", "folder_name"] {
    let mut rejected = context_params.clone();
    rejected["variables"] = json!({ token: "forged" });
    rejected["idempotency_key"] = json!(Uuid::new_v4().to_string());
    assert_eq!(
      dispatch_tool("document_template_instantiate", &rejected, &owner_write, &state)
        .await
        .expect_err("reserved context")
        .1,
      "MIX_MCP_DOCUMENT_TEMPLATE_VARIABLES_INVALID"
    );
  }
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM docs WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("after invalid contexts"),
    count_before
  );
  assert_eq!(
    docs
      .load_full_doc(workspace_id, context_template.id)
      .await
      .expect("unchanged context source"),
    context_source_before
  );

  // The same native registry ingress must preserve bindings for MCP, not a
  // Markdown approximation that loses row metadata before preflight.
  let repeat_blocks = serde_json::from_value::<Vec<yjs::PortableSnapshotBlock>>(json!([
    {"id":"page", "flavour":"myoxus:page", "children":["note"], "props":{"title":"Members"}},
    {"id":"note", "flavour":"myoxus:note", "children":["todo"]},
    {"id":"todo", "flavour":"myoxus:list", "props":{
      "type":"todo", "checked":false, "text":"{{member.name}} · {{member.email}}",
      "repeat":{"source":"workspace.members","alias":"member"}
    }}
  ]))
  .expect("native repeat source");
  let (repeat_template, _) = docs
    .create_page_from_snapshot_with_sync_updates(
      workspace_id,
      owner_id,
      Some("Members".into()),
      yjs::snapshot_blocks_to_yjs(&repeat_blocks).expect("native repeat import"),
    )
    .await
    .expect("create isolated repeat template");
  sqlx::query("INSERT INTO document_template_state (doc_id, state, source, materialized_at, updated_by) VALUES ($1, 'managed', 'document', now(), $2)")
    .bind(repeat_template.id).bind(owner_id).execute(&pool).await.expect("isolated template state");
  let repeat_before = docs
    .load_full_doc(workspace_id, repeat_template.id)
    .await
    .expect("repeat source before");
  let requirements = payload(
    dispatch_tool(
      "document_template_get",
      &json!({"workspace_id":workspace_id,"external_id":repeat_template.external_id}),
      &auth(owner_id, &["read:docs"]),
      &state,
    )
    .await
    .expect("repeat introspection"),
  );
  assert_eq!(requirements["requiredVariables"], json!(["workspace.members"]));
  let repeat_variables = json!({"workspace.members":[
    {"name":"Caller Alpha","email":"alpha@example.test"},
    {"name":"Caller Beta","email":"beta@example.test"}
  ]});
  let repeat_params = json!({"workspace_id":workspace_id,"template_external_id":repeat_template.external_id,
    "variables":repeat_variables,"folder_id":folder.id,"idempotency_key":"repeat-native-success"});
  let repeat_created = payload(
    dispatch_tool("document_template_instantiate", &repeat_params, &owner_write, &state)
      .await
      .expect("explicit repeat records"),
  );
  let repeat_id: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2")
    .bind(workspace_id)
    .bind(repeat_created["externalId"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .expect("repeat target identity");
  let repeat_snapshot = docs
    .load_full_doc(workspace_id, repeat_id)
    .await
    .expect("repeat target snapshot");
  let repeat_text = yjs::extract_text_from_yjs(&repeat_snapshot)
    .expect("repeat consumer content")
    .markdown;
  assert!(repeat_text.contains("- [ ] Caller Alpha · alpha@example.test"));
  assert!(repeat_text.contains("- [ ] Caller Beta · beta@example.test"));
  assert!(repeat_text.find("Caller Alpha") < repeat_text.find("Caller Beta"));
  assert!(!repeat_text.contains("{{member."));
  let before_invalid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id=$1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("repeat preflight count");
  for variables in [
    json!({}),
    json!({"workspace.members":[]}),
    json!({"workspace.members":[{"name":"Missing email"}]}),
  ] {
    let mut invalid = repeat_params.clone();
    invalid["variables"] = variables;
    invalid["idempotency_key"] = json!(Uuid::new_v4().to_string());
    dispatch_tool("document_template_instantiate", &invalid, &owner_write, &state)
      .await
      .expect_err("no automatic lookup or partial publication");
  }
  dispatch_tool(
    "document_template_instantiate",
    &repeat_params,
    &auth(reader_id, &["write:docs"]),
    &state,
  )
  .await
  .expect_err("repeat requires destination permission");
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM docs WHERE workspace_id=$1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("repeat count after rejection"),
    before_invalid
  );

  let metadata_repo = Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  state.document_template_service = Some(Arc::new(
    DocumentTemplateService::new(metadata_repo, Arc::new(docs.clone()), permission.clone())
      .with_mutation_ports(
        Arc::new(RejectFirstNonTemplateMetadata(AtomicBool::new(false))),
        Arc::new(OrganizerDocumentTemplatePlacement::new(
          docs.clone(),
          permission.clone(),
        )),
      )
      .with_instantiation_assets(blob_service.clone()),
  ));
  let metadata_failure = dispatch_tool(
    "document_template_instantiate",
    &json!({
      "workspace_id": workspace_id,
      "template_external_id": repeat_template.external_id.clone(),
      "title": "Instantiation metadata failure",
      "variables": repeat_variables,
      "folder_id": folder.id,
      "idempotency_key": "template-instantiate-metadata-failure"
    }),
    &owner_write,
    &state,
  )
  .await
  .expect_err("metadata failure is compensated");
  assert_eq!(metadata_failure.1, "MIX_MCP_DOCUMENT_TEMPLATE_COMPENSATED");

  let metadata_repo = Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  state.document_template_service = Some(Arc::new(
    DocumentTemplateService::new(metadata_repo.clone(), Arc::new(docs.clone()), permission.clone())
      .with_mutation_ports(
        Arc::new(DocumentMetadataService::new(metadata_repo)),
        Arc::new(RejectPlacement {
          reject_cleanup: false,
          delegate: OrganizerDocumentTemplatePlacement::new(docs.clone(), permission),
        }),
      )
      .with_instantiation_assets(blob_service),
  ));
  let placement_failure = dispatch_tool(
    "document_template_instantiate",
    &json!({
      "workspace_id": workspace_id,
      "template_external_id": repeat_template.external_id.clone(),
      "title": "Instantiation placement failure",
      "variables": repeat_variables,
      "folder_id": folder.id,
      "idempotency_key": "template-instantiate-placement-failure"
    }),
    &owner_write,
    &state,
  )
  .await
  .expect_err("placement failure is compensated");
  assert_eq!(placement_failure.1, "MIX_MCP_DOCUMENT_TEMPLATE_COMPENSATED");
  for title in ["Instantiation metadata failure", "Instantiation placement failure"] {
    let deleted_at: Option<chrono::DateTime<chrono::Utc>> =
      sqlx::query_scalar("SELECT deleted_at FROM docs WHERE workspace_id = $1 AND title = $2")
        .bind(workspace_id)
        .bind(title)
        .fetch_one(&pool)
        .await
        .expect("load compensated instantiation page");
    assert!(deleted_at.is_some());
  }

  assert_eq!(
    docs
      .load_full_doc(workspace_id, repeat_template.id)
      .await
      .expect("repeat source after success and failures"),
    repeat_before
  );

  helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
}
