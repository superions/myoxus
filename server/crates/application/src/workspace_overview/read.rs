// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{
  collections::{BTreeMap, BTreeSet},
  sync::Arc,
};

use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::{DocumentMetadataIndexRow, Workspace};
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::repositories::PageRequest;
use myoxus_domain::workspace_content_operation::{WorkspaceContentResourceKind, WorkspaceContentResourceRef};
use tracing::instrument;
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult, AuthService};
use crate::doc::DocService;
use crate::document_metadata_policy::DocumentMetadataPolicyService;
use crate::organizer::{OrganizerLinkType, OrganizerService, OrganizerSnapshot, OrganizerSnapshotNode};
use crate::permission::{AccessController, PermissionService, WorkspaceResource};
use crate::public::{PublicRepository, PublicService};
use crate::workspace::WorkspaceService;
use crate::workspace_tags::WorkspaceTagService;

use super::{
  OverviewDocument, OverviewPage, OverviewRegisterFacts, compose_workspace_overview, is_overview_document_key,
  ordinary_page,
};

/// Not a transport payload: adapters project the workspace identity and admitted
/// page fields explicitly, without serializing private settings into public data.
#[derive(Debug, Clone)]
pub struct WorkspaceOverviewRead {
  pub workspace: Workspace,
  pub page: OverviewPage,
  pub document_count: i64,
  pub register_page: PageRequest,
}

/// One admitted read capture for format adapters that materialize every page.
/// Keep its Organizer and settings together; only admitted document facts may
/// be narrowed to the adapter's successfully materialized inventory.
#[derive(Debug, Clone)]
pub struct WorkspaceOverviewSource {
  pub workspace: Workspace,
  pub organizer: OrganizerSnapshot,
  pub documents: Vec<OverviewDocument>,
}

fn register_page(request: PageRequest, count: i64) -> PageRequest {
  PageRequest {
    limit: request.limit.clamp(1, 50),
    // A lifecycle change can remove the last page between navigation and read.
    // Return the current first page rather than an obsolete empty page number.
    offset: if request.offset >= count {
      0
    } else {
      request.offset.max(0)
    },
  }
}

#[derive(Clone)]
pub struct WorkspaceOverviewService {
  workspace: WorkspaceService,
  documents: DocService,
  metadata: DocumentMetadataPolicyService,
  tags: Arc<WorkspaceTagService>,
  auth: AuthService,
}

impl WorkspaceOverviewService {
  pub fn new(
    workspace: WorkspaceService,
    documents: DocService,
    metadata: DocumentMetadataPolicyService,
    tags: Arc<WorkspaceTagService>,
    auth: AuthService,
  ) -> Self {
    Self {
      workspace,
      documents,
      metadata,
      tags,
      auth,
    }
  }

  #[instrument(skip_all, fields(%workspace_id, %user_id))]
  pub async fn read_authenticated(
    &self,
    user_id: Uuid,
    permission: &PermissionService,
    workspace_id: Uuid,
    folder_id: Option<&str>,
    page_request: PageRequest,
  ) -> AuthResult<WorkspaceOverviewRead> {
    permission
      .assert(&WorkspaceResource { user_id, workspace_id }, WorkspaceAction::Read)
      .await?;
    let (workspace, snapshot) = self.load(workspace_id).await?;
    let sources = document_sources(&snapshot);
    let mut facts = Vec::new();
    for source_id in sources {
      if source_id != workspace_id && self.workspace.get_workspace(source_id).await?.is_none() {
        continue;
      }
      facts.extend(
        read_authorized_overview_facts(
          &self.documents,
          &self.metadata,
          &self.tags,
          Some((permission, user_id)),
          source_id,
          false,
        )
        .await?,
      );
    }

    hydrate_overview_creators(self.auth.store.as_ref(), &mut facts).await?;
    permission
      .assert(&WorkspaceResource { user_id, workspace_id }, WorkspaceAction::Read)
      .await?;
    let overview = compose_workspace_overview(&snapshot, &workspace.overview_settings, facts, false)?;
    let mut page = overview.page(&snapshot, folder_id)?.clone();
    let document_count = page.documents.len() as i64;
    let register_page = register_page(page_request, document_count);
    page.documents = page
      .documents
      .into_iter()
      .skip(register_page.offset as usize)
      .take(register_page.limit as usize)
      .collect();
    hydrate_overview_register_display(&self.metadata, &self.tags, &mut page.documents).await?;
    Ok(WorkspaceOverviewRead {
      workspace,
      page,
      document_count,
      register_page,
    })
  }

