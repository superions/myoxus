// SPDX-License-Identifier: AGPL-3.0-or-later
//! Notion HTML export adapter (P-DB-29).
//!
//! This module is the *only* place that turns a [`DatabaseSnapshot`]
//! back into Notion-flavoured HTML pages. Each Database page carries the
//! property table and links to one Page per non-redacted Row, so optional Row
//! content can round-trip through the same parser without being flattened.
//!
//! ## Honesty contract
//!
//! The contract for P-DB-29 is "export adapter only for formats we can
//! produce honestly". The HTML emitted here:
//!
//! * Mirrors the existing `DatabaseSnapshot` → `NotionDocument` →
//!   HTML projection. Every cell becomes the closest Notion equivalent
//!   in the same way the import direction already did. No information
//!   is invented.
//! * Carries a `<!-- myoxus-export-meta -->` comment at the end of
//!   the document that lists the round-trip diagnostics so the
//!   operator (or any re-importing tool) sees exactly which fields
//!   were downgraded. The diagnostics are also returned alongside the
//!   HTML so the GraphQL layer can surface them.
//! * Skips every `NotionPropertyKind` that has no honest
//!   representation as an HTML cell (created_time, created_by, last
//!   edited, verification). The skip is recorded in the diagnostic
//!   list so the operator can re-add the information manually if
//!   they need it.
//!
//! What this adapter does **not** do:
//!
//! * It does not write a Notion `*.zip` archive (Notion ZIPs bundle
//!   per-page HTML files; that lives behind a separate entry point
//!   that the operator can call when they want a complete archive).
//! * It does not produce Notion sync blocks, page mentions, or
//!   inline databases. The export is a single database per HTML
//!   page, period.
//! * It does not run Notion formulas, verifications, or rollups.

use std::collections::HashMap;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use myoxus_domain::database::{
  DatabaseCellValueData, DatabaseFieldConfig, DatabaseFieldType, DatabaseSnapshot, DatabaseSnapshotCellValue,
  DatabaseSnapshotCellValueData, DatabaseSnapshotDatabase, DatabaseSnapshotField, DatabaseSnapshotFieldConfig,
  DatabaseSnapshotWorkspaceTag,
};
use myoxus_public_render::{Block, InlineText, PublicList, document_from_yjs};
use serde::Serialize;
use tracing::{debug, instrument};

use super::{
  NotionDiagnostic, NotionDiagnosticCode, NotionDiagnosticSeverity, NotionDocument, NotionPageBody, NotionProperty,
  NotionPropertyKind, NotionRow,
};

/// Outcome of exporting a snapshot to Notion HTML. The bytes are
/// ready-to-serve HTML; the diagnostics list mirrors every downgrade
/// or loss the round-trip encountered.
#[derive(Debug, Clone, Serialize)]
pub struct NotionHtmlExport {
  /// One HTML page per database. Always at least one entry; for a
  /// snapshot with a single database the caller uses `pages[0]`.
  pub pages: Vec<NotionHtmlExportPage>,
  /// Diagnostics emitted while walking the snapshot. Merged with the
  /// caller's diagnostic surface so the Web UI shows them in the
  /// same panel as the import diagnostics.
  pub diagnostics: Vec<NotionDiagnostic>,
}

/// One HTML page in the export. `filename` is a safe, ASCII-only
/// filename the caller can use as a download name.
#[derive(Debug, Clone, Serialize)]
pub struct NotionHtmlExportPage {
  pub filename: String,
  pub title: String,
  pub content: String,
}

/// Export a [`DatabaseSnapshot`] as a list of Notion HTML pages. The
/// export is *per database*: `snapshot.databases` becomes one HTML
/// page each. The legacy `snapshot.database` (always set to the first
/// database) is included as the first page when the two lists differ.
#[instrument(skip(snapshot), fields(snapshot_databases = snapshot.databases.len()))]
pub fn export_snapshot_as_notion_html(snapshot: &DatabaseSnapshot) -> NotionHtmlExport {
  let mut diagnostics: Vec<NotionDiagnostic> = Vec::new();
  let mut pages: Vec<NotionHtmlExportPage> = Vec::new();
  let workspace_tags = snapshot
    .workspace_tags_manifest
    .iter()
    .map(|tag| (tag.id, tag))
    .collect::<HashMap<_, _>>();
  let omitted_row_content = snapshot
    .diagnostics
    .iter()
    .filter(|diagnostic| diagnostic.code == "MIX_DATABASE_JSON_CONTENT_DOCUMENT_OMITTED")
    .filter_map(|diagnostic| diagnostic.path.as_deref())
    .filter_map(content_omission_row_id)
    .collect::<std::collections::HashSet<_>>();
  // The snapshot adapter always writes the first database into
  // `snapshot.database` for backwards compatibility. We dedupe so we
  // do not emit the same database twice.
  let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
  let databases: Vec<&DatabaseSnapshotDatabase> = snapshot
    .databases
    .iter()
    .filter(|db| seen_ids.insert(db.id.clone()))
    .collect();
  for (index, database) in databases.iter().enumerate() {
    let mut page_diagnostics: Vec<NotionDiagnostic> = Vec::new();
    let document =
      project_snapshot_database_to_notion(database, &workspace_tags, &omitted_row_content, &mut page_diagnostics);
    let html = render_notion_html_page(&document, &page_diagnostics);
    pages.push(NotionHtmlExportPage {
      filename: safe_notion_filename(&document.title, index),
      title: document.title.clone(),
      content: html,
    });
    for row in &document.rows {
      let Some(body) = &row.page_body else {
        continue;
      };
      pages.push(NotionHtmlExportPage {
        filename: body.entry_path.clone(),
        title: row.title.clone(),
        content: render_notion_row_page(row, body),
      });
    }
    diagnostics.extend(page_diagnostics);
  }
  if pages.is_empty() {
    // The snapshot was effectively empty; emit a placeholder page so
    // the caller has at least one file to give the user.
    let page_diagnostics: Vec<NotionDiagnostic> = Vec::new();
    let document = empty_notion_document();
    let html = render_notion_html_page(&document, &page_diagnostics);
    pages.push(NotionHtmlExportPage {
      filename: safe_notion_filename(&document.title, 0),
      title: document.title.clone(),
      content: html,
    });
    diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::EmptyTitleFallback,
      NotionDiagnosticSeverity::Info,
      "$.databases[0]",
      "Snapshot contained no databases; the export is a placeholder page",
    ));
  }
  debug!(
    pages = pages.len(),
    diagnostics = diagnostics.len(),
    total_bytes = pages.iter().map(|p| p.content.len()).sum::<usize>(),
    "notion html export complete"
  );
  NotionHtmlExport { pages, diagnostics }
}

