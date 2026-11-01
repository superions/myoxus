//! `shared-workspaces` — OU-owned workspace administration.

use clap::{Args, Subcommand};
use myoxus_application::workspace::{UpdateWorkspace, WorkspaceName};
use serde::Serialize;
use sqlx::Row;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_json, print_output, print_single, print_table};
use crate::services::Services;
use crate::users::resolve_user as resolve_user_domain;
use crate::workspaces::parse_workspace_role;

#[derive(Subcommand)]
pub enum SharedWorkspacesCommand {
  /// List all OU-owned shared workspaces.
  List,
  /// Show one shared workspace and its members.
  Get(SharedWorkspaceGetArgs),
  /// Create a shared workspace owned by an existing organization unit.
  Create(SharedWorkspaceCreateArgs),
  /// Update shared-workspace master data.
  Update(SharedWorkspaceUpdateArgs),
  /// Add an accepted member to a shared workspace.
  AddMember(SharedWorkspaceAddMemberArgs),
  /// Change an existing member's role.
  SetMemberRole(SharedWorkspaceSetMemberRoleArgs),
  /// Remove a member from a shared workspace.
  RemoveMember(SharedWorkspaceRemoveMemberArgs),
  /// Soft-delete a shared workspace.
  Delete(SharedWorkspaceDeleteArgs),
  /// Restore a soft-deleted shared workspace.
  Undelete(SharedWorkspaceUndeleteArgs),
}

#[derive(Args)]
pub struct SharedWorkspaceGetArgs {
  /// UUID of the shared workspace.
  pub workspace_id: String,
}

#[derive(Args)]
pub struct SharedWorkspaceCreateArgs {
  /// Initial workspace name.
  #[arg(long)]
  pub name: String,
  /// UUID of the owning organization unit.
  #[arg(long)]
  pub unit: String,
  /// UUID or email of the explicit global administrator who initializes the workspace.
  #[arg(long, value_name = "UUID_OR_EMAIL")]
  pub admin: String,
}

#[derive(Args)]
pub struct SharedWorkspaceAddMemberArgs {
  pub workspace_id: String,
  pub user_id: String,
  /// Workspace role: Admin, Manager, Collaborator, Commenter, or Reader.
  #[arg(long, default_value = "Collaborator")]
  pub role: String,
  /// UUID or email of the explicit global administrator performing the mutation.
  #[arg(long, value_name = "UUID_OR_EMAIL")]
  pub actor: String,
}

#[derive(Args)]
pub struct SharedWorkspaceUpdateArgs {
  pub workspace_id: String,
  /// New shared-workspace name.
  #[arg(long)]
  pub name: String,
}

#[derive(Args)]
pub struct SharedWorkspaceSetMemberRoleArgs {
  pub workspace_id: String,
  /// UUID or email of the existing member.
  pub user_id: String,
  /// Workspace role: Admin, Manager, Collaborator, Commenter, or Reader.
  #[arg(long)]
  pub role: String,
}

#[derive(Args)]
pub struct SharedWorkspaceRemoveMemberArgs {
  pub workspace_id: String,
  pub user_id: String,
}

#[derive(Args)]
pub struct SharedWorkspaceDeleteArgs {
  pub workspace_id: String,
  #[arg(long)]
  pub confirm: bool,
}

#[derive(Args)]
pub struct SharedWorkspaceUndeleteArgs {
  pub workspace_id: String,
}

#[derive(Tabled, Serialize)]
struct SharedWorkspaceRow {
  id: String,
  name: String,
  owner_unit_id: String,
  owner_unit_name: String,
  member_count: i64,
  created_at: String,
}

#[derive(Tabled, Serialize)]
struct SharedWorkspaceMemberRow {
  user_id: String,
  email: String,
  name: String,
  role: String,
  status: String,
}

pub async fn run(cmd: SharedWorkspacesCommand, svc: &Services, json: bool) -> anyhow::Result<()> {
  match cmd {
    SharedWorkspacesCommand::List => list(svc, json).await,
    SharedWorkspacesCommand::Get(args) => get(args, svc, json).await,
    SharedWorkspacesCommand::Create(args) => create(args, svc, json).await,
    SharedWorkspacesCommand::Update(args) => update(args, svc, json).await,
    SharedWorkspacesCommand::AddMember(args) => add_member(args, svc).await,
    SharedWorkspacesCommand::SetMemberRole(args) => set_member_role(args, svc).await,
    SharedWorkspacesCommand::RemoveMember(args) => remove_member(args, svc).await,
    SharedWorkspacesCommand::Delete(args) => delete(args, svc).await,
    SharedWorkspacesCommand::Undelete(args) => undelete(args, svc, json).await,
  }
}