  /// Git retains the caller's exact Organizer capture and its private read
  /// authority. Hydrate the complete authorized register, never Web pagination.
  pub async fn read_git_source(
    &self,
    user_id: Uuid,
    permission: &PermissionService,
    snapshot: &OrganizerSnapshot,
    emitted: &std::collections::HashSet<Uuid>,
    prepared: &[crate::git_sync::finalization::PreparedDocumentUpsert],
    deleted: &[Uuid],
  ) -> AuthResult<(WorkspaceOverviewSource, super::WorkspaceOverview)> {
    let workspace_id = snapshot.workspace_id;
    permission
      .assert(&WorkspaceResource { user_id, workspace_id }, WorkspaceAction::Read)
      .await?;
    let workspace = self
      .workspace
      .get_workspace(workspace_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("workspace".into()))?;
    let mut facts = read_authorized_overview_facts(
      &self.documents,
      &self.metadata,
      &self.tags,
      Some((permission, user_id)),
      workspace_id,
      true,
    )
    .await?;
    facts.retain(|document| !deleted.contains(&document.doc_id));
    for document in prepared {
      if document.workspace_id != workspace_id || !emitted.contains(&document.doc_id) {
        return Err(AuthError::InvalidInput(
          "prepared overview document does not match its output owner".into(),
        ));
      }
      if let Some(fact) = facts.iter_mut().find(|fact| fact.doc_id == document.doc_id) {
        fact.title = document.title.clone();
        fact.updated_at = document.observed_at;
      } else if document.expected_create {
        facts.push(OverviewDocument {
          reference: document_reference(workspace_id, &document.doc_id.to_string())?,
          doc_id: document.doc_id,
          title: document.title.clone(),
          updated_at: document.observed_at,
          public_mode: None,
          is_page: true,
          can_edit: true,
          register: Some(OverviewRegisterFacts {
            metadata: self
              .metadata
              .initial_metadata_index(workspace_id, document.doc_id, document.actor_user_id)
              .await
              .map_err(|_| AuthError::Storage("prepared document metadata could not be resolved".into()))?,
            labels: Default::default(),
            created_at: document.observed_at,
            created_by_name: None,
            tag_ids: vec![],
            tags: vec![],
            can_publish: false,
          }),
        });
      } else {
        return Err(AuthError::InvalidInput(
          "prepared overview update is no longer admitted".into(),
        ));
      }
    }
    hydrate_overview_creators(self.auth.store.as_ref(), &mut facts).await?;
    hydrate_overview_register_display(&self.metadata, &self.tags, &mut facts).await?;
    let definitions = self
      .metadata
      .field_definitions()
      .await
      .map_err(|_| AuthError::Storage("Git metadata definitions could not be loaded".into()))?;
    let mut overview =
      super::compose_git_workspace_overview(snapshot, &workspace.overview_settings, facts.clone(), &definitions)?;
    for page in std::iter::once(&mut overview.root).chain(overview.folders.iter_mut()) {
      page.documents.retain(|document| emitted.contains(&document.doc_id));
    }
    permission
      .assert(&WorkspaceResource { user_id, workspace_id }, WorkspaceAction::Read)
      .await?;
    Ok((
      WorkspaceOverviewSource {
        workspace,
        organizer: snapshot.clone(),
        documents: facts,
      },
      overview,
    ))
  }

  /// Trusted local DB operations retain native lifecycle and metadata admission,
  /// without inventing an authenticated person or granting interactive actions.
  #[instrument(skip_all, fields(workspace_id = %snapshot.workspace_id))]
  pub async fn read_trusted_git_source(
    &self,
    snapshot: &OrganizerSnapshot,
  ) -> AuthResult<(WorkspaceOverviewSource, super::WorkspaceOverview)> {
    let workspace = self
      .workspace
      .get_workspace(snapshot.workspace_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("workspace".into()))?;
    let mut facts = read_authorized_overview_facts(
      &self.documents,
      &self.metadata,
      &self.tags,
      None,
      snapshot.workspace_id,
      true,
    )
    .await?;
    hydrate_overview_creators(self.auth.store.as_ref(), &mut facts).await?;
    hydrate_overview_register_display(&self.metadata, &self.tags, &mut facts).await?;
    let definitions = self
      .metadata
      .field_definitions()
      .await
      .map_err(|_| AuthError::Storage("Git metadata definitions could not be loaded".into()))?;
    let overview =
      super::compose_git_workspace_overview(snapshot, &workspace.overview_settings, facts.clone(), &definitions)?;
    Ok((
      WorkspaceOverviewSource {
        workspace,
        organizer: snapshot.clone(),
        documents: facts,
      },
      overview,
    ))
  }