fn project_snapshot_database_to_notion(
  database: &DatabaseSnapshotDatabase,
  workspace_tags: &HashMap<uuid::Uuid, &DatabaseSnapshotWorkspaceTag>,
  omitted_row_content: &std::collections::HashSet<String>,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> NotionDocument {
  // Build the Notion column list. The first title-kind field is the
  // Notion page name; everything else becomes a regular property.
  let mut properties: Vec<NotionProperty> = Vec::new();
  let mut title_index: Option<usize> = None;
  for (column_index, field) in database.fields.iter().enumerate() {
    let kind = myoxus_to_notion_kind(&field.field_type);
    if matches!(kind, NotionPropertyKind::Title) && title_index.is_none() {
      title_index = Some(column_index);
    }
    properties.push(NotionProperty {
      name: field.name.clone(),
      kind,
      select_options: if field.field_type == DatabaseFieldType::Tags {
        workspace_tags.values().map(|tag| tag.name.clone()).collect()
      } else {
        extract_select_options(&field.config)
      },
      raw_text: None,
      rich_text: Vec::new(),
      rich_text_lossy: false,
      date_start: None,
      date_end: None,
      number: None,
      checkbox: None,
      relation_targets: Vec::new(),
      rollup_aggregate: None,
      file_paths: Vec::new(),
      url: None,
      email: None,
      phone: None,
      people: Vec::new(),
      tags: Vec::new(),
    });
  }
  if title_index.is_none() && !properties.is_empty() {
    // No title field at all; force the first column to be the title
    // so the export has a deterministic page name.
    if let Some(first) = properties.first_mut() {
      first.kind = NotionPropertyKind::Title;
    }
  }

  let mut rows: Vec<NotionRow> = Vec::new();
  let document_page_filenames = database
    .rows
    .iter()
    .filter_map(|row| {
      let content = row.content_document.as_ref()?;
      let page_id = notion_row_page_id(&database.id, &row.id);
      Some((
        content.document_key.clone(),
        notion_row_page_filename(&row.title, &page_id),
      ))
    })
    .collect::<HashMap<_, _>>();
  for (row_index, row) in database.rows.iter().enumerate() {
    let title = row.title.clone();
    let page_id = notion_row_page_id(&database.id, &row.id);
    let row_properties: Vec<NotionProperty> = database
      .fields
      .iter()
      .enumerate()
      .map(|(column_index, field)| {
        let cell = row.cells.iter().find(|cell| cell.field_id == field.id);
        let kind = properties
          .get(column_index)
          .map(|property| property.kind)
          .unwrap_or(NotionPropertyKind::RichText);
        project_cell_to_notion_property(field, cell, kind, row_index, column_index, workspace_tags, diagnostics)
      })
      .collect();
    rows.push(NotionRow {
      page_id: page_id.clone(),
      title,
      icon: None,
      cover_url: None,
      page_body: if omitted_row_content.contains(&row.id) {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::PageBodyUnsupported,
          NotionDiagnosticSeverity::Warning,
          format!("$.databases[0].rows[{row_index}].contentDocument"),
          "Row content was redacted by the snapshot ACL and was not exported",
        ));
        None
      } else if let Some(content) = row.content_document.as_ref() {
        project_content_document_to_notion_body(
          content,
          &notion_row_page_filename(&row.title, &page_id),
          &document_page_filenames,
          row_index,
          diagnostics,
        )
      } else {
        Some(NotionPageBody {
          entry_path: notion_row_page_filename(&row.title, &page_id),
          html_fragment: String::new(),
        })
      },
      properties: row_properties,
    });
  }

  NotionDocument {
    database_id: database.id.clone(),
    title: database.title.clone(),
    description: database.description.clone(),
    properties,
    rows,
  }
}

fn content_omission_row_id(path: &str) -> Option<String> {
  let marker = "$.database.rows[";
  let row_id = path.strip_prefix(marker)?.strip_suffix("].contentDocument")?;
  (!row_id.is_empty()).then(|| row_id.to_string())
}

fn project_content_document_to_notion_body(
  content: &myoxus_domain::database::DatabaseSnapshotContentDocument,
  entry_path: &str,
  document_page_filenames: &HashMap<String, String>,
  row_index: usize,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> Option<NotionPageBody> {
  let update = match STANDARD.decode(content.yjs_update_base64.as_bytes()) {
    Ok(update) => update,
    Err(error) => {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::PageBodyUnsupported,
        NotionDiagnosticSeverity::Warning,
        format!("$.databases[0].rows[{row_index}].contentDocument"),
        format!("Row content was omitted because its portable Yjs payload is invalid: {error}"),
      ));
      return None;
    }
  };
  if crate::document_fields::validate_snapshot(&update).is_err() {
    diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::PageBodyUnsupported,
      NotionDiagnosticSeverity::Warning,
      format!("$.databases[0].rows[{row_index}].contentDocument"),
      "Row content was omitted because its native document fields are unavailable",
    ));
    return None;
  }
  let projected = match document_from_yjs(
    uuid::Uuid::nil(),
    uuid::Uuid::nil(),
    &content.title,
    "notion-export",
    &update,
  ) {
    Ok(projected) => projected,
    Err(error) => {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::PageBodyUnsupported,
        NotionDiagnosticSeverity::Warning,
        format!("$.databases[0].rows[{row_index}].contentDocument"),
        format!("Row content was omitted because its Yjs blocks could not be projected: {error}"),
      ));
      return None;
    }
  };
  for diagnostic in projected.diagnostics {
    diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::PageBodyUnsupported,
      NotionDiagnosticSeverity::Warning,
      format!("$.databases[0].rows[{row_index}].contentDocument"),
      diagnostic.message,
    ));
  }
  Some(NotionPageBody {
    entry_path: entry_path.to_string(),
    html_fragment: render_public_blocks_as_notion_html(&projected.document.blocks, document_page_filenames),
  })
}

