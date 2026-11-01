// SPDX-License-Identifier: AGPL-3.0-or-later

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::{
  Arc, Mutex,
  atomic::{AtomicBool, Ordering},
};

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::FutureExt;
use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::database::{DatabaseLimits, DatabaseServices};
use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_application::organizer::{OrganizerService, OrganizerSnapshotNode};
use myoxus_application::permission::PermissionService;
use myoxus_application::ports::BlobStoragePort;
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::worker::WorkQueuePort;
use myoxus_application::workspace::tasks::WorkspaceTasksInitializer;
use myoxus_application::workspace::{WorkspaceName, WorkspaceStore};
use myoxus_application::workspace_export::WorkspaceExportProvenancePort;
use myoxus_application::workspace_import::{
  WorkspaceImportPolicy, WorkspaceImportPolicyProvider, WorkspaceImportRepository, WorkspaceImportService,
  WorkspaceImportWorkerEnvelope,
};
use myoxus_domain::database::{DatabaseEditPrecondition, DatabaseEditingRepository, DatabaseRowKind};
use myoxus_domain::ids::{UserId, WorkspaceImportId};
use myoxus_domain::workspace_import::{
  WorkspaceImportCompensationKind, WorkspaceImportOperation, WorkspaceImportProgressStage, WorkspaceImportStatus,
};
use myoxus_domain::workspace_tags::WorkspaceTagRepository;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::blob::SqlxBlobStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_infrastructure::workspace_database::PgDatabaseRepository;
use myoxus_infrastructure::workspace_import::PgWorkspaceImportRepository;
use myoxus_infrastructure::workspace_tags::PgWorkspaceTagRepository;
use myoxus_workspace_import::WorkspaceImportLimits;
use myoxus_workspace_import::{DecodedDocumentContent, WorkspaceDecoder};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Array, Doc, Map, Text, Transact, Update};
use zip::write::SimpleFileOptions;

#[derive(Default)]
struct ImportedEditorProjection {
  pages: usize,
  surfaces: usize,
  paragraphs: usize,
  linked_documents: usize,
  database_references: usize,
  images: usize,
  image_sources: Vec<String>,
  attachments: usize,
  mermaid: usize,
  annotations: Vec<String>,
  callouts: Vec<(String, String, String, bool, bool)>,
  footnotes: Vec<(String, String, Vec<String>)>,
  local_markers: Vec<(String, String)>,
}

fn inspect_imported_editor_projection(update: &[u8]) -> ImportedEditorProjection {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(update).expect("decode imported Yjs state"))
      .expect("apply imported Yjs state");
  }
  let txn = doc.transact();
  let mut projection = ImportedEditorProjection::default();
  for (block_id, value) in blocks.iter(&txn) {
    let yrs::Out::YMap(block) = value else {
      panic!("imported block {block_id:?} must be a Y.Map");
    };
    assert_eq!(
      block.get(&txn, "sys:id").map(|value| value.to_string(&txn)).as_deref(),
      Some(block_id),
      "imported block {block_id:?} must retain its canonical editor id"
    );
    assert!(
      matches!(block.get(&txn, "sys:children"), Some(yrs::Out::YArray(_))),
      "imported block {block_id:?} must expose collaborative children"
    );
    let raw_flavour = match block.get(&txn, "sys:flavour") {
      Some(yrs::Out::Any(yrs::Any::String(flavour))) => flavour.to_string(),
      other => panic!("imported block {block_id:?} has no string flavour: {other:?}"),
    };
    match yjs::resolve_flavour(&raw_flavour) {
      "myoxus:footnote-definition" => {
        let Some(yrs::Out::Any(yrs::Any::String(label))) = block.get(&txn, "prop:label") else {
          panic!("native definition label");
        };
        let Some(yrs::Out::YArray(children)) = block.get(&txn, "sys:children") else {
          panic!("normal definition children");
        };
        let flavours = children
          .iter(&txn)
          .map(|child| {
            let Some(yrs::Out::YMap(child)) = blocks.get(&txn, child.to_string(&txn).as_str()) else {
              panic!("complete definition child");
            };
            child.get(&txn, "sys:flavour").expect("child flavour").to_string(&txn)
          })
          .collect();
        projection
          .footnotes
          .push((block_id.to_string(), label.to_string(), flavours));
      }
      "myoxus:callout" => {
        let Some(yrs::Out::Any(yrs::Any::String(kind))) = block.get(&txn, "prop:type") else {
          panic!("callout kind must be an authored semantic string");
        };
        let Some(yrs::Out::Any(yrs::Any::Bool(foldable))) = block.get(&txn, "prop:foldable") else {
          panic!("callout foldability must be persisted");
        };
        let Some(yrs::Out::Any(yrs::Any::Bool(default_open))) = block.get(&txn, "prop:defaultOpen") else {
          panic!("callout default-open state must be persisted");
        };
        let Some(yrs::Out::YText(title)) = block.get(&txn, "prop:title") else {
          panic!("callout title must be canonical Y.Text");
        };
        let Some(yrs::Out::YText(body)) = block.get(&txn, "prop:text") else {
          panic!("callout body must be canonical Y.Text");
        };
        projection.callouts.push((
          kind.to_string(),
          yrs::GetString::get_string(&title, &txn),
          yrs::GetString::get_string(&body, &txn),
          foldable,
          default_open,
        ));
      }
      "myoxus:annotation" => {
        let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
          panic!("annotation body must be collaborative Y.Text");
        };
        projection.annotations.push(yrs::GetString::get_string(&text, &txn));
      }
      "myoxus:page" => {
        projection.pages += 1;
        assert!(
          matches!(block.get(&txn, "prop:title"), Some(yrs::Out::YText(_))),
          "imported page {block_id:?} title must be a collaborative Y.Text"
        );
      }
      "myoxus:surface" => {
        projection.surfaces += 1;
      }
      "myoxus:paragraph" => {
        projection.paragraphs += 1;
        assert!(
          matches!(block.get(&txn, "prop:text"), Some(yrs::Out::YText(_))),
          "imported paragraph {block_id:?} text must be a collaborative Y.Text"
        );
      }
      "myoxus:embed-linked-doc" => {
        projection.linked_documents += 1;
        assert!(
          matches!(block.get(&txn, "prop:pageId"), Some(yrs::Out::Any(yrs::Any::String(_)))),
          "imported linked document {block_id:?} must retain a rewritten target"
        );
      }
      "myoxus:database" => {
        projection.database_references += 1;
        assert!(
          matches!(
            block.get(&txn, "prop:serverDatabaseId"),
            Some(yrs::Out::Any(yrs::Any::String(_)))
          ),
          "imported Database block {block_id:?} must be reference-only"
        );
        for removed in [
          "prop:databaseId",
          "prop:title",
          "prop:columns",
          "prop:views",
          "prop:cells",
        ] {
          assert!(
            block.get(&txn, removed).is_none(),
            "imported Database block {block_id:?} retained {removed}"
          );
        }
      }
      "myoxus:image" => {
        projection.images += 1;
        let source = match block.get(&txn, "prop:sourceId") {
          Some(yrs::Out::Any(yrs::Any::String(source))) => source.to_string(),
          other => panic!("imported image {block_id:?} has no string sourceId: {other:?}"),
        };
        projection.image_sources.push(source);
      }
      "myoxus:attachment" => projection.attachments += 1,
      "myoxus:mermaid" => projection.mermaid += 1,
      _ => {}
    }
    for (_, value) in block.iter(&txn) {
      if let yrs::Out::YText(text) = value {
        for part in text.diff(&txn, yrs::types::text::YChange::identity) {
          if let Some(yrs::Any::Map(footnote)) = part.attributes.as_deref().and_then(|attrs| attrs.get("footnote"))
            && let (Some(yrs::Any::String(label)), Some(yrs::Any::String(id))) =
              (footnote.get("label"), footnote.get("definitionId"))
          {
            projection.local_markers.push((label.to_string(), id.to_string()));
          }
        }
      }
    }
  }
  projection
}

fn organizer_nodes<'a>(nodes: &'a [OrganizerSnapshotNode], flattened: &mut Vec<&'a OrganizerSnapshotNode>) {
  for node in nodes {
    flattened.push(node);
    organizer_nodes(&node.children, flattened);
  }
}

#[derive(Default)]
struct RecordingQueue {
  jobs: Mutex<Vec<serde_json::Value>>,
  fail_next: AtomicBool,
}