  #[instrument(skip_all, fields(%workspace_id))]
  pub async fn read_public<R: PublicRepository>(
    &self,
    public: &PublicService<R>,
    workspace_id: Uuid,
    folder_id: Option<&str>,
    page_request: PageRequest,
  ) -> AuthResult<WorkspaceOverviewRead> {
    let source = self.read_public_source(public, workspace_id).await?;
    let overview = compose_workspace_overview(
      &source.organizer,
      &source.workspace.overview_settings,
      source.documents,
      true,
    )?;
    let mut page = overview.page(&source.organizer, folder_id)?.clone();
    let document_count = page.documents.len() as i64;
    let register_page = register_page(page_request, document_count);
    page.documents = page
      .documents
      .into_iter()
      .skip(register_page.offset as usize)
      .take(register_page.limit as usize)
      .collect();
    Ok(WorkspaceOverviewRead {
      workspace: source.workspace,
      document_count,
      register_page,
      page,
    })
  }

  /// Reuse the anonymous route's access owner and one hierarchy capture for
  /// snapshot exports; callers must still guard each hydrated document body.
  #[instrument(skip_all, fields(%workspace_id))]
  pub async fn read_public_source<R: PublicRepository>(
    &self,
    public: &PublicService<R>,
    workspace_id: Uuid,
  ) -> AuthResult<WorkspaceOverviewSource> {
    if public
      .decide_workspace(workspace_id)
      .await
      .map_err(public_error)?
      .allowed()
      .is_none()
    {
      return Err(AuthError::NotFound("public workspace".into()));
    }
    let (mut workspace, snapshot) = self.load(workspace_id).await?;
    let definitions = self
      .metadata
      .field_definitions()
      .await
      .map_err(|_| AuthError::Storage("public metadata definitions could not be loaded".into()))?;
    super::public::admit_public_presentation(&mut workspace.overview_settings, &definitions);
    let mut facts = Vec::new();
    for source_id in document_sources(&snapshot) {
      if public
        .decide_workspace(source_id)
        .await
        .map_err(public_error)?
        .allowed()
        .is_none()
      {
        continue;
      }
      let metadata = metadata_index(&self.metadata, source_id).await?;
      // This live public inventory rechecks lifecycle, sharing and publication
      // after cached metadata. Normal-browse template/journal filters do not
      // narrow the established anonymous root document index. This is the
      // existing bulk publication ACL; rendering an introduction body must
      // additionally use the ordinary public-document read guard.
      let documents = public
        .list_public_workspace_docs(source_id)
        .await
        .map_err(public_error)?;
      let keys = documents
        .iter()
        .filter(|document| is_overview_document_key(&document.route_key) && document.route_key != source_id.to_string())
        .map(|document| DocumentKey::parse(document.route_key.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| AuthError::Storage("public document identity is invalid".into()))?;
      let mut assignments = self
        .tags
        .assignments_for_readable_index(source_id, &keys)
        .await
        .map_err(|_| AuthError::Storage("public document labels could not be loaded".into()))?
        .into_iter()
        .map(|entry| (entry.external_id, entry.tag_ids))
        .collect::<BTreeMap<_, _>>();
      for document in documents {
        if !is_overview_document_key(&document.route_key) || document.route_key == source_id.to_string() {
          continue;
        }
        let Some(tag_ids) = assignments.remove(&document.route_key) else {
          continue;
        };
        facts.push(OverviewDocument {
          reference: document_reference(source_id, &document.route_key)?,
          doc_id: document.doc_id,
          title: document.title,
          updated_at: document.updated_at,
          public_mode: Some(document.public_mode),
          is_page: metadata.get(&document.doc_id).is_some_and(ordinary_page),
          can_edit: false,
          register: Some(OverviewRegisterFacts {
            metadata: metadata
              .get(&document.doc_id)
              .cloned()
              .ok_or_else(|| AuthError::Storage("public document metadata is unavailable".into()))?,
            labels: Default::default(),
            created_at: document.created_at,
            created_by_name: None,
            tag_ids,
            tags: Vec::new(),
            can_publish: false,
          }),
        });
      }
    }
    if public
      .decide_workspace(workspace_id)
      .await
      .map_err(public_error)?
      .allowed()
      .is_none()
    {
      return Err(AuthError::NotFound("public workspace".into()));
    }
    hydrate_overview_register_display(&self.metadata, &self.tags, &mut facts).await?;
    Ok(WorkspaceOverviewSource {
      workspace,
      organizer: snapshot,
      documents: facts,
    })
  }

  async fn load(&self, workspace_id: Uuid) -> AuthResult<(Workspace, OrganizerSnapshot)> {
    let workspace = self
      .workspace
      .get_workspace(workspace_id)
      .await?
      .ok_or_else(|| AuthError::NotFound("workspace".into()))?;
    let snapshot = OrganizerService::new(self.documents.clone())
      .snapshot(workspace_id)
      .await
      .map_err(|_| AuthError::Storage("workspace Organizer could not be loaded".into()))?;
    Ok((workspace, snapshot))
  }
}

/// Reuse the authenticated register admission over one source workspace. Callers
/// own workspace read admission and the Organizer capture; no bodies are read.
/// Git retains its ordinary authorized export set, including template documents;
/// normal browse admission continues excluding those templates.
async fn read_authorized_overview_facts(
  documents_service: &DocService,
  metadata_service: &DocumentMetadataPolicyService,
  tags: &WorkspaceTagService,
  authority: Option<(&PermissionService, Uuid)>,
  source_id: Uuid,
  include_templates: bool,
) -> AuthResult<Vec<OverviewDocument>> {
  let mut facts = Vec::new();
  let metadata = metadata_index(metadata_service, source_id).await?;
  // Existing browse inventory excludes unmaterialized pages. Read live
  // lifecycle facts and effective roles after the actor-independent cache.
  let documents = documents_service.list_workspace_docs(source_id, i64::MAX, 0).await?;
  let ids = documents.iter().map(|document| document.id).collect::<Vec<_>>();
  let roles = match authority {
    Some((permission, user_id)) => Some(permission.effective_doc_roles(user_id, source_id, &ids).await?),
    None => None,
  };
  let readable = documents
    .into_iter()
    .filter_map(|document| {
      let row = metadata.get(&document.id)?;
      let role = match &roles {
        Some(roles) => Some(*roles.get(&document.id)?),
        None => None,
      };
      if document.workspace_id != Some(source_id)
        || document.blocked
        || document.deleted_at.is_some()
        || document.is_workspace_root
        || !is_overview_document_key(&document.external_id)
        || (row.is_template && !include_templates)
        || role.is_some_and(|role| !role.can(DocAction::Read))
      {
        return None;
      }
      Some((document, row, role))
    })
    .collect::<Vec<_>>();
  let keys = readable
    .iter()
    .map(|(document, _, _)| DocumentKey::parse(document.external_id.clone()))
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| AuthError::Storage("document index contains an invalid identity".into()))?;
  // Tag writes have an independent lifecycle. Join current assignments after
  // the bulk ACL; a missing assignment row means the document disappeared.
  let mut assignments = tags
    .assignments_for_readable_index(source_id, &keys)
    .await
    .map_err(|_| AuthError::Storage("document label index could not be loaded".into()))?
    .into_iter()
    .map(|entry| (entry.external_id, entry.tag_ids))
    .collect::<BTreeMap<_, _>>();
  for (document, metadata, role) in readable {
    let Some(tag_ids) = assignments.remove(&document.external_id) else {
      continue;
    };
    let mut metadata = metadata.clone();
    metadata.external_id = document.external_id.clone();
    metadata.created_by = metadata.created_by.or(document.created_by);
    let is_page = ordinary_page(&metadata);
    facts.push(OverviewDocument {
      reference: document_reference(source_id, &document.external_id)?,
      doc_id: document.id,
      title: document.title,
      updated_at: document.updated_at,
      public_mode: document.public_mode,
      is_page,
      can_edit: role.is_some_and(|role| role.can(DocAction::Update)),
      register: Some(OverviewRegisterFacts {
        metadata,
        created_at: document.created_at,
        created_by_name: None,
        labels: Default::default(),
        tag_ids,
        tags: Vec::new(),
        can_publish: role.is_some_and(|role| role.can(DocAction::Publish)),
      }),
    });
  }

