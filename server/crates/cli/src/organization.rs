// SPDX-License-Identifier: AGPL-3.0-or-later
//! Operator adapter for the shared OU lifecycle and existing membership stores.
//!
//! Explicit organization guards remain here; lifecycle validation, transactional
//! writes and audit belong to the same Application service as GraphQL and MCP.

use anyhow::{Context, ensure};
use chrono::Utc;
use clap::{ArgGroup, Args, Subcommand, ValueEnum};
use myoxus_application::organization::{MembershipChange, MembershipOperation};
use myoxus_domain::entities::{OrganizationUnit, OrganizationUnitRole, OrganizationUnitStatus};
use myoxus_domain::repositories::{OrganizationUnitRepository, OrganizationUnitTypeRepository};
use myoxus_infrastructure::organization::{PgOrganizationUnitRepository, PgOrganizationUnitTypeRepository};
use serde::Serialize;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_output, print_single};
use crate::services::Services;
use crate::users::resolve_user;

#[derive(Subcommand)]
pub enum OrganizationCommand {
  /// Manage organization units and their hierarchy.
  #[command(subcommand)]
  Units(OrganizationUnitsCommand),
  /// Manage organization-unit memberships.
  #[command(subcommand)]
  Members(OrganizationMembersCommand),
}

#[derive(Subcommand)]
pub enum OrganizationUnitsCommand {
  /// List units in an organization.
  List(UnitListArgs),
  /// Show one unit.
  Get(UnitIdentityArgs),
  /// Create an active unit.
  Create(UnitCreateArgs),
  /// Update a unit's type or descriptive fields.
  Update(UnitUpdateArgs),
  /// Move a unit below another unit or to organization root.
  Move(UnitMoveArgs),
  /// Soft-archive a unit while retaining its hierarchy and references.
  Archive(UnitIdentityArgs),
}

#[derive(Subcommand)]
pub enum OrganizationMembersCommand {
  /// List the members of one unit.
  List(MemberListArgs),
  /// Add a user who is not currently a member of the unit.
  Add(MemberMutationArgs),
  /// Change the role of an existing unit member.
  SetRole(MemberMutationArgs),
  /// Remove a user from a unit.
  Remove(MemberIdentityArgs),
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum UnitStatusArg {
  Active,
  Disabled,
  Archived,
}

impl From<UnitStatusArg> for OrganizationUnitStatus {
  fn from(value: UnitStatusArg) -> Self {
    match value {
      UnitStatusArg::Active => Self::Active,
      UnitStatusArg::Disabled => Self::Disabled,
      UnitStatusArg::Archived => Self::Archived,
    }
  }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum UnitRoleArg {
  Reader,
  Member,
  Manager,
}

impl From<UnitRoleArg> for OrganizationUnitRole {
  fn from(value: UnitRoleArg) -> Self {
    match value {
      UnitRoleArg::Reader => Self::Reader,
      UnitRoleArg::Member => Self::Member,
      UnitRoleArg::Manager => Self::Manager,
    }
  }
}

#[derive(Args)]
pub struct UnitListArgs {
  /// Organization UUID.
  #[arg(long)]
  organization: Uuid,
  /// Optional unit status filter.
  #[arg(long, value_enum)]
  status: Option<UnitStatusArg>,
}

#[derive(Args)]
pub struct UnitIdentityArgs {
  /// Organization UUID used to guard against cross-organization mistakes.
  #[arg(long)]
  organization: Uuid,
  /// Organization-unit UUID.
  #[arg(long)]
  unit: Uuid,
}

#[derive(Args)]
#[command(group(
  ArgGroup::new("parent_location")
    .required(true)
    .multiple(false)
    .args(["parent", "root"])
))]
pub struct UnitCreateArgs {
  /// Organization UUID.
  #[arg(long)]
  organization: Uuid,
  /// Organization-unit type UUID.
  #[arg(long)]
  unit_type: Uuid,
  /// Display name.
  #[arg(long)]
  name: String,
  /// Stable slug within the selected hierarchy scope.
  #[arg(long)]
  slug: String,
  /// Optional description.
  #[arg(long)]
  description: Option<String>,
  /// Parent organization-unit UUID.
  #[arg(long)]
  parent: Option<Uuid>,
  /// Create the unit at organization root.
  #[arg(long)]
  root: bool,
}

