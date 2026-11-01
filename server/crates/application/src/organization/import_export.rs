// SPDX-License-Identifier: AGPL-3.0-or-later
//! JSON / CSV import-export for the Organization domain (Paket H).
//!
//! Konzept: `todo/organization-management-concept.md` § Import und Export
//!
//! Two formats:
//!  - **JSON** — full snapshot, single document, schema-versioned.
//!  - **CSV** — a human-editable partial projection using `organization.csv`
//!    plus four optional entity files. Fields outside that projection retain
//!    their authoritative values on apply.
//!
//! Both formats run through the same three-step pipeline:
//!   1. **parse** — turn bytes into typed in-memory rows.
//!   2. **validate (dry-run)** — detect missing FKs, parent cycles,
//!      bad enum values, unknown user emails. Returns a list of
//!      structured errors with file/row/field references.
//!   3. **apply** — only runs if the dry-run yielded zero errors. One
//!      Infrastructure port owns the complete aggregate transaction and
//!      revalidates mutable references under its locks.
//!
//! Stable keys per entity (idempotency contract):
//!   * organization     → `key`
//!   * ou_type          → `(organization_id, key)`
//!   * ou               → `(organization_id, slug)` (parent resolved by `parent_slug`)
//!   * ou_member        → `(unit_id, user_id)` (user resolved by email)
//!   * ou_workspace     → `(unit_id, workspace_id, relationship)`
//!
//! The `apply` step reuses transaction-aware repository write paths. Full JSON
//! therefore retains semantic roundtrip fidelity, while CSV updates exactly
//! its represented columns and preserves authoritative out-of-format fields.

#![allow(clippy::too_many_arguments)]

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tracing::{instrument, warn};
use uuid::Uuid;

use myoxus_domain::entities::OrganizationUnit;
use myoxus_domain::ids::{OrganizationId, UserId};
use myoxus_domain::repositories::{
  OrganizationPolicyRepository, OrganizationRepository, OrganizationUnitMemberRepository, OrganizationUnitRepository,
  OrganizationUnitTypeRepository, OrganizationUnitWorkspaceRepository, RepoResult, RepositoryError,
};

/// Current JSON schema version. The validator rejects every other version;
/// compatibility requires an explicit schema upgrade rather than aliases.
pub const JSON_SCHEMA_VERSION: u32 = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot (JSON shape)
// ─────────────────────────────────────────────────────────────────────────────