  Ok(facts)
}

/// Attribution is display-only and grants no access to its associated documents.
pub async fn hydrate_overview_creators(
  auth: &dyn crate::auth::AuthStore,
  facts: &mut [OverviewDocument],
) -> AuthResult<()> {
  let authors = facts
    .iter()
    .filter_map(|document| document.register.as_ref()?.metadata.created_by)
    .collect::<BTreeSet<_>>()
    .into_iter()
    .collect::<Vec<_>>();
  // Reuse retained attribution profiles, including authors who left or were
  // deleted. This is one bulk display read and grants no document access.
  let profiles = auth.get_historical_profiles(&authors).await?;
  for document in facts.iter_mut() {
    if let Some(register) = &mut document.register {
      register.created_by_name = register
        .metadata
        .created_by
        .and_then(|id| profiles.get(&id))
        .and_then(|profile| {
          profile
            .name
            .clone()
            .or_else(|| (!profile.email.is_empty()).then(|| profile.email.clone()))
        });
    }
  }
  Ok(())
}

/// Display joins consume only facts admitted by the current read owner.
pub async fn hydrate_overview_register_display(
  metadata: &DocumentMetadataPolicyService,
  tag_service: &WorkspaceTagService,
  documents: &mut [OverviewDocument],
) -> AuthResult<()> {
  let rows = documents
    .iter()
    .filter_map(|document| document.register.as_ref().map(|row| row.metadata.clone()))
    .collect::<Vec<_>>();
  let mut labels = metadata
    .metadata_index_labels(&rows)
    .await
    .map_err(|_| AuthError::Storage("document metadata labels could not be resolved".into()))?;
  for document in documents.iter_mut() {
    if let Some(register) = &mut document.register {
      register.labels = labels.remove(&document.doc_id).unwrap_or_default();
    }
  }
  // Resolve the caller-admitted row set, grouped by qualified source workspace.
  // Reuse native Tag records, including archived historical assignments.
  let mut tag_ids_by_source = BTreeMap::<Uuid, BTreeSet<Uuid>>::new();
  for document in documents.iter() {
    if let Some(register) = &document.register {
      tag_ids_by_source
        .entry(document.reference.workspace_id())
        .or_default()
        .extend(register.tag_ids.iter().copied());
    }
  }
  let mut tags = BTreeMap::new();
  for (source_id, ids) in tag_ids_by_source {
    if ids.is_empty() {
      continue;
    }
    let records = tag_service
      .resolve_tags_for_index(source_id, &ids.into_iter().collect::<Vec<_>>())
      .await
      .map_err(|_| AuthError::Storage("document labels could not be resolved".into()))?;
    tags.extend(records.into_iter().map(|tag| (tag.id, tag)));
  }
  for document in documents.iter_mut() {
    if let Some(register) = &mut document.register {
      register.tags = register.tag_ids.iter().filter_map(|id| tags.get(id).cloned()).collect();
    }
  }
  Ok(())
}