#[async_trait]
impl WorkQueuePort for RecordingQueue {
  async fn add_job(
    &self,
    _queue: &str,
    _job_name: &str,
    data: serde_json::Value,
    _max_attempts: Option<u32>,
    _delay_ms: Option<i64>,
  ) -> AuthResult<String> {
    if self.fail_next.swap(false, Ordering::SeqCst) {
      return Err(AuthError::Storage("intentional queue failure".to_string()));
    }
    self.jobs.lock().expect("queue lock").push(data);
    Ok(Uuid::new_v4().to_string())
  }
}

struct StaticPolicy(WorkspaceImportPolicy);

#[async_trait]
impl WorkspaceImportPolicyProvider for StaticPolicy {
  async fn current_policy(&self) -> WorkspaceImportPolicy {
    self.0
  }
}

struct TestImportService {
  service: Arc<WorkspaceImportService>,
  queue: Arc<RecordingQueue>,
  _storage_root: tempfile::TempDir,
}

fn fixture(name: &str) -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("../workspace_import/tests/fixtures")
    .join(name)
}

async fn setup_pool() -> PgPool {
  let database_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .expect("TEST_DATABASE_URL must target the isolated test database");
  let pool = PgPoolOptions::new()
    .max_connections(5)
    .connect(&database_url)
    .await
    .expect("connect isolated workspace import database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("workspace import migrations");
  pool
}

async fn create_user(pool: &PgPool, suffix: &str) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, is_admin, email_verified_at) VALUES ($1, $2, $3, false, now())")
    .bind(id)
    .bind(format!("{suffix}_{id}@example.test"))
    .bind(suffix)
    .execute(pool)
    .await
    .expect("insert workspace import actor");
  id
}

async fn create_workspace(pool: &PgPool, owner_id: Uuid) -> Uuid {
  let workspace_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'Workspace import test')")
    .bind(workspace_id)
    .bind(owner_id)
    .execute(pool)
    .await
    .expect("insert workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'Owner', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(owner_id)
  .execute(pool)
  .await
  .expect("insert workspace owner");
  workspace_id
}

#[test]
fn workspace_import_cannot_bypass_the_normal_document_update_service() {
  let workspace_apply = include_str!("../../application/src/workspace_import/mod.rs");
  let persisted_migration = include_str!("../../application/src/database/import_export/legacy_migration.rs");

  for source in [workspace_apply, persisted_migration] {
    assert!(
      source.contains(".push_update_raw("),
      "Database migration must append through DocService"
    );
    assert!(
      !source.contains("doc_snapshots"),
      "Database migration must not write the snapshot table directly"
    );
    assert!(
      !source.contains("save_snapshot"),
      "Database migration must not invoke DocSnapshotStore"
    );
  }
}

fn build_service(pool: &PgPool) -> TestImportService {
  let storage_root = tempfile::tempdir().expect("workspace import storage root");
  let storage: Arc<dyn BlobStoragePort> = Arc::new(
    StorageAdapter::new_fs(storage_root.path().to_str().expect("UTF-8 storage path")).expect("storage adapter"),
  );
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let database_repository = Arc::new(PgDatabaseRepository::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  ));
  let databases = Arc::new(DatabaseServices::new(
    database_repository,
    documents.clone(),
    Arc::new(PermissionService::new(auth_store)),
    DatabaseLimits::default(),
    Arc::new(SqlxWorkspaceStore::new(
      pool.clone(),
      std::sync::Arc::new(
        myoxus_infrastructure::database_templates::load_database_template_catalog(
          &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
        )
        .expect("database catalog fixture"),
      ),
    )),
    Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("shipped Database catalog"),
    ),
    myoxus_application::database::DatabaseServiceDependencies::disabled(),
  ));
  let blobs = Arc::new(BlobService::new(
    Arc::new(SqlxBlobStore::new(pool.clone())),
    storage.clone(),
    "http://localhost:3001".to_string(),
  ));
  let queue = Arc::new(RecordingQueue::default());
  let repository: Arc<dyn WorkspaceImportRepository> = Arc::new(PgWorkspaceImportRepository::new(pool.clone()));
  let service = Arc::new(WorkspaceImportService::new(
    repository,
    storage,
    blobs,
    Arc::new(SqlxWorkspaceStore::new(
      pool.clone(),
      std::sync::Arc::new(
        myoxus_infrastructure::database_templates::load_database_template_catalog(
          &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
        )
        .expect("database catalog fixture"),
      ),
    )),
    documents,
    databases.import_export.clone(),
    queue.clone(),
    Arc::new(StaticPolicy(WorkspaceImportPolicy {
      limits: WorkspaceImportLimits::default(),
      staging_retention_hours: 24,
      job_timeout_seconds: 120,
    })),
  ));
  TestImportService {
    service,
    queue,
    _storage_root: storage_root,
  }
}

async fn stage_fixture(service: &WorkspaceImportService, actor: UserId, name: &str) -> WorkspaceImportId {
  let source = std::fs::read(fixture(name)).expect("fixture bytes");
  stage_bytes(service, actor, source, None).await
}

async fn stage_bytes(
  service: &WorkspaceImportService,
  actor: UserId,
  source: Vec<u8>,
  selected_format: Option<myoxus_workspace_import::WorkspaceImportFormat>,
) -> WorkspaceImportId {
  let upload = service
    .create_upload_as(actor, selected_format)
    .await
    .expect("create upload");
  let hash = format!("{:x}", Sha256::digest(&source));
  service
    .upload_part(actor, upload.import_id, 1, &hash, Bytes::from(source.clone()))
    .await
    .expect("stage part");
  service
    .complete_upload(actor, upload.import_id, source.len() as i64, &hash)
    .await
    .expect("complete upload");
  upload.import_id
}

fn obsidian_vault_zip() -> Vec<u8> {
  let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
  let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
  writer.add_directory("Empty folder/", options).expect("empty folder");
  writer.add_directory("People/", options).expect("people folder");
  writer.add_directory("Projects/", options).expect("projects folder");
  writer.add_directory("media/", options).expect("media folder");
  writer.add_directory("copies/", options).expect("copies folder");
  writer
    .start_file("People/Shared.md", options)
    .expect("first vault note");
  writer
    .write_all(b"# Person\n\nTarget note.\n")
    .expect("first note bytes");
  writer
    .start_file("Projects/Shared.md", options)
    .expect("second vault note");
  writer
    .write_all(
      br#"---
title: Project overview
aliases: [Overview]
tags: [project, active]
custom:
  nested: true
---
# Project

[[/People/Shared|Person]]

![[/People/Shared|Live person]]

==highlight==

```mermaid
flowchart LR
  A --> B
```

![[../media/pixel.svg]]

![Relative image](../media/pixel.svg)

![[../media/brief.pdf]]

Missing: ![[missing.png|200]]

%%private recovery note%%

Before %%literal [[Missing]] ![image](missing.png)
second line%% after.

> [!note] Current approval
> **Review** before release.
>
> [[/People/Shared|Open person]]

> [!warning]- Release gate
> Approve deployment.
>
> > [!TIP]+ Recovery
> > Keep rollback ready.
> >
> > ```text
> > %%literal comment%% and [!danger]- remain code
> > ```
>
> Closing instruction.

> [!Research_Review]-
> Unknown identifier remains authored.
"#,
    )
    .expect("second note bytes");
  writer
    .write_all(
      include_str!("../../../../build/fixtures/markdown/obsidian-vault/Structured footnotes.md")
        .replace("(media/pixel.svg)", "(../media/pixel.svg)")
        .replace("https://example.org/reference", "../People/Shared.md#Person")
        .as_bytes(),
    )
    .expect("complete parent-local footnote source");
  let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>"#;
  writer.start_file("media/pixel.svg", options).expect("primary asset");
  writer.write_all(svg).expect("primary asset bytes");
  writer.start_file("copies/pixel.svg", options).expect("duplicate asset");
  writer.write_all(svg).expect("duplicate asset bytes");
  writer.start_file("media/brief.pdf", options).expect("PDF attachment");
  writer.write_all(b"%PDF-1.4\n%%EOF\n").expect("PDF attachment bytes");
  writer
    .start_file(".obsidian/app.json", options)
    .expect("excluded config");
  writer.write_all(b"{}").expect("config bytes");
  writer.finish().expect("finish vault ZIP").into_inner()
}

