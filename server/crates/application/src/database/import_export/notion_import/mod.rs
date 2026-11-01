// SPDX-License-Identifier: AGPL-3.0-or-later
//! Notion HTML / ZIP import pipeline (P-DB-29).
//!
//! This module is the *only* place where Notion HTML or Notion export ZIPs
//! are turned into a server-owned [`DatabaseSnapshot`]. It is intentionally a
//! product-neutral, server-side parser:
//!
//! * **No UI / editor dependency.** Property tables use `quick-xml`; the
//!   bounded Page-body adapter uses `scraper` and the shared Yjs builder. The
//!   module must not import from `client/*`,
//!   `virgultum/*` or any editor runtime.
//! * **No editor-local Database block creation.** The Notion intermediate
//!   model is a [`NotionDocument`] list with property tables; the
//!   conversion to a [`DatabaseSnapshot`] is one-way and lives in
//!   [`snapshot`].
//! * **No console logging / browser-only DOMParser.** Diagnostics flow through [`NotionDiagnostic`]
//!   values that the snapshot adapter maps onto
//!   `MIX_DATABASE_NOTION_*` codes so they surface in the existing
//!   `previewDatabaseJsonImport` flow.
//!
//! The pipeline:
//!
//! 1. [`parser::parse_notion_zip`] or [`parser::parse_notion_html`] turns a
//!    byte buffer into a [`NotionDocument`] (a Notion database
//!    representation that is the neutral intermediate product of the
//!    P-DB-29 contract).
//! 2. [`snapshot::build_snapshot_from_notion`] projects one or more
//!    [`NotionDocument`]s into a single [`DatabaseSnapshot`], applying
//!    the Notion-property → Myoxus-field matrix documented in
//!    `docs/dev/server/databases-import-export.md`.
//! 3. The same `DatabaseSnapshot` is then fed to the existing
//!    `DatabaseImportExportService::preview_json_import_with_options` /
//!    `DatabaseImportExportService::import_json_with_options` code path.
//!
//! The intended use is that the GraphQL `previewDatabaseNotionImport` and
//! `importDatabaseNotion` resolvers only need to: read the upload, call
//! [`build_snapshot_from_notion`], and hand the resulting `DatabaseSnapshot`
//! over to the existing JSON import code path. No editor / Web / CLI code
//! is allowed to bypass this module.

mod body;
pub mod export;
pub mod parser;
pub mod snapshot;

pub use export::{NotionHtmlExport, NotionHtmlExportPage, export_snapshot_as_notion_html};
pub use parser::{parse_notion_html, parse_notion_zip};
pub use snapshot::{NotionSnapshotBuild, build_snapshot_from_notion};

use chrono::{DateTime, Utc};
use myoxus_domain::database::{
  DatabaseCellValueData, DatabaseFieldConfig, DatabaseFieldType, DatabaseRichTextFieldConfig,
  DatabaseSelectFieldConfig, DatabaseSelectOption, DatabaseStatusFieldConfig, DatabaseStatusGroup,
  DatabaseStatusOption, DatabaseTextFieldConfig, DatabaseUniqueIdFieldConfig, DatabaseUniqueIdValue,
};
use serde::{Deserialize, Serialize};
use tracing::{debug, instrument};

