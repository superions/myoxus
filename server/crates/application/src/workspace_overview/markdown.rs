// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only Git pages composed directly from admitted facts, never synthetic Yjs.

use crate::git_sync::overview::GitOverviewPathPlan;
use crate::markdown::{
  ConversionError, MarkdownBatchReferenceInventory, MarkdownDocumentProjection, MarkdownProjectionPolicy, content_hash,
  escape_markdown_destination, escape_markdown_literal_text, escape_markdown_table_cell,
  project_document_in_batch_with_images,
};
use myoxus_public_render::WorkspaceRegisterValue;

use super::{OverviewPage, public_register_columns, public_register_values};

/// A marker is a diagnostic signal, not ownership. Only the validated enclosing
/// manifest may classify this file as a derived output on subsequent reads.
pub const GIT_OVERVIEW_MARKER: &str = "<!-- myoxus:workspace-overview; read-only; regenerate from Myoxus -->";

fn line(value: &str) -> String {
  value.lines().collect::<Vec<_>>().join(" ")
}

fn link(title: &str, destination: &str) -> String {
  format!(
    "[{}]({})",
    escape_markdown_literal_text(&line(title)),
    escape_markdown_destination(destination)
  )
}

fn label(key: &str) -> &'static str {
  match key {
    "title" => "Document",
    "tags" => "Tags",
    "createdAt" => "Created",
    "updatedAt" => "Updated",
    "createdBy" => "Created by",
    "status" => "Status",
    "documentType" => "Document type",
    "classification" => "Classification",
    "version" => "Version",
    "reviewDueAt" => "Review due",
    "validUntil" => "Valid until",
    _ => "Property",
  }
}

fn text(value: WorkspaceRegisterValue) -> String {
  match value {
    WorkspaceRegisterValue::Text(value) => value,
    WorkspaceRegisterValue::Labels(values) => values.join(", "),
    WorkspaceRegisterValue::Timestamp(value) => value.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true),
    WorkspaceRegisterValue::Version { label, dirty } => {
      let mut value = label.unwrap_or_default();
      if dirty {
        value.push_str(" (modified)");
      }
      value
    }
  }
}