async fn list(svc: &Services, json: bool) -> anyhow::Result<()> {
  let rows = sqlx::query(
    r#"SELECT w.id, w.name, w.owner_principal_id, ou.name AS owner_unit_name,
              (SELECT COUNT(*) FROM workspace_memberships wm WHERE wm.workspace_id = w.id) AS member_count,
              w.created_at
         FROM workspaces w
         JOIN organization_unit ou ON ou.id = w.owner_principal_id
        WHERE w.owner_principal_type = 'ou' AND w.deleted_at IS NULL
        ORDER BY w.created_at"#,
  )
  .fetch_all(&svc.pool)
  .await?;
  let display = rows
    .into_iter()
    .map(|row| SharedWorkspaceRow {
      id: row.get::<Uuid, _>("id").to_string(),
      name: row.get("name"),
      owner_unit_id: row.get::<Uuid, _>("owner_principal_id").to_string(),
      owner_unit_name: row.get("owner_unit_name"),
      member_count: row.get("member_count"),
      created_at: row.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
    })
    .collect::<Vec<_>>();
  print_output(&display, json);
  Ok(())
}

async fn get(args: SharedWorkspaceGetArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  let detail = load_shared_workspace(svc, workspace_id).await?;
  let members = svc
    .workspace
    .list_members(workspace_id, 0, 10_000, None)
    .await
    .map_err(|error| anyhow::anyhow!(error.to_string()))?
    .into_iter()
    .map(|member| SharedWorkspaceMemberRow {
      user_id: member.user.id.to_string(),
      email: member.user.email,
      name: member.user.name,
      role: format!("{:?}", member.role),
      status: format!("{:?}", member.status),
    })
    .collect::<Vec<_>>();

  if json {
    #[derive(Serialize)]
    struct DetailOutput {
      workspace: SharedWorkspaceRow,
      members: Vec<SharedWorkspaceMemberRow>,
    }
    print_json(&DetailOutput {
      workspace: detail,
      members,
    });
  } else {
    print_single(&detail, false);
    println!("\nMembers:");
    print_table(&members);
  }
  Ok(())
}

async fn create(args: SharedWorkspaceCreateArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let owner_unit_id = args
    .unit
    .parse::<Uuid>()
    .map_err(|_| anyhow::anyhow!("Invalid organization unit UUID: {}", args.unit))?;
  let creator = resolve_global_admin(svc, &args.admin).await?;
  let workspace = svc
    .workspace
    .create_shared_workspace(owner_unit_id, creator, Some(args.name))
    .await
    .map_err(|error| anyhow::anyhow!("Failed to create shared workspace: {error}"))?;
  let detail = load_shared_workspace(svc, workspace.id).await?;
  print_single(&detail, json);
  Ok(())
}

async fn add_member(args: SharedWorkspaceAddMemberArgs, svc: &Services) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  load_shared_workspace(svc, workspace_id).await?;
  let user = resolve_user_domain(svc, &args.user_id).await?;
  let actor = resolve_global_admin(svc, &args.actor).await?;
  let role = parse_workspace_role(&args.role)?;
  svc
    .workspace
    .add_member_direct(workspace_id, user.id, role, actor)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to add shared workspace member: {error}"))?;
  println!(
    "User {} added to shared workspace {} as {:?}.",
    user.id, workspace_id, role
  );
  Ok(())
}

async fn update(args: SharedWorkspaceUpdateArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  load_shared_workspace(svc, workspace_id).await?;
  let name = WorkspaceName::parse(&args.name).map_err(|error| anyhow::anyhow!(error.to_string()))?;
  svc
    .workspace
    .update_workspace(
      workspace_id,
      UpdateWorkspace {
        name: Some(name),
        ..Default::default()
      },
    )
    .await
    .map_err(|error| anyhow::anyhow!("Failed to update shared workspace: {error}"))?;
  print_single(&load_shared_workspace(svc, workspace_id).await?, json);
  Ok(())
}

