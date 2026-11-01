// SPDX-License-Identifier: AGPL-3.0-or-later
//! Operation-local overview projection. Organizer remains the only hierarchy;
//! callers supply document facts admitted by their existing access owner.

pub mod markdown;
mod public;
mod read;
mod register;
pub use public::{public_register_columns, public_register_values};
pub use read::{
  WorkspaceOverviewRead, WorkspaceOverviewService, WorkspaceOverviewSource, hydrate_overview_creators,
  hydrate_overview_register_display,
};
pub use register::OverviewRegisterFacts;
use register::sort_documents;

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use myoxus_domain::entities::DocumentMetadataIndexRow;
use myoxus_domain::workspace_content_operation::{WorkspaceContentResourceKind, WorkspaceContentResourceRef};
use myoxus_domain::workspace_overview::{OverviewRegisterPresentation, WorkspaceOverviewSettings};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use crate::organizer::{OrganizerLinkType, OrganizerSnapshot, OrganizerSnapshotNode, resolve_organizer_folder_id};

/// Organizer/user preference payloads share document storage with Pages. Reuse
/// the established content-key boundary before projecting them as page facts.
pub(crate) fn is_overview_document_key(key: &str) -> bool {
  !key.starts_with("db$") && !key.starts_with("userdata$")
}

pub(crate) fn ordinary_page(row: &DocumentMetadataIndexRow) -> bool {
  !row.is_template
    && row.primary_mode.as_deref().is_none_or(|mode| mode == "page")
    && is_overview_document_key(&row.external_id)
}

/// A live, authorized identity; no document body or copied membership is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverviewDocument {
  pub reference: WorkspaceContentResourceRef,
  pub doc_id: Uuid,
  pub title: String,
  pub updated_at: DateTime<Utc>,
  pub public_mode: Option<String>,
  pub is_page: bool,
  pub can_edit: bool,
  /// Absent when this access context has not admitted register metadata.
  pub register: Option<OverviewRegisterFacts>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverviewFolder {
  pub id: String,
  pub name: String,
}

#[derive(Debug, Clone)]
pub struct OverviewPage {
  pub folder: Option<OverviewFolder>,
  /// Real ancestors including this folder; the workspace itself is separate.
  pub breadcrumbs: Vec<OverviewFolder>,
  pub children: Vec<OverviewFolder>,
  pub introduction: Option<OverviewDocument>,
  /// Internal configuration feedback only; public projections always use false.
  pub introduction_unavailable: bool,
  pub documents: Vec<OverviewDocument>,
  pub register_presentation: Option<OverviewRegisterPresentation>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceOverview {
  pub workspace_id: Uuid,
  pub root: OverviewPage,
  pub folders: Vec<OverviewPage>,
}

impl WorkspaceOverview {
  /// Resolve Extract's retained root through the canonical Organizer resolver,
  /// then require membership in the admitted projection for public selectors.
  pub fn page(&self, snapshot: &OrganizerSnapshot, folder_id: Option<&str>) -> AuthResult<&OverviewPage> {
    if snapshot.workspace_id != self.workspace_id {
      return Err(AuthError::InvalidInput("overview workspace mismatch".into()));
    }
    let Some(id) = folder_id else {
      return Ok(&self.root);
    };
    let resolved =
      resolve_organizer_folder_id(snapshot, id).ok_or_else(|| AuthError::NotFound("overview folder".into()))?;
    if resolved.path.is_empty() {
      return Ok(&self.root);
    }
    self
      .folders
      .iter()
      .find(|page| {
        page
          .folder
          .as_ref()
          .is_some_and(|folder| folder.id == resolved.folder_id)
      })
      .ok_or_else(|| AuthError::NotFound("overview folder".into()))
  }
}

/// Compose once from an existing operation snapshot and authorized inventory.
/// Public prunes empty/private branches; authenticated and Git callers retain
/// real empty folders. Root selection affects navigation, never the root index.
/// Public settings/facts must first be admitted by `read_public_source`, including
/// metadata export visibility; the composer never invents a permission policy.
pub fn compose_workspace_overview(
  snapshot: &OrganizerSnapshot,
  settings: &WorkspaceOverviewSettings,
  documents: Vec<OverviewDocument>,
  public: bool,
) -> AuthResult<WorkspaceOverview> {
  let mut facts = BTreeMap::new();
  for document in documents {
    if document.reference.kind() != WorkspaceContentResourceKind::Document
      || facts.insert(document.reference.clone(), document).is_some()
    {
      return Err(AuthError::InvalidInput("invalid or duplicate overview document".into()));
    }
  }
  let mut composer = Composer {
    workspace_id: snapshot.workspace_id,
    settings,
    facts: &facts,
    selected: settings
      .folder_ids
      .as_ref()
      .map(|ids| ids.iter().map(String::as_str).collect()),
    public,
    pages: Vec::new(),
  };
  let children = composer.folders(&snapshot.roots, &[], composer.selected.is_none());
  let (introduction, introduction_unavailable) = composer.introduction(settings.introduction.as_ref());
  let mut documents = facts
    .values()
    .filter(|document| document.reference.workspace_id() == snapshot.workspace_id)
    .cloned()
    .collect::<Vec<_>>();
  sort_documents(&mut documents, settings.register_presentation.as_ref());
  Ok(WorkspaceOverview {
    workspace_id: snapshot.workspace_id,
    root: OverviewPage {
      folder: None,
      breadcrumbs: Vec::new(),
      children: children
        .into_iter()
        .filter_map(|(folder, admitted)| admitted.then_some(folder))
        .collect(),
      introduction,
      introduction_unavailable,
      documents,
      register_presentation: settings.register_presentation.clone(),
    },
    folders: composer.pages,
  })
}

/// Compose the caller's already authorized Git export inventory. Publication
/// is not Git authorization: retain private admitted documents and real empty
/// folders. The caller supplies the same snapshot used by `project_organizer`;
/// subsequent path/render adapters must not reload or broaden that inventory.
pub fn compose_git_workspace_overview(
  snapshot: &OrganizerSnapshot,
  settings: &WorkspaceOverviewSettings,
  authorized_documents: Vec<OverviewDocument>,
  definitions: &[myoxus_domain::entities::DocumentMetadataFieldDefinition],
) -> AuthResult<WorkspaceOverview> {
  let mut admitted_settings = settings.clone();
  public::admit_export_presentation(&mut admitted_settings, definitions, true);
  compose_workspace_overview(snapshot, &admitted_settings, authorized_documents, false)
}

struct Composer<'a> {
  workspace_id: Uuid,
  settings: &'a WorkspaceOverviewSettings,
  facts: &'a BTreeMap<WorkspaceContentResourceRef, OverviewDocument>,
  selected: Option<BTreeSet<&'a str>>,
  public: bool,
  pages: Vec<OverviewPage>,
}