/// Render a page after final path allocation. `page` contains only facts admitted
/// by the Git composer over effective emitted documents. The introduction body
/// is captured/prepared by that same operation; no per-row bodies are loaded.
/// Asset destinations are operation-final root-relative paths, resolved from
/// this README through the ordinary batch lookup. Missing source data fails
/// before mutation; native partial-conversion diagnostics remain observable.
pub fn render_git_overview(
  workspace_title: &str,
  page: &OverviewPage,
  paths: &GitOverviewPathPlan,
  inventory: &MarkdownBatchReferenceInventory,
  introduction: Option<&[u8]>,
  asset_path: &dyn Fn(&str) -> Option<String>,
) -> Result<MarkdownDocumentProjection, ConversionError> {
  let missing = || ConversionError::Conversion("incomplete Git overview output inventory".into());
  let source = match &page.folder {
    None => &paths.workspace,
    Some(folder) => paths.folders.get(&folder.id).ok_or_else(missing)?,
  };
  let references = inventory.for_source(source.as_str())?;
  let relative = |target: &str| references.resolve_export_asset_path(target).ok_or_else(missing);
  let title = page
    .folder
    .as_ref()
    .map_or(workspace_title, |folder| folder.name.as_str());
  let mut result = match &page.introduction {
    Some(document) => project_document_in_batch_with_images(
      introduction.ok_or_else(missing)?,
      &document.title,
      MarkdownProjectionPolicy::default(),
      &references,
      &|source| {
        asset_path(source)
          .and_then(|path| references.resolve_export_asset_path(&path))
          .or_else(|| Some(source.to_string()))
      },
    )?,
    None => {
      project_document_in_batch_with_images(&[], title, MarkdownProjectionPolicy::default(), &references, &|_| None)?
    }
  };
  let mut body = format!(
    "{GIT_OVERVIEW_MARKER}\n\n# {}\n\n",
    escape_markdown_literal_text(&line(title))
  );
  let mut breadcrumbs = vec![link(workspace_title, &relative(paths.workspace.as_str())?)];
  for folder in &page.breadcrumbs {
    let path = paths.folders.get(&folder.id).ok_or_else(missing)?;
    breadcrumbs.push(link(&folder.name, &relative(path.as_str())?));
  }
  body.push_str(&breadcrumbs.join(" / "));
  body.push_str("\n\n");
  if !result.markdown.is_empty() {
    body.push_str(&result.markdown);
    body.push_str("\n\n");
  }
  if !page.children.is_empty() {
    body.push_str("## Folders\n\n");
    for folder in &page.children {
      let path = paths.folders.get(&folder.id).ok_or_else(missing)?;
      body.push_str(&format!("- {}\n", link(&folder.name, &relative(path.as_str())?)));
    }
    body.push('\n');
  }
  body.push_str("## Documents\n\n");
  let mut columns = public_register_columns(page);
  if !columns.iter().any(|key| key == "title") {
    columns.insert(0, "title".into());
  }
  let row = |cells: Vec<String>| {
    format!(
      "| {} |\n",
      cells
        .iter()
        .map(|value| escape_markdown_table_cell(value))
        .collect::<Vec<_>>()
        .join(" | ")
    )
  };
  body.push_str(&row(columns.iter().map(|key| label(key).into()).collect()));
  body.push_str(&row(columns.iter().map(|_| "---".into()).collect()));
  for document in &page.documents {
    let path = paths.documents.get(&document.doc_id).ok_or_else(missing)?;
    let mut values = public_register_values(document, page);
    if columns.iter().any(|key| key == "createdBy") {
      if let Some(name) = document.register.as_ref().and_then(|row| row.created_by_name.clone()) {
        values.insert("createdBy".into(), WorkspaceRegisterValue::Text(name));
      }
    }
    let document_link = link(&document.title, &relative(path.as_str())?);
    let cells = columns
      .iter()
      .map(|key| {
        if key == "title" {
          document_link.clone()
        } else {
          escape_markdown_literal_text(&values.remove(key).map(text).unwrap_or_default())
        }
      })
      .collect();
    body.push_str(&row(cells));
  }
  result.title = title.to_string();
  result.content_hash = content_hash(&body);
  result.markdown = body;
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{
    markdown::{AuthorizedMarkdownBatchDocument, AuthorizedMarkdownDocument},
    workspace_overview::{OverviewDocument, OverviewFolder, OverviewRegisterFacts},
  };
  use myoxus_domain::{
    workspace_content_operation::{WorkspaceContentResourceKind, WorkspaceContentResourceRef},
    workspace_overview::OverviewRegisterPresentation,
  };
  use std::collections::{BTreeMap, HashMap};
  use uuid::Uuid;

  #[test]
  fn nested_git_page_uses_final_targets_and_native_intro_diagnostics() {
    let workspace = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let timestamp = chrono::DateTime::from_timestamp(0, 0).unwrap();
    let document = OverviewDocument {
      reference: WorkspaceContentResourceRef::new(workspace, WorkspaceContentResourceKind::Document, "doc").unwrap(),
      doc_id, title: "A | [Ü]".into(), updated_at: timestamp, public_mode: None, is_page: true, can_edit: false,
      register: Some(OverviewRegisterFacts {
        metadata: serde_json::from_value(serde_json::json!({"doc_id":doc_id, "external_id":"doc", "is_template":false,"dirty_since_current_version":false})).unwrap(),
        labels: myoxus_domain::entities::DocumentMetadataIndexLabels {status_label:Some("Open | [value]\nnext".into()),..Default::default()},
        created_at: timestamp, created_by_name: Some("Person | <name>".into()),tag_ids:vec![],tags:vec![],can_publish:false,
      }),
    };
    let folder = OverviewFolder {
      id: "folder".into(),
      name: "Dienste".into(),
    };
    let mut presentation = OverviewRegisterPresentation::default();
    presentation.display_properties = vec![
      "system:status".into(),
      "system:title".into(),
      "system:updatedAt".into(),
      "system:createdBy".into(),
    ];
    let page = OverviewPage {
      folder: Some(folder.clone()),
      breadcrumbs: vec![folder],
      children: vec![OverviewFolder {
        id: "child".into(),
        name: "Child".into(),
      }],
      introduction: Some(document.clone()),
      introduction_unavailable: false,
      documents: vec![document],
      register_presentation: Some(presentation),
    };
    let paths = GitOverviewPathPlan {
      documents: HashMap::from([(
        doc_id,
        myoxus_domain::git_sync::RepoPath::new("content/shared ü.md").unwrap(),
      )]),
      workspace: myoxus_domain::git_sync::RepoPath::new("content/README.md").unwrap(),
      folders: BTreeMap::from([
        (
          "folder".into(),
          myoxus_domain::git_sync::RepoPath::new("content/dienste/README--resolved.md").unwrap(),
        ),
        (
          "child".into(),
          myoxus_domain::git_sync::RepoPath::new("content/dienste/child/README.md").unwrap(),
        ),
      ]),
      retired: vec![],
    };
    let inventory = MarkdownBatchReferenceInventory::new_with_authorized(
      "https://myoxus.test/workspace/ws",
      [AuthorizedMarkdownDocument {
        external_id: "outside".into(),
        title: "Outside".into(),
      }],
      [AuthorizedMarkdownBatchDocument {
        external_id: "doc".into(),
        title: "Doc".into(),
        path: "content/shared ü.md".into(),
      }],
    )
    .unwrap();
    let intro = crate::markdown::prepare_markdown_batch_import("Intro", "[Local](https://myoxus.test/workspace/ws/doc)\n\n[Outside](https://myoxus.test/workspace/ws/outside)\n\n![Image](blob-source)",
      &inventory.for_source("content/intro.md").unwrap()).unwrap().yjs_binary;
    let rendered = render_git_overview("Workspace", &page, &paths, &inventory, Some(&intro), &|source| {
      (source == "blob-source").then(|| "content/assets/image.png".into())
    })
    .unwrap();
    assert!(rendered.markdown.starts_with(GIT_OVERVIEW_MARKER));
    assert!(
      rendered
        .markdown
        .contains("| Status | Document | Updated | Created by |")
    );
    assert!(
      rendered
        .markdown
        .contains("[Workspace](../README.md) / [Dienste](README--resolved.md)")
    );
    assert!(rendered.markdown.contains("[Child](child/README.md)"));
    assert!(
      rendered.markdown.contains("[Local](../shared%20%C3%BC.md)"),
      "{}",
      rendered.markdown
    );
    assert!(rendered.markdown.contains("https://myoxus.test/workspace/ws/outside"));
    assert!(rendered.markdown.contains("../assets/image.png"));
    assert!(rendered.markdown.contains("Open \\| \\[value\\]<br />next"));
    assert!(rendered.markdown.contains("1970-01-01T00:00:00Z"));
    assert!(rendered.markdown.contains("Person \\| \\<name>"));
    assert_eq!(rendered.content_hash, content_hash(&rendered.markdown));
    assert!(render_git_overview("Workspace", &page, &paths, &inventory, None, &|_| None).is_err());
    let unresolved = crate::markdown::prepare_markdown_import_with_references(
      "Intro",
      "[Missing](https://myoxus.test/workspace/ws/missing)",
      &crate::markdown::MarkdownReferenceLookup::new(
        "https://myoxus.test/workspace/ws",
        [AuthorizedMarkdownDocument {
          external_id: "missing".into(),
          title: "Missing".into(),
        }],
      )
      .unwrap(),
    )
    .unwrap();
    let partial = render_git_overview(
      "Workspace",
      &page,
      &paths,
      &inventory,
      Some(&unresolved.yjs_binary),
      &|_| None,
    )
    .unwrap();
    assert!(partial.partial);
    assert!(!partial.diagnostics.is_empty());
  }
}