fn render_public_blocks_as_notion_html(blocks: &[Block], document_page_filenames: &HashMap<String, String>) -> String {
  let mut html = String::new();
  for block in blocks {
    match block {
      Block::Paragraph { text, .. } => html.push_str(&format!(
        "<p>{}</p>\n",
        render_public_inline(text, document_page_filenames)
      )),
      Block::Heading { level, text, .. } => {
        let level = (*level).clamp(1, 6);
        html.push_str(&format!(
          "<h{level}>{}</h{level}>\n",
          render_public_inline(text, document_page_filenames)
        ));
      }
      Block::List { list, .. } => render_public_list(&mut html, list, document_page_filenames),
      Block::Quote { text, .. } => html.push_str(&format!(
        "<blockquote>{}</blockquote>\n",
        render_public_inline(text, document_page_filenames)
      )),
      Block::Callout { text, children, .. } => {
        html.push_str("<div class=\"callout\">\n");
        if !text.is_empty() {
          html.push_str(&format!(
            "<p>{}</p>\n",
            render_public_inline(text, document_page_filenames)
          ));
        }
        html.push_str(&render_public_blocks_as_notion_html(children, document_page_filenames));
        html.push_str("</div>\n");
      }
      Block::Code { language, text, .. } => html.push_str(&format!(
        "<pre><code{}>{}</code></pre>\n",
        language
          .as_ref()
          .filter(|language| !language.trim().is_empty())
          .map(|language| format!(" class=\"language-{}\"", escape_html_attribute(language)))
          .unwrap_or_default(),
        escape_html(text)
      )),
      Block::Mermaid { .. } => {}
      Block::Divider { .. } => html.push_str("<hr />\n"),
      Block::Image { asset, .. } => html.push_str(&format!(
        "<figure><img src=\"{}\" alt=\"{}\" /></figure>\n",
        escape_html_attribute(&portable_resource_target(&asset.source, document_page_filenames)),
        escape_html_attribute(&asset.alt)
      )),
      Block::BookmarkCard { url, title, .. } => html.push_str(&format!(
        "<p><a href=\"{}\">{}</a></p>\n",
        escape_html_attribute(&portable_resource_target(url, document_page_filenames)),
        escape_html(if title.trim().is_empty() { url } else { title })
      )),
      Block::Table { rows, .. } => {
        html.push_str("<table>\n<tbody>\n");
        for row in rows {
          html.push_str("<tr>");
          for cell in row {
            html.push_str(&format!(
              "<td>{}</td>",
              render_public_inline(cell, document_page_filenames)
            ));
          }
          html.push_str("</tr>\n");
        }
        html.push_str("</tbody>\n</table>\n");
      }
      Block::FootnoteDefinition { label, children, .. } => {
        html.push_str(&format!("<p>[^{label}]</p>\n", label = escape_html(label)));
        html.push_str(&render_public_blocks_as_notion_html(children, document_page_filenames));
      }
      Block::TablePlaceholder { .. } | Block::UnsupportedBlock { .. } => {}
    }
  }
  html
}

fn render_public_list(html: &mut String, list: &PublicList, document_page_filenames: &HashMap<String, String>) {
  let ordered = matches!(list.kind, myoxus_public_render::PublicListKind::Numbered);
  let tag = if ordered { "ol" } else { "ul" };
  html.push_str(&format!("<{tag}>\n"));
  for item in &list.items {
    let todo = item
      .todo_checked
      .map(|checked| {
        format!(
          "<input type=\"checkbox\" disabled{} /> ",
          if checked { " checked" } else { "" }
        )
      })
      .unwrap_or_default();
    html.push_str(&format!(
      "<li>{todo}{}",
      render_public_inline(&item.text, document_page_filenames)
    ));
    html.push_str(&render_public_blocks_as_notion_html(
      &item.children,
      document_page_filenames,
    ));
    html.push_str("</li>\n");
  }
  html.push_str(&format!("</{tag}>\n"));
}

fn render_public_inline(text: &[InlineText], document_page_filenames: &HashMap<String, String>) -> String {
  text
    .iter()
    .map(|segment| {
      let mut value = escape_html(&segment.text);
      if segment.code {
        value = format!("<code>{value}</code>");
      }
      if segment.bold {
        value = format!("<strong>{value}</strong>");
      }
      if segment.italic {
        value = format!("<em>{value}</em>");
      }
      if segment.strike {
        value = format!("<s>{value}</s>");
      }
      if let Some(link) = &segment.link {
        value = format!(
          "<a href=\"{}\">{value}</a>",
          escape_html_attribute(&portable_resource_target(link, document_page_filenames))
        );
      }
      value
    })
    .collect::<String>()
}

fn portable_resource_target(value: &str, document_page_filenames: &HashMap<String, String>) -> String {
  if let Some(encoded) = value.strip_prefix("myoxus-snapshot-document:")
    && let Ok(key) = urlencoding::decode(encoded)
    && let Some(filename) = document_page_filenames.get(key.as_ref())
  {
    return filename.clone();
  }
  if let Some(encoded) = value.strip_prefix("myoxus-snapshot-asset:")
    && let Ok(key) = urlencoding::decode(encoded)
  {
    return key.into_owned();
  }
  value.to_string()
}

fn notion_row_page_id(database_id: &str, row_id: &str) -> String {
  uuid::Uuid::new_v5(
    &uuid::Uuid::NAMESPACE_OID,
    format!("myoxus-notion-row:{database_id}:{row_id}").as_bytes(),
  )
  .simple()
  .to_string()
}

fn notion_row_page_filename(title: &str, page_id: &str) -> String {
  let slug = safe_notion_filename(title, 0).trim_end_matches(".html").to_string();
  format!("{slug} {page_id}.html")
}