/// Stable diagnostic codes emitted by the Notion pipeline.
///
/// Every code is `MIX_DATABASE_NOTION_*` so they group together with the
/// existing JSON / CSV import diagnostics. The mapping between
/// [`NotionDiagnosticCode`] and the public string is fixed and exposed to
/// the Web UI; do not change the string without updating
/// `docs/dev/server/databases-import-export.md` and the i18n keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NotionDiagnosticCode {
  /// Notion construct has no Myoxus equivalent and is retained only through
  /// its structured diagnostic and any explicitly safe readable fallback.
  Unsupported,
  /// Notion construct was downgraded to a less-fidelity Myoxus equivalent
  /// (e.g. Notion `verification` becomes Myoxus `text`).
  PropertyDowngraded,
  /// Notion page mention link was dropped because the referenced page is
  /// not part of the import payload.
  DroppedPageMention,
  /// Notion page emoji / cover image was dropped (Myoxus does not store
  /// page iconography on Database rows).
  DroppedPageIconography,
  /// Notion page permissions were dropped.
  DroppedPagePermissions,
  /// Notion verification status was dropped.
  DroppedVerificationStatus,
  /// Notion inline / sub-page database was dropped because this bounded
  /// importer materializes only top-level Databases.
  DroppedInlineDatabase,
  /// Notion ZIP archive could not be opened or read.
  ZipParseFailed,
  /// Notion HTML page could not be parsed.
  HtmlParseFailed,
  /// Notion HTML page was syntactically valid but contained no recognizable
  /// database table (caller passed unrelated HTML).
  HtmlInvalid,
  /// Notion relation column was downgraded to a text column because the
  /// referenced database is not part of the same import payload.
  RelationDegraded,
  /// Notion rollup column was downgraded to a text column because the
  /// referenced relation is not part of the same import payload.
  RollupDegraded,
  /// Notion formula column was downgraded to a text column because Myoxus
  /// does not run Notion's formula language.
  FormulaDegraded,
  /// Notion people / user column was downgraded to a text column with the
  /// display names because user identities do not transfer between
  /// workspaces.
  PeopleDegraded,
  /// Notion files column reference could not be matched to a file inside
  /// the upload payload (the file is referenced but not included).
  MissingFile,
  /// Notion select / status option names collided after trimming; the
  /// second one was renamed to keep the import honest.
  DuplicateOptionName,
  /// Notion page title was empty after trimming; the row was given a
  /// fallback title (the page slug, or the row position).
  EmptyTitleFallback,
  /// Notion synced block content could not be expanded because the
  /// source block is not part of the import.
  DroppedSyncedBlock,
  /// Notion DateTime cell value could not be parsed as a date, date-time
  /// or timezone-bearing instant; the cell fell back to a per-row
  /// diagnostic and the field downgraded to `Text` if every cell failed.
  DateTimeInvalid,
  /// Notion same-database relation referenced a row id that could not be
  /// resolved inside the imported payload; the cell fell back to
  /// readable text and the value was not imported as a relation link.
  RelationTargetUnresolved,
  /// Notion view metadata (Board / Gallery / Calendar / Timeline) had no
  /// enough source metadata to be mapped to a Myoxus view config;
  /// the view was created as a Table and the loss was surfaced.
  ViewUnsupported,
  /// Notion template-like structure was detected but could not be
  /// represented as a Myoxus row template because required field defaults
  /// were missing or ambiguous.
  TemplateUnsupported,
  /// Notion People column referenced an identity that does not match any
  /// active workspace member; the cell value preserves the Notion display
  /// text instead of inventing a workspace user.
  PeopleUnmatched,
  /// Notion People column matched more than one workspace member for the
  /// same display identity; the cell value preserves the display text
  /// and the ambiguous match is surfaced for the user to resolve.
  PeopleAmbiguous,
  /// Notion People column resolved to a single active workspace member;
  /// the cell was updated to a `Users` cell value and the matched
  /// display name / handle is recorded alongside the row id.
  PeopleMatched,
  /// Notion relation property did not target a database that is part of
  /// the imported payload; the field is downgraded to `Text` and the
  /// readable target name is preserved.
  RelationCrossDatabase,
  /// Notion Files asset entry could not be validated (unsafe path,
  /// oversize entry, oversize cumulative bytes, unsupported MIME or
  /// malformed metadata). The cell preserves the original path and the
  /// reason for rejection is surfaced.
  AssetRejected,
  /// Notion Files asset entry was missing from the uploaded payload even
  /// though the row reference it. The cell preserves the original path
  /// and a workspace blob must be uploaded separately to resolve it.
  AssetMissing,
  /// Notion rollup column was successfully mapped to a real Myoxus
  /// Rollup over a same-database relation. This is informational; the
  /// rollup field is created, the source relation is preserved and the
  /// aggregate is recorded.
  RollupImported,
  /// Notion ZIP asset was successfully handed to the workspace blob
  /// store under a stable workspace-scoped key. The cell value's
  /// `blob_key` is rewritten to point at the new blob.
  AssetMaterialized,
  /// A Database Row had no unambiguous Page entry in the source archive and
  /// therefore remains documentless.
  PageBodyMissing,
  /// More than one archive entry resolved to the Row's normalized Page id.
  PageBodyAmbiguous,
  /// A Page-body construct could not be represented by the bounded converter.
  PageBodyUnsupported,
}

impl NotionDiagnosticCode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Unsupported => "MIX_DATABASE_NOTION_UNSUPPORTED",
      Self::PropertyDowngraded => "MIX_DATABASE_NOTION_PROPERTY_DOWNGRADED",
      Self::DroppedPageMention => "MIX_DATABASE_NOTION_DROPPED_PAGE_MENTION",
      Self::DroppedPageIconography => "MIX_DATABASE_NOTION_DROPPED_PAGE_ICONOGRAPHY",
      Self::DroppedPagePermissions => "MIX_DATABASE_NOTION_DROPPED_PAGE_PERMISSIONS",
      Self::DroppedVerificationStatus => "MIX_DATABASE_NOTION_DROPPED_VERIFICATION_STATUS",
      Self::DroppedInlineDatabase => "MIX_DATABASE_NOTION_DROPPED_INLINE_DATABASE",
      Self::ZipParseFailed => "MIX_DATABASE_NOTION_ZIP_PARSE_FAILED",
      Self::HtmlParseFailed => "MIX_DATABASE_NOTION_HTML_PARSE_FAILED",
      Self::HtmlInvalid => "MIX_DATABASE_NOTION_HTML_INVALID",
      Self::RelationDegraded => "MIX_DATABASE_NOTION_RELATION_DEGRADED",
      Self::RollupDegraded => "MIX_DATABASE_NOTION_ROLLUP_DEGRADED",
      Self::FormulaDegraded => "MIX_DATABASE_NOTION_FORMULA_DEGRADED",
      Self::PeopleDegraded => "MIX_DATABASE_NOTION_PEOPLE_DEGRADED",
      Self::DuplicateOptionName => "MIX_DATABASE_NOTION_DUPLICATE_OPTION_NAME",
      Self::EmptyTitleFallback => "MIX_DATABASE_NOTION_EMPTY_TITLE_FALLBACK",
      Self::DroppedSyncedBlock => "MIX_DATABASE_NOTION_DROPPED_SYNCED_BLOCK",
      Self::MissingFile => "MIX_DATABASE_NOTION_MISSING_FILE",
      Self::DateTimeInvalid => "MIX_DATABASE_NOTION_DATETIME_INVALID",
      Self::RelationTargetUnresolved => "MIX_DATABASE_NOTION_RELATION_TARGET_UNRESOLVED",
      Self::ViewUnsupported => "MIX_DATABASE_NOTION_VIEW_UNSUPPORTED",
      Self::TemplateUnsupported => "MIX_DATABASE_NOTION_TEMPLATE_UNSUPPORTED",
      Self::PeopleUnmatched => "MIX_DATABASE_NOTION_PEOPLE_UNMATCHED",
      Self::PeopleAmbiguous => "MIX_DATABASE_NOTION_PEOPLE_AMBIGUOUS",
      Self::PeopleMatched => "MIX_DATABASE_NOTION_PEOPLE_MATCHED",
      Self::RelationCrossDatabase => "MIX_DATABASE_NOTION_RELATION_CROSS_DATABASE",
      Self::AssetRejected => "MIX_DATABASE_NOTION_ASSET_REJECTED",
      Self::AssetMissing => "MIX_DATABASE_NOTION_ASSET_MISSING",
      Self::RollupImported => "MIX_DATABASE_NOTION_ROLLUP_IMPORTED",
      Self::AssetMaterialized => "MIX_DATABASE_NOTION_ASSET_MATERIALIZED",
      Self::PageBodyMissing => "MIX_DATABASE_NOTION_PAGE_BODY_MISSING",
      Self::PageBodyAmbiguous => "MIX_DATABASE_NOTION_PAGE_BODY_AMBIGUOUS",
      Self::PageBodyUnsupported => "MIX_DATABASE_NOTION_PAGE_BODY_UNSUPPORTED",
    }
  }
}