#[derive(Args)]
pub struct UnitUpdateArgs {
  /// Organization UUID used to guard against cross-organization mistakes.
  #[arg(long)]
  organization: Uuid,
  /// Organization-unit UUID.
  #[arg(long)]
  unit: Uuid,
  /// Explicit organization-unit type UUID for the resulting unit.
  #[arg(long)]
  unit_type: Uuid,
  /// Replacement display name.
  #[arg(long)]
  name: Option<String>,
  /// Replacement hierarchy-scoped slug.
  #[arg(long)]
  slug: Option<String>,
  /// Replacement description.
  #[arg(long, conflicts_with = "clear_description")]
  description: Option<String>,
  /// Remove the current description.
  #[arg(long)]
  clear_description: bool,
}

#[derive(Args)]
#[command(group(
  ArgGroup::new("parent_location")
    .required(true)
    .multiple(false)
    .args(["parent", "root"])
))]
pub struct UnitMoveArgs {
  /// Organization UUID used to guard against cross-organization mistakes.
  #[arg(long)]
  organization: Uuid,
  /// Organization-unit UUID.
  #[arg(long)]
  unit: Uuid,
  /// New parent organization-unit UUID.
  #[arg(long)]
  parent: Option<Uuid>,
  /// Move the unit to organization root.
  #[arg(long)]
  root: bool,
}

#[derive(Args)]
pub struct MemberListArgs {
  /// Organization UUID used to guard against cross-organization mistakes.
  #[arg(long)]
  organization: Uuid,
  /// Organization-unit UUID.
  #[arg(long)]
  unit: Uuid,
  /// Optional membership role filter.
  #[arg(long, value_enum)]
  role: Option<UnitRoleArg>,
}

#[derive(Args)]
pub struct MemberMutationArgs {
  /// Organization UUID used to guard against cross-organization mistakes.
  #[arg(long)]
  organization: Uuid,
  /// Organization-unit UUID.
  #[arg(long)]
  unit: Uuid,
  /// User UUID or exact normalized email address.
  #[arg(long)]
  user: String,
  /// Membership role.
  #[arg(long, value_enum)]
  role: UnitRoleArg,
}

#[derive(Args)]
pub struct MemberIdentityArgs {
  /// Organization UUID used to guard against cross-organization mistakes.
  #[arg(long)]
  organization: Uuid,
  /// Organization-unit UUID.
  #[arg(long)]
  unit: Uuid,
  /// User UUID or exact normalized email address.
  #[arg(long)]
  user: String,
}

#[derive(Serialize, Tabled)]
struct UnitRow {
  id: String,
  organization_id: String,
  parent_unit_id: String,
  unit_type_id: String,
  name: String,
  slug: String,
  description: String,
  status: String,
  max_members: i32,
  metadata: String,
  child_units: i64,
  members: i64,
  workspaces: i64,
  created_by: String,
  created_at: String,
  updated_at: String,
}

impl From<OrganizationUnit> for UnitRow {
  fn from(unit: OrganizationUnit) -> Self {
    Self {
      id: unit.id.to_string(),
      organization_id: unit.organization_id.to_string(),
      parent_unit_id: unit.parent_unit_id.map(|id| id.to_string()).unwrap_or_default(),
      unit_type_id: unit.unit_type_id.to_string(),
      name: unit.name,
      slug: unit.slug,
      description: unit.description.unwrap_or_default(),
      status: unit.status.as_str().to_string(),
      max_members: unit.max_members,
      metadata: unit.metadata.to_string(),
      child_units: unit.child_unit_count,
      members: unit.member_count,
      workspaces: unit.workspace_count,
      created_by: unit.created_by.map(|id| id.to_string()).unwrap_or_default(),
      created_at: unit.created_at.to_rfc3339(),
      updated_at: unit.updated_at.to_rfc3339(),
    }
  }
}

#[derive(Serialize, Tabled)]
struct MemberRow {
  unit_id: String,
  user_id: String,
  email: String,
  name: String,
  role: String,
  source: String,
  metadata: String,
  created_at: String,
  updated_at: String,
}

