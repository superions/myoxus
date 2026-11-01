// SPDX-License-Identifier: AGPL-3.0-or-later

//! Consuming persistence contract for the durable XWS aggregate.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use chrono::Utc;
use myoxus_application::auth::AuthError;
use myoxus_application::doc::{
  DocService, DocSpaceKind, DocUpdateStore, DocUpdateWrite, DocWriteTarget, ValidatedExternalYjsUpdate,
};
use myoxus_application::git_sync::export::{
  GitSyncManifest, GitSyncManifestDocument, GitSyncManifestFolder, GitSyncManifestOverview,
};
use myoxus_application::organizer::{CreateOrganizerFolder, CreateOrganizerLink, OrganizerLinkType, OrganizerService};
use myoxus_application::permission::{AccessController, PermissionService};
use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest, PortError};
use myoxus_application::workspace::{UpdateWorkspace, WorkspaceName, WorkspaceStore};
use myoxus_application::workspace_content_operation::authorization::{
  WorkspaceContentAuthorizationOptions, WorkspaceContentAuthorizer, WorkspaceContentMemberRevision,
  WorkspaceContentOwnerPrincipal,
};
use myoxus_application::workspace_content_operation::control::WorkspaceContentGraphSourcePort;
use myoxus_application::workspace_content_operation::coordination::{
  WorkspaceContentClusterCoordinator, WorkspaceContentCoordinationError, WorkspaceContentCoordinationResult,
  WorkspaceContentQueuePort,
};
use myoxus_application::workspace_content_operation::dependencies::workspace_content_dependency_manifest;
use myoxus_application::workspace_content_operation::extract::{
  WorkspaceContentExtractContextPort, WorkspaceContentExtractRecoveryPort, WorkspaceContentExtractRecoveryService,
  WorkspaceContentExtractTargetService,
};
use myoxus_application::workspace_content_operation::link::{
  WorkspaceContentLinkExecutor, WorkspaceContentLinkPublicationBatch, WorkspaceContentLinkPublicationPort,
  WorkspaceContentLinkService,
};
use myoxus_application::workspace_content_operation::move_publication::{
  WorkspaceContentMovePublicationBatch, WorkspaceContentMovePublicationPort, WorkspaceContentMovePublicationService,
  WorkspaceContentMoveRevisionManifestPort, WorkspaceContentRecipientSnapshotPort,
};
use myoxus_application::workspace_content_operation::notification::WorkspaceContentNotificationOutboxPort;
use myoxus_application::workspace_content_operation::overview::{
  OVERVIEW_PREVIEW_PREFIX, WorkspaceContentOverviewSnapshot, WorkspaceContentOverviewState,
};
use myoxus_application::workspace_content_operation::preflight::{
  WorkspaceContentGraphBuilder, WorkspaceContentGraphInput, WorkspaceContentGraphReference,
  WorkspaceContentGraphResource, WorkspaceContentPreflightGraph, WorkspaceContentReferencePurpose,
  WorkspaceContentSelection,
};
use myoxus_application::workspace_content_operation::publication::{
  WorkspaceContentCopyPublicationBatch, WorkspaceContentCopyPublicationPort, WorkspaceContentCopyPublicationService,
  WorkspaceContentPublicationObject,
};
use myoxus_application::workspace_content_operation::reconcile::{
  TAG_SCHEMA_VERSION, WorkspaceContentDefinition, WorkspaceContentReconcileAction, WorkspaceContentReconcileEnvelope,
  WorkspaceContentReconcileSourcePort,
};
use myoxus_application::workspace_content_operation::redirect::WorkspaceContentRedirectService;
use myoxus_application::workspace_content_operation::worker::{
  WorkspaceContentSemanticExecutor, WorkspaceContentSemanticRecovery,
};
use myoxus_application::workspace_content_operation::{
  WorkspaceContentCompensationIntent, WorkspaceContentControlRepository, WorkspaceContentExecuteRequest,
  WorkspaceContentExecutionMembership, WorkspaceContentGitSyncCapture, WorkspaceContentGitSyncCapturePort,
  WorkspaceContentLinkIntent, WorkspaceContentLinkIntentRepository, WorkspaceContentOperationRepository,
  WorkspaceContentOperationRequest, WorkspaceContentOperationSelection, WorkspaceContentRecipientIntent,
  WorkspaceContentRedirect, WorkspaceContentRedirectRepository, WorkspaceContentStagingManifestRepository,
};
use myoxus_domain::database::DatabaseDefinitionRepository;
use myoxus_domain::database::DatabaseEditPrecondition;
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::{OwnerPrincipalType, WorkspaceRole};
use myoxus_domain::git_sync::GitSyncProfile;
use myoxus_domain::workspace_content_operation::{
  RedactedWorkspaceContentError, WorkspaceContentBlocker, WorkspaceContentErrorCode, WorkspaceContentIdMapping,
  WorkspaceContentOperationKind, WorkspaceContentOperationRecord, WorkspaceContentOperationStatus,
  WorkspaceContentResourceKind, WorkspaceContentResourceRef, WorkspaceContentStagingEntry,
};
use myoxus_domain::workspace_overview::{
  OverviewOrderBy, OverviewRegisterPresentation, OverviewSettingsScope, WorkspaceOverviewSettingsPatch,
};
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_infrastructure::workspace_content_operation::{
  PgWorkspaceContentAuthorizationSource, PgWorkspaceContentCopyPublicationRepository, PgWorkspaceContentGraphSource,
  PgWorkspaceContentMovePublicationRepository, PgWorkspaceContentOperationRepository,
  PgWorkspaceContentRedirectRepository,
};
use myoxus_infrastructure::workspace_database::PgDatabaseRepository;

struct ExtractBranchFixture(WorkspaceContentGitSyncCapture);

#[async_trait]
impl WorkspaceContentGitSyncCapturePort for ExtractBranchFixture {
  async fn capture(
    &self,
    _actor_id: Uuid,
    _profile: &GitSyncProfile,
    _folder_id: &str,
    _paths: &[String],
  ) -> myoxus_application::auth::AuthResult<Option<WorkspaceContentGitSyncCapture>> {
    Ok(Some(self.0.clone()))
  }
}
use sha2::{Digest, Sha256};
use sqlx::Row;
use tower::ServiceExt;
use uuid::Uuid;

use crate::helpers;

/// Pause one completed object write so another publication can commit before
/// the first transaction fails and compensates its private materialization.
struct InterleavedPublicationStorage {
  inner: Arc<StorageAdapter>,
  paused_key: String,
  written: tokio::sync::Notify,
  resume: tokio::sync::Notify,
  reject_deletes: bool,
}

#[async_trait]
impl BlobStoragePort for InterleavedPublicationStorage {
  async fn write_blob(&self, req: BlobWriteRequest) -> myoxus_application::ports::PortResult<()> {
    let pause = req.key == self.paused_key;
    self.inner.write_blob(req).await?;
    if pause {
      self.written.notify_one();
      self.resume.notified().await;
    }
    Ok(())
  }
  async fn read_blob(
    &self,
    key: &str,
  ) -> myoxus_application::ports::PortResult<myoxus_application::ports::BlobReadResponse> {
    self.inner.read_blob(key).await
  }
  async fn delete_blob(&self, key: &str) -> myoxus_application::ports::PortResult<()> {
    if self.reject_deletes {
      return Err(PortError::Transport("test deletion failure".into()));
    }
    self.inner.delete_blob(key).await
  }
  async fn put_avatar(
    &self,
    key: &str,
    data: Bytes,
    content_type: &str,
  ) -> myoxus_application::ports::PortResult<String> {
    self.inner.put_avatar(key, data, content_type).await
  }
  async fn get_avatar(
    &self,
    key: &str,
  ) -> myoxus_application::ports::PortResult<myoxus_application::ports::BlobReadResponse> {
    self.inner.get_avatar(key).await
  }
  async fn delete_avatar(&self, key: &str) -> myoxus_application::ports::PortResult<()> {
    self.inner.delete_avatar(key).await
  }
  async fn create_multipart_upload(
    &self,
    req: myoxus_application::ports::MultipartCreateRequest,
  ) -> myoxus_application::ports::PortResult<myoxus_application::ports::MultipartCreateResponse> {
    self.inner.create_multipart_upload(req).await
  }
  async fn create_multipart_part_url(
    &self,
    req: myoxus_application::ports::MultipartPartUrlRequest,
  ) -> myoxus_application::ports::PortResult<myoxus_application::ports::MultipartPartUrlResponse> {
    self.inner.create_multipart_part_url(req).await
  }
  async fn complete_multipart_upload(
    &self,
    req: myoxus_application::ports::MultipartCompleteRequest,
  ) -> myoxus_application::ports::PortResult<()> {
    self.inner.complete_multipart_upload(req).await
  }
  async fn abort_multipart_upload(&self, upload_id: Uuid) -> myoxus_application::ports::PortResult<()> {
    self.inner.abort_multipart_upload(upload_id).await
  }
}

fn resource(
  workspace_id: Uuid,
  kind: WorkspaceContentResourceKind,
  id: impl Into<String>,
) -> WorkspaceContentResourceRef {
  WorkspaceContentResourceRef::new(workspace_id, kind, id).expect("valid workspace-qualified test resource")
}

async fn seed_organizer_root(pool: &sqlx::PgPool, workspace_id: Uuid, actor_id: Uuid) {
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, is_workspace_root, created_by, updated_by)
     VALUES ($1, $1, 'Workspace root', true, $2, $2)",
  )
  .bind(workspace_id)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("seed workspace organizer root");
  sqlx::query(
    "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
     VALUES ($1, $1, $2, 1)",
  )
  .bind(workspace_id)
  .bind(yjs::create_initial_workspace_doc("Workspace root"))
  .execute(pool)
  .await
  .expect("seed workspace organizer root update");
}

#[test]
fn folder_preflight_reconciles_organizer_targets_for_move_and_extract() {
  helpers::block_on_large_stack(
    "folder_preflight_reconciles_organizer_targets_for_move_and_extract",
    || async {
      let (_app, pool, auth) = helpers::setup_app().await;
      let (actor_id, _session) = helpers::seed_user(&pool, &auth, "xws_folder_preflight_actor").await;
      let source_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      let move_target_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      use futures_util::FutureExt;
      let outcome = std::panic::AssertUnwindSafe(async {
      seed_organizer_root(&pool, source_workspace_id, actor_id).await;
      seed_organizer_root(&pool, move_target_workspace_id, actor_id).await;

      let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
      let organizer = OrganizerService::new(doc_service.clone());
      let root_folder_id = Uuid::new_v4().to_string();
      let nested_folder_id = Uuid::new_v4().to_string();
      organizer
        .create_folder(
          source_workspace_id,
          CreateOrganizerFolder {
            id: root_folder_id.clone(),
            parent_id: None,
            name: "Folder preflight root".to_string(),
            index: Some("a0".to_string()),
          },
        )
        .await
        .expect("create preflight root folder");
      organizer
        .create_folder(
          source_workspace_id,
          CreateOrganizerFolder {
            id: nested_folder_id.clone(),
            parent_id: Some(root_folder_id.clone()),
            name: "Folder preflight nested".to_string(),
            index: Some("a0".to_string()),
          },
        )
        .await
        .expect("create nested preflight folder");

      let document_id = Uuid::new_v4();
      let document_key = Uuid::new_v4().to_string();
      sqlx::query(
        "INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by)
         VALUES ($1, $2, $3, '', $4, $4)",
      )
      .bind(document_id)
      .bind(source_workspace_id)
      .bind(&document_key)
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect("seed folder preflight document");
      let referenced_id = Uuid::new_v4();
      let referenced_key = "G-BOQ6jk9Ko2uqJ0eplg3";
      let incidental_key = "unrelated-plain-text";
      for key in [referenced_key, incidental_key] {
        sqlx::query("INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by) VALUES ($1, $2, $3, 'Reference target', $4, $4)")
          .bind(if key == referenced_key { referenced_id } else { Uuid::new_v4() })
          .bind(source_workspace_id).bind(key).bind(actor_id).execute(&pool).await.expect("seed reference target");
      }
      // Deliberately retain an obsolete index entry like the reported incident.
      // The current leaf and workspace-local external key are authoritative.
      sqlx::query("INSERT INTO document_graph_occurrences (workspace_id, source_doc_id, source_block_id, raw_target_doc_id, target_doc_id, link_kind, params_key, target_state) VALUES ($1, $2, 'linked', $3, NULL, 'embed_linked_doc', 'none', 'unresolved')")
        .bind(source_workspace_id).bind(document_id).bind(referenced_key).execute(&pool).await.expect("seed stale reference projection");
      let leaf = {
        use yrs::{Doc, Map, ReadTxn, Transact};
        let leaf = Doc::new();
        let blocks = leaf.get_or_insert_map("blocks");
        let mut txn = leaf.transact_mut();
        let link = blocks.insert(&mut txn, "linked", yrs::MapPrelim::default());
        link.insert(&mut txn, "sys:flavour", "myoxus:embed-linked-doc");
        link.insert(&mut txn, "prop:pageId", referenced_key);
        let paragraph = blocks.insert(&mut txn, "plain", yrs::MapPrelim::default());
        paragraph.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
        paragraph.insert(&mut txn, "prop:text", incidental_key);
        txn.encode_state_as_update_v1(&yrs::StateVector::default())
      };
      sqlx::query(
        "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
         VALUES ($1, $2, $3, 1)",
      )
      .bind(document_id)
      .bind(source_workspace_id)
      .bind(leaf)
      .execute(&pool)
      .await
      .expect("seed folder preflight document update");
      organizer
        .create_link(
          source_workspace_id,
          CreateOrganizerLink {
            id: Uuid::new_v4().to_string(),
            parent_id: nested_folder_id,
            link_type: OrganizerLinkType::Doc,
            target_id: document_key.clone(),
            target_workspace_id: None,
            index: Some("a0".to_string()),
          },
        )
        .await
        .expect("link folder preflight document");

      let collection_catalog = {
        use yrs::{Doc, Map, ReadTxn, Transact};
        let root = Doc::new();
        root.get_or_insert_map("setting").insert(&mut root.transact_mut(), "collections",
          yrs::Any::Array(vec![yrs::Any::Map(Arc::new(std::collections::HashMap::from([
            ("id".into(), yrs::Any::from("retained-collection")),
            ("futureRule".into(), yrs::Any::from("preserved")),
            ("allowList".into(), yrs::Any::Array(vec![yrs::Any::from(referenced_key)].into())),
          ])))].into()));
        root.transact().encode_state_as_update_v1(&yrs::StateVector::default())
      };
      sqlx::query("INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence) VALUES ($1, $1, $2, 2)")
        .bind(source_workspace_id).bind(&collection_catalog).execute(&pool).await.unwrap();
      organizer.create_link(source_workspace_id, CreateOrganizerLink {
        id: Uuid::new_v4().to_string(), parent_id: root_folder_id.clone(),
        link_type: OrganizerLinkType::Collection, target_id: "retained-collection".into(),
        target_workspace_id: None, index: Some("a1".into()),
      }).await.expect("ordinary placement reads the canonical catalog");
      let source_catalog_before = yjs::extract_workspace_collections(&doc_service.load_full_doc_consistent(source_workspace_id, source_workspace_id).await.unwrap()).unwrap();
      let graph_source = PgWorkspaceContentGraphSource::new(pool.clone(), doc_service.clone());
      let mut requests = vec![
        WorkspaceContentOperationRequest {
          kind: WorkspaceContentOperationKind::Move,
          source_workspace_id,
          target_workspace_id: move_target_workspace_id,
          selection: WorkspaceContentOperationSelection::Resources {
            resources: vec![resource(
              source_workspace_id,
              WorkspaceContentResourceKind::Folder,
              root_folder_id.clone(),
            )],
          },
          copy_document_acl: false,
          extract_workspace_name: None, git_sync_choice: None,
          link_entry_id: None,
          link_parent_id: None,
          link_index: None,
        },
        WorkspaceContentOperationRequest {
          kind: WorkspaceContentOperationKind::ExtractFolder,
          source_workspace_id,
          target_workspace_id: Uuid::new_v4(),
          selection: WorkspaceContentOperationSelection::FolderSubtree {
            folder_id: root_folder_id.clone(),
          },
          copy_document_acl: false,
          extract_workspace_name: Some("Folder preflight extract".to_string()), git_sync_choice: None,
          link_entry_id: None,
          link_parent_id: None,
          link_index: None,
        },
      ];
      requests.push(WorkspaceContentOperationRequest { kind: WorkspaceContentOperationKind::Copy, ..requests[0].clone() });

      for request in requests {
        sqlx::query("UPDATE docs SET deleted_at = NULL WHERE id = $1")
          .bind(document_id)
          .execute(&pool)
          .await
          .expect("restore authoritative document");
        let complete = graph_source
          .prepare(Uuid::nil(), Uuid::nil(), &request, Vec::new())
          .await
          .expect("prepare fully materialized folder graph");
        let complete = WorkspaceContentGraphBuilder
          .build(complete.input)
          .expect("build fully materialized folder graph");
        assert_eq!(complete.resources.len(), 3);
        assert_eq!(
          complete
            .resources
            .iter()
            .find(|resource| resource.resource.resource_id() == document_key)
            .expect("untitled document remains in graph")
            .display_name
            .as_deref(),
          Some("")
        );
        assert!(
          complete.blockers.is_empty(),
          "a complete folder graph must be executable"
        );
        assert!(
          complete
            .references
            .iter()
            .any(|reference| reference.target.resource_id() == referenced_key)
        );
        assert!(
          !complete
            .references
            .iter()
            .any(|reference| reference.target.resource_id() == incidental_key)
        );

        assert!(!complete.mappings.iter().any(|mapping| mapping.mapping.source.kind() == WorkspaceContentResourceKind::Collection));
        assert!(!complete.resources.iter().any(|item| item.resource.resource_id() == referenced_key), "lateral Collection allow-list documents are not adopted");
        let mappings = complete.mappings.iter().map(|planned| planned.mapping.clone()).collect::<Vec<_>>();
        let projection = organizer.project_move(source_workspace_id, request.target_workspace_id, &mappings, &[]).await.unwrap();
        assert!(projection.target_rows.iter().any(|row| row.row_type == "collection" && row.data == "retained-collection" && row.target_workspace_id == Some(source_workspace_id)));
        assert_eq!(yjs::extract_workspace_collections(&doc_service.load_full_doc_consistent(source_workspace_id, source_workspace_id).await.unwrap()).unwrap(), source_catalog_before);

        sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
          .bind(referenced_id)
          .execute(&pool)
          .await
          .expect("delete typed reference target");
        let missing = WorkspaceContentGraphBuilder
          .build(
            graph_source
              .prepare(Uuid::nil(), Uuid::nil(), &request, Vec::new())
              .await
              .expect("prepare missing typed reference")
              .input,
          )
          .expect("build missing typed reference");
        assert!(missing.blockers.is_empty(), "contained reference absence must not block transfer");
        assert!(missing.missing_resources.is_empty(), "only missing direct roots need source repair");
        assert!(missing.references.iter().any(|reference| reference.target.resource_id() == referenced_key && reference.placement == myoxus_application::workspace_content_operation::preflight::WorkspaceContentReferencePlacement::Broken));
        let projection = myoxus_api::graphql::auth::WorkspaceContentPreflightType::from_result(
          myoxus_application::workspace_content_operation::control::WorkspaceContentPreflightResult {
            operation: operation(Uuid::new_v4(), Uuid::new_v4(), actor_id, source_workspace_id, request.target_workspace_id, "reference-preview"),
            preflight: myoxus_application::workspace_content_operation::authorization::WorkspaceContentAuthorizedPreflight {
              legacy_empty_revision: None,
              graph: missing.clone(), membership_impacts: Vec::new(), extract_memberships: Vec::new(),
              extract_target_principal: None, git_sync_plan: None, required_confirmations: Vec::new(), blockers: Vec::new(), revision: missing.revision.clone(),
            },
          }, None,
        ).unwrap();
        assert!(projection.missing_resources.is_empty(), "the consuming API must not tell the user to repair an admitted omission");
        sqlx::query("UPDATE docs SET deleted_at = NULL WHERE id = $1")
          .bind(referenced_id)
          .execute(&pool)
          .await
          .expect("restore typed reference target");

        sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
          .bind(document_id)
          .execute(&pool)
          .await
          .expect("remove authoritative document while retaining its Organizer edge");
        let dangling = graph_source
          .prepare(Uuid::nil(), Uuid::nil(), &request, Vec::new())
          .await
          .expect("prepare dangling Organizer graph");
        let dangling = WorkspaceContentGraphBuilder
          .build(dangling.input)
          .expect("classify an absent Organizer target without an internal graph error");
        assert!(dangling.blockers.is_empty());
        assert!(dangling.missing_resources.is_empty());
        assert_eq!(dangling.resources.len(), 2, "both containing folders survive the omitted placement");
        assert!(dangling.broken_reference_count >= 1);
        let mappings = dangling.mappings.iter().map(|planned| planned.mapping.clone()).collect::<Vec<_>>();
        let before = organizer.snapshot(source_workspace_id).await.unwrap();
        let resolver = PgWorkspaceContentRedirectRepository::new(pool.clone(), doc_service.clone());
        let decisions = myoxus_application::workspace_content_operation::organizer_stage::prepare_organizer_reference_decisions(
          &before, &mappings, |resource| {
            let resolver = &resolver;
            async move { resolver.canonical_reference(&resource).await }
          },
        ).await.expect("canonical Organizer decisions");
        let copy = organizer.project_copy(Uuid::new_v4(), source_workspace_id, request.target_workspace_id, &mappings, &decisions).await.unwrap();
        let moved = organizer.project_move(source_workspace_id, request.target_workspace_id, &mappings, &decisions).await.unwrap();
        for rows in [&copy.rows, &moved.target_rows] {
          assert_eq!(rows.iter().filter(|row| row.is_folder()).count(), 2);
          assert!(!rows.iter().any(|row| row.data == document_key));
          assert!(rows.iter().any(|row| row.row_type == "collection" && row.target_workspace_id == Some(source_workspace_id)));
        }
        assert_eq!(organizer.snapshot(source_workspace_id).await.unwrap(), before, "projections do not repair the source");
      }

      // An offline profile cannot prove that no unbound authored file occupies
      // the selected physical subtree; a complete branch capture can.
      sqlx::query("UPDATE docs SET deleted_at = NULL WHERE id = $1")
        .bind(document_id).execute(&pool).await.unwrap();
      let profile_id = Uuid::new_v4();
      sqlx::query("INSERT INTO git_sync_profiles (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction, trigger_mode, auth_method, enabled)
        VALUES ($1, $2, $3, 'https://git.example.test/team/repo.git', 'main', 'content/', 'Bidirectional', 'Manual', 'HttpsToken', false)")
        .bind(profile_id).bind(source_workspace_id).bind(actor_id).execute(&pool).await.unwrap();
      let binding_id = Uuid::new_v4();
      let bound_path = "content/folder-preflight-root/folder-preflight-nested/doc.md";
      sqlx::query("INSERT INTO git_sync_bindings (id, profile_id, workspace_id, doc_id, sync_id, repo_path)
        VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(binding_id).bind(profile_id).bind(source_workspace_id).bind(document_id)
        .bind(Uuid::new_v4()).bind(bound_path).execute(&pool).await.unwrap();
      let request = WorkspaceContentOperationRequest {
        kind: WorkspaceContentOperationKind::ExtractFolder,
        source_workspace_id,
        target_workspace_id: Uuid::new_v4(),
        selection: WorkspaceContentOperationSelection::FolderSubtree { folder_id: root_folder_id.clone() },
        copy_document_acl: false,
        extract_workspace_name: Some("Git scope preflight".into()),
        git_sync_choice: None,
        link_entry_id: None, link_parent_id: None, link_index: None,
      };
      let offline = graph_source.prepare(actor_id, Uuid::new_v4(), &request, Vec::new()).await.unwrap();
      let offline_plan = offline.authorization_options.git_sync_plan.as_ref().expect("Git profile is present");
      assert_eq!(offline_plan.choice, myoxus_application::workspace_content_operation::WorkspaceContentGitSyncChoice::Move);
      assert!(offline.authorization_options.git_sync_blockers.contains(&WorkspaceContentBlocker::GitSyncOwnershipUnproven));
      let overview_path = format!("{}/README.md", offline_plan.target_root);
      let overview_hash = format!("{:x}", sha2::Sha256::digest(b"generated overview"));
      let body_hash = format!("{:x}", sha2::Sha256::digest(b"bound document"));
      let manifest = GitSyncManifest::new(
        source_workspace_id,
        "recorded".into(),
        vec![GitSyncManifestFolder {
          organizer_id: root_folder_id.clone(), parent_organizer_id: None,
          name: "Folder preflight root".into(), organizer_path: vec![root_folder_id.clone()],
          path: vec!["Folder preflight root".into()],
          overview: Some(GitSyncManifestOverview { repo_path: overview_path.clone(), content_hash: overview_hash.clone() }),
        }],
        vec![GitSyncManifestDocument {
          doc_id: document_id, organizer_entry_id: None,
          organizer_folder_ids: vec![root_folder_id.clone()], repo_path: bound_path.into(),
          title: "".into(), content_hash: body_hash.clone(),
        }],
      );
      let captured = WorkspaceContentGitSyncCapture {
        remote_verified: true,
        head_oid: "1234567890abcdef".into(), manifest,
        observed_paths: BTreeSet::from([overview_path.clone(), bound_path.into()]),
        path_hashes: [(overview_path, overview_hash), (bound_path.into(), body_hash)]
          .into_iter().collect(),
        document_body_hashes: [(bound_path.into(), format!("{:x}", Sha256::digest(b"bound document")))].into_iter().collect(),
      };
      let git_source = PgWorkspaceContentGraphSource::new(pool.clone(), doc_service.clone())
        .with_git_capture(Arc::new(ExtractBranchFixture(captured.clone())));
      let prepared = git_source.prepare(actor_id, Uuid::new_v4(), &request, Vec::new()).await.unwrap();
      assert!(prepared.authorization_options.git_sync_blockers.is_empty(), "remote inventory must prove the nested subtree");
      assert_eq!(prepared.authorization_options.git_sync_plan.as_ref().unwrap().documents.len(), 1);
      let mut unowned_capture = captured.clone();
      unowned_capture.observed_paths.insert(format!("{}/unbound.md", offline_plan.target_root));
      let unowned_source = PgWorkspaceContentGraphSource::new(pool.clone(), doc_service.clone())
        .with_git_capture(Arc::new(ExtractBranchFixture(unowned_capture)));
      let unowned = unowned_source.prepare(actor_id, Uuid::new_v4(), &request, Vec::new()).await.unwrap();
      assert!(unowned.authorization_options.git_sync_blockers.contains(&WorkspaceContentBlocker::GitSyncOwnershipUnproven),
        "an authored file absent from both bindings and generated manifest outputs cannot cross ownership boundaries");
      let mut changed_body = captured.clone();
      changed_body.document_body_hashes.insert(bound_path.into(), format!("{:x}", Sha256::digest(b"changed document")));
      let changed_source = PgWorkspaceContentGraphSource::new(pool.clone(), doc_service.clone())
        .with_git_capture(Arc::new(ExtractBranchFixture(changed_body)));
      let changed = changed_source.prepare(actor_id, Uuid::new_v4(), &request, Vec::new()).await.unwrap();
      assert!(changed.authorization_options.git_sync_blockers.contains(&WorkspaceContentBlocker::GitSyncOwnershipUnproven),
        "a remotely edited body invalidates the last manifest ownership evidence");
      sqlx::query("UPDATE git_sync_bindings SET repo_path = 'content/outside.md' WHERE id = $1")
        .bind(binding_id).execute(&pool).await.unwrap();
      let escaped = git_source.prepare(actor_id, Uuid::new_v4(), &request, Vec::new()).await.unwrap();
      assert!(escaped.authorization_options.git_sync_blockers.contains(&WorkspaceContentBlocker::GitSyncScopeAmbiguous),
        "a bound selected document outside the physical subtree must block before publication");
      sqlx::query("UPDATE git_sync_bindings SET repo_path = $2 WHERE id = $1")
        .bind(binding_id).bind(bound_path).execute(&pool).await.unwrap();
      let empty_folder_id = Uuid::new_v4().to_string();
      organizer.create_folder(source_workspace_id, CreateOrganizerFolder {
        id: empty_folder_id.clone(), parent_id: Some(root_folder_id.clone()),
        name: "Empty".into(), index: Some("a9".into()),
      }).await.unwrap();
      let empty_overview = format!("{}/empty/README.md", offline_plan.target_root);
      let mut empty_capture = captured;
      empty_capture.manifest.folders.push(GitSyncManifestFolder {
        organizer_id: empty_folder_id.clone(), parent_organizer_id: Some(root_folder_id.clone()),
        name: "Empty".into(), organizer_path: vec![root_folder_id, empty_folder_id.clone()],
        path: vec!["Folder preflight root".into(), "Empty".into()],
        overview: Some(GitSyncManifestOverview { repo_path: empty_overview.clone(), content_hash: format!("{:x}", Sha256::digest(b"empty overview")) }),
      });
      empty_capture.observed_paths.insert(empty_overview.clone());
      empty_capture.path_hashes.insert(empty_overview, format!("{:x}", Sha256::digest(b"empty overview")));
      let empty_source = PgWorkspaceContentGraphSource::new(pool.clone(), doc_service.clone())
        .with_git_capture(Arc::new(ExtractBranchFixture(empty_capture)));
      let empty_request = WorkspaceContentOperationRequest {
        selection: WorkspaceContentOperationSelection::FolderSubtree { folder_id: empty_folder_id },
        target_workspace_id: Uuid::new_v4(), ..request
      };
      let empty = empty_source.prepare(actor_id, Uuid::new_v4(), &empty_request, Vec::new()).await.unwrap();
      assert!(empty.authorization_options.git_sync_blockers.is_empty(), "a manifest-owned empty folder has physical proof: {:?} root={:?} docs={:?}", empty.authorization_options.git_sync_blockers, empty.authorization_options.git_sync_plan.as_ref().map(|plan| &plan.target_root), empty.authorization_options.git_sync_plan.as_ref().map(|plan| &plan.documents));
      assert!(empty.authorization_options.git_sync_plan.as_ref().unwrap().documents.is_empty());
      let other_profile = Uuid::new_v4();
      sqlx::query("INSERT INTO git_sync_profiles (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction, trigger_mode, auth_method, enabled)
        VALUES ($1, $2, $3, 'https://git.example.test/team/other.git', 'main', 'content/', 'Bidirectional', 'Manual', 'HttpsToken', false)")
        .bind(other_profile).bind(source_workspace_id).bind(actor_id).execute(&pool).await.unwrap();
      let ambiguous = empty_source.prepare(actor_id, Uuid::new_v4(), &empty_request, Vec::new()).await.unwrap();
      assert_eq!(ambiguous.authorization_options.git_sync_blockers, vec![WorkspaceContentBlocker::GitSyncScopeAmbiguous]);
      assert!(ambiguous.authorization_options.git_sync_plan.is_none(), "multiple profiles never choose a winner");

      }).catch_unwind().await;
      helpers::cleanup_workspaces(&pool, &[source_workspace_id, move_target_workspace_id]).await;
      helpers::cleanup_users(&pool, &[actor_id]).await;
      if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
      }
    },
  );
}

fn operation(
  id: Uuid,
  idempotency_id: Uuid,
  actor_id: Uuid,
  source_workspace_id: Uuid,
  target_workspace_id: Uuid,
  manifest_hash: &str,
) -> WorkspaceContentOperationRecord {
  let now = Utc::now();
  WorkspaceContentOperationRecord {
    id,
    idempotency_id,
    actor_id,
    kind: WorkspaceContentOperationKind::Copy,
    source_workspace_id,
    target_workspace_id: Some(target_workspace_id),
    status: WorkspaceContentOperationStatus::Draft,
    preview_revision: None,
    manifest_hash: manifest_hash.to_string(),
    error: None,
    diagnostic_instance_id: None,
    created_at: now,
    updated_at: now,
  }
}

/// Persist the API-owned request state required by publication repositories.
///
/// Publication tests call the repository boundary directly, so they must
/// provide the same request that the control service stores before preview.
/// The membership snapshot is persisted separately after the operation enters
/// `Previewed`, matching the repository state machine.
async fn store_operation_request(
  repository: &PgWorkspaceContentOperationRepository,
  operation: &WorkspaceContentOperationRecord,
  mappings: &[WorkspaceContentIdMapping],
  origin_operation_id: Option<Uuid>,
) {
  let target_workspace_id = operation
    .target_workspace_id
    .expect("Copy and Move fixtures require a target workspace");
  repository
    .store_request(
      operation.id,
      &WorkspaceContentOperationRequest {
        kind: operation.kind,
        source_workspace_id: operation.source_workspace_id,
        target_workspace_id,
        selection: WorkspaceContentOperationSelection::Resources {
          resources: mappings
            .iter()
            .filter(|mapping| {
              origin_operation_id.is_none() || mapping.source.kind() != WorkspaceContentResourceKind::Tag
            })
            .map(|mapping| mapping.source.clone())
            .collect(),
        },
        copy_document_acl: false,
        extract_workspace_name: None,
        git_sync_choice: None,
        link_entry_id: None,
        link_parent_id: None,
        link_index: None,
      },
      origin_operation_id,
    )
    .await
    .expect("store workspace content execution request");
}

fn recipient_intent(
  operation: &WorkspaceContentOperationRecord,
  snapshot: &myoxus_application::workspace_content_operation::move_publication::WorkspaceContentRecipientSnapshot,
  recipient_id: Uuid,
  resource_count: i32,
  visible_resource_kinds: Vec<WorkspaceContentResourceKind>,
) -> WorkspaceContentRecipientIntent {
  WorkspaceContentRecipientIntent {
    operation_id: operation.id,
    recipient_id,
    event_kind: "workspace_content_moved".to_string(),
    source_workspace_id: operation.source_workspace_id,
    source_workspace_name: snapshot.source_workspace_name.clone(),
    actor_id: operation.actor_id,
    resource_count,
    visible_resource_kinds,
    recipient_snapshot_revision: snapshot.revision.clone(),
  }
}

struct NoReuseReconcileSource;

#[async_trait]
impl WorkspaceContentReconcileSourcePort for NoReuseReconcileSource {
  async fn load(
    &self,
    _actor_id: Uuid,
    _resource: &WorkspaceContentResourceRef,
  ) -> Result<Option<WorkspaceContentDefinition>, AuthError> {
    panic!("Document-only Copy publication must not read reconcile resources")
  }

  async fn catalog(
    &self,
    _actor_id: Uuid,
    _workspace_id: Uuid,
    _kind: WorkspaceContentResourceKind,
  ) -> Result<Vec<WorkspaceContentDefinition>, AuthError> {
    panic!("Document-only Copy publication must not read reconcile catalogs")
  }
}

#[derive(Default)]
struct RecordingCopyPublisher {
  batches: Mutex<Vec<WorkspaceContentCopyPublicationBatch>>,
}

#[async_trait]
impl WorkspaceContentCopyPublicationPort for RecordingCopyPublisher {
  async fn publish_copy(
    &self,
    mut batch: WorkspaceContentCopyPublicationBatch,
    _diagnostic_instance_id: &str,
  ) -> myoxus_application::workspace_content_operation::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord>
  {
    batch.operation.status = WorkspaceContentOperationStatus::Succeeded;
    let result = batch.operation.clone();
    self.batches.lock().expect("recording publisher lock").push(batch);
    Ok(result)
  }
}

struct RecordingQueue {
  fail: bool,
  wakes: Mutex<Vec<Uuid>>,
}

#[async_trait]
impl WorkspaceContentQueuePort for RecordingQueue {
  async fn wake(&self, operation_id: Uuid) -> WorkspaceContentCoordinationResult<()> {
    self.wakes.lock().expect("recording queue lock").push(operation_id);
    if self.fail {
      Err(WorkspaceContentCoordinationError::unavailable("queue"))
    } else {
      Ok(())
    }
  }
  async fn wake_git(&self, operation_id: Uuid) -> WorkspaceContentCoordinationResult<()> {
    self.wake(operation_id).await
  }
}

// Pending-window fixtures contain only transient identifiers and sequence facts.
async fn seed_pending_document_change(pool: &sqlx::PgPool, workspace: Uuid, doc: Uuid, actor: Uuid) -> Uuid {
  let batch = Uuid::new_v4();
  sqlx::query("INSERT INTO document_change_batches(id,doc_id,workspace_id,started_at,last_changed_at,due_at,first_sequence,last_sequence) VALUES($1,$2,$3,now(),now(),now()+interval '10 minutes',1,1)")
    .bind(batch).bind(doc).bind(workspace).execute(pool).await.expect("seed pending change window");
  sqlx::query(
    "INSERT INTO document_change_batch_actors(batch_id,user_id,first_sequence,last_sequence) VALUES($1,$2,1,1)",
  )
  .bind(batch)
  .bind(actor)
  .execute(pool)
  .await
  .expect("seed pending actor");
  batch
}

/// Fixture setup uses the same revision-checked row writer as the product.
async fn configure_overview(
  pool: &sqlx::PgPool,
  workspace_id: Uuid,
  mut patch: WorkspaceOverviewSettingsPatch,
) -> myoxus_domain::entities::Workspace {
  let store = SqlxWorkspaceStore::new(pool.clone(), crate::helpers::database_starter_catalog());
  let current = store.get_workspace(workspace_id).await.unwrap().unwrap();
  patch.expected_revision = current.overview_revision;
  store
    .update_workspace(
      workspace_id,
      UpdateWorkspace {
        overview: Some(patch),
        ..Default::default()
      },
    )
    .await
    .expect("configure overview through its current native writer")
}

fn overview_columns(key: &str) -> OverviewRegisterPresentation {
  OverviewRegisterPresentation {
    display_properties: vec!["system:title".into(), format!("system:{key}")],
    order_by: OverviewOrderBy {
      property_type: "system".into(),
      key: key.into(),
      desc: false,
    },
  }
}

async fn prepared_move_batch(
  pool: &sqlx::PgPool,
  repository: &PgWorkspaceContentOperationRepository,
  actor_id: Uuid,
  source_workspace_id: Uuid,
  target_workspace_id: Uuid,
  mut mappings: Vec<WorkspaceContentIdMapping>,
  origin_operation_id: Option<Uuid>,
) -> WorkspaceContentMovePublicationBatch {
  let mut record = operation(
    Uuid::new_v4(),
    Uuid::new_v4(),
    actor_id,
    source_workspace_id,
    target_workspace_id,
    &hex::encode(Sha256::digest(Uuid::new_v4().as_bytes())),
  );
  record.kind = WorkspaceContentOperationKind::Move;
  if mappings
    .iter()
    .any(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Folder)
  {
    // Authorization hash checks have their own native authorizer coverage;
    // this fixture enters at the trusted, already-accepted SQL boundary.
    let store = SqlxWorkspaceStore::new(pool.clone(), crate::helpers::database_starter_catalog());
    let source = store.get_workspace(source_workspace_id).await.unwrap().unwrap();
    let target = store.get_workspace(target_workspace_id).await.unwrap().unwrap();
    record.preview_revision = Some(
      WorkspaceContentOverviewSnapshot {
        source: WorkspaceContentOverviewState {
          workspace_id: source_workspace_id,
          revision: source.overview_revision,
          settings: source.overview_settings,
        },
        target: Some(WorkspaceContentOverviewState {
          workspace_id: target_workspace_id,
          revision: target.overview_revision,
          settings: target.overview_settings,
        }),
        extracted_folder_id: None,
      }
      .accepted_revision(&"a".repeat(64)),
    );
  }
  for mapping in &mut mappings {
    if mapping.source.kind() == WorkspaceContentResourceKind::Blob {
      let key = Uuid::new_v5(
        &record.id,
        format!(
          "{}:{}:blob:{}:1",
          source_workspace_id,
          target_workspace_id,
          mapping.source.resource_id()
        )
        .as_bytes(),
      );
      mapping.target = resource(target_workspace_id, WorkspaceContentResourceKind::Blob, key.to_string());
    }
  }
  repository.create_or_get(record.clone()).await.expect("create Move");
  store_operation_request(repository, &record, &mappings, origin_operation_id).await;
  repository
    .store_manifest(record.id, &record.manifest_hash, &mappings, &[])
    .await
    .expect("store Move manifest");
  for (from, to, diagnostic_instance_id) in [
    (
      WorkspaceContentOperationStatus::Draft,
      WorkspaceContentOperationStatus::Previewed,
      None,
    ),
    (
      WorkspaceContentOperationStatus::Previewed,
      WorkspaceContentOperationStatus::Queued,
      None,
    ),
    (
      WorkspaceContentOperationStatus::Queued,
      WorkspaceContentOperationStatus::Running,
      Some("move-snapshot-test"),
    ),
  ] {
    record = repository
      .transition(record.id, from, to, None, diagnostic_instance_id)
      .await
      .expect("advance Move snapshot operation");
    if to == WorkspaceContentOperationStatus::Previewed {
      repository
        .store_execution_memberships(record.id, &[])
        .await
        .expect("store empty Move membership plan");
    }
  }
  let recipients = repository
    .recipient_snapshot(source_workspace_id, actor_id)
    .await
    .expect("capture Move recipient snapshot");
  let resource_kinds = mappings
    .iter()
    .map(|mapping| mapping.source.kind())
    .collect::<BTreeSet<_>>()
    .into_iter()
    .collect::<Vec<_>>();
  let recipient_intents = recipients
    .recipient_ids
    .iter()
    .copied()
    .map(|recipient_id| {
      recipient_intent(
        &record,
        &recipients,
        recipient_id,
        mappings.len() as i32,
        resource_kinds.clone(),
      )
    })
    .collect();
  let revision_manifest = repository
    .prepare_move_revision_manifest(&record, &mappings)
    .await
    .expect("prepare complete Move revision manifest");
  WorkspaceContentMovePublicationBatch {
    operation: record,
    mappings,
    revision_manifest,
    organizer: None,
    recipient_intents,
    extract_source_folder_id: None,
    staging_entries: Vec::new(),
  }
}

fn membership_graph(source_workspace_id: Uuid, target_workspace_id: Uuid) -> WorkspaceContentPreflightGraph {
  let resource = resource(
    source_workspace_id,
    WorkspaceContentResourceKind::Document,
    "membership-impact-doc",
  );
  WorkspaceContentGraphBuilder
    .build(WorkspaceContentGraphInput {
      operation_id: Uuid::nil(),
      kind: WorkspaceContentOperationKind::Move,
      source_workspace_id,
      target_workspace_id,
      selection: WorkspaceContentSelection::Resources(vec![resource.clone()]),
      resources: vec![WorkspaceContentGraphResource {
        database_system_role: None,
        resource,
        permission_resource_id: Some(Uuid::new_v4()),
        revision: "membership-impact-content".to_string(),
        display_name: None,
        schema_revision: None,
        persistence_relations: vec!["docs".to_string()],
        publicly_shared: false,
        tag_archived: false,
      }],
      references: Vec::new(),
      target_definitions: Vec::new(),
      target_resource_ids: Vec::new(),
      mapping_overrides: Vec::new(),
    })
    .expect("valid membership impact graph")
}

fn is_invalid_input(result: Result<impl Sized, AuthError>) -> bool {
  matches!(result, Err(AuthError::InvalidInput(_)))
}

async fn assert_dependency_manifest_matches_schema(pool: &sqlx::PgPool) {
  let schema_relations = sqlx::query_scalar::<_, String>(
    r#"
    WITH RECURSIVE seeds(table_oid, table_name) AS (
      SELECT c.oid, c.relname::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (
          'workspaces',
          'docs',
          'workspace_databases',
          'blobs',
          'notifications',
          'admin_audit_log'
        )
      UNION
      SELECT c.oid, c.relname::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_schema = n.nspname
       AND col.table_name = c.relname
      WHERE n.nspname = 'public'
        AND (
          col.column_name IN (
            'workspace_id',
            'doc_id',
            'database_id',
            'blob_id',
            'blob_key'
          )
          OR col.column_name LIKE '%\_workspace\_id' ESCAPE '\'
          OR col.column_name LIKE '%\_doc\_id' ESCAPE '\'
          OR col.column_name LIKE '%\_database\_id' ESCAPE '\'
          OR col.column_name LIKE '%\_blob\_id' ESCAPE '\'
          OR col.column_name LIKE '%\_blob\_key' ESCAPE '\'
        )
    ),
    owned(table_oid, table_name) AS (
      SELECT table_oid, table_name FROM seeds
      UNION
      SELECT child.oid, child.relname::text
      FROM owned parent
      JOIN pg_constraint fk
        ON fk.contype = 'f'
       AND fk.confrelid = parent.table_oid
      JOIN pg_class child ON child.oid = fk.conrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE n.nspname = 'public'
    )
    SELECT table_name
    FROM owned
    ORDER BY table_name
    "#,
  )
  .fetch_all(pool)
  .await
  .expect("derive live workspace content ownership graph");
  let schema_relations = schema_relations.into_iter().collect::<BTreeSet<_>>();
  let manifest_relations = workspace_content_dependency_manifest()
    .expect("dependency manifest is disjoint")
    .keys()
    .map(|relation| (*relation).to_string())
    .collect::<BTreeSet<_>>();
  assert_eq!(
    manifest_relations, schema_relations,
    "every live workspace/document/Database/blob relation must have exactly one explicit dependency class"
  );
}

// Global outbox claims must not consume another fixture's pending intents or
// leases. SQLx owns the database; reconnect inside the existing large-stack runtime.
#[sqlx::test(migrations = false)]
async fn durable_workspace_content_state_is_atomic_bounded_and_idempotent(pool: sqlx::PgPool) {
  let options = pool.connect_options();
  pool.close().await;
  helpers::block_on_large_stack(
    "durable_workspace_content_state_is_atomic_bounded_and_idempotent",
    move || async move {
      let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect_with((*options).clone())
        .await
        .expect("connect owned outbox test database");
      myoxus_infrastructure::tls::initialize_crypto_provider();
      myoxus_infrastructure::migrations::run(&pool).await.expect("migrations");
      let (_app, pool, auth) = helpers::setup_app_with_pool(pool).await;
      assert_dependency_manifest_matches_schema(&pool).await;
      let xws_product_trigger_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_trigger
         WHERE NOT tgisinternal AND tgname LIKE 'xws_guard_%'",
      )
      .fetch_one(&pool)
      .await
      .expect("inspect migrated trigger catalog");
      assert_eq!(
        xws_product_trigger_count, 0,
        "workspace-content operations must not add feature-specific triggers to product writes"
      );
      let lease_table_exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public.workspace_content_operation_leases') IS NOT NULL")
          .fetch_one(&pool)
          .await
          .expect("inspect migrated relation catalog");
      assert!(
        !lease_table_exists,
        "workspace-content operations must not retain a feature-local resource lease table"
      );
      let (actor_id, _session) = helpers::seed_user(&pool, &auth, "xws_state_actor").await;
      let (recipient_id, _session) = helpers::seed_user(&pool, &auth, "xws_state_recipient").await;
      let (inactive_id, _session) = helpers::seed_user(&pool, &auth, "xws_state_inactive").await;
      let source_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      let target_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      let repository = Arc::new(PgWorkspaceContentOperationRepository::new(
        pool.clone(),
        crate::helpers::database_starter_catalog(),
      ));
      sqlx::query(
        r#"
        INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
        VALUES
          ($1, $3, 'Admin', 'Accepted'),
          ($1, $4, 'Manager', 'Pending'),
          ($2, $3, 'Reader', 'Pending')
        "#,
      )
      .bind(source_workspace_id)
      .bind(target_workspace_id)
      .bind(recipient_id)
      .bind(inactive_id)
      .execute(&pool)
      .await
      .expect("seed membership impact states");
      let graph = membership_graph(source_workspace_id, target_workspace_id);
      let authorizer = WorkspaceContentAuthorizer::new(
        Arc::new(PermissionService::new(auth.clone())),
        PgWorkspaceContentAuthorizationSource::new(pool.clone()),
      );
      let preview = authorizer
        .preflight(actor_id, graph.clone(), WorkspaceContentAuthorizationOptions::default())
        .await
        .expect("authorize without a source-member enrollment plan");
      assert!(preview.blockers.is_empty());
      assert!(preview.membership_impacts.is_empty());
      assert!(preview.required_confirmations.is_empty());
      sqlx::query(
        r#"
        UPDATE workspace_memberships
        SET status = CASE WHEN user_id = $3 THEN 'Accepted' ELSE 'Revoked' END
        WHERE workspace_id IN ($1, $2)
          AND user_id IN ($3, $4)
        "#,
      )
      .bind(source_workspace_id)
      .bind(target_workspace_id)
      .bind(recipient_id)
      .bind(inactive_id)
      .execute(&pool)
      .await
      .expect("accept target and revoke inactive source");
      let refreshed = authorizer
        .preflight(actor_id, graph, WorkspaceContentAuthorizationOptions::default())
        .await
        .expect("membership changes do not become transfer prerequisites");
      assert!(refreshed.membership_impacts.is_empty());
      assert_eq!(refreshed.revision, preview.revision);
      let manifest_hash = "a".repeat(64);
      let mut record = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &manifest_hash,
      );
      record.preview_revision = Some("api-preflight-revision".to_string());

      // Exercise both deployed SQL allowlists and repository readback, not
      // only enum serialization. The SQLx fixture owns all temporary rows.
      let mut diagnostic = record.clone();
      diagnostic.id = Uuid::new_v4();
      diagnostic.idempotency_id = Uuid::new_v4();
      repository
        .create_or_get(diagnostic.clone())
        .await
        .expect("diagnostic operation");
      for (before, after) in [
        (
          WorkspaceContentOperationStatus::Draft,
          WorkspaceContentOperationStatus::Previewed,
        ),
        (
          WorkspaceContentOperationStatus::Previewed,
          WorkspaceContentOperationStatus::Queued,
        ),
        (
          WorkspaceContentOperationStatus::Queued,
          WorkspaceContentOperationStatus::Running,
        ),
      ] {
        repository
          .transition(diagnostic.id, before, after, None, Some("cause-contract"))
          .await
          .unwrap();
      }
      repository
        .append_compensation(WorkspaceContentCompensationIntent {
          operation_id: diagnostic.id,
          sequence: 0,
          kind: "delete_operation_blob".into(),
          target: resource(
            target_workspace_id,
            WorkspaceContentResourceKind::Blob,
            "diagnostic-owned-blob",
          ),
        })
        .await
        .unwrap();
      for code in [
        WorkspaceContentErrorCode::MoveContentRevisionChanged,
        WorkspaceContentErrorCode::MoveWorkspaceRootChanged,
        WorkspaceContentErrorCode::MoveRecipientSnapshotChanged,
        WorkspaceContentErrorCode::MoveRelatedRowsChanged,
        WorkspaceContentErrorCode::PublicationSerializationConflict,
        WorkspaceContentErrorCode::PublicationDeadlock,
        WorkspaceContentErrorCode::ExtractRecoveryStateChanged,
        WorkspaceContentErrorCode::OperationStateInvalid,
      ] {
        let failure = RedactedWorkspaceContentError::new(code, code.safe_message().unwrap())
          .unwrap()
          .with_phase("publication");
        repository
          .transition(
            diagnostic.id,
            WorkspaceContentOperationStatus::Running,
            WorkspaceContentOperationStatus::Running,
            Some(failure.clone()),
            Some("cause-contract"),
          )
          .await
          .unwrap();
        assert_eq!(
          repository.get(diagnostic.id).await.unwrap().unwrap().error,
          Some(failure)
        );
        sqlx::query("UPDATE workspace_content_operation_compensations SET last_error_code=$2, last_error_message=$3 WHERE operation_id=$1")
          .bind(diagnostic.id).bind(code.as_str()).bind(code.safe_message().unwrap()).execute(&pool).await.expect("precise compensation cause persists");
        let stored: String = sqlx::query_scalar(
          "SELECT last_error_code FROM workspace_content_operation_compensations WHERE operation_id=$1",
        )
        .bind(diagnostic.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored, code.as_str());
      }
      sqlx::query("DELETE FROM workspace_content_operations WHERE id=$1")
        .bind(diagnostic.id)
        .execute(&pool)
        .await
        .expect("remove diagnostic fixture before outbox assertions");

      let (first, second) = tokio::join!(
        repository.create_or_get(record.clone()),
        repository.create_or_get(record.clone())
      );
      let first = first.expect("first idempotent create");
      let second = second.expect("concurrent idempotent replay");
      assert_ne!(
        first.created, second.created,
        "exactly one concurrent caller must insert"
      );
      assert_eq!(first.record.id, second.record.id);

      let mut changed_replay = record.clone();
      changed_replay.kind = WorkspaceContentOperationKind::Move;
      assert!(
        is_invalid_input(repository.create_or_get(changed_replay).await),
        "an idempotency id must not accept changed immutable input"
      );

      let source_doc = resource(
        source_workspace_id,
        WorkspaceContentResourceKind::Document,
        "source-doc",
      );
      let operation_request = WorkspaceContentOperationRequest {
        kind: WorkspaceContentOperationKind::Copy,
        source_workspace_id,
        target_workspace_id,
        selection: WorkspaceContentOperationSelection::Resources {
          resources: vec![source_doc.clone()],
        },
        copy_document_acl: false,
        extract_workspace_name: None,
        git_sync_choice: None,
        link_entry_id: None,
        link_parent_id: None,
        link_index: None,
      };
      repository
        .store_request(record.id, &operation_request, None)
        .await
        .expect("persist exact API request");
      repository
        .store_request(record.id, &operation_request, None)
        .await
        .expect("exact API request replay");
      assert!(
        is_invalid_input(
          repository
            .store_request(
              record.id,
              &WorkspaceContentOperationRequest {
                copy_document_acl: true,
                ..operation_request.clone()
              },
              None,
            )
            .await
        ),
        "the persisted request must reject an idempotency replay with changed options"
      );
      let target_doc = resource(
        target_workspace_id,
        WorkspaceContentResourceKind::Document,
        "target-doc",
      );
      let mapping = WorkspaceContentIdMapping::new(source_doc.clone(), target_doc.clone()).expect("same-kind mapping");
      let reversed_mapping =
        WorkspaceContentIdMapping::new(target_doc.clone(), source_doc.clone()).expect("same-kind mapping");
      assert!(
        matches!(repository.store_manifest(record.id, &manifest_hash, &[reversed_mapping], &[]).await,
          Err(AuthError::InvalidInput(code)) if code == WorkspaceContentErrorCode::MappingPlanInvalid.as_str()),
        "manifest resources must stay inside their declared source/target boundary"
      );
      let staging = WorkspaceContentStagingEntry::new(
        record.id,
        0,
        target_doc.clone(),
        format!("workspace-content/{}/document", record.id),
        "b".repeat(64),
        4096,
      )
      .expect("bounded staging entry");
      repository
        .store_manifest(
          record.id,
          &manifest_hash,
          std::slice::from_ref(&mapping),
          std::slice::from_ref(&staging),
        )
        .await
        .expect("store complete manifest");
      repository
        .store_manifest(
          record.id,
          &manifest_hash,
          std::slice::from_ref(&mapping),
          std::slice::from_ref(&staging),
        )
        .await
        .expect("exact manifest replay");
      assert_eq!(repository.list_mappings(record.id).await.unwrap(), vec![mapping]);
      assert_eq!(
        repository.list_staging_entries(record.id).await.unwrap(),
        vec![staging.clone()]
      );

      let changed_staging = WorkspaceContentStagingEntry::new(
        record.id,
        0,
        target_doc.clone(),
        staging.object_key(),
        "c".repeat(64),
        staging.size_bytes,
      )
      .expect("changed but structurally valid staging entry");
      assert!(
        matches!(repository.store_manifest(record.id, &manifest_hash, &[], &[changed_staging]).await,
          Err(AuthError::InvalidInput(code)) if code == WorkspaceContentErrorCode::StagingReplayConflict.as_str()),
        "divergent or incomplete manifest replay must fail atomically"
      );
      assert_eq!(
        repository.list_staging_entries(record.id).await.unwrap(),
        vec![staging.clone()]
      );

      let previewed = repository
        .transition(
          record.id,
          WorkspaceContentOperationStatus::Draft,
          WorkspaceContentOperationStatus::Previewed,
          None,
          Some("api-node-redacted"),
        )
        .await
        .expect("legal compare-and-transition");
      assert_eq!(previewed.status, WorkspaceContentOperationStatus::Previewed);
      assert!(
        is_invalid_input(
          repository
            .transition(
              record.id,
              WorkspaceContentOperationStatus::Draft,
              WorkspaceContentOperationStatus::Queued,
              None,
              None,
            )
            .await
        ),
        "stale expected state must not transition"
      );
      assert!(
        is_invalid_input(
          repository
            .transition(
              record.id,
              WorkspaceContentOperationStatus::Previewed,
              WorkspaceContentOperationStatus::Succeeded,
              None,
              None,
            )
            .await
        ),
        "illegal state edge must not transition"
      );
      assert!(
        repository
          .queue_previewed(&WorkspaceContentExecuteRequest {
            operation_id: record.id,
            actor_id: recipient_id,
            revision: "api-preflight-revision".to_string(),
            confirmations: Vec::new(),
          })
          .await
          .is_err(),
        "a different actor must not queue another actor's operation"
      );
      assert!(
        repository
          .queue_previewed(&WorkspaceContentExecuteRequest {
            operation_id: record.id,
            actor_id,
            revision: "stale-revision".to_string(),
            confirmations: Vec::new(),
          })
          .await
          .is_err(),
        "a stale execute revision must not mutate the operation"
      );
      repository
        .store_execution_memberships(
          record.id,
          &[WorkspaceContentExecutionMembership {
            user_id: recipient_id,
            role: WorkspaceRole::Admin,
          }],
        )
        .await
        .expect("persist exact execution membership plan");
      let queued_record = repository
        .queue_previewed(&WorkspaceContentExecuteRequest {
          operation_id: record.id,
          actor_id,
          revision: "api-preflight-revision".to_string(),
          confirmations: Vec::new(),
        })
        .await
        .expect("queue actor-bound current preflight");
      assert_eq!(queued_record.status, WorkspaceContentOperationStatus::Queued);
      repository
        .transition(
          record.id,
          WorkspaceContentOperationStatus::Queued,
          WorkspaceContentOperationStatus::Running,
          None,
          Some("worker-node-redacted"),
        )
        .await
        .expect("claim operation");

      let transient = RedactedWorkspaceContentError::new(
        WorkspaceContentErrorCode::StorageUnavailable,
        "Operation storage is temporarily unavailable.",
      )
      .unwrap()
      .with_phase("blob_materialization");
      repository
        .transition(
          record.id,
          WorkspaceContentOperationStatus::Running,
          WorkspaceContentOperationStatus::Running,
          Some(transient.clone()),
          Some("retry-worker"),
        )
        .await
        .expect("persist actual retry failure");
      assert_eq!(repository.get(record.id).await.unwrap().unwrap().error, Some(transient));
      let latest = RedactedWorkspaceContentError::new(
        WorkspaceContentErrorCode::DatabaseUnavailable,
        "The operation repository is temporarily unavailable.",
      )
      .unwrap()
      .with_phase("publication");
      repository
        .transition(
          record.id,
          WorkspaceContentOperationStatus::Running,
          WorkspaceContentOperationStatus::Running,
          Some(latest.clone()),
          Some("retry-worker"),
        )
        .await
        .expect("replace prior retry with latest actual cause");
      assert_eq!(repository.get(record.id).await.unwrap().unwrap().error, Some(latest));

      let source_blob = resource(source_workspace_id, WorkspaceContentResourceKind::Blob, "source-blob");
      let target_blob = resource(target_workspace_id, WorkspaceContentResourceKind::Blob, "target-blob");
      let doc_mapping =
        WorkspaceContentIdMapping::new(source_doc.clone(), target_doc.clone()).expect("same-kind document mapping");
      let blob_mapping =
        WorkspaceContentIdMapping::new(source_blob, target_blob.clone()).expect("same-kind blob mapping");
      let blob_staging = WorkspaceContentStagingEntry::new(
        record.id,
        1,
        target_blob,
        format!("workspace-content/{}/blob", record.id),
        "d".repeat(64),
        8192,
      )
      .expect("bounded blob staging entry");
      repository
        .store_manifest(
          record.id,
          &manifest_hash,
          &[doc_mapping, blob_mapping],
          &[staging.clone(), blob_staging.clone()],
        )
        .await
        .expect("running Copy may extend the complete operation-owned manifest");
      assert_eq!(
        repository.list_staging_entries(record.id).await.unwrap(),
        vec![staging, blob_staging],
        "running staging remains cumulative and sequence ordered"
      );

      let redirect = WorkspaceContentRedirect {
        operation_id: record.id,
        source: source_doc.clone(),
        target: target_doc.clone(),
      };
      assert!(
        is_invalid_input(
          repository
            .insert_redirect(WorkspaceContentRedirect {
              operation_id: record.id,
              source: target_doc.clone(),
              target: source_doc.clone(),
            })
            .await
        ),
        "redirect direction must match the operation boundary"
      );
      assert!(repository.insert_redirect(redirect.clone()).await.unwrap());
      assert!(!repository.insert_redirect(redirect.clone()).await.unwrap());
      let conflicting_redirect = WorkspaceContentRedirect {
        target: resource(
          target_workspace_id,
          WorkspaceContentResourceKind::Document,
          "other-target",
        ),
        ..redirect
      };
      assert!(
        is_invalid_input(repository.insert_redirect(conflicting_redirect).await),
        "one source identity must not redirect to two targets"
      );

      let ordinary_doc_id = Uuid::new_v4();
      let ordinary_database_id = Uuid::new_v4();
      sqlx::query(
        "INSERT INTO docs (id, workspace_id, external_id, created_by) VALUES ($1, $2, 'ordinary-source-doc', $3)",
      )
      .bind(ordinary_doc_id)
      .bind(source_workspace_id)
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect("seed ordinary document");
      sqlx::query(
        "INSERT INTO workspace_databases (id, workspace_id, title, created_by) VALUES ($1, $2, 'Ordinary database', $3)",
      )
      .bind(ordinary_database_id)
      .bind(source_workspace_id)
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect("seed ordinary Database");
      sqlx::query("UPDATE docs SET title = 'unblocked' WHERE id = $1")
        .bind(ordinary_doc_id)
        .execute(&pool)
        .await
        .expect("normal document writes remain independent of XWS operations");
      sqlx::query("UPDATE workspace_databases SET title = 'Unblocked' WHERE id = $1")
        .bind(ordinary_database_id)
        .execute(&pool)
        .await
        .expect("normal Database writes remain independent of XWS operations");

      let recipient_snapshot = repository
        .recipient_snapshot(source_workspace_id, actor_id)
        .await
        .expect("snapshot recipient metadata");
      let recipient = recipient_intent(
        &record,
        &recipient_snapshot,
        recipient_id,
        1,
        vec![WorkspaceContentResourceKind::Document],
      );
      assert!(repository.enqueue_recipient(recipient.clone()).await.unwrap());
      assert!(!repository.enqueue_recipient(recipient.clone()).await.unwrap());
      assert!(
        is_invalid_input(
          repository
            .enqueue_recipient(WorkspaceContentRecipientIntent {
              resource_count: 2,
              ..recipient
            })
            .await
        ),
        "outbox replay must preserve the original recipient snapshot"
      );
      let claimed = repository.claim(10).await.expect("claim notification intent");
      assert_eq!(claimed.len(), 1);
      assert_eq!(claimed[0].source_workspace_id, source_workspace_id);
      assert_eq!(
        claimed[0].source_workspace_name,
        recipient_snapshot.source_workspace_name
      );
      assert_eq!(claimed[0].actor_id, actor_id);
      assert_eq!(
        repository.claim(10).await.unwrap().len(),
        0,
        "active leases prevent duplicate dispatch"
      );
      repository
        .mark_failed(claimed[0].id, "redis_fanout")
        .await
        .expect("release failed fanout for retry");
      let retried = repository.claim(10).await.expect("reclaim failed notification");
      assert_eq!(retried.len(), 1);
      assert_eq!(retried[0].id, claimed[0].id);
      repository
        .mark_dispatched(retried[0].id)
        .await
        .expect("complete notification dispatch");

      let compensation = WorkspaceContentCompensationIntent {
        operation_id: record.id,
        sequence: 0,
        kind: "delete_staged_document".to_string(),
        target: target_doc.clone(),
      };
      assert!(repository.append_compensation(compensation.clone()).await.unwrap());
      assert!(!repository.append_compensation(compensation.clone()).await.unwrap());
      assert!(
        is_invalid_input(
          repository
            .append_compensation(WorkspaceContentCompensationIntent {
              target: resource(
                target_workspace_id,
                WorkspaceContentResourceKind::Document,
                "other-target"
              ),
              ..compensation
            })
            .await
        ),
        "compensation sequence must not be rebound to another target"
      );

      repository
        .transition(
          record.id,
          WorkspaceContentOperationStatus::Running,
          WorkspaceContentOperationStatus::Succeeded,
          None,
          None,
        )
        .await
        .expect("finish first operation before recovery contract");
      assert!(
        repository.get(record.id).await.unwrap().unwrap().error.is_none(),
        "success clears both obsolete cause and phase"
      );
      let queued = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &"e".repeat(64),
      );
      repository
        .create_or_get(queued.clone())
        .await
        .expect("create recovery operation");
      repository
        .transition(
          queued.id,
          WorkspaceContentOperationStatus::Draft,
          WorkspaceContentOperationStatus::Previewed,
          None,
          None,
        )
        .await
        .expect("preview recovery operation");
      repository
        .transition(
          queued.id,
          WorkspaceContentOperationStatus::Previewed,
          WorkspaceContentOperationStatus::Queued,
          None,
          None,
        )
        .await
        .expect("queue recovery operation");

      let recovered_wakes = Arc::new(RecordingQueue {
        fail: false,
        wakes: Mutex::new(Vec::new()),
      });
      let fresh_coordinator =
        WorkspaceContentClusterCoordinator::new(repository.clone(), recovered_wakes.clone(), None, None);
      let reconciled_count = fresh_coordinator.reconcile(50).await.unwrap();
      let recovered_wakes = recovered_wakes.wakes.lock().expect("recording queue lock");
      assert_eq!(
        recovered_wakes.len(),
        reconciled_count,
        "every reconcilable SQL row must produce one queue wake-up"
      );
      assert_eq!(
        recovered_wakes
          .iter()
          .filter(|operation_id| **operation_id == queued.id)
          .count(),
        1,
        "a fresh service instance must reconstruct this operation's lost queue wake-up exactly once"
      );
      drop(recovered_wakes);

      let failing_queue = Arc::new(RecordingQueue {
        fail: true,
        wakes: Mutex::new(Vec::new()),
      });
      let fresh_coordinator = WorkspaceContentClusterCoordinator::new(repository.clone(), failing_queue, None, None);
      assert_eq!(fresh_coordinator.reconcile(50).await.unwrap_err().dependency(), "queue");
      assert_eq!(
        repository.get(queued.id).await.unwrap().unwrap().status,
        WorkspaceContentOperationStatus::Queued,
        "a failed wake-up must not mutate authoritative operation state"
      );

      assert!(
        repository.cancel_unpublished(record.id, actor_id).await.is_err(),
        "a terminal published operation must never be reopened as cancelled"
      );

      let cancellation = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &"f".repeat(64),
      );
      repository
        .create_or_get(cancellation.clone())
        .await
        .expect("create cancellation recovery operation");
      assert!(
        repository
          .cancel_unpublished(cancellation.id, recipient_id)
          .await
          .is_err(),
        "another actor must not cancel the operation"
      );
      assert_eq!(
        repository
          .cancel_unpublished(cancellation.id, actor_id)
          .await
          .expect("cancel unpublished operation")
          .status,
        WorkspaceContentOperationStatus::Cancelled
      );
      let private_key = Uuid::new_v5(&cancellation.id, b"private-cancellation-blob").to_string();
      let committed_key = Uuid::new_v5(&cancellation.id, b"committed-cancellation-blob").to_string();
      for (sequence, key) in [(1_000_000, &private_key), (1_000_001, &committed_key)] {
        repository
          .append_compensation(WorkspaceContentCompensationIntent {
            operation_id: cancellation.id,
            sequence,
            kind: "delete_operation_blob".into(),
            target: resource(target_workspace_id, WorkspaceContentResourceKind::Blob, key),
          })
          .await
          .expect("durable private materialization intent");
      }
      sqlx::query("INSERT INTO blobs(workspace_id,key,size,mime,status) VALUES ($1,$2,5,'text/plain','completed')")
        .bind(target_workspace_id)
        .bind(&committed_key)
        .execute(&pool)
        .await
        .expect("canonical catalog remains protected");
      let expected_cleanup = vec![resource(
        target_workspace_id,
        WorkspaceContentResourceKind::Blob,
        &private_key,
      )];
      assert_eq!(
        repository
          .cancelled_private_blob_targets(cancellation.id)
          .await
          .unwrap(),
        expected_cleanup,
        "only the cancelled operation's unpublished private address can be compensated"
      );
      assert_eq!(
        repository
          .mark_cancel_cleanup_required(cancellation.id)
          .await
          .expect("mark failed cancellation cleanup")
          .status,
        WorkspaceContentOperationStatus::CleanupRequired
      );
      assert_eq!(
        repository
          .cancelled_private_blob_targets(cancellation.id)
          .await
          .unwrap(),
        expected_cleanup,
        "cancellation cleanup retries retain the same receipt/catalog fencing"
      );
      assert!(
        repository.resume_cleanup_required(cancellation.id).await.is_err(),
        "cancellation cleanup must not resume semantic publication"
      );
      assert_eq!(
        repository
          .complete_cancel_cleanup(cancellation.id)
          .await
          .expect("complete cancellation cleanup")
          .status,
        WorkspaceContentOperationStatus::Cancelled
      );

      let mut retryable = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &"0".repeat(64),
      );
      retryable.preview_revision = Some("retry-revision".to_string());
      repository
        .create_or_get(retryable.clone())
        .await
        .expect("create retry recovery operation");
      repository
        .transition(
          retryable.id,
          WorkspaceContentOperationStatus::Draft,
          WorkspaceContentOperationStatus::Failed,
          Some(
            RedactedWorkspaceContentError::new(
              WorkspaceContentErrorCode::WorkerExecutionFailed,
              "retryable worker failure",
            )
            .expect("valid redacted retry fixture")
            .with_phase("publication"),
          ),
          Some("failed-worker"),
        )
        .await
        .expect("fail retry recovery operation");
      assert!(
        repository
          .retry_failed(retryable.id, recipient_id, "retry-revision")
          .await
          .is_err(),
        "another actor must not retry the operation"
      );
      assert!(
        repository
          .retry_failed(retryable.id, actor_id, "stale-revision")
          .await
          .is_err(),
        "retry must remain bound to the current preflight revision"
      );
      assert_eq!(
        repository
          .retry_failed(retryable.id, actor_id, "retry-revision")
          .await
          .expect("queue authorized retry")
          .status,
        WorkspaceContentOperationStatus::Queued
      );
      assert!(
        repository.get(retryable.id).await.unwrap().unwrap().error.is_none(),
        "authorized retry clears the failed attempt before a new actual failure"
      );

      sqlx::query("DELETE FROM workspace_content_operations WHERE id = ANY($1)")
        .bind([record.id, queued.id, cancellation.id, retryable.id])
        .execute(&pool)
        .await
        .expect("delete XWS operations");
      helpers::cleanup_workspaces(&pool, &[source_workspace_id, target_workspace_id]).await;
      helpers::cleanup_users(&pool, &[actor_id, recipient_id, inactive_id]).await;
    },
  );
}

#[test]
fn redirect_resolution_is_permission_checked_chain_bounded_and_cycle_safe() {
  helpers::block_on_large_stack(
    "redirect_resolution_is_permission_checked_chain_bounded_and_cycle_safe",
    || async {
      let (_app, pool, auth) = helpers::setup_app().await;
      let (actor_id, _session) = helpers::seed_user(&pool, &auth, "xws_redirect_actor").await;
      let (outsider_id, _session) = helpers::seed_user(&pool, &auth, "xws_redirect_outsider").await;
      let source_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      let middle_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      let target_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      let repository = Arc::new(PgWorkspaceContentOperationRepository::new(
        pool.clone(),
        crate::helpers::database_starter_catalog(),
      ));
      let source = resource(
        source_workspace_id,
        WorkspaceContentResourceKind::Document,
        "original-key",
      );
      let middle = resource(
        middle_workspace_id,
        WorkspaceContentResourceKind::Document,
        "intermediate-key",
      );
      let target = resource(
        target_workspace_id,
        WorkspaceContentResourceKind::Document,
        "current-key",
      );

      let target_doc_id = Uuid::new_v4();
      sqlx::query(
        "INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by)
         VALUES ($1, $2, $3, 'Private redirect target', $4, $4)",
      )
      .bind(target_doc_id)
      .bind(target_workspace_id)
      .bind(target.resource_id())
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect("seed redirect target");

      let first = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        middle_workspace_id,
        &"a".repeat(64),
      );
      let second = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        middle_workspace_id,
        target_workspace_id,
        &"b".repeat(64),
      );
      for record in [&first, &second] {
        repository
          .create_or_get(record.clone())
          .await
          .expect("persist redirect operation");
      }
      repository
        .insert_redirect(WorkspaceContentRedirect {
          operation_id: first.id,
          source: source.clone(),
          target: middle.clone(),
        })
        .await
        .expect("persist first redirect");
      repository
        .insert_redirect(WorkspaceContentRedirect {
          operation_id: second.id,
          source: middle.clone(),
          target: target.clone(),
        })
        .await
        .expect("persist second redirect");

      let doc = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
      let service = WorkspaceContentRedirectService::new(
        Arc::new(PgWorkspaceContentRedirectRepository::new(pool.clone(), doc.clone())),
        Arc::new(PermissionService::new(auth.clone())),
        doc,
      );
      assert_eq!(
        service
          .resolve(actor_id, source.clone())
          .await
          .expect("authorized actor resolves current target"),
        target.clone()
      );
      assert_eq!(
        service
          .resolve(actor_id, target.clone())
          .await
          .expect("authorized actor resolves a canonical Organizer target"),
        target
      );
      assert!(
        matches!(
          service.resolve(outsider_id, source.clone()).await,
          Err(AuthError::NotFound(_))
        ),
        "an outsider must not learn whether the redirect or its target exists"
      );
      assert!(
        matches!(
          service.resolve(outsider_id, target.clone()).await,
          Err(AuthError::NotFound(_))
        ),
        "a canonical Organizer target must enforce the same neutral read check"
      );

      let copied_back_doc_id = Uuid::new_v4();
      sqlx::query(
        "INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by)
         VALUES ($1, $2, $3, 'Copy returned to source', $4, $4)",
      )
      .bind(copied_back_doc_id)
      .bind(source_workspace_id)
      .bind(source.resource_id())
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect("recreate the live source key after Move");
      sqlx::query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'Reader', 'Accepted')",
      )
      .bind(target_workspace_id)
      .bind(outsider_id)
      .execute(&pool)
      .await
      .expect("allow reading only the historical redirect destination");
      assert_eq!(
        service.resolve(outsider_id, target.clone()).await.unwrap(),
        target,
        "the stale redirect destination is readable for the negative ACL case"
      );
      assert_eq!(
        service.resolve(actor_id, source.clone()).await.unwrap(),
        source,
        "the copy owns its live address, not the historical Move redirect"
      );
      assert!(
        matches!(
          service.resolve(outsider_id, source.clone()).await,
          Err(AuthError::NotFound(_))
        ),
        "a denied live resource must not fall through to an old redirect"
      );
      sqlx::query("DELETE FROM docs WHERE id = ANY($1)")
        .bind([copied_back_doc_id, target_doc_id])
        .execute(&pool)
        .await
        .expect("remove live endpoints before testing a redirect-only cycle");

      let cycle = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        target_workspace_id,
        source_workspace_id,
        &"c".repeat(64),
      );
      repository
        .create_or_get(cycle.clone())
        .await
        .expect("persist cycle fixture operation");
      repository
        .insert_redirect(WorkspaceContentRedirect {
          operation_id: cycle.id,
          source: target,
          target: source.clone(),
        })
        .await
        .expect("persist cycle fixture redirect");
      assert!(
        matches!(service.resolve(actor_id, source).await, Err(AuthError::NotFound(_))),
        "redirect cycles must fail with the same neutral contract"
      );

      sqlx::query("DELETE FROM workspace_content_operations WHERE id = ANY($1)")
        .bind([first.id, second.id, cycle.id])
        .execute(&pool)
        .await
        .expect("delete redirect operations");
      helpers::cleanup_workspaces(&pool, &[source_workspace_id, middle_workspace_id, target_workspace_id]).await;
      helpers::cleanup_users(&pool, &[actor_id, outsider_id]).await;
    },
  );
}

#[test]
fn link_publication_is_atomic_and_replayable() {
  helpers::block_on_large_stack("link_publication_is_atomic_and_replayable", || async {
    let (_app, pool, auth) = helpers::setup_app().await;
    let (actor_id, _session) = helpers::seed_user(&pool, &auth, "xws_link_intent_actor").await;
    let (link_member_id, _session) = helpers::seed_user(&pool, &auth, "xws_link_current_rights_actor").await;
    let source_workspace_id = helpers::create_workspace(&pool, actor_id).await;
    let target_workspace_id = helpers::create_workspace(&pool, actor_id).await;
    use futures_util::FutureExt;
    let outcome = std::panic::AssertUnwindSafe(async {
      sqlx::query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $3, 'Admin', 'Accepted'), ($2, $3, 'Admin', 'Accepted')",
      )
      .bind(source_workspace_id)
      .bind(target_workspace_id)
      .bind(link_member_id)
      .execute(&pool)
      .await
      .expect("seed Link current-rights memberships");
      let source_doc_id = Uuid::new_v4();
      let source_external_id = Uuid::new_v4().to_string();
      sqlx::query(
        "INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by)
       VALUES ($1, $2, $3, 'Link source', $4, $4)",
      )
      .bind(source_doc_id)
      .bind(source_workspace_id)
      .bind(&source_external_id)
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect("seed Link source document");
      sqlx::query("INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence) VALUES ($1, $2, $3, 7)")
        .bind(source_doc_id)
        .bind(source_workspace_id)
        .bind(yjs::create_initial_workspace_doc("Link source"))
        .execute(&pool)
        .await
        .expect("seed Link source history for compaction");
      let repository = Arc::new(PgWorkspaceContentOperationRepository::new(pool.clone(), crate::helpers::database_starter_catalog()));
      let organizer_service = OrganizerService::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
      let parent_id = Uuid::new_v4().to_string();
      organizer_service
        .create_folder(
          target_workspace_id,
          CreateOrganizerFolder {
            id: parent_id.clone(),
            parent_id: None,
            name: "Linked content".to_string(),
            index: Some("a0".to_string()),
          },
        )
        .await
        .expect("create Link target folder");
      sqlx::query(
        "INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by)
       VALUES ($1, $2, $3, '', $4, $4)",
      )
      .bind(Uuid::new_v4())
      .bind(target_workspace_id)
      .bind(Uuid::new_v4().to_string())
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect("seed a valid untitled target document");
      let graph_source =
        PgWorkspaceContentGraphSource::new(pool.clone(), DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
      let request = WorkspaceContentOperationRequest {
        kind: WorkspaceContentOperationKind::Link,
        source_workspace_id,
        target_workspace_id,
        selection: WorkspaceContentOperationSelection::Resources {
          resources: vec![resource(
            source_workspace_id,
            WorkspaceContentResourceKind::Document,
            source_external_id.clone(),
          )],
        },
        copy_document_acl: false,
        extract_workspace_name: None, git_sync_choice: None,
        link_entry_id: Some(Uuid::new_v4().to_string()),
        link_parent_id: Some(parent_id.clone()),
        link_index: Some("a1".to_string()),
      };
      let prepared = graph_source
        .prepare(Uuid::nil(), Uuid::nil(), &request, Vec::new())
        .await
        .expect("prepare the persistence-backed Link graph");
      let graph = WorkspaceContentGraphBuilder
        .build(prepared.input)
        .expect("the live document relation inventory remains classified");
      assert_eq!(graph.kind, WorkspaceContentOperationKind::Link);
      assert_eq!(graph.resources.len(), 1);
      let database_id = Uuid::new_v4();
      sqlx::query("INSERT INTO workspace_databases (id, workspace_id, title, created_by) VALUES ($1, $2, 'Populated Link root', $3)")
        .bind(database_id).bind(source_workspace_id).bind(actor_id)
        .execute(&pool).await.expect("seed selected Database");
      sqlx::query("INSERT INTO workspace_database_rows (id, database_id, doc_id, position, title) VALUES ($1, $2, $3, 0, 'Owned row')")
        .bind(Uuid::new_v4()).bind(database_id).bind(source_doc_id)
        .execute(&pool).await.expect("seed a real owned row document");
      let database_root = resource(source_workspace_id, WorkspaceContentResourceKind::Database, database_id.to_string());
      let database_request = WorkspaceContentOperationRequest {
        selection: WorkspaceContentOperationSelection::Resources { resources: vec![database_root.clone()] },
        ..request.clone()
      };
      let database_prepared = graph_source.prepare(Uuid::nil(), Uuid::nil(), &database_request, Vec::new()).await.expect("Link reads only its selected Database");
      assert!(database_prepared.input.references.is_empty());
      assert!(database_prepared.input.target_definitions.is_empty());
      assert!(database_prepared.input.target_resource_ids.is_empty());
      let database_graph = WorkspaceContentGraphBuilder.build(database_prepared.input).unwrap();
      assert_eq!(database_graph.resources.len(), 1, "owned row documents do not enter Link");
      assert_eq!(database_graph.mappings[0].mapping.source, database_root);
      assert_eq!(database_graph.mappings[0].mapping.target, database_root);
      for (kind, id, cause) in [
        (WorkspaceContentResourceKind::Database, Uuid::new_v4().to_string(), WorkspaceContentErrorCode::SourceDatabaseMissing),
        (WorkspaceContentResourceKind::Folder, parent_id.clone(), WorkspaceContentErrorCode::SelectedResourceUnsupported),
        (WorkspaceContentResourceKind::Blob, "unrelated-blob".into(), WorkspaceContentErrorCode::SelectedResourceUnsupported),
      ] {
        let invalid = WorkspaceContentOperationRequest {
          selection: WorkspaceContentOperationSelection::Resources { resources: vec![resource(source_workspace_id, kind, id)] },
          ..request.clone()
        };
        assert!(matches!(graph_source.prepare(Uuid::nil(), Uuid::nil(), &invalid, Vec::new()).await,
          Err(AuthError::NotFound(code) | AuthError::InvalidInput(code)) if code == cause.as_str()));
      }
      DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
        .with_compaction_thresholds(1, 1)
        .compaction
        .maybe_compact(source_workspace_id, source_doc_id)
        .await
        .expect("compact the unchanged source history");
      assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
          .bind(source_doc_id)
          .fetch_one(&pool)
          .await
          .expect("read remaining source updates"),
        0,
        "fixture must really compact the update tail",
      );
      let compacted = graph_source
        .prepare(Uuid::nil(), Uuid::nil(), &request, Vec::new())
        .await
        .expect("rebuild compacted preflight");
      assert_eq!(
        WorkspaceContentGraphBuilder
          .build(compacted.input)
          .expect("compacted graph")
          .revision,
        graph.revision,
        "storage compaction must not invalidate an unchanged Link/Copy content graph",
      );
      let mut record = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &"f".repeat(64),
      );
      record.kind = WorkspaceContentOperationKind::Link;
      repository
        .create_or_get(record.clone())
        .await
        .expect("create Link operation");
      let target = resource(
        source_workspace_id,
        WorkspaceContentResourceKind::Document,
        source_external_id,
      );
      repository
        .store_manifest(
          record.id,
          &record.manifest_hash,
          &[WorkspaceContentIdMapping::new(target.clone(), target.clone()).expect("valid Link identity mapping")],
          &[],
        )
        .await
        .expect("persist the identity-preserving Link manifest");
      let intent = WorkspaceContentLinkIntent {
        operation_id: record.id,
        entry_id: Uuid::new_v4().to_string(),
        parent_id,
        index: "a1".to_string(),
        organizer_revision: organizer_service
          .snapshot(target_workspace_id)
          .await
          .expect("snapshot Link organizer")
          .content_revision(),
        target: target.clone(),
      };
      repository.store_request(record.id, &WorkspaceContentOperationRequest {
        selection: WorkspaceContentOperationSelection::Resources { resources: vec![target.clone()] },
        link_entry_id: Some(intent.entry_id.clone()),
        link_parent_id: Some(intent.parent_id.clone()),
        link_index: Some(intent.index.clone()),
        ..request.clone()
      }, None).await.expect("persist the exact admitted root");
      assert!(matches!(repository.store_link_intent(WorkspaceContentLinkIntent {
        target: resource(target_workspace_id, WorkspaceContentResourceKind::Document, "wrong-source"),
        ..intent.clone()
      }).await, Err(AuthError::InvalidInput(code)) if code == WorkspaceContentErrorCode::MappingPlanInvalid.as_str()));
      assert_eq!(repository.get_link_intent(record.id).await.unwrap(), None);
      assert!(repository.store_link_intent(intent.clone()).await.unwrap());
      assert!(!repository.store_link_intent(intent.clone()).await.unwrap());
      assert_eq!(
        repository.get_link_intent(record.id).await.unwrap(),
        Some(intent.clone())
      );
      assert!(
        is_invalid_input(
          repository
            .store_link_intent(WorkspaceContentLinkIntent {
              entry_id: Uuid::new_v4().to_string(),
              ..intent.clone()
            })
            .await
        ),
        "an operation cannot be rebound to another organizer placement"
      );

      {
        use myoxus_application::organizer::OrganizerDocumentPort;
        use yrs::updates::decoder::Decode;
        use yrs::{Doc, Map, ReadTxn, StateVector, Transact, Update};
        let port = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
        let payload = port.load_organizer_document(target_workspace_id).await.unwrap();
        let state = Doc::new();
        state
          .transact_mut()
          .apply_update(Update::decode_v1(&payload).unwrap())
          .unwrap();
        let vector = state.transact().state_vector();
        state
          .get_or_insert_map("myoxus$mcp_folder_index")
          .insert(&mut state.transact_mut(), "$$DELETED", true);
        let update = state.transact().encode_state_as_update_v1(&vector);
        assert!(!update.is_empty());
        port
          .persist_organizer_update(target_workspace_id, update)
          .await
          .unwrap();
        let current = organizer_service.snapshot(target_workspace_id).await.unwrap();
        assert_eq!(
          current.content_revision(),
          intent.organizer_revision,
          "client bookkeeping must not invalidate a confirmed Link placement"
        );
        assert_ne!(StateVector::default(), state.transact().state_vector());
      }

      repository
        .transition(
          record.id,
          WorkspaceContentOperationStatus::Draft,
          WorkspaceContentOperationStatus::Previewed,
          None,
          None,
        )
        .await
        .unwrap();
      repository
        .transition(
          record.id,
          WorkspaceContentOperationStatus::Previewed,
          WorkspaceContentOperationStatus::Queued,
          None,
          None,
        )
        .await
        .unwrap();
      let running = repository
        .transition(
          record.id,
          WorkspaceContentOperationStatus::Queued,
          WorkspaceContentOperationStatus::Running,
          None,
          Some("link-worker"),
        )
        .await
        .expect("claim Link operation");
      let projection = organizer_service
        .project_operation_link(
          target_workspace_id,
          CreateOrganizerLink {
            id: intent.entry_id.clone(),
            parent_id: intent.parent_id.clone(),
            link_type: OrganizerLinkType::Doc,
            target_id: intent.target.resource_id().to_string(),
            target_workspace_id: Some(intent.target.workspace_id()),
            index: Some(intent.index.clone()),
          },
        )
        .await
        .expect("project Link organizer update");
      assert_eq!(projection.revision, intent.organizer_revision);
      let batch = WorkspaceContentLinkPublicationBatch {
        operation: running,
        intent: intent.clone(),
        organizer: projection,
      };
      let mut old = operation(Uuid::new_v4(), Uuid::new_v4(), actor_id, source_workspace_id, target_workspace_id, &"b".repeat(64));
      old.kind = WorkspaceContentOperationKind::Link;
      repository.create_or_get(old.clone()).await.expect("seed an older wrong-root Link");
      let old_intent = WorkspaceContentLinkIntent {
        operation_id: old.id,
        entry_id: Uuid::new_v4().to_string(),
        ..intent.clone()
      };
      repository.store_request(old.id, &WorkspaceContentOperationRequest {
        link_entry_id: Some(old_intent.entry_id.clone()),
        ..database_request.clone()
      }, None).await.expect("the selected root was a populated Database");
      repository.store_link_intent(old_intent.clone()).await.expect("older producer picked its row Document");
      let old = running_link(&repository, old).await;
      let old_projection = organizer_service.project_operation_link(target_workspace_id, CreateOrganizerLink {
        id: old_intent.entry_id.clone(), parent_id: old_intent.parent_id.clone(),
        link_type: OrganizerLinkType::Doc, target_id: old_intent.target.resource_id().into(),
        target_workspace_id: Some(old_intent.target.workspace_id()), index: Some(old_intent.index.clone()),
      }).await.expect("prepare an unpublished older projection");
      assert!(matches!(repository.publish_link(WorkspaceContentLinkPublicationBatch {
        operation: old.clone(), intent: old_intent, organizer: old_projection,
      }, "link-old-root").await, Err(AuthError::InvalidInput(code)) if code == WorkspaceContentErrorCode::RequestInvalid.as_str()));
      assert_eq!(organizer_service.snapshot(target_workspace_id).await.unwrap().content_revision(), intent.organizer_revision,
        "wrong-root admission cannot partially publish placement");
      sqlx::query("DELETE FROM workspace_content_operations WHERE id = $1").bind(old.id)
        .execute(&pool).await.expect("clean older Link fixture");
      let succeeded = repository
        .publish_link(batch.clone(), "link-worker")
        .await
        .expect("atomically publish and complete Link");
      assert_eq!(succeeded.status, WorkspaceContentOperationStatus::Succeeded);
      let replay_repository = PgWorkspaceContentOperationRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
      assert_eq!(
        replay_repository
          .publish_link(batch, "link-worker-replay")
          .await
          .expect("a fresh repository instance replays Link idempotently")
          .id,
        succeeded.id
      );
      let snapshot = organizer_service
        .snapshot(target_workspace_id)
        .await
        .expect("load published organizer");
      assert_eq!(snapshot.roots[0].children.len(), 1);
      assert_eq!(snapshot.roots[0].children[0].row.id, intent.entry_id);
      assert_eq!(
        sqlx::query_scalar::<_, i64>(
          "SELECT count(*) FROM workspace_content_link_publications WHERE operation_id = $1",
        )
        .bind(record.id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
      );
      assert_eq!(
        sqlx::query_scalar::<_, i64>(
          "SELECT count(*) FROM outbox_events
           WHERE aggregate_type = 'workspace_content_operation'
             AND aggregate_id = $1 AND event_type = 'workspace_content_published'",
        )
        .bind(record.id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
      );

      async fn running_link(
        repository: &PgWorkspaceContentOperationRepository,
        mut record: WorkspaceContentOperationRecord,
      ) -> WorkspaceContentOperationRecord {
        for (from, to) in [
          (
            WorkspaceContentOperationStatus::Draft,
            WorkspaceContentOperationStatus::Previewed,
          ),
          (
            WorkspaceContentOperationStatus::Previewed,
            WorkspaceContentOperationStatus::Queued,
          ),
          (
            WorkspaceContentOperationStatus::Queued,
            WorkspaceContentOperationStatus::Running,
          ),
        ] {
          record = repository
            .transition(record.id, from, to, None, Some("link-revalidation-test"))
            .await
            .expect("advance stale Link");
        }
        record
      }

      let link_service = WorkspaceContentLinkService::new(
        DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))),
        Arc::new(PermissionService::new(auth.clone())),
      );
      let executor = WorkspaceContentLinkExecutor::new(
        repository.clone(),
        repository.clone(),
        link_service,
        repository.clone(),
        Uuid::new_v4(),
      );
      // A coherent old admitted Collection intent must be readable but never executable.
      let mut legacy = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &"c".repeat(64),
      );
      legacy.kind = WorkspaceContentOperationKind::Link;
      repository.create_or_get(legacy.clone()).await.unwrap();
      let legacy_target = resource(
        source_workspace_id,
        WorkspaceContentResourceKind::Collection,
        "legacy-collection",
      );
      repository
        .store_manifest(
          legacy.id,
          &legacy.manifest_hash,
          &[WorkspaceContentIdMapping::new(legacy_target.clone(), legacy_target.clone()).unwrap()],
          &[],
        )
        .await
        .unwrap();
      let before_legacy = organizer_service.snapshot(target_workspace_id).await.unwrap();
      let legacy_intent = WorkspaceContentLinkIntent {
        operation_id: legacy.id,
        entry_id: Uuid::new_v4().to_string(),
        parent_id: intent.parent_id.clone(),
        index: "a2".into(),
        organizer_revision: before_legacy.content_revision(),
        target: legacy_target,
      };
      repository.store_link_intent(legacy_intent.clone()).await.unwrap();
      let legacy = running_link(&repository, legacy).await;
      let legacy_projection = organizer_service
        .project_operation_link(
          target_workspace_id,
          CreateOrganizerLink {
            id: legacy_intent.entry_id.clone(),
            parent_id: legacy_intent.parent_id.clone(),
            index: Some(legacy_intent.index.clone()),
            link_type: OrganizerLinkType::Collection,
            target_id: legacy_intent.target.resource_id().into(),
            target_workspace_id: Some(source_workspace_id),
          },
        )
        .await
        .unwrap();
      assert!(matches!(repository.publish_link(WorkspaceContentLinkPublicationBatch {
        operation: legacy.clone(), intent: legacy_intent.clone(), organizer: legacy_projection,
      }, "legacy-collection-link").await,
        Err(AuthError::InvalidInput(code)) if code == WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str()));
      let rejected = executor
        .execute(legacy.clone())
        .await
        .expect("historical Link fails precisely before effects");
      assert_eq!(rejected.status, WorkspaceContentOperationStatus::Failed);
      assert_eq!(
        rejected
          .error
          .as_ref()
          .map(|error| (error.code, error.phase.as_deref())),
        Some((
          WorkspaceContentErrorCode::SelectedResourceUnsupported,
          Some("link_projection")
        ))
      );
      assert_eq!(
        organizer_service.snapshot(target_workspace_id).await.unwrap(),
        before_legacy
      );
      assert_eq!(
        repository.get_link_intent(legacy.id).await.unwrap(),
        Some(legacy_intent)
      );

      let mut revoked = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        link_member_id,
        source_workspace_id,
        target_workspace_id,
        &"1".repeat(64),
      );
      revoked.kind = WorkspaceContentOperationKind::Link;
      repository
        .create_or_get(revoked.clone())
        .await
        .expect("create permission-revalidation Link");
      let revoked_intent = WorkspaceContentLinkIntent {
        operation_id: revoked.id,
        entry_id: Uuid::new_v4().to_string(),
        parent_id: intent.parent_id.clone(),
        index: "a2".to_string(),
        organizer_revision: organizer_service
          .snapshot(target_workspace_id)
          .await
          .unwrap()
          .content_revision(),
        target: target.clone(),
      };
      repository
        .store_link_intent(revoked_intent.clone())
        .await
        .expect("store permission-revalidation Link intent");
      let revoked = running_link(&repository, revoked).await;
      sqlx::query(
        "UPDATE workspace_memberships SET status = 'Revoked'
       WHERE workspace_id = $1 AND user_id = $2",
      )
      .bind(source_workspace_id)
      .bind(link_member_id)
      .execute(&pool)
      .await
      .expect("revoke Link source permission after intent");
      let revoked = executor.execute(revoked).await.expect("terminalize stale Link");
      assert_eq!(revoked.status, WorkspaceContentOperationStatus::Failed);
      assert_eq!(
        revoked.error.as_ref().map(|error| error.code),
        Some(myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode::LinkTargetUnavailable)
      );

      sqlx::query(
        "UPDATE workspace_memberships SET status = 'Accepted'
       WHERE workspace_id = $1 AND user_id = $2",
      )
      .bind(source_workspace_id)
      .bind(link_member_id)
      .execute(&pool)
      .await
      .expect("restore Link source permission");
      let stale_document_id = Uuid::new_v4();
      let stale_document_key = Uuid::new_v4().to_string();
      sqlx::query("INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by) VALUES ($1, $2, $3, 'Independent revision target', $4, $4)")
        .bind(stale_document_id).bind(source_workspace_id).bind(&stale_document_key).bind(actor_id)
        .execute(&pool).await.expect("stale-revision case has no preexisting duplicate placement");
      let mut organizer_stale = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        link_member_id,
        source_workspace_id,
        target_workspace_id,
        &"2".repeat(64),
      );
      organizer_stale.kind = WorkspaceContentOperationKind::Link;
      repository
        .create_or_get(organizer_stale.clone())
        .await
        .expect("create organizer-revalidation Link");
      let organizer_stale_intent = WorkspaceContentLinkIntent {
        operation_id: organizer_stale.id,
        entry_id: Uuid::new_v4().to_string(),
        parent_id: intent.parent_id.clone(),
        index: "a3".to_string(),
        organizer_revision: organizer_service
          .snapshot(target_workspace_id)
          .await
          .unwrap()
          .content_revision(),
        target: resource(source_workspace_id, WorkspaceContentResourceKind::Document, stale_document_key),
      };
      repository
        .store_link_intent(organizer_stale_intent.clone())
        .await
        .expect("store organizer-revalidation Link intent");
      let organizer_stale = running_link(&repository, organizer_stale).await;
      organizer_service
        .create_folder(
          target_workspace_id,
          CreateOrganizerFolder {
            id: Uuid::new_v4().to_string(),
            parent_id: None,
            name: "Concurrent organizer change".to_string(),
            index: Some("a1".to_string()),
          },
        )
        .await
        .expect("change Organizer after Link intent");
      let organizer_stale = executor
        .execute(organizer_stale)
        .await
        .expect("terminalize organizer-stale Link");
      assert_eq!(organizer_stale.status, WorkspaceContentOperationStatus::Failed);
      assert_eq!(
        organizer_stale.error.as_ref().map(|error| error.code),
        Some(myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode::LinkOrganizerChanged)
      );
      let snapshot = organizer_service.snapshot(target_workspace_id).await.unwrap();
      let rows = snapshot
        .roots
        .iter()
        .flat_map(|root| std::iter::once(&root.row).chain(root.children.iter().map(|child| &child.row)))
        .collect::<Vec<_>>();
      assert!(
        !rows
          .iter()
          .any(|row| { row.id == revoked_intent.entry_id || row.id == organizer_stale_intent.entry_id })
      );

      sqlx::query("DELETE FROM workspace_content_operations WHERE id = ANY($1)")
        .bind([record.id, revoked.id, organizer_stale.id])
        .execute(&pool)
        .await
        .expect("delete Link operations");
    })
    .catch_unwind()
    .await;
    sqlx::query("DELETE FROM workspace_content_operations WHERE source_workspace_id = $1 OR target_workspace_id = $2")
      .bind(source_workspace_id)
      .bind(target_workspace_id)
      .execute(&pool)
      .await
      .expect("clean exact publication fixtures after assertions");
    helpers::cleanup_workspaces(&pool, &[source_workspace_id, target_workspace_id]).await;
    helpers::cleanup_users(&pool, &[actor_id, link_member_id]).await;
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  });
}

#[test]
fn copy_publication_is_atomic_private_and_idempotent() {
  helpers::block_on_large_stack("copy_publication_is_atomic_private_and_idempotent", || async {
    let (app, pool, auth) = helpers::setup_app().await;
    let (actor_id, session) = helpers::seed_user(&pool, &auth, "xws_copy_publication_actor").await;
    let (source_reader_id, _source_reader_session) =
      helpers::seed_user(&pool, &auth, "xws_copy_publication_source_reader").await;
    let source_workspace_id = helpers::create_workspace(&pool, actor_id).await;
    let target_workspace_id = helpers::create_workspace(&pool, actor_id).await;
    use futures_util::FutureExt;
    let outcome = std::panic::AssertUnwindSafe(async {
      seed_organizer_root(&pool, target_workspace_id, actor_id).await;
      seed_organizer_root(&pool, source_workspace_id, actor_id).await;
      let repository = Arc::new(PgWorkspaceContentOperationRepository::new(pool.clone(), crate::helpers::database_starter_catalog()));
      let storage_root = tempfile::tempdir().expect("temporary publication storage");
      let storage = Arc::new(
        StorageAdapter::new_fs(
          storage_root
            .path()
            .to_str()
            .expect("temporary storage path is valid UTF-8"),
        )
        .expect("publication storage"),
      );
      let publisher = Arc::new(PgWorkspaceContentCopyPublicationRepository::new(pool.clone(), storage.clone(), crate::helpers::database_starter_catalog()));

      async fn running_copy(
        repository: &PgWorkspaceContentOperationRepository,
        mut record: WorkspaceContentOperationRecord,
        mappings: Vec<WorkspaceContentIdMapping>,
        stage_placeholders: bool,
      ) -> (WorkspaceContentOperationRecord, Vec<WorkspaceContentStagingEntry>) {
        repository
          .create_or_get(record.clone())
          .await
          .expect("create Copy operation");
        store_operation_request(repository, &record, &mappings, None).await;
        let entries = mappings
          .iter().filter(|_| stage_placeholders).map(|mapping| mapping.target.clone()).collect::<BTreeSet<_>>()
          .into_iter()
          .enumerate()
          .map(|(index, target)| {
            WorkspaceContentStagingEntry::new(
              record.id,
              index as i32,
              target,
              format!("workspace-content/{}/objects/{index}", record.id),
              format!("{:064x}", index + 1),
              1,
            )
            .expect("valid staging entry")
          })
          .collect::<Vec<_>>();
        repository
          .store_manifest(record.id, &record.manifest_hash, &mappings, &entries)
          .await
          .expect("store Copy manifest");
        record = repository
          .transition(
            record.id,
            WorkspaceContentOperationStatus::Draft,
            WorkspaceContentOperationStatus::Previewed,
            None,
            None,
          )
          .await
          .expect("preview Copy");
        repository
          .store_execution_memberships(record.id, &[])
          .await
          .expect("store empty Copy membership plan");
        record = repository
          .transition(
            record.id,
            WorkspaceContentOperationStatus::Previewed,
            WorkspaceContentOperationStatus::Queued,
            None,
            None,
          )
          .await
          .expect("queue Copy");
        record = repository
          .transition(
            record.id,
            WorkspaceContentOperationStatus::Queued,
            WorkspaceContentOperationStatus::Running,
            None,
            Some("copy-publication-test"),
          )
          .await
          .expect("claim Copy publication");
        (record, entries)
      }

      fn document_object(
        workspace_id: Uuid,
        actor_id: Uuid,
        external_id: &str,
        internal_doc_id: Uuid,
        title: &str,
      ) -> WorkspaceContentPublicationObject {
        let now = Utc::now();
        WorkspaceContentPublicationObject::Document {
          resource: resource(workspace_id, WorkspaceContentResourceKind::Document, external_id),
          internal_doc_id,
          title: title.to_string(),
          yjs_update: vec![0, 0],
          metadata: serde_json::json!({
            "doc_id": internal_doc_id,
            "workspace_id": workspace_id,
            "projection_version": "xws-copy-v1",
            "metadata_revision": 0,
            "metadata_updated_at": null,
            "metadata_updated_by": null,
            "system": {
              "created_at": now,
              "updated_at": now,
              "created_by": actor_id,
              "updated_by": actor_id,
              "metadata_updated_at": null,
              "metadata_updated_by": null
            },
            "fields": [],
            "audience": [],
            "template": null,
            "journal": {"journal_date": null},
            "presentation": null,
            "integration": null,
            "policy": {"locks": []}
          }),
          tag_ids: Vec::new(),
        }
      }

      use myoxus_application::database::{DatabaseServices, DatabaseLimits, DatabaseServiceDependencies, InitialDatabaseViewKind};
      use myoxus_application::workspace_content_operation::organizer_stage::WorkspaceContentOrganizerStageExecutor;
      use myoxus_application::workspace_content_operation::publication::WorkspaceContentOrganizerRevisionService;
      use myoxus_application::workspace_content_operation::reconcile::{WorkspaceContentReconcileExecutor, WorkspaceContentReconcileSourceService};
      let doc = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
      let permissions = Arc::new(PermissionService::new(auth.clone()));
      let organizer = OrganizerService::new(doc.clone());
      let folder_id = Uuid::new_v4().to_string();
      let child_id = Uuid::new_v4().to_string();
      for (id, parent_id, name) in [
        (folder_id.clone(), None, "Empty folder"),
        (child_id.clone(), Some(folder_id.clone()), "Empty nested folder"),
      ] {
        organizer.create_folder(source_workspace_id, CreateOrganizerFolder {
          id, parent_id, name: name.into(), index: None,
        }).await.expect("create real empty source structure");
      }
      let databases = Arc::new(DatabaseServices::new(
        Arc::new(PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog())), doc.clone(), permissions.clone(),
        DatabaseLimits::default(), Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(), crate::helpers::database_starter_catalog())), crate::helpers::database_starter_catalog(), DatabaseServiceDependencies::disabled(),
      ));
      let empty_database = databases.definition.create_database(actor_id, source_workspace_id,
        "Zero rows".into(), None, InitialDatabaseViewKind::Table).await.expect("create real zero-row Database");
      let database_before = databases.import_export.export_workspace_content_snapshot(actor_id, empty_database.database.id)
        .await.expect("read original Database definition");
      let introduction = doc.create_page_lifecycle(source_workspace_id, actor_id, Some("Unmapped introduction".into()), None)
        .await.expect("native introduction outside copied folders").document;
      let root_presentation = overview_columns("status");
      configure_overview(&pool, source_workspace_id, WorkspaceOverviewSettingsPatch {
        introduction: Some(Some(resource(source_workspace_id, WorkspaceContentResourceKind::Document, &introduction.external_id))),
        folder_ids: Some(Some(vec![folder_id.clone()])),
        register_presentation: Some(Some(root_presentation)), ..Default::default()
      }).await;
      let source_configured = configure_overview(&pool, source_workspace_id, WorkspaceOverviewSettingsPatch {
        scope: OverviewSettingsScope::Folder(folder_id.clone()),
        introduction: Some(Some(resource(source_workspace_id, WorkspaceContentResourceKind::Document, &introduction.external_id))),
        register_presentation: Some(Some(overview_columns("version"))), ..Default::default()
      }).await;
      let target_configured = configure_overview(&pool, target_workspace_id, WorkspaceOverviewSettingsPatch {
        folder_ids: Some(Some(vec![])), register_presentation: Some(Some(overview_columns("updatedAt"))), ..Default::default()
      }).await;
      let workspace_store = SqlxWorkspaceStore::new(pool.clone(), crate::helpers::database_starter_catalog());
      let source_before = organizer.snapshot(source_workspace_id).await.unwrap();
      let reconcile_source = Arc::new(WorkspaceContentReconcileSourceService::new(
        Some(databases.definition.clone()),
        Some(databases.import_export.clone()),
        None,
      ));
      let reconcile = WorkspaceContentReconcileExecutor::new(repository.clone(), repository.clone(), reconcile_source.clone(), storage.clone());
      let service = WorkspaceContentCopyPublicationService::new(repository.clone(), repository.clone(), reconcile_source,
        storage.clone(), publisher.clone()).with_databases(databases.import_export.clone()).with_organizer(
        Arc::new(WorkspaceContentOrganizerStageExecutor::new(repository.clone(), repository.clone(), doc.clone(), permissions, storage.clone(), Arc::new(PgWorkspaceContentRedirectRepository::new(pool.clone(), doc.clone())))),
        Arc::new(WorkspaceContentOrganizerRevisionService::new(doc.clone())),
      );
      let graph_source = PgWorkspaceContentGraphSource::new(pool.clone(), doc);
      use myoxus_domain::database::DatabaseEditingRepository;
      // Explicit Copy may duplicate the default's content, but its container role
      // stays bound to the original workspace and is never copied as authority.
      let native_repository = Arc::new(PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog()));
      let initializer = myoxus_application::workspace::tasks::WorkspaceTasksInitializer::new(
        crate::helpers::database_starter_catalog(), native_repository.clone(), databases.projection.clone());
      let source_default = initializer.ensure(source_workspace_id, None).await.expect("source canonical default");
      let target_default = initializer.ensure(target_workspace_id, None).await.expect("target canonical default");
      let default_parent = databases.editing.create_row(actor_id, source_default.database.id, Some("Default copy parent".into()), Vec::new())
        .await.expect("native default parent").row.id;
      let default_parent_field = source_default.field_roles.iter().find(|role|role.role_key == "task.parent").expect("native Parent role").field_id;
      let default_child = databases.editing.create_row(actor_id, source_default.database.id, Some("Default copy child".into()),
        vec![(default_parent_field, myoxus_domain::database::DatabaseCellValueData::Relation(vec![default_parent]))])
        .await.expect("native default child").row.id;
      let source_rows_before=serde_json::to_value((native_repository.get_row(default_parent).await.unwrap(),native_repository.get_row(default_child).await.unwrap())).unwrap();
      let source_counters_before:Vec<(Uuid,i64)>=sqlx::query_as("SELECT field_id,next_value FROM database_unique_id_sequences WHERE database_id=$1 ORDER BY field_id")
        .bind(source_default.database.id).fetch_all(&pool).await.unwrap();
      let default_snapshot = databases.import_export.export_workspace_content_snapshot(actor_id, source_default.database.id)
        .await.expect("default source snapshot");
      let root = resource(source_workspace_id, WorkspaceContentResourceKind::Database, source_default.database.id.to_string());
      let request = WorkspaceContentOperationRequest {
        kind: WorkspaceContentOperationKind::Copy, source_workspace_id, target_workspace_id,
        selection: WorkspaceContentOperationSelection::Resources { resources: vec![root.clone()] },
        copy_document_acl: false, extract_workspace_name: None, git_sync_choice: None, link_entry_id: None, link_parent_id: None, link_index: None,
      };
      let draft = operation(Uuid::new_v4(), Uuid::new_v4(), actor_id, source_workspace_id, target_workspace_id, &"d".repeat(64));
      let prepared = graph_source.prepare(draft.actor_id, draft.id, &request, Vec::new()).await.expect("explicit default Copy preview");
      let graph = WorkspaceContentGraphBuilder.build(prepared.input).expect("default Copy graph");
      assert!(graph.blockers.is_empty(), "{:?}", graph.blockers);
      let mappings = graph.mappings.iter().map(|planned|planned.mapping.clone()).collect::<Vec<_>>();
      let copied_id: Uuid = mappings.iter().find(|mapping|mapping.source == root).expect("default Copy mapping")
        .target.resource_id().parse().unwrap();
      let (running, _) = running_copy(&repository, draft, mappings, false).await;
      reconcile.reconcile(&running).await.expect("stage protected default as ordinary Project");
      service.publish(&running, "copy-publication-test").await.expect("native managed Copy publication");
      let copied = native_repository.get_database(copied_id).await.expect("copied native aggregate").expect("copied Project");
      assert_eq!(copied.database.system_role, None);
      assert_eq!(copied.database.profile_kind, myoxus_domain::database::DatabaseProfileKind::Project);
      assert_eq!(copied.database.managed_installation.as_ref().expect("copied source binding").readiness,
        myoxus_domain::database::DatabaseManagedSchemaReadiness::Ready);
      let source_schema = source_default.database.managed_installation.as_ref().expect("source installation");
      let copied_schema = copied.database.managed_installation.as_ref().expect("copied installation");
      assert_eq!(copied_schema.template_id, source_schema.template_id);
      assert_eq!(copied_schema.template_version, source_schema.template_version);
      assert_eq!(copied_schema.template_digest, source_schema.template_digest);
      assert_eq!(copied_schema.variant, source_schema.variant);
      assert_eq!(copied_schema.field_bindings.keys().collect::<Vec<_>>(), source_schema.field_bindings.keys().collect::<Vec<_>>());
      assert_eq!(copied_schema.view_bindings.keys().collect::<Vec<_>>(), source_schema.view_bindings.keys().collect::<Vec<_>>());
      assert_eq!(copied.field_roles.len(), source_default.field_roles.len());
      let copied_parent: Uuid = sqlx::query_scalar("SELECT id FROM workspace_database_rows WHERE database_id=$1 AND title='Default copy parent'")
        .bind(copied_id).fetch_one(&pool).await.unwrap();
      let copied_child: Uuid = sqlx::query_scalar("SELECT id FROM workspace_database_rows WHERE database_id=$1 AND title='Default copy child'")
        .bind(copied_id).fetch_one(&pool).await.unwrap();
      assert_ne!(copied_parent, default_parent);
      assert_ne!(copied_child, default_child);
      let parent_projection = databases.views.task_parent(actor_id, copied_id, copied_child).await.expect("copied native Parent graph");
      assert!(parent_projection.available);
      assert!(parent_projection.diagnostics.is_empty());
      assert_eq!(parent_projection.parent_row_ids, vec![copied_parent]);
      // Copy allocates target-native display IDs once, without importing source counters.
      let copied_display_id=copied_schema.field_bindings.get("public_id").expect("declared native display ID key");
      let copied_display_field=copied.fields.iter().find(|field|field.id==*copied_display_id).expect("native display ID binding");
      let myoxus_domain::database::DatabaseFieldConfig::UniqueId(display_config)=&copied_display_field.config else {panic!("UniqueId config")};
      let mut copied_sequences=Vec::new();
      for row_id in [copied_parent,copied_child] {
        let row=native_repository.get_row(row_id).await.unwrap().unwrap();
        let cell=row.cells.iter().find(|cell|cell.field_id==copied_display_field.id).expect("actual copied display ID Cell");
        let myoxus_domain::database::DatabaseCellValueData::UniqueId(value)=&cell.value else {panic!("native UniqueId value")};
        assert_eq!(value.prefix,display_config.prefix);
        assert!(!value.display.is_empty());
        assert_eq!(cell.updated_by,Some(actor_id));
        copied_sequences.push(value.sequence);
      }
      copied_sequences.sort();
      assert_eq!(copied_sequences,vec![display_config.start_number,display_config.start_number+1]);
      let next_copied_task=databases.editing.create_row(actor_id,copied_id,Some("After copied native IDs".into()),Vec::new()).await.unwrap();
      let next_copied_task=native_repository.get_row(next_copied_task.row.id).await.unwrap().unwrap();
      let next_display=next_copied_task.cells.iter().find(|cell|cell.field_id==copied_display_field.id).expect("continued display ID Cell");
      let myoxus_domain::database::DatabaseCellValueData::UniqueId(next_value)=&next_display.value else {panic!("native UniqueId value")};
      assert_eq!(next_value.sequence,display_config.start_number+2);
      let retained = databases.import_export.export_workspace_content_snapshot(actor_id, source_default.database.id)
        .await.expect("unchanged source snapshot");
      assert_eq!(serde_json::to_value(retained).unwrap(), serde_json::to_value(default_snapshot).unwrap());
      assert_eq!(serde_json::to_value((native_repository.get_row(default_parent).await.unwrap(),native_repository.get_row(default_child).await.unwrap())).unwrap(),source_rows_before);
      assert_eq!(sqlx::query_as::<_,(Uuid,i64)>("SELECT field_id,next_value FROM database_unique_id_sequences WHERE database_id=$1 ORDER BY field_id")
        .bind(source_default.database.id).fetch_all(&pool).await.unwrap(),source_counters_before);
      for (workspace, expected_default) in [(source_workspace_id, source_default.database.id), (target_workspace_id, target_default.database.id)] {
        let defaults: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'")
          .bind(workspace).fetch_all(&pool).await.unwrap();
        assert_eq!(defaults, vec![expected_default], "Copy never publishes a second default");
      }
      // A native captured Task and its source exercise the actual SQL publication owner.
      let task_source=Uuid::new_v4();
      sqlx::query("INSERT INTO docs(id,workspace_id,external_id,title,created_by,updated_by) VALUES($1,$2,'captured-source-key','Source document',$3,$3)")
        .bind(task_source).bind(source_workspace_id).bind(actor_id).execute(&pool).await.unwrap();
      let project=databases.definition.create_project(actor_id,myoxus_application::database::CreateDatabaseProject {
        workspace_id:source_workspace_id,title:"Copied Task Project".into(),description:None,
        priority_preset:myoxus_application::database::DatabaseProjectOptionPreset::ThreeStep,
        complexity_preset:myoxus_application::database::DatabaseProjectOptionPreset::ThreeStep,
        structure_preset:myoxus_domain::database::DatabaseProjectStructurePreset::TasksOnly,default_currency:"EUR".into(),
      }).await.unwrap();
      let parent_field=project.field_roles.iter().find(|role|role.role_key=="task.parent").unwrap().field_id;
      let blocked_field=project.field_roles.iter().find(|role|role.role_key=="task.blockedBy").unwrap().field_id;
      let task_parent=databases.editing.create_row(actor_id,project.database.id,Some("Portable Task parent".into()),Vec::new())
        .await.unwrap().row.id;
      let anchor=serde_json::json!({"type":"text","from":{"blockId":"source-text","index":0,"length":8},"to":null,"captureMode":"page","noteId":"note"}).to_string();
      let captured=databases.editing.create_task_from_source(actor_id,myoxus_application::database::DatabaseTaskCaptureInput {
        workspace_id:source_workspace_id,database_id:project.database.id,request_id:Uuid::new_v4(),source_document_id:task_source,
        source_external_id:"captured-source-key".into(),block_id:Some("source-text".into()),selection_anchor:Some(anchor.clone()),title:"Portable Task".into(),cells:vec![(parent_field,myoxus_domain::database::DatabaseCellValueData::Relation(vec![task_parent])),(blocked_field,myoxus_domain::database::DatabaseCellValueData::Relation(vec![task_parent]))],
      }).await.unwrap();
      let task_row=captured.receipt.row_id;
      let native_blocks=vec![
        ("page","myoxus:page",serde_json::json!({}),vec!["note"]),
        ("note","myoxus:note",serde_json::json!({}),vec!["source-text","task-ref","doc-ref"]),
        ("source-text","myoxus:paragraph",serde_json::json!({"text":"Portable Source excerpt","type":"text"}),vec![]),
        ("task-ref","myoxus:database",serde_json::json!({"serverWorkspaceId":source_workspace_id,"serverDatabaseId":project.database.id,"serverRowId":task_row}),vec![]),
        ("doc-ref","myoxus:embed-linked-doc",serde_json::json!({"pageId":"captured-source-key","workspaceId":source_workspace_id}),vec![]),
      ].into_iter().map(|(id,flavour,props,children)|yjs::PortableSnapshotBlock {id:id.into(),flavour:flavour.into(),version:None,props:props.as_object().unwrap().clone(),children:children.into_iter().map(str::to_string).collect()}).collect::<Vec<_>>();
      let native=yjs::snapshot_blocks_to_yjs(&native_blocks).unwrap();
      sqlx::query("INSERT INTO doc_updates(doc_id,workspace_id,payload,sequence) VALUES($1,$2,$3,1)")
        .bind(task_source).bind(source_workspace_id).bind(&native).execute(&pool).await.unwrap();
      let receipts_before:i64=sqlx::query_scalar("SELECT count(*) FROM database_task_capture_receipts WHERE actor_id=$1").bind(actor_id).fetch_one(&pool).await.unwrap();
      let mut copied_source_keys=Vec::new();
      let target_tasks_before:Vec<(Uuid,Uuid)>=sqlx::query_as("SELECT row.id,row.database_id FROM workspace_database_rows row JOIN workspace_databases db ON db.id=row.database_id WHERE db.workspace_id=$1 AND row.row_kind='task' ORDER BY row.id")
        .bind(target_workspace_id).fetch_all(&pool).await.unwrap();
      for include_database in [false,true] {
        let source_resource=resource(source_workspace_id,WorkspaceContentResourceKind::Document,"captured-source-key");
        let mut selected=vec![source_resource.clone()];
        if include_database {selected.push(resource(source_workspace_id,WorkspaceContentResourceKind::Database,project.database.id.to_string()));}
        let request=WorkspaceContentOperationRequest {kind:WorkspaceContentOperationKind::Copy,source_workspace_id,target_workspace_id,
          selection:WorkspaceContentOperationSelection::Resources {resources:selected},copy_document_acl:false,extract_workspace_name:None, git_sync_choice: None,link_entry_id:None,link_parent_id:None,link_index:None};
        let draft=operation(Uuid::new_v4(),Uuid::new_v4(),actor_id,source_workspace_id,target_workspace_id,&"c".repeat(64));
        let prepared=graph_source.prepare(draft.actor_id, draft.id, &request,Vec::new()).await.unwrap();
        let graph=WorkspaceContentGraphBuilder.build(prepared.input).unwrap();assert!(graph.blockers.is_empty(),"{:?}",graph.blockers);
        let mappings=graph.mappings.iter().map(|planned|planned.mapping.clone()).collect::<Vec<_>>();
        let (running,_)=running_copy(&repository,draft,mappings.clone(),false).await;
        let mapped=mappings.iter().find(|mapping|mapping.source==source_resource).unwrap();
        copied_source_keys.push(mapped.target.resource_id().to_string());
        let internal=Uuid::new_v5(&running.id,format!("document:{}:{}",target_workspace_id,mapped.target.resource_id()).as_bytes());
        let WorkspaceContentPublicationObject::Document {metadata,..}=document_object(target_workspace_id,actor_id,mapped.target.resource_id(),internal,"Source document") else {unreachable!()};
        let plan=myoxus_application::workspace_content_operation::copy::prepare_native_reference_plan_with_resolver(&source_resource,&native,&mappings,false,|address|async move {Ok(Some(address))}).await.unwrap();
        let staged_native=myoxus_application::workspace_content_operation::copy::apply_native_reference_plan(&native,&plan,myoxus_application::workspace_content_operation::copy::copy_rewrite_client_id(running.id,&mapped.target)).unwrap().full_state;
        let body=serde_json::to_vec(&serde_json::json!({"schemaVersion":3,"referencePlan":plan,"sourceHash":hex::encode(Sha256::digest(&native)),"sourceDocId":task_source,"targetDocId":internal,"title":"Source document","yjsUpdateBase64":STANDARD.encode(staged_native),"metadata":metadata,"tagIds":[]})).unwrap();
        let hash=hex::encode(Sha256::digest(&body));let key=format!("workspace-content/{}/objects/{hash}",running.id);
        storage.write_blob(BlobWriteRequest {key:key.clone(),content_type:Some("application/json".into()),body:Bytes::from(body.clone())}).await.unwrap();
        let entry=WorkspaceContentStagingEntry::new(running.id,0,mapped.target.clone(),key,hash,body.len() as i64).unwrap();
        repository.store_manifest(running.id,&running.manifest_hash,&mappings,&[entry]).await.unwrap();
        reconcile.reconcile(&running).await.unwrap();
        service.publish(&running,"copy-publication-test").await.unwrap();
        let persisted:Vec<Vec<u8>>=sqlx::query_scalar("SELECT payload FROM doc_updates WHERE doc_id=$1 ORDER BY sequence").bind(internal).fetch_all(&pool).await.unwrap();
        let persisted=yjs::merge_updates(persisted).unwrap();
        let values=yjs::collect_yjs_resource_values(&persisted).unwrap();
        assert!(values.contains(mapped.target.resource_id()),"mixed normal Document reference remains remapped");
        if include_database {
          let target=mappings.iter().find(|mapping|mapping.source.kind()==WorkspaceContentResourceKind::Database).unwrap();
          let target_database:Uuid=target.target.resource_id().parse().unwrap();
          let copied_row:Uuid=sqlx::query_scalar("SELECT id FROM workspace_database_rows WHERE database_id=$1 AND row_kind='task' AND title='Portable Task'").bind(target_database).fetch_one(&pool).await.unwrap();
          assert!(!values.contains(&source_workspace_id.to_string()),"complete tuple and ordinary reference both use destination scope");
          let copied_parent:Uuid=sqlx::query_scalar("SELECT id FROM workspace_database_rows WHERE database_id=$1 AND title='Portable Task parent'")
            .bind(target_database).fetch_one(&pool).await.unwrap();
          assert_ne!(copied_parent,task_parent);
          let parent_projection=databases.views.task_parent(actor_id,target_database,copied_row).await.unwrap();
          assert!(parent_projection.available);assert!(parent_projection.diagnostics.is_empty());
          assert_eq!(parent_projection.parent_row_ids,vec![copied_parent],"actual Copy remaps Parent to the copied native Task");
          let blocker_projection=databases.views.task_blocking(actor_id,target_database,copied_row,false,Some(10),None).await.unwrap();
          assert!(blocker_projection.available);assert!(blocker_projection.diagnostics.is_empty());
          assert_eq!(blocker_projection.retained_row_ids,vec![copied_parent],"actual Copy remaps BlockedBy through the same native operation mapping");
          assert_eq!(blocker_projection.rows[0].state,myoxus_domain::database::DatabaseTaskBlockingState::Active);
          assert_ne!(copied_row,task_row);assert!(values.contains(&copied_row.to_string()));assert!(values.contains(&target_database.to_string()));
          let (source,projection)=databases.editing.task_source(actor_id,target_workspace_id,copied_row).await.unwrap().unwrap();
          assert_eq!(source.source_workspace_id,target_workspace_id);assert_eq!(source.document_id,internal);assert_eq!(source.external_id,mapped.target.resource_id());
          assert_eq!(source.block_id.as_deref(),Some("source-text"));assert_eq!(source.selection_anchor.as_deref(),Some(anchor.as_str()));assert!(projection.is_some());
          let indexed=helpers::gql(&app,session,serde_json::json!({
            "query":"query($w:String!,$source:ID!){workspace(id:$w){documentGraph(input:{direction:Both,first:20}){databaseReferences{rowId referenceKind targetDocId}} documentLinks(input:{docId:$source,direction:Incoming,first:20}){databaseReferences{rowId referenceKind targetDocId}}}}",
            "variables":{"w":target_workspace_id,"source":mapped.target.resource_id()},
          })).await;
          assert!(indexed["errors"].is_null(),"native graph/backlink query: {indexed}");
          for field in ["documentGraph","documentLinks"] {
            let refs=indexed["data"]["workspace"][field]["databaseReferences"].as_array().expect("source graph references");
            let refs=refs.iter().filter(|reference|reference["rowId"]==copied_row.to_string()&&reference["referenceKind"]=="TaskSource").collect::<Vec<_>>();
            assert_eq!(refs.len(),1,"Copy publishes exactly one native {field} source reference before any index job");
            assert_eq!(refs[0]["targetDocId"],mapped.target.resource_id());
          }

          let tasks=databases.views.list_workspace_task_references(actor_id,target_workspace_id,vec![myoxus_domain::database::DatabaseTaskReferenceTarget {workspace_id:target_workspace_id.to_string(),database_id:target_database.to_string(),row_id:copied_row.to_string()}]).await.unwrap();
          assert_eq!(tasks[0].task.as_ref().unwrap().title,"Portable Task");
        } else {
          let tasks_after:Vec<(Uuid,Uuid)>=sqlx::query_as("SELECT row.id,row.database_id FROM workspace_database_rows row JOIN workspace_databases db ON db.id=row.database_id WHERE db.workspace_id=$1 AND row.row_kind='task' ORDER BY row.id")
            .bind(target_workspace_id).fetch_all(&pool).await.unwrap();
          assert_eq!(tasks_after,target_tasks_before,"a Doc-only reference copy preserves every existing Task and never synthesizes one");
          assert!(values.contains(&source_workspace_id.to_string()));assert!(values.contains(&project.database.id.to_string()));assert!(values.contains(&task_row.to_string()),"Doc-only cross-workspace copy retains explicit unavailable origin tuple");
        }
      }
      // Remove only the Parent edge, then trash the prerequisite. Only blocker
      // loss remains: an unmapped native Copy must not publish a satisfied Task.
      databases
        .editing
        .clear_cell_value(actor_id, project.database.id, task_row, parent_field)
        .await
        .unwrap();
      databases
        .editing
        .delete_row(actor_id, project.database.id, task_parent)
        .await
        .unwrap();
      let source_task_before = sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT to_jsonb(cell) FROM workspace_database_cell_values cell WHERE row_id=$1 AND field_id=$2",
      )
      .bind(task_row)
      .bind(blocked_field)
      .fetch_one(&pool)
      .await
      .unwrap();
      let loss_snapshot = databases
        .import_export
        .export_workspace_content_snapshot(actor_id, project.database.id)
        .await
        .unwrap();
      assert!(
        loss_snapshot["diagnostics"]
          .as_array()
          .unwrap()
          .iter()
          .any(|diagnostic| diagnostic["code"] == "MIX_DATABASE_JSON_BLOCKER_TARGET_OMITTED")
      );
      assert!(
        loss_snapshot["diagnostics"]
          .as_array()
          .unwrap()
          .iter()
          .all(|diagnostic| diagnostic["code"] != "MIX_DATABASE_JSON_PARENT_TARGET_OMITTED")
      );
      let source_resource = resource(
        source_workspace_id,
        WorkspaceContentResourceKind::Database,
        project.database.id.to_string(),
      );
      let request = WorkspaceContentOperationRequest {
        kind: WorkspaceContentOperationKind::Copy,
        source_workspace_id,
        target_workspace_id,
        selection: WorkspaceContentOperationSelection::Resources {
          resources: vec![source_resource],
        },
        copy_document_acl: false,
        extract_workspace_name: None, git_sync_choice: None,
        link_entry_id: None,
        link_parent_id: None,
        link_index: None,
      };
      let draft = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &"c".repeat(64),
      );
      let prepared = graph_source.prepare(draft.actor_id, draft.id, &request, Vec::new()).await.unwrap();
      let graph = WorkspaceContentGraphBuilder.build(prepared.input).unwrap();
      assert!(graph.blockers.is_empty(), "{:?}", graph.blockers);
      let mappings = graph
        .mappings
        .into_iter()
        .map(|planned| planned.mapping)
        .collect::<Vec<_>>();
      let (running, entries) = running_copy(&repository, draft, mappings, false).await;
      assert!(entries.is_empty());
      let target_before: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id=$1 ORDER BY id")
          .bind(target_workspace_id)
          .fetch_all(&pool)
          .await
          .unwrap();
      // Native reconciliation rejects lossy definitions before staging or publication.
      let failure = reconcile.reconcile(&running).await.unwrap_err();
      assert!(matches!(
        failure,
        AuthError::InvalidInput(ref code)
          if code == WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str()
      ));
      assert!(
        repository
          .list_staging_entries(running.id)
          .await
          .unwrap()
          .is_empty(),
        "rejected blocker reconciliation stages no partial definition"
      );
      assert_eq!(
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM workspace_databases WHERE workspace_id=$1 ORDER BY id")
          .bind(target_workspace_id)
          .fetch_all(&pool)
          .await
          .unwrap(),
        target_before,
        "rejected blocker reconciliation publishes no destination Database"
      );
      assert_eq!(
        sqlx::query_scalar::<_, serde_json::Value>(
          "SELECT to_jsonb(cell) FROM workspace_database_cell_values cell WHERE row_id=$1 AND field_id=$2"
        )
        .bind(task_row)
        .bind(blocked_field)
        .fetch_one(&pool)
        .await
        .unwrap(),
        source_task_before,
        "failed Copy never repairs the source blocker Cell"
      );
      databases
        .editing
        .bulk_restore_rows(actor_id, project.database.id, &[task_parent])
        .await
        .unwrap();
      let receipts_after:i64=sqlx::query_scalar("SELECT count(*) FROM database_task_capture_receipts WHERE actor_id=$1").bind(actor_id).fetch_one(&pool).await.unwrap();
      assert_eq!(receipts_after,receipts_before,"publication never clones capture receipts");
      let move_mappings=vec![
        WorkspaceContentIdMapping::new(resource(source_workspace_id,WorkspaceContentResourceKind::Document,"captured-source-key"),resource(target_workspace_id,WorkspaceContentResourceKind::Document,"moved-source-key")).unwrap(),
        WorkspaceContentIdMapping::new(resource(source_workspace_id,WorkspaceContentResourceKind::Database,project.database.id.to_string()),resource(target_workspace_id,WorkspaceContentResourceKind::Database,project.database.id.to_string())).unwrap(),
      ];
      let moving=prepared_move_batch(&pool, &repository,actor_id,source_workspace_id,target_workspace_id,move_mappings,None).await;
      PgWorkspaceContentMovePublicationRepository::new(pool.clone(),storage.clone(), crate::helpers::database_starter_catalog()).publish_move(moving,"move-snapshot-test").await.unwrap();
      let moved_stream:Vec<Vec<u8>>=sqlx::query_scalar("SELECT payload FROM doc_updates WHERE doc_id=$1 ORDER BY sequence").bind(task_source).fetch_all(&pool).await.unwrap();
      let moved=yjs::merge_updates(moved_stream).unwrap();let moved_values=yjs::collect_yjs_resource_values(&moved).unwrap();
      assert!(moved_values.contains("moved-source-key"),"normal Doc delta survives alongside Row delta");
      assert!(moved_values.contains(&target_workspace_id.to_string()));assert!(moved_values.contains(&task_row.to_string()));
      assert!(!moved_values.contains(&source_workspace_id.to_string()),"Row tuple workspace delta was persisted");
      let (moved_source,projection)=databases.editing.task_source(actor_id,target_workspace_id,task_row).await.unwrap().unwrap();
      assert_eq!(moved_source.document_id,task_source);assert_eq!(moved_source.external_id,"moved-source-key");assert_eq!(moved_source.source_workspace_id,target_workspace_id);
      assert_eq!(moved_source.block_id.as_deref(),Some("source-text"));assert_eq!(moved_source.selection_anchor.as_deref(),Some(anchor.as_str()));assert!(projection.is_some());
      let moved_blockers = databases
        .views
        .task_blocking(actor_id, project.database.id, task_row, false, Some(10), None)
        .await
        .unwrap();
      assert!(moved_blockers.available);
      assert!(moved_blockers.diagnostics.is_empty());
      assert_eq!(moved_blockers.retained_row_ids, vec![task_parent]);
      assert_eq!(moved_blockers.rows.len(), 1);
      assert_eq!(
        moved_blockers.rows[0].state,
        myoxus_domain::database::DatabaseTaskBlockingState::Active
      );
      let moved_prerequisite = moved_blockers.rows[0].task.as_ref().unwrap();
      assert_eq!(moved_prerequisite.workspace_id, target_workspace_id);
      assert_eq!(moved_prerequisite.database_id, project.database.id);
      assert_eq!(moved_prerequisite.row_id, task_parent);

      for root in [
        resource(source_workspace_id, WorkspaceContentResourceKind::Folder, folder_id.clone()),
        resource(source_workspace_id, WorkspaceContentResourceKind::Database, empty_database.database.id.to_string()),
      ] {
        let request = WorkspaceContentOperationRequest {
          kind: WorkspaceContentOperationKind::Copy, source_workspace_id, target_workspace_id,
          selection: WorkspaceContentOperationSelection::Resources { resources: vec![root.clone()] },
          copy_document_acl: false, extract_workspace_name: None, git_sync_choice: None,
          link_entry_id: None, link_parent_id: None, link_index: None,
        };
        let prepared = graph_source.prepare(Uuid::nil(), Uuid::nil(), &request, Vec::new()).await.expect("preview admits actual empty content");
        let graph = WorkspaceContentGraphBuilder.build(prepared.input).expect("empty content graph");
        assert!(graph.blockers.is_empty(), "empty definitions are eligible: {:?}", graph.blockers);
        let mut authorized = WorkspaceContentAuthorizer::new(
          Arc::new(PermissionService::new(auth.clone())), PgWorkspaceContentAuthorizationSource::new(pool.clone()),
        ).preflight(actor_id, graph.clone(), prepared.authorization_options).await.expect("native folder settings acceptance");
        let mappings = graph.mappings.iter().map(|planned| planned.mapping.clone()).collect::<Vec<_>>();
        let mut draft = operation(Uuid::new_v4(), Uuid::new_v4(), actor_id, source_workspace_id, target_workspace_id, &"f".repeat(64));
        if root.kind() == WorkspaceContentResourceKind::Folder {
          assert!(authorized.revision.starts_with(OVERVIEW_PREVIEW_PREFIX), "SQL preparation supplies current overview facts");
          let legacy = operation(Uuid::new_v4(), Uuid::new_v4(), actor_id, source_workspace_id, target_workspace_id, &"e".repeat(64));
          let (legacy, _) = running_copy(&repository, legacy, mappings.clone(), false).await;
          reconcile.reconcile(&legacy).await.expect("stage deployed accepted folder plan");
          let rejected = service.publish(&legacy, "copy-overview-legacy").await.expect_err("new settings require a fresh deployed preview");
          assert!(matches!(rejected, AuthError::InvalidInput(code) if code == WorkspaceContentErrorCode::PreflightStale.as_str()));
          assert_eq!(workspace_store.get_workspace(target_workspace_id).await.unwrap().unwrap().overview_settings, target_configured.overview_settings,
            "legacy rejection rolls back every configuration write");
          let mut stale = operation(Uuid::new_v4(), Uuid::new_v4(), actor_id, source_workspace_id, target_workspace_id, &"d".repeat(64));
          stale.preview_revision = Some(authorized.revision.clone());
          let (stale, _) = running_copy(&repository, stale, mappings.clone(), false).await;
          reconcile.reconcile(&stale).await.expect("stage currently accepted overview");
          configure_overview(&pool, source_workspace_id, WorkspaceOverviewSettingsPatch {
            scope: OverviewSettingsScope::Folder(folder_id.clone()),
            introduction: Some(source_configured.overview_settings.folders[&folder_id].introduction.clone()),
            ..Default::default()
          }).await;
          let rejected = service.publish(&stale, "copy-overview-stale").await.expect_err("a queue delay cannot absorb a later settings revision");
          assert!(matches!(rejected, AuthError::InvalidInput(code) if code == WorkspaceContentErrorCode::PreflightStale.as_str()));
          assert_eq!(workspace_store.get_workspace(target_workspace_id).await.unwrap().unwrap().overview_settings, target_configured.overview_settings);
          let fresh = graph_source.prepare(Uuid::nil(), Uuid::nil(), &request, Vec::new()).await.unwrap();
          authorized = WorkspaceContentAuthorizer::new(
            Arc::new(PermissionService::new(auth.clone())), PgWorkspaceContentAuthorizationSource::new(pool.clone()),
          ).preflight(actor_id, graph.clone(), fresh.authorization_options).await.expect("fresh native overview acceptance");
        }
        draft.preview_revision = Some(authorized.revision);
        let (running, entries) = running_copy(&repository, draft, mappings.clone(), false).await;
        assert!(entries.is_empty(), "no invented document objects");
        reconcile.reconcile(&running).await.expect("stage actual definitions");
        let published = service.publish(&running, "copy-publication-test").await.expect("publish actual zero-document content");
        assert_eq!(published.status, WorkspaceContentOperationStatus::Succeeded);
        let target = mappings.iter().find(|mapping| mapping.source == root).unwrap().target.clone();
        if root.kind() == WorkspaceContentResourceKind::Folder {
          let target_snapshot = organizer.snapshot(target_workspace_id).await.unwrap();
          let copied_folder = target_snapshot.roots.iter().find(|node| node.row.id == target.resource_id()).unwrap();
          assert!(copied_folder.row.is_folder());
          assert_eq!(copied_folder.row.data, "Empty folder");
          assert_eq!(copied_folder.row.parent_id, None);
          let child_mapping = mappings.iter().find(|mapping| mapping.source.resource_id() == child_id).unwrap();
          let copied_child = copied_folder.children.iter().find(|node| node.row.id == child_mapping.target.resource_id()).unwrap();
          assert!(copied_child.row.is_folder());
          assert_eq!(copied_child.row.data, "Empty nested folder");
          assert_eq!(copied_child.row.parent_id.as_deref(), Some(target.resource_id()));
          assert!(copied_child.children.is_empty());
          let target_workspace = workspace_store.get_workspace(target_workspace_id).await.unwrap().unwrap();
          let copied = target_workspace.overview_settings.folders.get(target.resource_id()).expect("copied folder settings");
          assert_eq!(copied, source_configured.overview_settings.folders.get(&folder_id).unwrap(),
            "an unmapped introduction keeps its real source address, without copying another document");
          assert_eq!(target_workspace.overview_settings.introduction, target_configured.overview_settings.introduction);
          assert_eq!(target_workspace.overview_settings.folder_ids, target_configured.overview_settings.folder_ids);
          assert_eq!(target_workspace.overview_settings.register_presentation, target_configured.overview_settings.register_presentation,
            "Copy cannot overwrite the existing workspace defaults");
          assert_eq!(workspace_store.get_workspace(source_workspace_id).await.unwrap().unwrap().overview_settings, source_configured.overview_settings);
        } else {
          let mut copied = databases.import_export.export_workspace_content_snapshot(actor_id, Uuid::parse_str(target.resource_id()).unwrap())
            .await.expect("read actual copied Database");
          let mut expected = database_before.clone();
          assert_eq!(copied["source"]["databaseId"], target.resource_id());
          expected["source"]["databaseId"] = copied["source"]["databaseId"].clone();
          copied.as_object_mut().unwrap().remove("workspaceContentIdentityManifest");
          expected.as_object_mut().unwrap().remove("workspaceContentIdentityManifest");
          assert_eq!(copied, expected, "schema and views survive without rows");
        }
        assert_eq!(organizer.snapshot(source_workspace_id).await.unwrap(), source_before);
        assert_eq!(databases.import_export.export_workspace_content_snapshot(actor_id, empty_database.database.id).await.unwrap(), database_before);
      }
      organizer.delete_folder(source_workspace_id, &folder_id).await.unwrap();
      let missing_request = WorkspaceContentOperationRequest {
        kind: WorkspaceContentOperationKind::Copy, source_workspace_id, target_workspace_id,
        selection: WorkspaceContentOperationSelection::Resources { resources: vec![resource(source_workspace_id, WorkspaceContentResourceKind::Folder, folder_id)] },
        copy_document_acl: false, extract_workspace_name: None, git_sync_choice: None, link_entry_id: None, link_parent_id: None, link_index: None,
      };
      assert!(matches!(graph_source.prepare(Uuid::nil(), Uuid::nil(), &missing_request, Vec::new()).await,
        Err(AuthError::NotFound(cause)) if cause == WorkspaceContentErrorCode::SourceRootMissing.as_str()));

      let baseline_directory_updates:Vec<Vec<u8>>=sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id=$1 AND doc_id=$1 ORDER BY sequence")
        .bind(target_workspace_id).fetch_all(&pool).await.unwrap();
      let baseline_directory=yjs::merge_updates(baseline_directory_updates).unwrap();
      let baseline_page_ids=yjs::extract_workspace_root_metadata(&baseline_directory).unwrap().pages.into_iter().map(|page|page.id).collect::<BTreeSet<_>>();
      let expected_native_pages=copied_source_keys.iter().cloned().chain(std::iter::once("moved-source-key".to_string())).collect::<BTreeSet<_>>();
      assert_eq!(baseline_page_ids,expected_native_pages,"baseline consists exactly of independently mapped native Copy/Move pages");
      let initial_root_broadcasts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'workspace_doc_broadcast'",
      ).bind(target_workspace_id.to_string()).fetch_one(&pool).await.expect("capture completed definition broadcasts");
      let target_external_id = "published-document";
      let target_internal_id = Uuid::new_v4();
      let source_internal_id = Uuid::new_v4();
      sqlx::query(
        "INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by)
       VALUES ($1, $2, 'source-document', 'Source document', $3, $3)",
      )
      .bind(source_internal_id)
      .bind(source_workspace_id)
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect("seed Copy source document");
      sqlx::query("INSERT INTO workspace_doc_view_daily (workspace_id, doc_id, date, total_views) VALUES ($1, $2::text, CURRENT_DATE, 6)")
        .bind(source_workspace_id).bind(source_internal_id).execute(&pool).await.expect("source Copy statistics");
      let source_pending=seed_pending_document_change(&pool,source_workspace_id,source_internal_id,actor_id).await;
      sqlx::query(
        "INSERT INTO doc_user_permissions (user_id, doc_id, role)
       VALUES ($1, $3, 'Owner'), ($2, $3, 'Reader')",
      )
      .bind(actor_id)
      .bind(source_reader_id)
      .bind(source_internal_id)
      .execute(&pool)
      .await
      .expect("seed Copy source permissions");
      let mappings = vec![
        WorkspaceContentIdMapping::new(
          resource(
            source_workspace_id,
            WorkspaceContentResourceKind::Document,
            "source-document",
          ),
          resource(
            target_workspace_id,
            WorkspaceContentResourceKind::Document,
            target_external_id,
          ),
        )
        .unwrap(),
      ];
      let draft = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &"a".repeat(64),
      );
      let (running, entries) = running_copy(&repository, draft, mappings.clone(), true).await;
      assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE id = $1")
          .bind(target_internal_id)
          .fetch_one(&pool)
          .await
          .unwrap(),
        0,
        "staging must not expose a canonical target document"
      );
      let batch = WorkspaceContentCopyPublicationBatch {
        operation: running,
        mappings,
        staging_entries: entries,
        objects: vec![document_object(
          target_workspace_id,
          actor_id,
          target_external_id,
          target_internal_id,
          "Published copy",
        )],
      };
      let mut unsupported = batch.clone();
      unsupported.mappings.push(
        WorkspaceContentIdMapping::new(
          resource(source_workspace_id, WorkspaceContentResourceKind::Collection, "legacy"),
          resource(
            target_workspace_id,
            WorkspaceContentResourceKind::Collection,
            "legacy-target",
          ),
        )
        .unwrap(),
      );
      assert!(matches!(publisher.publish_copy(unsupported, "copy-legacy-plan").await,
      Err(error) if error.failure.code == WorkspaceContentErrorCode::SelectedResourceUnsupported));
      assert_eq!(
        repository.get(batch.operation.id).await.unwrap().unwrap().status,
        WorkspaceContentOperationStatus::Running
      );
      assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE id = $1")
          .bind(target_internal_id)
          .fetch_one(&pool)
          .await
          .unwrap(),
        0,
        "historical Collection ownership plans cannot write a target"
      );
      let published = publisher
        .publish_copy(batch.clone(), "copy-publication-test")
        .await
        .expect("publish Copy atomically");
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM document_change_batches WHERE doc_id=$1")
        .bind(target_internal_id).fetch_one(&pool).await.unwrap(),0,"copies carry no source window");
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM document_change_batch_actors WHERE batch_id=$1")
        .bind(source_pending).fetch_one(&pool).await.unwrap(),1,"Copy leaves source pending facts intact");
      assert_eq!(published.status, WorkspaceContentOperationStatus::Succeeded);
      assert_eq!(sqlx::query_scalar::<_, i64>("SELECT total_views FROM workspace_doc_view_daily WHERE workspace_id=$1 AND doc_id=$2::text")
        .bind(source_workspace_id).bind(source_internal_id).fetch_one(&pool).await.unwrap(), 6);
      assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_doc_view_daily WHERE workspace_id=$1 AND doc_id=$2::text")
        .bind(target_workspace_id).bind(target_internal_id).fetch_one(&pool).await.unwrap(), 0, "Copy starts fresh destination statistics");
      let replay_publisher = PgWorkspaceContentCopyPublicationRepository::new(pool.clone(), storage.clone(), crate::helpers::database_starter_catalog());
      assert_eq!(
        replay_publisher
          .publish_copy(batch, "copy-publication-replay")
          .await
          .expect("a fresh publication instance replays Copy idempotently")
          .id,
        published.id
      );
      let directory_updates = sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT payload FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1 ORDER BY sequence",
      )
      .bind(target_workspace_id)
      .fetch_all(&pool)
      .await
      .expect("read published target directory");
      let directory = yjs::merge_updates(directory_updates).expect("merge target directory");
      let pages = yjs::extract_workspace_root_metadata(&directory)
        .expect("read browser page directory")
        .pages;
      let mut expected_page_ids=baseline_page_ids.clone();expected_page_ids.insert(target_external_id.to_string());
      let actual_page_ids=pages.iter().map(|page|page.id.clone()).collect::<BTreeSet<_>>();
      assert_eq!(actual_page_ids,expected_page_ids,"Copy+replay adds exactly the admitted target identity, no alternative duplicate IDs");
      assert_eq!(pages.len(),expected_page_ids.len(),"Copy replay cannot duplicate a directory entry under the same ID");
      let published_pages=pages.iter().filter(|page| page.id == target_external_id).collect::<Vec<_>>();
      assert_eq!(published_pages.len(),1,"Copy replay must not duplicate the exact browser directory entry");
      assert_eq!(published_pages[0].title.as_deref(),Some("Published copy"));
      for key in copied_source_keys.iter().map(String::as_str).chain(std::iter::once("moved-source-key")) {
        let source_pages=pages.iter().filter(|page|page.id==key).collect::<Vec<_>>();
        assert_eq!(source_pages.len(),1,"each independently admitted source copy/move appears once for {key}");
        assert_eq!(source_pages[0].title.as_deref(),Some("Source document"));
      }
      let root_broadcasts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'workspace_doc_broadcast'",
      )
      .bind(target_workspace_id.to_string())
      .fetch_one(&pool)
      .await
      .expect("read directory broadcasts");
      assert_eq!(
        root_broadcasts, initial_root_broadcasts + 1,
        "Copy must notify connected target clients exactly once"
      );
      let document = sqlx::query(
        "SELECT title, public_mode, default_role FROM docs
       WHERE workspace_id = $1 AND external_id = $2",
      )
      .bind(target_workspace_id)
      .bind(target_external_id)
      .fetch_one(&pool)
      .await
      .expect("published document");
      assert_eq!(document.get::<String, _>("title"), "Published copy");
      assert_eq!(document.get::<Option<String>, _>("public_mode"), None);
      assert_eq!(document.get::<String, _>("default_role"), "viewer");
      let target_permissions: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT user_id, role FROM doc_user_permissions
       WHERE doc_id = $1 ORDER BY user_id, role",
      )
      .bind(target_internal_id)
      .fetch_all(&pool)
      .await
      .expect("read copied document permissions");
      assert_eq!(
        target_permissions,
        vec![(actor_id, "Owner".to_string())],
        "Copy must materialize exactly the actor Owner role and never clone source permissions"
      );
      assert_eq!(
        sqlx::query_scalar::<_, i64>(
          "SELECT count(*) FROM workspace_content_copy_publications WHERE operation_id = $1",
        )
        .bind(published.id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
      );
      let rollback_external_id = "must-rollback";
      let rollback_internal_id = Uuid::new_v4();
      let conflict_internal_id = Uuid::new_v4();
      sqlx::query(
        "INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by)
       VALUES ($1, $2, $3, 'Existing target', $4, $4)",
      )
      .bind(conflict_internal_id)
      .bind(target_workspace_id)
      .bind(target_external_id)
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect_err("the successful publication already owns the external identity");
      let rollback_mappings = vec![
        WorkspaceContentIdMapping::new(
          resource(
            source_workspace_id,
            WorkspaceContentResourceKind::Document,
            "rollback-source",
          ),
          resource(
            target_workspace_id,
            WorkspaceContentResourceKind::Document,
            rollback_external_id,
          ),
        )
        .unwrap(),
        WorkspaceContentIdMapping::new(
          resource(
            source_workspace_id,
            WorkspaceContentResourceKind::Document,
            "conflict-source",
          ),
          resource(
            target_workspace_id,
            WorkspaceContentResourceKind::Document,
            target_external_id,
          ),
        )
        .unwrap(),
      ];
      let rollback_draft = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &"b".repeat(64),
      );
      let rollback_blob_key = Uuid::new_v5(&rollback_draft.id, b"rollback-private-asset").to_string();
      let mut rollback_mappings = rollback_mappings;
      rollback_mappings.push(WorkspaceContentIdMapping::new(
        resource(source_workspace_id, WorkspaceContentResourceKind::Blob, "rollback-source-asset"),
        resource(target_workspace_id, WorkspaceContentResourceKind::Blob, &rollback_blob_key),
      ).unwrap());
      let (rollback_running, rollback_entries) =
        running_copy(&repository, rollback_draft, rollback_mappings.clone(), true).await;
      let interleaved_storage = Arc::new(InterleavedPublicationStorage {
        inner: storage.clone(), paused_key: format!("{target_workspace_id}/{rollback_blob_key}"),
        written: tokio::sync::Notify::new(), resume: tokio::sync::Notify::new(),
        reject_deletes: false,
      });
      let interleaved_publisher = PgWorkspaceContentCopyPublicationRepository::new(pool.clone(), interleaved_storage.clone(), crate::helpers::database_starter_catalog());
      let concurrent_draft = operation(Uuid::new_v4(), Uuid::new_v4(), actor_id, source_workspace_id, target_workspace_id, &"e".repeat(64));
      let concurrent_key = Uuid::new_v5(&concurrent_draft.id, b"concurrent-private-asset").to_string();
      let concurrent_mappings = vec![
        WorkspaceContentIdMapping::new(resource(source_workspace_id, WorkspaceContentResourceKind::Document, "concurrent-source"), resource(target_workspace_id, WorkspaceContentResourceKind::Document, "concurrent-target")).unwrap(),
        WorkspaceContentIdMapping::new(resource(source_workspace_id, WorkspaceContentResourceKind::Blob, "rollback-source-asset"), resource(target_workspace_id, WorkspaceContentResourceKind::Blob, &concurrent_key)).unwrap(),
      ];
      let (concurrent_running, concurrent_entries) = running_copy(&repository, concurrent_draft, concurrent_mappings.clone(), true).await;
      let concurrent_batch = WorkspaceContentCopyPublicationBatch {
        operation: concurrent_running, mappings: concurrent_mappings, staging_entries: concurrent_entries,
        objects: vec![WorkspaceContentPublicationObject::Blob {
          resource: resource(target_workspace_id, WorkspaceContentResourceKind::Blob, &concurrent_key),
          bytes: Bytes::from_static(b"operation-owned-before-failed-SQL"), content_type: "application/octet-stream".into(),
        }, document_object(target_workspace_id, actor_id, "concurrent-target", Uuid::new_v4(), "Concurrent committed copy")],
      };
      let rollback_publication = interleaved_publisher
        .publish_copy(
          WorkspaceContentCopyPublicationBatch {
            operation: rollback_running.clone(),
            mappings: rollback_mappings,
            staging_entries: rollback_entries,
            objects: vec![
              WorkspaceContentPublicationObject::Blob {
                resource: resource(target_workspace_id, WorkspaceContentResourceKind::Blob, &rollback_blob_key),
                bytes: Bytes::from_static(b"operation-owned-before-failed-SQL"),
                content_type: "application/octet-stream".into(),
              },
              document_object(
                target_workspace_id,
                actor_id,
                rollback_external_id,
                rollback_internal_id,
                "Rolled back",
              ),
              document_object(
                target_workspace_id,
                actor_id,
                target_external_id,
                Uuid::new_v4(),
                "Conflicting copy",
              ),
            ],
          },
          "copy-publication-test",
        );
      let (rollback_result, committed) = tokio::join!(rollback_publication, async {
        interleaved_storage.written.notified().await;
        let committed = interleaved_publisher.publish_copy(concurrent_batch.clone(), "copy-interleaved-publication").await;
        interleaved_storage.resume.notify_one();
        committed
      });
      let committed = committed.expect("the second publication commits while the first is paused before SQL");
      assert_eq!(committed.status, WorkspaceContentOperationStatus::Succeeded);
      assert_eq!(storage.read_blob(&format!("{target_workspace_id}/{concurrent_key}")).await.unwrap().data,
        Bytes::from_static(b"operation-owned-before-failed-SQL"), "another operation's compensation cannot delete the committed asset");
      assert_eq!(interleaved_publisher.publish_copy(concurrent_batch, "copy-lost-commit-ack-replay").await.unwrap().id, committed.id,
        "a caller retaining its pre-commit Running record recovers the committed receipt");
      let failure = rollback_result.expect_err("a target identity conflict must abort publication");
      assert_eq!(failure.failure.code, WorkspaceContentErrorCode::DatabaseUniqueConstraint);
      assert_eq!(failure.failure.phase.as_deref(), Some("publication"));
      let rollback_storage_key = format!("{target_workspace_id}/{rollback_blob_key}");
      assert!(matches!(storage.read_blob(&rollback_storage_key).await, Err(PortError::NotFound(_))),
        "proved rolled-back SQL must compensate only its private materialization");
      let owned_intent: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_content_operation_compensations WHERE operation_id=$1 AND kind='delete_operation_blob' AND target_id=$2)")
        .bind(rollback_running.id).bind(&rollback_blob_key).fetch_one(&pool).await.unwrap();
      assert!(owned_intent, "materialization must have a durable ownership intent");
      assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE id = $1")
          .bind(rollback_internal_id)
          .fetch_one(&pool)
          .await
          .unwrap(),
        0,
        "a later conflict must roll back earlier rows in the same publication"
      );
      assert_eq!(
        repository.get(rollback_running.id).await.unwrap().unwrap().status,
        WorkspaceContentOperationStatus::Running,
        "a rolled-back publication remains durably resumable"
      );

      let source_tag_id = Uuid::new_v4();
      let historical_source_tag_id = Uuid::new_v4();
      sqlx::query("INSERT INTO workspace_tags (id,workspace_id,name,slug,color_role,description,archived_at) VALUES ($1,$3,'Source tag','source-tag','tag.blue','Copied tag',NULL),($2,$3,'Source tag','source-tag-historical','tag.green',NULL,now())")
        .bind(source_tag_id).bind(historical_source_tag_id).bind(source_workspace_id).execute(&pool).await.expect("seed active and historical classifications");
      sqlx::query("INSERT INTO workspace_tag_document_assignments (workspace_id,doc_id,tag_id,position) VALUES ($1,$2,$3,0),($1,$2,$4,1)")
        .bind(source_workspace_id).bind(source_internal_id).bind(source_tag_id).bind(historical_source_tag_id).execute(&pool).await.expect("retain a document sharing both source classifications");
      let target_tag_id = Uuid::new_v4();
      let tagged_doc_id = Uuid::new_v4();
      let tagged_doc_external_id = "tagged-document";
      let blob_key = "copied-asset.bin";
      let mut rich_mappings = vec![
        WorkspaceContentIdMapping::new(
          resource(
            source_workspace_id,
            WorkspaceContentResourceKind::Document,
            "tagged-source-document",
          ),
          resource(
            target_workspace_id,
            WorkspaceContentResourceKind::Document,
            tagged_doc_external_id,
          ),
        )
        .unwrap(),
        WorkspaceContentIdMapping::new(
          resource(
            source_workspace_id,
            WorkspaceContentResourceKind::Blob,
            "source-asset.bin",
          ),
          resource(target_workspace_id, WorkspaceContentResourceKind::Blob, blob_key),
        )
        .unwrap(),
        WorkspaceContentIdMapping::new(
          resource(
            source_workspace_id,
            WorkspaceContentResourceKind::Tag,
            source_tag_id.to_string(),
          ),
          resource(
            target_workspace_id,
            WorkspaceContentResourceKind::Tag,
            target_tag_id.to_string(),
          ),
        )
        .unwrap(),
      ];
      rich_mappings.push(WorkspaceContentIdMapping::new(
        resource(source_workspace_id, WorkspaceContentResourceKind::Tag, historical_source_tag_id.to_string()),
        resource(target_workspace_id, WorkspaceContentResourceKind::Tag, target_tag_id.to_string()),
      ).unwrap());
      let rich_draft = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &"c".repeat(64),
      );
      let (rich_running, rich_entries) = running_copy(&repository, rich_draft, rich_mappings.clone(), true).await;
      let target_tag_resource = resource(
        target_workspace_id,
        WorkspaceContentResourceKind::Tag,
        target_tag_id.to_string(),
      );
      let mut tag_envelope = WorkspaceContentReconcileEnvelope {
        tag_sources: Vec::new(),
        schema_version: TAG_SCHEMA_VERSION,
        operation_id: rich_running.id,
        source: resource(
          source_workspace_id,
          WorkspaceContentResourceKind::Tag,
          source_tag_id.to_string(),
        ),
        target: target_tag_resource.clone(),
        action: WorkspaceContentReconcileAction::Create,
        target_name: "Source tag".to_string(),
        schema_hash: hex::encode(Sha256::digest(b"{\"archived\":false,\"colorRole\":\"tag.blue\",\"description\":\"Copied tag\"}")),
        reference_mappings: Default::default(),
        nested_mappings: Default::default(),
        payload: serde_json::json!({
          "id": source_tag_id,
          "workspace_id": source_workspace_id,
          "name": "Source tag",
          "slug": "source-tag",
          "color_role": "tag.blue",
          "description": "Copied tag",
          "archived_at": null,
          "created_at": Utc::now(),
          "updated_at": Utc::now(),
          "created_by": actor_id,
          "updated_by": actor_id
        }),
      };
      let mut historical_payload = tag_envelope.payload.clone();
      historical_payload["id"] = serde_json::json!(historical_source_tag_id);
      historical_payload["color_role"] = serde_json::json!("tag.green");
      historical_payload["archived_at"] = serde_json::json!(Utc::now());
      tag_envelope.tag_sources = vec![
        WorkspaceContentDefinition { resource: tag_envelope.source.clone(), name: "Source tag".into(), schema: serde_json::json!({"archived":false,"colorRole":"tag.blue","description":"Copied tag"}), payload: tag_envelope.payload.clone() },
        WorkspaceContentDefinition { resource: resource(source_workspace_id, WorkspaceContentResourceKind::Tag, historical_source_tag_id.to_string()), name: "Source tag".into(), schema: serde_json::json!({"archived":true,"colorRole":"tag.green"}), payload: historical_payload },
      ];
      let mut tagged_document = document_object(
        target_workspace_id,
        actor_id,
        tagged_doc_external_id,
        tagged_doc_id,
        "Tagged copy",
      );
      let WorkspaceContentPublicationObject::Document { tag_ids, .. } = &mut tagged_document else {
        unreachable!("document helper returns a document object");
      };
      tag_ids.push(target_tag_id);
      let blob_bytes = Bytes::from_static(b"atomic blob");
      let rich = publisher
        .publish_copy(
          WorkspaceContentCopyPublicationBatch {
            operation: rich_running.clone(),
            mappings: rich_mappings,
            staging_entries: rich_entries,
            objects: vec![
              tagged_document,
              WorkspaceContentPublicationObject::Blob {
                resource: resource(target_workspace_id, WorkspaceContentResourceKind::Blob, blob_key),
                bytes: blob_bytes.clone(),
                content_type: "application/octet-stream".to_string(),
              },
              WorkspaceContentPublicationObject::Reconciled {
                resource: target_tag_resource,
                envelope: tag_envelope,
              },
            ],
          },
          "copy-publication-test",
        )
        .await
        .expect("publish document, Tag and Blob in one commit");
      assert_eq!(rich.status, WorkspaceContentOperationStatus::Succeeded);
      assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_tags WHERE workspace_id=$1 AND id IN ($2,$3)")
        .bind(source_workspace_id).bind(source_tag_id).bind(historical_source_tag_id).fetch_one(&pool).await.unwrap(),2,"Copy retains both source catalog records");
      assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_tag_document_assignments WHERE workspace_id=$1 AND doc_id=$2 AND tag_id IN ($3,$4)")
        .bind(source_workspace_id).bind(source_internal_id).bind(source_tag_id).bind(historical_source_tag_id).fetch_one(&pool).await.unwrap(),2,"Retained source assignments stay intact");
      assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_tags WHERE workspace_id=$1")
        .bind(target_workspace_id).fetch_one(&pool).await.unwrap(),1,"Many-to-one classification materializes one catalog row");
      assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_content_operation_mappings WHERE operation_id=$1 AND target_kind='tag' AND target_id=$2")
        .bind(rich.id).bind(target_tag_id.to_string()).fetch_one(&pool).await.unwrap(),2,"Both admitted Tag mappings survive the receipt");
      assert_eq!(
        sqlx::query_scalar::<_, i64>(
          "SELECT count(*) FROM workspace_tag_document_assignments
         WHERE workspace_id = $1 AND doc_id = $2 AND tag_id = $3",
        )
        .bind(target_workspace_id)
        .bind(tagged_doc_id)
        .bind(target_tag_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
      );
      assert_eq!(
        sqlx::query_scalar::<_, i64>(
          "SELECT count(*) FROM blobs
         WHERE workspace_id = $1 AND key = $2 AND status = 'completed' AND deleted_at IS NULL",
        )
        .bind(target_workspace_id)
        .bind(blob_key)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
      );
      assert_eq!(
        myoxus_application::ports::BlobStoragePort::read_blob(
          storage.as_ref(),
          &format!("{target_workspace_id}/{blob_key}"),
        )
        .await
        .expect("committed Blob bytes")
        .data,
        blob_bytes
      );

      sqlx::query("UPDATE workspaces SET storage_quota_bytes = 1 WHERE id = $1")
        .bind(target_workspace_id)
        .execute(&pool)
        .await
        .expect("set a restrictive target policy");
      let quota_doc_id = Uuid::new_v4();
      let quota_blob_key = "quota-rejected.bin";
      let quota_mappings = vec![
        WorkspaceContentIdMapping::new(
          resource(
            source_workspace_id,
            WorkspaceContentResourceKind::Document,
            "quota-source-document",
          ),
          resource(
            target_workspace_id,
            WorkspaceContentResourceKind::Document,
            "quota-target-document",
          ),
        )
        .unwrap(),
        WorkspaceContentIdMapping::new(
          resource(
            source_workspace_id,
            WorkspaceContentResourceKind::Blob,
            "quota-source.bin",
          ),
          resource(target_workspace_id, WorkspaceContentResourceKind::Blob, quota_blob_key),
        )
        .unwrap(),
      ];
      let quota_draft = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &"e".repeat(64),
      );
      let (quota_running, quota_entries) = running_copy(&repository, quota_draft, quota_mappings.clone(), true).await;
      assert!(matches!(
        publisher
          .publish_copy(
            WorkspaceContentCopyPublicationBatch {
              operation: quota_running.clone(),
              mappings: quota_mappings,
              staging_entries: quota_entries,
              objects: vec![
                document_object(
                  target_workspace_id,
                  actor_id,
                  "quota-target-document",
                  quota_doc_id,
                  "Quota rejected",
                ),
                WorkspaceContentPublicationObject::Blob {
                  resource: resource(target_workspace_id, WorkspaceContentResourceKind::Blob, quota_blob_key,),
                  bytes: Bytes::from_static(b"exceeds quota"),
                  content_type: "application/octet-stream".to_string(),
                },
              ],
            },
            "copy-publication-test",
          )
          .await,
        Err(error) if error.failure.code == WorkspaceContentErrorCode::TargetStorageLimit
      ));
      assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE id = $1")
          .bind(quota_doc_id)
          .fetch_one(&pool)
          .await
          .unwrap(),
        0,
        "target policy rejection must leave canonical SQL unchanged"
      );
      assert!(matches!(
        myoxus_application::ports::BlobStoragePort::read_blob(
          storage.as_ref(),
          &format!("{target_workspace_id}/{quota_blob_key}"),
        )
        .await,
        Err(myoxus_application::ports::PortError::NotFound(_))
      ));

      sqlx::query("DELETE FROM workspace_content_operations WHERE id = ANY($1)")
        .bind([published.id, rollback_running.id, rich.id, quota_running.id, committed.id])
        .execute(&pool)
        .await
        .expect("delete Copy operations");
    })
    .catch_unwind()
    .await;
    sqlx::query("DELETE FROM workspace_content_operations WHERE source_workspace_id = $1 OR target_workspace_id = $2")
      .bind(source_workspace_id)
      .bind(target_workspace_id)
      .execute(&pool)
      .await
      .expect("clean exact publication fixtures after assertions");
    helpers::cleanup_workspaces(&pool, &[source_workspace_id, target_workspace_id]).await;
    helpers::cleanup_users(&pool, &[actor_id, source_reader_id]).await;
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  });
}

#[test]
fn copy_publication_uses_confirmed_staging_after_source_changes() {
  helpers::block_on_large_stack(
    "copy_publication_uses_confirmed_staging_after_source_changes",
    || async {
      let (_app, pool, auth) = helpers::setup_app().await;
      let (actor_id, _session) = helpers::seed_user(&pool, &auth, "xws_copy_snapshot_actor").await;
      let source_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      let target_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      let source_doc_id = Uuid::new_v4();
      sqlx::query(
        "INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by)
       VALUES ($1, $2, 'snapshot-source', 'Old source title', $3, $3)",
      )
      .bind(source_doc_id)
      .bind(source_workspace_id)
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect("seed Copy source document");
      sqlx::query(
        "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $2, $3, 1)",
      )
      .bind(source_doc_id)
      .bind(source_workspace_id)
      .bind(vec![0_u8, 0])
      .execute(&pool)
      .await
      .expect("seed confirmed source bytes");

      let repository = Arc::new(PgWorkspaceContentOperationRepository::new(
        pool.clone(),
        crate::helpers::database_starter_catalog(),
      ));
      let storage_root = tempfile::tempdir().expect("temporary Copy snapshot storage");
      let storage = Arc::new(
        StorageAdapter::new_fs(storage_root.path().to_str().expect("UTF-8 storage path"))
          .expect("Copy snapshot storage"),
      );
      let publisher = Arc::new(RecordingCopyPublisher::default());
      let target_doc_id = Uuid::new_v4();
      let mapping = WorkspaceContentIdMapping::new(
        resource(
          source_workspace_id,
          WorkspaceContentResourceKind::Document,
          "snapshot-source",
        ),
        resource(
          target_workspace_id,
          WorkspaceContentResourceKind::Document,
          "snapshot-target",
        ),
      )
      .expect("Copy snapshot mapping");
      let staged_bytes = vec![0_u8, 0];
      let staged_body = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 3,
        "referencePlan": {"version": 2, "source": mapping.source,
          "snapshot_sha256": hex::encode(Sha256::digest(&staged_bytes)), "occurrences": []},
        "sourceHash": hex::encode(Sha256::digest(&staged_bytes)),
        "targetDocId": target_doc_id,
        "title": "Old source title",
        "yjsUpdateBase64": STANDARD.encode(&staged_bytes),
        "metadata": {},
        "tagIds": []
      }))
      .expect("encode staged Copy document");
      let content_hash = hex::encode(Sha256::digest(&staged_body));
      let mut record = operation(
        Uuid::new_v4(),
        Uuid::new_v4(),
        actor_id,
        source_workspace_id,
        target_workspace_id,
        &"7".repeat(64),
      );
      let object_key = format!("workspace-content/{}/objects/{content_hash}", record.id);
      let entry = WorkspaceContentStagingEntry::new(
        record.id,
        0,
        mapping.target.clone(),
        object_key.clone(),
        content_hash,
        staged_body.len() as i64,
      )
      .expect("Copy snapshot staging entry");
      repository
        .create_or_get(record.clone())
        .await
        .expect("create Copy snapshot operation");
      repository
        .store_manifest(
          record.id,
          &record.manifest_hash,
          std::slice::from_ref(&mapping),
          std::slice::from_ref(&entry),
        )
        .await
        .expect("store immutable Copy snapshot manifest");
      storage
        .write_blob(BlobWriteRequest {
          key: object_key,
          content_type: Some("application/vnd.myoxus.workspace-content-document+json".to_string()),
          body: Bytes::from(staged_body),
        })
        .await
        .expect("materialize confirmed Copy snapshot");
      for (from, to, diagnostic_instance_id) in [
        (
          WorkspaceContentOperationStatus::Draft,
          WorkspaceContentOperationStatus::Previewed,
          None,
        ),
        (
          WorkspaceContentOperationStatus::Previewed,
          WorkspaceContentOperationStatus::Queued,
          None,
        ),
        (
          WorkspaceContentOperationStatus::Queued,
          WorkspaceContentOperationStatus::Running,
          Some("copy-snapshot-test"),
        ),
      ] {
        record = repository
          .transition(record.id, from, to, None, diagnostic_instance_id)
          .await
          .expect("advance Copy snapshot operation");
      }

      sqlx::query("UPDATE docs SET title = 'New source title', updated_at = now() WHERE id = $1")
        .bind(source_doc_id)
        .execute(&pool)
        .await
        .expect("source metadata write remains available after staging");
      sqlx::query(
        "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $2, $3, 2)",
      )
      .bind(source_doc_id)
      .bind(source_workspace_id)
      .bind(vec![9_u8, 9])
      .execute(&pool)
      .await
      .expect("source payload write remains available after staging");

      let service = WorkspaceContentCopyPublicationService::new(
        repository.clone(),
        repository.clone(),
        Arc::new(NoReuseReconcileSource),
        storage.clone(),
        publisher.clone(),
      );
      service
        .publish(&record, "copy-snapshot-test")
        .await
        .expect("publish the confirmed immutable Copy snapshot");
      let batches = publisher.batches.lock().expect("recording publisher lock");
      let WorkspaceContentPublicationObject::Document { title, yjs_update, .. } = &batches[0].objects[0] else {
        panic!("Copy snapshot must publish a document object");
      };
      assert_eq!(title, "Old source title");
      assert_eq!(yjs_update, &staged_bytes);
      drop(batches);

      sqlx::query("DELETE FROM workspace_content_operations WHERE id = $1")
        .bind(record.id)
        .execute(&pool)
        .await
        .expect("delete Copy snapshot operation");
      helpers::cleanup_workspaces(&pool, &[source_workspace_id, target_workspace_id]).await;
      helpers::cleanup_users(&pool, &[actor_id]).await;
    },
  );
}

#[test]
fn move_manifest_rejects_each_authoritative_revision_family() {
  helpers::block_on_large_stack("move_manifest_rejects_each_authoritative_revision_family", || async {
    let (_app, pool, auth) = helpers::setup_app().await;
    let (actor_id, _session) = helpers::seed_user(&pool, &auth, "xws_move_manifest_actor").await;
    let (other_user_id, _session) = helpers::seed_user(&pool, &auth, "xws_move_manifest_other").await;
    let source_workspace_id = helpers::create_workspace(&pool, actor_id).await;
    let target_workspace_id = helpers::create_workspace(&pool, actor_id).await;
    let catalog_id = Uuid::new_v4();
    use futures_util::FutureExt;
    let outcome = std::panic::AssertUnwindSafe(async {
    seed_organizer_root(&pool, source_workspace_id, actor_id).await;
    seed_organizer_root(&pool, target_workspace_id, actor_id).await;
    let repository = Arc::new(PgWorkspaceContentOperationRepository::new(pool.clone(), crate::helpers::database_starter_catalog()));
    let storage_root = tempfile::tempdir().expect("temporary Move manifest storage");
    let storage = Arc::new(
      StorageAdapter::new_fs(storage_root.path().to_str().expect("UTF-8 storage path")).expect("Move manifest storage"),
    );
    let publisher = PgWorkspaceContentMovePublicationRepository::new(pool.clone(), storage, crate::helpers::database_starter_catalog());
    let doc_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO docs
         (id, workspace_id, external_id, title, created_by, updated_by)
       VALUES ($1, $2, 'manifest-source', 'Manifest source', $3, $3)",
    )
    .bind(doc_id)
    .bind(source_workspace_id)
    .bind(actor_id)
    .execute(&pool)
    .await
    .expect("seed Move manifest document");
    sqlx::query(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $2, $3, 1)",
    )
    .bind(doc_id)
    .bind(source_workspace_id)
    .bind(vec![0_u8, 0])
    .execute(&pool)
    .await
    .expect("seed Move manifest document content");
    sqlx::query(
      "INSERT INTO doc_user_permissions (user_id, doc_id, role)
       VALUES ($1, $2, 'Owner') ON CONFLICT DO NOTHING",
    )
    .bind(actor_id)
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("seed Move manifest ACL");
    let mapping = WorkspaceContentIdMapping::new(
      resource(
        source_workspace_id,
        WorkspaceContentResourceKind::Document,
        "manifest-source",
      ),
      resource(
        target_workspace_id,
        WorkspaceContentResourceKind::Document,
        "manifest-target",
      ),
    )
    .expect("Move manifest document mapping");

    for drift in [
      "document-content",
      "document-metadata",
      "document-acl",
      "organizer",
      "membership",
      "ownership",
      "policy",
    ] {
      let batch = prepared_move_batch(
        &pool, &repository,
        actor_id,
        source_workspace_id,
        target_workspace_id,
        vec![mapping.clone()],
        None,
      )
      .await;
      match drift {
        "document-content" => {
          sqlx::query(
            "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
             VALUES ($1, $2, $3, 2)",
          )
          .bind(doc_id)
          .bind(source_workspace_id)
          .bind(yjs::markdown_to_yjs("Manifest source", "Content changed after preview").unwrap())
          .execute(&pool)
          .await
          .expect("change document content after Move snapshot");
        }
        "document-metadata" => {
          sqlx::query(
            "UPDATE docs
             SET title = 'Changed after snapshot',
                 metadata_revision = metadata_revision + 1,
                 updated_at = now()
             WHERE id = $1",
          )
          .bind(doc_id)
          .execute(&pool)
          .await
          .expect("change document metadata after Move snapshot");
        }
        "document-acl" => {
          sqlx::query(
            "INSERT INTO doc_user_permissions (user_id, doc_id, role)
             VALUES ($1, $2, 'Reader')",
          )
          .bind(other_user_id)
          .bind(doc_id)
          .execute(&pool)
          .await
          .expect("change document ACL after Move snapshot");
        }
        "organizer" => {
          let sequence: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(sequence), 0) + 1 FROM doc_updates WHERE doc_id = $1")
              .bind(source_workspace_id)
              .fetch_one(&pool)
              .await
              .expect("derive organizer sequence");
          sqlx::query(
            "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
             VALUES ($1, $1, $2, $3)",
          )
          .bind(source_workspace_id)
          .bind(yjs::create_initial_workspace_doc("Organizer changed after preview"))
          .bind(sequence)
          .execute(&pool)
          .await
          .expect("change organizer after Move snapshot");
        }
        "membership" => {
          helpers::add_workspace_member(&pool, source_workspace_id, other_user_id).await;
        }
        "ownership" => {
          sqlx::query(
            "UPDATE workspaces
             SET owner_user_id = $2,
                 owner_principal_type = 'user',
                 owner_principal_id = $2,
                 updated_at = now()
             WHERE id = $1",
          )
          .bind(source_workspace_id)
          .bind(other_user_id)
          .execute(&pool)
          .await
          .expect("change workspace ownership after Move snapshot");
        }
        "policy" => {
          sqlx::query("UPDATE workspaces SET enable_sharing = NOT enable_sharing, updated_at = now() WHERE id = $1")
            .bind(target_workspace_id)
            .execute(&pool)
            .await
            .expect("change target policy after Move snapshot");
        }
        _ => unreachable!(),
      }

      let outcome = publisher.publish_move(batch.clone(), "move-manifest-drift-test").await;
      let expected_failure = match drift {
        "document-content" => Some(WorkspaceContentErrorCode::MoveContentRevisionChanged),
        "organizer" => Some(WorkspaceContentErrorCode::MoveWorkspaceRootChanged),
        "membership" => Some(WorkspaceContentErrorCode::MoveRecipientSnapshotChanged),
        _ => None,
      };
      let blocks_publication = expected_failure.is_some();
      if let Some(expected_failure) = expected_failure {
        let error = outcome.expect_err("changed content or notification recipients must reject drift");
        assert_eq!(
          error.failure.code,
          expected_failure,
          "{drift} drift must retain its precise publication condition"
        );
      } else {
        assert_eq!(
          outcome
            .expect("live metadata, ACL, owner and policy changes must not revoke admitted Move")
            .status,
          WorkspaceContentOperationStatus::Succeeded
        );
        if drift == "document-metadata" {
          assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT title FROM docs WHERE id = $1")
              .bind(doc_id)
              .fetch_one(&pool)
              .await
              .expect("read live metadata"),
            "Changed after snapshot"
          );
        }
        if drift == "document-acl" {
          assert_eq!(
            sqlx::query_scalar::<_, String>(
              "SELECT role::text FROM doc_user_permissions WHERE doc_id = $1 AND user_id = $2"
            )
            .bind(doc_id)
            .bind(other_user_id)
            .fetch_one(&pool)
            .await
            .expect("read live grant"),
            "Reader"
          );
        }
      }
      assert_eq!(
        sqlx::query_scalar::<_, Uuid>("SELECT workspace_id FROM docs WHERE id = $1")
          .bind(doc_id)
          .fetch_one(&pool)
          .await
          .expect("read document owner"),
        if blocks_publication {
          source_workspace_id
        } else {
          target_workspace_id
        },
      );
      if !blocks_publication {
        sqlx::query("UPDATE docs SET workspace_id = $2, external_id = 'manifest-source' WHERE id = $1")
          .bind(doc_id)
          .bind(source_workspace_id)
          .execute(&pool)
          .await
          .expect("restore document fixture ownership");
        sqlx::query("UPDATE doc_updates SET workspace_id = $2 WHERE doc_id = $1")
          .bind(doc_id)
          .bind(source_workspace_id)
          .execute(&pool)
          .await
          .expect("restore update fixture ownership");
      }

      match drift {
        "document-content" => {
          sqlx::query("DELETE FROM doc_updates WHERE doc_id = $1 AND sequence = 2")
            .bind(doc_id)
            .execute(&pool)
            .await
            .expect("restore document content fixture");
        }
        "document-metadata" => {
          sqlx::query(
            "UPDATE docs
             SET title = 'Manifest source',
                 metadata_revision = metadata_revision + 1,
                 updated_at = now()
             WHERE id = $1",
          )
          .bind(doc_id)
          .execute(&pool)
          .await
          .expect("restore document metadata fixture");
        }
        "document-acl" => {
          sqlx::query("DELETE FROM doc_user_permissions WHERE user_id = $1 AND doc_id = $2")
            .bind(other_user_id)
            .bind(doc_id)
            .execute(&pool)
            .await
            .expect("restore document ACL fixture");
        }
        "organizer" => {
          sqlx::query("DELETE FROM doc_updates WHERE doc_id = $1 AND payload = $2")
            .bind(source_workspace_id)
            .bind(yjs::create_initial_workspace_doc("Organizer changed after preview"))
            .execute(&pool)
            .await
            .expect("restore organizer fixture");
        }
        "membership" => {
          sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
            .bind(source_workspace_id)
            .bind(other_user_id)
            .execute(&pool)
            .await
            .expect("restore membership fixture");
        }
        "ownership" => {
          sqlx::query(
            "UPDATE workspaces
             SET owner_user_id = $2,
                 owner_principal_type = 'user',
                 owner_principal_id = $2,
                 updated_at = now()
             WHERE id = $1",
          )
          .bind(source_workspace_id)
          .bind(actor_id)
          .execute(&pool)
          .await
          .expect("restore ownership fixture");
        }
        "policy" => {
          sqlx::query("UPDATE workspaces SET enable_sharing = NOT enable_sharing, updated_at = now() WHERE id = $1")
            .bind(target_workspace_id)
            .execute(&pool)
            .await
            .expect("restore target policy fixture");
        }
        _ => unreachable!(),
      }
      sqlx::query("DELETE FROM workspace_content_operations WHERE id = $1")
        .bind(batch.operation.id)
        .execute(&pool)
        .await
        .expect("delete stale Move operation");
    }

    let database_id = Uuid::new_v4();
    let field_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO workspace_databases (id, workspace_id, title, created_by, updated_by)
       VALUES ($1, $2, 'Move manifest Database', $3, $3)",
    )
    .bind(database_id)
    .bind(source_workspace_id)
    .bind(actor_id)
    .execute(&pool)
    .await
    .expect("seed Move manifest Database");
    sqlx::query(
      "INSERT INTO workspace_database_fields
         (id, database_id, name, field_type, config_json, position, required)
       VALUES ($1, $2, 'Title', 'title', '{\"kind\":\"title\"}', 0, true)",
    )
    .bind(field_id)
    .bind(database_id)
    .execute(&pool)
    .await
    .expect("seed Move manifest Database field");
    let database_mapping = WorkspaceContentIdMapping::new(
      resource(
        source_workspace_id,
        WorkspaceContentResourceKind::Database,
        database_id.to_string(),
      ),
      resource(
        target_workspace_id,
        WorkspaceContentResourceKind::Database,
        database_id.to_string(),
      ),
    )
    .expect("Move manifest Database mapping");
    let stale_database_batch = prepared_move_batch(
      &pool, &repository,
      actor_id,
      source_workspace_id,
      target_workspace_id,
      vec![database_mapping.clone()],
      None,
    )
    .await;
    let mut concurrent_write = pool.begin().await.expect("begin concurrent Database write");
    sqlx::query(
      "UPDATE workspace_database_fields
       SET name = 'Changed field', edit_revision = edit_revision + 1, updated_at = now()
       WHERE id = $1",
    )
    .bind(field_id)
    .execute(&mut *concurrent_write)
    .await
    .expect("start Database child write after Move snapshot");
    let publication = publisher.publish_move(stale_database_batch.clone(), "move-database-drift-test");
    let commit_write = async move {
      concurrent_write
        .commit()
        .await
        .expect("commit Database child write while Move publication waits");
    };
    let (publication, ()) = tokio::join!(publication, commit_write);
    let publication_error = publication.expect_err("Database child drift must reject Move");
    assert_eq!(
      publication_error.failure.code,
      WorkspaceContentErrorCode::MoveDatabaseContentChanged,
      "Database child drift returned an unstable error: {publication_error}"
    );
    assert_eq!(
      sqlx::query_scalar::<_, Uuid>("SELECT workspace_id FROM workspace_databases WHERE id = $1")
        .bind(database_id)
        .fetch_one(&pool)
        .await
        .expect("read unchanged Database owner"),
      source_workspace_id
    );
    sqlx::query("DELETE FROM workspace_content_operations WHERE id = $1")
      .bind(stale_database_batch.operation.id)
      .execute(&pool)
      .await
      .expect("delete stale Database Move");

    let linked_row = Uuid::new_v4();
    let absent_field = Uuid::new_v4();
    let live_field = Uuid::new_v4();
    let template_id = Uuid::new_v4();
    let absent_doc = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace_database_rows(id,database_id,title,position,created_by,updated_by) VALUES($1,$2,'Retained linked row',0,$3,$3)")
      .bind(linked_row).bind(database_id).bind(actor_id).execute(&pool).await.unwrap();
    for (position, field, target) in [(1, absent_field, absent_doc), (2, live_field, doc_id)] {
      sqlx::query("INSERT INTO workspace_database_fields(id,database_id,name,field_type,config_json,position) VALUES($1,$2,$3,'document_link','{}',$4)")
        .bind(field).bind(database_id).bind(format!("Link {position}")).bind(position).execute(&pool).await.unwrap();
      sqlx::query("INSERT INTO workspace_database_cell_values(database_id,row_id,field_id,value_json) VALUES($1,$2,$3,$4)")
        .bind(database_id).bind(linked_row).bind(field).bind(serde_json::json!({"docId":target})).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO template_catalog_entries(id,slug,title,source) VALUES($1,$2,'Reference template','bundle')")
      .bind(catalog_id).bind(format!("xws-ref-{catalog_id}")).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO workspace_database_row_templates(id,workspace_id,database_id,template_id,name,initial_cell_values_json) VALUES($1,$2,$3,$4,'Retained template',$5)")
      .bind(template_id).bind(source_workspace_id).bind(database_id).bind(catalog_id)
      .bind(serde_json::json!({absent_field.to_string(): {"docId":absent_doc},live_field.to_string(): {"docId":doc_id}}))
      .execute(&pool).await.unwrap();

    let successful_database_batch = prepared_move_batch(
      &pool, &repository,
      actor_id,
      source_workspace_id,
      target_workspace_id,
      vec![database_mapping],
      None,
    )
    .await;
    publisher
      .publish_move(successful_database_batch.clone(), "move-database-publication-test")
      .await
      .expect("publish Database Move after fresh snapshot");
    let cells: serde_json::Value = sqlx::query_scalar("SELECT jsonb_object_agg(field_id,value_json) FROM workspace_database_cell_values WHERE database_id=$1 AND row_id=$2")
      .bind(database_id).bind(linked_row).fetch_one(&pool).await.unwrap();
    assert!(cells[absent_field.to_string()].is_null(), "only a proved missing SQL document link is cleared");
    assert_eq!(cells[live_field.to_string()]["docId"], doc_id.to_string(), "a lateral live SQL identity is preserved independently of reader permissions");
    let defaults: serde_json::Value = sqlx::query_scalar("SELECT initial_cell_values_json FROM workspace_database_row_templates WHERE id=$1")
      .bind(template_id).fetch_one(&pool).await.unwrap();
    assert!(defaults.get(absent_field.to_string()).is_none());
    assert_eq!(defaults[live_field.to_string()]["docId"],doc_id.to_string());
    let database_repository = PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
    let write_error = database_repository
      .update_field(
        field_id,
        Some("Old authorization must not write".to_string()),
        None,
        None,
        DatabaseEditPrecondition::new(None, false).in_workspace(source_workspace_id),
      )
      .await
      .expect_err("a write authorized before Move must not mutate the moved Database");
    assert!(matches!(
      write_error,
      myoxus_domain::repositories::RepositoryError::Conflict(_)
    ));
    assert_eq!(
      sqlx::query_scalar::<_, String>("SELECT name FROM workspace_database_fields WHERE id = $1")
        .bind(field_id)
        .fetch_one(&pool)
        .await
        .expect("read field after rejected old-workspace write"),
      "Changed field"
    );

    sqlx::query("DELETE FROM workspace_content_operations WHERE id = $1")
      .bind(successful_database_batch.operation.id)
      .execute(&pool)
      .await
      .expect("delete successful Database Move");
    }).catch_unwind().await;
    helpers::cleanup_workspaces(&pool, &[source_workspace_id, target_workspace_id]).await;
    sqlx::query("DELETE FROM template_catalog_entries WHERE id=$1")
      .bind(catalog_id)
      .execute(&pool)
      .await
      .expect("remove owned reference catalog fixture");
    helpers::cleanup_users(&pool, &[actor_id, other_user_id]).await;
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  });
}

#[test]
fn move_publication_preserves_all_canonical_document_permissions() {
  helpers::block_on_large_stack(
    "move_publication_preserves_all_canonical_document_permissions",
    || async {
      let (_app, pool, auth) = helpers::setup_app().await;
      let (actor_id, _session) = helpers::seed_user(&pool, &auth, "xws_move_permission_actor").await;
      let (commenter_id, _session) = helpers::seed_user(&pool, &auth, "xws_move_permission_commenter").await;
      let (drift_user_id, _session) = helpers::seed_user(&pool, &auth, "xws_move_permission_drift").await;
      let source_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      let target_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      seed_organizer_root(&pool, source_workspace_id, actor_id).await;
      seed_organizer_root(&pool, target_workspace_id, actor_id).await;
      let repository =
        PgWorkspaceContentOperationRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
      let storage_root = tempfile::tempdir().expect("temporary Move permission storage");
      let storage = Arc::new(
        StorageAdapter::new_fs(storage_root.path().to_str().expect("UTF-8 storage path"))
          .expect("Move permission storage"),
      );
      let publisher = PgWorkspaceContentMovePublicationRepository::new(
        pool.clone(),
        storage,
        crate::helpers::database_starter_catalog(),
      );
      let doc_id = Uuid::new_v4();
      sqlx::query(
        "INSERT INTO docs
           (id, workspace_id, external_id, title, created_by, updated_by)
         VALUES ($1, $2, 'permission-source', 'Permission source', $3, $3)",
      )
      .bind(doc_id)
      .bind(source_workspace_id)
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect("seed Move permission document");
      sqlx::query(
        "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
         VALUES ($1, $2, $3, 1)",
      )
      .bind(doc_id)
      .bind(source_workspace_id)
      .bind(vec![0_u8, 0])
      .execute(&pool)
      .await
      .expect("seed Move permission document content");
      sqlx::query(
        "INSERT INTO doc_user_permissions (user_id, doc_id, role)
         VALUES ($1, $3, 'Owner'), ($2, $3, 'Commenter')",
      )
      .bind(actor_id)
      .bind(commenter_id)
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("seed canonical Move permissions");

      let mapping = WorkspaceContentIdMapping::new(
        resource(
          source_workspace_id,
          WorkspaceContentResourceKind::Document,
          "permission-source",
        ),
        resource(
          target_workspace_id,
          WorkspaceContentResourceKind::Document,
          "permission-target",
        ),
      )
      .expect("Move permission mapping");
      let stale_batch = prepared_move_batch(
        &pool,
        &repository,
        actor_id,
        source_workspace_id,
        target_workspace_id,
        vec![mapping.clone()],
        None,
      )
      .await;
      let stale_operation_id = stale_batch.operation.id;
      sqlx::query(
        "INSERT INTO doc_user_permissions (user_id, doc_id, role)
         VALUES ($1, $2, 'Reader')",
      )
      .bind(drift_user_id)
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("introduce canonical permission drift after Move snapshot");
      publisher
        .publish_move(stale_batch, "move-permission-live")
        .await
        .expect("permission edits remain live data rather than aborting an admitted Move");
      let before: Vec<(Uuid, String)> = vec![
        (actor_id, "Owner".to_string()),
        (commenter_id, "Commenter".to_string()),
        (drift_user_id, "Reader".to_string()),
      ]
      .into_iter()
      .collect::<std::collections::BTreeMap<_, _>>()
      .into_iter()
      .collect();

      let moved_workspace: Uuid = sqlx::query_scalar("SELECT workspace_id FROM docs WHERE id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("read moved document workspace");
      assert_eq!(moved_workspace, target_workspace_id);
      let after: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT user_id, role FROM doc_user_permissions WHERE doc_id = $1 ORDER BY user_id, role")
          .bind(doc_id)
          .fetch_all(&pool)
          .await
          .expect("read canonical permissions after Move");
      assert_eq!(
        after, before,
        "Move must preserve every canonical document permission and exact role"
      );

      sqlx::query("DELETE FROM workspace_content_operations WHERE id = ANY($1)")
        .bind([stale_operation_id])
        .execute(&pool)
        .await
        .expect("delete Move permission operation");
      helpers::cleanup_workspaces(&pool, &[source_workspace_id, target_workspace_id]).await;
      helpers::cleanup_users(&pool, &[actor_id, commenter_id, drift_user_id]).await;
    },
  );
}

#[test]
fn move_publication_retains_catalogs_and_restores_receipt_bound_tag_lineage() {
  helpers::block_on_large_stack("move_tag_assignment", || async {
    let (_app, pool, auth) = helpers::setup_app().await;
    let (actor, _) = helpers::seed_user(&pool, &auth, "move_tag_assignment").await;
    let source = helpers::create_workspace(&pool, actor).await;
    let target = helpers::create_workspace(&pool, actor).await;
    let mut operations = Vec::new();
    use futures_util::FutureExt;
    let outcome = std::panic::AssertUnwindSafe(async {
      seed_organizer_root(&pool, source, actor).await;
      seed_organizer_root(&pool, target, actor).await;
      let moved = Uuid::new_v4();
      let retained = Uuid::new_v4();
      let independent = Uuid::new_v4();
      let historical = Uuid::new_v4();
      let active = Uuid::new_v4();
      let sole = Uuid::new_v4();
      let reused = Uuid::new_v4();
      let copied = Uuid::new_v4();
      for (id, workspace, key) in [(moved, source, "tagged-move"), (retained, source, "retained"), (independent, target, "independent")] {
        sqlx::query("INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by) VALUES ($1,$2,$3,'Tagged',$4,$4)")
          .bind(id).bind(workspace).bind(key).bind(actor).execute(&pool).await.expect("seed document");
      }
      for (id, workspace, name, slug, color, archived) in [
        (historical, source, "Shared", "shared-old", "tag.blue", true),
        (active, source, "Shared", "shared", "tag.green", false),
        (sole, source, "Sole usage", "sole", "tag.blue", false),
        (reused, target, "Shared", "shared", "tag.red", false),
      ] {
        sqlx::query("INSERT INTO workspace_tags (id,workspace_id,name,slug,color_role,description,archived_at) VALUES ($1,$2,$3,$4,$5,'Canonical metadata',CASE WHEN $6 THEN now() ELSE NULL END)")
          .bind(id).bind(workspace).bind(name).bind(slug).bind(color).bind(archived).execute(&pool).await.expect("seed canonical tag");
      }
      sqlx::query("INSERT INTO workspace_tag_legacy_ids (workspace_id,legacy_id,tag_id) VALUES ($1,'historical-label',$2)")
        .bind(source).bind(historical).execute(&pool).await.expect("seed retained legacy alias");
      for (workspace, doc, ids) in [(source,moved,vec![historical,active,sole]),(source,retained,vec![active]),(target,independent,vec![reused])] {
        for (position, tag) in ids.into_iter().enumerate() {
          sqlx::query("INSERT INTO workspace_tag_document_assignments (workspace_id,doc_id,tag_id,position,created_by) VALUES ($1,$2,$3,$4,$5)")
            .bind(workspace).bind(doc).bind(tag).bind(position as i32).bind(actor).execute(&pool).await.expect("seed assignment");
        }
      }
      let source_catalog: serde_json::Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM workspace_tags t WHERE workspace_id=$1")
        .bind(source).fetch_one(&pool).await.unwrap();
      let reused_metadata: serde_json::Value = sqlx::query_scalar("SELECT to_jsonb(t) FROM workspace_tags t WHERE id=$1")
        .bind(reused).fetch_one(&pool).await.unwrap();
      let mapping = |from, to, kind, id: String, target_id: String| WorkspaceContentIdMapping::new(resource(from,kind,id),resource(to,kind,target_id)).unwrap();
      let repository = PgWorkspaceContentOperationRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
      let storage_root = tempfile::tempdir().expect("temporary storage");
      let storage = Arc::new(StorageAdapter::new_fs(storage_root.path().to_str().unwrap()).unwrap());
      let native = yjs::append_imported_attachments(
        &yjs::markdown_to_yjs("Tagged", "Ordinary body survives").unwrap(),
        &[yjs::ImportedAttachment {source_id:"shared-source-blob".into(),name:"Shared".into(),mime:"application/octet-stream".into(),size:5}],
      ).unwrap();
      let historical_native = yjs::append_imported_attachments(&native,
        &[yjs::ImportedAttachment {source_id:"history-only-blob".into(),name:"Retained history only".into(),mime:"application/octet-stream".into(),size:7}],
      ).unwrap();
      sqlx::query("INSERT INTO doc_updates(doc_id,workspace_id,payload,sequence) VALUES($1,$2,$3,1)")
        .bind(moved).bind(source).bind(&native).execute(&pool).await.unwrap();
      let history_id: i64 = sqlx::query_scalar("INSERT INTO doc_histories(doc_id,workspace_id,reference_workspace_id,snapshot) VALUES($1,$2,$2,$3) RETURNING id")
        .bind(moved).bind(source).bind(&historical_native).fetch_one(&pool).await.unwrap();
      for (key, bytes) in [("shared-source-blob", Bytes::from_static(b"asset")), ("history-only-blob",Bytes::from_static(b"history"))] {
        sqlx::query("INSERT INTO blobs(workspace_id,key,size,mime,status) VALUES($1,$2,$3,'application/octet-stream','completed')")
          .bind(source).bind(key).bind(bytes.len() as i64).execute(&pool).await.unwrap();
        storage.write_blob(BlobWriteRequest{key:format!("{source}/{key}"),content_type:Some("application/octet-stream".into()),body:bytes}).await.unwrap();
      }
      sqlx::query("INSERT INTO workspace_storage_stats(workspace_id,blob_size) VALUES($1,12) ON CONFLICT(workspace_id) DO UPDATE SET blob_size=12")
        .bind(source).execute(&pool).await.unwrap();
      use myoxus_domain::repositories::DocumentVersionRepository;
      let versions = myoxus_infrastructure::document_version::PgDocumentVersionRepository::new(pool.clone());
      let named = myoxus_domain::entities::DocumentVersion::new_for_create(myoxus_domain::entities::DocumentVersionCreateInput {
        id:Uuid::new_v4(),doc_id:moved,workspace_id:source,doc_history_id:history_id,label:"Retained".into(),description:None,
        event:myoxus_domain::entities::DocumentVersionEvent::Manual,kind:myoxus_domain::entities::DocumentVersionKind::Checkpoint,
        created_by:actor,created_at:Utc::now(),is_pinned:false,is_protected:false,policy_id:None,
        policy_snapshot:serde_json::json!({}),content_hash:Some(hex::encode(Sha256::digest(&historical_native))),metadata:serde_json::json!({}),
      });
      versions.create(&named).await.unwrap();
      let batch = prepared_move_batch(&pool, &repository,actor,source,target,vec![
        mapping(source,target,WorkspaceContentResourceKind::Blob,"shared-source-blob".into(),"allocated-by-fixture".into()),
        mapping(source,target,WorkspaceContentResourceKind::Blob,"history-only-blob".into(),"allocated-by-fixture".into()),
        mapping(source,target,WorkspaceContentResourceKind::Document,"tagged-move".into(),"tagged-move".into()),
        mapping(source,target,WorkspaceContentResourceKind::Tag,historical.to_string(),reused.to_string()),
        mapping(source,target,WorkspaceContentResourceKind::Tag,active.to_string(),reused.to_string()),
        mapping(source,target,WorkspaceContentResourceKind::Tag,sole.to_string(),copied.to_string()),
      ],None).await;
      let origin = batch.operation.id;
      operations.push(origin);
      let target_shared = batch.mappings.iter().find(|m|m.source.resource_id()=="shared-source-blob").unwrap().target.resource_id().to_string();
      let target_history = batch.mappings.iter().find(|m|m.source.resource_id()=="history-only-blob").unwrap().target.resource_id().to_string();
      let publisher = PgWorkspaceContentMovePublicationRepository::new(pool.clone(),storage.clone(), crate::helpers::database_starter_catalog());
      let result = publisher.publish_move(batch.clone(),"move-tag-assignment").await.expect("publish with shared and sole-usage tags");
      assert_eq!(result.status,WorkspaceContentOperationStatus::Succeeded);
      // Retaining the pre-commit caller record models a lost success ACK.
      assert_eq!(publisher.publish_move(batch,"move-tag-assignment").await.expect("receipt replay after lost ACK").id,origin);
      let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
      use myoxus_application::database::{DatabaseServices, DatabaseLimits, DatabaseServiceDependencies};
      use myoxus_domain::database::DatabaseRowContentDocumentState;
      let databases = DatabaseServices::new(Arc::new(PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog())),
        doc_service.clone(), Arc::new(PermissionService::new(auth.clone())),
        DatabaseLimits::default(), Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(), crate::helpers::database_starter_catalog())), crate::helpers::database_starter_catalog(), DatabaseServiceDependencies::disabled());
      let incoming = databases.editing.resolve_document_link(actor,source,moved).await.unwrap().unwrap();
      assert_eq!(incoming.state,DatabaseRowContentDocumentState::Available);
      assert_eq!(incoming.document_id,moved);
      assert_eq!(incoming.workspace_id,Some(target),"a retained incoming link follows the committed SQL identity");
      assert_eq!(databases.editing.resolve_content_document(actor,source,Some(moved)).await.unwrap().unwrap().state,
        DatabaseRowContentDocumentState::Redacted,"Row content ownership does not acquire lateral-link semantics");
      let denied = databases.editing.resolve_document_link(Uuid::new_v4(),source,moved).await.unwrap().unwrap();
      assert_eq!(denied.state,DatabaseRowContentDocumentState::Redacted);
      assert!(denied.external_id.is_none() && denied.workspace_id.is_none() && denied.title.is_none());
      assert_eq!(databases.editing.resolve_document_link(actor,source,independent).await.unwrap().unwrap().state,
        DatabaseRowContentDocumentState::Redacted,"an unrelated foreign SQL identity has no origin proof");
      let history = doc_service.history_entry(history_id).await.unwrap().unwrap();
      let asset_keys = |bytes:&[u8]| yjs::extract_portable_asset_references(bytes).unwrap().into_iter().map(|a|a.source_key).collect::<BTreeSet<_>>();
      assert_eq!(asset_keys(&history.snapshot),BTreeSet::from([target_shared.clone(),target_history.clone()]));
      assert_eq!(asset_keys(&versions.snapshot_for_version(named.id).await.unwrap().unwrap().1),asset_keys(&history.snapshot));
      assert_eq!(versions.get(named.id).await.unwrap().unwrap().content_hash,named.content_hash);
      assert_eq!(asset_keys(&versions.latest_snapshot_for_doc(moved).await.unwrap().unwrap()),asset_keys(&history.snapshot));
      assert_eq!(sqlx::query_scalar::<_,Vec<u8>>("SELECT snapshot FROM doc_histories WHERE id=$1").bind(history_id).fetch_one(&pool).await.unwrap(),historical_native);
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT blob_size FROM workspace_storage_stats WHERE workspace_id=$1").bind(source).fetch_one(&pool).await.unwrap(),12);
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT blob_size FROM workspace_storage_stats WHERE workspace_id=$1").bind(target).fetch_one(&pool).await.unwrap(),12);
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspace_content_operation_redirects WHERE operation_id=$1 AND source_kind='blob'").bind(origin).fetch_one(&pool).await.unwrap(),0);
      for (scope,key,expected) in [(source,"shared-source-blob",b"asset".as_slice()),(target,target_shared.as_str(),b"asset".as_slice()),(source,"history-only-blob",b"history".as_slice()),(target,target_history.as_str(),b"history".as_slice())] {
        assert_eq!(storage.read_blob(&format!("{scope}/{key}")).await.unwrap().data.as_ref(),expected);
      }
      doc_service.rollback_to_history(moved,history_id).await.unwrap();
      assert_eq!(asset_keys(&doc_service.load_full_doc(target,moved).await.unwrap()),asset_keys(&history.snapshot));
      let classification: Vec<Uuid> = sqlx::query_scalar("SELECT tag_id FROM workspace_tag_document_assignments WHERE workspace_id=$1 AND doc_id=$2 ORDER BY position")
        .bind(target).bind(moved).fetch_all(&pool).await.unwrap();
      assert_eq!(classification,vec![reused,copied],"ordered many-to-one mapping deduplicates assignments");
      assert_eq!(sqlx::query_scalar::<_,serde_json::Value>("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM workspace_tags t WHERE workspace_id=$1")
        .bind(source).fetch_one(&pool).await.unwrap(),source_catalog,"all source metadata survives, including the zero-use tag");
      assert_eq!(sqlx::query_scalar::<_,serde_json::Value>("SELECT to_jsonb(t) FROM workspace_tags t WHERE id=$1")
        .bind(reused).fetch_one(&pool).await.unwrap(),reused_metadata,"target metadata wins without an update");
      assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT tag_id FROM workspace_tag_legacy_ids WHERE workspace_id=$1 AND legacy_id='historical-label'")
        .bind(source).fetch_one(&pool).await.unwrap(),historical);
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspace_tags WHERE workspace_id=$1")
        .bind(target).fetch_one(&pool).await.unwrap(),2,"replay creates no extra catalog entries");
      let undo = prepared_move_batch(&pool, &repository,actor,target,source,vec![
        mapping(target,source,WorkspaceContentResourceKind::Blob,target_shared.clone(),"allocated-by-fixture".into()),
        mapping(target,source,WorkspaceContentResourceKind::Blob,target_history.clone(),"allocated-by-fixture".into()),
        mapping(target,source,WorkspaceContentResourceKind::Document,"tagged-move".into(),"tagged-move".into()),
        mapping(target,source,WorkspaceContentResourceKind::Tag,reused.to_string(),active.to_string()),
        mapping(target,source,WorkspaceContentResourceKind::Tag,copied.to_string(),sole.to_string()),
      ],Some(origin)).await;
      operations.push(undo.operation.id);
      let return_assets=undo.mappings.iter().filter(|m|m.source.kind()==WorkspaceContentResourceKind::Blob).map(|m|m.target.resource_id().to_string()).collect::<BTreeSet<_>>();
      publisher.publish_move(undo,"undo-tag-assignment").await.expect("restore exact receipt-bound source IDs");
      let returned_history=doc_service.history_entry(history_id).await.unwrap().unwrap();
      assert_eq!(asset_keys(&returned_history.snapshot),return_assets);
      assert_eq!(asset_keys(&doc_service.load_full_doc(source,moved).await.unwrap()),return_assets);
      doc_service.rollback_to_history(moved,history_id).await.unwrap();
      assert_eq!(asset_keys(&doc_service.load_full_doc(source,moved).await.unwrap()),return_assets,"successive restored projections remain mergeable");
      assert_eq!(sqlx::query_scalar::<_,Vec<u8>>("SELECT snapshot FROM doc_histories WHERE id=$1").bind(history_id).fetch_one(&pool).await.unwrap(),historical_native);
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM blobs WHERE workspace_id=$1").bind(target).fetch_one(&pool).await.unwrap(),2,"Undo retains the departed target catalog");
      assert_eq!(storage.read_blob(&format!("{source}/shared-source-blob")).await.unwrap().data,Bytes::from_static(b"asset"));
      // An old history without a captured origin cannot adopt a same-key live asset.
      let unproved_id: i64 = sqlx::query_scalar("INSERT INTO doc_histories(doc_id,workspace_id,snapshot) VALUES($1,$2,$3) RETURNING id")
        .bind(moved).bind(source).bind(&historical_native).fetch_one(&pool).await.unwrap();
      let unproved = doc_service.history_entry(unproved_id).await.unwrap().unwrap();
      assert!(asset_keys(&unproved.snapshot).is_empty(), "unproved historical asset addresses stay unavailable");
      let body = |bytes: &[u8]| yjs::extract_blocks_from_yjs(bytes).unwrap().blocks.into_iter()
        .map(|b| (b.id, b.flavour, b.text, b.children_ids)).collect::<Vec<_>>();
      assert_eq!(body(&unproved.snapshot), body(&historical_native), "body and native identities remain readable");
      assert_eq!(sqlx::query_scalar::<_,Vec<u8>>("SELECT snapshot FROM doc_histories WHERE id=$1")
        .bind(unproved_id).fetch_one(&pool).await.unwrap(),historical_native);
      let mut cleanup = pool.begin().await.unwrap();
      assert!(!myoxus_infrastructure::blob::SqlxBlobStore::lock_unreferenced_import_object_cleanup_in_tx(
        &mut cleanup, &format!("{source}/shared-source-blob")).await.unwrap(), "legacy cleanup cannot adopt canonical source bytes");
      cleanup.rollback().await.unwrap();
      assert_eq!(storage.read_blob(&format!("{source}/shared-source-blob")).await.unwrap().data,Bytes::from_static(b"asset"));
      let returned: Vec<Uuid> = sqlx::query_scalar("SELECT tag_id FROM workspace_tag_document_assignments WHERE workspace_id=$1 AND doc_id=$2 ORDER BY position")
        .bind(source).bind(moved).fetch_all(&pool).await.unwrap();
      assert_eq!(returned,vec![historical,active,sole],"Undo is position lineage, not a global inverse");
      for (workspace,doc,expected) in [(source,retained,active),(target,independent,reused)] {
        assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT tag_id FROM workspace_tag_document_assignments WHERE workspace_id=$1 AND doc_id=$2")
          .bind(workspace).bind(doc).fetch_one(&pool).await.unwrap(),expected,"independent usages survive the counter-operation");
      }
      assert_eq!(sqlx::query_scalar::<_,serde_json::Value>("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM workspace_tags t WHERE workspace_id=$1")
        .bind(source).fetch_one(&pool).await.unwrap(),source_catalog);
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspace_tags WHERE workspace_id=$1")
        .bind(target).fetch_one(&pool).await.unwrap(),2,"Undo never removes destination catalog entries");
      let returned_link = databases.editing.resolve_document_link(actor,target,moved).await.unwrap().unwrap();
      assert_eq!(returned_link.workspace_id,Some(source),"an old destination-qualified incoming link follows Undo");
      assert_eq!(returned_link.state,DatabaseRowContentDocumentState::Available);
      let mut next_mappings = return_assets.iter().map(|key|
        mapping(source,target,WorkspaceContentResourceKind::Blob,key.clone(),"allocated-by-fixture".into())
      ).collect::<Vec<_>>();
      next_mappings.extend([
        mapping(source,target,WorkspaceContentResourceKind::Document,"tagged-move".into(),"tagged-again".into()),
        mapping(source,target,WorkspaceContentResourceKind::Tag,historical.to_string(),reused.to_string()),
        mapping(source,target,WorkspaceContentResourceKind::Tag,active.to_string(),reused.to_string()),
        mapping(source,target,WorkspaceContentResourceKind::Tag,sole.to_string(),copied.to_string()),
      ]);
      let next = prepared_move_batch(&pool, &repository,actor,source,target,next_mappings,None).await;
      let next_id = next.operation.id;
      operations.push(next_id);
      publisher.publish_move(next,"move-after-undo").await.expect("depart the same live source address again");
      let departed_link = databases.editing.resolve_document_link(actor,source,moved).await.unwrap().unwrap();
      assert_eq!(departed_link.workspace_id,Some(target));
      assert_eq!(departed_link.external_id.as_deref(),Some("tagged-again"),"incoming links follow the next committed route without changing SQL identity");
      let hop: (Uuid,Uuid,String) = sqlx::query_as("SELECT operation_id,target_workspace_id,target_id FROM workspace_content_operation_redirects WHERE source_workspace_id=$1 AND source_kind='document' AND source_id='tagged-move'")
        .bind(source).fetch_one(&pool).await.unwrap();
      assert_eq!(hop,(next_id,target,"tagged-again".into()),"a new departure replaces the old hop, preventing an Undo redirect cycle");
      assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT id FROM docs WHERE workspace_id=$1 AND external_id='tagged-again'")
        .bind(target).fetch_one(&pool).await.unwrap(),moved,"the canonical redirected target retains its SQL identity");
      assert_eq!(sqlx::query_scalar::<_,Vec<u8>>("SELECT snapshot FROM doc_histories WHERE id=$1")
        .bind(history_id).fetch_one(&pool).await.unwrap(),historical_native,"a repeated departure preserves immutable history");
    }).catch_unwind().await;
    // Counter requests reference their origin with an immediate FK.
    for operation_id in operations.iter().rev() {
      sqlx::query("DELETE FROM workspace_content_operations WHERE id=$1")
        .bind(operation_id)
        .execute(&pool)
        .await
        .expect("clean counters before origins even after assertion failure");
    }
    helpers::cleanup_workspaces(&pool, &[source, target]).await;
    helpers::cleanup_users(&pool, &[actor]).await;
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE id=ANY($1)")
        .bind([source, target])
        .fetch_one(&pool)
        .await
        .expect("verify exact fixture cleanup"),
      0,
    );
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  });
}

#[test]
fn move_publication_preserves_identity_history_acl_and_rolls_back_conflicts() {
  helpers::block_on_large_stack(
    "move_publication_preserves_identity_history_acl_and_rolls_back_conflicts",
    || async {
      use futures_util::FutureExt;
      use std::panic::AssertUnwindSafe;

      let (_app, pool, auth) = helpers::setup_app().await;
      let (actor_id, _session) = helpers::seed_user(&pool, &auth, "xws_move_publication_actor").await;
      let source_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      let target_workspace_id = helpers::create_workspace(&pool, actor_id).await;
      seed_organizer_root(&pool, source_workspace_id, actor_id).await;
      seed_organizer_root(&pool, target_workspace_id, actor_id).await;
      let repository = Arc::new(PgWorkspaceContentOperationRepository::new(
        pool.clone(),
        crate::helpers::database_starter_catalog(),
      ));
      let storage_root = tempfile::tempdir().expect("temporary move storage");
      let storage = Arc::new(
        StorageAdapter::new_fs(storage_root.path().to_str().expect("UTF-8 storage path"))
          .expect("move publication storage"),
      );
      let publisher = Arc::new(PgWorkspaceContentMovePublicationRepository::new(
        pool.clone(),
        storage.clone(),
        crate::helpers::database_starter_catalog(),
      ));
      let (external_id, _external_session) = helpers::seed_user(&pool, &auth, "xws_move_external").await;
      let (pending_id, _pending_session) = helpers::seed_user(&pool, &auth, "xws_move_pending").await;
      let mut fixture_operations = Vec::new();
      let mut fixture_users = vec![actor_id, external_id, pending_id];
      let result = AssertUnwindSafe(async {
      sqlx::query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'External', 'Accepted', now()),
                ($1, $3, 'Reader', 'Pending', NULL)",
      )
      .bind(source_workspace_id)
      .bind(external_id)
      .bind(pending_id)
      .execute(&pool)
      .await
      .unwrap();
      sqlx::query("UPDATE workspaces SET enable_sharing = true, public = true WHERE id = $1")
        .bind(target_workspace_id)
        .execute(&pool)
        .await
        .unwrap();

      async fn running_move(
        repository: &PgWorkspaceContentOperationRepository,
        mut record: WorkspaceContentOperationRecord,
        mappings: &[WorkspaceContentIdMapping],
        fixture_operations: &mut Vec<Uuid>,
      ) -> WorkspaceContentOperationRecord {
        record.kind = WorkspaceContentOperationKind::Move;
        let mut mappings = mappings.to_vec();
        if mappings.iter().any(|m| m.source.kind() == WorkspaceContentResourceKind::Document && m.source.resource_id() == "source-key") {
          let target = Uuid::new_v5(&record.id, format!("{}:{}:blob:attachment.bin:1", record.source_workspace_id, record.target_workspace_id.unwrap()).as_bytes()).to_string();
          mappings.push(WorkspaceContentIdMapping::new(resource(record.source_workspace_id, WorkspaceContentResourceKind::Blob, "attachment.bin"), resource(record.target_workspace_id.unwrap(), WorkspaceContentResourceKind::Blob, target)).unwrap());
        }
        fixture_operations.push(record.id);
        repository.create_or_get(record.clone()).await.expect("create Move");
        repository
          .store_request(
            record.id,
            &WorkspaceContentOperationRequest {
              kind: WorkspaceContentOperationKind::Move,
              source_workspace_id: record.source_workspace_id,
              target_workspace_id: record.target_workspace_id.expect("Move target workspace"),
              selection: WorkspaceContentOperationSelection::Resources {
                resources: mappings.iter().filter(|m| m.source.kind() == WorkspaceContentResourceKind::Document).map(|mapping| mapping.source.clone()).collect(),
              },
              copy_document_acl: false,
              extract_workspace_name: None, git_sync_choice: None,
              link_entry_id: None,
              link_parent_id: None,
              link_index: None,
            },
            None,
          )
          .await
          .expect("store Move execution request");
        repository
          .store_manifest(record.id, &record.manifest_hash, &mappings, &[])
          .await
          .expect("store Move manifest");
        record = repository
          .transition(
            record.id,
            WorkspaceContentOperationStatus::Draft,
            WorkspaceContentOperationStatus::Previewed,
            None,
            None,
          )
          .await
          .expect("preview Move");
        repository
          .store_execution_memberships(record.id, &[])
          .await
          .expect("store empty Move membership plan");
        record = repository
          .transition(
            record.id,
            WorkspaceContentOperationStatus::Previewed,
            WorkspaceContentOperationStatus::Queued,
            None,
            None,
          )
          .await
          .expect("queue Move");
        repository
          .transition(
            record.id,
            WorkspaceContentOperationStatus::Queued,
            WorkspaceContentOperationStatus::Running,
            None,
            Some("move-publication-test"),
          )
          .await
          .expect("claim Move")
      }

      let doc_id = Uuid::new_v4();
      let comment_id = Uuid::new_v4();
      let attachment_id = Uuid::new_v4();
      sqlx::query(
        "INSERT INTO docs
           (id, workspace_id, external_id, title, public_mode, created_by, updated_by)
         VALUES ($1, $2, 'source-key', 'Identity preserved', 'page', $3, $3)",
      )
      .bind(doc_id)
      .bind(source_workspace_id)
      .bind(actor_id)
      .execute(&pool)
      .await
      .unwrap();
      sqlx::query(
        "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
         VALUES ($1, $2, $3, 1)",
      )
      .bind(doc_id)
      .bind(source_workspace_id)
      .bind(vec![0_u8, 0])
      .execute(&pool)
      .await
      .unwrap();
      sqlx::query(
        "INSERT INTO doc_histories (doc_id, workspace_id, snapshot)
         VALUES ($1, $2, $3)",
      )
      .bind(doc_id)
      .bind(source_workspace_id)
      .bind(vec![1_u8, 2])
      .execute(&pool)
      .await
      .unwrap();
      sqlx::query(
        "INSERT INTO comments (id, workspace_id, doc_id, author_id, body)
         VALUES ($1, $2, $3, $4, '{\"text\":\"keep\"}'::jsonb)",
      )
      .bind(comment_id)
      .bind(source_workspace_id)
      .bind(doc_id)
      .bind(actor_id)
      .execute(&pool)
      .await
      .unwrap();
      sqlx::query(
        "INSERT INTO comment_attachments
           (id, workspace_id, doc_id, comment_id, storage_key, size_bytes, created_by)
         VALUES ($1, $2, $3, $4, 'attachment.bin', 2, $5)",
      )
      .bind(attachment_id)
      .bind(source_workspace_id)
      .bind(doc_id)
      .bind(comment_id)
      .bind(actor_id)
      .execute(&pool)
      .await
      .unwrap();
      sqlx::query("INSERT INTO blobs(workspace_id,key,size,mime,status) VALUES($1,'attachment.bin',2,'application/octet-stream','completed')")
        .bind(source_workspace_id).execute(&pool).await.unwrap();
      storage.write_blob(BlobWriteRequest { key: format!("{source_workspace_id}/attachment.bin"), content_type: Some("application/octet-stream".into()), body: Bytes::from_static(b"ab") }).await.unwrap();
      sqlx::query(
        "INSERT INTO doc_user_permissions (user_id, doc_id, role)
         VALUES ($1, $2, 'Owner') ON CONFLICT DO NOTHING",
      )
      .bind(actor_id)
      .bind(doc_id)
      .execute(&pool)
      .await
      .unwrap();

      let sealed_pending=seed_pending_document_change(&pool,source_workspace_id,doc_id,actor_id).await;
      sqlx::query("UPDATE document_change_batches SET sealed_at=now() WHERE id=$1").bind(sealed_pending).execute(&pool).await.unwrap();
      let active_pending=seed_pending_document_change(&pool,source_workspace_id,doc_id,external_id).await;
      let mapping = WorkspaceContentIdMapping::new(
        resource(
          source_workspace_id,
          WorkspaceContentResourceKind::Document,
          "source-key",
        ),
        resource(
          target_workspace_id,
          WorkspaceContentResourceKind::Document,
          "source-key",
        ),
      )
      .unwrap();
      let running = running_move(
        &repository,
        operation(
          Uuid::new_v4(),
          Uuid::new_v4(),
          actor_id,
          source_workspace_id,
          target_workspace_id,
          &"f".repeat(64),
        ),
        std::slice::from_ref(&mapping),
        &mut fixture_operations,
      )
      .await;
      let recipient_snapshot = repository
        .recipient_snapshot(source_workspace_id, actor_id)
        .await
        .expect("snapshot accepted Move recipients");
      assert_eq!(recipient_snapshot.recipient_ids.len(), 2);
      assert!(recipient_snapshot.recipient_ids.contains(&actor_id));
      assert!(recipient_snapshot.recipient_ids.contains(&external_id));
      assert!(!recipient_snapshot.recipient_ids.contains(&pending_id));
      let recipient_intents = vec![
        recipient_intent(
          &running,
          &recipient_snapshot,
          actor_id,
          1,
          vec![WorkspaceContentResourceKind::Document],
        ),
        recipient_intent(&running, &recipient_snapshot, external_id, 0, Vec::new()),
      ];
      let batch = WorkspaceContentMovePublicationBatch {
        operation: running.clone(),
        mappings: repository.list_mappings(running.id).await.unwrap(),
        revision_manifest: repository
          .prepare_move_revision_manifest(&running, &repository.list_mappings(running.id).await.unwrap())
          .await
          .expect("prepare Move revision manifest"),
        organizer: None,
        recipient_intents: recipient_intents.clone(),
        extract_source_folder_id: None,
        staging_entries: Vec::new(),
      };
      sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
        .bind(source_workspace_id)
        .bind(external_id)
        .execute(&pool)
        .await
        .expect("ordinary membership writes remain independent from a staged content operation");
      let stale_publication = publisher
        .publish_move(batch.clone(), "move-publication-stale-recipient-snapshot")
        .await
        .expect_err("publication must reject a changed recipient snapshot");
      assert_eq!(stale_publication.failure.code, WorkspaceContentErrorCode::MoveRecipientSnapshotChanged,
        "snapshot drift must fail at the publication boundary");
      assert_eq!(
        sqlx::query_scalar::<_, Uuid>("SELECT workspace_id FROM docs WHERE id = $1")
          .bind(doc_id)
          .fetch_one(&pool)
          .await
          .unwrap(),
        source_workspace_id,
        "stale publication must not partially move canonical content"
      );
      sqlx::query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'External', 'Accepted', now())",
      )
      .bind(source_workspace_id)
      .bind(external_id)
      .execute(&pool)
      .await
      .expect("restore the confirmed recipient snapshot");
      let successful_running = running_move(
        &repository,
        operation(
          Uuid::new_v4(),
          Uuid::new_v4(),
          actor_id,
          source_workspace_id,
          target_workspace_id,
          &"8".repeat(64),
        ),
        std::slice::from_ref(&mapping),
        &mut fixture_operations,
      )
      .await;
      let successful_recipient_snapshot = repository
        .recipient_snapshot(source_workspace_id, actor_id)
        .await
        .expect("snapshot successful Move recipients");
      let successful_intents = vec![
        recipient_intent(
          &successful_running,
          &successful_recipient_snapshot,
          actor_id,
          1,
          vec![WorkspaceContentResourceKind::Document],
        ),
        recipient_intent(
          &successful_running,
          &successful_recipient_snapshot,
          external_id,
          0,
          Vec::new(),
        ),
      ];
      let successful_batch = WorkspaceContentMovePublicationBatch {
        operation: successful_running.clone(),
        mappings: repository.list_mappings(successful_running.id).await.unwrap(),
        revision_manifest: repository
          .prepare_move_revision_manifest(&successful_running, &repository.list_mappings(successful_running.id).await.unwrap())
          .await
          .expect("prepare successful Move revision manifest"),
        organizer: None,
        recipient_intents: successful_intents,
        extract_source_folder_id: None,
        staging_entries: Vec::new(),
      };
      sqlx::query("INSERT INTO workspace_doc_view_daily (workspace_id, doc_id, date, total_views) VALUES ($1, $2::text, CURRENT_DATE, 4)")
        .bind(source_workspace_id).bind(doc_id).execute(&pool).await.expect("Move ignores post-snapshot views");
      // Publication uses the current target policy, even after its revision was captured.
      sqlx::query("UPDATE workspaces SET enable_sharing = false, public = false WHERE id = $1")
        .bind(target_workspace_id)
        .execute(&pool)
        .await
        .expect("reduce target sharing after preview");
      let move_service = WorkspaceContentMovePublicationService::new(
        repository.clone(),
        repository.clone(),
        Arc::new(PermissionService::new(auth.clone())),
        repository.clone(),
        repository.clone(),
        DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))),
        publisher.clone(),
        "move-publication-test".to_string(),
      );
      // Revoke the actor's target write authority after durable admission.
      // The operation still moves live metadata/grants rather than restoring
      // its earlier manifest's ACL or generic metadata freshness.
      sqlx::query("UPDATE workspaces SET owner_user_id = $2, owner_principal_id = $2 WHERE id = $1")
        .bind(target_workspace_id)
        .bind(pending_id)
        .execute(&pool)
        .await
        .unwrap();
      sqlx::query("UPDATE workspace_memberships SET role = 'Reader' WHERE workspace_id = $1 AND user_id = $2")
        .bind(target_workspace_id)
        .bind(actor_id)
        .execute(&pool)
        .await
        .unwrap();
      sqlx::query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
        VALUES ($1, $2, 'Owner', 'Accepted', now()) ON CONFLICT (workspace_id, user_id)
        DO UPDATE SET role = 'Owner', status = 'Accepted'",
      )
      .bind(target_workspace_id)
      .bind(pending_id)
      .execute(&pool)
      .await
      .unwrap();
      sqlx::query("UPDATE doc_user_permissions SET role = 'Reader' WHERE doc_id = $1 AND user_id = $2")
        .bind(doc_id)
        .bind(actor_id)
        .execute(&pool)
        .await
        .unwrap();
      sqlx::query("UPDATE docs SET default_role = 'None', updated_at = now() WHERE id = $1")
        .bind(doc_id)
        .execute(&pool)
        .await
        .unwrap();
      assert!(
        !PermissionService::new(auth.clone())
          .can(
            &myoxus_application::permission::WorkspaceResource {
              user_id: actor_id,
              workspace_id: target_workspace_id,
            },
            myoxus_domain::permission::WorkspaceAction::CreateDoc
          )
          .await
      );
      let published = move_service
        .execute(successful_running.clone())
        .await
        .expect("publish Move");
      assert_eq!(published.status, WorkspaceContentOperationStatus::Succeeded);
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM document_change_batches WHERE doc_id=$1")
        .bind(doc_id).fetch_one(&pool).await.unwrap(),0,"Move suppresses active and sealed source windows");
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM document_change_batch_actors WHERE batch_id=ANY($1)")
        .bind([sealed_pending,active_pending]).fetch_one(&pool).await.unwrap(),0,"Move cascades transient actor facts");
      let replay_publisher = PgWorkspaceContentMovePublicationRepository::new(pool.clone(), storage, crate::helpers::database_starter_catalog());
      assert_eq!(sqlx::query_scalar::<_, i64>("SELECT total_views FROM workspace_doc_view_daily WHERE workspace_id=$1 AND doc_id=$2::text")
        .bind(source_workspace_id).bind(doc_id).fetch_one(&pool).await.unwrap(), 4);
      assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_doc_view_daily WHERE workspace_id=$1 AND doc_id=$2::text")
        .bind(target_workspace_id).bind(doc_id).fetch_one(&pool).await.unwrap(), 0, "Move starts fresh destination statistics");
      assert_eq!(
        replay_publisher
          .publish_move(successful_batch.clone(), "move-publication-replay")
          .await
          .expect("a fresh publication instance replays Move idempotently")
          .id,
        published.id
      );
      let recipients = sqlx::query(
        "SELECT recipient_id, resource_count, visible_resource_kinds
         FROM workspace_content_operation_recipient_outbox
         WHERE operation_id = $1 ORDER BY recipient_id",
      )
      .bind(published.id)
      .fetch_all(&pool)
      .await
      .unwrap();
      assert_eq!(recipients.len(), 2);
      let external = recipients
        .iter()
        .find(|row| row.get::<Uuid, _>("recipient_id") == external_id)
        .expect("external source member receives generic intent");
      assert_eq!(external.get::<i32, _>("resource_count"), 0);
      assert!(external.get::<Vec<String>, _>("visible_resource_kinds").is_empty());
      assert!(
        !recipients
          .iter()
          .any(|row| row.get::<Uuid, _>("recipient_id") == pending_id),
        "pending membership must not enter the publication snapshot"
      );
      let (later_id, _later_session) = helpers::seed_user(&pool, &auth, "xws_move_later_member").await;
      fixture_users.push(later_id);
      helpers::add_workspace_member(&pool, source_workspace_id, later_id).await;
      publisher
        .publish_move(successful_batch, "move-publication-after-membership-change")
        .await
        .expect("replay remains bound to the finalize recipient snapshot");
      assert_eq!(
        sqlx::query_scalar::<_, i64>(
          "SELECT count(*) FROM workspace_content_operation_recipient_outbox WHERE operation_id = $1",
        )
        .bind(published.id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        2,
        "members added after publication must not receive a retroactive intent"
      );
      let moved = sqlx::query("SELECT workspace_id, external_id, public_mode FROM docs WHERE id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .unwrap();
      assert_eq!(moved.get::<Uuid, _>("workspace_id"), target_workspace_id);
      assert_eq!(moved.get::<String, _>("external_id"), "source-key");
      assert_eq!(
        moved.get::<Option<String>, _>("public_mode"),
        None,
        "a private target workspace must suspend the moved document selection atomically"
      );
      let target_root = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
        .load_full_doc(target_workspace_id, target_workspace_id)
        .await
        .expect("load target root after Move");
      assert!(
        yjs::extract_workspace_root_metadata(&target_root)
          .expect("decode target root after Move")
          .pages
          .iter()
          .any(|page| page.id == "source-key" && page.title.as_deref() == Some("Identity preserved")),
        "Move must publish the stable document identity into the target root page directory"
      );
      let update_count_before: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("count updates before rejected old-workspace write");
      assert!(matches!(
        DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
          .push_update(source_workspace_id, doc_id, vec![8_u8, 8], 0, DocSpaceKind::Workspace,)
          .await,
        Err(AuthError::NotFound(_))
      ));
      assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
          .bind(doc_id)
          .fetch_one(&pool)
          .await
          .expect("count updates after rejected old-workspace write"),
        update_count_before,
        "a write authorized before Move must not append after ownership changed"
      );
      let stale_external_payload =
        yjs::markdown_to_yjs("Stale source", "Must not rematerialize").expect("create valid stale external update");
      let move_evidence = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
      assert!(
        move_evidence
          .is_page_moved(source_workspace_id, &DocumentKey::parse("source-key").unwrap())
          .await
          .unwrap()
      );
      assert!(
        !move_evidence
          .is_page_moved(target_workspace_id, &DocumentKey::parse("source-key").unwrap())
          .await
          .unwrap()
      );
      assert!(
        !move_evidence
          .is_page_moved(source_workspace_id, &DocumentKey::parse("never-created").unwrap())
          .await
          .unwrap()
      );
      // Old deployed documents can have no registration receipt. Move's
      // publication still retires their source address transactionally.
      sqlx::query("DELETE FROM page_registration_evidence WHERE workspace_id = $1 AND external_id = 'source-key'")
        .bind(source_workspace_id)
        .execute(&pool)
        .await
        .expect("exercise legacy Move without a registration receipt");
      let permit = Arc::new(tokio::sync::Semaphore::new(1))
        .acquire_owned()
        .await
        .expect("acquire decoder permit");
      let (stale_external_payload, decoded) = yjs::decode_update_v1_guarded(stale_external_payload, permit)
        .await
        .expect("decode valid stale external update");
      assert!(matches!(
        SqlxDocStore::new(pool.clone())
          .push_update(DocUpdateWrite {
            sync_operation_id: Some(Uuid::new_v4()),
            connection_context: None,
            workspace_id: source_workspace_id,
            target: DocWriteTarget::External(DocumentKey::parse("source-key").expect("valid document key")),
            validated_external_update: Some(ValidatedExternalYjsUpdate::new(decoded, 1024 * 1024)),
            payload: stale_external_payload,
            space_kind: DocSpaceKind::Workspace,
            actor_user_id: Some(actor_id),
            client_format: None,
            client_capabilities: None,
            initial_provenance: None,
          })
          .await,
        Err(AuthError::NotFound(_))
      ));
      assert_eq!(
        sqlx::query_scalar::<_, i64>(
          "SELECT count(*) FROM docs WHERE workspace_id = $1 AND external_id = 'source-key'",
        )
        .bind(source_workspace_id)
        .fetch_one(&pool)
        .await
        .expect("count stale source documents"),
        0,
        "a browser flush through the source workspace must not rematerialize a moved external key"
      );
      let source_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
      // A historical redirect can outlive a legitimate return to the source workspace.
      let returned_id = Uuid::new_v4();
      sqlx::query("INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by) VALUES ($1, $2, 'returned-key', 'Returned page', $3, $3)")
        .bind(returned_id).bind(source_workspace_id).bind(actor_id)
        .execute(&pool).await.unwrap();
      sqlx::query("INSERT INTO workspace_content_operation_redirects (operation_id, source_workspace_id, source_kind, source_id, target_workspace_id, target_kind, target_id) VALUES ($1, $2, 'document', 'returned-key', $3, 'document', 'returned-key')")
        .bind(published.id).bind(source_workspace_id).bind(target_workspace_id)
        .execute(&pool).await.unwrap();
      assert!(
        !source_service
          .is_page_moved(source_workspace_id, &DocumentKey::parse("returned-key").unwrap())
          .await
          .unwrap(),
        "a live returned document must shadow its historical redirect"
      );
      let source_root = source_service
        .load_full_doc(source_workspace_id, source_workspace_id)
        .await
        .unwrap();
      let late_entry = yjs::add_pages_to_root_doc(
        &[source_root],
        &[
          ("source-key".to_string(), "Identity preserved".to_string()),
          ("returned-key".to_string(), "Returned page".to_string()),
        ],
      )
      .unwrap();
      let permit = Arc::new(tokio::sync::Semaphore::new(1)).acquire_owned().await.unwrap();
      let (payload, decoded) = yjs::decode_update_v1_guarded(late_entry, permit).await.unwrap();
      SqlxDocStore::new(pool.clone())
        .push_update(DocUpdateWrite {
          sync_operation_id: Some(Uuid::new_v4()),
          connection_context: None,
          workspace_id: source_workspace_id,
          target: DocWriteTarget::External(DocumentKey::parse(source_workspace_id.to_string()).unwrap()),
          validated_external_update: Some(ValidatedExternalYjsUpdate::new(decoded, 1024 * 1024)),
          payload,
          space_kind: DocSpaceKind::Workspace,
          actor_user_id: Some(actor_id),
          client_format: None,
          client_capabilities: None,
          initial_provenance: None,
        })
        .await
        .expect("late root delivery must reconcile against the existing Move redirect");
      assert!(
        !yjs::extract_workspace_root_metadata(
          &source_service
            .load_full_doc(source_workspace_id, source_workspace_id)
            .await
            .unwrap(),
        )
        .unwrap()
        .pages
        .iter()
        .any(|page| page.id == "source-key")
      );
      assert_eq!(
        source_service
          .load_full_doc(target_workspace_id, target_workspace_id)
          .await
          .unwrap(),
        target_root,
        "rejecting a late source entry must not alter the target root"
      );
      assert!(
        yjs::extract_workspace_root_metadata(
          &source_service
            .load_full_doc(source_workspace_id, source_workspace_id)
            .await
            .unwrap(),
        )
        .unwrap()
        .pages
        .iter()
        .any(|page| page.id == "returned-key"),
        "a historical Move redirect must not retire a currently owned page"
      );
      sqlx::query(
        "DELETE FROM workspace_content_operation_redirects WHERE operation_id = $1 AND source_id = 'returned-key'",
      )
      .bind(published.id)
      .execute(&pool)
      .await
      .unwrap();
      for table in ["doc_updates", "doc_histories", "comments", "comment_attachments"] {
        let count = sqlx::query_scalar::<_, i64>(&format!(
          "SELECT count(*) FROM {table} WHERE doc_id = $1 AND workspace_id = $2"
        ))
        .bind(doc_id)
        .bind(target_workspace_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1, "{table} must follow the preserved document identity");
      }
      assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_user_permissions WHERE doc_id = $1 AND user_id = $2",)
          .bind(doc_id)
          .bind(actor_id)
          .fetch_one(&pool)
          .await
          .unwrap(),
        1
      );
      assert_eq!(
        sqlx::query_scalar::<_, i64>(
          "SELECT count(*) FROM workspace_content_operation_redirects
           WHERE operation_id = $1 AND source_id = 'source-key' AND target_id = 'source-key'
             AND source_workspace_id <> target_workspace_id",
        )
        .bind(published.id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
      );

      let (window_actor, _) = helpers::seed_user(&pool,&auth,"move-window-owner").await;
      fixture_users.push(window_actor);
      for workspace in [source_workspace_id,target_workspace_id] {
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status,joined_at) VALUES($1,$2,'Owner','Accepted',now())")
          .bind(workspace).bind(window_actor).execute(&pool).await.unwrap();
      }
      let window_doc=source_service.create_page_lifecycle(source_workspace_id,window_actor,Some("Window source".into()),None).await.unwrap().document;
      source_service.rename_page(source_workspace_id,window_doc.id,window_actor,"Source edit".into(),None).await.unwrap();
      // A title command opens a metadata window. Persist content through the
      // normal writer too, so Move/Undo exercise actual pending capture intent.
      let pending_delta=yjs::update_document_title(
        &source_service.load_full_doc(source_workspace_id,window_doc.id).await.unwrap(),
        "Pending title before Move").expect("edit the existing page without adding a second page block");
      source_service.push_update(source_workspace_id,window_doc.id,
        pending_delta,0,DocSpaceKind::Workspace)
        .await.expect("persist pending content before Move admission");
      sqlx::query("INSERT INTO document_versioning_workspace_settings(workspace_id,edit_capture_enabled,edit_capture_interval_ms) VALUES($1,false,1800000),($2,true,900000)")
        .bind(target_workspace_id).bind(source_workspace_id).execute(&pool).await.unwrap();
      let mut move_origin=None;
      for (from,to,title) in [(source_workspace_id,target_workspace_id,"Target edit"),(target_workspace_id,source_workspace_id,"Returned edit")] {
        let mapping=WorkspaceContentIdMapping::new(resource(from,WorkspaceContentResourceKind::Document,&window_doc.external_id),resource(to,WorkspaceContentResourceKind::Document,&window_doc.external_id)).unwrap();
        let pending:Uuid=sqlx::query_scalar("SELECT id FROM document_change_batches WHERE doc_id=$1").bind(window_doc.id).fetch_one(&pool).await.unwrap();
        let moving=prepared_move_batch(&pool, &repository,window_actor,from,to,vec![mapping],move_origin).await;
        assert!(!moving.revision_manifest.documents[0].ownership_row_counts.contains_key("document_edit_capture_state"),
          "mutable intent must not add a requirement to already admitted manifests");
        // Mutable scheduling changes after admission must neither invalidate
        // that manifest nor be lost during Move/receipt-bound Undo.
        sqlx::query("UPDATE document_edit_capture_state SET retry_count=3,next_retry_at=now(),last_capture_at=now()-interval '1 hour' WHERE doc_id=$1")
          .bind(window_doc.id).execute(&pool).await.unwrap();
        fixture_operations.push(moving.operation.id);
        move_origin=Some(moving.operation.id);
        if to==target_workspace_id {
          let before:serde_json::Value=sqlx::query_scalar("SELECT to_jsonb(s) FROM document_edit_capture_state s WHERE doc_id=$1")
            .bind(window_doc.id).fetch_one(&pool).await.unwrap();
          let hook=format!("hist_rollback_{}",Uuid::new_v4().simple());
          // Root publication follows the document/intent transition. Fail there
          // to prove the rebind cannot escape the owning SQL transaction.
          sqlx::query(&format!("CREATE FUNCTION {hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history rollback fixture'; END $$"))
            .execute(&pool).await.unwrap();
          sqlx::query(&format!("CREATE TRIGGER {hook} BEFORE INSERT ON doc_updates FOR EACH ROW WHEN (NEW.doc_id='{to}'::uuid) EXECUTE FUNCTION {hook}()"))
            .execute(&pool).await.unwrap();
          let failed=publisher.publish_move(moving.clone(),"move-capture-late-rollback").await;
          sqlx::query(&format!("DROP TRIGGER {hook} ON doc_updates")).execute(&pool).await.expect("remove exact rollback trigger");
          sqlx::query(&format!("DROP FUNCTION {hook}()")).execute(&pool).await.expect("remove exact rollback function");
          assert!(failed.is_err(),"late root publication must fail");
          let after:serde_json::Value=sqlx::query_scalar("SELECT to_jsonb(s) FROM document_edit_capture_state s WHERE doc_id=$1")
            .bind(window_doc.id).fetch_one(&pool).await.unwrap();
          assert_eq!(after,before,"late failure rolls back owner, schedule, acknowledgements and retry changes");
          assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT workspace_id FROM docs WHERE id=$1")
            .bind(window_doc.id).fetch_one(&pool).await.unwrap(),from);
        }
        publisher.publish_move(moving,"move-window-return").await.expect("canonical window document move");
        let intent=sqlx::query("SELECT * FROM document_edit_capture_state WHERE doc_id=$1").bind(window_doc.id).fetch_one(&pool).await.unwrap();
        assert_eq!(intent.get::<Uuid,_>("workspace_id"),to);
        assert_eq!(intent.get::<Option<bool>,_>("configured_enabled"),Some(to==source_workspace_id));
        assert_eq!(intent.get::<Option<i64>,_>("configured_interval_ms"),Some(if to==source_workspace_id {900000} else {1800000}));
        assert_eq!(intent.get::<i32,_>("retry_count"),0);
        assert!(intent.get::<Option<i64>,_>("last_captured_revision").is_none());
        assert!(intent.get::<Option<chrono::DateTime<Utc>>,_>("last_capture_at").is_some());
        assert_eq!(intent.get::<Option<chrono::DateTime<Utc>>,_>("due_at").is_some(),to==source_workspace_id);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM document_edit_capture_state WHERE doc_id=$1")
          .bind(window_doc.id).fetch_one(&pool).await.unwrap(),1);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM document_change_batches WHERE doc_id=$1")
          .bind(window_doc.id).fetch_one(&pool).await.unwrap(),0,"moving back cannot revive a pending source window");
        source_service.rename_page(to,window_doc.id,window_actor,title.into(),None).await.unwrap();
        let next:(Uuid,Uuid)=sqlx::query_as("SELECT id,workspace_id FROM document_change_batches WHERE doc_id=$1")
          .bind(window_doc.id).fetch_one(&pool).await.unwrap();
        assert_ne!(next.0,pending,"later edits open a fresh canonical window");
        assert_eq!(next.1,to);
      }

      let rollback_doc_id = Uuid::new_v4();
      let conflict_doc_id = Uuid::new_v4();
      for (id, workspace_id, external_id) in [
        (rollback_doc_id, source_workspace_id, "rollback-source"),
        (conflict_doc_id, target_workspace_id, "occupied-target"),
      ] {
        sqlx::query(
          "INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by)
           VALUES ($1, $2, $3, 'Conflict fixture', $4, $4)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(external_id)
        .bind(actor_id)
        .execute(&pool)
        .await
        .unwrap();
      }
      sqlx::query("INSERT INTO document_edit_capture_state(workspace_id,doc_id,dirty_revision) VALUES($1,$2,1)")
        .bind(source_workspace_id).bind(rollback_doc_id).execute(&pool).await.unwrap();
      let rollback_mapping = WorkspaceContentIdMapping::new(
        resource(
          source_workspace_id,
          WorkspaceContentResourceKind::Document,
          "rollback-source",
        ),
        resource(
          target_workspace_id,
          WorkspaceContentResourceKind::Document,
          "occupied-target",
        ),
      )
      .unwrap();
      let rollback_running = running_move(
        &repository,
        operation(
          Uuid::new_v4(),
          Uuid::new_v4(),
          actor_id,
          source_workspace_id,
          target_workspace_id,
          &"9".repeat(64),
        ),
        std::slice::from_ref(&rollback_mapping),
        &mut fixture_operations,
      )
      .await;
      assert!(matches!(
        move_service.execute(rollback_running.clone()).await,
        Err(error) if error.failure.code == WorkspaceContentErrorCode::TargetDocumentKeyConflict
      ));
      assert_eq!(
        sqlx::query_scalar::<_, Uuid>("SELECT workspace_id FROM docs WHERE id = $1")
          .bind(rollback_doc_id)
          .fetch_one(&pool)
          .await
          .unwrap(),
        source_workspace_id,
        "target conflict must leave the source owner unchanged"
      );
      assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT workspace_id FROM document_edit_capture_state WHERE doc_id=$1")
        .bind(rollback_doc_id).fetch_one(&pool).await.unwrap(),source_workspace_id,"rollback preserves the capture intent owner");

      }).catch_unwind().await;

      // Undo requests retain their origin receipt with ON DELETE RESTRICT.
      // Remove all fixture requests before deleting either side of that chain.
      sqlx::query("DELETE FROM workspace_content_operation_requests WHERE operation_id = ANY($1)")
        .bind(&fixture_operations)
        .execute(&pool)
        .await
        .expect("remove fixture Undo request edges");
      sqlx::query("DELETE FROM workspace_content_operations WHERE id = ANY($1)")
        .bind(&fixture_operations)
        .execute(&pool)
        .await
        .unwrap();
      helpers::cleanup_workspaces(&pool, &[source_workspace_id, target_workspace_id]).await;
      helpers::cleanup_users(&pool, &fixture_users).await;
      assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE id = ANY($1)")
          .bind([source_workspace_id, target_workspace_id])
          .fetch_one(&pool)
          .await
          .expect("verify fixture cleanup"),
        0
      );
      if let Err(panic) = result {
        std::panic::resume_unwind(panic);
      }
    },
  );
}

#[test]
fn extract_target_creation_is_hidden_atomic_and_replay_safe() {
  exercise_extract_publication(false, false, false, false, false, false);
}

#[test]
fn extract_git_publication_keeps_content_success_and_durable_retry_ownership() {
  exercise_extract_publication(false, false, true, false, false, false);
}

#[test]
fn extract_disconnect_preserves_git_files_until_permitted_scoped_cleanup() {
  exercise_extract_publication(false, false, true, true, false, false);
}

#[test]
fn extract_git_undo_reverses_only_its_scope_and_preserves_current_edits() {
  exercise_extract_publication(false, false, true, false, true, false);
  exercise_extract_publication(false, false, true, true, true, false);
}

#[test]
fn extract_followup_syncs_preserve_moved_and_detached_ownership() {
  exercise_extract_publication(false, false, true, false, false, true);
  exercise_extract_publication(false, false, true, true, false, true);
}

#[test]
fn extract_ou_manager_publication_survives_revocation_and_preserves_start_snapshot() {
  exercise_extract_publication(true, false, false, false, false, false);
}

#[test]
fn extract_workspace_manager_inherits_owner_memberships_and_survives_source_revocation() {
  exercise_extract_publication(false, true, false, false, false, false);
}

#[allow(clippy::too_many_arguments)]
async fn assert_extract_followup_syncs(
  pool: &sqlx::PgPool,
  state: &myoxus_api::state::ApiState,
  storage: &dyn myoxus_application::ports::BlobStoragePort,
  docs: &DocService,
  actor: Uuid,
  source: Uuid,
  target: Uuid,
  source_profile: Uuid,
  target_profile: Option<Uuid>,
  moved_doc: Uuid,
  remote: &git2::Repository,
  directory: &std::path::Path,
) {
  let tree = remote.head().unwrap().peel_to_commit().unwrap().tree().unwrap();
  let mut files = std::collections::BTreeMap::new();
  tree
    .walk(git2::TreeWalkMode::PreOrder, |root, entry| {
      if let Ok(blob) = remote.find_blob(entry.id()) {
        files.insert(format!("{root}{}", entry.name().unwrap()), blob.content().to_vec());
      }
      git2::TreeWalkResult::Ok
    })
    .unwrap();
  let retained = docs
    .create_page_lifecycle(source, actor, Some("Retained after extraction".into()), None)
    .await
    .unwrap()
    .document;
  let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
  let ids = std::iter::once(source_profile)
    .chain(target_profile)
    .collect::<Vec<_>>();
  let identity = || async {
    let mut rows = Vec::new();
    for table in [
      "git_sync_bindings",
      "git_sync_file_bindings",
      "git_sync_file_baselines",
      "git_sync_path_owners",
      "git_sync_scope_exclusions",
    ] {
      let query = format!("SELECT to_jsonb(t) FROM {table} t WHERE profile_id=ANY($1) ORDER BY to_jsonb(t)::text");
      rows.push(
        sqlx::query_scalar::<_, serde_json::Value>(&query)
          .bind(&ids)
          .fetch_all(pool)
          .await
          .unwrap(),
      );
    }
    rows.push(
      sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT to_jsonb(b) FROM git_sync_baselines b
      JOIN git_sync_bindings d ON d.id=b.binding_id WHERE d.profile_id=ANY($1) ORDER BY b.binding_id",
      )
      .bind(&ids)
      .fetch_all(pool)
      .await
      .unwrap(),
    );
    rows.push(
      sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT to_jsonb(e) FROM workspace_content_extract_targets e WHERE target_workspace_id=$1",
      )
      .bind(target)
      .fetch_all(pool)
      .await
      .unwrap(),
    );
    rows
  };
  let before = identity().await;
  let cutoff = store.history_retention_cutoff(7).await.unwrap();
  for profile in &ids {
    let expired = Uuid::new_v4();
    for (id, days) in [(expired, 30), (Uuid::new_v4(), 20)] {
      sqlx::query(
        "INSERT INTO git_sync_runs(id,profile_id,direction,status,started_at,finished_at)
        VALUES($1,$2,'MyoxusToGit','Failed',now()-make_interval(days=>$3),now()-make_interval(days=>$3))",
      )
      .bind(id)
      .bind(profile)
      .bind(days)
      .execute(pool)
      .await
      .unwrap();
    }
    store.cleanup_auxiliary_history(*profile, cutoff, 1_000).await.unwrap();
    assert!(
      store
        .cleanup_terminal_runs(*profile, cutoff, 1_000)
        .await
        .unwrap()
        .deleted_rows()
        > 0
    );
    assert!(matches!(
      store.get_run(expired).await,
      Err(myoxus_infrastructure::git_sync::GitSyncStoreError::NotFound)
    ));
  }
  assert_eq!(
    identity().await,
    before,
    "history expiry must not mutate receipt-owned bindings, baselines or scope fences"
  );
  let mut original = Vec::new();
  // The existing deterministic runner port accepts a valid, isolated URL. It
  // needs no public network or a new local-file exception in product admission.
  for id in &ids {
    original.push(store.get_profile(*id).await.unwrap());
    sqlx::query("UPDATE git_sync_profiles SET repo_url=$2,sync_direction='MyoxusToGit' WHERE id=$1")
      .bind(id)
      .bind(format!("https://extract.test/{source}.git"))
      .execute(pool)
      .await
      .unwrap();
  }
  let config = myoxus_api::git_sync_engine::runner::RunnerConfig {
    overview_service: state.workspace_overview_service(),
    repo_base_dir: directory.join("followup-mirrors"),
    crypto_key: state.config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    ..Default::default()
  };
  let outputs = crate::git_sync_runner_harness_test::sync_extracted_tree(pool, &config, storage, &ids, &files).await;
  for profile in original {
    sqlx::query("UPDATE git_sync_profiles SET repo_url=$2,sync_direction=$3 WHERE id=$1")
      .bind(profile.id)
      .bind(profile.repo_url)
      .bind(profile.sync_direction.to_string())
      .execute(pool)
      .await
      .unwrap();
  }
  let prefix = "content/extracted-folder/";
  for (path, bytes) in &files {
    if path.starts_with(prefix) {
      assert_eq!(
        outputs[0].get(path),
        Some(bytes),
        "source run must not rewrite/reimport/delete delegated or detached {path}"
      );
    }
  }
  let retained_path: String =
    sqlx::query_scalar("SELECT repo_path FROM git_sync_bindings WHERE profile_id=$1 AND doc_id=$2 AND NOT tombstone")
      .bind(source_profile)
      .bind(retained.id)
      .fetch_one(pool)
      .await
      .unwrap();
  assert!(
    outputs[0].contains_key(&retained_path),
    "the source still publishes its own remaining content"
  );
  assert_eq!(
    sqlx::query_scalar::<_, Uuid>("SELECT workspace_id FROM docs WHERE id=$1")
      .bind(moved_doc)
      .fetch_one(pool)
      .await
      .unwrap(),
    target
  );
  let source_manifest: GitSyncManifest =
    serde_json::from_slice(outputs[0].get(".myoxus/git-sync-manifest.json").unwrap()).unwrap();
  assert!(!source_manifest.documents.iter().any(|entry| entry.doc_id == moved_doc));
  if target_profile.is_some() {
    let target_files = &outputs[1];
    for (path, bytes) in &outputs[0] {
      if !path.starts_with(prefix) {
        assert_eq!(
          target_files.get(path),
          Some(bytes),
          "target run must not change the remaining source scope"
        );
      }
    }
    let current_path: String =
      sqlx::query_scalar("SELECT repo_path FROM git_sync_bindings WHERE profile_id=$1 AND doc_id=$2 AND NOT tombstone")
        .bind(target_profile.unwrap())
        .bind(moved_doc)
        .fetch_one(pool)
        .await
        .unwrap();
    let body = std::str::from_utf8(target_files.get(&current_path).unwrap()).unwrap();
    assert!(
      body.contains("Body survives equal attachments"),
      "only the target publishes current local content, not the old captured Git body: {current_path}: {body}"
    );
    let manifest: GitSyncManifest = serde_json::from_slice(
      target_files
        .get("content/extracted-folder/.myoxus/git-sync-manifest.json")
        .unwrap(),
    )
    .unwrap();
    assert_eq!(manifest.workspace_id, target);
    assert!(manifest.documents.iter().any(|entry| entry.doc_id == moved_doc));
  }
}

fn exercise_extract_publication(
  ou_owned: bool,
  direct_manager: bool,
  git_enabled: bool,
  disconnect: bool,
  undo: bool,
  followup: bool,
) {
  helpers::block_on_large_stack("extract_publication", move || async move {
    // Retain safe publication phases/reasons when an invariant fails.
    let _trace_guard = tracing::subscriber::set_default(
      tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .finish(),
    );
    let (_app, pool, auth, api_state) = helpers::setup_app_with_state().await;
    let (actor_id, _session) = helpers::seed_user(&pool, &auth, "xws_extract_owner").await;
    let workspace_owner_id = if direct_manager {
      helpers::seed_user(&pool, &auth, "xws_extract_workspace_owner").await.0
    } else {
      actor_id
    };
    let source_workspace_id = helpers::create_workspace(&pool, workspace_owner_id).await;
    if direct_manager {
      sqlx::query("INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'Manager', 'Accepted')")
        .bind(source_workspace_id).bind(actor_id).execute(&pool).await.expect("seed direct workspace manager");
    }
    use myoxus_infrastructure::organization::{
      PgOrganizationPolicyRepository, PgOrganizationUnitMemberRepository, PgOrganizationUnitRepository,
      PgOrganizationUnitWorkspaceRepository, PgUserFeatureLookup,
    };
    let organization_permissions = Arc::new(myoxus_application::organization::OrganizationPermissionService::new(
      Arc::new(PgOrganizationUnitMemberRepository::new(pool.clone())),
      Arc::new(PgOrganizationUnitRepository::new(pool.clone())),
      Arc::new(PgOrganizationUnitWorkspaceRepository::new(pool.clone())),
      Arc::new(PgOrganizationPolicyRepository::new(pool.clone())),
      Arc::new(PgUserFeatureLookup::new(pool.clone())),
    ));
    let permission =
      Arc::new(PermissionService::new(auth.clone()).with_organization_permissions(organization_permissions.clone()));
    let mut organization_fixture = None;
    let owner = if ou_owned {
      let organization_id = helpers::default_organization_id(&pool).await;
      let type_id = helpers::preset_unit_type_id(&pool, "team").await;
      let unit_id =
        helpers::create_organization_unit(&pool, organization_id, type_id, None, "Extract manager unit").await;
      helpers::make_manager_of(&pool, actor_id, unit_id).await;
      let previous_policy: bool =
        sqlx::query_scalar("SELECT manager_can_create_workspaces FROM organization_policy WHERE organization_id = $1")
          .bind(organization_id)
          .fetch_one(&pool)
          .await
          .expect("original OU creation policy");
      sqlx::query("UPDATE organization_policy SET manager_can_create_workspaces = false WHERE organization_id = $1")
        .bind(organization_id)
        .execute(&pool)
        .await
        .expect("ordinary creation policy is not an extraction prerequisite");
      sqlx::query("UPDATE workspaces SET owner_user_id = NULL, owner_principal_type = 'ou', owner_principal_id = $2, management_unit_id = $2 WHERE id = $1")
        .bind(source_workspace_id).bind(unit_id).execute(&pool).await.expect("OU-owned source");
      sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
        .bind(source_workspace_id)
        .bind(actor_id)
        .execute(&pool)
        .await
        .expect("manager has no direct workspace membership");
      sqlx::query(
        "INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship) VALUES ($1, $2, 'owner')",
      )
      .bind(unit_id)
      .bind(source_workspace_id)
      .execute(&pool)
      .await
      .expect("source OU owner link");
      organization_fixture = Some((organization_id, unit_id, previous_policy));
      WorkspaceContentOwnerPrincipal {
        principal_type: OwnerPrincipalType::Ou,
        principal_id: unit_id,
      }
    } else {
      WorkspaceContentOwnerPrincipal {
        principal_type: OwnerPrincipalType::User,
        principal_id: workspace_owner_id,
      }
    };
    use futures_util::FutureExt;
    let target_workspace_id = Uuid::new_v4();
    let mut fixture_workspaces = vec![source_workspace_id, target_workspace_id];
    let mut fixture_operations = Vec::new();
    let git_directory = tempfile::tempdir().unwrap();
    let outcome = std::panic::AssertUnwindSafe(async {
    sqlx::query(
      "INSERT INTO docs (id, workspace_id, title, is_workspace_root, created_by, updated_by)
       VALUES ($1, $1, 'Extract source', true, $2, $2)",
    )
    .bind(source_workspace_id)
    .bind(actor_id)
    .execute(&pool)
    .await
    .expect("seed source root");
    sqlx::query(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $1, $2, 1)",
    )
    .bind(source_workspace_id)
    .bind(yjs::create_initial_workspace_doc("Extract source"))
    .execute(&pool)
    .await
    .expect("seed source root update");
    let folder_id = Uuid::new_v4().to_string();
    let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
    let organizer_service = OrganizerService::new(doc_service.clone());
    organizer_service
      .create_folder(
        source_workspace_id,
        CreateOrganizerFolder {
          id: folder_id.clone(),
          parent_id: None,
          name: "Extracted Folder".to_string(),
          index: Some("a0".to_string()),
        },
      )
      .await
      .expect("create Extract source folder");
    let document_id = Uuid::new_v4();
    let document_key = Uuid::new_v4().to_string();
    let blob_key = "extract-attachment.bin";
    let equal_blob_key = "extract-equal-attachment.bin";
    sqlx::query(
      "INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by)
       VALUES ($1, $2, $3, 'Extracted document', $4, $4)",
    )
    .bind(document_id)
    .bind(source_workspace_id)
    .bind(&document_key)
    .bind(actor_id)
    .execute(&pool)
    .await
    .expect("seed Extract document");
    let tag_id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace_tags (id,workspace_id,name,slug,color_role) VALUES ($1,$2,'Extract Tag','extract-tag','tag.blue')")
      .bind(tag_id).bind(source_workspace_id).execute(&pool).await.unwrap();
    sqlx::query(
      "INSERT INTO workspace_tag_document_assignments (workspace_id,doc_id,tag_id,position) VALUES ($1,$2,$3,0)",
    )
    .bind(source_workspace_id)
    .bind(document_id)
    .bind(tag_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $2, $3, 1)",
    )
    .bind(document_id)
    .bind(source_workspace_id)
    .bind(yjs::append_imported_attachments(&yjs::markdown_to_yjs("Extracted document","Body survives equal attachments").unwrap(),
      &[blob_key,equal_blob_key].map(|key| yjs::ImportedAttachment {source_id:key.into(),name:key.into(),mime:"application/octet-stream".into(),size:18})).unwrap())
    .execute(&pool)
    .await
    .expect("seed Extract document update");
    sqlx::query(
      "INSERT INTO doc_user_permissions (user_id, doc_id, role)
       VALUES ($2, $1, 'Owner')",
    )
    .bind(document_id)
    .bind(actor_id)
    .execute(&pool)
    .await
    .expect("seed Extract document permission");
    organizer_service
      .create_link(
        source_workspace_id,
        CreateOrganizerLink {
          id: Uuid::new_v4().to_string(),
          parent_id: folder_id.clone(),
          link_type: OrganizerLinkType::Doc,
          target_id: document_key.clone(),
          target_workspace_id: None,
          index: Some("a1".to_string()),
        },
      )
      .await
      .expect("link Extract document");
    let organizer_snapshot = organizer_service
      .snapshot(source_workspace_id)
      .await
      .expect("snapshot Extract source organizer");
    let folder = resource(
      source_workspace_id,
      WorkspaceContentResourceKind::Folder,
      folder_id.clone(),
    );
    let planned_operation_id = Uuid::new_v4();
    let graph = WorkspaceContentGraphBuilder
      .build(WorkspaceContentGraphInput {
        operation_id: planned_operation_id,
        kind: WorkspaceContentOperationKind::ExtractFolder,
        source_workspace_id,
        target_workspace_id,
        selection: WorkspaceContentSelection::FolderSubtree {
          organizer: organizer_snapshot,
          folder_id: folder_id.clone(),
        },
        resources: vec![
          WorkspaceContentGraphResource {
        database_system_role: None,
            resource: folder,
            permission_resource_id: None,
            revision: "extract-folder-revision".to_string(),
            display_name: Some("Extracted Folder".to_string()),
            schema_revision: None,
            persistence_relations: vec!["doc_updates".to_string()],
            publicly_shared: false,
            tag_archived: false,
          },
          WorkspaceContentGraphResource {
        database_system_role: None,
            resource: resource(
              source_workspace_id,
              WorkspaceContentResourceKind::Document,
              document_key.clone(),
            ),
            permission_resource_id: Some(document_id),
            revision: "extract-document-revision".to_string(),
            display_name: Some("Extracted document".to_string()),
            schema_revision: None,
            persistence_relations: vec!["docs".to_string()],
            publicly_shared: false,
            tag_archived: false,
          },
          WorkspaceContentGraphResource {
        database_system_role: None,
            resource: resource(source_workspace_id, WorkspaceContentResourceKind::Blob, blob_key),
            permission_resource_id: None,
            revision: "extract-blob-revision".to_string(),
            display_name: Some("Extract attachment".to_string()),
            schema_revision: None,
            persistence_relations: vec!["blobs".to_string()],
            publicly_shared: false,
            tag_archived: false,
          },
          WorkspaceContentGraphResource {
        database_system_role: None,
            resource: resource(source_workspace_id,WorkspaceContentResourceKind::Blob,equal_blob_key),
            permission_resource_id:None,revision:"extract-equal-blob".into(),display_name:Some("Equal bytes".into()),
            schema_revision:None,persistence_relations:vec!["blobs".into()],publicly_shared:false,tag_archived:false,
          },
          WorkspaceContentGraphResource {
        database_system_role: None,
            resource: resource(
              source_workspace_id,
              WorkspaceContentResourceKind::Tag,
              tag_id.to_string(),
            ),
            permission_resource_id: None,
            revision: "extract-tag-revision".into(),
            display_name: Some("Extract Tag".into()),
            schema_revision: None,
            persistence_relations: vec!["workspace_tags".into()],
            publicly_shared: false,
            tag_archived: false,
          },
        ],
        references: vec![
          WorkspaceContentGraphReference {
            relation: "blobs".to_string(),
            source: resource(
              source_workspace_id,
              WorkspaceContentResourceKind::Document,
              document_key.clone(),
            ),
            target: resource(source_workspace_id, WorkspaceContentResourceKind::Blob, blob_key),
            purpose: WorkspaceContentReferencePurpose::OwnedDependency,
            target_exists: true,
          },
          WorkspaceContentGraphReference {
            relation:"blobs".into(),source:resource(source_workspace_id,WorkspaceContentResourceKind::Document,&document_key),
            target:resource(source_workspace_id,WorkspaceContentResourceKind::Blob,equal_blob_key),
            purpose:WorkspaceContentReferencePurpose::OwnedDependency,target_exists:true,
          },
          WorkspaceContentGraphReference {
            relation: "workspace_tag_document_assignments".into(),
            source: resource(
              source_workspace_id,
              WorkspaceContentResourceKind::Document,
              document_key.clone(),
            ),
            target: resource(
              source_workspace_id,
              WorkspaceContentResourceKind::Tag,
              tag_id.to_string(),
            ),
            purpose: WorkspaceContentReferencePurpose::OwnedDependency,
            target_exists: true,
          },
        ],
        target_definitions: Vec::new(),
        target_resource_ids: Vec::new(),
        mapping_overrides: Vec::new(),

      })
      .expect("valid Extract graph");
    let mappings = graph
      .mappings
      .iter()
      .map(|mapping| mapping.mapping.clone())
      .collect::<Vec<_>>();
    let target_blob_key=mappings.iter().find(|m|m.source.kind()==WorkspaceContentResourceKind::Blob && m.source.resource_id()==blob_key).unwrap().target.resource_id().to_string();
    let shared_target_key=mappings.iter().find(|m|m.source.kind()==WorkspaceContentResourceKind::Blob && m.source.resource_id()==equal_blob_key).unwrap().target.resource_id().to_string();
    let authorizer = WorkspaceContentAuthorizer::new(
      permission.clone(),
      PgWorkspaceContentAuthorizationSource::new(pool.clone()),
    );
    let root_configuration = configure_overview(&pool, source_workspace_id, WorkspaceOverviewSettingsPatch {
      folder_ids: Some(Some(vec![folder_id.clone()])),
      register_presentation: Some(Some(overview_columns("status"))), ..Default::default()
    }).await;
    let overview_before = configure_overview(&pool, source_workspace_id, WorkspaceOverviewSettingsPatch {
      scope: OverviewSettingsScope::Folder(folder_id.clone()),
      introduction: Some(Some(resource(source_workspace_id, WorkspaceContentResourceKind::Document, &document_key))),
      ..Default::default()
    }).await;
    let workspace_store = SqlxWorkspaceStore::new(pool.clone(), crate::helpers::database_starter_catalog());
    let options = WorkspaceContentAuthorizationOptions {
      overview: Some(WorkspaceContentOverviewSnapshot {
        source: WorkspaceContentOverviewState {
          workspace_id: source_workspace_id, revision: overview_before.overview_revision,
          settings: overview_before.overview_settings.clone(),
        }, target: None, extracted_folder_id: Some(folder_id.clone()),
      }),
      copy_document_acl: false,
      extract_target_principal: Some(owner.clone()),
      ..Default::default()
    };
    let authorized = authorizer
      .preflight(actor_id, graph.clone(), options.clone())
      .await
      .expect("authorize extraction through the central effective role");
    assert!(authorized.blockers.is_empty());
    let preview_revision = authorized.revision.clone();
    let now = Utc::now();
    let draft = WorkspaceContentOperationRecord {
      id: planned_operation_id,
      idempotency_id: Uuid::new_v4(),
      actor_id,
      kind: WorkspaceContentOperationKind::ExtractFolder,
      source_workspace_id,
      target_workspace_id: None,
      status: WorkspaceContentOperationStatus::Draft,
      preview_revision: Some(preview_revision.clone()),
      manifest_hash: hex::encode(Sha256::digest(graph.revision.as_bytes())),
      error: None,
      diagnostic_instance_id: None,
      created_at: now,
      updated_at: now,
    };
    fixture_operations.push(draft.id);
    let repository = PgWorkspaceContentOperationRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
    repository.create_or_get(draft.clone()).await.expect("create Extract");
    repository
      .store_request(
        draft.id,
        &WorkspaceContentOperationRequest {
          kind: WorkspaceContentOperationKind::ExtractFolder,
          source_workspace_id,
          target_workspace_id,
          selection: WorkspaceContentOperationSelection::FolderSubtree {
            folder_id: folder_id.clone(),
          },
          copy_document_acl: false,
          extract_workspace_name: Some("Extracted Folder".to_string()), git_sync_choice: None,
          link_entry_id: None,
          link_parent_id: None,
          link_index: None,
        },
        None,
      )
      .await
      .expect("store Extract request with reserved target");
    let previewed = repository
      .transition(
        draft.id,
        WorkspaceContentOperationStatus::Draft,
        WorkspaceContentOperationStatus::Previewed,
        None,
        None,
      )
      .await
      .expect("preview Extract");
    let name = WorkspaceName::parse("Extracted Folder").expect("valid target name");
    let created = WorkspaceContentExtractTargetService::new(repository.clone())
      .create(previewed.clone(), name.clone(), authorized.clone())
      .await
      .expect("create hidden Extract target");
    assert_eq!(created.workspace_id, target_workspace_id);
    repository
      .store_manifest(draft.id, &draft.manifest_hash, &mappings, &[])
      .await
      .expect("store Extract manifest after its isolated target exists");

    let target = sqlx::query(
      "SELECT lifecycle_state, lifecycle_owner_kind, lifecycle_owner_id,
              owner_principal_type::text AS owner_principal_type, owner_principal_id
         FROM workspaces WHERE id = $1",
    )
    .bind(target_workspace_id)
    .fetch_one(&pool)
    .await
    .expect("load hidden target");
    assert_eq!(target.get::<String, _>("lifecycle_state"), "extracting");
    assert_eq!(
      target.get::<Option<String>, _>("lifecycle_owner_kind").as_deref(),
      Some("workspace_content")
    );
    assert_eq!(target.get::<Option<Uuid>, _>("lifecycle_owner_id"), Some(draft.id));
    assert_eq!(
      target.get::<String, _>("owner_principal_type"),
      owner.principal_type.as_str()
    );
    assert_eq!(
      target.get::<Option<Uuid>, _>("owner_principal_id"),
      Some(owner.principal_id)
    );
    assert_eq!(
      sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM workspace_memberships
          WHERE workspace_id = $1 AND user_id = $2 AND role = 'Owner' AND status = 'Accepted'",
      )
      .bind(target_workspace_id)
      .bind(actor_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
      if ou_owned || direct_manager { 0 } else { 1 }
    );
    assert!(
      sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT payload FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1 AND sequence = 1",
      )
      .bind(target_workspace_id)
      .fetch_one(&pool)
      .await
      .expect("initial target root update")
      .len()
        > 8,
      "Extract root must be a materialized Yjs update, not an empty placeholder"
    );

    let replay = WorkspaceContentExtractTargetService::new(PgWorkspaceContentOperationRepository::new(pool.clone(), crate::helpers::database_starter_catalog()))
      .create(previewed, name, authorized)
      .await
      .expect("exact replay from a fresh repository instance");
    assert_eq!(replay, created);
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_content_extract_targets WHERE operation_id = $1")
        .bind(draft.id)
        .fetch_one(&pool)
        .await
        .unwrap(),
      1
    );

    repository
      .store_manifest(draft.id, &draft.manifest_hash, &mappings, &[])
      .await
      .expect("persist Extract mapping manifest");
    let queued = repository
      .transition(
        draft.id,
        WorkspaceContentOperationStatus::Previewed,
        WorkspaceContentOperationStatus::Queued,
        None,
        None,
      )
      .await
      .expect("queue Extract");
    let running = repository
      .transition(
        draft.id,
        WorkspaceContentOperationStatus::Queued,
        WorkspaceContentOperationStatus::Running,
        None,
        Some("extract-publication-test"),
      )
      .await
      .expect("claim Extract");
    assert_eq!(queued.target_workspace_id, Some(target_workspace_id));
    let repository = Arc::new(repository);
    let storage_root = tempfile::tempdir().expect("temporary Extract storage");
    let storage = Arc::new(
      StorageAdapter::new_fs(storage_root.path().to_str().expect("UTF-8 storage path"))
        .expect("Extract publication storage"),
    );
    let blob_bytes = Bytes::from_static(b"extract attachment");
    sqlx::query(
      "INSERT INTO blobs (workspace_id, key, size, mime, status)
       VALUES ($1, $2, $3, 'application/octet-stream', 'completed')",
    )
    .bind(source_workspace_id)
    .bind(blob_key)
    .bind(i64::try_from(blob_bytes.len()).expect("bounded fixture"))
    .execute(&pool)
    .await
    .expect("seed Extract Blob metadata");
    storage
      .write_blob(BlobWriteRequest {
        key: format!("{source_workspace_id}/{blob_key}"),
        content_type: Some("application/octet-stream".to_string()),
        body: blob_bytes.clone(),
      })
      .await
      .expect("seed Extract Blob payload");
    sqlx::query("INSERT INTO blobs(workspace_id,key,size,mime,status) VALUES($1,$2,$3,'application/octet-stream','completed')")
      .bind(source_workspace_id).bind(equal_blob_key).bind(blob_bytes.len() as i64).execute(&pool).await.unwrap();
    storage.write_blob(BlobWriteRequest{key:format!("{source_workspace_id}/{equal_blob_key}"),content_type:Some("application/octet-stream".into()),body:blob_bytes.clone()}).await.unwrap();
    let transfer = WorkspaceContentMovePublicationService::new(
      repository.clone(),
      repository.clone(),
      permission.clone(),
      repository.clone(),
      repository.clone(),
      doc_service.clone(),
      Arc::new(PgWorkspaceContentMovePublicationRepository::new(
        pool.clone(),
        storage.clone(), crate::helpers::database_starter_catalog())),
      "extract-publication-test".to_string(),
    )
    .with_extract(repository.clone(), storage.clone());
    assert_eq!(
      permission
        .get_effective_workspace_role(actor_id, target_workspace_id)
        .await
        .expect("ordinary target access"),
      None,
      "an unpublished target must remain hidden from ordinary workspace authorization"
    );
    assert_eq!(
      repository
        .extract_target_owner(&running)
        .await
        .expect("owned target principal"),
      Some(owner.clone())
    );
    let mut unrelated_operation = running.clone();
    unrelated_operation.id = Uuid::new_v4();
    assert_eq!(
      repository
        .extract_target_owner(&unrelated_operation)
        .await
        .expect("other operation denied"),
      None
    );
    let mut unrelated_actor = running.clone();
    unrelated_actor.actor_id = Uuid::new_v4();
    assert_eq!(
      repository
        .extract_target_owner(&unrelated_actor)
        .await
        .expect("other actor denied"),
      None
    );

    if let Some((organization_id, unit_id, _)) = organization_fixture {
      assert!(
        !organization_permissions
          .manageable_workspace_ids(actor_id)
          .await
          .expect("manager discovery")
          .contains(&target_workspace_id)
      );
      sqlx::query("UPDATE organization_unit_member SET role = 'member' WHERE unit_id = $1 AND user_id = $2")
        .bind(unit_id)
        .bind(actor_id)
        .execute(&pool)
        .await
        .expect("revoke OU manager role");
      sqlx::query("UPDATE organization_policy SET manager_can_create_workspaces = false WHERE organization_id = $1")
        .bind(organization_id)
        .execute(&pool)
        .await
        .expect("revoke OU creation policy");
    } else if !git_enabled {
      sqlx::query("UPDATE workspace_memberships SET role = 'Reader' WHERE workspace_id = $1 AND user_id = $2")
        .bind(target_workspace_id)
        .bind(actor_id)
        .execute(&pool)
        .await
        .expect("revoke target write capability");
      assert!(
        matches!(transfer.execute(running.clone()).await, Err(error) if error.failure.code == WorkspaceContentErrorCode::ExtractMembershipSnapshotChanged)
      );
      sqlx::query("UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2")
        .bind(target_workspace_id)
        .bind(actor_id)
        .bind(if direct_manager { "Manager" } else { "Owner" })
        .execute(&pool)
        .await
        .expect("restore target membership snapshot");
    }
    sqlx::query("UPDATE workspaces SET lifecycle_owner_id = $2 WHERE id = $1")
      .bind(target_workspace_id)
      .bind(Uuid::new_v4())
      .execute(&pool)
      .await
      .expect("change target lifecycle owner");
    assert!(
      matches!(transfer.execute(running.clone()).await, Err(error) if error.failure.code == WorkspaceContentErrorCode::TransferForbidden)
    );
    sqlx::query("UPDATE workspaces SET lifecycle_owner_id = $2 WHERE id = $1")
      .bind(target_workspace_id)
      .bind(running.id)
      .execute(&pool)
      .await
      .expect("restore operation-owned target");

    // Freeze publication content before changing permissions. Neither the
    // worker replay nor the SQL publication may reinterpret actor authority.
    let mut git_descendant=None;
    let git_profile = if git_enabled {
      let profile_id = Uuid::new_v4();
      sqlx::query("INSERT INTO git_sync_profiles (id,workspace_id,owner_id,repo_url,branch,root_path,sync_direction,trigger_mode,auth_method,enabled)
        VALUES ($1,$2,$3,$4,'main','content/','GitToMyoxus','Manual','HttpsToken',true)")
        .bind(profile_id).bind(source_workspace_id).bind(actor_id)
        .bind(format!("file://{}",git_directory.path().join("remote.git").display()))
        .execute(&pool).await.unwrap();
      let credential_id=Uuid::new_v4();
      let encrypted=myoxus_infrastructure::crypto::encrypt(&api_state.config.crypto.private_key,br#"{"token":"local-fixture-not-a-secret"}"#).unwrap();
      sqlx::query("INSERT INTO git_sync_credentials (id,profile_id,auth_method,encrypted_data) VALUES ($1,$2,'HttpsToken',$3)")
        .bind(credential_id).bind(profile_id).bind(encrypted).execute(&pool).await.unwrap();
      sqlx::query("UPDATE git_sync_profiles SET credential_id=$2 WHERE id=$1")
        .bind(profile_id).bind(credential_id).execute(&pool).await.unwrap();
      let git_store=myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
      if undo {
        let workspace=helpers::create_workspace(&pool,actor_id).await;
        fixture_workspaces.push(workspace);
        let child=Uuid::new_v4();
        sqlx::query("INSERT INTO git_sync_profiles (id,workspace_id,owner_id,repo_url,branch,root_path,manifest_path,sync_direction,trigger_mode,auth_method,enabled)
          VALUES ($1,$2,$3,$4,'main','content/extracted-folder/delegated','content/extracted-folder/delegated/.myoxus/git-sync-manifest.json','GitToMyoxus','Manual','HttpsToken',false)")
          .bind(child).bind(workspace).bind(actor_id).bind(format!("file://{}",git_directory.path().join("remote.git").display())).execute(&pool).await.unwrap();
        let fence=git_store.add_scope_exclusion(profile_id,"content/extracted-folder/delegated",true,Some(child),Uuid::new_v4(),0).await.unwrap();
        git_descendant=Some((child,fence));
      }
      let source = git_store.get_profile(profile_id).await.unwrap();
      let binding_id = Uuid::new_v4();
      let sync_id = Uuid::new_v4();
      let path = "content/extracted-folder/doc.md";
      sqlx::query("INSERT INTO git_sync_bindings (id,profile_id,workspace_id,doc_id,sync_id,repo_path)
        VALUES ($1,$2,$3,$4,$5,$6)")
        .bind(binding_id).bind(profile_id).bind(source_workspace_id).bind(document_id).bind(sync_id).bind(path)
        .execute(&pool).await.unwrap();
      let file_id = Uuid::new_v4();
      let file_hash = format!("{:x}", Sha256::digest(&blob_bytes));
      sqlx::query("INSERT INTO git_sync_file_bindings (id,profile_id,workspace_id,blob_key,repo_path,content_hash)
        VALUES ($1,$2,$3,$4,'content/extracted-folder/attachment.bin',$5)")
        .bind(file_id).bind(profile_id).bind(source_workspace_id).bind(blob_key).bind(&file_hash)
        .execute(&pool).await.unwrap();
      sqlx::query("INSERT INTO git_sync_file_baselines (profile_id,blob_key,content_hash) VALUES ($1,$2,$3)")
        .bind(profile_id).bind(blob_key).bind(&file_hash).execute(&pool).await.unwrap();
      let shared_id=Uuid::new_v4();
      sqlx::query("INSERT INTO git_sync_file_bindings (id,profile_id,workspace_id,blob_key,repo_path,content_hash)
        VALUES ($1,$2,$3,$4,'content/shared.bin',$5)")
        .bind(shared_id).bind(profile_id).bind(source_workspace_id).bind(equal_blob_key).bind(&file_hash).execute(&pool).await.unwrap();
      let shared_path=myoxus_application::git_sync::export::asset_repo_path("content/extracted-folder",&shared_target_key,"application/octet-stream").unwrap().as_str().to_owned();
      let body="Accepted Git body; later target edits must not be exported here.\n\n![Shared](../shared.bin)\n\n![SharedRef][asset]\n\n[asset]: ../shared.bin \"kept title\"\n\n`[literal](../shared.bin)`\n";
      let markdown=myoxus_application::git_sync::export::compose_markdown_file(&myoxus_application::git_sync::export::ExportFrontmatter {
        sync_id,doc_id:document_id,workspace_id:source_workspace_id,title:"Extracted document".into(),
      },body);
      let marker=myoxus_application::workspace_overview::markdown::GIT_OVERVIEW_MARKER;
      let source_overview=format!("{marker}\n\n# Extract source\n\n[Extract source](README.md)\n\n- [Introduction reference](extracted-folder/README.md)\n\n## Folders\n\n- [Extracted Folder](extracted-folder/README.md)\n\n## Documents\n\n");
      let target_overview=format!("{marker}\n\n# Extracted Folder\n\n[Extract source](../README.md) / [Extracted Folder](README.md)\n\n## Documents\n\n| Title |\n| --- |\n| [Extracted document](doc.md) |\n");
      let mut manifest=GitSyncManifest::new(source_workspace_id,"captured".into(),vec![GitSyncManifestFolder {
        organizer_id:folder_id.clone(),parent_organizer_id:None,name:"Extracted Folder".into(),
        organizer_path:vec![folder_id.clone()],path:vec!["Extracted Folder".into()],
        overview:Some(GitSyncManifestOverview {repo_path:"content/extracted-folder/README.md".into(),content_hash:format!("{:x}",Sha256::digest(target_overview.as_bytes()))}),
      }],vec![GitSyncManifestDocument {doc_id:document_id,organizer_entry_id:None,organizer_folder_ids:vec![folder_id.clone()],
        repo_path:path.into(),title:"Extracted document".into(),content_hash:format!("{:x}",Sha256::digest(body.as_bytes()))}]);
      manifest.overview=Some(GitSyncManifestOverview {repo_path:"content/README.md".into(),content_hash:format!("{:x}",Sha256::digest(source_overview.as_bytes()))});
      if disconnect && !undo {
        for child in ["edited","delegated"] {
          manifest.folders.push(GitSyncManifestFolder {organizer_id:child.into(),parent_organizer_id:Some(folder_id.clone()),
            organizer_path:vec![folder_id.clone(),child.into()],path:vec!["Extracted Folder".into(),child.into()],name:child.into(),
            overview:Some(GitSyncManifestOverview {repo_path:format!("content/extracted-folder/{child}/README.md"),
              content_hash:format!("{:x}",Sha256::digest(b"generated child"))})});
        }
      }
      let mut files=std::collections::BTreeMap::from([
        (path.to_owned(),markdown.into_bytes()),
        ("content/README.md".into(),source_overview.into_bytes()),
        ("content/extracted-folder/README.md".into(),target_overview.into_bytes()),
        ("content/extracted-folder/attachment.bin".into(),blob_bytes.to_vec()),
        ("content/shared.bin".into(),blob_bytes.to_vec()),
        (source.manifest_path.clone(),manifest.to_json().unwrap().into_bytes()),
      ]);
      if disconnect && !undo {
        for child in ["edited","delegated"] {
          files.insert(format!("content/extracted-folder/{child}/README.md"),b"generated child".to_vec());
        }
      }
      if undo {
        files.insert("content/extracted-folder/delegated/note.md".into(),b"independently delegated content".to_vec());
        files.insert("content/extracted-folder/delegated/.myoxus/git-sync-manifest.json".into(),b"independently delegated manifest".to_vec());
      }
      let remote=git2::Repository::init_bare(git_directory.path().join("remote.git")).unwrap();
      let local=git2::Repository::init_opts(git_directory.path().join("seed"),git2::RepositoryInitOptions::new().initial_head("main")).unwrap();
      for (path,bytes) in &files {
        let destination=local.workdir().unwrap().join(path);
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();std::fs::write(destination,bytes).unwrap();
      }
      let mut index=local.index().unwrap();index.add_all(["*"],git2::IndexAddOption::DEFAULT,None).unwrap();index.write().unwrap();
      let tree=local.find_tree(index.write_tree().unwrap()).unwrap();
      let signature=git2::Signature::now("Git fixture","fixture@myoxus.test").unwrap();
      let oid=local.commit(Some("HEAD"),&signature,&signature,"accepted capture",&tree,&[]).unwrap();
      let baseline_hash=if disconnect {format!("{:x}",Sha256::digest(body.as_bytes()))} else {
        let imported=myoxus_application::markdown::markdown_to_yjs("Extracted document",body).unwrap();
        let normalized=myoxus_application::markdown::yjs_to_markdown(&imported).unwrap().unwrap();
        format!("{:x}",Sha256::digest(normalized.markdown.as_bytes()))
      };
      sqlx::query("INSERT INTO git_sync_baselines (binding_id,content_hash,commit_oid,myoxus_updated_at) VALUES ($1,$2,$3,now())")
        .bind(binding_id).bind(&baseline_hash).bind(oid.to_string()).execute(&pool).await.unwrap();
      if disconnect {
        sqlx::query("INSERT INTO git_sync_conflicts (profile_id,binding_id,doc_id,repo_path,conflict_type) VALUES ($1,$2,$3,$4,'BothModified')")
          .bind(profile_id).bind(binding_id).bind(document_id).bind(path).execute(&pool).await.unwrap();
        let historic_run=Uuid::new_v4();
        sqlx::query("INSERT INTO git_sync_runs (id,profile_id,direction,trigger_source,status,finished_at,commit_after,observed_remote_oid) VALUES ($1,$2,'GitToMyoxus','Manual','Completed',now(),$3,$3)")
          .bind(historic_run).bind(profile_id).bind(oid.to_string()).execute(&pool).await.unwrap();
        for (key,repo_path) in [(blob_key,"content/extracted-folder/attachment.bin"),(equal_blob_key,"content/shared.bin")] {
          sqlx::query("INSERT INTO git_sync_file_conflicts (profile_id,run_id,blob_key,repo_path) VALUES ($1,$2,$3,$4)")
            .bind(profile_id).bind(historic_run).bind(key).bind(repo_path).execute(&pool).await.unwrap();
        }
        let history:i64=sqlx::query_scalar("INSERT INTO doc_histories (doc_id,workspace_id,snapshot) VALUES ($1,$2,$3) RETURNING id")
          .bind(document_id).bind(source_workspace_id).bind(vec![0u8]).fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO git_sync_history_capture_receipts (profile_id,activation_generation,history_id,workspace_id) VALUES ($1,1,$2,$3)")
          .bind(profile_id).bind(history).bind(source_workspace_id).execute(&pool).await.unwrap();
      }
      local.remote("origin",remote.path().to_str().unwrap()).unwrap().push(&["refs/heads/main:refs/heads/main"],None).unwrap();
      remote.set_head("refs/heads/main").unwrap();
      let capture=myoxus_api::git_sync_engine::extract_capture::ExtractGitCapture::new(api_state.clone());
      let capture_paths=vec![path.into(),"content/extracted-folder/attachment.bin".into(),"content/shared.bin".into()];
      let verified=capture.capture(actor_id,&source,&folder_id,&capture_paths).await.unwrap().unwrap();
      assert_eq!(verified.head_oid,oid.to_string());
      let offline=git_directory.path().join("offline.git");
      std::fs::rename(remote.path(),&offline).unwrap();
      let cached=capture.capture(actor_id,&source,&folder_id,&capture_paths).await.unwrap().unwrap();
      assert_eq!(cached.head_oid,verified.head_oid,"an outage may reuse exact last-verified structural evidence");
      let mut stale=source.clone();stale.updated_at+=chrono::Duration::seconds(1);
      assert!(capture.capture(actor_id,&stale,&folder_id,&capture_paths).await.unwrap().is_none(),"configuration drift invalidates offline proof");
      std::fs::rename(&offline,git_directory.path().join("remote.git")).unwrap();
      let plan = myoxus_application::workspace_content_operation::WorkspaceContentGitSyncPlan {
        undo: None,
        target_configuration: Some(myoxus_application::workspace_content_operation::extract_git_profile_configuration(&source)),
        choice: if disconnect { myoxus_application::workspace_content_operation::WorkspaceContentGitSyncChoice::Disconnect }
          else { myoxus_application::workspace_content_operation::WorkspaceContentGitSyncChoice::Move },
        source_profile_id: profile_id, source_profile_owner_id: actor_id,
        source_profile_updated_at: source.updated_at, source_scope_revision: source.scope_revision,
        direction: source.sync_direction, trigger: source.trigger_mode, intended_enabled: source.enabled,
        repository: source.repo_url, branch: source.branch, source_root: source.root_path,
        source_manifest: source.manifest_path, target_root: "content/extracted-folder".into(),
        target_manifest: "content/extracted-folder/.myoxus/git-sync-manifest.json".into(),
        remote_oid: Some(oid.to_string()), observed_hashes: files.iter().map(|(path,bytes)|(path.clone(),format!("{:x}",Sha256::digest(bytes)))).collect(), manifest_inventory: Some(serde_json::to_value(manifest).unwrap()),
        documents: vec![myoxus_application::workspace_content_operation::WorkspaceContentGitSyncDocument {
          binding_id, doc_id: document_id, sync_id, repo_path: path.into(), content_hash: None,
          baseline_hash: Some(baseline_hash),
        }], files: vec![myoxus_application::workspace_content_operation::WorkspaceContentGitSyncFile {
          binding_id: file_id, blob_key: blob_key.into(), repo_path: "content/extracted-folder/attachment.bin".into(), content_hash: file_hash,
        }], shared_files: vec![myoxus_application::workspace_content_operation::WorkspaceContentGitSyncSharedFile {
          source:myoxus_application::workspace_content_operation::WorkspaceContentGitSyncFile {
            binding_id:shared_id,blob_key:equal_blob_key.into(),repo_path:"content/shared.bin".into(),content_hash:format!("{:x}",Sha256::digest(&blob_bytes)),
          },target_blob_key:shared_target_key.clone(),target_repo_path:shared_path,mime_type:"application/octet-stream".into(),file_size:blob_bytes.len() as i64,
        }], delegated_descendants: if let Some((_,fence))=&git_descendant {vec![myoxus_application::workspace_content_operation::WorkspaceContentGitSyncDelegation {
          repo_path:fence.repo_path.as_str().into(),is_directory:true,destination_profile_id:fence.destination_profile_id,
          originating_operation_id:fence.originating_operation_id,scope_revision:fence.scope_revision,
        }]} else if disconnect && !undo {vec![myoxus_application::workspace_content_operation::WorkspaceContentGitSyncDelegation {
          repo_path:"content/extracted-folder/delegated".into(),is_directory:true,destination_profile_id:None,originating_operation_id:draft.id,scope_revision:1,
        }]} else {vec![]},
      };
      // Exercise the SQL publication boundary directly; public admission remains
      // blocked until receipt-owned Undo is available.
      sqlx::query("UPDATE workspace_content_extract_targets SET git_sync_plan = $2 WHERE operation_id = $1")
        .bind(draft.id).bind(serde_json::to_value(plan).unwrap()).execute(&pool).await.unwrap();
      Some(profile_id)
    } else { None };
    sqlx::query("INSERT INTO workspace_doc_view_daily (workspace_id, doc_id, date, total_views) VALUES ($1, $2::text, CURRENT_DATE, 3)")
      .bind(source_workspace_id).bind(document_id).execute(&pool).await.expect("source views before admission");
    let admission_manifest = repository
      .prepare_move_revision_manifest(&running, &mappings)
      .await
      .expect("capture Extract content manifest");
    sqlx::query("UPDATE workspace_doc_view_daily SET total_views = 7 WHERE workspace_id = $1 AND doc_id = $2::text")
      .bind(source_workspace_id).bind(document_id).execute(&pool).await.expect("views after admission are not content changes");
    sqlx::query("INSERT INTO workspace_doc_view_daily (workspace_id, doc_id, date, total_views) VALUES ($1, $2::text, CURRENT_DATE - 1, 2)")
      .bind(source_workspace_id).bind(document_id).execute(&pool).await.expect("another view bucket cannot make publication stale");
    if !ou_owned {
      sqlx::query("UPDATE workspace_memberships SET role = 'Reader' WHERE workspace_id = $1 AND user_id = $2")
        .bind(source_workspace_id)
        .bind(actor_id)
        .execute(&pool)
        .await
        .expect("change source membership after admission");
    }
    assert!(
      authorizer
        .preflight(actor_id, graph, options)
        .await
        .unwrap()
        .blockers
        .contains(&WorkspaceContentBlocker::PermissionDenied),
      "revocation must still deny a new extraction, not the admitted operation"
    );
    sqlx::query("UPDATE doc_user_permissions SET role = 'Reader' WHERE doc_id = $1 AND user_id = $2")
      .bind(document_id)
      .bind(actor_id)
      .execute(&pool)
      .await
      .expect("edit live document grant after admission");
    sqlx::query("UPDATE docs SET default_role = 'none', updated_at = now() WHERE id = $1")
      .bind(document_id)
      .execute(&pool)
      .await
      .expect("edit document default permission");
    let live_metadata_revision: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
      .bind(document_id)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert!(live_metadata_revision > admission_manifest.documents[0].metadata_revision);
    sqlx::query("INSERT INTO document_edit_capture_state(workspace_id,doc_id,dirty_revision,first_pending_at,configured_enabled,configured_interval_ms,lifecycle_active)
      VALUES($1,$2,1,now()-interval '1 hour',true,900000,true) ON CONFLICT(workspace_id,doc_id) DO UPDATE SET dirty_revision=1")
      .bind(source_workspace_id).bind(document_id).execute(&pool).await.unwrap();
    let published = transfer.execute(running.clone()).await.expect("publish Extract");
    assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT workspace_id FROM document_edit_capture_state WHERE doc_id=$1")
      .bind(document_id).fetch_one(&pool).await.unwrap(),target_workspace_id,"Extract reuses the same capture-intent transition");
    assert_eq!(sqlx::query_scalar::<_,Option<i64>>("SELECT last_captured_revision FROM document_edit_capture_state WHERE doc_id=$1")
      .bind(document_id).fetch_one(&pool).await.unwrap(),None,"Extract does not acknowledge an uncaptured revision");
    let tag_workspace: (Uuid, Uuid) = sqlx::query_as("SELECT a.workspace_id,t.workspace_id FROM workspace_tag_document_assignments a JOIN workspace_tags t ON t.id=a.tag_id WHERE a.doc_id=$1")
      .bind(document_id).fetch_one(&pool).await.unwrap();
    assert_eq!(tag_workspace, (target_workspace_id, target_workspace_id));
    assert!(
      sqlx::query_scalar::<_, i64>("SELECT metadata_revision FROM docs WHERE id = $1")
        .bind(document_id)
        .fetch_one(&pool)
        .await
        .unwrap()
        > live_metadata_revision,
      "publication must advance live metadata freshness, not restore the captured revision"
    );
    assert_eq!(
      sqlx::query_scalar::<_, String>("SELECT role FROM doc_user_permissions WHERE doc_id = $1 AND user_id = $2")
        .bind(document_id)
        .bind(actor_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
      "Reader"
    );
    assert_eq!(
      sqlx::query_scalar::<_, String>("SELECT default_role FROM docs WHERE id = $1")
        .bind(document_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
      "none"
    );
    if !ou_owned {
      assert_eq!(
        sqlx::query_scalar::<_, String>(
          "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2"
        )
        .bind(source_workspace_id)
        .bind(actor_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "Reader",
        "completion must not restore source authority"
      );
      assert_eq!(
        sqlx::query_scalar::<_, String>(
          "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2"
        )
        .bind(target_workspace_id)
        .bind(actor_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        if direct_manager { "Manager" } else { "Owner" },
        "the new workspace inherits the admission-time members"
      );
    }
    if let Some((organization_id, unit_id, _)) = organization_fixture {
      assert_eq!(
        permission
          .get_effective_workspace_role(actor_id, target_workspace_id)
          .await
          .unwrap(),
        None,
        "completion must not restore revoked OU-manager access"
      );
      helpers::make_manager_of(&pool, actor_id, unit_id).await;
      sqlx::query("UPDATE organization_policy SET manager_can_create_workspaces = true WHERE organization_id = $1")
        .bind(organization_id)
        .execute(&pool)
        .await
        .expect("restore fixture creation policy");
    }
    assert_eq!(
      repository
        .extract_target_owner(&running)
        .await
        .expect("published target is no longer hidden"),
      None
    );
    assert_eq!(published.status, WorkspaceContentOperationStatus::Succeeded);
    let target_overview = workspace_store.get_workspace(target_workspace_id).await.unwrap().unwrap();
    assert_eq!(target_overview.overview_settings.introduction,
      Some(resource(target_workspace_id, WorkspaceContentResourceKind::Document, &document_key)),
      "Extract promotes the mapped external key, never the internal database UUID");
    assert_eq!(target_overview.overview_settings.register_presentation, root_configuration.overview_settings.register_presentation,
      "the selected folder inherits its original workspace default before becoming a root");
    assert_eq!(target_overview.overview_settings.folder_ids, None);
    assert!(!target_overview.overview_settings.folders.contains_key(&folder_id), "retained workspace-root has no hidden settings scope");
    let mut source_expected = overview_before.overview_settings.clone();
    source_expected.folders.remove(&folder_id);
    assert_eq!(workspace_store.get_workspace(source_workspace_id).await.unwrap().unwrap().overview_settings, source_expected,
      "Extract removes only the selected folder binding from the source");

    let staged = repository.list_staging_entries(draft.id).await.unwrap();
    assert_eq!(staged.len(),2);
    assert_eq!(staged[0].content_hash(),staged[1].content_hash());
    assert_ne!(staged[0].object_key(),staged[1].object_key(),"equal-byte resources cannot share a manifest row");
    for entry in &staged {
      assert_eq!(storage.read_blob(&format!("{target_workspace_id}/{}",entry.resource.resource_id())).await.unwrap().data,blob_bytes);
    }
    assert_eq!(storage.read_blob(&format!("{source_workspace_id}/{equal_blob_key}")).await.unwrap().data,blob_bytes);

    assert_eq!(
      sqlx::query_scalar::<_, String>("SELECT lifecycle_state FROM workspaces WHERE id = $1")
        .bind(target_workspace_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
      "active"
    );
    let source_rows = organizer_service
      .snapshot(source_workspace_id)
      .await
      .expect("source organizer after Extract");
    let replacement = &source_rows.roots[0].row;
    assert_eq!(replacement.id, folder_id);
    assert_eq!(replacement.row_type, "workspace");
    assert_eq!(replacement.data, target_workspace_id.to_string());
    assert_eq!(replacement.index, "a0");
    assert_eq!(replacement.target_workspace_id, Some(target_workspace_id));
    let target_rows = organizer_service
      .snapshot(target_workspace_id)
      .await
      .expect("target organizer after Extract");
    assert_eq!(target_rows.roots[0].row.id, folder_id);
    assert_eq!(target_rows.roots[0].row.row_type, "workspace-root");
    assert_eq!(target_rows.roots[0].children.len(), 1);
    assert_eq!(target_rows.roots[0].children[0].row.data, document_key);
    assert_eq!(
      sqlx::query_scalar::<_, Uuid>("SELECT workspace_id FROM docs WHERE id = $1")
        .bind(document_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
      target_workspace_id
    );
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM blobs WHERE workspace_id = $1 AND key = $2")
        .bind(target_workspace_id)
        .bind(&target_blob_key)
        .fetch_one(&pool)
        .await
        .unwrap(),
      1
    );
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM blobs WHERE workspace_id = $1 AND key = $2")
        .bind(source_workspace_id)
        .bind(blob_key)
        .fetch_one(&pool)
        .await
        .unwrap(),
      1
    );
    assert_eq!(
      sqlx::query_scalar::<_, Uuid>("SELECT workspace_id FROM workspace_tags WHERE id = $1")
        .bind(tag_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
      source_workspace_id
    );
    assert_eq!(
      sqlx::query_scalar::<_, Uuid>(
        "SELECT workspace_id FROM workspace_tag_document_assignments WHERE doc_id = $1 AND tag_id = $2",
      )
      .bind(document_id)
      .bind(mappings.iter().find(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Tag).map(|mapping| Uuid::parse_str(mapping.target.resource_id()).unwrap()).expect("admitted target Tag"))
      .fetch_one(&pool)
      .await
      .unwrap(),
      target_workspace_id
    );
    assert_eq!(
      storage
        .read_blob(&format!("{target_workspace_id}/{target_blob_key}"))
        .await
        .expect("published Extract Blob")
        .data,
      blob_bytes
    );
    assert_eq!(
      sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM workspace_content_operation_redirects WHERE operation_id = $1",
      )
      .bind(draft.id)
      .fetch_one(&pool)
      .await
      .unwrap(),
      mappings.iter().filter(|mapping| !matches!(mapping.source.kind(), WorkspaceContentResourceKind::Tag|WorkspaceContentResourceKind::Blob)).count() as i64
    );

    let replayed_publication = WorkspaceContentExtractRecoveryService::new(
      repository.clone(),
      repository.clone(),
      storage.clone(),
      "extract-published-replay-test".to_string(),
    )
    .recover(
      draft.id,
      RedactedWorkspaceContentError::new(
        WorkspaceContentErrorCode::WorkerExecutionFailed,
        "workspace content execution failed",
      )
      .expect("valid replay failure"),
    )
    .await
    .expect("published Extract recovery replay");
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT sum(total_views)::bigint FROM workspace_doc_view_daily WHERE workspace_id=$1 AND doc_id=$2::text")
      .bind(source_workspace_id).bind(document_id).fetch_one(&pool).await.unwrap(), 9, "source observations stay in their original workspace");
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_doc_view_daily WHERE workspace_id=$1 AND doc_id=$2::text")
      .bind(target_workspace_id).bind(document_id).fetch_one(&pool).await.unwrap(), 0, "Extract starts a fresh destination view history");
    assert_eq!(
      replayed_publication.status,
      WorkspaceContentOperationStatus::Succeeded,
      "recovery replay must preserve a published Extract"
    );
    assert_eq!(
      storage
        .read_blob(&format!("{target_workspace_id}/{target_blob_key}"))
        .await
        .expect("published Extract Blob after recovery replay")
        .data,
      blob_bytes
    );

    if let Some(source_profile) = git_profile {
      let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
      if disconnect {
        use myoxus_application::workspace_content_operation::worker::WorkspaceContentGitMetadataExecutor;
        let source=store.get_profile(source_profile).await.unwrap();
        assert!(store.get_profile_by_workspace(target_workspace_id).await.unwrap().is_none());
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM git_sync_profiles WHERE workspace_id=$1")
          .bind(target_workspace_id).fetch_one(&pool).await.unwrap(),0,"Disconnect creates no disabled target profile either");
        assert!(sqlx::query_scalar::<_,bool>("SELECT tombstone FROM git_sync_bindings WHERE profile_id=$1 AND doc_id=$2")
          .bind(source_profile).bind(document_id).fetch_one(&pool).await.unwrap());
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM git_sync_baselines baseline JOIN git_sync_bindings binding ON binding.id=baseline.binding_id WHERE binding.profile_id=$1")
          .bind(source_profile).fetch_one(&pool).await.unwrap(),0);
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT resolution FROM git_sync_conflicts WHERE profile_id=$1 AND doc_id=$2")
          .bind(source_profile).bind(document_id).fetch_one(&pool).await.unwrap(),"Dismissed");
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT resolution FROM git_sync_file_conflicts WHERE profile_id=$1 AND blob_key=$2")
          .bind(source_profile).bind(blob_key).fetch_one(&pool).await.unwrap(),"Dismissed");
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT resolution FROM git_sync_file_conflicts WHERE profile_id=$1 AND blob_key=$2")
          .bind(source_profile).bind(equal_blob_key).fetch_one(&pool).await.unwrap(),"Open","shared conflict remains independently actionable");
        assert!(sqlx::query_scalar::<_,bool>("SELECT discarded_at IS NOT NULL FROM git_sync_history_capture_receipts WHERE profile_id=$1")
          .bind(source_profile).fetch_one(&pool).await.unwrap());
        assert!(sqlx::query_scalar::<_,bool>("SELECT tombstoned FROM git_sync_file_bindings WHERE profile_id=$1 AND blob_key=$2")
          .bind(source_profile).bind(blob_key).fetch_one(&pool).await.unwrap());
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM git_sync_file_baselines WHERE profile_id=$1 AND blob_key=$2")
          .bind(source_profile).bind(blob_key).fetch_one(&pool).await.unwrap(),0);
        assert!(store.writer_scope(&source).await.unwrap().excludes("content/extracted-folder/doc.md").unwrap());
        let metadata=myoxus_api::git_sync_engine::extract_metadata::ExtractGitMetadata::new(
          api_state.clone(),repository.clone(),myoxus_api::git_sync_engine::locking::new_locks());
        assert!(!repository.has_reconcilable_git_work(draft.id).await.unwrap());
        assert!(matches!(metadata.execute(draft.id).await,Err(AuthError::Storage(code))
          if code==WorkspaceContentErrorCode::GitSyncOutboundCleanupPending.as_str()));
        let remote=git2::Repository::open_bare(git_directory.path().join("remote.git")).unwrap();
        let untouched=remote.head().unwrap().target().unwrap();
        let captured=repository.pending_extract_git_work(draft.id).await.unwrap().unwrap();
        assert_eq!(Some(untouched.to_string()),captured.plan.remote_oid,"SQL publication and read-only cleanup make no Git write");
        // Explicit repair is permitted, but cannot itself grant cleanup before
        // an outbound source run has actually committed its valid manifest.
        sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2")
          .bind(source_workspace_id).bind(actor_id).execute(&pool).await.unwrap();
        sqlx::query("UPDATE git_sync_profiles SET sync_direction='MyoxusToGit',updated_at=now() WHERE id=$1")
          .bind(source_profile).execute(&pool).await.unwrap();
        assert!(!repository.disconnect_outbound_admitted(draft.id).await.unwrap());
        let profile=store.get_profile(source_profile).await.unwrap();
        let (run,_)=store.create_pending_run_if_absent(source_profile,profile.sync_direction,myoxus_domain::git_sync::GitSyncRunSource::Manual).await.unwrap();
        store.persist_dispatch_job_id(run.id,&format!("disconnect-fixture:{}",run.id)).await.unwrap();
        // This fixture exercises cleanup admission/readback with real Git.
        // The existing detached-child runner fixture owns outbound execution;
        // represent its completed, fenced manifest here without a new harness.
        let local=git2::Repository::clone(remote.path().to_str().unwrap(),git_directory.path().join("outbound")).unwrap();
        let mut manifest:GitSyncManifest=serde_json::from_value(captured.plan.manifest_inventory.clone().unwrap()).unwrap();
        manifest.documents.clear();manifest.folders.clear();
        std::fs::write(local.workdir().unwrap().join(&profile.manifest_path),manifest.to_json().unwrap()).unwrap();
        if !undo {
          std::fs::write(local.workdir().unwrap().join("content/extracted-folder/edited/README.md"),b"externally edited generated file").unwrap();
          std::fs::write(local.workdir().unwrap().join("content/extracted-folder/new-authored.md"),b"independent authored file").unwrap();
        }
        let mut index=local.index().unwrap();index.add_all(["*"],git2::IndexAddOption::DEFAULT,None).unwrap();index.write().unwrap();
        let tree=local.find_tree(index.write_tree().unwrap()).unwrap();
        let parent=local.head().unwrap().peel_to_commit().unwrap();
        let signature=git2::Signature::now("Source fixture","fixture@myoxus.test").unwrap();
        let outbound=local.commit(Some("HEAD"),&signature,&signature,"fenced outbound inventory",&tree,&[&parent]).unwrap();
        local.find_remote("origin").unwrap().push(&["refs/heads/main:refs/heads/main"],None).unwrap();
        sqlx::query("UPDATE git_sync_runs SET status='Completed',finished_at=now(),commit_after=$2,observed_remote_oid=$2 WHERE id=$1")
          .bind(run.id).bind(outbound.to_string()).execute(&pool).await.unwrap();
        assert!(repository.has_reconcilable_git_work(draft.id).await.unwrap());
        let tree=remote.head().unwrap().peel_to_commit().unwrap().tree().unwrap();
        let read=|path:&str|tree.get_path(std::path::Path::new(path)).unwrap().to_object(&remote).unwrap().as_blob().unwrap().content().to_vec();
        let document_before=read("content/extracted-folder/doc.md");
        assert!(tree.get_path(std::path::Path::new("content/extracted-folder/README.md")).is_ok());
        metadata.execute(draft.id).await.expect("cleanup only unchanged generated detached output");
        let cleaned=remote.head().unwrap().target().unwrap();
        let tree=remote.head().unwrap().peel_to_commit().unwrap().tree().unwrap();
        assert!(tree.get_path(std::path::Path::new("content/extracted-folder/README.md")).is_err());
        let read=|path:&str|tree.get_path(std::path::Path::new(path)).unwrap().to_object(&remote).unwrap().as_blob().unwrap().content().to_vec();
        assert_eq!(read("content/extracted-folder/doc.md"),document_before,"authored frontmatter/body remain detached and unchanged");
        assert_eq!(read("content/extracted-folder/attachment.bin"),blob_bytes);
        assert_eq!(read("content/shared.bin"),blob_bytes);
        if !undo {
        assert_eq!(read("content/extracted-folder/edited/README.md"),b"externally edited generated file");
        assert_eq!(read("content/extracted-folder/delegated/README.md"),b"generated child");
        assert_eq!(read("content/extracted-folder/new-authored.md"),b"independent authored file");
        }
        assert!(!repository.git_work_status(draft.id).await.unwrap().unwrap().pending);
        metadata.execute(draft.id).await.unwrap();
        assert_eq!(remote.head().unwrap().target(),Some(cleaned));
        if !undo {
        // Recover a lost SQL acknowledgement after an external author has
        // reintroduced the deleted path. An applied deletion is never replayed.
        local.find_remote("origin").unwrap().fetch(&["main"],None,None).unwrap();
        let applied=local.find_object(cleaned,None).unwrap();
        local.reset(&applied,git2::ResetType::Hard,None).unwrap();
        std::fs::write(local.workdir().unwrap().join("content/extracted-folder/README.md"),b"new authored README").unwrap();
        let mut index=local.index().unwrap();index.add_all(["*"],git2::IndexAddOption::DEFAULT,None).unwrap();index.write().unwrap();
        let tree=local.find_tree(index.write_tree().unwrap()).unwrap();
        let parent=local.head().unwrap().peel_to_commit().unwrap();
        let reintroduced=local.commit(Some("HEAD"),&signature,&signature,"reintroduced authored README",&tree,&[&parent]).unwrap();
        local.find_remote("origin").unwrap().push(&["refs/heads/main:refs/heads/main"],None).unwrap();
        sqlx::query("UPDATE workspace_content_extract_targets SET git_sync_pending=true WHERE operation_id=$1")
          .bind(draft.id).execute(&pool).await.unwrap();
        metadata.execute(draft.id).await.expect("ancestor readback preserves reintroduced detached paths");
        assert_eq!(remote.head().unwrap().target(),Some(reintroduced));
        assert!(!repository.git_work_status(draft.id).await.unwrap().unwrap().pending);
        }
        assert_eq!(store.get_profile(source_profile).await.unwrap().sync_direction,myoxus_domain::git_sync::SyncDirection::MyoxusToGit);
        if followup {
          assert_extract_followup_syncs(&pool,&api_state,storage.as_ref(),&doc_service,actor_id,
            source_workspace_id,target_workspace_id,source_profile,None,document_id,&remote,git_directory.path()).await;
        }
      } else {
      let target_id: Uuid = sqlx::query_scalar("SELECT id FROM git_sync_profiles WHERE workspace_id=$1")
        .bind(target_workspace_id).fetch_one(&pool).await.unwrap();
      let target = store.get_profile(target_id).await.unwrap();
      assert!(!target.enabled, "target sync waits, independently of content usability");
      assert_eq!(target.sync_direction, myoxus_domain::git_sync::SyncDirection::GitToMyoxus);
      assert_eq!(target.root_path, "content/extracted-folder");
      let binding: (Uuid,Uuid) = sqlx::query_as("SELECT profile_id,workspace_id FROM git_sync_bindings WHERE doc_id=$1")
        .bind(document_id).fetch_one(&pool).await.unwrap();
      assert_eq!(binding, (target.id,target_workspace_id));
      let file: (Uuid,Uuid,String) = sqlx::query_as("SELECT profile_id,workspace_id,blob_key FROM git_sync_file_bindings WHERE profile_id=$1 AND repo_path='content/extracted-folder/attachment.bin'")
        .bind(target.id).fetch_one(&pool).await.unwrap();
      assert_eq!(file, (target.id,target_workspace_id,target_blob_key.clone()), "file bindings use the actual copied Blob identity");
      assert!(sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM git_sync_file_baselines WHERE profile_id=$1 AND blob_key=$2)")
        .bind(target.id).bind(&target_blob_key).fetch_one(&pool).await.unwrap());
      let source = store.get_profile(source_profile).await.unwrap();
      assert!(source.enabled);
      assert!(store.assert_profile_scope_unambiguous(&source).await.is_ok(), "parent sync remains runnable");
      assert!(store.assert_profile_scope_unambiguous(&target).await.is_err(), "direct CLI writers must honor pending target metadata");
      assert!(store.writer_scope(&source).await.unwrap().excludes("content/extracted-folder/doc.md").unwrap());
      assert!(repository.git_work_status(draft.id).await.unwrap().unwrap().pending);
      if followup {
        let cutoff=store.history_retention_cutoff(7).await.unwrap();
        assert_eq!(store.cleanup_auxiliary_history(source_profile,cutoff,1_000).await.unwrap().protected_profiles,1,
          "Succeeded SQL publication still owns pending Git recovery");
        assert_eq!(store.cleanup_terminal_runs(target.id,cutoff,1_000).await.unwrap().protected_profiles,1);
        assert!(repository.git_work_status(draft.id).await.unwrap().unwrap().pending);
      }
      assert!(repository.list_reconcilable_operation_ids(1_000).await.unwrap().contains(&draft.id));
      assert!(store.delete_profile(source_profile).await.is_err(), "pending handoff cannot lose its source");
      let metadata=Arc::new(myoxus_api::git_sync_engine::extract_metadata::ExtractGitMetadata::new(
        api_state.clone(),repository.clone(),myoxus_api::git_sync_engine::locking::new_locks()));
      let worker = myoxus_application::workspace_content_operation::worker::WorkspaceContentWorkerService::new(repository.clone(),Uuid::new_v4())
        .with_git_metadata_executor(metadata.clone());
      use myoxus_application::workspace_content_operation::worker::WorkspaceContentWorkerPort;
      let offline=git_directory.path().join("offline.git");
      std::fs::rename(git_directory.path().join("remote.git"),&offline).unwrap();
      assert!(matches!(worker.execute(myoxus_application::workspace_content_operation::worker::WorkspaceContentWorkerEnvelope { operation_id: draft.id }).await,
        Err(AuthError::Storage(code)) if code==WorkspaceContentErrorCode::GitSyncRemoteUnavailable.as_str()));
      worker.finalize_retry_exhaustion(draft.id).await.unwrap();
      assert!(repository.git_work_status(draft.id).await.unwrap().unwrap().retry_exhausted);
      assert!(!repository.list_reconcilable_operation_ids(1_000).await.unwrap().contains(&draft.id));
      std::fs::rename(&offline,git_directory.path().join("remote.git")).unwrap();
      repository.retry_git_work(draft.id, actor_id).await.unwrap();
      assert!(repository.has_reconcilable_git_work(draft.id).await.unwrap());
      assert_eq!(repository.get(draft.id).await.unwrap().unwrap().status, WorkspaceContentOperationStatus::Succeeded);
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspace_content_extract_targets WHERE operation_id=$1")
        .bind(draft.id).fetch_one(&pool).await.unwrap(),1);
      sqlx::query("UPDATE docs SET title='Edited after publication',updated_at=now() WHERE id=$1")
        .bind(document_id).execute(&pool).await.unwrap();
      use myoxus_application::workspace_content_operation::worker::WorkspaceContentGitMetadataExecutor;
      metadata.execute(draft.id).await.expect("complete only the accepted Git metadata");
      metadata.execute(draft.id).await.expect("completed metadata delivery is read-only");
      assert!(!repository.git_work_status(draft.id).await.unwrap().unwrap().pending);
      assert!(store.get_profile(target.id).await.unwrap().enabled);
      let remote=git2::Repository::open_bare(git_directory.path().join("remote.git")).unwrap();
      if followup {
        assert_extract_followup_syncs(&pool,&api_state,storage.as_ref(),&doc_service,actor_id,
          source_workspace_id,target_workspace_id,source_profile,Some(target.id),document_id,&remote,git_directory.path()).await;
      }
      let tree=remote.head().unwrap().peel_to_commit().unwrap().tree().unwrap();
      let read=|path:&str| {let object=tree.get_path(std::path::Path::new(path)).unwrap().to_object(&remote).unwrap();
        object.as_blob().unwrap().content().to_vec()};
      let target_manifest:GitSyncManifest=serde_json::from_slice(&read(&target.manifest_path)).unwrap();
      let source_manifest:GitSyncManifest=serde_json::from_slice(&read(&source.manifest_path)).unwrap();
      assert_eq!(target_manifest.workspace_id,target_workspace_id);
      assert_eq!(target_manifest.documents[0].doc_id,document_id);
      assert!(source_manifest.documents.is_empty());
      let source_readme=String::from_utf8(read("content/README.md")).unwrap();
      assert!(source_readme.contains("- [Introduction reference](extracted-folder/README.md)"));
      assert!(!source_readme.contains("- [Extracted Folder](extracted-folder/README.md)"));
      let text=String::from_utf8(read("content/extracted-folder/doc.md")).unwrap();
      let (header,body)=myoxus_application::git_sync::export::split_markdown_file(&text);
      assert_eq!(myoxus_application::git_sync::export::ExportFrontmatter::from_yaml(&header.unwrap()).unwrap().workspace_id,target_workspace_id);
      let shared_path=myoxus_application::git_sync::export::asset_repo_path("content/extracted-folder",&shared_target_key,"application/octet-stream").unwrap().as_str().to_owned();
      let shared_relative=shared_path.strip_prefix("content/extracted-folder/").unwrap();
      assert_eq!(body,format!("Accepted Git body; later target edits must not be exported here.\n\n![Shared]({shared_relative})\n\n![SharedRef][asset]\n\n[asset]: {shared_relative} \"kept title\"\n\n`[literal](../shared.bin)`\n"));
      assert_eq!(read(&shared_path),blob_bytes);
      assert_eq!(read("content/shared.bin"),blob_bytes,"source shared bytes survive");
      assert_eq!(sqlx::query_scalar::<_,String>("SELECT title FROM docs WHERE id=$1").bind(document_id).fetch_one(&pool).await.unwrap(),"Edited after publication");
      assert!(store.assert_profile_scope_unambiguous(&target).await.is_ok());
      // Recreate lost SQL acknowledgement after the remote already applied the
      // prepared commit, then advance that branch independently. Recovery must
      // recognize the ancestor rather than replaying a stale tree or content.
      if !undo && !followup {
      sqlx::query("UPDATE git_sync_profiles SET enabled=false WHERE id=$1").bind(target.id).execute(&pool).await.unwrap();
      sqlx::query("UPDATE workspace_content_extract_targets SET git_sync_pending=true WHERE operation_id=$1")
        .bind(draft.id).execute(&pool).await.unwrap();
      let sibling=git2::Repository::clone(remote.path().to_str().unwrap(),git_directory.path().join("sibling")).unwrap();
      std::fs::write(sibling.workdir().unwrap().join("retained-sibling.txt"),b"independent branch work").unwrap();
      let retained_id=Uuid::new_v4();
      let mut evolved=source_manifest.clone();
      evolved.documents.push(GitSyncManifestDocument {doc_id:retained_id,organizer_entry_id:None,organizer_folder_ids:vec![],
        repo_path:"content/retained.md".into(),title:"New retained sibling".into(),content_hash:format!("{:x}",Sha256::digest(b"new sibling body"))});
      std::fs::write(sibling.workdir().unwrap().join(&source.manifest_path),evolved.to_json().unwrap()).unwrap();
      std::fs::write(sibling.workdir().unwrap().join("content/retained.md"),b"new sibling body").unwrap();
      let mut index=sibling.index().unwrap();index.add_all(["*"],git2::IndexAddOption::DEFAULT,None).unwrap();index.write().unwrap();
      let tree=sibling.find_tree(index.write_tree().unwrap()).unwrap();
      let parent=sibling.head().unwrap().peel_to_commit().unwrap();
      let signature=git2::Signature::now("Sibling fixture","fixture@myoxus.test").unwrap();
      let advanced=sibling.commit(Some("HEAD"),&signature,&signature,"independent sibling",&tree,&[&parent]).unwrap();
      sibling.find_remote("origin").unwrap().push(&["refs/heads/main:refs/heads/main"],None).unwrap();
      metadata.execute(draft.id).await.expect("read back the applied ancestor after lost acknowledgement");
      assert_eq!(remote.head().unwrap().target(),Some(advanced),"Retry cannot create another metadata commit");
      assert!(!repository.git_work_status(draft.id).await.unwrap().unwrap().pending);
      let current_tree=remote.head().unwrap().peel_to_commit().unwrap().tree().unwrap();
      let current_manifest=current_tree.get_path(std::path::Path::new(&source.manifest_path)).unwrap().to_object(&remote).unwrap();
      let retained:GitSyncManifest=serde_json::from_slice(current_manifest.as_blob().unwrap().content()).unwrap();
      assert_eq!(retained.documents[0].doc_id,retained_id,"source manifest updates survive receipt recovery");
      sqlx::query("UPDATE git_sync_profiles SET enabled=false WHERE id=$1").bind(target.id).execute(&pool).await.unwrap();
      sqlx::query("UPDATE workspace_content_extract_targets SET git_sync_pending=true WHERE operation_id=$1")
        .bind(draft.id).execute(&pool).await.unwrap();
      let owned=sibling.workdir().unwrap().join("content/extracted-folder/doc.md");
      let divergent=std::fs::read_to_string(&owned).unwrap().replace("Accepted Git body;","External divergence;");
      std::fs::write(&owned,&divergent).unwrap();
      let mut index=sibling.index().unwrap();index.add_path(std::path::Path::new("content/extracted-folder/doc.md")).unwrap();index.write().unwrap();
      let tree=sibling.find_tree(index.write_tree().unwrap()).unwrap();
      let parent=sibling.head().unwrap().peel_to_commit().unwrap();
      let changed=sibling.commit(Some("HEAD"),&signature,&signature,"external owned-byte edit",&tree,&[&parent]).unwrap();
      sibling.find_remote("origin").unwrap().push(&["refs/heads/main:refs/heads/main"],None).unwrap();
      assert!(matches!(worker.execute(myoxus_application::workspace_content_operation::worker::WorkspaceContentWorkerEnvelope {operation_id:draft.id}).await,
        Err(AuthError::InvalidInput(code)) if code==WorkspaceContentErrorCode::GitSyncMetadataConflict.as_str()));
      assert_eq!(remote.head().unwrap().target(),Some(changed));
      let pending=repository.git_work_status(draft.id).await.unwrap().unwrap();
      assert!(pending.pending && pending.retry_exhausted);
      assert_eq!(pending.error_code,Some(WorkspaceContentErrorCode::GitSyncMetadataConflict));
      assert_eq!(repository.get(draft.id).await.unwrap().unwrap().status,WorkspaceContentOperationStatus::Succeeded);
      }
      }
    }

    if undo {
      let source_profile=git_profile.unwrap();
      let store=myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
      sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2")
        .bind(source_workspace_id).bind(actor_id).execute(&pool).await.unwrap();
      sqlx::query("UPDATE docs SET title='Current edit survives Undo',updated_at=now() WHERE id=$1")
        .bind(document_id).execute(&pool).await.unwrap();
      sqlx::query("UPDATE git_sync_profiles SET polling_interval_secs=987,updated_at=now() WHERE id=$1")
        .bind(source_profile).execute(&pool).await.unwrap();
      let credential_before=store.get_profile(source_profile).await.unwrap().credential_id;
      let reverse=mappings.iter().map(|mapping|WorkspaceContentIdMapping::new(mapping.target.clone(),mapping.source.clone()).unwrap()).collect::<Vec<_>>();
      let request=WorkspaceContentOperationRequest {kind:WorkspaceContentOperationKind::Move,
        source_workspace_id:target_workspace_id,target_workspace_id:source_workspace_id,
        selection:WorkspaceContentOperationSelection::Resources {resources:reverse.iter().filter(|mapping|!matches!(mapping.source.kind(),WorkspaceContentResourceKind::Blob|WorkspaceContentResourceKind::Tag)).map(|mapping|mapping.source.clone()).collect()},
        copy_document_acl:false,extract_workspace_name:None,git_sync_choice:None,link_entry_id:None,link_parent_id:None,link_index:None};
      let graph_source=PgWorkspaceContentGraphSource::new(pool.clone(),doc_service.clone())
        .with_git_capture(Arc::new(myoxus_api::git_sync_engine::extract_capture::ExtractGitCapture::new(api_state.clone())));
      let independent=Uuid::new_v4().to_string();
      organizer_service.create_folder(target_workspace_id,CreateOrganizerFolder {id:independent.clone(),parent_id:Some(folder_id.clone()),name:"Independent target content".into(),index:None}).await.unwrap();
      assert!(matches!(graph_source.prepare_with_origin(actor_id,Uuid::new_v4(),&request,vec![],Some(draft.id)).await,
        Err(AuthError::InvalidInput(code)) if code==WorkspaceContentErrorCode::GitSyncUndoTargetNotEmpty.as_str()));
      organizer_service.delete_folder(target_workspace_id,&independent).await.unwrap();
      let root=store.get_profile(source_profile).await.unwrap().root_path;
      sqlx::query("UPDATE git_sync_profiles SET root_path='changed-root/' WHERE id=$1").bind(source_profile).execute(&pool).await.unwrap();
      assert!(matches!(graph_source.prepare_with_origin(actor_id,Uuid::new_v4(),&request,vec![],Some(draft.id)).await,
        Err(AuthError::InvalidInput(code)) if code==WorkspaceContentErrorCode::GitSyncUndoOwnershipChanged.as_str()));
      sqlx::query("UPDATE git_sync_profiles SET root_path=$2 WHERE id=$1").bind(source_profile).bind(root).execute(&pool).await.unwrap();
      if !disconnect {
        let child=myoxus_application::workspace_content_operation::extract_git_profile_id(draft.id);
        let conflict:Uuid=sqlx::query_scalar("INSERT INTO git_sync_conflicts (profile_id,doc_id,repo_path,conflict_type,myoxus_content) VALUES ($1,$2,'content/extracted-folder/doc.md','BothModified','unresolved local input') RETURNING id")
          .bind(child).bind(document_id).fetch_one(&pool).await.unwrap();
        assert!(matches!(graph_source.prepare_with_origin(actor_id,Uuid::new_v4(),&request,vec![],Some(draft.id)).await,
          Err(AuthError::InvalidInput(code)) if code==WorkspaceContentErrorCode::GitSyncUndoPending.as_str()),"Undo must not cascade-delete an open conflict while removing the child profile");
        sqlx::query("DELETE FROM git_sync_conflicts WHERE id=$1").bind(conflict).execute(&pool).await.unwrap();
        sqlx::query("UPDATE git_sync_profiles SET polling_interval_secs=321 WHERE id=$1").bind(child).execute(&pool).await.unwrap();
        assert!(matches!(graph_source.prepare_with_origin(actor_id,Uuid::new_v4(),&request,vec![],Some(draft.id)).await,
          Err(AuthError::InvalidInput(code)) if code==WorkspaceContentErrorCode::GitSyncUndoOwnershipChanged.as_str()),"Undo cannot discard independently changed target configuration");
        sqlx::query("UPDATE git_sync_profiles SET polling_interval_secs=NULL WHERE id=$1").bind(child).execute(&pool).await.unwrap();
        let local=git2::Repository::clone(git_directory.path().join("remote.git").to_str().unwrap(),git_directory.path().join("undo-divergence")).unwrap();
        let path=std::path::Path::new("content/extracted-folder/doc.md");
        let original=std::fs::read(local.workdir().unwrap().join(path)).unwrap();
        let signature=git2::Signature::now("Undo fixture","fixture@myoxus.test").unwrap();
        for (body,changed) in [(b"external changed body".to_vec(),true),(original,false)] {
          std::fs::write(local.workdir().unwrap().join(path),body).unwrap();
          let mut index=local.index().unwrap();index.add_path(path).unwrap();index.write().unwrap();
          let tree=local.find_tree(index.write_tree().unwrap()).unwrap();let parent=local.head().unwrap().peel_to_commit().unwrap();
          local.commit(Some("HEAD"),&signature,&signature,"owned-byte observation",&tree,&[&parent]).unwrap();
          local.find_remote("origin").unwrap().push(&["refs/heads/main:refs/heads/main"],None).unwrap();
          if changed {assert!(matches!(graph_source.prepare_with_origin(actor_id,Uuid::new_v4(),&request,vec![],Some(draft.id)).await,
            Err(AuthError::InvalidInput(code)) if code==WorkspaceContentErrorCode::GitSyncUndoContentChanged.as_str()));}
        }
      }
      let counter=prepared_move_batch(&pool,&repository,actor_id,target_workspace_id,source_workspace_id,reverse,Some(draft.id)).await;
      fixture_operations.push(counter.operation.id);
      let captured=graph_source.prepare_with_origin(actor_id,counter.operation.id,&request,vec![],Some(draft.id)).await.expect("receipt-owned inverse preflight");
      repository.store_git_undo_plan(counter.operation.id,captured.authorization_options.git_sync_plan.as_ref()).await.unwrap();
      let published=transfer.execute(counter.operation.clone()).await.expect("SQL-first Git Undo on the existing Move publisher");
      assert_eq!(published.status,WorkspaceContentOperationStatus::Succeeded);
      assert!(repository.git_work_status(counter.operation.id).await.unwrap().unwrap().pending);
      assert!(repository.git_work_status(draft.id).await.unwrap().is_none(),"the original Extract cannot offer Retry for the counter-Move's pending metadata");
      assert!(repository.has_reconcilable_git_work(counter.operation.id).await.unwrap());
      assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT workspace_id FROM docs WHERE id=$1").bind(document_id).fetch_one(&pool).await.unwrap(),source_workspace_id);
      let metadata=Arc::new(myoxus_api::git_sync_engine::extract_metadata::ExtractGitMetadata::new(api_state.clone(),repository.clone(),myoxus_api::git_sync_engine::locking::new_locks()));
      use myoxus_application::workspace_content_operation::worker::{WorkspaceContentGitMetadataExecutor,WorkspaceContentWorkerPort};
      let worker=myoxus_application::workspace_content_operation::worker::WorkspaceContentWorkerService::new(repository.clone(),Uuid::new_v4()).with_git_metadata_executor(metadata.clone());
      worker.execute(myoxus_application::workspace_content_operation::worker::WorkspaceContentWorkerEnvelope {operation_id:counter.operation.id}).await
        .expect("a succeeded counter-Move still dispatches its pending inverse Git metadata");
      metadata.execute(counter.operation.id).await.unwrap();
      assert!(!repository.git_work_status(counter.operation.id).await.unwrap().unwrap().pending);
      let source=store.get_profile(source_profile).await.unwrap();
      assert_eq!(source.credential_id,credential_before);
      assert_eq!(source.polling_interval_secs,Some(987));
      assert!(!store.writer_scope(&source).await.unwrap().excludes("content/extracted-folder/doc.md").unwrap());
      assert_eq!(sqlx::query_scalar::<_,String>("SELECT title FROM docs WHERE id=$1").bind(document_id).fetch_one(&pool).await.unwrap(),"Current edit survives Undo");
      let remote=git2::Repository::open_bare(git_directory.path().join("remote.git")).unwrap();
      let tree=remote.head().unwrap().peel_to_commit().unwrap().tree().unwrap();
      assert!(tree.get_path(std::path::Path::new("content/extracted-folder/.myoxus/git-sync-manifest.json")).is_err());
      let read=|path:&str|tree.get_path(std::path::Path::new(path)).unwrap().to_object(&remote).unwrap().as_blob().unwrap().content().to_vec();
      let restored:GitSyncManifest=serde_json::from_slice(&read(&source.manifest_path)).unwrap();
      assert!(restored.documents.iter().any(|document|document.doc_id==document_id));
      if disconnect {
        assert!(sqlx::query_scalar::<_,bool>("SELECT baseline.myoxus_updated_at<document.updated_at FROM git_sync_baselines baseline
          JOIN git_sync_bindings binding ON binding.id=baseline.binding_id JOIN docs document ON document.id=binding.doc_id
          WHERE binding.profile_id=$1 AND binding.doc_id=$2")
          .bind(source_profile).bind(document_id).fetch_one(&pool).await.unwrap(),"restored baseline must not acknowledge the current local edit");
      }
      let bytes=read("content/extracted-folder/doc.md");
      let text=std::str::from_utf8(&bytes).unwrap();
      let (header,body)=myoxus_application::git_sync::export::split_markdown_file(text);
      assert_eq!(myoxus_application::git_sync::export::ExportFrontmatter::from_yaml(&header.unwrap()).unwrap().workspace_id,source_workspace_id);
      assert!(body.contains("![Shared](../shared.bin)"));
      if let Some((child,fence))=&git_descendant {
        assert!(store.get_profile(*child).await.is_ok());
        assert!(store.scope_exclusions(source_profile).await.unwrap().iter().any(|remaining|remaining.id==fence.id));
        assert_eq!(read("content/extracted-folder/delegated/note.md"),b"independently delegated content");
        assert_eq!(read("content/extracted-folder/delegated/.myoxus/git-sync-manifest.json"),b"independently delegated manifest");
      }
    }

    if !ou_owned && !direct_manager && !git_enabled {
      // The preceding checks proved one-time Extract admission after revocation.
      // Return current destination authority before admitting a normal Undo Move.
      sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2")
        .bind(source_workspace_id).bind(actor_id).execute(&pool).await.unwrap();
      let independent_doc = doc_service.create_page_lifecycle(source_workspace_id, actor_id, Some("Independent source work".into()), None)
        .await.unwrap().document;
      let independent_folder = Uuid::new_v4().to_string();
      organizer_service.create_folder(source_workspace_id, CreateOrganizerFolder {
        id: independent_folder.clone(), parent_id: None, name: "Independent source folder".into(), index: None,
      }).await.unwrap();
      configure_overview(&pool, source_workspace_id, WorkspaceOverviewSettingsPatch {
        introduction: Some(Some(resource(source_workspace_id, WorkspaceContentResourceKind::Document, &independent_doc.external_id))),
        register_presentation: Some(Some(overview_columns("version"))), ..Default::default()
      }).await;
      let source_before_undo = configure_overview(&pool, source_workspace_id, WorkspaceOverviewSettingsPatch {
        scope: OverviewSettingsScope::Folder(independent_folder.clone()),
        introduction: Some(Some(resource(source_workspace_id, WorkspaceContentResourceKind::Document, &independent_doc.external_id))),
        ..Default::default()
      }).await;
      configure_overview(&pool, target_workspace_id, WorkspaceOverviewSettingsPatch {
        folder_ids: Some(Some(vec![])), ..Default::default()
      }).await;
      let added_child = Uuid::new_v4().to_string();
      organizer_service.create_folder(target_workspace_id, CreateOrganizerFolder {
        id: added_child.clone(), parent_id: Some(folder_id.clone()), name: "Added after Extract".into(), index: None,
      }).await.unwrap();
      let target_before_undo = configure_overview(&pool, target_workspace_id, WorkspaceOverviewSettingsPatch {
        scope: OverviewSettingsScope::Folder(added_child.clone()),
        register_presentation: Some(Some(overview_columns("classification"))), ..Default::default()
      }).await;
      let mut inverse = mappings.iter().map(|mapping| WorkspaceContentIdMapping::new(mapping.target.clone(), mapping.source.clone()).unwrap()).collect::<Vec<_>>();
      inverse.push(WorkspaceContentIdMapping::new(
        resource(target_workspace_id, WorkspaceContentResourceKind::Folder, &added_child),
        resource(source_workspace_id, WorkspaceContentResourceKind::Folder, &added_child),
      ).unwrap());
      let counter = prepared_move_batch(&pool, &repository, actor_id, target_workspace_id, source_workspace_id, inverse, Some(draft.id)).await;
      fixture_operations.push(counter.operation.id);
      transfer.execute(counter.operation).await.expect("native receipt-bound Extract Undo with current descendant identities");
      let restored = workspace_store.get_workspace(source_workspace_id).await.unwrap().unwrap();
      let remaining = workspace_store.get_workspace(target_workspace_id).await.unwrap().unwrap();
      assert_eq!(restored.overview_settings.folders.get(&folder_id), overview_before.overview_settings.folders.get(&folder_id),
        "Undo restores the exact folder override/None state, not the promoted effective default");
      assert_eq!(restored.overview_settings.register_presentation, source_before_undo.overview_settings.register_presentation);
      assert_eq!(restored.overview_settings.introduction, source_before_undo.overview_settings.introduction);
      assert_eq!(restored.overview_settings.folders.get(&independent_folder), source_before_undo.overview_settings.folders.get(&independent_folder));
      assert_eq!(restored.overview_settings.folders.get(&added_child), target_before_undo.overview_settings.folders.get(&added_child),
        "settings of newly added descendant identities follow the existing counter-Move");
      assert_eq!(remaining.overview_settings.introduction, None);
      assert_eq!(remaining.overview_settings.register_presentation, None);
      assert_eq!(remaining.overview_settings.folder_ids, Some(vec![]), "independent target root preferences survive Undo");
      assert!(remaining.overview_settings.folders.is_empty());
      assert!(restored.overview_revision > source_before_undo.overview_revision);
      assert!(remaining.overview_revision > target_before_undo.overview_revision);
      let restored_tree = organizer_service.snapshot(source_workspace_id).await.unwrap();
      assert!(restored_tree.roots.iter().any(|node| node.row.id == folder_id && node.row.is_folder()),
        "the original folder identity returns without another root wrapper");
    }

    if ou_owned {
      assert_eq!(
        permission
          .get_effective_workspace_role(actor_id, target_workspace_id)
          .await
          .expect("published OU access"),
        Some(WorkspaceRole::Admin)
      );
      assert!(
        organization_permissions
          .manageable_workspace_ids(actor_id)
          .await
          .expect("published manager discovery")
          .contains(&target_workspace_id)
      );
      sqlx::query("DELETE FROM workspace_content_operations WHERE id = $1")
        .bind(draft.id)
        .execute(&pool)
        .await
        .expect("clean OU Extract operation");
    } else {
      for cancelled in [false, true] {
        let recovery_target_id = Uuid::new_v4();
        fixture_workspaces.push(recovery_target_id);
        let mut recovery_draft = operation(
          Uuid::new_v4(),
          Uuid::new_v4(),
          actor_id,
          source_workspace_id,
          recovery_target_id,
          &"e".repeat(64),
        );
        recovery_draft.kind = WorkspaceContentOperationKind::ExtractFolder;
        fixture_operations.push(recovery_draft.id);
        sqlx::query(
          "INSERT INTO workspaces (
         id, owner_user_id, owner_principal_type, owner_principal_id,
         created_by_user_id, name, name_normalized, lifecycle_state,
         lifecycle_owner_kind, lifecycle_owner_id
       )
       VALUES ($1, $2, 'user', $2, $2, 'Recovery Extract',
               'recovery extract', 'extracting', 'workspace_content', $3)",
        )
        .bind(recovery_target_id)
        .bind(actor_id)
        .bind(recovery_draft.id)
        .execute(&pool)
        .await
        .expect("seed recovery target");
        repository
          .create_or_get(recovery_draft.clone())
          .await
          .expect("create recovery Extract");
        sqlx::query(
          "INSERT INTO workspace_memberships
         (workspace_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'Owner', 'Accepted', now())",
        )
        .bind(recovery_target_id)
        .bind(actor_id)
        .execute(&pool)
        .await
        .expect("seed recovery target membership");
        sqlx::query(
          "INSERT INTO workspace_content_extract_targets (
         operation_id, source_workspace_id, source_folder_id, target_workspace_id,
         owner_principal_type, owner_principal_id, membership_revision,
         membership_snapshot, acl_publication_plan
       )
       VALUES ($1, $2, 'recovery-folder', $3, 'user', $4,
               'recovery-revision', $5, '[]'::jsonb)",
        )
        .bind(recovery_draft.id)
        .bind(source_workspace_id)
        .bind(recovery_target_id)
        .bind(actor_id)
        .bind(
          serde_json::to_value(vec![WorkspaceContentMemberRevision {
            user_id: actor_id,
            role: WorkspaceRole::Owner,
          }])
          .unwrap(),
        )
        .execute(&pool)
        .await
        .expect("seed recovery receipt");
        for (from, to) in [
          (
            WorkspaceContentOperationStatus::Draft,
            WorkspaceContentOperationStatus::Previewed,
          ),
          (
            WorkspaceContentOperationStatus::Previewed,
            WorkspaceContentOperationStatus::Queued,
          ),
          (
            WorkspaceContentOperationStatus::Queued,
            WorkspaceContentOperationStatus::Running,
          ),
        ] {
          repository
            .transition(recovery_draft.id, from, to, None, None)
            .await
            .expect("advance recovery Extract");
        }
        let failure = RedactedWorkspaceContentError::new(
          WorkspaceContentErrorCode::PreflightStale,
          "workspace content publication snapshot is stale",
        )
        .expect("safe failure")
        .with_phase("publication");
        // Real publication creates these target-private intents before I/O.
        // They must not keep the unpublished target alive after compensation.
        let private_blob = resource(recovery_target_id, WorkspaceContentResourceKind::Blob, "private-recovery-blob");
        repository.append_compensation(WorkspaceContentCompensationIntent {
          operation_id: recovery_draft.id, sequence: 1_000_000,
          kind: "delete_operation_blob".into(), target: private_blob.clone(),
        }).await.expect("durable private Blob cleanup intent");
        let private_key = format!("{recovery_target_id}/private-recovery-blob");
        storage.write_blob(BlobWriteRequest {
          key: private_key.clone(), content_type: Some("application/octet-stream".into()),
          body: Bytes::from_static(b"unpublished recovery bytes"),
        }).await.expect("unpublished materialization");
        if cancelled {
          repository
            .cancel_unpublished(recovery_draft.id, actor_id)
            .await
            .expect("cancellation wins race");
        }
        let cleanup = repository
          .mark_extract_cleanup_required(recovery_draft.id, "cleanup-test", failure.clone())
          .await
          .expect("persist interrupted compensation");
        assert_eq!(cleanup.status, WorkspaceContentOperationStatus::CleanupRequired);
        if cancelled {
          assert_eq!(
            cleanup.error.as_ref().unwrap().message(),
            "workspace content cancellation cleanup requires retry"
          );
          assert!(repository.resume_cleanup_required(recovery_draft.id).await.is_err());
        } else {
          assert_eq!(cleanup.error, Some(failure.clone()));
          let resumed = repository
            .resume_cleanup_required(recovery_draft.id)
            .await
            .expect("resume only cleanup");
          assert_eq!(resumed.status, WorkspaceContentOperationStatus::CleanupRequired);
          assert_eq!(resumed.error, Some(failure.clone()));
        }
        if !cancelled {
          let unavailable_storage = Arc::new(InterleavedPublicationStorage {
            inner: storage.clone(), paused_key: String::new(),
            written: tokio::sync::Notify::new(), resume: tokio::sync::Notify::new(),
            reject_deletes: true,
          });
          let interrupted = WorkspaceContentExtractRecoveryService::new(
            repository.clone(), repository.clone(), unavailable_storage,
            "extract-recovery-unavailable-storage".into(),
          ).recover(recovery_draft.id, failure.clone()).await;
          assert!(matches!(interrupted, Err(AuthError::Storage(code)) if code == WorkspaceContentErrorCode::BlobCompensationFailed.as_str()));
          let retained = repository.get(recovery_draft.id).await.unwrap().unwrap();
          assert_eq!(retained.status, WorkspaceContentOperationStatus::CleanupRequired);
          assert_eq!(retained.error, Some(failure.clone()), "cleanup failure never replaces the originating publication failure");
          assert_eq!(retained.target_workspace_id, Some(recovery_target_id));
          assert!(storage.read_blob(&private_key).await.is_ok(), "failed deletion retains private bytes and their recovery intent");
          assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_content_operation_compensations WHERE operation_id=$1 AND completed_at IS NULL")
            .bind(recovery_draft.id).fetch_one(&pool).await.unwrap(), 1);
        }
        let recovered = WorkspaceContentExtractRecoveryService::new(
          repository.clone(),
          repository.clone(),
          storage.clone(),
          "extract-recovery-test".to_string(),
        )
        .recover(recovery_draft.id, failure.clone())
        .await
        .expect("compensate unpublished Extract");
        assert_eq!(
          recovered.status,
          if cancelled {
            WorkspaceContentOperationStatus::Cancelled
          } else {
            WorkspaceContentOperationStatus::Failed
          }
        );
        assert_eq!(recovered.error, if cancelled { None } else { Some(failure) });
        assert_eq!(recovered.target_workspace_id, None);
        assert!(matches!(storage.read_blob(&private_key).await, Err(PortError::NotFound(_))), "operation-private bytes must be removed before their target");
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_content_operation_compensations WHERE operation_id=$1")
          .bind(recovery_draft.id).fetch_one(&pool).await.unwrap(), 0, "completed intents must not retain a RESTRICT reference");
        assert!(
          !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = $1)")
            .bind(recovery_target_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
          "pre-publication compensation removes only the operation-owned hidden target"
        );

        sqlx::query("DELETE FROM workspace_content_operations WHERE id = $1")
          .bind(recovery_draft.id)
          .execute(&pool)
          .await
          .unwrap();
      }
    }
    }).catch_unwind().await;
    sqlx::query("DELETE FROM workspace_content_operation_requests WHERE operation_id = ANY($1)")
      .bind(&fixture_operations)
      .execute(&pool)
      .await
      .expect("remove exact fixture Undo request edges");
    // Immediate RESTRICT checks cannot rely on the row order of a multi-row
    // parent DELETE. Remove this fixture's inverse receipt edges explicitly.
    sqlx::query("DELETE FROM workspace_content_extract_targets WHERE operation_id = ANY($1)")
      .bind(&fixture_operations)
      .execute(&pool)
      .await
      .expect("remove exact fixture counter-Move receipt edges");
    sqlx::query("DELETE FROM workspace_content_operations WHERE id = ANY($1)")
      .bind(&fixture_operations)
      .execute(&pool)
      .await
      .expect("clean exact Extract operation fixtures even after assertion failure");
    helpers::cleanup_workspaces(&pool, &fixture_workspaces).await;
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces WHERE id = ANY($1)")
      .bind(&fixture_workspaces)
      .fetch_one(&pool)
      .await
      .expect("verify Extract workspace cleanup");
    if let Some((organization_id, unit_id, previous_policy)) = organization_fixture {
      helpers::cleanup_organization_units(&pool, &[unit_id]).await;
      sqlx::query("UPDATE organization_policy SET manager_can_create_workspaces = $2 WHERE organization_id = $1")
        .bind(organization_id)
        .bind(previous_policy)
        .execute(&pool)
        .await
        .expect("restore original OU creation policy");
    }
    helpers::cleanup_users(&pool, &[actor_id, workspace_owner_id]).await;
    assert_eq!(remaining, 0, "Extract fixture cleanup must not hide a SQL failure");
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  });
}

/// Deleting a former owner must not destroy a surviving document's lineage;
/// deleting its current owner must remove the document and its history.
#[sqlx::test(migrations = false)]
async fn workspace_deletion_after_move_preserves_only_surviving_document_history(pool: sqlx::PgPool) {
  let options = pool.connect_options();
  pool.close().await;
  helpers::block_on_large_stack("workspace-deletion-after-move", move || async move {
    let pool = sqlx::postgres::PgPoolOptions::new()
      .max_connections(4)
      .connect_with((*options).clone())
      .await
      .expect("owned deletion database");
    myoxus_infrastructure::migrations::run(&pool)
      .await
      .expect("migrate deletion database");
    let (app, pool, auth) = helpers::setup_app_with_pool(pool).await;
    let (admin, session) = helpers::seed_admin(&pool, &auth).await;
    for delete_account in [false, true] {
      let actor = if delete_account {
        helpers::seed_user(&pool, &auth, "move-deleted-owner").await.0
      } else {
        admin
      };
      let source = helpers::create_workspace(&pool, actor).await;
      let target = helpers::create_workspace(&pool, admin).await;
      seed_organizer_root(&pool, source, actor).await;
      seed_organizer_root(&pool, target, admin).await;
      let doc = Uuid::new_v4();
      let body = yjs::markdown_to_yjs("Moved document", "History of the surviving document").expect("native snapshot");
      sqlx::query("INSERT INTO docs(id,workspace_id,external_id,title,created_by,updated_by) VALUES($1,$2,'delete-source','Moved document',$3,$3)")
        .bind(doc).bind(source).bind(actor).execute(&pool).await.expect("source document");
      sqlx::query("INSERT INTO doc_updates(doc_id,workspace_id,payload,sequence) VALUES($1,$2,$3,1)")
        .bind(doc)
        .bind(source)
        .bind(&body)
        .execute(&pool)
        .await
        .expect("source body");
      sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) VALUES($1,$2,'Owner')")
        .bind(actor)
        .bind(doc)
        .execute(&pool)
        .await
        .expect("source permission");
      let docs = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
      let history = docs.capture_history_snapshot(doc).await.expect("capture real history");
      let original: Vec<u8> = sqlx::query_scalar("SELECT snapshot FROM doc_histories WHERE id=$1")
        .bind(history)
        .fetch_one(&pool)
        .await
        .expect("immutable history bytes");
      let repository =
        PgWorkspaceContentOperationRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
      let mapping = WorkspaceContentIdMapping::new(
        resource(source, WorkspaceContentResourceKind::Document, "delete-source"),
        resource(target, WorkspaceContentResourceKind::Document, "delete-target"),
      )
      .expect("Move mapping");
      let batch = prepared_move_batch(&pool, &repository, actor, source, target, vec![mapping], None).await;
      let mut replay = batch.operation.clone();
      replay.status = WorkspaceContentOperationStatus::Draft;
      replay.diagnostic_instance_id = None;
      let storage_root = tempfile::tempdir().expect("owned Move storage");
      let publisher = PgWorkspaceContentMovePublicationRepository::new(
        pool.clone(),
        Arc::new(StorageAdapter::new_fs(storage_root.path().to_str().expect("storage path")).expect("Move storage")),
        crate::helpers::database_starter_catalog(),
      );
      publisher
        .publish_move(batch, "workspace-deletion-test")
        .await
        .expect("actual Move publication");
      let before = docs
        .history_entry(history)
        .await
        .expect("project moved history")
        .expect("moved history");
      let head = docs.history.revision(target, doc).await.expect("persisted head");
      let mutation = if delete_account {
        serde_json::json!({"query":"mutation($id:String!){admin{deleteUser(id:$id){success}}}","variables":{"id":actor}})
      } else {
        serde_json::json!({"query":"mutation($id:ID!){admin{deleteWorkspace(id:$id)}}","variables":{"id":source}})
      };
      let response = helpers::gql(&app, session, mutation).await;
      assert!(
        response.get("errors").is_none(),
        "public former-owner deletion: {response}"
      );
      if delete_account {
        assert_eq!(response["data"]["admin"]["deleteUser"]["success"], true);
      }
      assert!(
        !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1)")
          .bind(source)
          .fetch_one(&pool)
          .await
          .expect("source deletion readback")
      );
      let after = docs
        .history_entry(history)
        .await
        .expect("history after former-owner deletion")
        .expect("surviving history");
      assert_eq!(after.workspace_id, target);
      assert_eq!(
        after.snapshot, before.snapshot,
        "former-owner deletion cannot change projected history"
      );
      assert_eq!(
        sqlx::query_scalar::<_, Vec<u8>>("SELECT snapshot FROM doc_histories WHERE id=$1")
          .bind(history)
          .fetch_one(&pool)
          .await
          .expect("retained original history"),
        original
      );
      assert_eq!(docs.history.revision(target, doc).await.expect("unchanged head"), head);
      let metadata = helpers::gql(&app, session, serde_json::json!({
        "query":"query($w:String!,$d:String!,$h:ID!){workspace(id:$w){history(guid:$d,snapshotId:$h){snapshotId origin}}}",
        "variables":{"w":target,"d":"delete-target","h":history.to_string()}
      })).await;
      assert!(
        metadata.get("errors").is_none(),
        "surviving history metadata: {metadata}"
      );
      assert_eq!(
        metadata["data"]["workspace"]["history"]["snapshotId"],
        history.to_string()
      );
      let preview = app
        .clone()
        .oneshot(
          axum::http::Request::builder()
            .uri(format!(
              "/api/workspaces/{target}/docs/delete-target/histories/by-id/{history}"
            ))
            .header("Cookie", format!("affine_session={session}"))
            .body(axum::body::Body::empty())
            .expect("history preview request"),
        )
        .await
        .expect("history preview");
      assert_eq!(preview.status(), axum::http::StatusCode::OK);
      let replayed = repository
        .create_or_get(replay)
        .await
        .expect("terminal replay after parent deletion");
      assert!(!replayed.created);
      assert_eq!(replayed.record.status, WorkspaceContentOperationStatus::Succeeded);
      let response = helpers::gql(
        &app,
        session,
        serde_json::json!({
          "query":"mutation($id:ID!){admin{deleteWorkspace(id:$id)}}","variables":{"id":target}
        }),
      )
      .await;
      assert!(
        response.get("errors").is_none(),
        "public current-owner deletion: {response}"
      );
      assert!(
        docs
          .history_entry(history)
          .await
          .expect("deleted history readback")
          .is_none()
      );
      assert!(
        !sqlx::query_scalar::<_, bool>(
          "SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1) OR EXISTS(SELECT 1 FROM doc_histories WHERE doc_id=$1)"
        )
        .bind(doc)
        .fetch_one(&pool)
        .await
        .expect("deleted content readback")
      );
    }
    // SQLx drops the complete owned database; StorageAdapter uses the scoped tempdir.
  });
}

#[sqlx::test(migrations = false)]
async fn workspace_deletion_fences_admission_retry_and_unfinished_cleanup(pool: sqlx::PgPool) {
  use myoxus_application::admin::AdminStore;
  use myoxus_infrastructure::admin::SqlxAdminStore;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrate owned fencing database");
  let (actor, _) = helpers::seed_admin_db(&pool).await;
  let source = helpers::create_workspace(&pool, actor).await;
  let target = helpers::create_workspace(&pool, actor).await;
  let repository = PgWorkspaceContentOperationRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
  let admin = SqlxAdminStore::new(pool.clone());
  let draft = operation(Uuid::new_v4(), Uuid::new_v4(), actor, source, target, &"a".repeat(64));
  repository.create_or_get(draft.clone()).await.expect("admit transfer");
  assert!(
    matches!(admin.delete_workspace(source).await, Err(AuthError::InvalidInput(_))),
    "admitted work protects its source"
  );
  repository
    .transition(
      draft.id,
      WorkspaceContentOperationStatus::Draft,
      WorkspaceContentOperationStatus::Cancelled,
      None,
      None,
    )
    .await
    .expect("cancel empty transfer");
  sqlx::query("INSERT INTO workspace_content_operation_compensations(operation_id,sequence,kind,target_workspace_id,target_kind,target_id) VALUES($1,0,'delete_operation_blob',$2,'blob','private-unpublished')")
    .bind(draft.id).bind(target).execute(&pool).await.expect("pending private cleanup fixture");
  assert!(
    matches!(admin.delete_workspace(source).await, Err(AuthError::InvalidInput(_))),
    "cancelled work must finish private cleanup before either parent is deleted"
  );
  sqlx::query("UPDATE workspace_content_operation_compensations SET completed_at=now() WHERE operation_id=$1")
    .bind(draft.id)
    .execute(&pool)
    .await
    .expect("finish owned cleanup intent");
  admin
    .delete_workspace(source)
    .await
    .expect("completed cancellation permits delete");
  let source = helpers::create_workspace(&pool, actor).await;
  let mut failed = operation(Uuid::new_v4(), Uuid::new_v4(), actor, source, target, &"b".repeat(64));
  failed.preview_revision = Some("retry-bound".into());
  repository
    .create_or_get(failed.clone())
    .await
    .expect("admit failed fixture");
  repository
    .transition(
      failed.id,
      WorkspaceContentOperationStatus::Draft,
      WorkspaceContentOperationStatus::Failed,
      Some(
        RedactedWorkspaceContentError::new(
          WorkspaceContentErrorCode::WorkerExecutionFailed,
          "owned terminal failure",
        )
        .expect("failure"),
      ),
      None,
    )
    .await
    .expect("terminal failure with no private effects");
  admin
    .delete_workspace(source)
    .await
    .expect("clean terminal failure permits delete");
  assert!(
    matches!(repository.retry_failed(failed.id,actor,"retry-bound").await,Err(AuthError::NotFound(code)) if code==WorkspaceContentErrorCode::SourceWorkspaceMissing.as_str())
  );
  assert!(
    matches!(repository.transition(failed.id,WorkspaceContentOperationStatus::Failed,WorkspaceContentOperationStatus::Queued,None,None).await,Err(AuthError::NotFound(code)) if code==WorkspaceContentErrorCode::SourceWorkspaceMissing.as_str())
  );
  let replay = repository
    .create_or_get(failed.clone())
    .await
    .expect("read completed failure receipt");
  assert!(!replay.created);
  assert_eq!(replay.record.status, WorkspaceContentOperationStatus::Failed);

  // Hold the real parent deletion open. Admission must wait, then observe its
  // committed absence rather than leave a new operation against a deleted owner.
  let source = helpers::create_workspace(&pool, actor).await;
  let mut deleting = pool.begin().await.expect("owned deletion transaction");
  let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
    .fetch_one(&mut *deleting)
    .await
    .expect("delete blocker pid");
  sqlx::query("DELETE FROM workspaces WHERE id=$1")
    .bind(source)
    .execute(&mut *deleting)
    .await
    .expect("pending deletion");
  let diagnostic_pool = sqlx::postgres::PgPoolOptions::new()
    .max_connections(2)
    .connect_with(
      (*pool.connect_options())
        .clone()
        .application_name("history-delete-admission"),
    )
    .await
    .expect("scoped admission pool");
  let contender =
    PgWorkspaceContentOperationRepository::new(diagnostic_pool.clone(), crate::helpers::database_starter_catalog());
  let record = operation(Uuid::new_v4(), Uuid::new_v4(), actor, source, target, &"c".repeat(64));
  let op_id = record.id;
  let pending = tokio::spawn(async move { contender.create_or_get(record).await });
  tokio::time::timeout(std::time::Duration::from_secs(10),async {
    loop {
      let waiting: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='history-delete-admission' AND $1=ANY(pg_blocking_pids(pid)))")
        .bind(blocker).fetch_one(&pool).await.expect("observe admission parent lock");
      if waiting { break; }
      tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
  }).await.expect("admission must wait on the deleting parent");
  deleting.commit().await.expect("commit parent deletion");
  assert!(
    matches!(pending.await.expect("admission task"),Err(AuthError::NotFound(code)) if code==WorkspaceContentErrorCode::SourceWorkspaceMissing.as_str())
  );
  assert!(
    !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workspace_content_operations WHERE id=$1)")
      .bind(op_id)
      .fetch_one(&pool)
      .await
      .expect("no orphan admission")
  );
  diagnostic_pool.close().await;
  // SQLx removes this isolated database, including retained content-free receipts.
}

#[test]
fn task_source_discovery_binds_internal_identity_without_editor_key_retargeting() {
  helpers::block_on_large_stack("task-source-discovery-identity", || async {
    use futures_util::FutureExt;
    use myoxus_domain::database::{DatabaseEditingRepository, DatabaseProjectionRepository};
    async fn graph_source_projection(app: &axum::Router, session: Uuid, workspace: Uuid) -> serde_json::Value {
      let response=helpers::gql(app,session,serde_json::json!({
        "query":"query($w:String!){workspace(id:$w){documentGraph(input:{direction:Both,first:20}){databaseReferences{targetDocId rawTargetDocId referenceKind targetWorkspaceId}}}}",
        "variables":{"w":workspace},
      })).await;
      assert!(response.get("errors").is_none(), "{response}");
      response["data"]["workspace"]["documentGraph"]["databaseReferences"]
        .as_array()
        .expect("graph references")
        .iter()
        .find(|r| r["referenceKind"] == "TaskSource")
        .expect("capture source in actual GraphQL graph")
        .clone()
    }
    let (app, pool, auth) = helpers::setup_app().await;
    let (actor, session) = helpers::seed_user(&pool, &auth, "task-source-discovery-owner").await;
    let source_workspace = helpers::create_workspace(&pool, actor).await;
    let target_workspace = helpers::create_workspace(&pool, actor).await;
    let outcome=std::panic::AssertUnwindSafe(async {
      seed_organizer_root(&pool,source_workspace,actor).await;
      seed_organizer_root(&pool,target_workspace,actor).await;
      let source=Uuid::new_v4();let database=Uuid::new_v4();let row=Uuid::new_v4();
      let source_key="capture-meeting-note";
      sqlx::query("INSERT INTO docs(id,workspace_id,external_id,title,created_by,updated_by) VALUES($1,$2,$3,'Original source',$4,$4)")
        .bind(source).bind(source_workspace).bind(source_key).bind(actor).execute(&pool).await.unwrap();
      // A local editor key spelling the retained internal UUID is another Doc.
      sqlx::query("INSERT INTO docs(id,workspace_id,external_id,title,created_by,updated_by) VALUES($1,$2,$3,'UUID-key impostor',$4,$4)")
        .bind(Uuid::new_v4()).bind(source_workspace).bind(source.to_string()).bind(actor).execute(&pool).await.unwrap();
      sqlx::query("INSERT INTO workspace_databases(id,workspace_id,title,created_by,updated_by) VALUES($1,$2,'Capture Project',$3,$3)")
        .bind(database).bind(source_workspace).bind(actor).execute(&pool).await.unwrap();
      sqlx::query("INSERT INTO workspace_database_rows(id,database_id,row_kind,title,position,created_by,updated_by) VALUES($1,$2,'task','Captured action',0,$3,$3)")
        .bind(row).bind(database).bind(actor).execute(&pool).await.unwrap();
      sqlx::query("INSERT INTO database_row_source_links(row_id,source_workspace_id,source_document_id,source_external_id) VALUES($1,$2,$3,$4)")
        .bind(row).bind(source_workspace).bind(source).bind(source_key).execute(&pool).await.unwrap();
      let database_repo=PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
      database_repo.refresh_document_references_for_row(row).await.unwrap();
      let graph_source=PgWorkspaceContentGraphSource::new(pool.clone(),DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
      let request=WorkspaceContentOperationRequest {
        kind:WorkspaceContentOperationKind::Copy,source_workspace_id:source_workspace,target_workspace_id:target_workspace,
        selection:WorkspaceContentOperationSelection::Resources {resources:vec![resource(source_workspace,WorkspaceContentResourceKind::Database,database.to_string())]},
        copy_document_acl:false,extract_workspace_name:None, git_sync_choice: None,link_entry_id:None,link_parent_id:None,link_index:None,
      };
      let prepared=graph_source.prepare(Uuid::nil(), Uuid::nil(), &request,vec![]).await.unwrap();
      let reference=prepared.input.references.iter().find(|r|r.relation=="database_document_references").expect("native capture source discovery");
      assert_eq!(reference.target.resource_id(),source_key);
      assert_eq!(reference.target.workspace_id(),source_workspace);
      assert!(reference.target_exists,"non-UUID editor key resolves through its immutable Doc UUID");
      WorkspaceContentGraphBuilder.build(prepared.input).expect("native source reference remains a classified graph edge");
      // Move only the Task's Database: retained origin identity must stay
      // unavailable in the new containing scope, even for this owner of both.
      sqlx::query("UPDATE workspace_databases SET workspace_id=$2 WHERE id=$1").bind(database).bind(target_workspace).execute(&pool).await.unwrap();
      let stationary_database=Uuid::new_v4();
      sqlx::query("INSERT INTO workspace_databases(id,workspace_id,title,created_by,updated_by) VALUES($1,$2,'Stationary discovery root',$3,$3)")
        .bind(stationary_database).bind(source_workspace).bind(actor).execute(&pool).await.unwrap();
      let old_scope_request=WorkspaceContentOperationRequest {
        selection:WorkspaceContentOperationSelection::Resources {resources:vec![resource(source_workspace,WorkspaceContentResourceKind::Database,stationary_database.to_string())]},
        ..request.clone()
      };
      let stale_old_scope=graph_source.prepare(Uuid::nil(), Uuid::nil(), &old_scope_request,vec![]).await.unwrap();
      assert!(!stale_old_scope.input.references.iter().any(|r|r.relation=="database_document_references"&&r.source.resource_id()==database.to_string()),
        "old-scope discovery must reject stale TaskSource ownership before index refresh");
      database_repo.refresh_document_references_for_row(row).await.unwrap();
      let moved_database_request=WorkspaceContentOperationRequest {
        source_workspace_id:target_workspace,target_workspace_id:source_workspace,
        selection:WorkspaceContentOperationSelection::Resources {resources:vec![resource(target_workspace,WorkspaceContentResourceKind::Database,database.to_string())]},
        ..request.clone()
      };
      let moved_database=graph_source.prepare(Uuid::nil(), Uuid::nil(), &moved_database_request,vec![]).await.unwrap();
      let moved_database_ref=moved_database.input.references.iter().find(|r|r.relation=="database_document_references").expect("retained moved Task source association");
      assert!(!moved_database_ref.target_exists,"Task move cannot admit its foreign origin into the new containing workspace");
      assert_eq!(moved_database_ref.target.workspace_id(),source_workspace);
      assert_eq!(moved_database_ref.target.resource_id(),source.to_string());
      let moved_database_graph=WorkspaceContentGraphBuilder.build(moved_database.input).unwrap();
      assert!(moved_database_graph.references.iter().any(|r|r.relation=="database_document_references" && r.placement==myoxus_application::workspace_content_operation::preflight::WorkspaceContentReferencePlacement::Broken));
      sqlx::query("UPDATE workspace_databases SET workspace_id=$2 WHERE id=$1").bind(database).bind(source_workspace).execute(&pool).await.unwrap();
      database_repo.refresh_document_references_for_row(row).await.unwrap();
      let api_source=graph_source_projection(&app,session,source_workspace).await;
      assert_eq!(api_source["targetDocId"],source_key);
      // Keep the derived UUID stale while changing only the current route key.
      sqlx::query("UPDATE docs SET external_id='renamed-origin-key' WHERE id=$1").bind(source).execute(&pool).await.unwrap();
      let renamed=graph_source_projection(&app,session,source_workspace).await;
      assert!(renamed["targetDocId"].is_null(),"captured origin must retain the preview's immutable scoped identity");
      sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1").bind(source).bind(source_key).execute(&pool).await.unwrap();
      sqlx::query("UPDATE docs SET blocked=true WHERE id=$1").bind(source).execute(&pool).await.unwrap();
      let blocked=graph_source.prepare(Uuid::nil(), Uuid::nil(), &request,vec![]).await.unwrap();
      let blocked=blocked.input.references.iter().find(|r|r.relation=="database_document_references").unwrap();
      assert!(!blocked.target_exists,"blocked origin is neutral even while its derived UUID is retained");
      assert_eq!(blocked.target.resource_id(),source.to_string());
      sqlx::query("UPDATE docs SET blocked=false,workspace_id=$2 WHERE id=$1").bind(source).bind(target_workspace).execute(&pool).await.unwrap();
      // A committed native transfer is deliberately insufficient for TaskSource:
      // normal document links may follow it, while capture retains its origin.
      let hash="a".repeat(64);let operation_id=Uuid::new_v4();
      let mut moved_operation=operation(operation_id,Uuid::new_v4(),actor,source_workspace,target_workspace,&hash);
      moved_operation.kind=WorkspaceContentOperationKind::Move;
      PgWorkspaceContentOperationRepository::new(pool.clone(), crate::helpers::database_starter_catalog()).create_or_get(moved_operation).await.unwrap();
      sqlx::query("INSERT INTO workspace_content_move_revision_manifests(operation_id,manifest,manifest_hash) VALUES($1,$2,$3)")
        .bind(operation_id).bind(serde_json::json!({"documents":[{"doc_id":source}]})).bind(&hash).execute(&pool).await.unwrap();
      sqlx::query("INSERT INTO workspace_content_move_publications(operation_id,source_workspace_id,target_workspace_id,manifest_hash,resource_count,diagnostic_instance_id) VALUES($1,$2,$3,$4,1,'capture-source-test')")
        .bind(operation_id).bind(source_workspace).bind(target_workspace).bind(&hash).execute(&pool).await.unwrap();
      assert!(DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))).has_committed_transfer_from(source,source_workspace).await.unwrap());
      let moved_api=graph_source_projection(&app,session,source_workspace).await;
      assert!(moved_api["targetDocId"].is_null(),"TaskSource never follows a committed transfer, even for an actor owning both workspaces");
      assert_eq!(moved_api["targetWorkspaceId"],source_workspace.to_string());
      database_repo.refresh_document_references_for_row(row).await.unwrap();
      let moved=graph_source.prepare(Uuid::nil(), Uuid::nil(), &request,vec![]).await.unwrap();
      let moved_ref=moved.input.references.iter().find(|r|r.relation=="database_document_references").unwrap();
      assert!(!moved_ref.target_exists,"foreign moved identity cannot resolve through a same-named local key");
      assert_eq!(moved_ref.target.resource_id(),source.to_string());
      let moved_graph=WorkspaceContentGraphBuilder.build(moved.input).unwrap();
      assert!(moved_graph.references.iter().any(|r|r.relation=="database_document_references" && r.placement==myoxus_application::workspace_content_operation::preflight::WorkspaceContentReferencePlacement::Broken));
      sqlx::query("DELETE FROM docs WHERE id=$1").bind(source).execute(&pool).await.unwrap();
      sqlx::query("INSERT INTO docs(id,workspace_id,external_id,title,created_by,updated_by) VALUES($1,$2,$3,'Reused editor key',$4,$4)")
        .bind(Uuid::new_v4()).bind(source_workspace).bind(source_key).bind(actor).execute(&pool).await.unwrap();
      database_repo.refresh_document_references_for_row(row).await.unwrap();
      let reused=graph_source.prepare(Uuid::nil(), Uuid::nil(), &request,vec![]).await.unwrap();
      let reused=reused.input.references.iter().find(|r|r.relation=="database_document_references").unwrap();
      assert!(!reused.target_exists);assert_eq!(reused.target.resource_id(),source.to_string());
    }).catch_unwind().await;
    sqlx::query("DELETE FROM workspace_content_operations WHERE source_workspace_id=$1")
      .bind(source_workspace)
      .execute(&pool)
      .await
      .expect("remove fixture-owned transfer evidence");
    helpers::cleanup_workspaces(&pool, &[source_workspace, target_workspace]).await;
    helpers::cleanup_users(&pool, &[actor]).await;
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  });
}
