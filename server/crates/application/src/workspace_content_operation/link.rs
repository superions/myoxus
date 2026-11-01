// SPDX-License-Identifier: AGPL-3.0-or-later
//! Permission-safe cross-workspace organizer links.
//!
//! Link rows never grant access. Every mutation and projection resolves the
//! current target through its owning application service and applies the
//! canonical effective permission model. Transports receive one neutral
//! denied-or-missing result and therefore cannot use links to enumerate
//! inaccessible resources.

use std::{
  collections::{HashMap, HashSet},
  sync::Arc,
};

use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::workspace_content_operation::{
  RedactedWorkspaceContentError, WorkspaceContentErrorCode, WorkspaceContentOperationKind,
  WorkspaceContentOperationRecord, WorkspaceContentOperationStatus, WorkspaceContentResourceKind,
};
use thiserror::Error;
use uuid::Uuid;

use crate::database::{DatabaseDefinitionService, ERR_FORBIDDEN, ERR_NOT_FOUND};
use crate::doc::{DocService, DocSpaceKind};
use crate::organizer::{
  CreateOrganizerLink, OrganizerError, OrganizerLinkProjection, OrganizerLinkType, OrganizerRow, OrganizerService,
  OrganizerSnapshotNode, UpdateOrganizerLink,
};
use crate::permission::{AccessController, PermissionService, WorkspaceResource};
use crate::workspace_tags::{ERR_TAG_FORBIDDEN, ERR_TAG_NOT_FOUND, WorkspaceTagService};
use myoxus_domain::document_key::DocumentKey;

use super::worker::WorkspaceContentSemanticExecutor;
use super::{WorkspaceContentLinkIntentRepository, WorkspaceContentOperationRepository};

#[derive(Debug, Clone)]
pub struct WorkspaceContentLinkPublicationBatch {
  pub operation: WorkspaceContentOperationRecord,
  pub intent: super::WorkspaceContentLinkIntent,
  pub organizer: OrganizerLinkProjection,
}

#[async_trait::async_trait]
pub trait WorkspaceContentLinkPublicationPort: Send + Sync {
  /// Commit organizer state, publication intent, and terminal status as one
  /// durable boundary.
  async fn publish_link(
    &self,
    batch: WorkspaceContentLinkPublicationBatch,
    diagnostic_instance_id: &str,
  ) -> crate::auth::AuthResult<WorkspaceContentOperationRecord>;
}

/// Stable, non-enumerating link failure.
#[derive(Debug, Error)]
pub enum WorkspaceContentLinkError {
  #[error("organizer link target is unavailable")]
  DeniedOrMissing,
  #[error("organizer link dependency is unavailable")]
  DependencyUnavailable,
  #[error(transparent)]
  Organizer(#[from] OrganizerError),
}

/// One permission-filtered backlink row and its containing workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentBacklink {
  pub containing_workspace_id: Uuid,
  pub row: OrganizerRow,
}

/// Shared link handler used by server transports and XWS workers.
#[derive(Clone)]
pub struct WorkspaceContentLinkService {
  organizer: OrganizerService<DocService>,
  doc: DocService,
  permission: Arc<PermissionService>,
  database: Option<Arc<DatabaseDefinitionService>>,
  tags: Option<Arc<WorkspaceTagService>>,
}

impl WorkspaceContentLinkService {
  pub fn new(doc: DocService, permission: Arc<PermissionService>) -> Self {
    Self {
      organizer: OrganizerService::new(doc.clone()),
      doc,
      permission,
      database: None,
      tags: None,
    }
  }

  pub fn with_database_definition(mut self, database: Option<Arc<DatabaseDefinitionService>>) -> Self {
    self.database = database;
    self
  }

  pub fn with_workspace_tag_service(mut self, tags: Option<Arc<WorkspaceTagService>>) -> Self {
    self.tags = tags;
    self
  }