#[derive(Serialize, Tabled)]
struct MutationResult {
  operation: String,
  unit_id: String,
  user_id: String,
  role: String,
  manager_capability_changed: bool,
}

pub async fn run(command: OrganizationCommand, services: &Services, json: bool) -> anyhow::Result<()> {
  match command {
    OrganizationCommand::Units(command) => run_units(command, services, json).await,
    OrganizationCommand::Members(command) => run_members(command, services, json).await,
  }
}

async fn run_units(command: OrganizationUnitsCommand, services: &Services, json: bool) -> anyhow::Result<()> {
  let units = PgOrganizationUnitRepository::new(services.pool.clone());
  match command {
    OrganizationUnitsCommand::List(args) => {
      let rows = units
        .list(args.organization, args.status.map(Into::into))
        .await
        .context("list organization units")?
        .into_iter()
        .map(UnitRow::from)
        .collect::<Vec<_>>();
      print_output(&rows, json);
    }
    OrganizationUnitsCommand::Get(args) => {
      let unit = require_unit(&units, args.organization, args.unit).await?;
      print_single(&UnitRow::from(unit), json);
    }
    OrganizationUnitsCommand::Create(args) => {
      require_unit_type(services, args.organization, args.unit_type).await?;
      if let Some(parent) = args.parent {
        require_unit(&units, args.organization, parent).await?;
      }
      let now = Utc::now();
      let unit = services
        .organization_unit_lifecycle
        .create(
          &OrganizationUnit {
            id: Uuid::new_v4(),
            organization_id: args.organization,
            parent_unit_id: args.parent,
            unit_type_id: args.unit_type,
            name: args.name,
            slug: args.slug,
            description: args.description,
            status: OrganizationUnitStatus::Active,
            max_members: 25,
            metadata: serde_json::json!({}),
            created_by: None,
            child_unit_count: 0,
            member_count: 0,
            workspace_count: 0,
            created_at: now,
            updated_at: now,
          },
          myoxus_domain::audit::AuditActor::system(),
        )
        .await
        .context("create organization unit")?;
      print_single(&UnitRow::from(unit), json);
    }
    OrganizationUnitsCommand::Update(args) => {
      require_unit_type(services, args.organization, args.unit_type).await?;
      let mut unit = require_unit(&units, args.organization, args.unit).await?;
      unit.unit_type_id = args.unit_type;
      if let Some(name) = args.name {
        unit.name = name;
      }
      if let Some(slug) = args.slug {
        unit.slug = slug;
      }
      if args.clear_description {
        unit.description = None;
      } else if let Some(description) = args.description {
        unit.description = Some(description);
      }
      // Start from persisted state so omitted CLI fields never inherit GraphQL
      // full-upsert defaults (including placement, status and member limits).
      let unit = services
        .organization_unit_lifecycle
        .update(&unit, myoxus_domain::audit::AuditActor::system())
        .await
        .context("update organization unit")?;
      print_single(&UnitRow::from(unit), json);
    }
    OrganizationUnitsCommand::Move(args) => {
      require_unit(&units, args.organization, args.unit).await?;
      if let Some(parent) = args.parent {
        require_unit(&units, args.organization, parent).await?;
      }
      let unit = services
        .organization_unit_lifecycle
        .move_unit(args.unit, args.parent, myoxus_domain::audit::AuditActor::system())
        .await
        .context("move organization unit")?;
      print_single(&UnitRow::from(unit), json);
    }
    OrganizationUnitsCommand::Archive(args) => {
      require_unit(&units, args.organization, args.unit).await?;
      let unit = services
        .organization_unit_lifecycle
        .set_status(
          args.unit,
          OrganizationUnitStatus::Archived,
          myoxus_domain::audit::AuditActor::system(),
        )
        .await
        .context("archive organization unit")?;
      print_single(&UnitRow::from(unit), json);
    }
  }
  Ok(())
}

