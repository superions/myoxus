// SPDX-License-Identifier: AGPL-3.0-or-later
//! Application owner for user-visible document templates.
//!
//! Document templates remain ordinary canonical documents. Their template
//! attribution lives only in `document_template_state`; this service joins the
//! two through a narrow persistence port, applies the normal workspace and
//! document ACLs, and derives variables from the current Yjs document state.
//! Registry-backed setup copies enter the same content/lifecycle owner through
//! an exact captured native revision. Registry assignment/publication and
//! Database Row templates remain with their existing owners.

use std::{
  collections::{BTreeSet, HashMap},
  sync::Arc,
};

use async_trait::async_trait;
use myoxus_domain::{
  document_key::DocumentKey,
  entities::DocumentMetadataPatch,
  permission::{DocAction, WorkspaceAction},
  repositories::{RepoResult, RepositoryError},
};
use sha2::Digest;
use thiserror::Error;
use tracing::{instrument, warn};
use uuid::Uuid;

use crate::{
  auth::{AuthError, EffectiveUserPreferences},
  doc::{DocRevisionCheckedUpdateOutcome, DocService, DocSpaceKind, DocumentFragment, canonical_yjs_revision},
  document_metadata::{DocumentMetadataService, DocumentMetadataServiceError},
  organization::OrganizationTemplateContextService,
  organizer::{
    CreateOrganizerLink, OrganizerError, OrganizerFolderResolutionError, OrganizerLinkType, OrganizerService,
    resolve_organizer_folder_id, resolve_organizer_folder_path,
  },
  permission::{AccessController, DocResource, PermissionService, WorkspaceResource},
  ports::{blob::BlobStatus, blob_service::BlobService},
  workspace::WorkspaceService,
  workspace_content_operation::link::{WorkspaceContentLinkError, WorkspaceContentLinkService},
};

mod capture;
mod regional;
mod sources;

pub use capture::{
  CapturedDocumentTemplate, CapturedDocumentTemplateAsset, DocumentTemplateCaptureError, DocumentTemplateCaptureRequest,
};
pub use sources::{DocumentTemplateSource, DocumentTemplateSourcePage, DocumentTemplateSourceRequest};

/// Non-secret, point-in-time projection of the authenticated applying account.
pub struct DocumentTemplateActor {
  pub name: Option<String>,
  pub email: String,
}

/// Narrow adapter to the existing Auth account owner. Actor reads are self
/// reads, not membership enumeration; preferences reuse the account UI defaults.
#[async_trait]
pub trait DocumentTemplateAccount: Send + Sync {
  async fn effective_preferences(&self, actor_id: Uuid) -> Result<EffectiveUserPreferences, AuthError>;
  async fn applying_actor(&self, actor_id: Uuid) -> Result<Option<DocumentTemplateActor>, AuthError>;
}

pub const DEFAULT_DOCUMENT_TEMPLATE_LIMIT: usize = 50;
fn required_template_text(value: &str) -> Result<String, DocumentTemplateError> {
  let value = value.trim();
  if value.is_empty() {
    return Err(DocumentTemplateError::EmptyField);
  }
  Ok(value.to_owned())
}

fn collect_template_parents<'a>(
  nodes: &'a [crate::organizer::OrganizerSnapshotNode],
  workspace_id: Uuid,
  target: &str,
  parents: &mut Vec<&'a str>,
) {
  for node in nodes {
    if node.row.row_type == "doc"
      && node.row.data == target
      && node.row.effective_target_workspace_id(workspace_id) == workspace_id
    {
      if let Some(parent) = node.row.parent_id.as_deref() {
        parents.push(parent);
      }
    }
    collect_template_parents(&node.children, workspace_id, target, parents);
  }
}
pub const MAX_DOCUMENT_TEMPLATE_LIMIT: usize = 200;
const MAX_TEMPLATE_VARIABLE_NAME_BYTES: usize = 128;
const MAX_TEMPLATE_VARIABLES: usize = 100;
const MAX_TEMPLATE_VARIABLE_VALUE_BYTES: usize = 8 * 1024;
const MAX_TEMPLATE_VARIABLE_LIST_ITEMS: usize = 500;
const USER_DOCUMENT_TEMPLATE_STATE: &str = "managed";

/// Optional literal Project context. Ordinary manual application leaves these
/// values empty; only an explicit caller supplies them. Navigation never selects
/// a Project or infers people, dates or assignments for a document.
const OPTIONAL_PROJECT_TEMPLATE_VARIABLES: [&str; 6] = [
  "project.title",
  "project.goal",
  "project.scope",
  "project.start_date",
  "project.end_date",
  "project.people",
];

const OPTIONAL_PREPARATION_TEMPLATE_VARIABLES: [&str; 4] = [
  "preparation.title",
  "preparation.date",
  "preparation.people",
  "preparation.notes",
];
fn optional_known_variable(name: &str) -> bool {
  OPTIONAL_PROJECT_TEMPLATE_VARIABLES.contains(&name) || OPTIONAL_PREPARATION_TEMPLATE_VARIABLES.contains(&name)
}

fn template_body_without_title(snapshot: &[u8]) -> Result<Vec<u8>, DocumentTemplateError> {
  let update = yjs::update_document_title(snapshot, "").map_err(|_| DocumentTemplateError::Content)?;
  yjs::merge_updates(vec![snapshot.to_vec(), update]).map_err(|_| DocumentTemplateError::Content)
}

fn is_creation_value(name: &str) -> bool {
  matches!(
    name,
    "creator.name"
      | "creator.email"
      | "document.created_at.date"
      | "document.created_at.time"
      | "document.created_at.datetime"
  )
}

fn extend_native_variables(
  native: &mut HashMap<String, yjs::NativeTemplateVariable>,
  values: HashMap<String, DocumentTemplateVariable>,
) {
  native.extend(values.into_iter().map(|(name, value)| {
    (
      name,
      match value {
        DocumentTemplateVariable::String(value) => yjs::NativeTemplateVariable::String(value),
        DocumentTemplateVariable::StringList(values) => yjs::NativeTemplateVariable::StringList(values),
        DocumentTemplateVariable::Records(values) => yjs::NativeTemplateVariable::Records(values),
      },
    )
  }));
}

/// Offset pagination is bounded by the first accepted-member count, not by
/// unique records or later counts. Failures never publish a partial inventory.
async fn template_member_records<F, Fut>(
  bound: i64,
  mut fetch: F,
) -> Result<Vec<HashMap<String, String>>, DocumentTemplateError>
where
  F: FnMut(i64, i64) -> Fut,
  Fut: std::future::Future<Output = Result<Vec<myoxus_domain::entities::WorkspaceMember>, AuthError>>,
{
  if bound < 0 {
    return Err(DocumentTemplateError::MemberUnavailable);
  }
  let mut offset = 0;
  let mut seen = BTreeSet::new();
  let mut members = Vec::new();
  while offset < bound {
    let take = (bound - offset).min(100);
    let page = fetch(offset, take)
      .await
      .map_err(|_| DocumentTemplateError::MemberUnavailable)?;
    if page.len() as i64 > take {
      return Err(DocumentTemplateError::MemberUnavailable);
    }
    if page.is_empty() {
      break;
    }
    offset += page.len() as i64;
    for member in page {
      if member.status == myoxus_domain::entities::MembershipStatus::Accepted && seen.insert(member.user.id) {
        members.push(HashMap::from([
          ("name".into(), member.user.name.trim().into()),
          ("email".into(), member.user.email.trim().into()),
        ]));
      }
    }
  }
  Ok(members)
}

/// Internal candidate loaded from canonical `docs` plus
/// `document_template_state`. The persisted state literal intentionally does
/// not cross this port because callers only need the positive template fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentTemplateCandidate {
  pub doc_id: Uuid,
  pub external_id: String,
  pub title: String,
}