  /// Create a link after checking both the containing organizer and target.
  pub async fn create(
    &self,
    actor_id: Uuid,
    containing_workspace_id: Uuid,
    request: CreateOrganizerLink,
  ) -> Result<OrganizerRow, WorkspaceContentLinkError> {
    // A link row changes document placement only in its containing workspace.
    // The target remains independently protected by assert_target_visible.
    self
      .assert_workspace_action(actor_id, containing_workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    self
      .assert_target_visible(
        actor_id,
        containing_workspace_id,
        request.link_type,
        &request.target_id,
        request.target_workspace_id,
      )
      .await?;
    Ok(self.organizer.create_link(containing_workspace_id, request).await?)
  }

  /// Authorize and prepare an operation-owned link without publishing it.
  pub async fn project_for_operation(
    &self,
    actor_id: Uuid,
    containing_workspace_id: Uuid,
    request: CreateOrganizerLink,
  ) -> Result<OrganizerLinkProjection, WorkspaceContentLinkError> {
    self
      .assert_workspace_action(actor_id, containing_workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    self
      .assert_target_visible(
        actor_id,
        containing_workspace_id,
        request.link_type,
        &request.target_id,
        request.target_workspace_id,
      )
      .await?;
    Ok(
      self
        .organizer
        .project_operation_link(containing_workspace_id, request)
        .await?,
    )
  }

  /// Retarget a row only after validating the resulting complete reference.
  pub async fn update(
    &self,
    actor_id: Uuid,
    containing_workspace_id: Uuid,
    entry_id: &str,
    patch: UpdateOrganizerLink,
  ) -> Result<OrganizerRow, WorkspaceContentLinkError> {
    self
      .assert_workspace_action(actor_id, containing_workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    let current = self
      .link_row(containing_workspace_id, entry_id)
      .await?
      .ok_or(WorkspaceContentLinkError::DeniedOrMissing)?;
    let link_type = patch.link_type.unwrap_or(current.link_type()?);
    let target_id = patch.target_id.as_deref().unwrap_or(&current.data);
    let target_workspace_id = patch.target_workspace_id.unwrap_or(current.target_workspace_id);
    self
      .assert_target_visible(
        actor_id,
        containing_workspace_id,
        link_type,
        target_id,
        target_workspace_id,
      )
      .await?;
    Ok(
      self
        .organizer
        .update_link(containing_workspace_id, entry_id, patch)
        .await?,
    )
  }

  pub async fn delete(
    &self,
    actor_id: Uuid,
    containing_workspace_id: Uuid,
    entry_id: &str,
  ) -> Result<(), WorkspaceContentLinkError> {
    // Removing placement requires authority over the container only. It neither
    // reads, authorizes nor deletes the target resource.
    self
      .assert_workspace_action(actor_id, containing_workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    self.organizer.delete_link(containing_workspace_id, entry_id).await?;
    Ok(())
  }

  /// Return only rows whose targets remain readable at request time.
  pub async fn visible_links(
    &self,
    actor_id: Uuid,
    containing_workspace_id: Uuid,
  ) -> Result<(String, Vec<OrganizerRow>), WorkspaceContentLinkError> {
    // Folder navigation is ordinary workspace content read. Each row is still
    // filtered through the target owner's current resource-specific read ACL.
    self
      .assert_workspace_action(actor_id, containing_workspace_id, WorkspaceAction::Read)
      .await?;
    let snapshot = self.organizer.snapshot(containing_workspace_id).await?;
    let rows = flatten_rows(&snapshot.roots);
    let mut document_keys: HashMap<Uuid, Vec<String>> = HashMap::new();
    for row in rows.iter().filter(|row| row.row_type == "doc") {
      if DocumentKey::parse(row.data.clone()).is_ok() {
        document_keys
          .entry(row.target_workspace_id.unwrap_or(containing_workspace_id))
          .or_default()
          .push(row.data.clone());
      }
    }
    let mut readable_keys = HashSet::new();
    for (workspace, keys) in document_keys {
      for keys in keys.chunks(200) {
        let metadata = self
          .doc
          .metadata_by_external_keys(workspace, keys)
          .await
          .map_err(|_| WorkspaceContentLinkError::DependencyUnavailable)?;
        let ids = metadata.values().map(|doc| doc.id).collect::<Vec<_>>();
        let readable = self
          .permission
          .readable_doc_ids(actor_id, workspace, &ids)
          .await
          .map_err(|_| WorkspaceContentLinkError::DependencyUnavailable)?;
        readable_keys.extend(
          metadata
            .into_iter()
            .filter(|(_, doc)| readable.contains(&doc.id))
            .map(|(key, _)| (workspace, key)),
        );
      }
    }
    let mut visible = Vec::new();
    for row in rows.into_iter().filter(|row| !row.is_folder()) {
      if row.row_type == "doc" {
        if readable_keys.contains(&(
          row.target_workspace_id.unwrap_or(containing_workspace_id),
          row.data.clone(),
        )) {
          visible.push(row);
        }
        continue;
      }
      if self
        .target_visible(
          actor_id,
          containing_workspace_id,
          row.link_type()?,
          &row.data,
          row.target_workspace_id,
        )
        .await?
      {
        visible.push(row);
      }
    }
    Ok((snapshot.revision, visible))
  }

  /// Resolve backlinks without exposing either the target or hidden containers.
  pub async fn backlinks(
    &self,
    actor_id: Uuid,
    target_workspace_id: Uuid,
    target_type: OrganizerLinkType,
    target_id: &str,
    candidate_containing_workspaces: &[Uuid],
  ) -> Result<Vec<WorkspaceContentBacklink>, WorkspaceContentLinkError> {
    if !self
      .target_visible(
        actor_id,
        target_workspace_id,
        target_type,
        target_id,
        Some(target_workspace_id),
      )
      .await?
    {
      return Ok(Vec::new());
    }
    let mut backlinks = Vec::new();
    for workspace_id in candidate_containing_workspaces.iter().copied() {
      if !self
        .workspace_action_allowed(actor_id, workspace_id, WorkspaceAction::Read)
        .await
      {
        continue;
      }
      let snapshot = self.organizer.snapshot(workspace_id).await?;
      backlinks.extend(
        flatten_rows(&snapshot.roots)
          .into_iter()
          .filter(|row| {
            !row.is_folder()
              && row.link_type().ok() == Some(target_type)
              && row.effective_target_workspace_id(workspace_id) == target_workspace_id
              && row.data == target_id
          })
          .map(|row| WorkspaceContentBacklink {
            containing_workspace_id: workspace_id,
            row,
          }),
      );
    }
    backlinks.sort_by(|left, right| {
      (
        left.containing_workspace_id,
        left.row.index.as_str(),
        left.row.id.as_str(),
      )
        .cmp(&(
          right.containing_workspace_id,
          right.row.index.as_str(),
          right.row.id.as_str(),
        ))
    });
    Ok(backlinks)
  }

  async fn link_row(
    &self,
    containing_workspace_id: Uuid,
    entry_id: &str,
  ) -> Result<Option<OrganizerRow>, WorkspaceContentLinkError> {
    Ok(
      flatten_rows(&self.organizer.snapshot(containing_workspace_id).await?.roots)
        .into_iter()
        .find(|row| row.id == entry_id && !row.is_folder()),
    )
  }

  async fn assert_target_visible(
    &self,
    actor_id: Uuid,
    containing_workspace_id: Uuid,
    target_type: OrganizerLinkType,
    target_id: &str,
    target_workspace_id: Option<Uuid>,
  ) -> Result<(), WorkspaceContentLinkError> {
    if self
      .target_visible(
        actor_id,
        containing_workspace_id,
        target_type,
        target_id,
        target_workspace_id,
      )
      .await?
    {
      Ok(())
    } else {
      Err(WorkspaceContentLinkError::DeniedOrMissing)
    }
  }

  async fn target_visible(
    &self,
    actor_id: Uuid,
    containing_workspace_id: Uuid,
    target_type: OrganizerLinkType,
    target_id: &str,
    target_workspace_id: Option<Uuid>,
  ) -> Result<bool, WorkspaceContentLinkError> {
    let workspace_id = target_workspace_id.unwrap_or(containing_workspace_id);
    match target_type {
      OrganizerLinkType::Doc => {
        let Ok(document_key) = DocumentKey::parse(target_id) else {
          return Ok(false);
        };
        let Some(doc_id) = self
          .doc
          .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &document_key)
          .await
          .map_err(|_| WorkspaceContentLinkError::DependencyUnavailable)?
        else {
          return Ok(false);
        };
        let Some(metadata) = self
          .doc
          .get_doc_metadata(doc_id)
          .await
          .map_err(|_| WorkspaceContentLinkError::DependencyUnavailable)?
        else {
          return Ok(false);
        };
        if metadata.workspace_id != Some(workspace_id) || metadata.deleted_at.is_some() {
          return Ok(false);
        }
        // A storage failure is not evidence that a previously visible link
        // disappeared. Current-state consumers must fail closed, not publish a
        // successful partial projection during an authorization-store outage.
        Ok(
          self
            .permission
            .get_effective_doc_role(actor_id, workspace_id, doc_id)
            .await
            .map_err(|_| WorkspaceContentLinkError::DependencyUnavailable)?
            .can(DocAction::Read),
        )
      }
      OrganizerLinkType::Database => {
        let Some(database) = &self.database else {
          return Err(WorkspaceContentLinkError::DependencyUnavailable);
        };
        let Ok(database_id) = Uuid::parse_str(target_id) else {
          return Ok(false);
        };
        match database.get_database(actor_id, database_id).await {
          Ok(record) => Ok(record.database.workspace_id == workspace_id && record.database.deleted_at.is_none()),
          Err(error) if matches!(error.code, ERR_NOT_FOUND | ERR_FORBIDDEN) => Ok(false),
          Err(_) => Err(WorkspaceContentLinkError::DependencyUnavailable),
        }
      }
      OrganizerLinkType::Tag => {
        let Some(tags) = &self.tags else {
          return Err(WorkspaceContentLinkError::DependencyUnavailable);
        };
        let Ok(tag_id) = Uuid::parse_str(target_id) else {
          return Ok(false);
        };
        if !self
          .workspace_action_allowed(actor_id, workspace_id, WorkspaceAction::PropertiesRead)
          .await
        {
          return Ok(false);
        }
        match tags.get_tag(actor_id, workspace_id, tag_id).await {
          Ok(Some(tag)) => Ok(tag.workspace_id == workspace_id && tag.archived_at.is_none()),
          Ok(None) => Ok(false),
          Err(error) if matches!(error.code, ERR_TAG_NOT_FOUND | ERR_TAG_FORBIDDEN) => Ok(false),
          Err(_) => Err(WorkspaceContentLinkError::DependencyUnavailable),
        }
      }
      OrganizerLinkType::Collection => {
        if !self
          .workspace_action_allowed(actor_id, workspace_id, WorkspaceAction::OrganizeRead)
          .await
        {
          return Ok(false);
        }
        let root = self
          .doc
          .load_full_doc_consistent(workspace_id, workspace_id)
          .await
          .map_err(|_| WorkspaceContentLinkError::DependencyUnavailable)?;
        let collections =
          yjs::extract_workspace_collections(&root).map_err(|_| WorkspaceContentLinkError::DependencyUnavailable)?;
        Ok(
          collections
            .iter()
            .any(|value| value.get("id").and_then(serde_json::Value::as_str) == Some(target_id)),
        )
      }
      OrganizerLinkType::Workspace => {
        let Ok(target) = Uuid::parse_str(target_id) else {
          return Ok(false);
        };
        Ok(
          target == workspace_id
            && target_workspace_id == Some(target)
            && self
              .workspace_action_allowed(actor_id, workspace_id, WorkspaceAction::Read)
              .await,
        )
      }
    }
  }

  async fn assert_workspace_action(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    action: WorkspaceAction,
  ) -> Result<(), WorkspaceContentLinkError> {
    if self.workspace_action_allowed(actor_id, workspace_id, action).await {
      Ok(())
    } else {
      Err(WorkspaceContentLinkError::DeniedOrMissing)
    }
  }

  async fn workspace_action_allowed(&self, actor_id: Uuid, workspace_id: Uuid, action: WorkspaceAction) -> bool {
    self
      .permission
      .can(
        &WorkspaceResource {
          user_id: actor_id,
          workspace_id,
        },
        action,
      )
      .await
  }
}

fn flatten_rows(nodes: &[OrganizerSnapshotNode]) -> Vec<OrganizerRow> {
  let mut rows = Vec::new();
  let mut stack = nodes.iter().rev().collect::<Vec<_>>();
  while let Some(node) = stack.pop() {
    rows.push(node.row.clone());
    stack.extend(node.children.iter().rev());
  }
  rows
}

/// Durable Link semantics invoked by the operation-ID-only worker envelope.
pub struct WorkspaceContentLinkExecutor {
  operations: Arc<dyn WorkspaceContentOperationRepository>,
  intents: Arc<dyn WorkspaceContentLinkIntentRepository>,
  links: WorkspaceContentLinkService,
  publisher: Arc<dyn WorkspaceContentLinkPublicationPort>,
  diagnostic_instance_id: String,
}

impl WorkspaceContentLinkExecutor {
  pub fn new(
    operations: Arc<dyn WorkspaceContentOperationRepository>,
    intents: Arc<dyn WorkspaceContentLinkIntentRepository>,
    links: WorkspaceContentLinkService,
    publisher: Arc<dyn WorkspaceContentLinkPublicationPort>,
    instance_id: Uuid,
  ) -> Self {
    Self {
      operations,
      intents,
      links,
      publisher,
      diagnostic_instance_id: instance_id.to_string(),
    }
  }

  /// Publish one idempotent link through the operation-owned SQL boundary.
  pub async fn execute(
    &self,
    record: WorkspaceContentOperationRecord,
  ) -> crate::auth::AuthResult<WorkspaceContentOperationRecord> {
    self
      .execute_with_diagnostics(record)
      .await
      .map_err(|error| error.into_source())
  }

  async fn execute_with_diagnostics(
    &self,
    record: WorkspaceContentOperationRecord,
  ) -> super::diagnostics::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord> {
    if record.kind != WorkspaceContentOperationKind::Link || record.status != WorkspaceContentOperationStatus::Running {
      return Err(
        crate::auth::AuthError::InvalidInput(WorkspaceContentErrorCode::PublicationStateInvalid.as_str().into()).into(),
      );
    }
    let Some(containing_workspace_id) = record.target_workspace_id else {
      return self
        .fail_with_code(
          record,
          WorkspaceContentErrorCode::TargetWorkspaceMissing,
          "The link destination workspace is missing.",
        )
        .await
        .map_err(Into::into);
    };
    let Some(intent) = self.intents.get_link_intent(record.id).await? else {
      return self
        .fail_with_code(
          record,
          WorkspaceContentErrorCode::LinkIntentMissing,
          "The admitted link intent is missing.",
        )
        .await
        .map_err(Into::into);
    };
    if intent.target.workspace_id() != record.source_workspace_id {
      return self
        .fail_with_code(
          record,
          WorkspaceContentErrorCode::LinkIntentWorkspaceChanged,
          WorkspaceContentErrorCode::LinkIntentWorkspaceChanged
            .safe_message()
            .expect("registered cause"),
        )
        .await
        .map_err(Into::into);
    }

    let link_type = match intent.target.kind() {
      WorkspaceContentResourceKind::Document => OrganizerLinkType::Doc,
      WorkspaceContentResourceKind::Database => OrganizerLinkType::Database,
      WorkspaceContentResourceKind::Tag => OrganizerLinkType::Tag,
      WorkspaceContentResourceKind::Folder
      | WorkspaceContentResourceKind::Blob
      | WorkspaceContentResourceKind::Collection => {
        return self
          .fail_with_code(
            record,
            WorkspaceContentErrorCode::SelectedResourceUnsupported,
            "This selected resource cannot be linked.",
          )
          .await
          .map_err(Into::into);
      }
    };
    let organizer = match self
      .links
      .project_for_operation(
        record.actor_id,
        containing_workspace_id,
        CreateOrganizerLink {
          id: intent.entry_id.clone(),
          parent_id: intent.parent_id.clone(),
          link_type,
          target_id: intent.target.resource_id().to_string(),
          target_workspace_id: Some(intent.target.workspace_id()),
          index: Some(intent.index.clone()),
        },
      )
      .await
    {
      Ok(projection) if projection.revision == intent.organizer_revision => projection,
      Ok(_) => {
        return self
          .fail_with_code(
            record,
            WorkspaceContentErrorCode::LinkOrganizerChanged,
            WorkspaceContentErrorCode::LinkOrganizerChanged
              .safe_message()
              .expect("registered cause"),
          )
          .await
          .map_err(Into::into);
      }
      Err(WorkspaceContentLinkError::DependencyUnavailable) => {
        return Err(super::diagnostics::WorkspaceContentExecutionError::at_phase(
          crate::auth::AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().into()),
          "link_projection",
        ));
      }
      Err(WorkspaceContentLinkError::Organizer(error)) => {
        let error = super::diagnostics::organizer_failure(error);
        let code = super::diagnostics::failure_code(&error);
        super::diagnostics::record_failure(&record, "link_projection", &error);
        if code.retryable() {
          return Err(super::diagnostics::WorkspaceContentExecutionError::at_phase(
            error,
            "link_projection",
          ));
        }
        return self
          .fail_with_code(record, code, code.safe_message().expect("registered Organizer cause"))
          .await
          .map_err(Into::into);
      }
      Err(WorkspaceContentLinkError::DeniedOrMissing) => {
        return self
          .fail_with_code(
            record,
            WorkspaceContentErrorCode::LinkTargetUnavailable,
            WorkspaceContentErrorCode::LinkTargetUnavailable
              .safe_message()
              .expect("registered cause"),
          )
          .await
          .map_err(Into::into);
      }
    };

    let diagnostic_record = record.clone();
    super::diagnostics::in_phase(
      &diagnostic_record,
      "publication",
      self.publisher.publish_link(
        WorkspaceContentLinkPublicationBatch {
          operation: record,
          intent,
          organizer,
        },
        &self.diagnostic_instance_id,
      ),
    )
    .await
  }

  async fn fail_with_code(
    &self,
    record: WorkspaceContentOperationRecord,
    code: WorkspaceContentErrorCode,
    message: &'static str,
  ) -> crate::auth::AuthResult<WorkspaceContentOperationRecord> {
    tracing::warn!(
      operation_id = %record.id,
      phase = "link_projection",
      error_code = code.as_str(),
      reason = message,
      diagnostic_instance_id = %self.diagnostic_instance_id,
      "workspace content Link failed before publication"
    );
    let error = RedactedWorkspaceContentError::new(code, message)
      .map(|failure| failure.with_phase("link_projection"))
      .map_err(|_| {
        crate::auth::AuthError::InvalidInput(WorkspaceContentErrorCode::RequestInvalid.as_str().to_string())
      })?;
    self
      .operations
      .transition(
        record.id,
        WorkspaceContentOperationStatus::Running,
        WorkspaceContentOperationStatus::Failed,
        Some(error),
        Some(&self.diagnostic_instance_id),
      )
      .await
  }
}

#[async_trait::async_trait]
impl WorkspaceContentSemanticExecutor for WorkspaceContentLinkExecutor {
  async fn execute(
    &self,
    record: WorkspaceContentOperationRecord,
  ) -> super::diagnostics::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord> {
    self.execute_with_diagnostics(record).await
  }
}