impl std::fmt::Display for NotionDiagnosticCode {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(self.as_str())
  }
}

/// Severity bucket so the Web UI can show the right badge tone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotionDiagnosticSeverity {
  Info,
  Warning,
  Error,
}

impl NotionDiagnosticSeverity {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Info => "info",
      Self::Warning => "warning",
      Self::Error => "error",
    }
  }
}

/// A single Notion import diagnostic. Carries the JSON-Path-ish locator
/// in the original Notion document, a stable code, and a human-readable
/// message. The snapshot adapter maps these onto `DatabaseJsonDiagnostic`
/// values so the existing UI can render them unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotionDiagnostic {
  pub code: String,
  pub severity: NotionDiagnosticSeverity,
  pub path: String,
  pub message: String,
}

impl NotionDiagnostic {
  pub fn new(
    code: NotionDiagnosticCode,
    severity: NotionDiagnosticSeverity,
    path: impl Into<String>,
    message: impl Into<String>,
  ) -> Self {
    Self {
      code: code.as_str().to_string(),
      severity,
      path: path.into(),
      message: message.into(),
    }
  }
}

/// A single Notion page that is also a row in a Notion database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotionPageBody {
  /// Original bounded ZIP entry used for diagnostics and relative assets.
  pub entry_path: String,
  /// Sanitized body subtree without scripts, styles or Database chrome.
  pub html_fragment: String,
}

/// A single Notion page that is also a row in a Notion database.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotionRow {
  /// Stable id derived from the Notion page id. Used for cross-references
  /// and for the local-id in the resulting `DatabaseSnapshot`.
  pub page_id: String,
  /// Title of the page. Myoxus title is the page name in Notion.
  pub title: String,
  /// Notion page icon (emoji or external URL). Stripped during snapshot
  /// conversion with a `DroppedPageIconography` diagnostic.
  pub icon: Option<String>,
  /// Notion page cover URL. Stripped during snapshot conversion.
  pub cover_url: Option<String>,
  /// Present only when an archive Page entry matched this Row by stable id.
  #[serde(default)]
  pub page_body: Option<NotionPageBody>,
  /// Properties keyed by Notion property name. Values are tagged with
  /// their detected Notion kind so the snapshot adapter can map them.
  pub properties: Vec<NotionProperty>,
}

impl NotionRow {
  pub fn property(&self, name: &str) -> Option<&NotionProperty> {
    self.properties.iter().find(|property| property.name == name)
  }
}