async fn set_member_role(args: SharedWorkspaceSetMemberRoleArgs, svc: &Services) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  load_shared_workspace(svc, workspace_id).await?;
  let user = resolve_user_domain(svc, &args.user_id).await?;
  let role = parse_workspace_role(&args.role)?;
  svc
    .workspace
    .update_member_role(workspace_id, user.id, role)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to update shared workspace member role: {error}"))?;
  println!(
    "User {} now has {:?} in shared workspace {}.",
    user.id, role, workspace_id
  );
  Ok(())
}

async fn remove_member(args: SharedWorkspaceRemoveMemberArgs, svc: &Services) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  load_shared_workspace(svc, workspace_id).await?;
  let user = resolve_user_domain(svc, &args.user_id).await?;
  svc
    .workspace
    .revoke_member(workspace_id, user.id)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to remove shared workspace member: {error}"))?;
  println!("User {} removed from shared workspace {}.", user.id, workspace_id);
  Ok(())
}

async fn delete(args: SharedWorkspaceDeleteArgs, svc: &Services) -> anyhow::Result<()> {
  if !args.confirm {
    anyhow::bail!("Pass --confirm to delete the shared workspace");
  }
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  load_shared_workspace(svc, workspace_id).await?;
  svc
    .workspace
    .delete_workspace(workspace_id)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to delete shared workspace: {error}"))?;
  println!("Shared workspace {workspace_id} deleted.");
  Ok(())
}

async fn undelete(args: SharedWorkspaceUndeleteArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  let details = svc
    .admin
    .workspace_details(workspace_id)
    .await
    .map_err(|error| anyhow::anyhow!(error.to_string()))?
    .ok_or_else(|| anyhow::anyhow!("Shared workspace not found: {workspace_id}"))?;
  if details.owner_principal_type != "ou" {
    anyhow::bail!("Workspace {workspace_id} is not an OU-owned shared workspace");
  }
  svc
    .workspace
    .undelete_workspace(workspace_id)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to restore shared workspace: {error}"))?;
  print_single(&load_shared_workspace(svc, workspace_id).await?, json);
  Ok(())
}

async fn load_shared_workspace(svc: &Services, workspace_id: Uuid) -> anyhow::Result<SharedWorkspaceRow> {
  let row = sqlx::query(
    r#"SELECT w.id, w.name, w.owner_principal_id, ou.name AS owner_unit_name,
              (SELECT COUNT(*) FROM workspace_memberships wm WHERE wm.workspace_id = w.id) AS member_count,
              w.created_at
         FROM workspaces w
         JOIN organization_unit ou ON ou.id = w.owner_principal_id
        WHERE w.id = $1 AND w.owner_principal_type = 'ou' AND w.deleted_at IS NULL"#,
  )
  .bind(workspace_id)
  .fetch_optional(&svc.pool)
  .await?
  .ok_or_else(|| anyhow::anyhow!("Shared workspace not found: {workspace_id}"))?;
  Ok(SharedWorkspaceRow {
    id: row.get::<Uuid, _>("id").to_string(),
    name: row.get("name"),
    owner_unit_id: row.get::<Uuid, _>("owner_principal_id").to_string(),
    owner_unit_name: row.get("owner_unit_name"),
    member_count: row.get("member_count"),
    created_at: row.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
  })
}

/// Resolve the operator-selected principal without guessing from global users.
///
/// Requiring the caller to name the administrator keeps privileged local CLI
/// operations attributable and independent of database row ordering.
async fn resolve_global_admin(svc: &Services, value: &str) -> anyhow::Result<Uuid> {
  let user = resolve_user_domain(svc, value).await?;
  if user.status != myoxus_domain::entities::AccountStatus::Active || user.disabled {
    anyhow::bail!("User {} is disabled", user.id);
  }
  if !user.is_admin {
    anyhow::bail!("User {} is not a global admin", user.id);
  }
  Ok(user.id)
}

fn parse_workspace_id(value: &str) -> anyhow::Result<Uuid> {
  value
    .parse::<Uuid>()
    .map_err(|_| anyhow::anyhow!("Invalid shared workspace UUID: {value}"))
}