async fn run_preview(service: &WorkspaceImportService, actor: UserId, import_id: WorkspaceImportId) {
  service.queue_preview(actor, import_id).await.expect("queue preview");
  let result = service
    .run_worker_operation(WorkspaceImportWorkerEnvelope {
      import_id,
      actor_id: actor,
      operation: WorkspaceImportOperation::Preview,
    })
    .await
    .expect("run preview");
  assert_eq!(result.status, WorkspaceImportStatus::Previewed);
}

#[tokio::test]
async fn obsidian_vault_materializes_native_documents_metadata_and_organizer_once() {
  let pool = setup_pool().await;
  let actor = create_user(&pool, "workspace_import_obsidian_preview").await;
  let harness = build_service(&pool);
  let colliding_workspace = SqlxWorkspaceStore::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  )
  .create_workspace(actor, WorkspaceName::parse("Obsidian vault").unwrap())
  .await
  .expect("create existing same-name vault workspace");
  let import_id = stage_bytes(
    harness.service.as_ref(),
    actor,
    obsidian_vault_zip(),
    Some(myoxus_workspace_import::WorkspaceImportFormat::ObsidianZip),
  )
  .await;

  run_preview(harness.service.as_ref(), actor, import_id).await;
  let previewed = harness
    .service
    .operator_status(import_id)
    .await
    .expect("preview status");
  assert_eq!(previewed.selected_format, "obsidian_zip");
  let preview = previewed.preview.expect("durable preview");
  assert_eq!(preview["detectedFormat"], "obsidian_zip");
  assert_eq!(preview["sourceRoot"], "archive_root");
  assert_eq!(preview["counts"]["documents"], 2);
  assert_eq!(preview["counts"]["assets"], 3);
  assert_eq!(preview["omittedCounts"]["excludedEntries"], 1);
  assert_eq!(preview["applyAllowed"], true);
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE owner_user_id = $1")
      .bind(actor)
      .fetch_one(&pool)
      .await
      .expect("workspace count after preview"),
    1
  );

  let target_workspace_id =
    Uuid::parse_str(preview["targetPlan"]["workspaceId"].as_str().expect("workspace id")).expect("workspace UUID");
  let vault = &preview["targetPlan"]["vault"];
  let project = vault["documents"]
    .as_array()
    .expect("vault documents")
    .iter()
    .find(|document| document["sourcePath"] == "Projects/Shared.md")
    .expect("project plan");
  let project_id = Uuid::parse_str(project["targetDocumentId"].as_str().expect("project id")).expect("project UUID");
  assert!(
    vault["classifications"]
      .as_array()
      .expect("vault classifications")
      .iter()
      .any(|classification| classification["code"] == "VAULT_ANNOTATION_NATIVE")
  );
  assert!(
    vault["classifications"]
      .as_array()
      .expect("vault classifications")
      .iter()
      .any(
        |classification| classification["code"] == "VAULT_EMBED_NATIVE" && classification["preservation"] == "native"
      )
  );
  let current_fingerprint = harness
    .service
    .status(actor, import_id)
    .await
    .expect("preview status")
    .config_fingerprint;
  sqlx::query("UPDATE workspace_imports SET config_fingerprint = 'old-source-only-conversion' WHERE id = $1")
    .bind(import_id)
    .execute(&pool)
    .await
    .expect("stage prior conversion fingerprint");
  assert!(
    matches!(harness.service.queue_apply(actor, import_id).await, Err(AuthError::InvalidInput(message)) if message.contains("configuration changed"))
  );
  assert!(
    matches!(harness.service.queue_preview(actor, import_id).await, Err(AuthError::InvalidInput(message)) if message.contains("configuration changed"))
  );
  assert_eq!(
    harness
      .service
      .status(actor, import_id)
      .await
      .expect("old preview remains readable")
      .status,
    WorkspaceImportStatus::Previewed
  );
  sqlx::query("UPDATE workspace_imports SET config_fingerprint = $1 WHERE id = $2")
    .bind(current_fingerprint)
    .bind(import_id)
    .execute(&pool)
    .await
    .expect("restore current confirmation policy");
  let source_asset_targets = vault["assets"].as_array().expect("vault assets").iter();
  let primary_image_target = source_asset_targets
    .clone()
    .find(|asset| asset["sourcePath"] == "media/pixel.svg")
    .and_then(|asset| asset["targetAssetId"].as_str())
    .expect("primary image target");
  let duplicate_image_target = source_asset_targets
    .clone()
    .find(|asset| asset["sourcePath"] == "copies/pixel.svg")
    .and_then(|asset| asset["targetAssetId"].as_str())
    .expect("duplicate image target");
  assert_eq!(
    primary_image_target, duplicate_image_target,
    "duplicate bytes share one blob"
  );
  assert!(
    preview["diagnostics"]
      .as_array()
      .expect("diagnostics")
      .iter()
      .any(|diagnostic| diagnostic["message"]
        .as_str()
        .is_some_and(|message| message.contains("attachment embed"))),
    "the missing attachment must remain an explicit recovery diagnostic"
  );

  harness
    .service
    .queue_apply(actor, import_id)
    .await
    .expect("queue Obsidian apply");
  let envelope = WorkspaceImportWorkerEnvelope {
    import_id,
    actor_id: actor,
    operation: WorkspaceImportOperation::Apply,
  };
  let applied = harness
    .service
    .run_worker_operation(envelope.clone())
    .await
    .expect("apply Obsidian vault");
  assert_eq!(applied.status, WorkspaceImportStatus::Succeeded, "{applied:?}");
  assert_eq!(applied.target_workspace_id, Some(target_workspace_id));
  assert_one_workspace_tasks(&pool, target_workspace_id).await;
  let imported_workspace_and_root_name: (String, String) =
    sqlx::query_as("SELECT w.name, d.title FROM workspaces w JOIN docs d ON d.id = w.id WHERE w.id = $1")
      .bind(target_workspace_id)
      .fetch_one(&pool)
      .await
      .expect("imported workspace and root name");
  assert_eq!(
    imported_workspace_and_root_name,
    ("Obsidian vault (2)".to_string(), "Obsidian vault (2)".to_string()),
    "a same-name vault import receives one consistent server-owned suffix"
  );

  let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let project_update = doc_service
    .load_full_doc(target_workspace_id, project_id)
    .await
    .expect("stored project document");
  let project_text = yjs::extract_text_from_yjs(&project_update).expect("extract stored project");
  assert_eq!(project_text.title.as_deref(), Some("Project overview"));
  assert!(project_text.markdown.contains("==highlight=="));
  assert!(project_text.markdown.contains("```mermaid"));
  let projection = inspect_imported_editor_projection(&project_update);
  assert_eq!(projection.annotations, ["private recovery note"]);
  let mut callouts = projection.callouts.clone();
  callouts.sort();
  assert_eq!(
    callouts,
    [
      (
        "Research_Review".into(),
        "".into(),
        "Unknown identifier remains authored.".into(),
        true,
        false
      ),
      (
        "TIP".into(),
        "Recovery".into(),
        "Keep rollback ready.".into(),
        true,
        true
      ),
      (
        "note".into(),
        "Current approval".into(),
        "Review before release.".into(),
        false,
        true
      ),
      (
        "warning".into(),
        "Release gate".into(),
        "Approve deployment.".into(),
        true,
        false
      ),
    ]
  );
  for source in [
    "> [!warning]- Release gate",
    "> > [!TIP]+ Recovery",
    "> [!Research_Review]-",
    "%%literal comment%% and [!danger]- remain code",
    "> Closing instruction.",
  ] {
    assert!(
      project_text.markdown.contains(source),
      "persisted vault lost callout source: {source}"
    );
  }
  assert!(
    vault["classifications"]
      .as_array()
      .expect("classifications")
      .iter()
      .any(|item| item["code"] == "VAULT_CALLOUT_NATIVE")
  );
  assert!(
    project_text
      .markdown
      .contains("Before %%literal [[Missing]] ![image](missing.png)\nsecond line%% after."),
    "inline bodies remain literal through vault preparation and the native writer"
  );
  assert_eq!(
    projection.images, 3,
    "wiki, relative Markdown and definition images are native"
  );
  let research = projection
    .footnotes
    .iter()
    .find(|definition| definition.1 == "Research")
    .expect("native Research body");
  assert_eq!(
    research.2,
    [
      "myoxus:paragraph",
      "myoxus:paragraph",
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:paragraph",
      "myoxus:code",
      "myoxus:image",
      "myoxus:table"
    ]
  );
  let numeric = projection
    .footnotes
    .iter()
    .find(|definition| definition.1 == "2")
    .expect("native numeric body");
  assert_eq!(numeric.2, ["myoxus:paragraph"]);
  assert_eq!(projection.footnotes.len(), 2);
  assert_eq!(
    projection
      .local_markers
      .iter()
      .filter(|(_, id)| id == &research.0)
      .count(),
    2
  );
  assert_eq!(
    projection
      .local_markers
      .iter()
      .filter(|(_, id)| id == &numeric.0)
      .count(),
    1
  );
  assert!(
    vault["classifications"]
      .as_array()
      .unwrap()
      .iter()
      .any(|finding| finding["code"] == "VAULT_FOOTNOTE_NATIVE")
  );
  assert_eq!(project_text.markdown.matches("[^Research]:").count(), 1);
  assert!(
    projection
      .image_sources
      .iter()
      .all(|source| source == primary_image_target),
    "every source-relative image must resolve to the deduplicated workspace blob"
  );
  assert_eq!(
    projection.attachments, 1,
    "supported file embed uses the attachment schema"
  );
  assert_eq!(projection.mermaid, 1, "Mermaid is stored as the native diagram model");
  let references = yjs::extract_document_references_from_yjs(&project_update).expect("stored project references");
  assert_eq!(
    references.occurrences.len(),
    4,
    "ordinary/callout/definition links and the live document embed are native"
  );
  assert!(
    references
      .occurrences
      .iter()
      .all(|reference| reference.raw_target_doc_id == references.occurrences[0].raw_target_doc_id)
  );
  assert_eq!(
    references
      .occurrences
      .iter()
      .filter(|reference| reference.link_kind == yjs::DocumentReferenceLinkKind::EmbedSyncedDoc)
      .count(),
    1
  );
  assert_eq!(
    references.occurrences[0].raw_target_doc_id, references.occurrences[1].raw_target_doc_id,
    "callout resolution reuses the same batch target"
  );

  let metadata: serde_json::Value = sqlx::query_scalar("SELECT meta FROM docs WHERE id = $1")
    .bind(project_id)
    .fetch_one(&pool)
    .await
    .expect("project metadata");
  assert_eq!(metadata["obsidian"]["sourcePath"], "Projects/Shared.md");
  assert_eq!(metadata["obsidian"]["aliases"][0], "Overview");
  assert_eq!(metadata["obsidian"]["properties"]["custom"]["nested"], true);
  assert!(metadata["obsidian"]["recoverySourceKey"].is_string());

  let labels: Vec<String> = sqlx::query_scalar("SELECT name FROM workspace_tags WHERE workspace_id = $1 ORDER BY name")
    .bind(target_workspace_id)
    .fetch_all(&pool)
    .await
    .expect("vault labels");
  assert_eq!(labels, ["active", "project"]);
  let assignments: i64 =
    sqlx::query_scalar("SELECT count(*) FROM workspace_tag_document_assignments WHERE workspace_id = $1")
      .bind(target_workspace_id)
      .fetch_one(&pool)
      .await
      .expect("vault label assignments");
  assert_eq!(assignments, 2);

  let provenance = PgWorkspaceImportRepository::new(pool.clone())
    .latest_obsidian_provenance(target_workspace_id)
    .await
    .expect("load Obsidian export provenance");
  assert!(
    provenance.iter().any(|entry| {
      entry.kind == "document" && entry.source_path == "Projects/Shared.md" && entry.target_id == project_id.to_string()
    }),
    "the persisted UUID mapping must remain available to the exporter"
  );

  let organizer = OrganizerService::new(doc_service);
  let organizer_snapshot = organizer.snapshot(target_workspace_id).await.expect("vault organizer");
  let mut organizer_rows = Vec::new();
  organizer_nodes(&organizer_snapshot.roots, &mut organizer_rows);
  for folder in ["Empty folder", "People", "Projects", "media", "copies"] {
    assert!(
      organizer_rows
        .iter()
        .any(|node| node.row.row_type == "folder" && node.row.data == folder),
      "missing imported folder {folder}"
    );
  }
  assert_eq!(
    organizer_rows.iter().filter(|node| node.row.row_type == "doc").count(),
    2
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>(
      "SELECT count(*) FROM docs WHERE workspace_id = $1 AND id <> $1 AND external_id NOT LIKE 'db$%'",
    )
    .bind(target_workspace_id)
    .fetch_one(&pool)
    .await
    .expect("source parent row count"),
    2,
    "multiple footnotes add neither persisted documents nor root pages"
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE workspace_id = $1")
      .bind(target_workspace_id)
      .fetch_one(&pool)
      .await
      .expect("all document rows"),
    4,
    "only the existing workspace root and organizer database accompany the two source parents"
  );
  let storage = StorageAdapter::new_fs(harness._storage_root.path().to_str().unwrap()).unwrap();
  let bytes = storage
    .read_blob(&format!("{target_workspace_id}/{primary_image_target}"))
    .await
    .expect("actual definition image bytes");
  assert_eq!(
    bytes.data.as_ref(),
    br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>"#
  );

  let blob_count: i64 = sqlx::query_scalar("SELECT count(*) FROM blobs WHERE workspace_id = $1")
    .bind(target_workspace_id)
    .fetch_one(&pool)
    .await
    .expect("vault blob count");
  assert_eq!(
    blob_count, 3,
    "one deduplicated SVG, one PDF attachment and one recovery source"
  );

  let retry = harness
    .service
    .run_worker_operation(envelope)
    .await
    .expect("terminal Obsidian retry");
  assert_eq!(retry.status, WorkspaceImportStatus::Succeeded);
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE id = $1")
      .bind(target_workspace_id)
      .fetch_one(&pool)
      .await
      .expect("workspace count after retry"),
    1
  );
  assert_one_workspace_tasks(&pool, target_workspace_id).await;
  cleanup_case(&pool, import_id, actor, &[target_workspace_id, colliding_workspace.id]).await;
}