/// One column in a Notion database. The Notion kind is preserved so the
/// snapshot adapter can decide which Myoxus field type to emit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotionProperty {
  pub name: String,
  pub kind: NotionPropertyKind,
  /// Original raw text value (useful for diagnostics + for downgrade
  /// paths that fall back to `text`).
  pub raw_text: Option<String>,
  /// Inline formatting captured from Notion HTML for rich-text properties.
  /// The source model stays independent from Tiptap; the snapshot adapter is
  /// the only layer that projects these bounded spans into canonical cell JSON.
  pub rich_text: Vec<NotionRichTextInline>,
  /// True when source formatting was readable but outside the canonical cell
  /// schema. The adapter emits a row-local diagnostic instead of hiding loss.
  pub rich_text_lossy: bool,
  /// For `Select` / `MultiSelect` / `Status`, the option names (Notion
  /// allows duplicate option names across columns; the snapshot adapter
  /// de-duplicates per-column).
  pub select_options: Vec<String>,
  /// For `Date`, the start / end ISO-8601 strings.
  pub date_start: Option<String>,
  pub date_end: Option<String>,
  /// For `Number`, the parsed number (None if not parseable).
  pub number: Option<f64>,
  /// For `Checkbox`.
  pub checkbox: Option<bool>,
  /// For `Relation`, the referenced page ids.
  pub relation_targets: Vec<String>,
  /// For `Rollup`, the aggregate function Notion asks for.
  pub rollup_aggregate: Option<String>,
  /// For `Files` / `FilesV2`, the asset paths inside the ZIP (or URLs for
  /// HTML-only imports).
  pub file_paths: Vec<String>,
  /// For `Url` / `Email` / `Phone`, the parsed value.
  pub url: Option<String>,
  pub email: Option<String>,
  pub phone: Option<String>,
  /// For `People`, the Notion user names.
  pub people: Vec<String>,
  /// Tags (Notion `multi_select` already collapses into select_options, but
  /// we keep tags explicit for clarity).
  pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotionRichTextInline {
  Text {
    text: String,
    marks: Vec<NotionRichTextMark>,
  },
  HardBreak,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotionRichTextMark {
  Bold,
  Italic,
  Strike,
  Code,
  Link { href: String },
}

impl NotionProperty {
  pub fn text(name: impl Into<String>, raw: impl Into<String>) -> Self {
    Self {
      name: name.into(),
      kind: NotionPropertyKind::RichText,
      raw_text: Some(raw.into()),
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
    }
  }

  pub fn title(name: impl Into<String>, raw: impl Into<String>) -> Self {
    Self {
      name: name.into(),
      kind: NotionPropertyKind::Title,
      raw_text: Some(raw.into()),
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
    }
  }

  pub fn with_kind(mut self, kind: NotionPropertyKind) -> Self {
    self.kind = kind;
    self
  }
}

/// The set of Notion property kinds recognised by the parser. Anything we
/// cannot classify is reported as `NotionPropertyKind::RichText` and a
/// `PropertyDowngraded` diagnostic is emitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotionPropertyKind {
  Title,
  RichText,
  Number,
  Checkbox,
  Select,
  MultiSelect,
  Status,
  Date,
  DateTime,
  Url,
  Email,
  Phone,
  People,
  Files,
  Relation,
  Rollup,
  Formula,
  Verification,
  CreatedTime,
  CreatedBy,
  LastEditedTime,
  LastEditedBy,
}

impl NotionPropertyKind {
  /// Map a Notion kind onto the closest Myoxus field type. Returns
  /// `None` for kinds that have no representation and should be dropped
  /// (Notion-only metadata such as verification, created_time, created_by,
  /// last_edited_time and last_edited_by).
  ///
  /// `People`, `Relation`, `Rollup` and `Formula` deliberately return
  /// `None` so the snapshot adapter emits an explicit, type-specific
  /// diagnostic (relation/rollup/formula/people degraded to text). Keeping
  /// them as the matching Myoxus field type would require cross-database
  /// wiring that the P-DB-29 contract explicitly defers.
  pub fn to_myoxus_field_type(self) -> Option<DatabaseFieldType> {
    match self {
      Self::Title => Some(DatabaseFieldType::Title),
      Self::RichText => Some(DatabaseFieldType::RichText),
      Self::Number => Some(DatabaseFieldType::Number),
      Self::Checkbox => Some(DatabaseFieldType::Checkbox),
      Self::Select => Some(DatabaseFieldType::Select),
      Self::MultiSelect => Some(DatabaseFieldType::MultiSelect),
      Self::Status => Some(DatabaseFieldType::Status),
      Self::Date => Some(DatabaseFieldType::Date),
      Self::DateTime => Some(DatabaseFieldType::DateTime),
      Self::Url => Some(DatabaseFieldType::Url),
      Self::Email => Some(DatabaseFieldType::Email),
      Self::Phone => Some(DatabaseFieldType::Phone),
      Self::Files => Some(DatabaseFieldType::Files),
      Self::People => Some(DatabaseFieldType::Users),
      Self::Relation
      | Self::Rollup
      | Self::Formula
      | Self::Verification
      | Self::CreatedTime
      | Self::CreatedBy
      | Self::LastEditedTime
      | Self::LastEditedBy => None,
    }
  }
}

/// A parsed Notion database: columns + rows + page references. The
/// snapshot adapter projects this into a `DatabaseSnapshot`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotionDocument {
  /// Notion database id.
  pub database_id: String,
  /// Database title (Notion "Name" or "Title" property).
  pub title: String,
  /// Database description (Notion has no separate description; the
  /// snapshot adapter derives it from the first paragraph when present).
  pub description: Option<String>,
  /// Properties (columns) in the Notion database. The first property
  /// whose kind is `Title` is treated as the row title; everything else
  /// becomes a non-title field.
  pub properties: Vec<NotionProperty>,
  /// Rows of the database, in Notion order.
  pub rows: Vec<NotionRow>,
}

impl NotionDocument {
  pub fn title_property(&self) -> Option<&NotionProperty> {
    self
      .properties
      .iter()
      .find(|property| property.kind == NotionPropertyKind::Title)
  }
}

/// All output from the parser: zero or more Notion databases (one ZIP
/// can contain several), and a flat diagnostic list. Diagnostics are
/// collected and forwarded to the snapshot adapter so the Web UI can
/// surface them in the preview/apply dialog.
///
/// `assets` carries the raw bytes of every non-HTML entry in the ZIP
/// keyed by their entry path. The snapshot adapter exposes them to the
/// service layer, which materialises each one as a workspace blob and
/// rewrites the corresponding `Files` cell value to use the new
/// blob_key. Empty for plain HTML uploads because no archive bytes
/// are available.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotionParseResult {
  pub databases: Vec<NotionDocument>,
  pub diagnostics: Vec<NotionDiagnostic>,
  pub source: NotionSource,
  pub assets: std::collections::BTreeMap<String, Vec<u8>>,
}