fn project_cell_to_notion_property(
  field: &DatabaseSnapshotField,
  cell: Option<&DatabaseSnapshotCellValue>,
  kind: NotionPropertyKind,
  row_index: usize,
  column_index: usize,
  workspace_tags: &HashMap<uuid::Uuid, &DatabaseSnapshotWorkspaceTag>,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> NotionProperty {
  let base_path = format!("$.databases[0].rows[row_{row_index}].cells[field_{column_index}]");
  let raw_text = cell.and_then(cell_text_value).map(|value| value.to_string());
  let number = cell.and_then(cell_number_value);
  let checkbox = cell.and_then(cell_checkbox_value);
  let url = cell.and_then(cell_url_value);
  let email = cell.and_then(cell_email_value);
  let phone = cell.and_then(cell_phone_value);
  let (date_start, date_end) = cell
    .and_then(cell_date_value)
    .map(|(start, end)| (Some(start), end))
    .unwrap_or((None, None));
  let (datetime_start, datetime_end) = cell
    .and_then(cell_datetime_value)
    .map(|(start, end)| (Some(start), end))
    .unwrap_or((None, None));
  let select_options = match (field.field_type, cell) {
    (DatabaseFieldType::Tags, Some(cell)) => cell_workspace_tag_names(cell, workspace_tags, &base_path, diagnostics),
    (_, Some(cell)) => cell_select_value(cell).unwrap_or_default(),
    (_, None) => Vec::new(),
  };
  let relation_targets = cell.and_then(cell_relation_value).unwrap_or_default();
  // Notion field kinds that have no Myoxus export are downgraded to
  // rich_text with a warning. The import direction is symmetric: the
  // same kind, when imported, becomes a Text field.
  let effective_kind = match kind {
    NotionPropertyKind::Formula
    | NotionPropertyKind::Rollup
    | NotionPropertyKind::CreatedTime
    | NotionPropertyKind::CreatedBy
    | NotionPropertyKind::LastEditedTime
    | NotionPropertyKind::LastEditedBy
    | NotionPropertyKind::Verification
    | NotionPropertyKind::Relation => {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::PropertyDowngraded,
        NotionDiagnosticSeverity::Info,
        base_path.clone(),
        format!(
          "Notion export of field '{}' is informational only; the value is exported as rich text",
          field.name
        ),
      ));
      NotionPropertyKind::RichText
    }
    NotionPropertyKind::People => {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::PeopleDegraded,
        NotionDiagnosticSeverity::Info,
        base_path.clone(),
        format!(
          "Notion export of People field '{}' is informational only; the value is exported as rich text",
          field.name
        ),
      ));
      NotionPropertyKind::RichText
    }
    NotionPropertyKind::Files => {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::AssetMissing,
        NotionDiagnosticSeverity::Info,
        base_path.clone(),
        format!(
          "Notion export of Files field '{}' is informational only; the value is exported as rich text",
          field.name
        ),
      ));
      NotionPropertyKind::RichText
    }
    other => other,
  };
  // The Date vs DateTime split: the import direction chose between
  // the two based on the Notion kind. The export direction chooses
  // based on the Myoxus field type, and falls back to the closest
  // Notion kind.
  let exported_kind = effective_kind;
  let (exported_start, exported_end) = match exported_kind {
    NotionPropertyKind::Date => (date_start, date_end),
    NotionPropertyKind::DateTime => (datetime_start.or(date_start), datetime_end.or(date_end)),
    _ => (None, None),
  };
  let exported_relation_targets = if matches!(kind, NotionPropertyKind::Relation) {
    // Re-import round-trip: the relation cell carries local row ids
    // (row_N). Reconstruct the Notion target names as text so the
    // export is still useful when re-imported.
    diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::PropertyDowngraded,
      NotionDiagnosticSeverity::Info,
      base_path.clone(),
      format!(
        "Notion export of Relation field '{}' is informational only; targets are exported as rich text",
        field.name
      ),
    ));
    Vec::new()
  } else {
    relation_targets
  };
  NotionProperty {
    name: field.name.clone(),
    kind: exported_kind,
    raw_text,
    rich_text: Vec::new(),
    rich_text_lossy: false,
    select_options,
    date_start: exported_start,
    date_end: exported_end,
    number,
    checkbox,
    relation_targets: exported_relation_targets,
    rollup_aggregate: None,
    file_paths: Vec::new(),
    url,
    email,
    phone,
    people: Vec::new(),
    tags: Vec::new(),
  }
}

fn myoxus_to_notion_kind(field_type: &DatabaseFieldType) -> NotionPropertyKind {
  match field_type {
    DatabaseFieldType::Title => NotionPropertyKind::Title,
    DatabaseFieldType::Text | DatabaseFieldType::RichText => NotionPropertyKind::RichText,
    DatabaseFieldType::Number | DatabaseFieldType::Percent | DatabaseFieldType::Currency => NotionPropertyKind::Number,
    DatabaseFieldType::Checkbox => NotionPropertyKind::Checkbox,
    DatabaseFieldType::Select => NotionPropertyKind::Select,
    DatabaseFieldType::MultiSelect | DatabaseFieldType::Tags => NotionPropertyKind::MultiSelect,
    DatabaseFieldType::Status => NotionPropertyKind::Status,
    DatabaseFieldType::Date => NotionPropertyKind::Date,
    DatabaseFieldType::DateTime => NotionPropertyKind::DateTime,
    DatabaseFieldType::Url => NotionPropertyKind::Url,
    DatabaseFieldType::Email => NotionPropertyKind::Email,
    DatabaseFieldType::Phone => NotionPropertyKind::Phone,
    DatabaseFieldType::Files => NotionPropertyKind::Files,
    DatabaseFieldType::Relation => NotionPropertyKind::Relation,
    DatabaseFieldType::Rollup => NotionPropertyKind::Rollup,
    DatabaseFieldType::Formula => NotionPropertyKind::Formula,
    DatabaseFieldType::User | DatabaseFieldType::Users => NotionPropertyKind::People,
    DatabaseFieldType::CreatedTime => NotionPropertyKind::CreatedTime,
    DatabaseFieldType::CreatedBy => NotionPropertyKind::CreatedBy,
    DatabaseFieldType::UpdatedTime => NotionPropertyKind::LastEditedTime,
    DatabaseFieldType::UpdatedBy => NotionPropertyKind::LastEditedBy,
    DatabaseFieldType::UniqueId => NotionPropertyKind::RichText,
    DatabaseFieldType::Duration | DatabaseFieldType::DocumentLink => NotionPropertyKind::RichText,
  }
}