impl Composer<'_> {
  fn introduction(&self, reference: Option<&WorkspaceContentResourceRef>) -> (Option<OverviewDocument>, bool) {
    let introduction = reference
      .filter(|reference| reference.workspace_id() == self.workspace_id)
      .and_then(|reference| self.facts.get(reference))
      .filter(|document| document.is_page)
      .cloned();
    let unavailable = !self.public && reference.is_some() && introduction.is_none();
    (introduction, unavailable)
  }

  /// Walk the already validated, ordered snapshot. Structural workspace roots
  /// contribute their children directly, matching the canonical folder resolver.
  fn folders(
    &mut self,
    nodes: &[OrganizerSnapshotNode],
    ancestors: &[OverviewFolder],
    inside_selection: bool,
  ) -> Vec<(OverviewFolder, bool)> {
    let mut result = Vec::new();
    for node in nodes {
      if node.row.is_workspace_root() {
        result.extend(self.folders(&node.children, ancestors, inside_selection));
        continue;
      }
      if !node.row.is_folder() {
        continue;
      }
      let folder = OverviewFolder {
        id: node.row.id.clone(),
        name: node.row.data.clone(),
      };
      let inside = inside_selection
        || self
          .selected
          .as_ref()
          .is_some_and(|ids| ids.contains(folder.id.as_str()));
      let mut breadcrumbs = ancestors.to_vec();
      breadcrumbs.push(folder.clone());
      let children = self.folders(&node.children, &breadcrumbs, inside);
      let child_admitted = children.iter().any(|(_, admitted)| *admitted);
      let mut documents = node
        .children
        .iter()
        .filter(|child| child.row.link_type() == Ok(OrganizerLinkType::Doc))
        .filter_map(|child| child.row.resource_reference(self.workspace_id).ok().flatten())
        .filter_map(|reference| self.facts.get(&reference).cloned())
        .collect::<Vec<_>>();
      let presentation = self
        .settings
        .folders
        .get(&folder.id)
        .and_then(|config| config.register_presentation.as_ref())
        .or(self.settings.register_presentation.as_ref());
      sort_documents(&mut documents, presentation);
      let config = self.settings.folders.get(&folder.id);
      let (introduction, introduction_unavailable) =
        self.introduction(config.and_then(|config| config.introduction.as_ref()));
      // A connector ancestor is public only while an admitted child is visible.
      // Its own unselected contents cannot reveal an otherwise private branch.
      let admitted = if self.public {
        child_admitted || (inside && (!documents.is_empty() || introduction.is_some()))
      } else {
        inside || child_admitted
      };
      if !self.public || admitted {
        self.pages.push(OverviewPage {
          folder: Some(folder.clone()),
          breadcrumbs,
          children: children
            .into_iter()
            .filter_map(|(folder, admitted)| (!self.public || admitted).then_some(folder))
            .collect(),
          introduction,
          introduction_unavailable,
          documents,
          register_presentation: config
            .and_then(|config| config.register_presentation.as_ref())
            .or(self.settings.register_presentation.as_ref())
            .cloned(),
        });
        result.push((folder, admitted));
      }
    }
    result
  }
}