async fn assert_one_workspace_tasks(pool: &PgPool, workspace_id: Uuid) {
  let count: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM workspace_databases WHERE workspace_id = $1 AND system_role = 'workspace_tasks' AND deleted_at IS NULL"
  ).bind(workspace_id).fetch_one(pool).await.expect("published default inventory");
  assert_eq!(count, 1, "every published imported workspace has one canonical default");
}

async fn cleanup_case(pool: &PgPool, import_id: WorkspaceImportId, actor: UserId, workspace_ids: &[Uuid]) {
  // Outbox rows have no workspace FK and survive compensation/deletion. Include
  // this import's planned target even when compensation already removed it.
  sqlx::query(
    "DELETE FROM outbox_events WHERE event_type = 'workspace_doc_broadcast' AND (
       payload->>'workspaceId' IN (SELECT unnest($1::uuid[])::text)
       OR payload->>'actorUserId' = $2
       OR payload->>'workspaceId' = (
         SELECT preview->'targetPlan'->>'workspaceId' FROM workspace_imports WHERE id = $3
       ))",
  )
  .bind(workspace_ids)
  .bind(actor.to_string())
  .bind(import_id)
  .execute(pool)
  .await
  .expect("delete this import fixture's document broadcast outbox rows");
  for workspace_id in workspace_ids {
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(workspace_id)
      .execute(pool)
      .await
      .expect("delete imported workspace during test cleanup");
  }
  sqlx::query("DELETE FROM workspace_imports WHERE id = $1")
    .bind(import_id)
    .execute(pool)
    .await
    .expect("delete workspace import during test cleanup");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(actor)
    .execute(pool)
    .await
    .expect("delete workspace import actor during test cleanup");
}

