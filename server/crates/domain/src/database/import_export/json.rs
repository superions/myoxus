// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::database::views;
use crate::database::{
  DatabaseCalendarDateMode, DatabaseCalendarInitialRange, DatabaseCardDensity, DatabaseCellValueData,
  DatabaseFieldConfig, DatabaseFieldType, DatabaseFilterConjunction, DatabaseFilterOperator, DatabaseFilterValue,
  DatabaseFormulaResultType, DatabaseFormulaStalePolicy, DatabaseGalleryCardDensity, DatabaseListDensity,
  DatabaseManagedTemplateSource, DatabaseProfileKind, DatabaseRecord, DatabaseRollupAggregate,
  DatabaseRollupScalarValue, DatabaseRollupStalePolicy, DatabaseRowKind, DatabaseSortDirection,
  DatabaseTimelineGroupBy, DatabaseTimelineOrder, DatabaseTimelineZoom, DatabaseViewIcon, DatabaseViewKind,
};
use crate::ids::{DatabaseFieldId, DatabaseId, DocId, WorkspaceId};
use crate::template_registry::TemplateCatalogEntryId;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

pub const DATABASE_SNAPSHOT_SCHEMA_VERSION: u32 = 4;

/// Portable, server-authored Database snapshot envelope.
///
/// Snapshot IDs are export-local strings. Import must allocate fresh server
/// IDs and remap every field/view/row reference through those local IDs instead
/// of trusting server IDs from a different workspace or installation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshot {
  pub schema_version: u32,
  pub exported_at: DateTime<Utc>,
  pub source: DatabaseSnapshotSource,
  pub database: DatabaseSnapshotDatabase,
  #[serde(default)]
  pub databases: Vec<DatabaseSnapshotDatabase>,
  /// P-DB-28: every blob referenced from a `Files` cell across all
  /// snapshot rows / templates. Import uses this to surface missing
  /// media references via `MIX_JSON_IMPORT_MISSING_FILE`.
  #[serde(default)]
  pub files_manifest: Vec<DatabaseSnapshotFileManifestEntry>,
  /// Canonical tag records referenced by `Tags` cells. Cell values retain
  /// stable source ids; import maps them to the target workspace catalog only
  /// after preview has reported every create/reuse/archive decision.
  #[serde(default)]
  pub workspace_tags_manifest: Vec<DatabaseSnapshotWorkspaceTag>,
  /// Structured fidelity and ACL diagnostics produced during export.
  #[serde(default)]
  pub diagnostics: Vec<DatabaseJsonDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotWorkspaceTag {
  pub id: Uuid,
  pub name: String,
  pub slug: String,
  pub color_role: String,
  #[serde(default)]
  pub archived: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseWorkspaceTagImportAction {
  Create,
  Reuse,
  ArchivedReference,
  Rejected,
}

/// Exact tag decision shared by import preview and apply results.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseWorkspaceTagImportDiagnostic {
  pub source_id: Option<Uuid>,
  pub target_id: Option<Uuid>,
  pub name: String,
  pub slug: String,
  pub source_color: Option<String>,
  pub color_role: String,
  pub action: DatabaseWorkspaceTagImportAction,
  pub affected_rows: Vec<i32>,
  pub affected_fields: Vec<String>,
  pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotSource {
  pub product: String,
  pub format: String,
  pub database_id: Option<String>,
  pub exported_by: Option<String>,
}

fn default_database_profile_config() -> Value {
  serde_json::json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotDatabase {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub managed_template: Option<DatabaseManagedTemplateSource>,
  pub id: String,
  #[serde(default)]
  pub profile_kind: DatabaseProfileKind,
  #[serde(default)]
  pub profile_structure_preset: Option<String>,
  #[serde(default = "default_database_profile_config")]
  pub profile_config: Value,
  pub title: String,
  pub description: Option<String>,
  pub fields: Vec<DatabaseSnapshotField>,
  pub views: Vec<DatabaseSnapshotView>,
  #[serde(default)]
  pub field_roles: Vec<DatabaseSnapshotFieldRole>,
  #[serde(default)]
  pub view_roles: Vec<DatabaseSnapshotViewRole>,
  pub rows: Vec<DatabaseSnapshotRow>,
  #[serde(default)]
  pub row_templates: Vec<DatabaseSnapshotRowTemplate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotFieldRole {
  pub profile_kind: DatabaseProfileKind,
  pub role_key: String,
  pub row_kind_scope: Option<String>,
  pub field_id: String,
  pub required: bool,
  #[serde(default)]
  pub config: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotViewRole {
  pub profile_kind: DatabaseProfileKind,
  pub role_key: String,
  pub view_id: String,
  pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotField {
  pub id: String,
  pub name: String,
  pub field_type: DatabaseFieldType,
  pub config: DatabaseSnapshotFieldConfig,
  pub position: i32,
  pub required: bool,
  pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DatabaseSnapshotFieldConfig {
  Domain(DatabaseFieldConfig),
  Relation(DatabaseSnapshotRelationFieldConfig),
  Rollup(DatabaseSnapshotRollupFieldConfig),
  Formula(DatabaseSnapshotFormulaFieldConfig),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotRelationFieldConfig {
  pub target_database_id: String,
  #[serde(default)]
  pub allow_multiple: bool,
  pub reciprocal_field_id: Option<String>,
  pub max_targets: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotRollupFieldConfig {
  pub source_relation_field_id: String,
  pub target_field_id: String,
  pub aggregate: DatabaseRollupAggregate,
  pub empty_value: Option<DatabaseRollupScalarValue>,
  pub stale_policy: DatabaseRollupStalePolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotFormulaFieldConfig {
  pub expression: String,
  pub result_type: DatabaseFormulaResultType,
  #[serde(default)]
  pub dependency_field_ids: Vec<String>,
  pub stale_policy: DatabaseFormulaStalePolicy,
  pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotView {
  pub id: String,
  pub name: String,
  pub view_kind: DatabaseViewKind,
  pub icon: Option<DatabaseViewIcon>,
  pub config: DatabaseSnapshotViewConfig,
  pub position: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseSnapshotViewConfig {
  Table(DatabaseSnapshotTableViewConfig),
  Kanban(DatabaseSnapshotKanbanViewConfig),
  List(DatabaseSnapshotListViewConfig),
  Gallery(DatabaseSnapshotGalleryViewConfig),
  Calendar(DatabaseSnapshotCalendarViewConfig),
  Timeline(DatabaseSnapshotTimelineViewConfig),
  Gantt(DatabaseSnapshotGanttViewConfig),
  Progress(DatabaseSnapshotProgressViewConfig),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotTableViewConfig {
  pub title_field_id: String,
  #[serde(default)]
  pub visible_field_ids: Vec<String>,
  #[serde(default)]
  pub field_widths: BTreeMap<String, i32>,
  #[serde(default)]
  pub search_field_ids: Vec<String>,
  #[serde(default)]
  pub sort: Vec<DatabaseSnapshotSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseSnapshotFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseSnapshotFilterGroup>,
  #[serde(default)]
  pub group: Option<DatabaseSnapshotGroupRule>,
  #[serde(default)]
  pub subgroup: Option<DatabaseSnapshotGroupRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotKanbanViewConfig {
  pub title_field_id: String,
  pub group_field_id: String,
  #[serde(default)]
  pub visible_field_ids: Vec<String>,
  pub cover_field_id: Option<String>,
  #[serde(default)]
  pub card_density: DatabaseCardDensity,
  #[serde(default)]
  pub sort: Vec<DatabaseSnapshotSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseSnapshotFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseSnapshotFilterGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotListViewConfig {
  pub title_field_id: String,
  #[serde(default)]
  pub visible_field_ids: Vec<String>,
  #[serde(default)]
  pub sort: Vec<DatabaseSnapshotSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseSnapshotFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseSnapshotFilterGroup>,
  #[serde(default)]
  pub density: DatabaseListDensity,
  #[serde(default = "views::default_show_field_labels")]
  pub show_field_labels: bool,
  #[serde(default)]
  pub group: Option<DatabaseSnapshotGroupRule>,
  #[serde(default)]
  pub subgroup: Option<DatabaseSnapshotGroupRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotGalleryViewConfig {
  pub title_field_id: String,
  #[serde(default)]
  pub visible_field_ids: Vec<String>,
  pub cover_field_id: Option<String>,
  #[serde(default)]
  pub sort: Vec<DatabaseSnapshotSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseSnapshotFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseSnapshotFilterGroup>,
  #[serde(default)]
  pub card_density: DatabaseGalleryCardDensity,
  #[serde(default = "views::default_show_empty_cover")]
  pub show_empty_cover: bool,
  #[serde(default)]
  pub group: Option<DatabaseSnapshotGroupRule>,
  #[serde(default)]
  pub subgroup: Option<DatabaseSnapshotGroupRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotCalendarViewConfig {
  pub title_field_id: String,
  pub date_field_id: String,
  #[serde(default)]
  pub visible_field_ids: Vec<String>,
  #[serde(default)]
  pub sort: Vec<DatabaseSnapshotSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseSnapshotFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseSnapshotFilterGroup>,
  #[serde(default)]
  pub date_mode: DatabaseCalendarDateMode,
  #[serde(default)]
  pub initial_range: DatabaseCalendarInitialRange,
  #[serde(default)]
  pub group: Option<DatabaseSnapshotGroupRule>,
  #[serde(default)]
  pub subgroup: Option<DatabaseSnapshotGroupRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotGroupRule {
  pub field_id: String,
  #[serde(default)]
  pub descending: bool,
  #[serde(default)]
  pub show_empty_groups: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotTimelineViewConfig {
  pub title_field_id: String,
  pub start_field_id: String,
  pub end_field_id: Option<String>,
  #[serde(default)]
  pub visible_field_ids: Vec<String>,
  #[serde(default)]
  pub sort: Vec<DatabaseSnapshotSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseSnapshotFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseSnapshotFilterGroup>,
  #[serde(default)]
  pub group_by: DatabaseTimelineGroupBy,
  #[serde(default)]
  pub order: DatabaseTimelineOrder,
  #[serde(default)]
  pub zoom: DatabaseTimelineZoom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotGanttViewConfig {
  pub title_field_id: String,
  pub start_field_id: String,
  pub end_field_id: Option<String>,
  #[serde(default)]
  pub visible_field_ids: Vec<String>,
  #[serde(default)]
  pub sort: Vec<DatabaseSnapshotSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseSnapshotFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseSnapshotFilterGroup>,
  #[serde(default)]
  pub group: Option<DatabaseSnapshotGroupRule>,
  #[serde(default)]
  pub zoom: DatabaseTimelineZoom,
  pub dependency_field_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotProgressViewConfig {
  pub title_field_id: String,
  pub progress_field_id: String,
  pub group_field_id: Option<String>,
  #[serde(default)]
  pub visible_field_ids: Vec<String>,
  #[serde(default)]
  pub sort: Vec<DatabaseSnapshotSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseSnapshotFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseSnapshotFilterGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotSortRule {
  pub field_id: String,
  pub direction: DatabaseSortDirection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotFilterRule {
  pub field_id: String,
  pub operator: DatabaseFilterOperator,
  pub value: DatabaseFilterValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotFilterGroup {
  #[serde(default)]
  pub conjunction: DatabaseFilterConjunction,
  #[serde(default)]
  pub rules: Vec<DatabaseSnapshotFilterRule>,
  #[serde(default)]
  pub groups: Vec<DatabaseSnapshotFilterGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotRow {
  pub id: String,
  #[serde(default)]
  pub row_kind: DatabaseRowKind,
  pub title: String,
  pub position: i32,
  /// Portable optional page content. The key is snapshot-local and must never
  /// be interpreted as a live workspace document id.
  #[serde(default)]
  pub content_document: Option<DatabaseSnapshotContentDocument>,
  /// Retained origin identity; private navigation and anchors require source Read.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub source: Option<DatabaseSnapshotTaskSource>,
  pub cells: Vec<DatabaseSnapshotCellValue>,
  #[serde(default)]
  pub projections: Vec<DatabaseSnapshotCellValue>,
}

/// Source association only: admission receipts and actor/request identities are never portable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotTaskSource {
  pub source_workspace_id: WorkspaceId,
  pub document_id: DocId,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub external_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub block_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub selection_anchor: Option<String>,
}

/// Portable Yjs content associated with a snapshot Row or Row template.
///
/// Live document ids and private blob keys are deliberately excluded. Links
/// and assets inside `yjs_update_base64` use the reserved snapshot URI schemes
/// until the importing workspace allocates their final identities.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotContentDocument {
  pub document_key: String,
  pub title: String,
  pub yjs_update_base64: String,
  #[serde(default)]
  pub asset_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotCellValue {
  pub field_id: String,
  pub field_type: DatabaseFieldType,
  pub value: DatabaseSnapshotCellValueData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum DatabaseSnapshotCellValueData {
  Domain(DatabaseCellValueData),
  Relation(Vec<String>),
  DocumentLink {
    doc_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_id: Option<WorkspaceId>,
  },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotRowTemplate {
  pub id: String,
  pub template_id: TemplateCatalogEntryId,
  #[serde(default)]
  pub row_kind: DatabaseRowKind,
  pub name: String,
  pub description: Option<String>,
  pub position: i32,
  pub enabled: bool,
  pub is_default: bool,
  #[serde(default)]
  pub content_document: Option<DatabaseSnapshotContentDocument>,
  #[serde(default)]
  pub initial_cell_values: BTreeMap<String, DatabaseSnapshotCellValueData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseJsonDiagnostic {
  pub code: String,
  pub source: String,
  pub path: Option<String>,
  pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseJsonPreview {
  pub schema_version: u32,
  pub schema_version_supported: bool,
  pub title: String,
  pub field_count: i32,
  pub view_count: i32,
  pub row_count: i32,
  pub template_count: i32,
  pub file_manifest_count: i32,
  #[serde(default)]
  pub matched_page_count: i32,
  #[serde(default)]
  pub content_document_count: i32,
  #[serde(default)]
  pub empty_page_count: i32,
  #[serde(default)]
  pub body_block_count: i32,
  #[serde(default)]
  pub rewritten_internal_link_count: i32,
  pub export_actor: Option<String>,
  pub exported_at: Option<DateTime<Utc>>,
  pub default_mode: DatabaseJsonImportMode,
  pub default_conflict_strategy: DatabaseJsonConflictStrategy,
  pub warnings: Vec<DatabaseJsonDiagnostic>,
  pub errors: Vec<DatabaseJsonDiagnostic>,
  #[serde(default)]
  pub workspace_tag_diagnostics: Vec<DatabaseWorkspaceTagImportDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseJsonExport {
  pub filename: String,
  pub content_type: String,
  pub content: String,
}

/// P-DB-28: import mode. `Create` always imports into a brand-new
/// Database. `Replace` deletes every existing row and field from the
/// target Database and re-creates everything from the snapshot.
/// `Merge` keeps the target Database shape and adds the snapshot's
/// rows against an explicit field mapping.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseJsonImportMode {
  #[default]
  Create,
  Replace,
  Merge,
}

/// P-DB-28: conflict handling when a snapshot row's local id collides
/// with an existing row (UniqueId or explicit row key). `Abort` rolls
/// the import back and surfaces a diagnostic; `Rename` keeps both
/// copies and rewrites the second one to a fresh server id;
/// `Overwrite` replaces the existing row in place.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseJsonConflictStrategy {
  #[default]
  Abort,
  Rename,
  Overwrite,
}

/// P-DB-28: one logical "files/media manifest" entry that documents a
/// blob referenced from a `Files` cell. The manifest is informational
/// at export time and is consulted at import time to surface
/// `MIX_JSON_IMPORT_MISSING_FILE` diagnostics when a referenced blob
/// is not carried alongside the snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshotFileManifestEntry {
  pub blob_key: String,
  pub name: Option<String>,
  pub mime: Option<String>,
  pub size: Option<i64>,
  pub field_name: Option<String>,
  pub row_id: Option<String>,
}

/// P-DB-28: import-time options. `target_database_id` is required for
/// `Replace` and `Merge`; `field_mapping` maps snapshot field ids to
/// either an existing target field id or a snapshot `new_field`
/// instruction for `Merge` mode.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseJsonImportOptions {
  #[serde(default)]
  pub mode: DatabaseJsonImportMode,
  #[serde(default)]
  pub conflict_strategy: DatabaseJsonConflictStrategy,
  /// Workspace id of the target Database when mode != Create.
  #[serde(default)]
  pub target_workspace_id: Option<WorkspaceId>,
  /// Required for `Replace` / `Merge`. Must live in
  /// `target_workspace_id`.
  #[serde(default)]
  pub target_database_id: Option<DatabaseId>,
  /// Optional dry-run: when true, the import produces an
  /// `ImportResult` but does not persist.
  #[serde(default)]
  pub dry_run: bool,
  /// Per-snapshot field id -> either an existing target field id or
  /// a string starting with `new:` followed by the snapshot field's
  /// name (which becomes the new field's name). Used for `Merge`.
  #[serde(default)]
  pub field_mapping: BTreeMap<String, String>,
  /// Optional explicit acknowledgement of the destructive `Replace`
  /// mode. Required to be `true` for `Replace`; otherwise the import
  /// fails fast.
  #[serde(default)]
  pub confirm_destructive: bool,
}

/// P-DB-28: import-time field-mapping instruction parsed from
/// `DatabaseJsonImportOptions.field_mapping`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatabaseJsonImportFieldTarget {
  /// Reuse an existing field on the target Database.
  Existing(DatabaseFieldId),
  /// Create a brand-new field with the given name on the target
  /// Database.
  New(String),
}

impl DatabaseJsonImportOptions {
  pub fn parse_field_target(raw: &str) -> DatabaseJsonImportFieldTarget {
    if let Some(rest) = raw.strip_prefix("new:") {
      DatabaseJsonImportFieldTarget::New(rest.to_string())
    } else {
      DatabaseJsonImportFieldTarget::Existing(Uuid::parse_str(raw).unwrap_or_else(|_| Uuid::nil()))
    }
  }
}

/// P-DB-28: extended import result so the GraphQL surface can tell
/// the wizard which mode ran, which conflict strategy was used and
/// whether the run was a `dryRun`. Per-row / per-field diagnostics are
/// returned via `conflict_warnings`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseJsonImportResult {
  pub database: DatabaseRecord,
  pub mode: DatabaseJsonImportMode,
  pub conflict_strategy: DatabaseJsonConflictStrategy,
  pub dry_run: bool,
  pub created_field_count: i32,
  pub created_view_count: i32,
  pub created_row_count: i32,
  pub updated_row_count: i32,
  pub skipped_row_count: i32,
  pub created_template_count: i32,
  pub missing_file_count: i32,
  pub warnings: Vec<DatabaseJsonDiagnostic>,
  pub conflict_warnings: Vec<DatabaseJsonDiagnostic>,
  #[serde(default)]
  pub workspace_tag_diagnostics: Vec<DatabaseWorkspaceTagImportDiagnostic>,
}