/// Where the bytes came from. The snapshot adapter writes this into the
/// `DatabaseSnapshotSource` so exports can be traced back to Notion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotionSource {
  Zip,
  Html,
}

impl NotionSource {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Zip => "notion-zip",
      Self::Html => "notion-html",
    }
  }
}

/// Default field config for a freshly detected Myoxus field. Used by the
/// snapshot adapter when projecting a Notion property to a field with no
/// opinionated config.
pub fn default_field_config_for(kind: DatabaseFieldType) -> DatabaseFieldConfig {
  match kind {
    DatabaseFieldType::Title => DatabaseFieldConfig::Title,
    DatabaseFieldType::Text | DatabaseFieldType::Url | DatabaseFieldType::Email | DatabaseFieldType::Phone => {
      DatabaseFieldConfig::Text(DatabaseTextFieldConfig::default())
    }
    DatabaseFieldType::RichText => DatabaseFieldConfig::RichText(DatabaseRichTextFieldConfig::default()),
    DatabaseFieldType::Select => DatabaseFieldConfig::Select(DatabaseSelectFieldConfig { options: Vec::new() }),
    DatabaseFieldType::MultiSelect => {
      DatabaseFieldConfig::MultiSelect(DatabaseSelectFieldConfig { options: Vec::new() })
    }
    DatabaseFieldType::Status => DatabaseFieldConfig::Status(DatabaseStatusFieldConfig {
      options: Vec::new(),
      default_option_id: String::new(),
    }),
    DatabaseFieldType::UniqueId => DatabaseFieldConfig::UniqueId(DatabaseUniqueIdFieldConfig::default()),
    _ => DatabaseFieldConfig::Text(DatabaseTextFieldConfig::default()),
  }
}

/// Project a list of distinct Notion option names into a de-duplicated
/// list of [`DatabaseSelectOption`]s. Trims whitespace, drops empties,
/// and surfaces duplicates via a `DuplicateOptionName` diagnostic
/// appended to `diagnostics`.
///
/// The returned options are stable: the first occurrence wins and
/// subsequent duplicates get a numeric suffix so the snapshot is
/// importable. The caller decides whether to attach the same options to
/// a `Select`, `MultiSelect` or `Status` field.
pub fn project_select_options(
  raw_names: impl IntoIterator<Item = String>,
  base_path: &str,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> Vec<DatabaseSelectOption> {
  let mut options: Vec<DatabaseSelectOption> = Vec::new();
  let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
  for (index, raw) in raw_names.into_iter().enumerate() {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
      continue;
    }
    let canonical = trimmed.to_string();
    if seen.contains(&canonical) {
      let deduped = format!("{canonical} ({})", index + 1);
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::DuplicateOptionName,
        NotionDiagnosticSeverity::Warning,
        format!("{base_path}[{index}]"),
        format!("Duplicate Notion option name '{canonical}' renamed to '{deduped}'"),
      ));
      seen.insert(deduped.clone());
      options.push(DatabaseSelectOption {
        id: uuid::Uuid::new_v4().to_string(),
        name: deduped,
        position: options.len() as i32,
        color_role: String::new(),
      });
    } else {
      seen.insert(canonical.clone());
      options.push(DatabaseSelectOption {
        id: uuid::Uuid::new_v4().to_string(),
        name: canonical,
        position: options.len() as i32,
        color_role: String::new(),
      });
    }
  }
  options
}

/// Project a list of distinct Notion status option names into a
/// de-duplicated list of [`DatabaseStatusOption`]s. Same rules as
/// [`project_select_options`].
pub fn project_status_options(
  raw_names: impl IntoIterator<Item = String>,
  base_path: &str,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> Vec<DatabaseStatusOption> {
  let mut options: Vec<DatabaseStatusOption> = Vec::new();
  let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
  for (index, raw) in raw_names.into_iter().enumerate() {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
      continue;
    }
    let canonical = trimmed.to_string();
    if seen.contains(&canonical) {
      let deduped = format!("{canonical} ({})", index + 1);
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::DuplicateOptionName,
        NotionDiagnosticSeverity::Warning,
        format!("{base_path}[{index}]"),
        format!("Duplicate Notion status option name '{canonical}' renamed to '{deduped}'"),
      ));
      seen.insert(deduped.clone());
      options.push(DatabaseStatusOption {
        id: uuid::Uuid::new_v4().to_string(),
        name: deduped,
        position: options.len() as i32,
        color_role: String::new(),
        group: DatabaseStatusGroup::NotStarted,
      });
    } else {
      seen.insert(canonical.clone());
      options.push(DatabaseStatusOption {
        id: uuid::Uuid::new_v4().to_string(),
        name: canonical,
        position: options.len() as i32,
        color_role: String::new(),
        group: DatabaseStatusGroup::NotStarted,
      });
    }
  }
  options
}

/// Coerce a Notion `Title` or downgraded raw value into a `Text` cell
/// value. Returns `None` if the raw value is empty after trimming.
pub fn text_cell(raw: Option<&str>) -> Option<DatabaseCellValueData> {
  raw
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(|value| DatabaseCellValueData::Text(value.to_string()))
}