#[tokio::test]
async fn both_supported_workspace_fixtures_apply_once_and_terminal_retry_is_idempotent() {
  let pool = setup_pool().await;
  for fixture_name in ["workspace-sqlite-v1-valid.myoxus", "workspace-snapshot-valid.zip"] {
    let actor = create_user(&pool, "workspace_import_success").await;
    let harness = build_service(&pool);
    let import_id = stage_fixture(harness.service.as_ref(), actor, fixture_name).await;
    let outcome = std::panic::AssertUnwindSafe(async {
      run_preview(harness.service.as_ref(), actor, import_id).await;
      harness
        .service
        .queue_apply(actor, import_id)
        .await
        .expect("queue apply");
      assert_eq!(harness.queue.jobs.lock().expect("queue lock").len(), 2);
      if fixture_name == "workspace-sqlite-v1-valid.myoxus" {
        let repository = PgWorkspaceImportRepository::new(pool.clone());
        let running = repository
          .claim_operation(import_id, WorkspaceImportOperation::Apply)
          .await
          .expect("claim interrupted apply");
        repository
          .update_progress(import_id, WorkspaceImportProgressStage::TargetCreation, 1, 2)
          .await
          .expect("persist interrupted progress");
        let target_workspace_id = running
          .preview
          .as_ref()
          .and_then(|preview| preview["targetPlan"]["workspaceId"].as_str())
          .map(|id| Uuid::parse_str(id).expect("planned workspace id must be a UUID"))
          .expect("planned workspace id must exist");
        repository
          .append_compensation(
            import_id,
            0,
            WorkspaceImportCompensationKind::Workspace,
            &target_workspace_id.to_string(),
          )
          .await
          .expect("persist interrupted compensation");
        sqlx::query(
          "INSERT INTO workspaces (
             id, owner_user_id, name, lifecycle_state,
             lifecycle_owner_kind, lifecycle_owner_id
           ) VALUES ($1, $2, 'Interrupted import', 'importing', 'import', $3)",
        )
        .bind(target_workspace_id)
        .bind(actor)
        .bind(import_id)
        .execute(&pool)
        .await
        .expect("partial hidden workspace");
      }
      let envelope = WorkspaceImportWorkerEnvelope {
        import_id,
        actor_id: actor,
        operation: WorkspaceImportOperation::Apply,
      };
      let result = harness
        .service
        .run_worker_operation(envelope.clone())
        .await
        .expect("run apply");
      assert_eq!(result.status, WorkspaceImportStatus::Succeeded);
      let workspace_id = result.target_workspace_id.expect("published target workspace");
      let catalog = Arc::new(myoxus_infrastructure::database_templates::load_database_template_catalog(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases")
      ).expect("immutable catalog fixture"));
      let repository = Arc::new(PgDatabaseRepository::new(pool.clone(), catalog.clone()));
      assert_one_workspace_tasks(&pool, workspace_id).await;
      let initializer = WorkspaceTasksInitializer::new(catalog, repository.clone(), std::sync::Arc::new(myoxus_application::database::DatabaseProjectionService::new(repository.clone(), repository.clone(), repository.clone(), repository.clone(), myoxus_application::database::DatabaseLimits::default())));
      let default = initializer.ensure(workspace_id, None).await.expect("verify imported default");
      let retained_task = repository.create_row(
        default.database.id, Uuid::new_v4(), DatabaseRowKind::Task,
        "Task created after workspace publication".into(), actor, Vec::new(),
        DatabaseEditPrecondition::new(None, true).in_workspace(workspace_id).in_database(default.database.id),
      ).await.expect("native Task after import");
      let retained_task = repository.get_row(retained_task.row.id).await
        .expect("read persisted Task before retry").expect("created Task is persisted");


      let labels: Vec<(String, String, Option<String>, bool)> = sqlx::query_as(
        "SELECT name, color_role, description, archived_at IS NOT NULL FROM workspace_tags WHERE workspace_id = $1 ORDER BY archived_at NULLS FIRST"
      ).bind(workspace_id).fetch_all(&pool).await.expect("canonical imported label catalog");
      assert_eq!(
        labels,
        vec![
          (
            "Priority".into(),
            "tag.blue".into(),
            Some("Active portable label".into()),
            false
          ),
          (
            "Priority".into(),
            "tag.grey".into(),
            Some("Archived portable label".into()),
            true
          ),
        ]
      );
      let assigned: Vec<(String, bool)> = sqlx::query_as(
        "SELECT tag.description, tag.archived_at IS NOT NULL FROM workspace_tag_document_assignments assignment JOIN workspace_tags tag ON tag.id = assignment.tag_id WHERE assignment.workspace_id = $1 ORDER BY assignment.position"
      ).bind(workspace_id).fetch_all(&pool).await.expect("ordered imported label references");
      assert_eq!(
        assigned,
        vec![
          ("Archived portable label".into(), true),
          ("Active portable label".into(), false)
        ]
      );
      // A live imported workspace has one label authority; portable Yjs fields
      // belong only to detached exports after the coordinated client cutover.
      let root = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
        .load_full_doc_with_meta(workspace_id, workspace_id)
        .await
        .expect("load imported live root");
      assert!(root.has_real_content);
      let metadata = yjs::extract_workspace_root_metadata(&root.payload)
        .expect("decode imported live root");
      assert_eq!(metadata.workspace_tags, serde_json::json!([]));
      assert!(!metadata.pages.is_empty());
      assert!(metadata.pages.iter().all(|page| !page.tags_present));

      let counts: (i64, i64, i64, i64, i64) = sqlx::query_as(
        r#"
        SELECT
          (SELECT count(*) FROM docs WHERE workspace_id = $1),
          (SELECT count(*) FROM workspace_databases WHERE workspace_id = $1 AND system_role IS NULL),
          (SELECT count(*) FROM workspace_database_fields WHERE database_id IN (SELECT id FROM workspace_databases WHERE workspace_id = $1 AND system_role IS NULL)),
          (SELECT count(*) FROM workspace_database_rows WHERE database_id IN (SELECT id FROM workspace_databases WHERE workspace_id = $1 AND system_role IS NULL)),
          (SELECT count(*) FROM workspace_database_views WHERE database_id IN (SELECT id FROM workspace_databases WHERE workspace_id = $1 AND system_role IS NULL))
        "#,
      )
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("imported product counts");
      assert_eq!(counts, (3, 2, 18, 3, 3));
      let workspace_state: String = sqlx::query_scalar("SELECT lifecycle_state FROM workspaces WHERE id = $1")
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("workspace state");
      assert_eq!(workspace_state, "active");
      let update_count: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE workspace_id = $1")
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("normal imported document updates");
      assert_eq!(
        update_count, counts.0,
        "every imported document must use the normal update path"
      );
      let snapshot_count: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_snapshots WHERE workspace_id = $1")
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("import snapshot bypass count");
      assert_eq!(
        snapshot_count, 0,
        "initial import must not bypass DocService via snapshots"
      );
      let imported_database_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id = $1")
          .bind(workspace_id)
          .fetch_all(&pool)
          .await
          .expect("imported Database ids");
      let imported_updates: Vec<Vec<u8>> = sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id = $1")
        .bind(workspace_id)
        .fetch_all(&pool)
        .await
        .expect("imported document states");
      let mut editor_projection = ImportedEditorProjection::default();
      for update in imported_updates {
        let inspected = inspect_imported_editor_projection(&update);
        editor_projection.pages += inspected.pages;
        editor_projection.surfaces += inspected.surfaces;
        editor_projection.paragraphs += inspected.paragraphs;
        editor_projection.linked_documents += inspected.linked_documents;
        editor_projection.database_references += inspected.database_references;
        for block in yjs::extract_legacy_database_blocks(&update).expect("read imported Database blocks") {
          assert!(
            block.is_reference_only(),
            "imported document retained editor-local Database data"
          );
          let database_id = Uuid::parse_str(block.server_database_id.as_deref().expect("server Database reference"))
            .expect("server Database UUID");
          assert!(
            imported_database_ids.contains(&database_id),
            "imported reference points outside the fresh workspace"
          );
        }
      }
      assert_eq!(editor_projection.pages, 2, "both imported documents need a root page");
      assert_eq!(
        editor_projection.surfaces, 2,
        "both imported documents must remain switchable to Edgeless"
      );
      assert_eq!(
        editor_projection.paragraphs, 2,
        "Database-owned row blocks must be removed while document paragraphs remain"
      );
      assert_eq!(
        editor_projection.linked_documents, 2,
        "both imported documents need a resolvable internal link"
      );
      assert_eq!(
        editor_projection.database_references, 3,
        "all repeated Database embeds must remain as references"
      );

      let before_retry = counts;
      let retry = harness
        .service
        .run_worker_operation(envelope)
        .await
        .expect("terminal worker retry");
      assert_eq!(retry.status, WorkspaceImportStatus::Succeeded);
      let after_retry: (i64, i64, i64, i64, i64) = sqlx::query_as(
        r#"
        SELECT
          (SELECT count(*) FROM docs WHERE workspace_id = $1),
          (SELECT count(*) FROM workspace_databases WHERE workspace_id = $1 AND system_role IS NULL),
          (SELECT count(*) FROM workspace_database_fields WHERE database_id IN (SELECT id FROM workspace_databases WHERE workspace_id = $1 AND system_role IS NULL)),
          (SELECT count(*) FROM workspace_database_rows WHERE database_id IN (SELECT id FROM workspace_databases WHERE workspace_id = $1 AND system_role IS NULL)),
          (SELECT count(*) FROM workspace_database_views WHERE database_id IN (SELECT id FROM workspace_databases WHERE workspace_id = $1 AND system_role IS NULL))
        "#,
      )
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("post-retry counts");
      assert_eq!(after_retry, before_retry);
      assert_one_workspace_tasks(&pool, workspace_id).await;
      for _ in 0..2 {
        let ensured = initializer.ensure(workspace_id, None).await.expect("idempotent imported workspace initialization");
        assert_eq!(ensured.database.id, default.database.id);
        assert_eq!(serde_json::to_value(&ensured.database.managed_installation).unwrap(), serde_json::to_value(&default.database.managed_installation).unwrap());
        let retained = repository.get_row(retained_task.row.id).await.expect("read retained Task").expect("Task remains after retry");
        assert_eq!(serde_json::to_value(retained).unwrap(), serde_json::to_value(&retained_task).unwrap());
      }
      let label_repo = PgWorkspaceTagRepository::new(pool.clone(), std::sync::Arc::new(myoxus_infrastructure::database_templates::load_database_template_catalog(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases")).expect("catalog fixture")));
      let original_tags = label_repo.list_tags(workspace_id, true).await.expect("imported labels");
      sqlx::query("UPDATE workspace_tags SET description = 'Canonical edit after import' WHERE id = $1")
        .bind(original_tags[0].id)
        .execute(&pool)
        .await
        .expect("edit canonical imported label");
      let replayed = label_repo
        .import_tags(workspace_id, actor, &original_tags, &[])
        .await
        .expect("replay explicit catalog transfer");
      assert_eq!(replayed.len(), 2);
      assert_eq!(replayed[0].description.as_deref(), Some("Canonical edit after import"));
      assert_eq!(label_repo.list_tags(workspace_id, true).await.unwrap().len(), 2);

      // Hold the actual catalog row until the importing connection is waiting;
      // retirement commits between the first ledger read and the row-lock result.
      let retired = original_tags
        .iter()
        .find(|tag| tag.archived_at.is_some())
        .unwrap()
        .clone();
      let writer_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&std::env::var("TEST_DATABASE_URL").expect("isolated test URL"))
        .await
        .unwrap();
      let writer_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&writer_pool)
        .await
        .unwrap();
      let mut deletion = pool.begin().await.unwrap();
      sqlx::query("SELECT id FROM workspace_tags WHERE id = $1 FOR UPDATE")
        .bind(retired.id)
        .fetch_one(&mut *deletion)
        .await
        .unwrap();
      sqlx::query(
        "INSERT INTO workspace_tag_retired_ids (workspace_id, retired_tag_id, retired_at) VALUES ($1, $2, now())",
      )
      .bind(workspace_id)
      .bind(retired.id.to_string())
      .execute(&mut *deletion)
      .await
      .unwrap();
      sqlx::query("DELETE FROM workspace_tag_document_assignments WHERE tag_id = $1")
        .bind(retired.id)
        .execute(&mut *deletion)
        .await
        .unwrap();
      sqlx::query("DELETE FROM workspace_tags WHERE id = $1")
        .bind(retired.id)
        .execute(&mut *deletion)
        .await
        .unwrap();
      let mut writers = tokio::task::JoinSet::new();
      writers.spawn(async move {
        let result = PgWorkspaceTagRepository::new(writer_pool.clone(), std::sync::Arc::new(myoxus_infrastructure::database_templates::load_database_template_catalog(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases")).expect("catalog fixture")))
          .import_tags(workspace_id, actor, &[retired], &[])
          .await;
        writer_pool.close().await;
        result
      });
      let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
      loop {
        let waiting: bool =
          sqlx::query_scalar("SELECT COALESCE(wait_event_type = 'Lock', false) FROM pg_stat_activity WHERE pid = $1")
            .bind(writer_pid)
            .fetch_one(&pool)
            .await
            .unwrap();
        if waiting {
          break;
        }
        assert!(
          tokio::time::Instant::now() < deadline,
          "import must wait on the retiring catalog row"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
      }
      deletion.commit().await.unwrap();
      assert!(
        writers.join_next().await.unwrap().unwrap().is_err(),
        "retirement must never be resurrected by a transfer retry"
      );
      assert_eq!(label_repo.list_tags(workspace_id, true).await.unwrap().len(), 1);
    })
    .catch_unwind()
    .await;
    // This actor belongs only to this case, including a partially created hidden
    // workspace. Assertion failures must clean up before their panic is resumed.
    let workspace_ids = sqlx::query_scalar("SELECT id FROM workspaces WHERE owner_user_id = $1")
      .bind(actor)
      .fetch_all(&pool)
      .await
      .expect("find owned test workspaces for cleanup");
    cleanup_case(&pool, import_id, actor, &workspace_ids).await;
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  }
}

#[tokio::test]
async fn queue_failure_restores_previewable_state_without_duplicate_dispatch() {
  let pool = setup_pool().await;
  let actor = create_user(&pool, "workspace_import_queue_recovery").await;
  let harness = build_service(&pool);
  let import_id = stage_fixture(harness.service.as_ref(), actor, "workspace-snapshot-valid.zip").await;
  harness.queue.fail_next.store(true, Ordering::SeqCst);
  let error = harness
    .service
    .queue_preview(actor, import_id)
    .await
    .expect_err("intentional dispatch failure");
  assert!(matches!(error, AuthError::Storage(_)));
  assert_eq!(
    harness
      .service
      .operator_status(import_id)
      .await
      .expect("restored import")
      .status,
    WorkspaceImportStatus::Staged
  );
  harness
    .service
    .queue_preview(actor, import_id)
    .await
    .expect("retry preview dispatch");
  assert_eq!(harness.queue.jobs.lock().expect("queue lock").len(), 1);
  cleanup_case(&pool, import_id, actor, &[]).await;
}

#[tokio::test]
async fn cancellation_is_terminal_before_writes_and_after_partial_target_creation() {
  let pool = setup_pool().await;

  // A queued operation may still exist in Redis when the account cancels it.
  // Its eventual delivery must observe the durable terminal state as a no-op,
  // rather than burn retries or create a target after cancellation.
  let actor = create_user(&pool, "workspace_import_cancel_queued").await;
  let harness = build_service(&pool);
  let import_id = stage_fixture(harness.service.as_ref(), actor, "workspace-snapshot-valid.zip").await;
  run_preview(harness.service.as_ref(), actor, import_id).await;
  harness
    .service
    .queue_apply(actor, import_id)
    .await
    .expect("queue apply before cancellation");
  let cancelled = harness
    .service
    .cancel(actor, import_id)
    .await
    .expect("cancel queued import");
  assert_eq!(cancelled.status, WorkspaceImportStatus::Cancelled);
  let stale_delivery = harness
    .service
    .run_worker_operation(WorkspaceImportWorkerEnvelope {
      import_id,
      actor_id: actor,
      operation: WorkspaceImportOperation::Apply,
    })
    .await
    .expect("stale apply delivery is terminal and idempotent");
  assert_eq!(stale_delivery.status, WorkspaceImportStatus::Cancelled);
  assert_eq!(
    sqlx::query_scalar::<_, i64>(
      "SELECT count(*) FROM workspaces WHERE owner_user_id = $1 AND lifecycle_state = 'importing'"
    )
    .bind(actor)
    .fetch_one(&pool)
    .await
    .expect("hidden target count after queued cancellation"),
    0
  );
  cleanup_case(&pool, import_id, actor, &[]).await;

  // Simulate a worker process stopping immediately after durable target
  // creation. The replay must compensate that target before it observes the
  // cancellation and finishes without duplicate product state.
  let actor = create_user(&pool, "workspace_import_cancel_running").await;
  let harness = build_service(&pool);
  let import_id = stage_fixture(harness.service.as_ref(), actor, "workspace-snapshot-valid.zip").await;
  run_preview(harness.service.as_ref(), actor, import_id).await;
  let preview = harness
    .service
    .operator_status(import_id)
    .await
    .expect("preview status")
    .preview
    .expect("durable preview");
  let target_workspace_id = Uuid::parse_str(
    preview["targetPlan"]["workspaceId"]
      .as_str()
      .expect("planned workspace id"),
  )
  .expect("planned workspace UUID");
  harness
    .service
    .queue_apply(actor, import_id)
    .await
    .expect("queue running apply");
  let repository = PgWorkspaceImportRepository::new(pool.clone());
  repository
    .claim_operation(import_id, WorkspaceImportOperation::Apply)
    .await
    .expect("claim interrupted apply");
  repository
    .append_compensation(
      import_id,
      0,
      WorkspaceImportCompensationKind::Workspace,
      &target_workspace_id.to_string(),
    )
    .await
    .expect("persist target compensation");
  SqlxWorkspaceStore::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  )
  .create_importing_workspace(
    import_id,
    actor,
    target_workspace_id,
    myoxus_application::workspace::WorkspaceName::parse("Cancelled import").unwrap(),
  )
  .await
  .expect("create partial hidden target");
  repository
    .update_progress(import_id, WorkspaceImportProgressStage::TargetCreation, 1, 1)
    .await
    .expect("persist interrupted target stage");
  let running = harness
    .service
    .cancel(actor, import_id)
    .await
    .expect("request cancellation during apply");
  assert_eq!(running.status, WorkspaceImportStatus::Running);
  assert!(running.cancel_requested);

  let cancelled = harness
    .service
    .run_worker_operation(WorkspaceImportWorkerEnvelope {
      import_id,
      actor_id: actor,
      operation: WorkspaceImportOperation::Apply,
    })
    .await
    .expect("replay compensates and finishes cancellation");
  assert_eq!(cancelled.status, WorkspaceImportStatus::Cancelled);
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE id = $1")
      .bind(target_workspace_id)
      .fetch_one(&pool)
      .await
      .expect("partial target count after cancellation"),
    0
  );
  assert!(
    repository
      .pending_compensations(import_id)
      .await
      .expect("pending cancellation compensations")
      .is_empty()
  );
  cleanup_case(&pool, import_id, actor, &[]).await;
}

async fn install_apply_failure_trigger(pool: &PgPool, import_id: WorkspaceImportId, predicate: &str) {
  sqlx::query("DROP TRIGGER IF EXISTS pdb36_workspace_import_failpoint_trigger ON workspace_imports")
    .execute(pool)
    .await
    .expect("drop stale workspace import failure trigger");
  let function = format!(
    r#"
    CREATE OR REPLACE FUNCTION pdb36_workspace_import_failpoint()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = '{import_id}'::uuid AND ({predicate}) THEN
        RAISE EXCEPTION 'P-DB-36 injected durable transition failure';
      END IF;
      RETURN NEW;
    END;
    $$
    "#,
  );
  sqlx::query(&function)
    .execute(pool)
    .await
    .expect("install workspace import failure function");
  sqlx::query(
    "CREATE TRIGGER pdb36_workspace_import_failpoint_trigger BEFORE UPDATE ON workspace_imports \
     FOR EACH ROW EXECUTE FUNCTION pdb36_workspace_import_failpoint()",
  )
  .execute(pool)
  .await
  .expect("install workspace import failure trigger");
}

async fn remove_apply_failure_trigger(pool: &PgPool) {
  sqlx::query("DROP TRIGGER IF EXISTS pdb36_workspace_import_failpoint_trigger ON workspace_imports")
    .execute(pool)
    .await
    .expect("remove workspace import failure trigger");
  sqlx::query("DROP FUNCTION IF EXISTS pdb36_workspace_import_failpoint()")
    .execute(pool)
    .await
    .expect("remove workspace import failure function");
}

#[tokio::test]
async fn every_apply_materialization_boundary_compensates_without_product_leaks() {
  let pool = setup_pool().await;
  for (name, predicate) in [
    (
      "workspace",
      "NEW.progress_stage = 'target_creation' AND NEW.progress_current = 1",
    ),
    (
      "asset",
      "NEW.progress_stage = 'target_creation' AND NEW.progress_current = 2",
    ),
    (
      "document",
      "NEW.progress_stage = 'document_materialization' AND NEW.progress_current = 1",
    ),
    (
      "database",
      "NEW.progress_stage = 'database_materialization' AND NEW.progress_current = 1",
    ),
    ("publication", "NEW.status = 'succeeded'"),
  ] {
    let actor = create_user(&pool, &format!("workspace_import_failure_{name}")).await;
    let harness = build_service(&pool);
    let import_id = stage_fixture(harness.service.as_ref(), actor, "workspace-snapshot-valid.zip").await;
    run_preview(harness.service.as_ref(), actor, import_id).await;
    let target_workspace_id = harness
      .service
      .operator_status(import_id)
      .await
      .expect("preview status")
      .preview
      .as_ref()
      .and_then(|preview| preview["targetPlan"]["workspaceId"].as_str())
      .map(|id| Uuid::parse_str(id).expect("planned workspace UUID"))
      .expect("planned workspace id");
    harness
      .service
      .queue_apply(actor, import_id)
      .await
      .expect("queue apply for failure boundary");
    install_apply_failure_trigger(&pool, import_id, predicate).await;

    let failure = harness
      .service
      .run_worker_operation(WorkspaceImportWorkerEnvelope {
        import_id,
        actor_id: actor,
        operation: WorkspaceImportOperation::Apply,
      })
      .await
      .expect_err("injected durable transition must fail the worker attempt");
    assert!(matches!(failure, AuthError::Storage(_)), "{name}: {failure:?}");
    remove_apply_failure_trigger(&pool).await;

    let terminal = harness
      .service
      .finalize_retry_exhaustion(import_id)
      .await
      .expect("retry exhaustion compensates the partial target");
    assert_eq!(terminal.status, WorkspaceImportStatus::Failed, "{name}");
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE id = $1")
        .bind(target_workspace_id)
        .fetch_one(&pool)
        .await
        .expect("target workspace count"),
      0,
      "{name}: hidden workspace leaked"
    );
    for (label, query) in [
      ("documents", "SELECT count(*) FROM docs WHERE workspace_id = $1"),
      (
        "Databases",
        "SELECT count(*) FROM workspace_databases WHERE workspace_id = $1",
      ),
      ("assets", "SELECT count(*) FROM blobs WHERE workspace_id = $1"),
      (
        "memberships",
        "SELECT count(*) FROM workspace_memberships WHERE workspace_id = $1",
      ),
    ] {
      assert_eq!(
        sqlx::query_scalar::<_, i64>(query)
          .bind(target_workspace_id)
          .fetch_one(&pool)
          .await
          .unwrap_or_else(|error| panic!("{name}: count {label}: {error}")),
        0,
        "{name}: {label} leaked"
      );
    }
    assert!(
      PgWorkspaceImportRepository::new(pool.clone())
        .pending_compensations(import_id)
        .await
        .expect("pending compensations after failure")
        .is_empty(),
      "{name}: compensation ledger remains pending"
    );
    cleanup_case(&pool, import_id, actor, &[]).await;
  }
  remove_apply_failure_trigger(&pool).await;
}

#[tokio::test]
async fn unsafe_compensation_enters_cleanup_required_and_operator_retry_finishes_once() {
  let pool = setup_pool().await;
  let actor = create_user(&pool, "workspace_import_cleanup_retry").await;
  let harness = build_service(&pool);
  let import_id = stage_fixture(harness.service.as_ref(), actor, "workspace-snapshot-valid.zip").await;
  run_preview(harness.service.as_ref(), actor, import_id).await;
  let preview = harness
    .service
    .operator_status(import_id)
    .await
    .expect("preview status")
    .preview
    .expect("durable preview");
  let target_workspace_id = Uuid::parse_str(
    preview["targetPlan"]["workspaceId"]
      .as_str()
      .expect("planned workspace id"),
  )
  .expect("planned workspace UUID");
  harness
    .service
    .queue_apply(actor, import_id)
    .await
    .expect("queue apply before interrupted cleanup");
  let repository = PgWorkspaceImportRepository::new(pool.clone());
  repository
    .claim_operation(import_id, WorkspaceImportOperation::Apply)
    .await
    .expect("claim interrupted apply");
  repository
    .append_compensation(
      import_id,
      0,
      WorkspaceImportCompensationKind::Workspace,
      &target_workspace_id.to_string(),
    )
    .await
    .expect("persist workspace compensation");
  SqlxWorkspaceStore::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  )
  .create_importing_workspace(
    import_id,
    actor,
    target_workspace_id,
    myoxus_application::workspace::WorkspaceName::parse("Cleanup recovery").unwrap(),
  )
  .await
  .expect("create hidden target");
  repository
    .update_progress(import_id, WorkspaceImportProgressStage::TargetCreation, 1, 1)
    .await
    .expect("persist interrupted target stage");

  // A membership makes hard deletion unsafe. This uses the real repository
  // safety predicate and therefore proves cleanup_required without a fake
  // service or a status-only fixture.
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'Owner', 'Accepted', now())",
  )
  .bind(target_workspace_id)
  .bind(actor)
  .execute(&pool)
  .await
  .expect("make compensation target unsafe");
  let cleanup_required = harness
    .service
    .run_worker_operation(WorkspaceImportWorkerEnvelope {
      import_id,
      actor_id: actor,
      operation: WorkspaceImportOperation::Apply,
    })
    .await
    .expect("failed compensation projects durable recovery state");
  assert_eq!(cleanup_required.status, WorkspaceImportStatus::CleanupRequired);
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE id = $1")
      .bind(target_workspace_id)
      .fetch_one(&pool)
      .await
      .expect("protected target count"),
    1,
    "the compensation safety gate must never delete a target with membership"
  );

  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(target_workspace_id)
    .execute(&pool)
    .await
    .expect("resolve operator cleanup blocker");
  harness
    .service
    .retry_cleanup(import_id)
    .await
    .expect("queue operator cleanup retry");
  let cleanup_envelope = WorkspaceImportWorkerEnvelope {
    import_id,
    actor_id: actor,
    operation: WorkspaceImportOperation::Cleanup,
  };
  let recovered = harness
    .service
    .run_worker_operation(cleanup_envelope.clone())
    .await
    .expect("operator cleanup completes");
  assert_eq!(recovered.status, WorkspaceImportStatus::Failed);
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE id = $1")
      .bind(target_workspace_id)
      .fetch_one(&pool)
      .await
      .expect("recovered target count"),
    0
  );
  assert!(
    repository
      .pending_compensations(import_id)
      .await
      .expect("pending recovery compensations")
      .is_empty()
  );
  let terminal_retry = harness
    .service
    .run_worker_operation(cleanup_envelope)
    .await
    .expect("terminal cleanup delivery is idempotent");
  assert_eq!(terminal_retry.status, WorkspaceImportStatus::Failed);
  let operator_retry = harness
    .service
    .retry_cleanup(import_id)
    .await
    .expect("terminal operator cleanup action is idempotent");
  assert_eq!(operator_retry.status, WorkspaceImportStatus::Failed);
  cleanup_case(&pool, import_id, actor, &[]).await;
}