/// Full organisation snapshot. The exact shape is the JSON contract —
/// any client (frontend, CLI, future SCIM bridge) speaks this struct.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrganizationSnapshot {
  #[serde(rename = "schemaVersion")]
  pub schema_version: u32,
  pub organization: OrganizationSnapshotOrganization,
  #[serde(rename = "unitTypes", default)]
  pub unit_types: Vec<OrganizationSnapshotUnitType>,
  #[serde(default)]
  pub units: Vec<OrganizationSnapshotUnit>,
  #[serde(default)]
  pub members: Vec<OrganizationSnapshotMember>,
  #[serde(rename = "workspaceLinks", default)]
  pub workspace_links: Vec<OrganizationSnapshotWorkspaceLink>,
  pub policies: OrganizationSnapshotPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrganizationSnapshotOrganization {
  pub key: String,
  pub name: String,
  pub slug: String,
  #[serde(default = "empty_object")]
  pub metadata: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrganizationSnapshotUnitType {
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub icon: Option<String>,
  pub color: Option<String>,
  #[serde(rename = "isPreset", default)]
  pub is_preset: bool,
  #[serde(rename = "isActive", default = "default_true")]
  pub is_active: bool,
  #[serde(rename = "isStructural")]
  pub is_structural: bool,
  #[serde(rename = "canHaveChildren")]
  pub can_have_children: bool,
  #[serde(rename = "canBeRootLevel")]
  pub can_be_root_level: bool,
  #[serde(rename = "canBeManagerCreated")]
  pub can_be_manager_created: bool,
  #[serde(rename = "canHaveCrossUnitMembers")]
  pub can_have_cross_unit_members: bool,
  #[serde(rename = "canOwnWorkspaces")]
  pub can_own_workspaces: bool,
  #[serde(rename = "canManageWorkspaces")]
  pub can_manage_workspaces: bool,
  #[serde(rename = "isStaffUnit", default)]
  pub is_staff_unit: bool,
  #[serde(rename = "requiresAdminApproval", default)]
  pub requires_admin_approval: bool,
  #[serde(default = "empty_object")]
  pub metadata: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrganizationSnapshotUnit {
  /// Stable identity key — `slug` is the join key for hierarchy lookups.
  pub slug: String,
  #[serde(rename = "parentSlug")]
  pub parent_slug: Option<String>,
  #[serde(rename = "typeKey")]
  pub type_key: String,
  pub name: String,
  pub description: Option<String>,
  /// `active` | `disabled` | `archived`.
  pub status: String,
  #[serde(rename = "maxMembers", default = "default_max_members")]
  pub max_members: i32,
  #[serde(default = "empty_object")]
  pub metadata: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrganizationSnapshotMember {
  #[serde(rename = "ouSlug")]
  pub ou_slug: String,
  /// Users are referenced by email so the snapshot is portable.
  #[serde(rename = "userEmail")]
  pub user_email: String,
  /// `reader` | `member` | `manager`.
  pub role: String,
  /// `manual` | `import` | `oidc` | `ldap` | `scim`.
  #[serde(default = "default_source")]
  pub source: String,
  #[serde(default = "empty_object")]
  pub metadata: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrganizationSnapshotWorkspaceLink {
  #[serde(rename = "ouSlug")]
  pub ou_slug: String,
  #[serde(rename = "workspaceId")]
  pub workspace_id: Uuid,
  /// `owner` | `managed` | `linked`.
  pub relationship: String,
  #[serde(default = "empty_object")]
  pub metadata: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrganizationSnapshotPolicy {
  #[serde(rename = "managerRootProjectCreation")]
  pub manager_root_project_creation: String,
  #[serde(rename = "managerUnitProjectCreation")]
  pub manager_unit_project_creation: String,
  #[serde(rename = "managerCanCreateWorkspaces")]
  pub manager_can_create_workspaces: bool,
  #[serde(rename = "managerCanManageOuMembers")]
  pub manager_can_manage_ou_members: bool,
  #[serde(rename = "importExportEnabled")]
  pub import_export_enabled: bool,
}

fn empty_object() -> JsonValue {
  serde_json::json!({})
}

fn default_true() -> bool {
  true
}

fn default_source() -> String {
  "manual".to_string()
}

fn default_max_members() -> i32 {
  25
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors / Outcome
// ─────────────────────────────────────────────────────────────────────────────

/// One structured validation error. References the location precisely.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportError {
  /// `organization.csv`, `ou_types.csv`, `units` (JSON array), …
  pub source: String,
  /// 1-based row number. JSON arrays use the array index + 1.
  pub row: Option<u32>,
  /// Column / field name.
  pub field: Option<String>,
  pub message: String,
}

impl ImportError {
  pub fn at(source: impl Into<String>, row: u32, field: impl Into<String>, msg: impl Into<String>) -> Self {
    Self {
      source: source.into(),
      row: Some(row),
      field: Some(field.into()),
      message: msg.into(),
    }
  }

  pub fn global(source: impl Into<String>, msg: impl Into<String>) -> Self {
    Self {
      source: source.into(),
      row: None,
      field: None,
      message: msg.into(),
    }
  }

  fn field(source: impl Into<String>, field: impl Into<String>, msg: impl Into<String>) -> Self {
    Self {
      source: source.into(),
      row: None,
      field: Some(field.into()),
      message: msg.into(),
    }
  }
}

/// Summary of a successful apply. All counts are non-negative.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportSummary {
  pub organization_updated: bool,
  pub unit_types_inserted: u32,
  pub unit_types_updated: u32,
  pub units_inserted: u32,
  pub units_updated: u32,
  pub members_inserted: u32,
  pub members_updated: u32,
  pub workspace_links_inserted: u32,
  pub workspace_links_updated: u32,
  pub policy_updated: bool,
}

/// One CSV file as a tuple of name + body (UTF-8). Used for export
/// payloads and as the input shape of `apply_csv`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvFile {
  pub name: String,
  pub content: String,
}

/// Admitted wire representation. The format remains attached after decoding
/// because CSV intentionally omits authoritative fields that apply preserves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrganizationImportFormat {
  Json,
  Csv,
}

/// Which top-level entities were represented by the admitted input. JSON is a
/// complete snapshot; CSV files are independently optional after the required
/// organization row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrganizationImportPresence {
  pub unit_types: bool,
  pub units: bool,
  pub members: bool,
  pub workspace_links: bool,
  pub policies: bool,
}

/// Structurally valid input plus its field-presence contract.
#[derive(Debug, Clone)]
pub struct PreparedOrganizationImport {
  pub snapshot: OrganizationSnapshot,
  pub format: OrganizationImportFormat,
  pub presence: OrganizationImportPresence,
}

/// Durable result returned only after the complete transaction commits.
#[derive(Debug, Clone)]
pub struct OrganizationImportCommit {
  pub summary: ImportSummary,
  /// Manager capability rows changed by the transaction. Consumers invalidate
  /// their caches only after commit; cache work never runs inside the writer.
  pub manager_capability_users: Vec<UserId>,
}

/// Infrastructure-owned atomic persistence boundary for organization imports.
#[async_trait::async_trait]
pub trait OrganizationImportWriter: Send + Sync {
  async fn apply(
    &self,
    import: &PreparedOrganizationImport,
  ) -> RepoResult<Result<OrganizationImportCommit, Vec<ImportError>>>;
}

const CSV_FILE_NAMES: &[&str] = &[
  "organization.csv",
  "ou_types.csv",
  "ous.csv",
  "ou_members.csv",
  "ou_workspaces.csv",
];
const ORGANIZATION_COLUMNS: &[&str] = &["key", "name", "slug"];
const OU_TYPE_COLUMNS: &[&str] = &[
  "key",
  "label",
  "is_structural",
  "can_have_children",
  "can_be_root_level",
  "can_be_manager_created",
  "can_have_cross_unit_members",
  "can_own_workspaces",
  "can_manage_workspaces",
  "is_staff_unit",
  "requires_admin_approval",
];
const OU_COLUMNS: &[&str] = &["key", "parent_key", "type_key", "name", "slug", "status", "max_members"];
const OU_MEMBER_COLUMNS: &[&str] = &["ou_key", "user_email", "role", "source"];
const OU_WORKSPACE_COLUMNS: &[&str] = &["ou_key", "workspace_id", "relationship"];

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

/// Looks up a user by email. The application crate stays free of SQLx,
/// so callers wire in this trait.
#[async_trait::async_trait]
pub trait UserEmailLookup: Send + Sync {
  /// Resolve `email` → `Some(user_id)` if the user exists.
  async fn user_id_by_email(&self, email: &str) -> RepoResult<Option<UserId>>;
  /// Reverse lookup for export — `user_id` → email.
  async fn email_by_user_id(&self, user_id: UserId) -> RepoResult<Option<String>>;
}

/// Application service that runs the import-export pipelines.
#[derive(Clone)]
pub struct OrganizationImportExportService {
  organizations: Arc<dyn OrganizationRepository>,
  unit_types: Arc<dyn OrganizationUnitTypeRepository>,
  units: Arc<dyn OrganizationUnitRepository>,
  members: Arc<dyn OrganizationUnitMemberRepository>,
  workspaces: Arc<dyn OrganizationUnitWorkspaceRepository>,
  policies: Arc<dyn OrganizationPolicyRepository>,
  user_lookup: Arc<dyn UserEmailLookup>,
  import_writer: Arc<dyn OrganizationImportWriter>,
}

impl OrganizationImportExportService {
  pub fn new(
    organizations: Arc<dyn OrganizationRepository>,
    unit_types: Arc<dyn OrganizationUnitTypeRepository>,
    units: Arc<dyn OrganizationUnitRepository>,
    members: Arc<dyn OrganizationUnitMemberRepository>,
    workspaces: Arc<dyn OrganizationUnitWorkspaceRepository>,
    policies: Arc<dyn OrganizationPolicyRepository>,
    user_lookup: Arc<dyn UserEmailLookup>,
    import_writer: Arc<dyn OrganizationImportWriter>,
  ) -> Self {
    Self {
      organizations,
      unit_types,
      units,
      members,
      workspaces,
      policies,
      user_lookup,
      import_writer,
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /// Build a full JSON snapshot of `organization_id`. Stays read-only.
  #[instrument(skip(self))]
  pub async fn export_json(&self, organization_id: OrganizationId) -> RepoResult<OrganizationSnapshot> {
    let org = self
      .organizations
      .get_by_id(organization_id)
      .await?
      .ok_or(RepositoryError::NotFound("organization"))?;
    let types = self.unit_types.list(organization_id, true).await?;
    let units = self.units.list(organization_id, None).await?;
    let policy = self.policies.get(organization_id).await?;

    // Snapshot member rows for every OU in `units`.
    let mut snapshot_members: Vec<OrganizationSnapshotMember> = Vec::new();
    for u in &units {
      let rows = self.members.list_members(u.id, None).await?;
      for m in rows {
        if let Some(email) = self.user_lookup.email_by_user_id(m.user_id).await? {
          snapshot_members.push(OrganizationSnapshotMember {
            ou_slug: u.slug.clone(),
            user_email: email,
            role: m.role.as_str().to_string(),
            source: m.source.as_str().to_string(),
            metadata: m.metadata,
          });
        }
      }
    }

    // Snapshot workspace links for every OU.
    let mut snapshot_links: Vec<OrganizationSnapshotWorkspaceLink> = Vec::new();
    for u in &units {
      let rows = self.workspaces.list_for_unit(u.id).await?;
      for l in rows {
        snapshot_links.push(OrganizationSnapshotWorkspaceLink {
          ou_slug: u.slug.clone(),
          workspace_id: l.workspace_id,
          relationship: l.relationship.as_str().to_string(),
          metadata: empty_object(),
        });
      }
    }

    let by_id: HashMap<Uuid, &OrganizationUnit> = units.iter().map(|u| (u.id, u)).collect();
    let type_key_by_id: HashMap<Uuid, String> = types.iter().map(|t| (t.id, t.key.clone())).collect();
    let snapshot_units: Vec<OrganizationSnapshotUnit> = units
      .iter()
      .map(|u| OrganizationSnapshotUnit {
        slug: u.slug.clone(),
        parent_slug: u.parent_unit_id.and_then(|p| by_id.get(&p).map(|pu| pu.slug.clone())),
        type_key: type_key_by_id.get(&u.unit_type_id).cloned().unwrap_or_default(),
        name: u.name.clone(),
        description: u.description.clone(),
        status: u.status.as_str().to_string(),
        max_members: u.max_members,
        metadata: u.metadata.clone(),
      })
      .collect();

    let snapshot_types: Vec<OrganizationSnapshotUnitType> = types
      .into_iter()
      .map(|t| OrganizationSnapshotUnitType {
        key: t.key,
        label: t.label,
        description: t.description,
        icon: t.icon,
        color: t.color,
        is_preset: t.is_preset,
        is_active: t.is_active,
        is_structural: t.is_structural,
        can_have_children: t.can_have_children,
        can_be_root_level: t.can_be_root_level,
        can_be_manager_created: t.can_be_manager_created,
        can_have_cross_unit_members: t.can_have_cross_unit_members,
        can_own_workspaces: t.can_own_workspaces,
        can_manage_workspaces: t.can_manage_workspaces,
        is_staff_unit: t.is_staff_unit,
        requires_admin_approval: t.requires_admin_approval,
        metadata: t.metadata,
      })
      .collect();

    Ok(OrganizationSnapshot {
      schema_version: JSON_SCHEMA_VERSION,
      organization: OrganizationSnapshotOrganization {
        key: org.key,
        name: org.name,
        slug: org.slug,
        metadata: org.metadata,
      },
      unit_types: snapshot_types,
      units: snapshot_units,
      members: snapshot_members,
      workspace_links: snapshot_links,
      policies: OrganizationSnapshotPolicy {
        manager_root_project_creation: policy.manager_root_project_creation.as_str().to_string(),
        manager_unit_project_creation: policy.manager_unit_project_creation.as_str().to_string(),
        manager_can_create_workspaces: policy.manager_can_create_workspaces,
        manager_can_manage_ou_members: policy.manager_can_manage_ou_members,
        import_export_enabled: policy.import_export_enabled,
      },
    })
  }

  /// Convert a JSON snapshot into the five canonical CSV files.
  /// Pure transform, never touches the DB.
  pub fn snapshot_to_csv(snapshot: &OrganizationSnapshot) -> RepoResult<Vec<CsvFile>> {
    let mut out = Vec::with_capacity(5);

    // organization.csv
    let mut wtr = csv::Writer::from_writer(vec![]);
    wtr.write_record(["key", "name", "slug"]).map_err(csv_export_error)?;
    wtr
      .write_record([
        &snapshot.organization.key,
        &snapshot.organization.name,
        &snapshot.organization.slug,
      ])
      .map_err(csv_export_error)?;
    out.push(CsvFile {
      name: "organization.csv".to_string(),
      content: finish_csv_writer(wtr)?,
    });

    // ou_types.csv
    let mut wtr = csv::Writer::from_writer(vec![]);
    wtr
      .write_record([
        "key",
        "label",
        "is_structural",
        "can_have_children",
        "can_be_root_level",
        "can_be_manager_created",
        "can_have_cross_unit_members",
        "can_own_workspaces",
        "can_manage_workspaces",
        "is_staff_unit",
        "requires_admin_approval",
      ])
      .map_err(csv_export_error)?;
    for t in &snapshot.unit_types {
      wtr
        .write_record([
          &t.key,
          &t.label,
          &t.is_structural.to_string(),
          &t.can_have_children.to_string(),
          &t.can_be_root_level.to_string(),
          &t.can_be_manager_created.to_string(),
          &t.can_have_cross_unit_members.to_string(),
          &t.can_own_workspaces.to_string(),
          &t.can_manage_workspaces.to_string(),
          &t.is_staff_unit.to_string(),
          &t.requires_admin_approval.to_string(),
        ])
        .map_err(csv_export_error)?;
    }
    out.push(CsvFile {
      name: "ou_types.csv".to_string(),
      content: finish_csv_writer(wtr)?,
    });

    // ous.csv
    let mut wtr = csv::Writer::from_writer(vec![]);
    wtr
      .write_record(["key", "parent_key", "type_key", "name", "slug", "status", "max_members"])
      .map_err(csv_export_error)?;
    for u in &snapshot.units {
      wtr
        .write_record([
          &u.slug,
          u.parent_slug.as_deref().unwrap_or(""),
          &u.type_key,
          &u.name,
          &u.slug,
          &u.status,
          &u.max_members.to_string(),
        ])
        .map_err(csv_export_error)?;
    }
    out.push(CsvFile {
      name: "ous.csv".to_string(),
      content: finish_csv_writer(wtr)?,
    });

    // ou_members.csv
    let mut wtr = csv::Writer::from_writer(vec![]);
    wtr
      .write_record(["ou_key", "user_email", "role", "source"])
      .map_err(csv_export_error)?;
    for m in &snapshot.members {
      wtr
        .write_record([&m.ou_slug, &m.user_email, &m.role, &m.source])
        .map_err(csv_export_error)?;
    }
    out.push(CsvFile {
      name: "ou_members.csv".to_string(),
      content: finish_csv_writer(wtr)?,
    });

    // ou_workspaces.csv
    let mut wtr = csv::Writer::from_writer(vec![]);
    wtr
      .write_record(["ou_key", "workspace_id", "relationship"])
      .map_err(csv_export_error)?;
    for l in &snapshot.workspace_links {
      wtr
        .write_record([&l.ou_slug, &l.workspace_id.to_string(), &l.relationship])
        .map_err(csv_export_error)?;
    }
    out.push(CsvFile {
      name: "ou_workspaces.csv".to_string(),
      content: finish_csv_writer(wtr)?,
    });

    Ok(out)
  }

  // ── Import (parse + validate + apply) ────────────────────────────────────

  /// Decode exactly one admitted import representation. Structural failures
  /// stay in the application contract so GraphQL dry-run and apply cannot
  /// accidentally use different JSON or CSV semantics.
  pub fn decode_import(
    json: Option<&str>,
    files: Option<&[CsvFile]>,
  ) -> Result<PreparedOrganizationImport, Vec<ImportError>> {
    match (json, files) {
      (Some(_), Some(_)) => Err(vec![ImportError::global(
        "input",
        "provide exactly one of `json` or `files`, not both",
      )]),
      (None, None) => Err(vec![ImportError::global(
        "input",
        "either `json` or `files` is required",
      )]),
      (Some(json), None) => serde_json::from_str(json)
        .map(|snapshot| PreparedOrganizationImport {
          snapshot,
          format: OrganizationImportFormat::Json,
          presence: OrganizationImportPresence {
            unit_types: true,
            units: true,
            members: true,
            workspace_links: true,
            policies: true,
          },
        })
        .map_err(|error| {
          vec![ImportError::global(
            "snapshot",
            format!("invalid JSON snapshot: {error}"),
          )]
        }),
      (None, Some(files)) => {
        let (snapshot, errors) = Self::csv_to_snapshot(files);
        if errors.is_empty() {
          Ok(PreparedOrganizationImport {
            snapshot,
            format: OrganizationImportFormat::Csv,
            presence: OrganizationImportPresence {
              unit_types: files.iter().any(|file| file.name == "ou_types.csv"),
              units: files.iter().any(|file| file.name == "ous.csv"),
              members: files.iter().any(|file| file.name == "ou_members.csv"),
              workspace_links: files.iter().any(|file| file.name == "ou_workspaces.csv"),
              policies: false,
            },
          })
        } else {
          Err(errors)
        }
      }
    }
  }

  /// Parse CSV files into a `OrganizationSnapshot`. Errors are collected
  /// and returned alongside the partial snapshot so the caller can show
  /// every issue at once.
  fn csv_to_snapshot(files: &[CsvFile]) -> (OrganizationSnapshot, Vec<ImportError>) {
    let mut errors: Vec<ImportError> = Vec::new();
    let mut by_name: HashMap<&str, &str> = HashMap::new();
    for file in files {
      if !CSV_FILE_NAMES.contains(&file.name.as_str()) {
        errors.push(ImportError::global(&file.name, "unknown CSV file"));
        continue;
      }
      if by_name.contains_key(file.name.as_str()) {
        errors.push(ImportError::global(&file.name, "duplicate CSV file name"));
      } else {
        by_name.insert(file.name.as_str(), file.content.as_str());
      }
    }

    let mut snapshot = empty_csv_snapshot();
    if let Some(content) = by_name.get("organization.csv") {
      if let Some(table) = parse_csv_table("organization.csv", content, ORGANIZATION_COLUMNS, &mut errors) {
        if table.rows.len() != 1 {
          errors.push(ImportError::global(
            "organization.csv",
            format!("expected exactly one organization row, found {}", table.rows.len()),
          ));
        } else {
          let (_, row) = &table.rows[0];
          snapshot.organization.key = table.value(row, "key").to_string();
          snapshot.organization.name = table.value(row, "name").to_string();
          snapshot.organization.slug = table.value(row, "slug").to_string();
        }
      }
    } else {
      errors.push(ImportError::global("organization.csv", "missing required CSV file"));
    }

    if let Some(content) = by_name.get("ou_types.csv")
      && let Some(table) = parse_csv_table("ou_types.csv", content, OU_TYPE_COLUMNS, &mut errors)
    {
      let mut keys = HashSet::new();
      for (row_number, row) in &table.rows {
        let key = table.value(row, "key");
        if !keys.insert(key) {
          errors.push(ImportError::at(
            "ou_types.csv",
            *row_number,
            "key",
            format!("duplicate unit-type key '{key}'"),
          ));
        }
        snapshot.unit_types.push(OrganizationSnapshotUnitType {
          key: key.to_string(),
          label: table.value(row, "label").to_string(),
          description: None,
          icon: None,
          color: None,
          is_preset: false,
          is_active: true,
          is_structural: parse_bool_or_default(
            &mut errors,
            "ou_types.csv",
            *row_number,
            "is_structural",
            Some(table.value(row, "is_structural")),
          ),
          can_have_children: parse_bool_or_default(
            &mut errors,
            "ou_types.csv",
            *row_number,
            "can_have_children",
            Some(table.value(row, "can_have_children")),
          ),
          can_be_root_level: parse_bool_or_default(
            &mut errors,
            "ou_types.csv",
            *row_number,
            "can_be_root_level",
            Some(table.value(row, "can_be_root_level")),
          ),
          can_be_manager_created: parse_bool_or_default(
            &mut errors,
            "ou_types.csv",
            *row_number,
            "can_be_manager_created",
            Some(table.value(row, "can_be_manager_created")),
          ),
          can_have_cross_unit_members: parse_bool_or_default(
            &mut errors,
            "ou_types.csv",
            *row_number,
            "can_have_cross_unit_members",
            Some(table.value(row, "can_have_cross_unit_members")),
          ),
          can_own_workspaces: parse_bool_or_default(
            &mut errors,
            "ou_types.csv",
            *row_number,
            "can_own_workspaces",
            Some(table.value(row, "can_own_workspaces")),
          ),
          can_manage_workspaces: parse_bool_or_default(
            &mut errors,
            "ou_types.csv",
            *row_number,
            "can_manage_workspaces",
            Some(table.value(row, "can_manage_workspaces")),
          ),
          is_staff_unit: parse_bool_or_default(
            &mut errors,
            "ou_types.csv",
            *row_number,
            "is_staff_unit",
            Some(table.value(row, "is_staff_unit")),
          ),
          requires_admin_approval: parse_bool_or_default(
            &mut errors,
            "ou_types.csv",
            *row_number,
            "requires_admin_approval",
            Some(table.value(row, "requires_admin_approval")),
          ),
          metadata: empty_object(),
        });
      }
    }

    if let Some(content) = by_name.get("ous.csv")
      && let Some(table) = parse_csv_table("ous.csv", content, OU_COLUMNS, &mut errors)
    {
      let mut slugs = HashSet::new();
      for (row_number, row) in &table.rows {
        let key = table.value(row, "key");
        let slug = table.value(row, "slug");
        if !slugs.insert(slug) {
          errors.push(ImportError::at(
            "ous.csv",
            *row_number,
            "slug",
            format!("duplicate unit slug '{slug}'"),
          ));
        }
        if key != slug {
          errors.push(ImportError::at(
            "ous.csv",
            *row_number,
            "key",
            "OU key must equal slug in the version 1 CSV contract",
          ));
        }
        let max_members_raw = table.value(row, "max_members").trim();
        let max_members = if max_members_raw.is_empty() {
          default_max_members()
        } else {
          match max_members_raw.parse::<i32>() {
            Ok(value) => value,
            Err(error) => {
              errors.push(ImportError::at(
                "ous.csv",
                *row_number,
                "max_members",
                format!("invalid integer: {error}"),
              ));
              default_max_members()
            }
          }
        };
        snapshot.units.push(OrganizationSnapshotUnit {
          slug: slug.to_string(),
          parent_slug: non_empty(table.value(row, "parent_key")),
          type_key: table.value(row, "type_key").to_string(),
          name: table.value(row, "name").to_string(),
          description: None,
          status: table.value(row, "status").to_string(),
          max_members,
          metadata: empty_object(),
        });
      }
    }

    if let Some(content) = by_name.get("ou_members.csv")
      && let Some(table) = parse_csv_table("ou_members.csv", content, OU_MEMBER_COLUMNS, &mut errors)
    {
      let mut keys = HashSet::new();
      for (row_number, row) in &table.rows {
        let ou_slug = table.value(row, "ou_key");
        let user_email = table.value(row, "user_email");
        if !keys.insert((ou_slug, user_email.to_ascii_lowercase())) {
          errors.push(ImportError::at(
            "ou_members.csv",
            *row_number,
            "user_email",
            "duplicate OU member key",
          ));
        }
        snapshot.members.push(OrganizationSnapshotMember {
          ou_slug: ou_slug.to_string(),
          user_email: user_email.to_string(),
          role: table.value(row, "role").to_string(),
          source: table.value(row, "source").to_string(),
          metadata: empty_object(),
        });
      }
    }

    if let Some(content) = by_name.get("ou_workspaces.csv")
      && let Some(table) = parse_csv_table("ou_workspaces.csv", content, OU_WORKSPACE_COLUMNS, &mut errors)
    {
      let mut keys = HashSet::new();
      for (row_number, row) in &table.rows {
        let ou_slug = table.value(row, "ou_key");
        let relationship = table.value(row, "relationship");
        match table.value(row, "workspace_id").parse::<Uuid>() {
          Ok(workspace_id) => {
            if !keys.insert((ou_slug, workspace_id, relationship)) {
              errors.push(ImportError::at(
                "ou_workspaces.csv",
                *row_number,
                "workspace_id",
                "duplicate OU-to-workspace link key",
              ));
            }
            snapshot.workspace_links.push(OrganizationSnapshotWorkspaceLink {
              ou_slug: ou_slug.to_string(),
              workspace_id,
              relationship: relationship.to_string(),
              metadata: empty_object(),
            });
          }
          Err(error) => errors.push(ImportError::at(
            "ou_workspaces.csv",
            *row_number,
            "workspace_id",
            format!("invalid UUID: {error}"),
          )),
        }
      }
    }

    (snapshot, errors)
  }

  /// Validate-only: does NOT persist anything. Returns an empty vector
  /// when the snapshot is consistent. Combine with `apply_*` to do a
  /// guarded import.
  #[instrument(skip(self, import))]
  pub async fn dry_run(&self, import: &PreparedOrganizationImport) -> RepoResult<Vec<ImportError>> {
    let snapshot = &import.snapshot;
    let mut errors: Vec<ImportError> = Vec::new();
    if snapshot.schema_version != JSON_SCHEMA_VERSION {
      errors.push(ImportError::global(
        "snapshot",
        format!(
          "unsupported schemaVersion={} (expected {})",
          snapshot.schema_version, JSON_SCHEMA_VERSION
        ),
      ));
    }
    if snapshot.organization.key.is_empty() {
      errors.push(ImportError::global("organization", "key is required"));
    }
    if snapshot.organization.slug.is_empty() {
      errors.push(ImportError::global("organization", "slug is required"));
    }
    let organization = if snapshot.organization.key.is_empty() {
      None
    } else {
      self.organizations.get_by_key(&snapshot.organization.key).await?
    };
    if organization.is_none() && !snapshot.organization.key.is_empty() {
      errors.push(ImportError::global(
        "organization",
        format!(
          "no organization with key '{}' — single-tenant imports must reuse the existing key",
          snapshot.organization.key
        ),
      ));
    }
    let (existing_types, existing_units) = if import.format == OrganizationImportFormat::Csv {
      if let Some(organization) = &organization {
        (
          self.unit_types.list(organization.id, true).await?,
          self.units.list(organization.id, None).await?,
        )
      } else {
        (vec![], vec![])
      }
    } else {
      (vec![], vec![])
    };

    // unit_types: unique keys
    let mut seen_type_keys: HashSet<&str> = HashSet::new();
    for (idx, t) in snapshot.unit_types.iter().enumerate() {
      let row = (idx + 1) as u32;
      if t.key.is_empty() {
        errors.push(ImportError::at("unitTypes", row, "key", "key is required"));
      }
      if !seen_type_keys.insert(t.key.as_str()) {
        errors.push(ImportError::at(
          "unitTypes",
          row,
          "key",
          format!("duplicate unit-type key '{}'", t.key),
        ));
      }
    }
    let known_type_keys: HashSet<&str> = snapshot
      .unit_types
      .iter()
      .map(|unit_type| unit_type.key.as_str())
      .chain(existing_types.iter().map(|unit_type| unit_type.key.as_str()))
      .collect();

    // units: unique slugs, FK to type, no parent cycle
    let mut seen_slugs: HashSet<&str> = HashSet::new();
    for (idx, u) in snapshot.units.iter().enumerate() {
      let row = (idx + 1) as u32;
      if u.slug.is_empty() {
        errors.push(ImportError::at("units", row, "slug", "slug is required"));
      }
      if !seen_slugs.insert(u.slug.as_str()) {
        errors.push(ImportError::at(
          "units",
          row,
          "slug",
          format!("duplicate unit slug '{}'", u.slug),
        ));
      }
      if !known_type_keys.contains(u.type_key.as_str()) {
        errors.push(ImportError::at(
          "units",
          row,
          "typeKey",
          format!("unknown unit-type key '{}'", u.type_key),
        ));
      }
      if u.max_members < 1 {
        errors.push(ImportError::at(
          "units",
          row,
          "maxMembers",
          "maxMembers must be at least 1",
        ));
      }
      if let Some(p) = &u.parent_slug
        && p == &u.slug
      {
        errors.push(ImportError::at("units", row, "parentSlug", "self-parent not allowed"));
      }
      match u.status.as_str() {
        "active" | "disabled" | "archived" => {}
        other => errors.push(ImportError::at(
          "units",
          row,
          "status",
          format!("invalid status '{other}', expected active|disabled|archived"),
        )),
      }
    }
    let existing_slug_by_id: HashMap<Uuid, &str> = existing_units
      .iter()
      .map(|unit| (unit.id, unit.slug.as_str()))
      .collect();
    let mut parent_index: HashMap<&str, Option<&str>> = existing_units
      .iter()
      .map(|unit| {
        (
          unit.slug.as_str(),
          unit
            .parent_unit_id
            .and_then(|parent| existing_slug_by_id.get(&parent).copied()),
        )
      })
      .collect();
    for unit in &snapshot.units {
      parent_index.insert(unit.slug.as_str(), unit.parent_slug.as_deref());
    }
    // cycle detection: walk parents up to 32 hops; mark cycles.
    for (idx, u) in snapshot.units.iter().enumerate() {
      let row = (idx + 1) as u32;
      let mut cur = u.parent_slug.as_deref();
      let mut hops = 0u32;
      while let Some(p) = cur {
        if hops > 32 {
          errors.push(ImportError::at(
            "units",
            row,
            "parentSlug",
            format!("parent chain exceeds 32 hops at '{p}' (likely cycle)"),
          ));
          break;
        }
        if p == u.slug.as_str() {
          errors.push(ImportError::at(
            "units",
            row,
            "parentSlug",
            format!("parent cycle detected via '{p}'"),
          ));
          break;
        }
        match parent_index.get(p) {
          Some(next) => cur = *next,
          None => {
            errors.push(ImportError::at(
              "units",
              row,
              "parentSlug",
              format!("unknown parent slug '{p}'"),
            ));
            break;
          }
        }
        hops += 1;
      }
    }

    // members: FK ou_slug, FK email, role enum
    let known_slugs: HashSet<&str> = snapshot
      .units
      .iter()
      .map(|unit| unit.slug.as_str())
      .chain(existing_units.iter().map(|unit| unit.slug.as_str()))
      .collect();
    let mut seen_members = HashSet::new();
    for (idx, m) in snapshot.members.iter().enumerate() {
      let row = (idx + 1) as u32;
      let member_key = (m.ou_slug.clone(), m.user_email.to_lowercase());
      if !seen_members.insert(member_key) {
        errors.push(ImportError::at("members", row, "userEmail", "duplicate OU member key"));
      }
      if !known_slugs.contains(m.ou_slug.as_str()) {
        errors.push(ImportError::at(
          "members",
          row,
          "ouSlug",
          format!("unknown OU slug '{}'", m.ou_slug),
        ));
      }
      match m.role.as_str() {
        "reader" | "member" | "manager" => {}
        other => errors.push(ImportError::at(
          "members",
          row,
          "role",
          format!("invalid role '{other}', expected reader|member|manager"),
        )),
      }
      match m.source.as_str() {
        "manual" | "import" | "oidc" | "ldap" | "scim" => {}
        other => errors.push(ImportError::at(
          "members",
          row,
          "source",
          format!("invalid source '{other}'"),
        )),
      }
      if self.user_lookup.user_id_by_email(&m.user_email).await?.is_none() {
        errors.push(ImportError::at(
          "members",
          row,
          "userEmail",
          format!("no user with email '{}'", m.user_email),
        ));
      }
    }

    // workspace links: FK ou_slug, relationship enum, single-owner per workspace
    let mut owner_workspaces: HashSet<Uuid> = HashSet::new();
    let mut seen_workspace_links = HashSet::new();
    for (idx, l) in snapshot.workspace_links.iter().enumerate() {
      let row = (idx + 1) as u32;
      let link_key = (l.ou_slug.as_str(), l.workspace_id, l.relationship.as_str());
      if !seen_workspace_links.insert(link_key) {
        errors.push(ImportError::at(
          "workspaceLinks",
          row,
          "workspaceId",
          "duplicate OU-to-workspace link key",
        ));
      }
      if !known_slugs.contains(l.ou_slug.as_str()) {
        errors.push(ImportError::at(
          "workspaceLinks",
          row,
          "ouSlug",
          format!("unknown OU slug '{}'", l.ou_slug),
        ));
      }
      match l.relationship.as_str() {
        "owner" | "managed" | "linked" => {}
        other => errors.push(ImportError::at(
          "workspaceLinks",
          row,
          "relationship",
          format!("invalid relationship '{other}'"),
        )),
      }
      if l.relationship == "owner" && !owner_workspaces.insert(l.workspace_id) {
        errors.push(ImportError::at(
          "workspaceLinks",
          row,
          "workspaceId",
          format!("workspace {} already has an owner OU in the snapshot", l.workspace_id),
        ));
      }
    }

    // policy enum sanity
    for (label, val) in [
      (
        "managerRootProjectCreation",
        &snapshot.policies.manager_root_project_creation,
      ),
      (
        "managerUnitProjectCreation",
        &snapshot.policies.manager_unit_project_creation,
      ),
    ] {
      match val.as_str() {
        "disabled" | "requires_approval" | "allowed" => {}
        other => errors.push(ImportError::global("policies", format!("invalid {label} '{other}'"))),
      }
    }

    Ok(errors)
  }

  /// Validate immutable input and delegate the complete durable mutation to
  /// one infrastructure transaction. The writer rechecks mutable references,
  /// so a successful return always represents one committed import.
  #[instrument(skip(self, import))]
  pub async fn apply(
    &self,
    import: &PreparedOrganizationImport,
  ) -> RepoResult<Result<OrganizationImportCommit, Vec<ImportError>>> {
    let errors = self.dry_run(import).await?;
    if !errors.is_empty() {
      warn!(error_count = errors.len(), "import refused — dry-run produced errors");
      return Ok(Err(errors));
    }
    self.import_writer.apply(import).await
  }
}

struct CsvTable {
  columns: HashMap<String, usize>,
  rows: Vec<(u32, csv::StringRecord)>,
}

impl CsvTable {
  fn value<'a>(&self, row: &'a csv::StringRecord, column: &str) -> &'a str {
    let index = self.columns.get(column).expect("validated CSV column must exist");
    row
      .get(*index)
      .expect("non-flexible CSV record must match its validated header")
  }
}

fn parse_csv_table(
  source: &str,
  content: &str,
  expected_columns: &[&str],
  errors: &mut Vec<ImportError>,
) -> Option<CsvTable> {
  let mut reader = csv::ReaderBuilder::new()
    .flexible(false)
    .from_reader(content.as_bytes());
  let headers = match reader.headers() {
    Ok(headers) => headers.clone(),
    Err(error) => {
      errors.push(ImportError::global(source, format!("invalid CSV header: {error}")));
      return None;
    }
  };

  let mut columns = HashMap::new();
  let mut header_valid = true;
  for (index, header) in headers.iter().enumerate() {
    if columns.insert(header.to_string(), index).is_some() {
      errors.push(ImportError::field(source, header, "duplicate CSV column"));
      header_valid = false;
    }
    if !expected_columns.contains(&header) {
      errors.push(ImportError::field(source, header, "unknown CSV column"));
      header_valid = false;
    }
  }
  for required in expected_columns {
    if !columns.contains_key(*required) {
      errors.push(ImportError::field(source, *required, "missing required CSV column"));
      header_valid = false;
    }
  }

  let mut rows = Vec::new();
  let mut records_valid = true;
  for (index, record) in reader.records().enumerate() {
    let row = (index + 2) as u32;
    match record {
      Ok(record) => rows.push((row, record)),
      Err(error) => {
        errors.push(ImportError::at(
          source,
          row,
          "row",
          format!("invalid CSV record: {error}"),
        ));
        records_valid = false;
      }
    }
  }

  (header_valid && records_valid).then_some(CsvTable { columns, rows })
}

fn empty_csv_snapshot() -> OrganizationSnapshot {
  OrganizationSnapshot {
    schema_version: JSON_SCHEMA_VERSION,
    organization: OrganizationSnapshotOrganization {
      key: String::new(),
      name: String::new(),
      slug: String::new(),
      metadata: empty_object(),
    },
    unit_types: vec![],
    units: vec![],
    members: vec![],
    workspace_links: vec![],
    policies: OrganizationSnapshotPolicy {
      manager_root_project_creation: "disabled".to_string(),
      manager_unit_project_creation: "disabled".to_string(),
      manager_can_create_workspaces: false,
      manager_can_manage_ou_members: false,
      import_export_enabled: true,
    },
  }
}

fn non_empty(value: &str) -> Option<String> {
  (!value.is_empty()).then(|| value.to_string())
}

fn csv_export_error(error: csv::Error) -> RepositoryError {
  RepositoryError::Storage(format!("organization CSV serialization failed: {error}"))
}

fn finish_csv_writer(writer: csv::Writer<Vec<u8>>) -> RepoResult<String> {
  let bytes = writer
    .into_inner()
    .map_err(|error| RepositoryError::Storage(format!("organization CSV finalization failed: {}", error.error())))?;
  String::from_utf8(bytes)
    .map_err(|_| RepositoryError::Storage("organization CSV serialization produced invalid UTF-8".to_string()))
}

fn parse_bool_or_default(
  errors: &mut Vec<ImportError>,
  source: &str,
  row: u32,
  field: &str,
  raw: Option<&str>,
) -> bool {
  match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
    Some("true" | "1" | "yes") => true,
    Some("false" | "0" | "no" | "") | None => false,
    Some(other) => {
      errors.push(ImportError::at(source, row, field, format!("invalid bool '{other}'")));
      false
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn minimal_json(extra: &str) -> String {
    format!(
      r#"{{
        "schemaVersion": 1,
        "organization": {{
          "key": "myoxus",
          "name": "Myoxus",
          "slug": "myoxus",
          "metadata": {{"arbitrary": {{"nested": true}}}}
        }},
        "policies": {{
          "managerRootProjectCreation": "disabled",
          "managerUnitProjectCreation": "disabled",
          "managerCanCreateWorkspaces": false,
          "managerCanManageOuMembers": false,
          "importExportEnabled": true
        }}
        {extra}
      }}"#
    )
  }

  #[test]
  fn import_decoder_rejects_ambiguous_or_unknown_json_without_restricting_metadata() {
    let snapshot = OrganizationImportExportService::decode_import(Some(&minimal_json("")), None)
      .expect("valid optional omissions and arbitrary metadata must decode");
    assert!(snapshot.snapshot.unit_types.is_empty());
    assert_eq!(snapshot.snapshot.organization.metadata["arbitrary"]["nested"], true);
    assert_eq!(snapshot.format, OrganizationImportFormat::Json);

    for invalid in [
      minimal_json(r#", "unit_types": []"#),
      minimal_json(r#", "units": [{"slug":"one","typeKey":"team","name":"One","status":"active","unknown":true}]"#),
      minimal_json(r#", "organization": {"key":"duplicate"}"#),
    ] {
      let errors = OrganizationImportExportService::decode_import(Some(&invalid), None)
        .expect_err("unknown and duplicate typed fields must be rejected");
      assert_eq!(errors[0].source, "snapshot");
      assert!(errors[0].message.starts_with("invalid JSON snapshot:"));
    }

    let csv = [CsvFile {
      name: "organization.csv".to_string(),
      content: "key,name,slug\r\nmyoxus,Myoxus,myoxus\r\n".to_string(),
    }];
    assert!(OrganizationImportExportService::decode_import(Some(&minimal_json("")), Some(&csv)).is_err());
  }

  #[test]
  fn csv_decoder_resolves_reordered_columns_and_preserves_rfc4180_text() {
    let files = [CsvFile {
      name: "organization.csv".to_string(),
      content: "slug,name,key\r\nmyoxus,\"Mýoxus,\r\nGmbH\",myoxus\r\n".to_string(),
    }];
    let snapshot = OrganizationImportExportService::decode_import(None, Some(&files))
      .expect("reordered headers and quoted Unicode multiline values must decode");
    assert_eq!(snapshot.snapshot.organization.name, "Mýoxus,\r\nGmbH");
    assert!(
      snapshot.snapshot.unit_types.is_empty(),
      "non-organization CSV files are optional"
    );

    assert_eq!(snapshot.format, OrganizationImportFormat::Csv);
    let exported =
      OrganizationImportExportService::snapshot_to_csv(&snapshot.snapshot).expect("CSV export must succeed");
    let reparsed = OrganizationImportExportService::decode_import(None, Some(&exported))
      .expect("the canonical five-file export must re-import");
    assert_eq!(reparsed.snapshot.organization.name, snapshot.snapshot.organization.name);
  }

  #[test]
  fn csv_decoder_reports_ambiguous_structure_at_its_source() {
    let files = [
      CsvFile {
        name: "organization.csv".to_string(),
        content: "key,name,slug,unknown\nmyoxus,Myoxus,myoxus,value\n".to_string(),
      },
      CsvFile {
        name: "ou_types.csv".to_string(),
        content: concat!(
          "key,label,is_structural,can_have_children,can_be_root_level,can_be_manager_created,",
          "can_have_cross_unit_members,can_own_workspaces,can_manage_workspaces,is_staff_unit,requires_admin_approval\n",
          "team,Team,false,true,true,false,false,true,true,false,false\n",
          "team,Duplicate,false,true,true,false,false,true,true,false,false\n"
        )
        .to_string(),
      },
      CsvFile {
        name: "ou_types.csv".to_string(),
        content: String::new(),
      },
      CsvFile {
        name: "unsupported.csv".to_string(),
        content: String::new(),
      },
    ];

    let errors = OrganizationImportExportService::decode_import(None, Some(&files))
      .expect_err("unknown columns/files and duplicate files/entity keys must be rejected");
    assert!(
      errors
        .iter()
        .any(|error| { error.source == "organization.csv" && error.field.as_deref() == Some("unknown") })
    );
    assert!(
      errors
        .iter()
        .any(|error| { error.source == "ou_types.csv" && error.message == "duplicate CSV file name" })
    );
    assert!(
      errors
        .iter()
        .any(|error| { error.source == "ou_types.csv" && error.message.contains("duplicate unit-type key") })
    );
    assert!(errors.iter().any(|error| error.source == "unsupported.csv"));
  }
}