/// Native source state read with template eligibility and presentation from one
/// database snapshot. This internal projection never becomes bundle metadata.
pub struct DocumentTemplateSourceState {
  pub doc_id: Uuid,
  pub external_id: String,
  pub title: String,
  pub document_revision: i64,
  pub metadata_revision: i64,
  pub primary_mode: Option<String>,
  pub update: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTemplateSummary {
  pub external_id: String,
  pub title: String,
  pub is_template: bool,
  pub required_variables: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentTemplatePage {
  pub templates: Vec<DocumentTemplateSummary>,
  pub next_offset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum DocumentTemplateFolderSelector {
  Id(String),
  Path(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DocumentTemplateDestination {
  folder_id: String,
  path: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CreateDocumentTemplate {
  pub workspace_id: Uuid,
  pub actor_id: Uuid,
  pub title: String,
  pub fragment: DocumentFragment,
  pub destination: DocumentTemplateDestination,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedDocumentTemplate {
  pub doc_id: Uuid,
  pub external_id: String,
  pub title: String,
  pub document_revision: i64,
  pub root_revision: i64,
  pub folder_id: String,
  pub folder_path: Vec<String>,
  pub entry_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum DocumentTemplateVariable {
  String(String),
  StringList(Vec<String>),
  // Keep StringList first: [] remains the existing empty string-array value.
  Records(Vec<HashMap<String, String>>),
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedDocumentTemplateContent {
  reference_targets: Option<yjs::NativeTemplateReferenceTargets>,
  authored_title: String,
  context_parent_id: Option<Uuid>,
  title: String,
  snapshot: Vec<u8>,
  pending_creation: BTreeSet<String>,
  variables: HashMap<String, yjs::NativeTemplateVariable>,
  regional: Option<EffectiveUserPreferences>,
}

#[derive(Debug, Clone)]
struct ReservedDocumentInstantiation {
  doc_id: Uuid,
  entry_id: String,
  ack: crate::workspace::ProjectDocumentAck,
}

#[derive(Debug, Clone)]
pub struct PreparedDocumentTemplateInstantiation {
  source_external_id: String,
  destination: DocumentTemplateDestination,
  content: PreparedDocumentTemplateContent,
}

impl PreparedDocumentTemplateInstantiation {
  pub fn semantic_source_external_id(&self) -> &str {
    &self.source_external_id
  }

  pub fn semantic_title(&self) -> &str {
    &self.content.authored_title
  }

  pub fn semantic_destination_id(&self) -> &str {
    &self.destination.folder_id
  }

  pub fn semantic_context_parent_id(&self) -> Option<Uuid> {
    self.content.context_parent_id
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstantiatedDocumentTemplate {
  pub doc_id: Uuid,
  pub external_id: String,
  pub document_revision: i64,
  pub root_revision: i64,
  pub folder_id: String,
  pub folder_path: Vec<String>,
  pub entry_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentTemplateStateChange {
  pub doc_id: Uuid,
  pub external_id: String,
  pub is_template: bool,
}

#[async_trait]
pub trait DocumentTemplateRepository: Send + Sync {
  async fn list_candidates(
    &self,
    workspace_id: Uuid,
    limit: usize,
    offset: usize,
  ) -> RepoResult<Vec<DocumentTemplateCandidate>>;

  async fn get_candidate(&self, workspace_id: Uuid, doc_id: Uuid) -> RepoResult<Option<DocumentTemplateCandidate>>;

  /// Capture the current committed sources in request order in one read-only
  /// repeatable-read transaction. Any ineligible source makes the capture absent.
  async fn capture_sources(
    &self,
    workspace_id: Uuid,
    external_ids: &[String],
  ) -> RepoResult<Option<Vec<DocumentTemplateSourceState>>>;
}

#[async_trait]
pub trait DocumentTemplatePlacement: Send + Sync {
  async fn resolve_destination(
    &self,
    workspace_id: Uuid,
    selector: &DocumentTemplateFolderSelector,
  ) -> Result<DocumentTemplateDestination, DocumentTemplateError>;

  async fn create_entry(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    entry_id: &str,
    destination: &DocumentTemplateDestination,
    external_id: &str,
  ) -> Result<(), DocumentTemplateError>;

  async fn delete_entry(&self, actor_id: Uuid, workspace_id: Uuid, entry_id: &str)
  -> Result<(), DocumentTemplateError>;
}

#[async_trait]
pub trait DocumentTemplateMetadata: Send + Sync {
  async fn set_template_state(
    &self,
    doc_id: Uuid,
    actor_id: Uuid,
    is_template: bool,
  ) -> Result<(), DocumentTemplateError>;
}

#[async_trait]
pub trait DocumentTemplateAssetVisibility: Send + Sync {
  async fn assert_completed_asset(&self, workspace_id: Uuid, key: &str) -> Result<(), DocumentTemplateError>;
}

/// Read-only, bounded resource access for a previously authorized source capture.
/// Workspace BlobsRead belongs to the caller; this port enforces canonical blob
/// identity, completed/live state and bounded storage reads without uploading.
#[async_trait]
pub trait DocumentTemplateAssetReader: Send + Sync {
  async fn read_completed_asset(
    &self,
    workspace_id: Uuid,
    key: &str,
    max_bytes: u64,
  ) -> Result<crate::ports::BlobReadResponse, DocumentTemplateCaptureError>;
}

#[async_trait]
impl DocumentTemplateAssetReader for BlobService {
  async fn read_completed_asset(
    &self,
    workspace_id: Uuid,
    key: &str,
    max_bytes: u64,
  ) -> Result<crate::ports::BlobReadResponse, DocumentTemplateCaptureError> {
    let before = self
      .get_blob_metadata(workspace_id, key)
      .await
      .map_err(|_| DocumentTemplateCaptureError::AssetUnavailable)?
      .filter(|meta| meta.status == BlobStatus::Completed && meta.deleted_at.is_none())
      .ok_or(DocumentTemplateCaptureError::AssetUnavailable)?;
    let content = self
      .get_blob_bounded(workspace_id, key, max_bytes)
      .await
      .map_err(|_| DocumentTemplateCaptureError::AssetUnavailable)?;
    let after = self
      .get_blob_metadata(workspace_id, key)
      .await
      .map_err(|_| DocumentTemplateCaptureError::AssetUnavailable)?
      .filter(|meta| meta.status == BlobStatus::Completed && meta.deleted_at.is_none())
      .ok_or(DocumentTemplateCaptureError::AssetUnavailable)?;
    if before.blob_id != after.blob_id
      || before.updated_at != after.updated_at
      || before.size != after.size
      || before.mime != after.mime
      || before.checksum != after.checksum
    {
      return Err(DocumentTemplateCaptureError::AssetUnavailable);
    }
    Ok(content)
  }
}

#[async_trait]
impl DocumentTemplateAssetVisibility for BlobService {
  async fn assert_completed_asset(&self, workspace_id: Uuid, key: &str) -> Result<(), DocumentTemplateError> {
    let metadata = self
      .get_blob_metadata(workspace_id, key)
      .await
      .map_err(|_| DocumentTemplateError::AssetNotVisible)?
      .ok_or(DocumentTemplateError::AssetNotVisible)?;
    if metadata.status != BlobStatus::Completed || metadata.deleted_at.is_some() {
      return Err(DocumentTemplateError::AssetNotVisible);
    }
    Ok(())
  }
}

#[async_trait]
impl DocumentTemplateMetadata for DocumentMetadataService {
  async fn set_template_state(
    &self,
    doc_id: Uuid,
    actor_id: Uuid,
    is_template: bool,
  ) -> Result<(), DocumentTemplateError> {
    self
      .set_metadata(doc_id, actor_id, template_state_patch(is_template))
      .await
      .map_err(DocumentTemplateError::Metadata)
  }
}

#[derive(Clone)]
pub struct OrganizerDocumentTemplatePlacement {
  organizer: OrganizerService<DocService>,
  links: WorkspaceContentLinkService,
}

impl OrganizerDocumentTemplatePlacement {
  pub fn new(docs: DocService, permission: Arc<PermissionService>) -> Self {
    Self {
      organizer: OrganizerService::new(docs.clone()),
      links: WorkspaceContentLinkService::new(docs, permission),
    }
  }
}

#[async_trait]
impl DocumentTemplatePlacement for OrganizerDocumentTemplatePlacement {
  async fn resolve_destination(
    &self,
    workspace_id: Uuid,
    selector: &DocumentTemplateFolderSelector,
  ) -> Result<DocumentTemplateDestination, DocumentTemplateError> {
    let snapshot = self
      .organizer
      .snapshot(workspace_id)
      .await
      .map_err(DocumentTemplateError::Organizer)?;
    match selector {
      DocumentTemplateFolderSelector::Id(folder_id) => resolve_organizer_folder_id(&snapshot, folder_id)
        .map(|folder| DocumentTemplateDestination {
          folder_id: folder.folder_id,
          path: folder.path,
        })
        .ok_or(DocumentTemplateError::DestinationNotFound),
      DocumentTemplateFolderSelector::Path(path) => resolve_organizer_folder_path(&snapshot, path)
        .map(|folder| DocumentTemplateDestination {
          folder_id: folder.folder_id,
          path: folder.path,
        })
        .map_err(|error| match error {
          OrganizerFolderResolutionError::NotFound => DocumentTemplateError::DestinationNotFound,
          OrganizerFolderResolutionError::Ambiguous { .. } => DocumentTemplateError::DestinationAmbiguous,
        }),
    }
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
      .links
      .create(
        actor_id,
        workspace_id,
        CreateOrganizerLink {
          id: entry_id.to_string(),
          parent_id: destination.folder_id.clone(),
          link_type: OrganizerLinkType::Doc,
          target_id: external_id.to_string(),
          target_workspace_id: None,
          index: None,
        },
      )
      .await
      .map(|_| ())
      .map_err(DocumentTemplateError::Placement)
  }

  async fn delete_entry(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    entry_id: &str,
  ) -> Result<(), DocumentTemplateError> {
    match self.links.delete(actor_id, workspace_id, entry_id).await {
      Ok(()) | Err(WorkspaceContentLinkError::Organizer(OrganizerError::EntryNotFound(_))) => Ok(()),
      Err(error) => Err(DocumentTemplateError::Placement(error)),
    }
  }
}

#[derive(Debug, Error)]
pub enum DocumentTemplateError {
  #[error("document template permission denied")]
  Forbidden,
  #[error("document template not found")]
  NotFound,
  #[error("document template pagination is invalid")]
  InvalidPagination,
  #[error("document template key is invalid")]
  InvalidDocumentKey,
  #[error("document template persistence failed")]
  Repository(#[from] RepositoryError),
  #[error("document template content could not be loaded")]
  Content,
  #[error("document template variables are invalid")]
  InvalidVariables,
  #[error("document template contains unresolved variables")]
  UnresolvedVariables,
  #[error("document template organization context unavailable")]
  OrganizationUnavailable,
  #[error("document template owner unit context unavailable")]
  OwnerUnitUnavailable,
  #[error("document template parent context unavailable")]
  ParentUnavailable,
  #[error("document template creator unavailable")]
  CreatorUnavailable,
  #[error("document template applying account unavailable")]
  ActorUnavailable,
  #[error("document template member lookup failed")]
  MemberUnavailable,
  #[error("document template creation metadata unavailable")]
  CreationUnavailable,
  #[error("document template requested field is empty")]
  EmptyField,
  #[error("document template asset is not visible")]
  AssetNotVisible,
  #[error("document template mutation dependencies are unavailable")]
  MutationUnavailable,
  #[error("document template destination was not found")]
  DestinationNotFound,
  #[error("document template destination path is ambiguous")]
  DestinationAmbiguous,
  #[error("document template metadata mutation failed")]
  Metadata(#[from] DocumentMetadataServiceError),
  #[error("document template organizer state failed")]
  Organizer(OrganizerError),
  #[error("document template placement failed")]
  Placement(WorkspaceContentLinkError),
  #[error("document template page lifecycle failed")]
  Lifecycle,
  #[error("document template mutation failed and was compensated")]
  Compensated,
  #[error("document template mutation failed and compensation was incomplete")]
  CompensationFailed,
}

#[derive(Clone)]
pub struct DocumentTemplateService {
  repo: Arc<dyn DocumentTemplateRepository>,
  docs: Arc<DocService>,
  permission: Arc<PermissionService>,
  metadata: Option<Arc<dyn DocumentTemplateMetadata>>,
  placement: Option<Arc<dyn DocumentTemplatePlacement>>,
  assets: Option<Arc<dyn DocumentTemplateAssetVisibility>>,
  organization_context: Option<Arc<OrganizationTemplateContextService>>,
  workspace_context: Option<WorkspaceService>,
  account: Option<Arc<dyn DocumentTemplateAccount>>,
}

pub(crate) struct PreparedRegistryDocumentTemplate {
  pub source_revision_id: Uuid,
  pub source_content_digest: String,
  pub source_revision_digest: String,
  pub locale: String,
  pub title: String,
  content: PreparedDocumentTemplateContent,
}

impl DocumentTemplateService {
  pub fn new(
    repo: Arc<dyn DocumentTemplateRepository>,
    docs: Arc<DocService>,
    permission: Arc<PermissionService>,
  ) -> Self {
    Self {
      repo,
      docs,
      permission,
      metadata: None,
      placement: None,
      assets: None,
      organization_context: None,
      workspace_context: None,
      account: None,
    }
  }

  pub fn with_mutations(
    mut self,
    metadata: DocumentMetadataService,
    placement: Arc<dyn DocumentTemplatePlacement>,
  ) -> Self {
    self.metadata = Some(Arc::new(metadata));
    self.placement = Some(placement);
    self
  }

  pub fn with_mutation_ports(
    mut self,
    metadata: Arc<dyn DocumentTemplateMetadata>,
    placement: Arc<dyn DocumentTemplatePlacement>,
  ) -> Self {
    self.metadata = Some(metadata);
    self.placement = Some(placement);
    self
  }

  pub fn with_instantiation_assets(mut self, assets: Arc<dyn DocumentTemplateAssetVisibility>) -> Self {
    self.assets = Some(assets);
    self
  }

  pub fn with_organization_context(mut self, service: Option<Arc<OrganizationTemplateContextService>>) -> Self {
    self.organization_context = service;
    self
  }

  pub fn with_workspace_context(mut self, workspace: WorkspaceService) -> Self {
    self.workspace_context = Some(workspace);
    self
  }

  pub fn with_account(mut self, account: Arc<dyn DocumentTemplateAccount>) -> Self {
    self.account = Some(account);
    self
  }

  /// Resolve only requested template facts. Creation values are committed
  /// timestamps, not formatted dates: native clients retain regional rendering.
  /// This read never creates a target or changes its placement.
  #[instrument(skip_all)]
  pub async fn resolve_requested_values(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    requested: &BTreeSet<String>,
    target_external_id: Option<&str>,
    folder_id: Option<&str>,
    parent_external_id: Option<&str>,
    defer_creation: bool,
  ) -> Result<HashMap<String, DocumentTemplateVariable>, DocumentTemplateError> {
    self.assert_workspace_read(actor_id, workspace_id).await?;
    if requested.len() > MAX_TEMPLATE_VARIABLES
      || requested.iter().any(|name| {
        !optional_known_variable(name.as_str())
          && !matches!(
            name.as_str(),
            "workspace.name"
              | "workspace.members"
              | "creator.name"
              | "creator.email"
              | "actor.name"
              | "actor.email"
              | "document.created_at.date"
              | "document.created_at.time"
              | "document.created_at.datetime"
              | "organization_name"
              | "organization_unit_name"
              | "folder_name"
              | "folder.path"
              | "parent_page_title"
          )
      })
    {
      return Err(DocumentTemplateError::UnresolvedVariables);
    }
    // Deferred creation is application preflight, not an authorization bypass:
    // reject an unwritable target before the client creates or copies any leaf.
    if defer_creation {
      if let Some(target) = target_external_id {
        let key = DocumentKey::parse(target.to_owned()).map_err(|_| DocumentTemplateError::InvalidDocumentKey)?;
        let doc_id = self
          .docs
          .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &key)
          .await
          .map_err(|_| DocumentTemplateError::Content)?
          .ok_or(DocumentTemplateError::NotFound)?;
        self
          .permission
          .assert(
            &DocResource {
              user_id: actor_id,
              workspace_id,
              doc_id,
            },
            DocAction::Update,
          )
          .await
          .map_err(|_| DocumentTemplateError::Forbidden)?;
      } else {
        self
          .permission
          .assert(
            &WorkspaceResource {
              user_id: actor_id,
              workspace_id,
            },
            WorkspaceAction::CreateDoc,
          )
          .await
          .map_err(|_| DocumentTemplateError::Forbidden)?;
      }
    }
    let mut values = HashMap::new();
    for name in OPTIONAL_PROJECT_TEMPLATE_VARIABLES
      .into_iter()
      .chain(OPTIONAL_PREPARATION_TEMPLATE_VARIABLES)
    {
      if requested.contains(name) {
        values.insert(name.to_owned(), DocumentTemplateVariable::String(String::new()));
      }
    }
    let workspace = self.workspace_context.as_ref();
    if requested.contains("actor.name") || requested.contains("actor.email") {
      let actor = self
        .account
        .as_ref()
        .ok_or(DocumentTemplateError::ActorUnavailable)?
        .applying_actor(actor_id)
        .await
        .map_err(|_| DocumentTemplateError::ActorUnavailable)?
        .ok_or(DocumentTemplateError::ActorUnavailable)?;
      for name in ["actor.name", "actor.email"] {
        if requested.contains(name) {
          let text = if name == "actor.name" {
            actor.name.as_deref().ok_or(DocumentTemplateError::EmptyField)?
          } else {
            &actor.email
          };
          values.insert(
            name.into(),
            DocumentTemplateVariable::String(required_template_text(text)?),
          );
        }
      }
    }
    if requested.contains("workspace.name") {
      let name = workspace
        .ok_or(DocumentTemplateError::MutationUnavailable)?
        .get_workspace(workspace_id)
        .await
        .map_err(|_| DocumentTemplateError::Content)?
        .ok_or(DocumentTemplateError::NotFound)?
        .name;
      values.insert(
        "workspace.name".into(),
        DocumentTemplateVariable::String(required_template_text(&name)?),
      );
    }
    let needs_creator = requested.contains("creator.name") || requested.contains("creator.email");
    if needs_creator || requested.contains("workspace.members") {
      self
        .permission
        .assert(
          &WorkspaceResource {
            user_id: actor_id,
            workspace_id,
          },
          WorkspaceAction::UsersRead,
        )
        .await
        .map_err(|_| DocumentTemplateError::MemberUnavailable)?;
    }
    if requested.contains("workspace.members") {
      let workspace = workspace.ok_or(DocumentTemplateError::MemberUnavailable)?;
      let bound = workspace
        .member_count(workspace_id)
        .await
        .map_err(|_| DocumentTemplateError::MemberUnavailable)?;
      let members = template_member_records(bound, |offset, take| {
        workspace.list_members(workspace_id, offset, take, None)
      })
      .await?;
      values.insert("workspace.members".into(), DocumentTemplateVariable::Records(members));
    }
    let needs_time = requested.iter().any(|name| name.starts_with("document.created_at."));
    if !defer_creation && (needs_creator || needs_time) {
      let target = target_external_id.ok_or(DocumentTemplateError::CreationUnavailable)?;
      let metadata = self.readable_context_doc(actor_id, workspace_id, target).await?;
      for name in requested.iter().filter(|name| name.starts_with("document.created_at.")) {
        values.insert(
          name.clone(),
          DocumentTemplateVariable::String(metadata.created_at.to_rfc3339()),
        );
      }
      if needs_creator {
        let creator_id = metadata.created_by.ok_or(DocumentTemplateError::CreatorUnavailable)?;
        // A single member lookup replaces a second full traversal when repeats
        // and creator facts are requested in the same application attempt.
        let creator = workspace
          .ok_or(DocumentTemplateError::MemberUnavailable)?
          .get_member(workspace_id, creator_id)
          .await
          .map_err(|_| DocumentTemplateError::MemberUnavailable)?
          .filter(|member| member.status == myoxus_domain::entities::MembershipStatus::Accepted)
          .ok_or(DocumentTemplateError::CreatorUnavailable)?;
        for (name, value) in [
          ("creator.name", creator.user.name),
          ("creator.email", creator.user.email),
        ] {
          if requested.contains(name) {
            values.insert(
              name.into(),
              DocumentTemplateVariable::String(required_template_text(&value)?),
            );
          }
        }
      }
    }
    if requested.contains("folder_name") || requested.contains("folder.path") {
      let snapshot = OrganizerService::new(self.docs.as_ref().clone())
        .snapshot(workspace_id)
        .await
        .map_err(DocumentTemplateError::Organizer)?;
      let mut parents = Vec::new();
      if let Some(target) = target_external_id {
        let target = self.readable_context_doc(actor_id, workspace_id, target).await?;
        collect_template_parents(&snapshot.roots, workspace_id, &target.external_id, &mut parents);
        let [parent] = parents.as_slice() else {
          return Err(if parents.is_empty() {
            DocumentTemplateError::DestinationNotFound
          } else {
            DocumentTemplateError::DestinationAmbiguous
          });
        };
        if folder_id.is_some_and(|explicit| explicit != *parent) {
          return Err(DocumentTemplateError::DestinationNotFound);
        }
      } else if !defer_creation {
        return Err(DocumentTemplateError::DestinationNotFound);
      }
      let parent = parents
        .first()
        .copied()
        .or(folder_id)
        .ok_or(DocumentTemplateError::DestinationNotFound)?;
      let folder = resolve_organizer_folder_id(&snapshot, parent).ok_or(DocumentTemplateError::DestinationNotFound)?;
      let name = folder.path.last().ok_or(DocumentTemplateError::DestinationNotFound)?;
      if requested.contains("folder_name") {
        values.insert(
          "folder_name".into(),
          DocumentTemplateVariable::String(required_template_text(name)?),
        );
      }
      if requested.contains("folder.path") {
        let path = folder
          .path
          .iter()
          .map(|name| required_template_text(name))
          .collect::<Result<Vec<_>, _>>()?;
        values.insert("folder.path".into(), DocumentTemplateVariable::String(path.join("/")));
      }
    }
    if requested.contains("parent_page_title") {
      let parent = parent_external_id.ok_or(DocumentTemplateError::ParentUnavailable)?;
      let metadata = self
        .readable_context_doc(actor_id, workspace_id, parent)
        .await
        .map_err(|_| DocumentTemplateError::ParentUnavailable)?;
      if let Some(target) = target_external_id {
        let target = self.readable_context_doc(actor_id, workspace_id, target).await?;
        if metadata.id == target.id {
          return Err(DocumentTemplateError::ParentUnavailable);
        }
      }
      values.insert(
        "parent_page_title".into(),
        DocumentTemplateVariable::String(required_template_text(&metadata.title)?),
      );
    }
    let organization = requested.contains("organization_name");
    let owner_unit = requested.contains("organization_unit_name");
    if organization || owner_unit {
      let service = self.organization_context.as_ref().ok_or(if organization {
        DocumentTemplateError::OrganizationUnavailable
      } else {
        DocumentTemplateError::OwnerUnitUnavailable
      })?;
      let context = service
        .resolve(workspace_id, organization, owner_unit)
        .await
        .map_err(|_| DocumentTemplateError::Content)?;
      for (name, value, unavailable) in [
        (
          "organization_name",
          context.organization_name,
          DocumentTemplateError::OrganizationUnavailable,
        ),
        (
          "organization_unit_name",
          context.organization_unit_name,
          DocumentTemplateError::OwnerUnitUnavailable,
        ),
      ] {
        if requested.contains(name) {
          values.insert(
            name.into(),
            DocumentTemplateVariable::String(required_template_text(&value.ok_or(unavailable)?)?),
          );
        }
      }
    }
    Ok(values)
  }

  async fn readable_context_doc(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    external_id: &str,
  ) -> Result<myoxus_domain::entities::Doc, DocumentTemplateError> {
    let key = DocumentKey::parse(external_id.to_owned()).map_err(|_| DocumentTemplateError::InvalidDocumentKey)?;
    let id = self
      .docs
      .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &key)
      .await
      .map_err(|_| DocumentTemplateError::Content)?
      .ok_or(DocumentTemplateError::NotFound)?;
    self
      .permission
      .assert(
        &DocResource {
          user_id: actor_id,
          workspace_id,
          doc_id: id,
        },
        DocAction::Read,
      )
      .await
      .map_err(map_auth_error)?;
    let metadata = self
      .docs
      .get_metadata(id)
      .await
      .map_err(|_| DocumentTemplateError::Content)?
      .filter(|doc| {
        doc.workspace_id == Some(workspace_id) && !doc.is_workspace_root && !doc.blocked && doc.deleted_at.is_none()
      })
      .ok_or(DocumentTemplateError::NotFound)?;
    Ok(metadata)
  }

  /// List native template sources after one catalog admission. The repository
  /// owns the workspace, positive-template and live-document predicates.
  #[instrument(skip(self), fields(%actor_id, %workspace_id, limit, offset), err)]
  pub async fn list(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    limit: usize,
    offset: usize,
  ) -> Result<DocumentTemplatePage, DocumentTemplateError> {
    if !(1..=MAX_DOCUMENT_TEMPLATE_LIMIT).contains(&limit) || offset > i64::MAX as usize {
      return Err(DocumentTemplateError::InvalidPagination);
    }
    self
      .permission
      .assert_template_catalog_read(actor_id, workspace_id)
      .await
      .map_err(map_auth_error)?;

    let page_probe_size = limit.checked_add(1).ok_or(DocumentTemplateError::InvalidPagination)?;
    let candidates = self.repo.list_candidates(workspace_id, page_probe_size, offset).await?;
    let has_more = candidates.len() > limit;
    let mut summaries = Vec::with_capacity(candidates.len().min(limit));
    for candidate in candidates.into_iter().take(limit) {
      summaries.push(self.summarize(workspace_id, candidate).await?);
    }
    Ok(DocumentTemplatePage {
      templates: summaries,
      next_offset: has_more
        .then(|| {
          offset
            .checked_add(limit)
            .ok_or(DocumentTemplateError::InvalidPagination)
        })
        .transpose()?,
    })
  }

  #[instrument(skip(self), fields(%actor_id, %workspace_id, %doc_id), err)]
  pub async fn get(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> Result<DocumentTemplateSummary, DocumentTemplateError> {
    self
      .permission
      .assert_template_catalog_read(actor_id, workspace_id)
      .await
      .map_err(map_auth_error)?;
    self.get_source_summary(workspace_id, doc_id).await
  }

  /// Resolve a workspace-local external key only after workspace authorization,
  /// then keep the internal UUID inside the Application/persistence chain.
  #[instrument(skip(self), fields(%actor_id, %workspace_id, external_id), err)]
  pub async fn get_by_external_id(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    external_id: &str,
  ) -> Result<DocumentTemplateSummary, DocumentTemplateError> {
    // Workspace Read must precede key resolution. Otherwise different
    // not-found/forbidden paths could disclose whether an external key exists
    // in a workspace that the API-key owner cannot read.
    self
      .permission
      .assert_template_catalog_read(actor_id, workspace_id)
      .await
      .map_err(map_auth_error)?;
    let key = DocumentKey::parse(external_id.to_string()).map_err(|_| DocumentTemplateError::InvalidDocumentKey)?;
    let doc_id = self
      .docs
      .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &key)
      .await
      .map_err(|_| DocumentTemplateError::Content)?
      .ok_or(DocumentTemplateError::NotFound)?;
    self.get_source_summary(workspace_id, doc_id).await
  }

  #[instrument(skip(self, request), fields(%request.actor_id, %request.workspace_id), err)]
  pub async fn create(
    &self,
    request: CreateDocumentTemplate,
  ) -> Result<CreatedDocumentTemplate, DocumentTemplateError> {
    let metadata = self
      .metadata
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;
    let placement = self
      .placement
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;

    // Creating the page and its Organizer link are one ordinary editor action.
    // Workspace CreateDoc is the canonical capability for both; requiring an
    // Organizer administration role would deny legitimate document editors
    // without protecting any additional resource.
    self
      .assert_workspace_create(request.actor_id, request.workspace_id)
      .await?;

    let committed = self
      .docs
      .create_page_lifecycle(
        request.workspace_id,
        request.actor_id,
        Some(request.title.clone()),
        Some(request.fragment),
      )
      .await
      .map_err(|_| DocumentTemplateError::Lifecycle)?;
    let doc_id = committed.document.id;
    let external_id = committed.document.external_id.clone();
    let Some(document_revision) = committed.leaf.as_ref().map(|delta| delta.sequence) else {
      return Err(
        self
          .compensate_created_page(request.workspace_id, request.actor_id, doc_id)
          .await,
      );
    };

    if metadata
      .set_template_state(doc_id, request.actor_id, true)
      .await
      .is_err()
    {
      let metadata_clean = metadata
        .set_template_state(doc_id, request.actor_id, false)
        .await
        .is_ok();
      let page_clean = metadata_clean
        && self
          .docs
          .trash_page(request.workspace_id, doc_id, request.actor_id)
          .await
          .is_ok();
      warn!(
        workspace_id = %request.workspace_id,
        %doc_id,
        metadata_removed = metadata_clean,
        page_trashed = page_clean,
        "document template metadata failed and compensation ran"
      );
      return Err(if metadata_clean && page_clean {
        DocumentTemplateError::Compensated
      } else {
        DocumentTemplateError::CompensationFailed
      });
    }

    let entry_id = Uuid::new_v4().to_string();
    if placement
      .create_entry(
        request.actor_id,
        request.workspace_id,
        &entry_id,
        &request.destination,
        &external_id,
      )
      .await
      .is_err()
    {
      let metadata_clean = metadata
        .set_template_state(doc_id, request.actor_id, false)
        .await
        .is_ok();
      let entry_clean = placement
        .delete_entry(request.actor_id, request.workspace_id, &entry_id)
        .await
        .is_ok();
      let page_clean = metadata_clean
        && entry_clean
        && self
          .docs
          .trash_page(request.workspace_id, doc_id, request.actor_id)
          .await
          .is_ok();
      warn!(
        workspace_id = %request.workspace_id,
        %doc_id,
        metadata_removed = metadata_clean,
        entry_removed = entry_clean,
        page_trashed = page_clean,
        "document template placement failed and compensation ran"
      );
      return Err(if metadata_clean && entry_clean && page_clean {
        DocumentTemplateError::Compensated
      } else {
        DocumentTemplateError::CompensationFailed
      });
    }

    Ok(CreatedDocumentTemplate {
      doc_id,
      external_id,
      title: request.title,
      document_revision,
      root_revision: committed.workspace_root.sequence,
      folder_id: request.destination.folder_id,
      folder_path: request.destination.path,
      entry_id,
    })
  }

  /// Authorize and resolve the destination before the MCP idempotency record is
  /// opened. This keeps rejected permissions and invalid folders zero-write and
  /// also prevents a replay from bypassing current authorization.
  pub async fn preflight_create(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    selector: &DocumentTemplateFolderSelector,
  ) -> Result<DocumentTemplateDestination, DocumentTemplateError> {
    self
      .metadata
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;
    let placement = self
      .placement
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;
    self.assert_workspace_create(actor_id, workspace_id).await?;
    placement.resolve_destination(workspace_id, selector).await
  }

  /// Resolve and authorize every source dependency before MCP opens its
  /// idempotency record. The returned value contains the already-transformed
  /// native snapshot, or a captured source with only recognized creation facts
  /// pending, so the write phase cannot accidentally re-read a newer
  /// template revision than the one whose assets and variables were checked.
  #[instrument(
    skip(self, selector, final_title, variables, context_parent_external_id),
    fields(%actor_id, %workspace_id, source_external_id),
    err
  )]
  pub async fn preflight_instantiate(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    source_external_id: &str,
    selector: &DocumentTemplateFolderSelector,
    final_title: Option<&str>,
    variables: &HashMap<String, DocumentTemplateVariable>,
    context_parent_external_id: Option<&str>,
  ) -> Result<PreparedDocumentTemplateInstantiation, DocumentTemplateError> {
    self
      .metadata
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;
    let placement = self
      .placement
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;
    validate_template_variables(variables)?;
    // Reserved automatic facts cannot be supplied even when the source does
    // not request them; a caller must never impersonate server-owned context.
    if [
      "organization_name",
      "organization_unit_name",
      "parent_page_title",
      "folder_name",
      "actor.name",
      "actor.email",
      "folder.path",
      "calendar.iso_week_year",
    ]
    .iter()
    .any(|key| variables.contains_key(*key))
    {
      return Err(DocumentTemplateError::InvalidVariables);
    }

    // Catalog admission precedes key resolution. Only a native source in this
    // workspace may supply content; destination writes are checked separately.
    self
      .permission
      .assert_template_catalog_read(actor_id, workspace_id)
      .await
      .map_err(map_auth_error)?;
    let key =
      DocumentKey::parse(source_external_id.to_string()).map_err(|_| DocumentTemplateError::InvalidDocumentKey)?;
    let doc_id = self
      .docs
      .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &key)
      .await
      .map_err(|_| DocumentTemplateError::Content)?
      .ok_or(DocumentTemplateError::NotFound)?;
    self
      .repo
      .get_candidate(workspace_id, doc_id)
      .await?
      .ok_or(DocumentTemplateError::NotFound)?;

    // The destination receives a new ordinary page, so Workspace CreateDoc is
    // the narrow authority. Organizer administration would incorrectly deny
    // normal editors and does not protect any additional mutation here.
    self.assert_workspace_create(actor_id, workspace_id).await?;
    let destination = placement.resolve_destination(workspace_id, selector).await?;
    let source_snapshot = self
      .docs
      .load_full_doc(workspace_id, doc_id)
      .await
      .map_err(|_| DocumentTemplateError::Content)?;

    let content = self
      .preflight_instantiation_content(
        actor_id,
        workspace_id,
        doc_id,
        source_snapshot,
        final_title,
        variables,
        Some(&destination.folder_id),
        context_parent_external_id,
        false,
      )
      .await?;
    Ok(PreparedDocumentTemplateInstantiation {
      source_external_id: source_external_id.to_string(),
      destination,
      content,
    })
  }

  pub(crate) async fn preflight_project_placement(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    folder: &myoxus_domain::assistant_package::AssistantFolderDestination,
  ) -> Result<(), DocumentTemplateError> {
    self
      .project_destination(actor_id, workspace_id, folder)
      .await
      .map(|_| ())
  }
  async fn project_destination(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    folder: &myoxus_domain::assistant_package::AssistantFolderDestination,
  ) -> Result<(Option<String>, Vec<String>), DocumentTemplateError> {
    use myoxus_domain::assistant_package::AssistantFolderDestination;
    self.assert_workspace_read(actor_id, workspace_id).await?;
    self.assert_workspace_create(actor_id, workspace_id).await?;
    let organizer = OrganizerService::new((*self.docs).clone());
    let snapshot = organizer
      .snapshot(workspace_id)
      .await
      .map_err(DocumentTemplateError::Organizer)?;
    let destination = match folder {
      AssistantFolderDestination::Existing { id } => {
        let resolved = resolve_organizer_folder_id(&snapshot, id).ok_or(DocumentTemplateError::DestinationNotFound)?;
        (Some(resolved.folder_id), resolved.path)
      }
      AssistantFolderDestination::New { name, parent } => {
        crate::organizer::validate_project_folder_name(name).map_err(DocumentTemplateError::Organizer)?;
        let parent = parent.as_deref().or_else(|| {
          snapshot
            .roots
            .iter()
            .find(|node| node.row.is_workspace_root())
            .map(|node| node.row.id.as_str())
        });
        let mut path = match parent {
          Some(parent) => {
            resolve_organizer_folder_id(&snapshot, parent)
              .ok_or(DocumentTemplateError::DestinationNotFound)?
              .path
          }
          None => Vec::new(),
        };
        path.push(name.clone());
        (None, path)
      }
    };
    Ok(destination)
  }

  /// Authorization precedes Registry identity discovery. This readonly path
  /// captures immutable revision content without materializing a Library source.
  #[instrument(skip_all)]
  pub(crate) async fn preflight_registry_component(
    &self,
    registry: &crate::template_registry::TemplateRegistryService,
    actor_id: Uuid,
    workspace_id: Uuid,
    source: &myoxus_domain::assistant_package::AssistantDocumentComponentSource,
    delivered: &[u8],
    folder: &myoxus_domain::assistant_package::AssistantFolderDestination,
    locale: &str,
    client_version: u32,
    variables: &std::collections::BTreeMap<String, String>,
    accepted: Option<&myoxus_domain::assistant_package::AssistantPreparedDocumentComponent>,
    metadata: Option<&myoxus_domain::assistant_package::AssistantPreparedDocumentMetadata>,
    reference_targets: Option<yjs::NativeTemplateReferenceTargets>,
  ) -> Result<PreparedRegistryDocumentTemplate, DocumentTemplateError> {
    let (folder_id, path) = self.project_destination(actor_id, workspace_id, folder).await?;
    let mut variables = variables
      .iter()
      .map(|(name, value)| (name.clone(), DocumentTemplateVariable::String(value.clone())))
      .collect::<HashMap<_, _>>();
    validate_template_variables(&variables)?;
    if variables.keys().any(|name| !optional_known_variable(name.as_str())) {
      return Err(DocumentTemplateError::InvalidVariables);
    }
    // Native destination facts may refer to a reviewed new folder not yet
    // persisted. They are resolved by this owner, never accepted from answers.
    variables.insert(
      "folder_name".into(),
      DocumentTemplateVariable::String(path.last().cloned().unwrap_or_default()),
    );
    variables.insert("folder.path".into(), DocumentTemplateVariable::String(path.join("/")));
    if accepted.is_none() && format!("{:x}", sha2::Sha256::digest(delivered)) != source.digest {
      return Err(DocumentTemplateError::Content);
    }
    let captured = match (accepted, metadata) {
      (Some(document), _) => {
        registry
          .capture_accepted_document_revision(
            &document.source,
            document.source_revision_id,
            &document.source_revision_digest,
            &document.source_content_digest,
            &document.locale,
            client_version,
          )
          .await
      }
      (None, Some(document)) => {
        registry
          .capture_workspace_document_revision(document, delivered, client_version)
          .await
      }
      (None, None) => {
        registry
          .capture_delivered_document_revision(&source.template_id, &source.version, delivered, locale, client_version)
          .await
      }
    }
    .map_err(|error| match error {
      AuthError::Storage(message) => DocumentTemplateError::Repository(RepositoryError::Storage(message)),
      _ => DocumentTemplateError::NotFound,
    })?;
    if let Some(targets) = &reference_targets {
      let slots =
        yjs::inspect_native_template_references(&captured.snapshot).map_err(|_| DocumentTemplateError::Content)?;
      if !slots.iter().any(|key| key == "context.container")
        || (targets.task_id.is_some() && !slots.iter().any(|key| key == "context.task"))
      {
        return Err(DocumentTemplateError::InvalidVariables);
      }
    }
    let mut content = self
      .preflight_instantiation_content(
        actor_id,
        workspace_id,
        captured.revision_id,
        captured.snapshot,
        None,
        &variables,
        folder_id.as_deref(),
        None,
        false,
      )
      .await?;
    content.reference_targets = reference_targets;
    // Validate every creation-only capability before the Project can publish.
    // These are availability checks; the final value still uses the exact
    // timestamp/actor persisted by the later canonical lifecycle command.
    if content.pending_creation.iter().any(|name| name.starts_with("creator.")) {
      let creator = self
        .workspace_context
        .as_ref()
        .ok_or(DocumentTemplateError::CreatorUnavailable)?
        .get_member(workspace_id, actor_id)
        .await
        .map_err(|_| DocumentTemplateError::CreatorUnavailable)?
        .filter(|member| member.status == myoxus_domain::entities::MembershipStatus::Accepted)
        .ok_or(DocumentTemplateError::CreatorUnavailable)?;
      if content.pending_creation.contains("creator.name") {
        required_template_text(&creator.user.name)?;
      }
      if content.pending_creation.contains("creator.email") {
        required_template_text(&creator.user.email)?;
      }
    }
    for name in content
      .pending_creation
      .iter()
      .filter(|name| name.starts_with("document.created_at."))
    {
      regional::creation_value(
        name,
        &chrono::Utc::now().to_rfc3339(),
        content
          .regional
          .as_ref()
          .ok_or(DocumentTemplateError::CreationUnavailable)?,
      )?;
    }
    Ok(PreparedRegistryDocumentTemplate {
      source_revision_id: captured.revision_id,
      source_content_digest: captured.content_digest,
      source_revision_digest: captured.revision_digest,
      locale: captured.locale,
      title: content.title.clone(),
      content,
    })
  }

  /// Read only the exact acknowledged identity through current native Doc Read.
  pub(crate) async fn readable_project_result(
    &self,
    actor: Uuid,
    workspace: Uuid,
    result: &crate::workspace::ProjectStarterDocumentResult,
  ) -> Result<(), DocumentTemplateError> {
    self.assert_workspace_read(actor, workspace).await?;
    let document = self.readable_context_doc(actor, workspace, &result.external_id).await?;
    if document.id != result.doc_id || document.external_id != result.external_id {
      return Err(DocumentTemplateError::NotFound);
    }
    Ok(())
  }

  /// Complete native creation-only values before the one canonical leaf/root
  /// commit. The command persists this exact timestamp and creator identity.
  #[instrument(skip_all)]
  pub(crate) async fn create_accepted_component(
    &self,
    registry: &crate::template_registry::TemplateRegistryService,
    accepted: &crate::workspace::AcceptedProjectStarter,
    document: &myoxus_domain::assistant_package::AssistantPreparedDocumentComponent,
    project_installation: myoxus_domain::database::DatabaseManagedSchemaInstallation,
  ) -> Result<(), DocumentTemplateError> {
    self
      .create_accepted_document(
        registry,
        &accepted.document_receipt(),
        document,
        crate::workspace::StarterDocumentAdmission::ProjectSetup {
          installation: project_installation,
        },
        None,
      )
      .await
  }
  pub(crate) async fn create_context_component(
    &self,
    registry: &crate::template_registry::TemplateRegistryService,
    accepted: &crate::workspace::AcceptedContextDocuments,
    document: &myoxus_domain::assistant_package::AssistantPreparedDocumentComponent,
    automation_effect: Option<myoxus_domain::workspace_automation::AutomationEffectFence>,
  ) -> Result<(), DocumentTemplateError> {
    self
      .create_accepted_document(
        registry,
        &accepted.document_receipt(),
        document,
        crate::workspace::StarterDocumentAdmission::TaskContainer {
          target: accepted.plan.target.clone(),
          installation: accepted.admission.installation.clone(),
        },
        automation_effect,
      )
      .await
  }
  pub(crate) async fn workspace_setup_link_available(
    &self,
    accepted: &crate::workspace::assistant_packages::AcceptedWorkspaceSetup,
    component: &str,
  ) -> Result<bool, DocumentTemplateError> {
    self
      .assert_workspace_read(accepted.actor_id, accepted.workspace_id)
      .await?;
    let receipt = accepted.document_receipt();
    let crate::workspace::StarterDocumentOrigin::WorkspaceSetup { links } = &receipt.origin else {
      return Ok(false);
    };
    let Some(link) = links.get(component) else {
      return Ok(false);
    };
    let (kind, target) = match &link.target {
      myoxus_domain::workspace_automation::WorkspaceSetupResult::Database { database_id } => {
        ("database", database_id.to_string())
      }
      myoxus_domain::workspace_automation::WorkspaceSetupResult::Document { document_id } => {
        let Some(document) = receipt
          .progress
          .documents
          .values()
          .find(|document| document.doc_id == *document_id)
        else {
          return Ok(false);
        };
        self
          .readable_project_result(accepted.actor_id, accepted.workspace_id, document)
          .await?;
        ("doc", document.external_id.clone())
      }
      _ => return Ok(false),
    };
    let snapshot = OrganizerService::new((*self.docs).clone())
      .snapshot(accepted.workspace_id)
      .await
      .map_err(DocumentTemplateError::Organizer)?;
    fn contains(
      nodes: &[crate::organizer::OrganizerSnapshotNode],
      entry: &str,
      kind: &str,
      target: &str,
      workspace: Uuid,
    ) -> bool {
      nodes.iter().any(|node| {
        (node.row.id == entry
          && node.row.row_type == kind
          && node.row.data == target
          && node.row.effective_target_workspace_id(workspace) == workspace)
          || contains(&node.children, entry, kind, target, workspace)
      })
    }
    Ok(contains(
      &snapshot.roots,
      &link.entry_id,
      kind,
      &target,
      accepted.workspace_id,
    ))
  }
  pub(crate) async fn create_workspace_setup_component(
    &self,
    registry: &crate::template_registry::TemplateRegistryService,
    accepted: &crate::workspace::assistant_packages::AcceptedWorkspaceSetup,
    document: &myoxus_domain::assistant_package::AssistantPreparedDocumentComponent,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> Result<(), DocumentTemplateError> {
    self
      .create_accepted_document(
        registry,
        &accepted.document_receipt(),
        document,
        crate::workspace::StarterDocumentAdmission::WorkspaceSetup,
        Some(fence),
      )
      .await
  }
  pub(crate) async fn place_workspace_setup_stage(
    &self,
    accepted: &crate::workspace::assistant_packages::AcceptedWorkspaceSetup,
    stage: crate::workspace::ProjectPlacementStage,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> Result<(), DocumentTemplateError> {
    self
      .place_document_stage(
        &accepted.document_receipt(),
        crate::workspace::StarterDocumentAdmission::WorkspaceSetup,
        stage,
        Some(fence),
      )
      .await
  }
  async fn create_accepted_document(
    &self,
    registry: &crate::template_registry::TemplateRegistryService,
    accepted: &crate::workspace::StarterDocumentReceipt,
    document: &myoxus_domain::assistant_package::AssistantPreparedDocumentComponent,
    admission: crate::workspace::StarterDocumentAdmission,
    automation_effect: Option<myoxus_domain::workspace_automation::AutomationEffectFence>,
  ) -> Result<(), DocumentTemplateError> {
    let reserved = accepted
      .ids
      .iter()
      .find(|ids| ids.component_id == document.source.component_id)
      .ok_or(DocumentTemplateError::CreationUnavailable)?;
    if !accepted.progress.folder_ready {
      return Err(DocumentTemplateError::DestinationNotFound);
    }
    let folder_id = accepted
      .folder_id
      .as_ref()
      .ok_or(DocumentTemplateError::DestinationNotFound)?;
    let folder = myoxus_domain::assistant_package::AssistantFolderDestination::Existing { id: folder_id.clone() };
    let prepared = self
      .preflight_registry_component(
        registry,
        accepted.actor_id,
        accepted.workspace_id,
        &document.source,
        &[],
        &folder,
        &document.locale,
        accepted
          .client_version
          .ok_or(DocumentTemplateError::CreationUnavailable)?,
        &document.variables,
        Some(document),
        None,
        match &admission {
          crate::workspace::StarterDocumentAdmission::TaskContainer { target, .. } => {
            Some(yjs::NativeTemplateReferenceTargets {
              workspace_id: accepted.workspace_id,
              database_id: target.database_id,
              task_id: target.task_id,
            })
          }
          _ => None,
        },
      )
      .await?;
    let destination = self
      .placement
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?
      .resolve_destination(
        accepted.workspace_id,
        &DocumentTemplateFolderSelector::Id(folder_id.clone()),
      )
      .await?;
    self
      .instantiate_prepared(
        accepted.actor_id,
        accepted.workspace_id,
        PreparedDocumentTemplateInstantiation {
          source_external_id: document.source_revision_id.to_string(),
          destination,
          content: prepared.content,
        },
        Some(ReservedDocumentInstantiation {
          doc_id: reserved.doc_id,
          entry_id: reserved.entry_id.clone(),
          ack: crate::workspace::ProjectDocumentAck {
            automation_effect,
            operation: accepted.operation,
            actor_id: accepted.actor_id,
            workspace_id: accepted.workspace_id,
            request_id: accepted.request_id,
            fingerprint: accepted.fingerprint.clone(),
            component_id: document.source.component_id.clone(),
            admission,
          },
        }),
      )
      .await?;
    Ok(())
  }

  /// Resolve creation-only facts before publication, shared by reserved setup
  /// documents and native Task content. Literal Row titles are never templates.
  async fn finalize_reserved_content(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    prepared: PreparedDocumentTemplateContent,
    committed_at: chrono::DateTime<chrono::Utc>,
    literal_title: Option<&str>,
  ) -> Result<(String, Vec<u8>), DocumentTemplateError> {
    let mut content = prepared;
    let mut variables = std::mem::take(&mut content.variables);
    if content.pending_creation.iter().any(|name| name.starts_with("creator.")) {
      let creator = self
        .workspace_context
        .as_ref()
        .ok_or(DocumentTemplateError::CreatorUnavailable)?
        .get_member(workspace_id, actor_id)
        .await
        .map_err(|_| DocumentTemplateError::CreatorUnavailable)?
        .filter(|member| member.status == myoxus_domain::entities::MembershipStatus::Accepted)
        .ok_or(DocumentTemplateError::CreatorUnavailable)?;
      for (name, value) in [
        ("creator.name", creator.user.name),
        ("creator.email", creator.user.email),
      ] {
        if content.pending_creation.contains(name) {
          variables.insert(
            name.into(),
            yjs::NativeTemplateVariable::String(required_template_text(&value)?),
          );
        }
      }
    }
    for name in content
      .pending_creation
      .iter()
      .filter(|name| name.starts_with("document.created_at."))
    {
      let value = regional::creation_value(
        name,
        &committed_at.to_rfc3339(),
        content
          .regional
          .as_ref()
          .ok_or(DocumentTemplateError::CreationUnavailable)?,
      )?;
      variables.insert(name.clone(), yjs::NativeTemplateVariable::String(value));
    }
    // A fully resolved preflight snapshot already contains literal supplied
    // strings. Only the original pending capture may be expanded here.
    if !content.pending_creation.is_empty() {
      content.snapshot = Self::render_creation_snapshot(&content.snapshot, &variables, literal_title)?;
    }
    if let Some(title) = literal_title {
      let update = yjs::update_document_title(&content.snapshot, title).map_err(|_| DocumentTemplateError::Content)?;
      content.snapshot =
        yjs::merge_updates(vec![content.snapshot, update]).map_err(|_| DocumentTemplateError::Content)?;
    }
    let title = yjs::extract_structural_document_title(&content.snapshot)
      .map_err(|_| DocumentTemplateError::Content)?
      .filter(|title| !title.trim().is_empty() && title.chars().count() <= 1024)
      .ok_or(DocumentTemplateError::InvalidVariables)?;
    content.snapshot = yjs::bind_native_template_references(&content.snapshot, content.reference_targets.as_ref())
      .map_err(|_| DocumentTemplateError::InvalidVariables)?;
    Ok((title, content.snapshot))
  }

  async fn publish_reserved_instantiation(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    prepared: PreparedDocumentTemplateContent,
    reserved: ReservedDocumentInstantiation,
  ) -> Result<(Uuid, String, i64, i64), DocumentTemplateError> {
    let committed_at = chrono::Utc::now();
    let (title, snapshot) = self
      .finalize_reserved_content(actor_id, workspace_id, prepared, committed_at, None)
      .await?;
    let committed = self
      .docs
      .create_project_page_from_snapshot(
        workspace_id,
        actor_id,
        reserved.doc_id,
        title,
        snapshot,
        committed_at,
        reserved.ack,
      )
      .await
      .map_err(|error| match error {
        AuthError::Storage(message) => DocumentTemplateError::Repository(RepositoryError::Storage(message)),
        _ => DocumentTemplateError::Lifecycle,
      })?;
    let leaf = committed.leaf.as_ref().ok_or(DocumentTemplateError::Lifecycle)?;
    Ok((
      committed.document.id,
      committed.document.external_id,
      leaf.sequence,
      committed.workspace_root.sequence,
    ))
  }

  #[instrument(skip_all)]
  pub(crate) async fn place_accepted_project(
    &self,
    accepted: &crate::workspace::AcceptedProjectStarter,
    project_installation: myoxus_domain::database::DatabaseManagedSchemaInstallation,
    stage: crate::workspace::ProjectPlacementStage,
  ) -> Result<(), DocumentTemplateError> {
    self
      .place_document_stage(
        &accepted.document_receipt(),
        crate::workspace::StarterDocumentAdmission::ProjectSetup {
          installation: project_installation,
        },
        stage,
        None,
      )
      .await
  }
  pub(crate) async fn place_context_documents(
    &self,
    accepted: &crate::workspace::AcceptedContextDocuments,
    stage: crate::workspace::ProjectPlacementStage,
    automation_effect: Option<myoxus_domain::workspace_automation::AutomationEffectFence>,
  ) -> Result<(), DocumentTemplateError> {
    self
      .place_document_stage(
        &accepted.document_receipt(),
        crate::workspace::StarterDocumentAdmission::TaskContainer {
          target: accepted.plan.target.clone(),
          installation: accepted.admission.installation.clone(),
        },
        stage,
        automation_effect,
      )
      .await
  }
  async fn place_document_stage(
    &self,
    accepted: &crate::workspace::StarterDocumentReceipt,
    admission: crate::workspace::StarterDocumentAdmission,
    stage: crate::workspace::ProjectPlacementStage,
    automation_effect: Option<myoxus_domain::workspace_automation::AutomationEffectFence>,
  ) -> Result<(), DocumentTemplateError> {
    self
      .assert_workspace_read(accepted.actor_id, accepted.workspace_id)
      .await?;
    self
      .assert_workspace_create(accepted.actor_id, accepted.workspace_id)
      .await?;
    for document in accepted.progress.documents.values() {
      self
        .readable_project_result(accepted.actor_id, accepted.workspace_id, document)
        .await?;
    }
    let organizer = OrganizerService::new((*self.docs).clone());
    let projection = organizer
      .document_starter_placement(accepted, &stage)
      .await
      .map_err(DocumentTemplateError::Organizer)?;
    let organizer_revision = projection.revision.clone();
    self
      .docs
      .commit_project_placement(
        projection,
        crate::workspace::ProjectPlacementAck {
          automation_effect,
          operation: accepted.operation,
          stage,
          actor_id: accepted.actor_id,
          workspace_id: accepted.workspace_id,
          request_id: accepted.request_id,
          fingerprint: accepted.fingerprint.clone(),
          organizer_revision,
          admission,
        },
      )
      .await
      .map_err(|error| match error {
        AuthError::Storage(message) => DocumentTemplateError::Repository(RepositoryError::Storage(message)),
        _ => DocumentTemplateError::Lifecycle,
      })?;
    Ok(())
  }

  async fn assert_template_assets(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    source_snapshot: &[u8],
  ) -> Result<(), DocumentTemplateError> {
    let assets = self.assets.as_ref().ok_or(DocumentTemplateError::MutationUnavailable)?;
    let referenced_assets =
      yjs::extract_portable_asset_references(source_snapshot).map_err(|_| DocumentTemplateError::Content)?;
    if !referenced_assets.is_empty() {
      // Instantiation only retains references to existing workspace blobs; it
      // neither uploads nor mutates blob bytes. BlobsRead is therefore correct,
      // while BlobsWrite would be an unjustified privilege escalation.
      self
        .permission
        .assert(
          &WorkspaceResource {
            user_id: actor_id,
            workspace_id,
          },
          WorkspaceAction::BlobsRead,
        )
        .await
        .map_err(map_auth_error)?;
      let mut checked = BTreeSet::new();
      for reference in referenced_assets {
        if checked.insert(reference.source_key.clone()) {
          assets
            .assert_completed_asset(workspace_id, &reference.source_key)
            .await?;
        }
      }
    }

    Ok(())
  }

  /// Both local Library and pinned Registry sources enter the same native
  /// asset, variable, destination-context and complete-snapshot preflight.
  async fn preflight_instantiation_content(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    source_id: Uuid,
    snapshot: Vec<u8>,
    title: Option<&str>,
    variables: &HashMap<String, DocumentTemplateVariable>,
    folder_id: Option<&str>,
    parent: Option<&str>,
    body_only: bool,
  ) -> Result<PreparedDocumentTemplateContent, DocumentTemplateError> {
    self
      .metadata
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;
    self
      .placement
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;
    self.assert_template_assets(actor_id, workspace_id, &snapshot).await?;
    self
      .prepare_native_content(
        actor_id,
        workspace_id,
        source_id,
        snapshot,
        title,
        variables,
        folder_id,
        parent,
        body_only,
      )
      .await
  }

  /// Shared native preparation. Row bodies exclude the authored page title;
  /// their literal title belongs to the Database Row, not template expansion.
  #[instrument(skip_all)]
  async fn prepare_native_content(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    source_snapshot: Vec<u8>,
    final_title: Option<&str>,
    variables: &HashMap<String, DocumentTemplateVariable>,
    folder_id: Option<&str>,
    context_parent_external_id: Option<&str>,
    body_only: bool,
  ) -> Result<PreparedDocumentTemplateContent, DocumentTemplateError> {
    validate_template_variables(variables)?;
    let explicit_title = final_title
      .map(str::trim)
      .map(|title| {
        if title.is_empty() || title.chars().count() > 1024 {
          Err(DocumentTemplateError::InvalidVariables)
        } else {
          Ok(title.to_string())
        }
      })
      .transpose()?;
    let variable_source = if let Some(title) = explicit_title.as_deref() {
      let title_delta =
        yjs::update_document_title(&source_snapshot, title).map_err(|_| DocumentTemplateError::Content)?;
      yjs::merge_updates(vec![source_snapshot, title_delta]).map_err(|_| DocumentTemplateError::Content)?
    } else {
      source_snapshot
    };
    let mut native_variables = variables
      .iter()
      .map(|(key, value)| {
        let value = match value {
          DocumentTemplateVariable::String(value) => {
            yjs::NativeTemplateVariable::String(if key.starts_with("input.") {
              value.trim().to_string()
            } else {
              value.clone()
            })
          }
          DocumentTemplateVariable::StringList(values) => yjs::NativeTemplateVariable::StringList(values.clone()),
          DocumentTemplateVariable::Records(values) => yjs::NativeTemplateVariable::Records(values.clone()),
        };
        (key.clone(), value)
      })
      .collect::<HashMap<_, _>>();
    // Use the native owner's exact title/body/table token traversal. This is
    // an in-memory scan; no source or target is persisted during preflight.
    let requested = yjs::inspect_native_template(&variable_source)
      .map_err(|_| DocumentTemplateError::InvalidVariables)?
      .required_variables;
    // Idempotency describes authored input and stable identities, not text
    // resolved at this attempt. Context renames must not become a new request.
    let authored_title = yjs::extract_structural_document_title(&variable_source)
      .map_err(|_| DocumentTemplateError::Content)?
      .unwrap_or_default();
    if !body_only && authored_title.is_empty() {
      return Err(DocumentTemplateError::InvalidVariables);
    }
    // Legacy explicit values are caller-authored. Only omitted names request
    // authoritative facts; supplied member records are never reinterpreted.
    let automatic = requested
      .iter()
      .filter(|name| !variables.contains_key(*name))
      .cloned()
      .collect::<BTreeSet<_>>();
    let application_instant = chrono::Utc::now();
    let regional = if automatic
      .iter()
      .any(|name| regional::is_date_value(name) || name.starts_with("document.created_at."))
    {
      Some(
        self
          .account
          .as_ref()
          .ok_or(DocumentTemplateError::CreationUnavailable)?
          .effective_preferences(actor_id)
          .await
          .map_err(|_| DocumentTemplateError::CreationUnavailable)?,
      )
    } else {
      None
    };
    let server_facts = automatic
      .iter()
      .filter(|name| !regional::is_date_value(name))
      .cloned()
      .collect::<BTreeSet<_>>();
    let facts = self
      .resolve_requested_values(
        actor_id,
        workspace_id,
        &server_facts,
        None,
        folder_id,
        context_parent_external_id,
        true,
      )
      .await?;
    extend_native_variables(&mut native_variables, facts);
    if let Some(preferences) = &regional {
      for name in automatic.iter().filter(|name| regional::is_date_value(name)) {
        native_variables.insert(
          name.clone(),
          yjs::NativeTemplateVariable::String(regional::application_value(name, application_instant, preferences)?),
        );
      }
    }
    let context_parent_id = if automatic.contains("parent_page_title") {
      let parent = self
        .readable_context_doc(
          actor_id,
          workspace_id,
          context_parent_external_id.ok_or(DocumentTemplateError::ParentUnavailable)?,
        )
        .await
        .map_err(|_| DocumentTemplateError::ParentUnavailable)?;
      if parent.id == doc_id {
        return Err(DocumentTemplateError::ParentUnavailable);
      }
      Some(parent.id)
    } else {
      None
    };
    let allowed_pending = automatic
      .iter()
      .filter(|name| is_creation_value(name))
      .cloned()
      .collect::<BTreeSet<_>>();
    let instantiated = yjs::instantiate_native_template(&variable_source, &native_variables)
      .map_err(|_| DocumentTemplateError::InvalidVariables)?;
    let pending_creation = instantiated
      .unresolved_variables
      .iter()
      .cloned()
      .collect::<BTreeSet<_>>();
    if !pending_creation.is_subset(&allowed_pending) {
      return Err(DocumentTemplateError::UnresolvedVariables);
    }
    let (validated_snapshot, _) = self
      .docs
      .write
      .validate_snapshot_ingress(instantiated.snapshot)
      .await
      .map_err(|_| DocumentTemplateError::InvalidVariables)?;
    // Explicit titles were installed before substitution; take the resolved
    // native title rather than reintroducing the caller's unresolved tokens.
    // When creation facts are pending, keep the original capture. Re-expanding
    // a partial result would evaluate inserted literal braces and generate
    // competing repeat copies. Transform exactly once after the leaf commits.
    let snapshot = if pending_creation.is_empty() {
      validated_snapshot
    } else {
      variable_source
    };
    let title = {
      yjs::extract_structural_document_title(&snapshot)
        .map_err(|_| DocumentTemplateError::Content)?
        .unwrap_or_default()
    };

    if (!body_only && title.trim().is_empty()) || title.chars().count() > 1024 {
      return Err(DocumentTemplateError::InvalidVariables);
    }
    Ok(PreparedDocumentTemplateContent {
      reference_targets: None,
      authored_title,
      context_parent_id,
      title,
      snapshot,
      pending_creation,
      variables: native_variables,
      regional,
    })
  }

  /// Read-only native body inspection; Database owns binding and source ACL checks.
  pub(crate) fn row_body_inputs(snapshot: &[u8]) -> Result<Vec<String>, DocumentTemplateError> {
    let body = template_body_without_title(snapshot)?;
    let inspection =
      yjs::instantiate_native_template(&body, &HashMap::new()).map_err(|_| DocumentTemplateError::InvalidVariables)?;
    Ok(
      inspection
        .unresolved_variables
        .into_iter()
        .filter(|name| name.starts_with("input."))
        .collect(),
    )
  }

  #[instrument(skip_all)]
  pub(crate) async fn prepare_row_body(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    source_doc_id: Uuid,
    snapshot: Vec<u8>,
    inputs: &std::collections::BTreeMap<String, String>,
  ) -> Result<PreparedDocumentTemplateContent, DocumentTemplateError> {
    if inputs.keys().any(|key| !key.starts_with("input.")) {
      return Err(DocumentTemplateError::InvalidVariables);
    }
    let variables = inputs
      .iter()
      .map(|(key, value)| (key.clone(), DocumentTemplateVariable::String(value.clone())))
      .collect();
    self.assert_workspace_create(actor_id, workspace_id).await?;
    self.assert_template_assets(actor_id, workspace_id, &snapshot).await?;
    self
      .prepare_native_content(
        actor_id,
        workspace_id,
        source_doc_id,
        template_body_without_title(&snapshot)?,
        None,
        &variables,
        None,
        None,
        true,
      )
      .await
  }

  /// Capture the admitted component and validate its declared literal inputs without
  /// creating content or inventing an Organizer destination for a Row body.
  #[instrument(skip_all)]
  pub(crate) async fn prepare_automation_row_body_source(
    &self,
    registry: &crate::template_registry::TemplateRegistryService,
    actor: Uuid,
    workspace: Uuid,
    source: &myoxus_domain::assistant_package::AssistantDocumentComponentSource,
    delivered: &[u8],
    locale: &str,
    client_version: u32,
    variables: &std::collections::BTreeMap<String, String>,
  ) -> Result<myoxus_domain::workspace_automation::AutomationDocumentSourceSetup, DocumentTemplateError> {
    if format!("{:x}", sha2::Sha256::digest(delivered)) != source.digest {
      return Err(DocumentTemplateError::Content);
    }
    let captured = registry
      .capture_delivered_document_revision(&source.template_id, &source.version, delivered, locale, client_version)
      .await
      .map_err(|error| match error {
        AuthError::Storage(message) => DocumentTemplateError::Repository(RepositoryError::Storage(message)),
        _ => DocumentTemplateError::NotFound,
      })?;
    let title = yjs::extract_structural_document_title(&captured.snapshot)
      .map_err(|_| DocumentTemplateError::Content)?
      .filter(|title| !title.trim().is_empty() && title.chars().count() <= 1024)
      .ok_or(DocumentTemplateError::InvalidVariables)?;
    let content = self
      .prepare_row_body(actor, workspace, captured.revision_id, captured.snapshot, variables)
      .await?;
    self
      .finalize_reserved_content(actor, workspace, content, chrono::Utc::now(), Some(&title))
      .await?;
    Ok(myoxus_domain::workspace_automation::AutomationDocumentSourceSetup {
      source: source.clone(),
      source_revision_id: captured.revision_id,
      source_revision_digest: captured.revision_digest,
      source_content_digest: captured.content_digest,
      locale: captured.locale,
      title,
      variables: variables.clone(),
    })
  }

  /// One native create/associate/ACK transaction publishes this accepted source.
  /// Replays never replace existing Row content or create a second document.
  #[instrument(skip_all)]
  pub(crate) async fn create_automation_row_body(
    &self,
    registry: &crate::template_registry::TemplateRegistryService,
    actor: Uuid,
    workspace: Uuid,
    setup: &myoxus_domain::workspace_automation::AutomationDocumentSourceSetup,
    target: crate::doc::AutomationRowContentTarget,
    title: String,
    reserved: Uuid,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
    client_version: u32,
  ) -> Result<myoxus_domain::entities::Doc, DocumentTemplateError> {
    let captured = registry
      .capture_accepted_document_revision(
        &setup.source,
        setup.source_revision_id,
        &setup.source_revision_digest,
        &setup.source_content_digest,
        &setup.locale,
        client_version,
      )
      .await
      .map_err(|error| match error {
        AuthError::Storage(message) => DocumentTemplateError::Repository(RepositoryError::Storage(message)),
        _ => DocumentTemplateError::NotFound,
      })?;
    let mut content = self
      .prepare_row_body(
        actor,
        workspace,
        captured.revision_id,
        captured.snapshot,
        &setup.variables,
      )
      .await?;
    content.reference_targets = Some(yjs::NativeTemplateReferenceTargets {
      workspace_id: workspace,
      database_id: target.database_id,
      task_id: Some(target.row_id),
    });
    let committed_at = chrono::Utc::now();
    let (title, initial_leaf_update) = self
      .finalize_reserved_content(actor, workspace, content, committed_at, Some(&title))
      .await?;
    self
      .docs
      .create_automation_page(
        workspace,
        actor,
        reserved,
        title,
        Some(crate::doc::AutomationPageContent {
          initial_leaf_update,
          committed_at,
          target,
        }),
        fence,
      )
      .await
      .map_err(|error| match error {
        AuthError::Storage(message) => DocumentTemplateError::Repository(RepositoryError::Storage(message)),
        _ => DocumentTemplateError::Lifecycle,
      })
  }

  /// Complete late facts against the real newly created Row page. The caller
  /// retains Row attachment/compensation; no Organizer placement is invented.
  #[instrument(skip_all)]
  pub(crate) async fn create_row_body(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    title: String,
    content: PreparedDocumentTemplateContent,
  ) -> Result<myoxus_domain::entities::Doc, DocumentTemplateError> {
    self.assert_workspace_create(actor_id, workspace_id).await?;
    let (doc, updates) = self
      .docs
      .create_page_from_snapshot_with_sync_updates(workspace_id, actor_id, Some(title.clone()), content.snapshot)
      .await
      .map_err(|_| DocumentTemplateError::Lifecycle)?;
    if !content.pending_creation.is_empty() {
      if self
        .finish_creation_values(
          actor_id,
          workspace_id,
          doc.id,
          &doc.external_id,
          &updates.document,
          &content.pending_creation,
          content.variables,
          content.regional.as_ref(),
          Some(&title),
        )
        .await
        .is_err()
      {
        return Err(self.compensate_created_page(workspace_id, actor_id, doc.id).await);
      }
    }
    Ok(doc)
  }

  #[instrument(skip(self, prepared), fields(%actor_id, %workspace_id), err)]
  pub async fn instantiate(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    prepared: PreparedDocumentTemplateInstantiation,
  ) -> Result<InstantiatedDocumentTemplate, DocumentTemplateError> {
    self
      .permission
      .assert_template_catalog_read(actor_id, workspace_id)
      .await
      .map_err(map_auth_error)?;
    self.instantiate_prepared(actor_id, workspace_id, prepared, None).await
  }

  async fn instantiate_prepared(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    mut prepared: PreparedDocumentTemplateInstantiation,
    reserved: Option<ReservedDocumentInstantiation>,
  ) -> Result<InstantiatedDocumentTemplate, DocumentTemplateError> {
    if reserved.is_none() {
      prepared.content.snapshot = yjs::bind_native_template_references(&prepared.content.snapshot, None)
        .map_err(|_| DocumentTemplateError::InvalidVariables)?;
    }
    let metadata = self
      .metadata
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;
    let placement = self
      .placement
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;
    // Prepared values are non-constructible outside this owner, but authority
    // is still re-evaluated at the write edge so a revoked CreateDoc grant
    // cannot be raced between preflight/idempotency and page publication.
    self.assert_workspace_create(actor_id, workspace_id).await?;
    let reserved_entry = reserved.as_ref().map(|reserved| reserved.entry_id.clone());
    let (doc_id, external_id, document_revision, root_revision) = if let Some(reserved) = reserved {
      self
        .publish_reserved_instantiation(actor_id, workspace_id, prepared.content, reserved)
        .await?
    } else {
      let committed = self
        .docs
        .create_page_from_snapshot_with_sync_updates(
          workspace_id,
          actor_id,
          Some(prepared.content.title),
          prepared.content.snapshot,
        )
        .await
        .map_err(|_| DocumentTemplateError::Lifecycle)?;
      let doc_id = committed.0.id;
      let external_id = committed.0.external_id.clone();
      let (document_revision, root_revision) = if prepared.content.pending_creation.is_empty() {
        (committed.1.document_sequence, committed.1.workspace_root_sequence)
      } else {
        let result = self
          .finish_creation_values(
            actor_id,
            workspace_id,
            doc_id,
            &external_id,
            &committed.1.document,
            &prepared.content.pending_creation,
            prepared.content.variables,
            prepared.content.regional.as_ref(),
            None,
          )
          .await;
        match result {
          Ok(revisions) => revisions,
          Err(error) => {
            return Err(
              self
                .compensate_instantiation(
                  actor_id,
                  workspace_id,
                  doc_id,
                  None,
                  metadata.as_ref(),
                  placement.as_ref(),
                  error,
                )
                .await,
            );
          }
        }
      };

      (doc_id, external_id, document_revision, root_revision)
    };

    // Reserved creation has already cleared canonical attribution in its
    // leaf/root transaction. Its ordinary entry is the next receipt frontier.
    let entry_id = if let Some(entry_id) = reserved_entry {
      entry_id
    } else {
      // A clone is deliberately an ordinary document. Clearing the SQL template
      // attribution through its canonical metadata owner makes that invariant
      // explicit without copying source Tags or introducing clone-only metadata.
      if let Err(error) = metadata.set_template_state(doc_id, actor_id, false).await {
        return Err(
          self
            .compensate_instantiation(
              actor_id,
              workspace_id,
              doc_id,
              None,
              metadata.as_ref(),
              placement.as_ref(),
              error,
            )
            .await,
        );
      }
      let entry_id = Uuid::new_v4().to_string();
      if let Err(error) = placement
        .create_entry(actor_id, workspace_id, &entry_id, &prepared.destination, &external_id)
        .await
      {
        return Err(
          self
            .compensate_instantiation(
              actor_id,
              workspace_id,
              doc_id,
              Some(&entry_id),
              metadata.as_ref(),
              placement.as_ref(),
              error,
            )
            .await,
        );
      }
      entry_id
    };
    Ok(InstantiatedDocumentTemplate {
      doc_id,
      external_id,
      document_revision,
      root_revision,
      folder_id: prepared.destination.folder_id,
      folder_path: prepared.destination.path,
      entry_id,
    })
  }

  /// Render the original pending capture once. Both ordinary and reserved
  /// instantiation preserve supplied strings as literals and share title checks.
  fn render_creation_snapshot(
    snapshot: &[u8],
    variables: &HashMap<String, yjs::NativeTemplateVariable>,
    literal_title: Option<&str>,
  ) -> Result<Vec<u8>, DocumentTemplateError> {
    let instantiated =
      yjs::instantiate_native_template(snapshot, variables).map_err(|_| DocumentTemplateError::InvalidVariables)?;
    if !instantiated.unresolved_variables.is_empty() {
      return Err(DocumentTemplateError::UnresolvedVariables);
    }
    let completed_snapshot = if let Some(title) = literal_title {
      let title_update =
        yjs::update_document_title(&instantiated.snapshot, title).map_err(|_| DocumentTemplateError::Content)?;
      yjs::merge_updates(vec![instantiated.snapshot, title_update]).map_err(|_| DocumentTemplateError::Content)?
    } else {
      instantiated.snapshot
    };
    yjs::extract_structural_document_title(&completed_snapshot)
      .map_err(|_| DocumentTemplateError::Content)?
      .filter(|title| !title.trim().is_empty() && title.chars().count() <= 1024)
      .ok_or(DocumentTemplateError::InvalidVariables)?;
    Ok(completed_snapshot)
  }

  #[instrument(skip_all)]
  async fn finish_creation_values(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    external_id: &str,
    captured_leaf: &[u8],
    requested: &BTreeSet<String>,
    mut variables: HashMap<String, yjs::NativeTemplateVariable>,
    preferences: Option<&EffectiveUserPreferences>,
    literal_title: Option<&str>,
  ) -> Result<(i64, i64), DocumentTemplateError> {
    let mut facts = self
      .resolve_requested_values(actor_id, workspace_id, requested, Some(external_id), None, None, false)
      .await?;
    for (name, value) in &mut facts {
      if name.starts_with("document.created_at.") {
        let DocumentTemplateVariable::String(value) = value else {
          return Err(DocumentTemplateError::CreationUnavailable);
        };
        *value = regional::creation_value(
          name,
          value,
          preferences.ok_or(DocumentTemplateError::CreationUnavailable)?,
        )?;
      }
    }
    extend_native_variables(&mut variables, facts);
    let body_source = literal_title
      .map(|_| template_body_without_title(captured_leaf))
      .transpose()?;
    let completed_snapshot = Self::render_creation_snapshot(
      body_source.as_deref().unwrap_or(captured_leaf),
      &variables,
      literal_title,
    )?;
    let revision = canonical_yjs_revision(captured_leaf).map_err(|_| DocumentTemplateError::Content)?;
    // Late values can grow the capture. Reuse the normal bounded ingress
    // validator before the trusted checked append; it is not an ingress bypass.
    let (snapshot, _) = self
      .docs
      .write
      .validate_snapshot_ingress(completed_snapshot)
      .await
      .map_err(|_| DocumentTemplateError::InvalidVariables)?;
    // The captured creation leaf is the only valid expansion input. A concurrent
    // edit must fail/compensate, never be replaced by a late captured-source write.
    let outcome = self
      .docs
      .push_revision_checked_update(workspace_id, doc_id, &revision, snapshot)
      .await
      .map_err(|_| DocumentTemplateError::Lifecycle)?;
    let DocRevisionCheckedUpdateOutcome::Appended { sequence } = outcome else {
      return Err(DocumentTemplateError::Lifecycle);
    };
    // The checked append also owns SQL/root title projection and broadcast.
    let root = self
      .docs
      .store()
      .page_projection_root_sequence(workspace_id)
      .await
      .map_err(|_| DocumentTemplateError::Lifecycle)?;
    Ok((sequence, root))
  }

  async fn compensate_instantiation(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    entry_id: Option<&str>,
    metadata: &dyn DocumentTemplateMetadata,
    placement: &dyn DocumentTemplatePlacement,
    _error: impl std::fmt::Display,
  ) -> DocumentTemplateError {
    let metadata_clean = metadata.set_template_state(doc_id, actor_id, false).await.is_ok();
    let entry_clean = if let Some(entry_id) = entry_id {
      placement.delete_entry(actor_id, workspace_id, entry_id).await.is_ok()
    } else {
      true
    };
    // Retain the live target when placement or metadata cleanup is uncertain.
    // Otherwise a failed compensation can publish a link to a trashed page.
    let page_clean =
      metadata_clean && entry_clean && self.docs.trash_page(workspace_id, doc_id, actor_id).await.is_ok();
    warn!(
      %workspace_id,
      %doc_id,
      metadata_removed = metadata_clean,
      entry_removed = entry_clean,
      page_trashed = page_clean,
      "document template instantiation failed and compensation ran"
    );
    if metadata_clean && entry_clean && page_clean {
      DocumentTemplateError::Compensated
    } else {
      DocumentTemplateError::CompensationFailed
    }
  }

  /// Recheck current document authority before opening or replaying a durable
  /// MCP idempotency operation.
  pub async fn preflight_template_state_change(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    external_id: &str,
  ) -> Result<(), DocumentTemplateError> {
    self
      .metadata
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;
    self
      .resolve_template_state_target(actor_id, workspace_id, external_id)
      .await
      .map(|_| ())
  }

  #[instrument(skip(self), fields(%actor_id, %workspace_id, external_id, is_template), err)]
  pub async fn set_template_state_by_external_id(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    external_id: &str,
    is_template: bool,
  ) -> Result<DocumentTemplateStateChange, DocumentTemplateError> {
    let metadata = self
      .metadata
      .as_ref()
      .ok_or(DocumentTemplateError::MutationUnavailable)?;
    // Workspace Read precedes external-key resolution to keep key existence
    // private. The mutation itself is guarded by PropertiesUpdate: changing a
    // document property neither edits its body nor creates workspace content,
    // so Update/CreateDoc would be broader and therefore incorrect.
    let doc_id = self
      .resolve_template_state_target(actor_id, workspace_id, external_id)
      .await?;
    metadata.set_template_state(doc_id, actor_id, is_template).await?;
    Ok(DocumentTemplateStateChange {
      doc_id,
      external_id: external_id.to_string(),
      is_template,
    })
  }

  async fn compensate_created_page(&self, workspace_id: Uuid, actor_id: Uuid, doc_id: Uuid) -> DocumentTemplateError {
    if self.docs.trash_page(workspace_id, doc_id, actor_id).await.is_ok() {
      DocumentTemplateError::Compensated
    } else {
      DocumentTemplateError::CompensationFailed
    }
  }

  async fn assert_workspace_create(&self, actor_id: Uuid, workspace_id: Uuid) -> Result<(), DocumentTemplateError> {
    self
      .permission
      .assert(
        &WorkspaceResource {
          user_id: actor_id,
          workspace_id,
        },
        WorkspaceAction::CreateDoc,
      )
      .await
      .map_err(map_auth_error)
  }

  async fn resolve_template_state_target(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    external_id: &str,
  ) -> Result<Uuid, DocumentTemplateError> {
    self.assert_workspace_read(actor_id, workspace_id).await?;
    let key = DocumentKey::parse(external_id.to_string()).map_err(|_| DocumentTemplateError::InvalidDocumentKey)?;
    let doc_id = self
      .docs
      .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &key)
      .await
      .map_err(|_| DocumentTemplateError::Content)?
      .ok_or(DocumentTemplateError::NotFound)?;
    self
      .permission
      .assert(
        &DocResource {
          user_id: actor_id,
          workspace_id,
          doc_id,
        },
        DocAction::PropertiesUpdate,
      )
      .await
      .map_err(map_auth_error)?;
    Ok(doc_id)
  }

  async fn get_source_summary(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> Result<DocumentTemplateSummary, DocumentTemplateError> {
    let candidate = self
      .repo
      .get_candidate(workspace_id, doc_id)
      .await?
      .ok_or(DocumentTemplateError::NotFound)?;
    self.summarize(workspace_id, candidate).await
  }

  /// Content transports use catalog admission only for a positively identified
  /// live native source. `false` leaves ordinary-document authorization intact.
  #[instrument(skip_all)]
  pub async fn authorize_source_read_if_template(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> crate::auth::AuthResult<bool> {
    if self
      .repo
      .get_candidate(workspace_id, doc_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?
      .is_none()
    {
      return Ok(false);
    }
    self
      .permission
      .assert_template_catalog_read(actor_id, workspace_id)
      .await?;
    Ok(true)
  }

  async fn assert_workspace_read(&self, actor_id: Uuid, workspace_id: Uuid) -> Result<(), DocumentTemplateError> {
    // Context and destination operations retain ordinary workspace semantics;
    // reusable-source reads use the catalog admission operation instead.
    self
      .permission
      .assert(
        &WorkspaceResource {
          user_id: actor_id,
          workspace_id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_auth_error)
  }

  async fn summarize(
    &self,
    workspace_id: Uuid,
    candidate: DocumentTemplateCandidate,
  ) -> Result<DocumentTemplateSummary, DocumentTemplateError> {
    let snapshot = self
      .docs
      .get_snapshot(workspace_id, candidate.doc_id)
      .await
      .map_err(|_| DocumentTemplateError::Content)?;
    let mut required_variables = BTreeSet::new();
    collect_required_template_variables(&candidate.title, &mut required_variables);
    if let Some(snapshot) = snapshot {
      // The native owner understands scoped fields and repeat metadata, which
      // Markdown deliberately omits. Report the actionable collection once,
      // not member fields as unrelated caller variables.
      required_variables = yjs::inspect_native_template(&snapshot)
        .map_err(|_| DocumentTemplateError::Content)?
        .required_variables
        .into_iter()
        .collect();
    }
    Ok(DocumentTemplateSummary {
      external_id: candidate.external_id,
      title: candidate.title,
      is_template: true,
      required_variables: required_variables.into_iter().collect(),
    })
  }
}

fn template_state_patch(is_template: bool) -> DocumentMetadataPatch {
  DocumentMetadataPatch {
    template_state: Some(is_template.then(|| USER_DOCUMENT_TEMPLATE_STATE.to_string())),
    ..DocumentMetadataPatch::default()
  }
}

fn map_auth_error(error: AuthError) -> DocumentTemplateError {
  match error {
    AuthError::Storage(message) => DocumentTemplateError::Repository(RepositoryError::Storage(message)),
    _ => DocumentTemplateError::Forbidden,
  }
}

/// Detect canonical `{{ variable }}` placeholders without interpreting or
/// mutating document content. Keys are intentionally small and portable so the
/// same contract can later drive native template instantiation.
pub fn detect_required_template_variables(content: &str) -> Vec<String> {
  let mut names = BTreeSet::new();
  collect_required_template_variables(content, &mut names);
  names.into_iter().collect()
}

fn collect_required_template_variables(content: &str, names: &mut BTreeSet<String>) {
  let mut remaining = content;
  while let Some(start) = remaining.find("{{") {
    remaining = &remaining[start + 2..];
    let Some(end) = remaining.find("}}") else {
      break;
    };
    let candidate = remaining[..end].trim();
    if valid_template_variable_name(candidate) {
      names.insert(candidate.to_string());
    }
    remaining = &remaining[end + 2..];
  }
}

fn valid_template_variable_name(value: &str) -> bool {
  if value.is_empty() || value.len() > MAX_TEMPLATE_VARIABLE_NAME_BYTES {
    return false;
  }
  let mut chars = value.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  (first.is_ascii_alphabetic() || first == '_')
    && chars.all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
}

fn validate_template_variables(
  variables: &HashMap<String, DocumentTemplateVariable>,
) -> Result<(), DocumentTemplateError> {
  if variables.len() > MAX_TEMPLATE_VARIABLES {
    return Err(DocumentTemplateError::InvalidVariables);
  }
  for (key, value) in variables {
    if !valid_template_variable_name(key) {
      return Err(DocumentTemplateError::InvalidVariables);
    }
    if let Some(name) = key.strip_prefix("input.") {
      let mut chars = name.chars();
      let valid_name = chars.next().is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'));
      if !valid_name
        || !matches!(value, DocumentTemplateVariable::String(text)
        if !text.trim().is_empty() && text.trim().len() <= MAX_TEMPLATE_VARIABLE_VALUE_BYTES)
      {
        return Err(DocumentTemplateError::InvalidVariables);
      }
    }
    let valid_value = match value {
      DocumentTemplateVariable::String(value) => value.len() <= MAX_TEMPLATE_VARIABLE_VALUE_BYTES,
      DocumentTemplateVariable::StringList(values) => {
        values.len() <= MAX_TEMPLATE_VARIABLE_LIST_ITEMS
          && values
            .iter()
            .all(|value| value.len() <= MAX_TEMPLATE_VARIABLE_VALUE_BYTES)
      }
      DocumentTemplateVariable::Records(values) => {
        values.len() <= MAX_TEMPLATE_VARIABLE_LIST_ITEMS
          && values.iter().all(|record| {
            record.len() <= MAX_TEMPLATE_VARIABLES
              && record.iter().all(|(field, value)| {
                field.len() <= MAX_TEMPLATE_VARIABLE_NAME_BYTES
                  && field.split('.').all(|segment| {
                    let mut chars = segment.chars();
                    chars.next().is_some_and(|first| first.is_ascii_alphabetic())
                      && chars.all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
                  })
                  && value.len() <= MAX_TEMPLATE_VARIABLE_VALUE_BYTES
              })
          })
      }
    };
    if !valid_value {
      return Err(DocumentTemplateError::InvalidVariables);
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn member(id: u128) -> myoxus_domain::entities::WorkspaceMember {
    use myoxus_domain::entities::*;
    let now = chrono::Utc::now();
    WorkspaceMember {
      workspace_id: Uuid::nil(),
      invited_by_user_id: None,
      role: WorkspaceRole::Collaborator,
      status: MembershipStatus::Accepted,
      invite_id: Uuid::from_u128(id),
      user: User {
        id: Uuid::from_u128(id),
        name: format!(" Member {id} "),
        email: format!(" member-{id}@example.test "),
        password_hash: None,
        avatar_url: None,
        avatar_key: None,
        status: AccountStatus::Active,
        is_admin: false,
        registered: true,
        disabled: false,
        email_verified_at: None,
        created_at: now,
        updated_at: now,
      },
    }
  }

  #[tokio::test]
  async fn member_traversal_freezes_bound_caps_pages_and_preserves_first_seen_order() {
    let mut calls = Vec::new();
    let mut second: Vec<_> = (99..199).map(member).collect();
    second[0].user.name = "Later duplicate".into();
    let mut pages =
      std::collections::VecDeque::from([(0..100).map(member).collect(), second, (199..202).map(member).collect()]);
    let values = template_member_records(203, |offset, take| {
      calls.push((offset, take));
      std::future::ready(Ok(pages.pop_front().expect("bounded pages")))
    })
    .await
    .expect("complete inventory");
    assert_eq!(calls, [(0, 100), (100, 100), (200, 3)]);
    assert_eq!(values.len(), 202);
    for (id, value) in values.iter().enumerate() {
      assert_eq!(
        value,
        &HashMap::from([
          ("name".into(), format!("Member {id}")),
          ("email".into(), format!("member-{id}@example.test")),
        ])
      );
    }
    assert!(
      template_member_records(0, |_, _| {
        panic!("a new empty inventory cannot reuse the prior traversal");
        #[allow(unreachable_code)]
        std::future::ready(Ok(Vec::new()))
      })
      .await
      .expect("empty bound")
      .is_empty()
    );
  }

  #[tokio::test]
  async fn member_traversal_does_not_return_partial_data_after_a_later_failure() {
    let mut calls = 0;
    let result = template_member_records(2, |_, _| {
      calls += 1;
      std::future::ready(if calls == 1 {
        Ok(vec![member(1)])
      } else {
        Err(AuthError::ActionForbidden)
      })
    })
    .await;
    assert!(matches!(result, Err(DocumentTemplateError::MemberUnavailable)));
    assert_eq!(calls, 2);
  }

  #[test]
  fn variable_wire_forms_keep_legacy_empty_arrays_and_bound_record_fields() {
    use serde_json::json;
    assert!(
      matches!(serde_json::from_value::<DocumentTemplateVariable>(json!([])).unwrap(), DocumentTemplateVariable::StringList(values) if values.is_empty())
    );
    assert!(
      matches!(serde_json::from_value::<DocumentTemplateVariable>(json!(["one"])).unwrap(), DocumentTemplateVariable::StringList(values) if values == ["one"])
    );
    assert!(
      matches!(serde_json::from_value::<DocumentTemplateVariable>(json!("one")).unwrap(), DocumentTemplateVariable::String(value) if value == "one")
    );
    assert!(serde_json::from_value::<DocumentTemplateVariable>(json!([{"name": 42}])).is_err());
    assert!(serde_json::from_value::<DocumentTemplateVariable>(json!([{"name": "one"}, "two"])).is_err());
    let valid = HashMap::from([(
      "workspace.members".into(),
      DocumentTemplateVariable::Records(vec![HashMap::from([("a".repeat(128), "x".repeat(8192))]); 500]),
    )]);
    validate_template_variables(&valid).expect("inclusive item/name/value limits");
    for field in ["_name", "1name", "name..part", "name.1part", "na mé", &"a".repeat(129)] {
      let invalid = HashMap::from([(
        "workspace.members".into(),
        DocumentTemplateVariable::Records(vec![HashMap::from([(field.into(), "x".into())])]),
      )]);
      assert!(validate_template_variables(&invalid).is_err(), "field {field}");
    }
  }

  #[test]
  fn required_variable_detection_is_sorted_deduplicated_and_bounded() {
    let oversized = "x".repeat(129);
    let content =
      format!("{{{{ project.name }}}} {{{{owner_name}}}} {{{{ project.name }}}} {{{{bad value}}}} {{{{{oversized}}}}}");
    assert_eq!(
      detect_required_template_variables(&content),
      vec!["owner_name".to_string(), "project.name".to_string()]
    );
  }
}