fn extract_select_options(config: &DatabaseSnapshotFieldConfig) -> Vec<String> {
  match config {
    DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Select(inner)) => {
      inner.options.iter().map(|option| option.name.clone()).collect()
    }
    DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::MultiSelect(inner)) => {
      inner.options.iter().map(|option| option.name.clone()).collect()
    }
    DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Status(inner)) => {
      inner.options.iter().map(|option| option.name.clone()).collect()
    }
    _ => Vec::new(),
  }
}

fn cell_text_value(cell: &DatabaseSnapshotCellValue) -> Option<String> {
  let DatabaseSnapshotCellValueData::Domain(value) = &cell.value else {
    return None;
  };
  match value {
    DatabaseCellValueData::Text(s) => Some(s.clone()),
    DatabaseCellValueData::Url(s) => Some(s.clone()),
    DatabaseCellValueData::Email(s) => Some(s.clone()),
    DatabaseCellValueData::Phone(s) => Some(s.clone()),
    _ => None,
  }
}

fn cell_number_value(cell: &DatabaseSnapshotCellValue) -> Option<f64> {
  let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Number(value)) = &cell.value else {
    return None;
  };
  Some(*value)
}

fn cell_checkbox_value(cell: &DatabaseSnapshotCellValue) -> Option<bool> {
  let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Checkbox(value)) = &cell.value else {
    return None;
  };
  Some(*value)
}

fn cell_url_value(cell: &DatabaseSnapshotCellValue) -> Option<String> {
  let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Url(value)) = &cell.value else {
    return None;
  };
  Some(value.clone())
}

fn cell_email_value(cell: &DatabaseSnapshotCellValue) -> Option<String> {
  let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Email(value)) = &cell.value else {
    return None;
  };
  Some(value.clone())
}

fn cell_phone_value(cell: &DatabaseSnapshotCellValue) -> Option<String> {
  let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Phone(value)) = &cell.value else {
    return None;
  };
  Some(value.clone())
}

fn cell_date_value(cell: &DatabaseSnapshotCellValue) -> Option<(String, Option<String>)> {
  let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Date(value)) = &cell.value else {
    return None;
  };
  Some((
    value.start.format("%Y-%m-%d").to_string(),
    value.end.map(|end| end.format("%Y-%m-%d").to_string()),
  ))
}

fn cell_datetime_value(cell: &DatabaseSnapshotCellValue) -> Option<(String, Option<String>)> {
  let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::DateTime(value)) = &cell.value else {
    return None;
  };
  Some((format_datetime(&value.start), value.end.as_ref().map(format_datetime)))
}

fn cell_select_value(cell: &DatabaseSnapshotCellValue) -> Option<Vec<String>> {
  let DatabaseSnapshotCellValueData::Domain(value) = &cell.value else {
    return None;
  };
  match value {
    DatabaseCellValueData::Select(name) => Some(vec![name.clone()]),
    DatabaseCellValueData::MultiSelect(values) => Some(values.clone()),
    _ => None,
  }
}

fn cell_workspace_tag_names(
  cell: &DatabaseSnapshotCellValue,
  workspace_tags: &HashMap<uuid::Uuid, &DatabaseSnapshotWorkspaceTag>,
  path: &str,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> Vec<String> {
  let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Tags(tag_ids)) = &cell.value else {
    return Vec::new();
  };
  tag_ids
    .iter()
    .filter_map(|tag_id| match workspace_tags.get(tag_id) {
      Some(tag) => Some(tag.name.clone()),
      None => {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::PropertyDowngraded,
          NotionDiagnosticSeverity::Warning,
          path,
          format!("Workspace tag {tag_id} is missing from the snapshot manifest and was omitted"),
        ));
        None
      }
    })
    .collect()
}

fn cell_relation_value(cell: &DatabaseSnapshotCellValue) -> Option<Vec<String>> {
  let DatabaseSnapshotCellValueData::Relation(values) = &cell.value else {
    return None;
  };
  Some(values.clone())
}

fn format_datetime(value: &DateTime<Utc>) -> String {
  value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn safe_notion_filename(title: &str, index: usize) -> String {
  let mut cleaned: String = title
    .chars()
    .map(|c| {
      if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
        c
      } else {
        '_'
      }
    })
    .collect();
  if cleaned.is_empty() {
    cleaned = format!("notion-database-{index}");
  }
  if cleaned.len() > 64 {
    cleaned.truncate(64);
  }
  format!("{cleaned}.html")
}

fn empty_notion_document() -> NotionDocument {
  NotionDocument {
    database_id: "database_0".to_string(),
    title: "Empty Myoxus export".to_string(),
    description: None,
    properties: vec![NotionProperty {
      name: "Name".to_string(),
      kind: NotionPropertyKind::Title,
      raw_text: None,
      rich_text: Vec::new(),
      rich_text_lossy: false,
      select_options: Vec::new(),
      date_start: None,
      date_end: None,
      number: None,
      checkbox: None,
      relation_targets: Vec::new(),
      rollup_aggregate: None,
      file_paths: Vec::new(),
      url: None,
      email: None,
      phone: None,
      people: Vec::new(),
      tags: Vec::new(),
    }],
    rows: Vec::new(),
  }
}

