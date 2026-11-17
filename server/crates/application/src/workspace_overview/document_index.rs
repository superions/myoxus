// SPDX-License-Identifier: AGPL-3.0-or-later
//! Operation-local directory reads for existing public and PDF output owners.
use super::{WorkspaceOverviewService, read::select_overview_page};
use crate::auth::{AuthError, AuthResult};
use crate::permission::PermissionService;
use crate::public::{PublicRepository, PublicService};
use myoxus_domain::workspace_overview::DocumentIndexQuery;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedDirectoryOutput {
  workspace_id: Uuid,
  doc_id: Uuid,
  outputs: Vec<(yjs::document_index::Definition, yjs::document_index::Output)>,
}
impl PreparedDirectoryOutput {
  pub fn apply(&self, snapshot: &[u8], workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Vec<u8>> {
    if workspace_id != self.workspace_id || doc_id != self.doc_id {
      return Err(unavailable());
    }
    yjs::document_index::project(snapshot, &self.outputs).map_err(|_| unavailable())
  }
}
fn unavailable() -> AuthError {
  AuthError::InvalidInput("directory output unavailable".into())
}

impl WorkspaceOverviewService {
  #[tracing::instrument(skip_all)]
  pub async fn prepare_directory_output(
    &self,
    snapshot: &[u8],
    workspace_id: Uuid,
    doc_id: Uuid,
    actor: Uuid,
    permission: &PermissionService,
    origin: &str,
    locale: &str,
  ) -> AuthResult<Option<PreparedDirectoryOutput>> {
    let definitions = yjs::document_index::inspect(snapshot).map_err(|_| unavailable())?;
    if definitions.is_empty() {
      return Ok(None);
    }
    let mut sources = std::collections::BTreeMap::new();
    let mut outputs = Vec::new();
    for definition in definitions {
      let query: DocumentIndexQuery = serde_json::from_value(definition.query.clone()).map_err(|_| unavailable())?;
      let source_id = source_workspace(&definition, workspace_id)?;
      if !sources.contains_key(&source_id) {
        sources.insert(
          source_id,
          self.authenticated_source(actor, permission, source_id).await?,
        );
      }
      let (_, organizer, facts) = &sources[&source_id];
      query.validate(source_id).map_err(|_| unavailable())?;
      let presentation = query.presentation(
        definition
          .display_properties
          .clone()
          .unwrap_or_else(|| vec!["system:title".into()]),
      );
      let page = select_overview_page(
        organizer,
        &sources[&source_id].0.overview_settings,
        facts.clone(),
        query.folder_id.as_deref(),
        Some(presentation),
        false,
      )?;
      let rows = self.directory_output(&definition, page, origin, false, locale).await?;
      outputs.push((definition, rows));
    }
    Ok(Some(PreparedDirectoryOutput {
      workspace_id,
      doc_id,
      outputs,
    }))
  }