async fn run_members(command: OrganizationMembersCommand, services: &Services, json: bool) -> anyhow::Result<()> {
  let units = PgOrganizationUnitRepository::new(services.pool.clone());

  match command {
    OrganizationMembersCommand::List(args) => {
      require_unit(&units, args.organization, args.unit).await?;
      let rows = services
        .organization_reads
        .unit_members(args.unit, args.role.map(Into::into))
        .await
        .context("list organization-unit members")?
        .into_iter()
        .map(|row| {
          let member = row.membership;
          MemberRow {
            unit_id: member.unit_id.to_string(),
            user_id: member.user_id.to_string(),
            email: row.email.unwrap_or_default(),
            name: row.name.unwrap_or_default(),
            role: member.role.as_str().to_string(),
            source: member.source.as_str().to_string(),
            metadata: member.metadata.to_string(),
            created_at: member.created_at.to_rfc3339(),
            updated_at: member.updated_at.to_rfc3339(),
          }
        })
        .collect::<Vec<_>>();
      print_output(&rows, json);
    }
    OrganizationMembersCommand::Add(args) => {
      let result = mutate_member(args, services, true).await?;
      print_single(&result, json);
    }
    OrganizationMembersCommand::SetRole(args) => {
      let result = mutate_member(args, services, false).await?;
      print_single(&result, json);
    }
    OrganizationMembersCommand::Remove(args) => {
      require_unit(&units, args.organization, args.unit).await?;
      let user = resolve_user(services, &args.user).await?;
      let commit = services
        .organization_memberships
        .apply(
          MembershipChange {
            organization_id: Some(args.organization),
            unit_id: args.unit,
            user_id: user.id,
            operation: MembershipOperation::RemoveExisting,
            role: OrganizationUnitRole::Member,
            metadata: serde_json::json!({}),
            manager_id: None,
          },
          myoxus_domain::audit::AuditActor::system(),
        )
        .await?;
      let previous = commit.previous.context("removed membership missing from commit")?;
      let capability_changed = commit.manager_capability.is_some();
      print_single(
        &MutationResult {
          operation: "removed".to_string(),
          unit_id: args.unit.to_string(),
          user_id: user.id.to_string(),
          role: previous.role.as_str().to_string(),
          manager_capability_changed: capability_changed,
        },
        json,
      );
    }
  }
  Ok(())
}

async fn mutate_member(args: MemberMutationArgs, services: &Services, is_add: bool) -> anyhow::Result<MutationResult> {
  let user = resolve_user(services, &args.user).await?;
  let commit = services
    .organization_memberships
    .apply(
      MembershipChange {
        organization_id: Some(args.organization),
        unit_id: args.unit,
        user_id: user.id,
        operation: if is_add {
          MembershipOperation::Add
        } else {
          MembershipOperation::SetRole
        },
        role: args.role.into(),
        metadata: serde_json::json!({"assigned_by": "myoxus-cli"}),
        manager_id: None,
      },
      myoxus_domain::audit::AuditActor::system(),
    )
    .await?;
  let saved = commit.current.context("membership missing from committed assignment")?;
  Ok(MutationResult {
    operation: if is_add { "added" } else { "role-updated" }.to_string(),
    unit_id: saved.unit_id.to_string(),
    user_id: saved.user_id.to_string(),
    role: saved.role.as_str().to_string(),
    manager_capability_changed: commit.manager_capability.is_some(),
  })
}

async fn require_unit(
  units: &PgOrganizationUnitRepository,
  organization_id: Uuid,
  unit_id: Uuid,
) -> anyhow::Result<OrganizationUnit> {
  let unit = units
    .get_by_id(unit_id)
    .await
    .context("load organization unit")?
    .with_context(|| format!("organization unit not found: {unit_id}"))?;
  ensure!(
    unit.organization_id == organization_id,
    "organization unit {unit_id} does not belong to organization {organization_id}"
  );
  Ok(unit)
}

async fn require_unit_type(services: &Services, organization_id: Uuid, unit_type_id: Uuid) -> anyhow::Result<()> {
  let types = PgOrganizationUnitTypeRepository::new(services.pool.clone());
  let unit_type = types
    .get_by_id(unit_type_id)
    .await
    .context("load organization-unit type")?
    .with_context(|| format!("organization-unit type not found: {unit_type_id}"))?;
  ensure!(
    unit_type.organization_id == organization_id,
    "organization-unit type {unit_type_id} does not belong to organization {organization_id}"
  );
  Ok(())
}