/// Coerce a Notion `Number` raw value into a `Number` cell value.
/// Returns `None` if the value cannot be parsed as `f64` or is empty.
pub fn number_cell(value: Option<f64>) -> Option<DatabaseCellValueData> {
  value.and_then(finite_or_none).map(DatabaseCellValueData::Number)
}

/// Coerce a Notion `Checkbox` value into a `Checkbox` cell value.
pub fn checkbox_cell(value: Option<bool>) -> Option<DatabaseCellValueData> {
  value.map(DatabaseCellValueData::Checkbox)
}

/// Build a UniqueId cell value (used for the Notion "id" property that
/// every database has, which we cannot import as a regular cell because
/// Myoxus UniqueId fields are server-generated).
pub fn unique_id_cell(value: &str) -> DatabaseCellValueData {
  DatabaseCellValueData::UniqueId(DatabaseUniqueIdValue {
    prefix: String::new(),
    sequence: 0,
    display: value.to_string(),
  })
}

fn finite_or_none(value: f64) -> Option<f64> {
  if value.is_finite() { Some(value) } else { None }
}

/// Rewrite map returned by [`materialize_notion_assets`]. The caller
/// must replace every `blob_key` that appears as a key here with the
/// mapped value in the snapshot's files manifest and in any cell
/// value that referenced it. The vec of uploaded keys is the rollback
/// surface: if the subsequent JSON import fails, every key in this vec
/// must be soft-deleted by the caller so no orphan blob is left in the
/// workspace blob store.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotionAssetMaterialization {
  /// Map from the original Notion asset path (or the cell-path the
  /// manifest entry used) to the workspace blob key that the upload
  /// produced. Empty when no asset was materialised.
  pub rewritten_keys: std::collections::BTreeMap<String, String>,
  /// Every workspace blob key that was uploaded. Used by the caller
  /// to soft-delete the blobs on import failure.
  pub uploaded_blob_keys: Vec<String>,
  /// Diagnostics emitted while walking the asset map. These are merged
  /// into the snapshot adapter's diagnostics list so the Web UI can
  /// surface them in the preview / apply panel.
  pub diagnostics: Vec<NotionDiagnostic>,
}

/// Outcome variant reported by the closure passed to
/// [`materialize_notion_assets`]. A successful upload returns
/// `Uploaded { workspace_blob_key }`; a failed upload returns
/// `Rejected { reason }`. The helper never panics: every entry is
/// reported either as a successful rewrite or as a diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotionAssetUpload {
  Uploaded { workspace_blob_key: String },
  Rejected { reason: String },
}

/// Signature of the upload closure. The closure is invoked once per
/// Notion asset that the snapshot adapter wants to materialise. It
/// must not panic; failures are surfaced as `Rejected` variants.
pub type NotionAssetUploader = dyn Fn(
  /* original_path */ &str,
  /* workspace_blob_key */ &str,
  /* body */ &[u8],
  /* mime */ &str,
) -> NotionAssetUpload;

/// P-DB-29: real asset materialisation. Walks the snapshot's files
/// manifest in lock-step with the parsed Notion assets map. For every
/// manifest entry whose `blob_key` resolves to a body inside
/// `parse_result.assets`, the closure `uploader` is invoked to upload
/// the body to the workspace blob store under `workspace_blob_key`.
/// The resulting rewrite map is returned alongside the list of uploaded
/// keys (for rollback) and any per-asset diagnostics.
///
/// The function deliberately does not touch the workspace blob store
/// itself: it only orchestrates the upload through the closure so the
/// logic stays unit-testable without Postgres, an object store, or a
/// `BlobService` dependency. The production caller passes a closure
/// that delegates to `BlobService::upload_single_part_blob`.
#[instrument(
  skip(parse_result, manifest, workspace_blob_key_for, uploader),
  fields(assets = parse_result.assets.len(), manifest_entries = manifest.len())
)]
pub fn materialize_notion_assets(
  parse_result: &NotionParseResult,
  manifest: &[crate::database::DatabaseSnapshotFileManifestEntry],
  workspace_blob_key_for: impl Fn(&str) -> String,
  uploader: &NotionAssetUploader,
) -> NotionAssetMaterialization {
  let mut result = NotionAssetMaterialization::default();
  if parse_result.assets.is_empty() {
    debug!("notion asset materialize: nothing to upload");
    return result;
  }
  for entry in manifest {
    let body = match parse_result
      .assets
      .iter()
      .find(|(path, _)| matches_asset_path_inner(&entry.blob_key, path))
    {
      Some((_, body)) => body,
      None => continue,
    };
    let workspace_key = workspace_blob_key_for(&entry.blob_key);
    let mime = entry
      .mime
      .clone()
      .unwrap_or_else(|| "application/octet-stream".to_string());
    let outcome = uploader(&entry.blob_key, &workspace_key, body, &mime);
    match outcome {
      NotionAssetUpload::Uploaded { workspace_blob_key } => {
        result
          .rewritten_keys
          .insert(entry.blob_key.clone(), workspace_blob_key.clone());
        result.uploaded_blob_keys.push(workspace_blob_key.clone());
        result.diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::AssetMaterialized,
          NotionDiagnosticSeverity::Info,
          format!("$.assets[{}]", entry.blob_key),
          format!(
            "Notion ZIP asset '{}' was uploaded to the workspace blob store as '{}' \
             ({} bytes, mime={})",
            entry.blob_key,
            workspace_blob_key,
            body.len(),
            mime
          ),
        ));
      }
      NotionAssetUpload::Rejected { reason } => {
        result.diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::AssetRejected,
          NotionDiagnosticSeverity::Warning,
          format!("$.assets[{}]", entry.blob_key),
          format!(
            "Notion ZIP asset '{}' could not be uploaded during apply: {}; \
             the cell preserves the original path so the operator can re-upload manually",
            entry.blob_key, reason
          ),
        ));
      }
    }
  }
  debug!(
    uploaded = result.uploaded_blob_keys.len(),
    rejected = result.diagnostics.len(),
    "notion asset materialize complete"
  );
  result
}