  #[tracing::instrument(skip_all)]
  pub async fn public_directory_snapshot<R: PublicRepository>(
    &self,
    public: &PublicService<R>,
    snapshot: &[u8],
    workspace_id: Uuid,
    doc_id: Uuid,
    origin: &str,
    locale: &str,
  ) -> AuthResult<Vec<u8>> {
    let definitions = yjs::document_index::inspect(snapshot).map_err(|_| unavailable())?;
    if definitions.is_empty() {
      return Ok(snapshot.to_vec());
    }
    let mut sources = std::collections::BTreeMap::new();
    let metadata = self.metadata.field_definitions().await.map_err(|_| unavailable())?;
    let visible = metadata
      .iter()
      .filter(|field| crate::public::document_metadata_export_visible(field) && field.visible_in_lists)
      .map(|field| field.key.as_str())
      .chain(["title", "tags"])
      .collect::<std::collections::BTreeSet<_>>();
    let mut outputs = Vec::new();
    for definition in definitions {
      let query: DocumentIndexQuery = serde_json::from_value(definition.query.clone()).map_err(|_| unavailable())?;
      if query
        .selection
        .filters
        .iter()
        .any(|filter| !visible.contains(filter.key.as_str()))
        || query.order_by.as_ref().is_some_and(|order| {
          !visible.contains(order.key.as_str()) || matches!(order.key.as_str(), "createdBy" | "responsible")
        })
      {
        return Err(unavailable());
      }
      let source_id = source_workspace(&definition, workspace_id)?;
      if !sources.contains_key(&source_id) {
        sources.insert(source_id, self.read_public_source(public, source_id).await?);
      }
      let source = &sources[&source_id];
      query.validate(source_id).map_err(|_| unavailable())?;
      let mut settings = source.workspace.overview_settings.clone();
      let presentation = query.presentation(
        definition
          .display_properties
          .clone()
          .unwrap_or_else(|| vec!["system:title".into()]),
      );
      settings.register_presentation = Some(presentation.clone());
      // Admission precedes composition, including metadata-dependent selection.
      if let Some(folder) = query.folder_id.as_ref() {
        settings
          .folders
          .entry(folder.clone())
          .or_default()
          .register_presentation = Some(presentation);
      }
      super::public::admit_export_presentation(&mut settings, &metadata, false)?;
      let page = select_overview_page(
        &source.organizer,
        &settings,
        source.documents.clone(),
        query.folder_id.as_deref(),
        None,
        // Facts already passed anonymous admission. An embedding emits only
        // rows, so an existing folder with revoked results must render empty;
        // public overview routes still omit that folder and return 404.
        false,
      )?;
      let output = self.directory_output(&definition, page, origin, true, locale).await?;
      outputs.push((definition, output));
    }
    PreparedDirectoryOutput {
      workspace_id,
      doc_id,
      outputs,
    }
    .apply(snapshot, workspace_id, doc_id)
  }
  async fn directory_output(
    &self,
    definition: &yjs::document_index::Definition,
    mut page: super::OverviewPage,
    origin: &str,
    public: bool,
    locale: &str,
  ) -> AuthResult<yjs::document_index::Output> {
    if definition.view.as_deref().unwrap_or("list") == "list" {
      return Ok(yjs::document_index::Output::List(directory_rows(
        page.documents,
        origin,
        public,
        locale,
      )?));
    }
    if definition.view.as_deref() != Some("table") {
      return Err(unavailable());
    }
    let definitions = self.metadata.field_definitions().await.map_err(|_| unavailable())?;
    let mut settings = myoxus_domain::workspace_overview::WorkspaceOverviewSettings {
      register_presentation: page.register_presentation.clone(),
      ..Default::default()
    };
    super::public::admit_export_presentation(&mut settings, &definitions, !public)?;
    page.register_presentation = settings.register_presentation;
    if !public {
      super::hydrate_overview_register_display(&self.metadata, &self.tags, &mut page.documents).await?;
    }
    let columns = super::public_register_columns(&page);
    let renderer = self
      .html_catalog
      .as_ref()
      .ok_or_else(unavailable)?
      .renderer()
      .map_err(|_| unavailable())?;
    let headers = columns
      .iter()
      .map(|key| renderer.register_column_label(key, locale).map_err(|_| unavailable()))
      .collect::<AuthResult<Vec<_>>>()?;
    let links = directory_rows(page.documents.clone(), origin, public, locale)?;
    let mut rows: Vec<Vec<(String, Option<String>)>> = page
      .documents
      .iter()
      .zip(links)
      .map(|(document, link)| {
        let values = super::public_register_values(document, &page);
        columns
          .iter()
          .map(|key| {
            if key == "title" {
              link.clone()
            } else {
              (renderer.register_value_text(values.get(key), locale), None)
            }
          })
          .collect()
      })
      .collect();
    if rows.is_empty() {
      rows.push(
        columns
          .iter()
          .map(|key| {
            (
              if key == "title" {
                message(locale, "empty")
              } else {
                "–".into()
              },
              None,
            )
          })
          .collect(),
      );
    }
    Ok(yjs::document_index::Output::Table { headers, rows })
  }
}
fn directory_rows(
  documents: Vec<super::OverviewDocument>,
  origin: &str,
  public: bool,
  locale: &str,
) -> AuthResult<Vec<(String, Option<String>)>> {
  if documents.len() > crate::workspace_content_operation::MAX_OPERATION_SELECTION_RESOURCES {
    return Err(AuthError::InvalidInput(
      "directory output exceeds workspace operation limit".into(),
    ));
  }
  if documents.is_empty() {
    return Ok(vec![(message(locale, "empty"), None)]);
  }
  Ok(
    documents
      .into_iter()
      .map(|document| {
        // Qualified native identities and the established route namespaces are preserved.
        let id = urlencoding::encode(document.reference.resource_id()).into_owned();
        let workspace = document.reference.workspace_id();
        (
          if document.title.is_empty() {
            message(locale, "untitled")
          } else {
            document.title
          },
          Some(if public {
            format!(
              "{}{}",
              origin.trim_end_matches('/'),
              myoxus_public_render::public_document_path(workspace, document.reference.resource_id())
            )
          } else {
            format!("{origin}/workspace/{workspace}/{id}")
          }),
        )
      })
      .collect(),
  )
}

/// Generated product copy uses the same locale fallback as the existing output owners.
fn message(locale: &str, key: &str) -> String {
  let messages: serde_json::Value =
    serde_json::from_str(include_str!("messages.generated.json")).expect("generated directory messages");
  messages
    .get(locale)
    .or_else(|| messages.get(locale.split('-').next().unwrap_or("en")))
    .unwrap_or(&messages["en"])[key]
    .as_str()
    .expect("generated empty message")
    .to_owned()
}

fn source_workspace(definition: &yjs::document_index::Definition, containing: Uuid) -> AuthResult<Uuid> {
  definition
    .workspace_id
    .as_ref()
    .map(|id| Uuid::parse_str(id).map_err(|_| unavailable()))
    .transpose()
    .map(|id| id.unwrap_or(containing))
}