#[tokio::test]
async fn persisted_document_migration_appends_once_without_snapshot_bypass() {
  let pool = setup_pool().await;
  let actor = create_user(&pool, "workspace_import_persisted").await;
  let workspace_id = create_workspace(&pool, actor).await;
  let document_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by) \
     VALUES ($1, $1::text, $2, 'Legacy Database', false, $3, $3)",
  )
  .bind(document_id)
  .bind(workspace_id)
  .bind(actor)
  .execute(&pool)
  .await
  .expect("persisted migration source document");

  let decoded = WorkspaceDecoder::new(WorkspaceImportLimits::default())
    .decode_path(fixture("workspace-sqlite-v1-valid.myoxus"))
    .expect("decode persisted migration fixture");
  let source_document = decoded
    .documents
    .into_iter()
    .find(|document| {
      let update = match &document.content {
        DecodedDocumentContent::YjsV1(update) => update.clone(),
        DecodedDocumentContent::SnapshotBlocks(blocks) => yjs::snapshot_blocks_to_yjs(blocks).unwrap(),
        DecodedDocumentContent::MarkdownUtf8(_) => return false,
      };
      yjs::extract_legacy_database_blocks(&update)
        .map(|blocks| blocks.iter().any(|block| !block.is_reference_only()))
        .unwrap_or(false)
    })
    .expect("legacy Database fixture document");
  let source_update = match source_document.content {
    DecodedDocumentContent::YjsV1(update) => update,
    DecodedDocumentContent::SnapshotBlocks(blocks) => {
      yjs::snapshot_blocks_to_yjs(&blocks).expect("snapshot fixture Yjs state")
    }
    DecodedDocumentContent::MarkdownUtf8(_) => unreachable!("SQLite fixture cannot contain Markdown source"),
  };
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  documents
    .push_update_raw(workspace_id, document_id, source_update, DocSpaceKind::Workspace)
    .await
    .expect("persist legacy document state");
  let databases = DatabaseServices::new(
    Arc::new(PgDatabaseRepository::new(
      pool.clone(),
      std::sync::Arc::new(
        myoxus_infrastructure::database_templates::load_database_template_catalog(
          &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
        )
        .expect("database catalog fixture"),
      ),
    )),
    documents,
    Arc::new(PermissionService::new(auth_store)),
    DatabaseLimits::default(),
    Arc::new(SqlxWorkspaceStore::new(
      pool.clone(),
      std::sync::Arc::new(
        myoxus_infrastructure::database_templates::load_database_template_catalog(
          &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
        )
        .expect("database catalog fixture"),
      ),
    )),
    Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("shipped Database catalog"),
    ),
    myoxus_application::database::DatabaseServiceDependencies::disabled(),
  );
  let updates_before: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
    .bind(document_id)
    .fetch_one(&pool)
    .await
    .expect("source update count");
  let first = databases
    .import_export
    .apply_legacy_database_migration(actor, workspace_id, &[document_id], WorkspaceImportLimits::default())
    .await
    .expect("apply persisted migration");
  assert!(first.plan.apply_allowed);
  assert!(first.migrated_block_count > 0);
  let updates_after: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
    .bind(document_id)
    .fetch_one(&pool)
    .await
    .expect("migration update count");
  assert_eq!(
    updates_after,
    updates_before + 1,
    "migration must append one server-authored update"
  );
  let snapshots: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_snapshots WHERE doc_id = $1")
    .bind(document_id)
    .fetch_one(&pool)
    .await
    .expect("migration snapshot count");
  assert_eq!(snapshots, 0, "migration must not write a snapshot directly");
  let database_count = first.created_database_ids.len() as i64;

  let retry = databases
    .import_export
    .apply_legacy_database_migration(actor, workspace_id, &[document_id], WorkspaceImportLimits::default())
    .await
    .expect("retry persisted migration");
  assert_eq!(retry.migrated_block_count, 0);
  assert!(retry.created_database_ids.is_empty());
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_databases WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("idempotent Database count"),
    database_count
  );
  cleanup_case(&pool, Uuid::new_v4(), actor, &[workspace_id]).await;
}