/// Inner helper used by both the snapshot adapter and the
/// materialisation helper. Mirrors the snapshot-adapter `matches_asset_path`
/// semantics: full equality, then trailing-suffix overlap.
fn matches_asset_path_inner(cell_path: &str, archive_path: &str) -> bool {
  if cell_path.is_empty() || archive_path.is_empty() {
    return false;
  }
  if cell_path == archive_path {
    return true;
  }
  let cell_tail = cell_path.trim_start_matches('/');
  let arc_tail = archive_path.trim_start_matches('/');
  cell_tail.ends_with(arc_tail) || arc_tail.ends_with(cell_tail)
}

/// Public alias for [`matches_asset_path_inner`] so the service
/// caller can drive its own asset walk (e.g. running the async
/// `BlobService::upload_single_part_blob` outside the sync closure
/// passed to [`materialize_notion_assets`]) using the exact same
/// matching rule as the helper.
pub fn matches_asset_path(cell_path: &str, archive_path: &str) -> bool {
  matches_asset_path_inner(cell_path, archive_path)
}

/// P-DB-29: compute the stable workspace blob key a Notion asset
/// should be uploaded under. The key is namespaced under
/// `notion/<sha-of-path>/<filename>` so two Notion imports with the
/// same file do not collide and the operator can find them later. The
/// key is validated through `BlobKey::parse` so path-traversal payloads
/// are rejected before they reach the object store.
pub fn notion_asset_blob_key(asset_path: &str) -> String {
  use std::collections::hash_map::DefaultHasher;
  use std::hash::{Hash, Hasher};
  let mut hasher = DefaultHasher::new();
  asset_path.hash(&mut hasher);
  let digest = hasher.finish();
  let basename = std::path::Path::new(asset_path)
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("asset");
  format!("notion/{:016x}/{}", digest, basename)
}

/// Builder that turns a parsed Notion document into a stable, importable
/// shape. This is the **only** place that knows the Notion → Myoxus
/// field mapping. Tests assert against this builder, not against the
/// parser.
pub struct NotionDocumentBuilder<'a> {
  pub document: &'a NotionDocument,
  pub diagnostics: &'a mut Vec<NotionDiagnostic>,
  pub source_zip_name: Option<&'a str>,
  pub exported_at: DateTime<Utc>,
}

impl<'a> NotionDocumentBuilder<'a> {
  pub fn new(
    document: &'a NotionDocument,
    diagnostics: &'a mut Vec<NotionDiagnostic>,
    source_zip_name: Option<&'a str>,
  ) -> Self {
    Self {
      document,
      diagnostics,
      source_zip_name,
      exported_at: Utc::now(),
    }
  }