async fn metadata_index(
  metadata: &DocumentMetadataPolicyService,
  workspace_id: Uuid,
) -> AuthResult<BTreeMap<Uuid, DocumentMetadataIndexRow>> {
  Ok(
    metadata
      .list_metadata_index(workspace_id)
      .await
      .map_err(|_| AuthError::Storage("document metadata index could not be loaded".into()))?
      .into_iter()
      .map(|row| (row.doc_id, row))
      .collect(),
  )
}

fn public_error(_: crate::public::PublicError) -> AuthError {
  AuthError::Storage("public workspace projection could not be loaded".into())
}

fn document_reference(workspace_id: Uuid, key: &str) -> AuthResult<WorkspaceContentResourceRef> {
  WorkspaceContentResourceRef::new(workspace_id, WorkspaceContentResourceKind::Document, key)
    .map_err(|_| AuthError::Storage("document index contains an invalid identity".into()))
}

fn document_sources(snapshot: &OrganizerSnapshot) -> BTreeSet<Uuid> {
  let mut sources = BTreeSet::from([snapshot.workspace_id]);
  visit_document_rows(&snapshot.roots, &mut |node| {
    sources.insert(node.row.effective_target_workspace_id(snapshot.workspace_id));
  });
  sources
}

fn visit_document_rows(nodes: &[OrganizerSnapshotNode], visit: &mut impl FnMut(&OrganizerSnapshotNode)) {
  for node in nodes {
    if node.row.link_type() == Ok(OrganizerLinkType::Doc) {
      visit(node);
    }
    visit_document_rows(&node.children, visit);
  }
}