#[tokio::test]
async fn apply_failure_compensates_partial_target_without_deleting_a_colliding_database() {
  let pool = setup_pool().await;
  let actor = create_user(&pool, "workspace_import_compensation").await;
  let collision_workspace = create_workspace(&pool, actor).await;
  let harness = build_service(&pool);
  let import_id = stage_fixture(harness.service.as_ref(), actor, "workspace-snapshot-valid.zip").await;
  run_preview(harness.service.as_ref(), actor, import_id).await;
  let preview = harness
    .service
    .operator_status(import_id)
    .await
    .expect("preview status")
    .preview
    .expect("durable preview");
  let target_workspace_id =
    Uuid::parse_str(preview["targetPlan"]["workspaceId"].as_str().expect("workspace id")).expect("workspace uuid");
  let colliding_database_id =
    Uuid::parse_str(preview["targetPlan"]["databaseIds"][0].as_str().expect("database id")).expect("database uuid");
  sqlx::query(
    "INSERT INTO workspace_databases (id, workspace_id, title, created_by, updated_by) VALUES ($1, $2, 'Collision', $3, $3)",
  )
  .bind(colliding_database_id)
  .bind(collision_workspace)
  .bind(actor)
  .execute(&pool)
  .await
  .expect("insert collision");

  harness
    .service
    .queue_apply(actor, import_id)
    .await
    .expect("queue apply");
  let result = harness
    .service
    .run_worker_operation(WorkspaceImportWorkerEnvelope {
      import_id,
      actor_id: actor,
      operation: WorkspaceImportOperation::Apply,
    })
    .await
    .expect("deterministic failure is projected as terminal status");
  assert_eq!(result.status, WorkspaceImportStatus::Failed);
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE id = $1")
      .bind(target_workspace_id)
      .fetch_one(&pool)
      .await
      .expect("target workspace count"),
    0,
    "partial target must remain unpublished and be compensated"
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_databases WHERE id = $1 AND workspace_id = $2")
      .bind(colliding_database_id)
      .bind(collision_workspace)
      .fetch_one(&pool)
      .await
      .expect("collision count"),
    1,
    "compensation must not delete another workspace's Database"
  );
  cleanup_case(&pool, import_id, actor, &[collision_workspace]).await;
}