/// Render a [`NotionDocument`] as a Notion-shaped HTML page. The
/// output is the same shape `parse_notion_html` accepts, so a
/// round-trip through the import path re-creates the same fields
/// and rows (modulo the downgrades noted in the diagnostics).
fn render_notion_html_page(document: &NotionDocument, page_diagnostics: &[NotionDiagnostic]) -> String {
  let mut html = String::new();
  html.push_str("<html>\n");
  html.push_str(&format!(
    "<head><title>{}</title></head>\n",
    escape_html(&document.title)
  ));
  html.push_str("<body>\n");
  html.push_str(&format!("<h1>{}</h1>\n", escape_html(&document.title)));
  if let Some(description) = &document.description
    && !description.trim().is_empty()
  {
    html.push_str(&format!("<p>{}</p>\n", escape_html(description)));
  }
  html.push_str("<table class=\"collection-content\">\n");
  html.push_str("<thead><tr>\n");
  for property in &document.properties {
    let kind_tag = notion_kind_tag(&property.kind);
    let label = format!("{} ({})", property.name, kind_tag);
    html.push_str(&format!(
      "<th data-property-name=\"{}\" data-property-type=\"{}\">{}</th>\n",
      escape_html_attribute(&property.name),
      kind_tag,
      escape_html(&label)
    ));
  }
  html.push_str("</tr></thead>\n");
  html.push_str("<tbody>\n");
  for row in &document.rows {
    html.push_str("<tr>\n");
    for property in &document.properties {
      let cell = row.property(&property.name);
      let value = cell.map(notion_cell_text).unwrap_or_default();
      if property.kind == NotionPropertyKind::Title
        && let Some(body) = &row.page_body
      {
        html.push_str(&format!(
          "<td><a href=\"{}\">{}</a></td>\n",
          escape_html_attribute(&body.entry_path),
          escape_html(&value)
        ));
      } else {
        html.push_str(&format!("<td>{}</td>\n", escape_html(&value)));
      }
    }
    html.push_str("</tr>\n");
  }
  html.push_str("</tbody>\n");
  html.push_str("</table>\n");
  if !page_diagnostics.is_empty() {
    html.push_str("<!-- myoxus-export-meta\n");
    for diag in page_diagnostics {
      html.push_str(&format!(
        "  {severity} {code} {path} {message}\n",
        severity = diag.severity.as_str(),
        code = diag.code,
        path = diag.path,
        message = diag.message
      ));
    }
    html.push_str("-->\n");
  }
  html.push_str("</body></html>\n");
  html
}

fn render_notion_row_page(row: &NotionRow, body: &NotionPageBody) -> String {
  format!(
    "<html>\n<head><title>{title}</title></head>\n<body>\n<h1 class=\"page-title\">{title}</h1>\n{body}\n</body></html>\n",
    title = escape_html(&row.title),
    body = body.html_fragment
  )
}

fn notion_cell_text(property: &NotionProperty) -> String {
  if let Some(start) = &property.date_start {
    return match &property.date_end {
      Some(end) if end != start => format!("{start} → {end}"),
      _ => start.clone(),
    };
  }
  if let Some(number) = property.number {
    return format_number(number);
  }
  if let Some(checked) = property.checkbox {
    return if checked {
      "true".to_string()
    } else {
      "false".to_string()
    };
  }
  if let Some(url) = &property.url {
    return url.clone();
  }
  if let Some(email) = &property.email {
    return email.clone();
  }
  if let Some(phone) = &property.phone {
    return phone.clone();
  }
  if !property.select_options.is_empty() {
    return property.select_options.join(", ");
  }
  property.raw_text.clone().unwrap_or_default()
}

fn format_number(value: f64) -> String {
  if value.fract() == 0.0 && value.abs() < 1e15 {
    format!("{}", value as i64)
  } else {
    format!("{value}")
  }
}

fn notion_kind_tag(kind: &NotionPropertyKind) -> &'static str {
  match kind {
    NotionPropertyKind::Title => "title",
    NotionPropertyKind::RichText => "rich_text",
    NotionPropertyKind::Number => "number",
    NotionPropertyKind::Checkbox => "checkbox",
    NotionPropertyKind::Select => "select",
    NotionPropertyKind::MultiSelect => "multi_select",
    NotionPropertyKind::Status => "status",
    NotionPropertyKind::Date => "date",
    NotionPropertyKind::DateTime => "date_time",
    NotionPropertyKind::Url => "url",
    NotionPropertyKind::Email => "email",
    NotionPropertyKind::Phone => "phone_number",
    NotionPropertyKind::People => "people",
    NotionPropertyKind::Files => "files",
    NotionPropertyKind::Relation => "relation",
    NotionPropertyKind::Rollup => "rollup",
    NotionPropertyKind::Formula => "formula",
    NotionPropertyKind::Verification => "verification",
    NotionPropertyKind::CreatedTime => "created_time",
    NotionPropertyKind::CreatedBy => "created_by",
    NotionPropertyKind::LastEditedTime => "last_edited_time",
    NotionPropertyKind::LastEditedBy => "last_edited_by",
  }
}

fn escape_html(input: &str) -> String {
  let mut out = String::with_capacity(input.len());
  for c in input.chars() {
    match c {
      '&' => out.push_str("&amp;"),
      '<' => out.push_str("&lt;"),
      '>' => out.push_str("&gt;"),
      '"' => out.push_str("&quot;"),
      '\'' => out.push_str("&#39;"),
      _ => out.push(c),
    }
  }
  out
}