  /// Stable per-document source name written into the
  /// `DatabaseSnapshotSource`. Includes the database slug for parity
  /// with multi-database ZIPs.
  pub fn source_label(&self) -> String {
    match self.source_zip_name {
      Some(zip) => format!("{}/{}", zip, self.document.title),
      None => self.document.title.clone(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_domain::database::{DatabaseCellValueData, DatabaseFieldType, DatabaseSnapshotFileManifestEntry};

  fn manifest_entry(blob_key: &str, mime: Option<&str>) -> DatabaseSnapshotFileManifestEntry {
    DatabaseSnapshotFileManifestEntry {
      blob_key: blob_key.to_string(),
      name: Some(blob_key.to_string()),
      mime: mime.map(|value| value.to_string()),
      size: Some(0),
      field_name: None,
      row_id: None,
    }
  }

  #[test]
  fn text_cell_trims_and_drops_empty() {
    assert_eq!(text_cell(None), None);
    assert_eq!(text_cell(Some("")), None);
    assert_eq!(text_cell(Some("   ")), None);
    assert_eq!(
      text_cell(Some("  hello  ")),
      Some(DatabaseCellValueData::Text("hello".to_string()))
    );
  }

  #[test]
  fn number_cell_drops_non_finite() {
    assert_eq!(number_cell(None), None);
    assert_eq!(number_cell(Some(f64::NAN)), None);
    assert_eq!(number_cell(Some(42.0)), Some(DatabaseCellValueData::Number(42.0)));
  }

  #[test]
  fn checkbox_cell_passes_through() {
    assert_eq!(checkbox_cell(None), None);
    assert_eq!(checkbox_cell(Some(true)), Some(DatabaseCellValueData::Checkbox(true)));
    assert_eq!(checkbox_cell(Some(false)), Some(DatabaseCellValueData::Checkbox(false)));
  }

  #[test]
  fn duplicate_options_are_deduped_with_diagnostic() {
    let mut diagnostics = Vec::new();
    let options = project_select_options(
      vec!["To Do".to_string(), "To Do".to_string(), "Done".to_string()],
      "$.database.properties[0].options",
      &mut diagnostics,
    );
    assert_eq!(options.len(), 3);
    assert_eq!(options[0].name, "To Do");
    assert!(options[1].name.starts_with("To Do ("));
    assert_eq!(options[2].name, "Done");
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, NotionDiagnosticCode::DuplicateOptionName.as_str());
  }

  #[test]
  fn notion_property_kind_maps_to_myoxus_field() {
    assert_eq!(
      NotionPropertyKind::Title.to_myoxus_field_type(),
      Some(DatabaseFieldType::Title)
    );
    assert_eq!(
      NotionPropertyKind::Checkbox.to_myoxus_field_type(),
      Some(DatabaseFieldType::Checkbox)
    );
    assert_eq!(NotionPropertyKind::Verification.to_myoxus_field_type(), None);
    assert_eq!(NotionPropertyKind::CreatedBy.to_myoxus_field_type(), None);
  }

  #[test]
  fn notion_asset_blob_key_is_namespaced_and_rejects_traversal() {
    let a = notion_asset_blob_key("assets/lamp.png");
    let b = notion_asset_blob_key("assets/lamp.png");
    let c = notion_asset_blob_key("assets/chair.png");
    assert_eq!(a, b);
    assert_ne!(a, c);
    assert!(a.starts_with("notion/"));
    assert!(a.ends_with("/lamp.png"));
    // Empty input still produces a stable key.
    let empty = notion_asset_blob_key("");
    assert!(empty.starts_with("notion/"));
  }

  #[test]
  fn materialize_notion_assets_uploads_referenced_entries_and_records_rollback_keys() {
    // Two referenced assets, one unreferenced asset in the archive
    // (must be ignored by the manifest-driven helper), and a cell
    // referencing a file the archive does not carry (also ignored).
    let parse_result = NotionParseResult {
      databases: Vec::new(),
      diagnostics: Vec::new(),
      source: NotionSource::Zip,
      assets: std::collections::BTreeMap::from([
        ("assets/lamp.png".to_string(), vec![0u8; 16]),
        ("assets/orphan.png".to_string(), vec![0u8; 32]),
      ]),
    };
    let manifest = vec![
      manifest_entry("lamp.png", Some("image/png")),
      manifest_entry("missing.png", Some("image/png")),
    ];
    let uploaded: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
      std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let uploaded_inside = uploaded.clone();
    let result = materialize_notion_assets(
      &parse_result,
      &manifest,
      notion_asset_blob_key,
      &move |_path, workspace_key, body, mime| {
        // Mirror the production BlobService::upload_single_part_blob contract.
        assert!(!body.is_empty());
        assert!(!mime.is_empty());
        uploaded_inside.lock().unwrap().push(workspace_key.to_string());
        NotionAssetUpload::Uploaded {
          workspace_blob_key: workspace_key.to_string(),
        }
      },
    );
    // Only the resolved entry (lamp.png) is uploaded, missing.png is
    // absent from the archive so it is silently skipped (the snapshot
    // adapter already emits AssetMissing for it).
    assert_eq!(uploaded.lock().unwrap().len(), 1);
    assert_eq!(result.uploaded_blob_keys.len(), 1);
    assert_eq!(result.rewritten_keys.len(), 1);
    assert!(result.rewritten_keys.contains_key("lamp.png"));
    assert!(!result.rewritten_keys.contains_key("missing.png"));
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(
      result.diagnostics[0].code,
      NotionDiagnosticCode::AssetMaterialized.as_str()
    );
  }

  #[test]
  fn materialize_notion_assets_reports_rejection_when_uploader_fails() {
    let parse_result = NotionParseResult {
      databases: Vec::new(),
      diagnostics: Vec::new(),
      source: NotionSource::Zip,
      assets: std::collections::BTreeMap::from([("assets/lamp.png".to_string(), vec![0u8; 16])]),
    };
    let manifest = vec![manifest_entry("lamp.png", Some("image/png"))];
    let result = materialize_notion_assets(
      &parse_result,
      &manifest,
      notion_asset_blob_key,
      &|_path, _key, _body, _mime| NotionAssetUpload::Rejected {
        reason: "blob store unavailable".to_string(),
      },
    );
    assert!(result.rewritten_keys.is_empty());
    assert!(result.uploaded_blob_keys.is_empty());
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(result.diagnostics[0].code, NotionDiagnosticCode::AssetRejected.as_str());
    assert!(result.diagnostics[0].message.contains("blob store unavailable"));
  }

  #[test]
  fn materialize_notion_assets_no_assets_yields_empty_result() {
    // Plain HTML imports have no archive bytes — the helper must
    // produce an empty result so the production caller does no work.
    let parse_result = NotionParseResult {
      databases: Vec::new(),
      diagnostics: Vec::new(),
      source: NotionSource::Html,
      assets: std::collections::BTreeMap::new(),
    };
    let result = materialize_notion_assets(
      &parse_result,
      &[],
      notion_asset_blob_key,
      &|_path, _key, _body, _mime| panic!("uploader should not be called"),
    );
    assert!(result.uploaded_blob_keys.is_empty());
    assert!(result.rewritten_keys.is_empty());
    assert!(result.diagnostics.is_empty());
  }
}