fn escape_html_attribute(input: &str) -> String {
  escape_html(input)
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_domain::database::{
    DatabaseCellValueData, DatabaseProfileKind, DatabaseSnapshotDatabase, DatabaseSnapshotField,
    DatabaseSnapshotFieldConfig, DatabaseSnapshotRow, DatabaseSnapshotView, DatabaseSnapshotViewConfig,
    DatabaseViewKind,
  };
  use std::collections::BTreeMap;

  fn zip_export_pages(pages: &[NotionHtmlExportPage]) -> Vec<u8> {
    use std::io::Write;

    let mut bytes = Vec::new();
    {
      let cursor = std::io::Cursor::new(&mut bytes);
      let mut archive = zip::ZipWriter::new(cursor);
      let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
      for page in pages {
        archive.start_file(page.filename.as_str(), options).expect("start page");
        archive.write_all(page.content.as_bytes()).expect("write page");
      }
      archive.finish().expect("finish export archive");
    }
    bytes
  }

  fn title_field(id: &str) -> DatabaseSnapshotField {
    DatabaseSnapshotField {
      id: id.to_string(),
      name: "Name".to_string(),
      field_type: DatabaseFieldType::Title,
      config: DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Text(Default::default())),
      position: 0,
      required: false,
      read_only: false,
    }
  }

  fn text_field(id: &str, name: &str) -> DatabaseSnapshotField {
    DatabaseSnapshotField {
      id: id.to_string(),
      name: name.to_string(),
      field_type: DatabaseFieldType::Text,
      config: DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Text(Default::default())),
      position: 1,
      required: false,
      read_only: false,
    }
  }

  fn snapshot_row(id: &str, title: &str, cells: Vec<DatabaseSnapshotCellValue>) -> DatabaseSnapshotRow {
    DatabaseSnapshotRow {
      id: id.to_string(),
      title: title.to_string(),
      position: 0,
      content_document: None,
      row_kind: myoxus_domain::database::DatabaseRowKind::Record,
      source: None,
      cells,
      projections: Vec::new(),
    }
  }

  fn text_cell(field_id: &str, text: &str) -> DatabaseSnapshotCellValue {
    DatabaseSnapshotCellValue {
      field_id: field_id.to_string(),
      field_type: DatabaseFieldType::Text,
      value: DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Text(text.to_string())),
    }
  }

  fn sample_snapshot() -> DatabaseSnapshot {
    let fields = vec![title_field("field_0"), text_field("field_1", "Notes")];
    let rows = vec![
      snapshot_row(
        "row_0",
        "Alpha",
        vec![text_cell("field_0", "Alpha"), text_cell("field_1", "first")],
      ),
      snapshot_row(
        "row_1",
        "Beta",
        vec![text_cell("field_0", "Beta"), text_cell("field_1", "second")],
      ),
    ];
    let database = DatabaseSnapshotDatabase {
      managed_template: None,
      id: "database_0".to_string(),
      profile_kind: DatabaseProfileKind::Generic,
      profile_structure_preset: None,
      profile_config: serde_json::json!({}),
      title: "My Tasks".to_string(),
      description: None,
      fields,
      views: vec![DatabaseSnapshotView {
        id: "view_0".to_string(),
        name: "Table".to_string(),
        view_kind: DatabaseViewKind::Table,
        icon: None,
        config: DatabaseSnapshotViewConfig::Table(myoxus_domain::database::DatabaseSnapshotTableViewConfig {
          title_field_id: "field_0".to_string(),
          visible_field_ids: Vec::new(),
          field_widths: BTreeMap::new(),
          search_field_ids: Vec::new(),
          sort: Vec::new(),
          filter: Vec::new(),
          filter_tree: None,
          group: None,
          subgroup: None,
        }),
        position: 0,
      }],
      field_roles: Vec::new(),
      view_roles: Vec::new(),
      rows,
      row_templates: Vec::new(),
    };
    DatabaseSnapshot {
      schema_version: 1,
      exported_at: Utc::now(),
      source: myoxus_domain::database::DatabaseSnapshotSource {
        product: "myoxus".to_string(),
        format: "myoxus-database".to_string(),
        database_id: Some("database_0".to_string()),
        exported_by: Some("myoxus".to_string()),
      },
      database: database.clone(),
      databases: vec![database],
      files_manifest: Vec::new(),
      workspace_tags_manifest: Vec::new(),
      diagnostics: Vec::new(),
    }
  }

  #[test]
  fn export_round_trips_through_import_with_diagnostics() {
    let snapshot = sample_snapshot();
    let export = export_snapshot_as_notion_html(&snapshot);
    // One Database table page plus one valid empty Page per documentless Row.
    assert_eq!(export.pages.len(), 3);
    let page = &export.pages[0];
    assert!(page.content.contains("<table"));
    assert!(page.content.contains("My Tasks"));
    assert!(page.content.contains("Alpha"));
    assert!(page.content.contains("first"));
    // The export HTML is the same shape parse_notion_html accepts.
    let parsed = crate::database::notion_import::parse_notion_html(page.content.as_bytes());
    assert_eq!(parsed.databases.len(), 1);
    let db = &parsed.databases[0];
    assert_eq!(db.title, "My Tasks");
    assert_eq!(db.properties.len(), 2);
    assert!(matches!(db.properties[0].kind, NotionPropertyKind::Title));
    assert_eq!(db.rows.len(), 2);
    assert_eq!(db.rows[0].title, "Alpha");
  }

  #[test]
  fn export_projects_portable_row_body_to_linked_notion_page() {
    let mut snapshot = sample_snapshot();
    let mut builder = yjs::YjsDocumentBuilder::new("Alpha");
    let mut linked = yjs::YjsTextSegment::plain("Beta");
    linked.link = Some("myoxus-snapshot-document:beta-content".to_string());
    builder.push_heading(2, &[yjs::YjsTextSegment::plain("Overview")]);
    builder.push_paragraph(&[yjs::YjsTextSegment::plain("See "), linked]);
    builder.push_quote(&[yjs::YjsTextSegment::plain("Important")]);
    let alpha_content = myoxus_domain::database::DatabaseSnapshotContentDocument {
      document_key: "alpha-content".to_string(),
      title: "Alpha".to_string(),
      yjs_update_base64: STANDARD.encode(builder.encode()),
      asset_keys: Vec::new(),
    };
    let beta_content = myoxus_domain::database::DatabaseSnapshotContentDocument {
      document_key: "beta-content".to_string(),
      title: "Beta".to_string(),
      yjs_update_base64: STANDARD.encode(yjs::YjsDocumentBuilder::new("Beta").encode()),
      asset_keys: Vec::new(),
    };
    snapshot.database.rows[0].content_document = Some(alpha_content.clone());
    snapshot.database.rows[1].content_document = Some(beta_content.clone());
    snapshot.databases[0].rows[0].content_document = Some(alpha_content);
    snapshot.databases[0].rows[1].content_document = Some(beta_content);

    let export = export_snapshot_as_notion_html(&snapshot);
    assert_eq!(export.pages.len(), 3, "database page plus both Row pages");
    let database_page = &export.pages[0];
    let alpha_page = export.pages.iter().find(|page| page.title == "Alpha").unwrap();
    let beta_page = export.pages.iter().find(|page| page.title == "Beta").unwrap();
    assert!(
      database_page
        .content
        .contains(&format!("href=\"{}\"", alpha_page.filename))
    );
    assert!(alpha_page.content.contains("<h2>Overview</h2>"));
    assert!(alpha_page.content.contains("<blockquote>Important</blockquote>"));
    assert!(alpha_page.content.contains(&format!("href=\"{}\"", beta_page.filename)));
    assert!(alpha_page.filename.ends_with(".html"));
    assert_eq!(
      alpha_page
        .filename
        .trim_end_matches(".html")
        .split_whitespace()
        .next_back()
        .map(str::len),
      Some(32)
    );

    let reparsed = crate::database::notion_import::parse_notion_zip(&zip_export_pages(&export.pages));
    assert_eq!(reparsed.databases.len(), 1);
    assert!(reparsed.databases[0].rows[0].page_body.is_some());
    let rebuilt = crate::database::notion_import::build_snapshot_from_notion(&reparsed, Some("roundtrip.zip"));
    assert_eq!(rebuilt.matched_page_count, 2);
    assert_eq!(rebuilt.content_document_count, 2);
    assert!(rebuilt.body_block_count >= 3);
    assert_eq!(rebuilt.rewritten_internal_link_count, 1);
  }

  #[test]
  fn export_emits_filename_and_placeholder_for_empty_snapshot() {
    let empty = DatabaseSnapshot {
      schema_version: 1,
      exported_at: Utc::now(),
      source: myoxus_domain::database::DatabaseSnapshotSource {
        product: "myoxus".to_string(),
        format: "myoxus-database".to_string(),
        database_id: None,
        exported_by: Some("myoxus".to_string()),
      },
      database: DatabaseSnapshotDatabase {
        managed_template: None,
        id: "database_0".to_string(),
        profile_kind: DatabaseProfileKind::Generic,
        profile_structure_preset: None,
        profile_config: serde_json::json!({}),
        title: "Empty".to_string(),
        description: None,
        fields: Vec::new(),
        views: Vec::new(),
        field_roles: Vec::new(),
        view_roles: Vec::new(),
        rows: Vec::new(),
        row_templates: Vec::new(),
      },
      databases: Vec::new(),
      files_manifest: Vec::new(),
      workspace_tags_manifest: Vec::new(),
      diagnostics: Vec::new(),
    };
    let export = export_snapshot_as_notion_html(&empty);
    assert_eq!(export.pages.len(), 1);
    assert!(
      export
        .diagnostics
        .iter()
        .any(|d| d.code == NotionDiagnosticCode::EmptyTitleFallback.as_str())
    );
  }

  #[test]
  fn export_downgrades_relation_to_text_with_diagnostic() {
    let mut snapshot = sample_snapshot();
    let relation_field = DatabaseSnapshotField {
      id: "field_2".to_string(),
      name: "Related".to_string(),
      field_type: DatabaseFieldType::Relation,
      config: DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Text(Default::default())),
      position: 2,
      required: false,
      read_only: false,
    };
    snapshot.database.fields.push(relation_field.clone());
    snapshot.databases[0].fields.push(relation_field);
    snapshot.databases[0].rows[0].cells.push(DatabaseSnapshotCellValue {
      field_id: "field_2".to_string(),
      field_type: DatabaseFieldType::Relation,
      value: DatabaseSnapshotCellValueData::Relation(vec!["row_1".to_string()]),
    });
    let export = export_snapshot_as_notion_html(&snapshot);
    // Relation column is downgraded to rich_text in the export
    // surface so the round-trip through parse_notion_html is
    // lossless. The diagnostic surfaces the loss.
    assert!(
      export
        .diagnostics
        .iter()
        .any(|d| d.code == NotionDiagnosticCode::PropertyDowngraded.as_str() && d.message.contains("Relation"))
    );
  }

  #[test]
  fn export_resolves_workspace_tag_ids_to_notion_multi_select_names() {
    let mut snapshot = sample_snapshot();
    let backend_id = uuid::Uuid::new_v4();
    let release_id = uuid::Uuid::new_v4();
    let tags_field = DatabaseSnapshotField {
      id: "field_2".to_string(),
      name: "Tags".to_string(),
      field_type: DatabaseFieldType::Tags,
      config: DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Tags(Default::default())),
      position: 2,
      required: false,
      read_only: false,
    };
    snapshot.database.fields.push(tags_field.clone());
    snapshot.databases[0].fields.push(tags_field);
    let tags_cell = DatabaseSnapshotCellValue {
      field_id: "field_2".to_string(),
      field_type: DatabaseFieldType::Tags,
      value: DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Tags(vec![backend_id, release_id])),
    };
    snapshot.database.rows[0].cells.push(tags_cell.clone());
    snapshot.databases[0].rows[0].cells.push(tags_cell);
    snapshot.workspace_tags_manifest = vec![
      DatabaseSnapshotWorkspaceTag {
        id: backend_id,
        name: "Backend".to_string(),
        slug: "backend".to_string(),
        color_role: "tag.blue".to_string(),
        archived: false,
      },
      DatabaseSnapshotWorkspaceTag {
        id: release_id,
        name: "Release Ready".to_string(),
        slug: "release-ready".to_string(),
        color_role: "tag.green".to_string(),
        archived: false,
      },
    ];

    let export = export_snapshot_as_notion_html(&snapshot);
    let html = &export.pages[0].content;
    assert!(html.contains("Backend"));
    assert!(html.contains("Release Ready"));
    let parsed = crate::database::notion_import::parse_notion_html(html.as_bytes());
    assert_eq!(parsed.databases[0].properties[2].name, "Tags");
    let tags = &parsed.databases[0].rows[0].properties[2];
    assert_eq!(tags.select_options, vec!["Backend", "Release Ready"]);
  }

  #[test]
  fn safe_notion_filename_handles_non_ascii_titles() {
    assert_eq!(safe_notion_filename("My Tasks", 0), "My_Tasks.html");
    assert_eq!(safe_notion_filename("Über / 详情", 0), "_ber_____.html");
    assert_eq!(safe_notion_filename("", 0), "notion-database-0.html");
    let long = "a".repeat(200);
    let trimmed = safe_notion_filename(&long, 0);
    assert!(trimmed.len() <= 69);
  }

  #[test]
  fn format_number_renders_integers_without_decimal() {
    assert_eq!(format_number(3.0), "3");
    assert_eq!(format_number(0.5), "0.5");
    assert_eq!(format_number(13.0), "13");
  }

  #[test]
  fn escape_html_neutralises_attribute_injection() {
    assert_eq!(escape_html("<script>"), "&lt;script&gt;");
    assert_eq!(escape_html("a&b"), "a&amp;b");
    assert_eq!(escape_html("\"x\""), "&quot;x&quot;");
  }
}
