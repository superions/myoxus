//! `workspaces` subcommand — workspace management via the application service layer.

use clap::{Args, Subcommand};
use myoxus_application::public::PublicRepository;
use myoxus_application::workspace::{UpdateWorkspace, WorkspaceName, WorkspaceOwnerTarget};
use myoxus_domain::entities::WorkspaceRole;
use myoxus_infrastructure::public::PgPublicRepository;
use serde::Serialize;
use sqlx::PgPool;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_json, print_output, print_single, print_table};
use crate::services::Services;
use crate::users::resolve_user as resolve_user_domain;

/// Subcommands for `workspaces`.
#[derive(Subcommand)]
pub enum WorkspacesCommand {
  /// Inspect or explicitly reconcile SQL/legacy workspace Labels (Tags).
  Labels {
    #[command(subcommand)]
    command: WorkspaceLabelsCommand,
  },
  /// List workspaces (optionally filtered by member user).
  List(WorkspaceListArgs),
  /// Create a non-personal workspace owned by an existing user.
  Create(WorkspaceCreateArgs),
  /// Show detail for a single workspace.
  Get(WorkspaceGetArgs),
  /// Ensure the canonical protected Task container without reseeding user contents.
  EnsureTasks { workspace_id: Uuid },
  /// List members and their roles for a workspace.
  Members(WorkspaceMembersArgs),
  /// Show storage and document statistics for a workspace.
  Stats(WorkspaceStatsArgs),
  /// Seed root doc for a workspace (fixes blank workspace issue).
  SeedRootDoc(WorkspaceSeedRootDocArgs),
  /// Compact a document: merge pending updates into a snapshot.
  ///
  /// Reads all pending `doc_updates` for the given document, merges them with
  /// the existing snapshot via Y.js, and writes a new snapshot. Pending updates
  /// that were absorbed by the snapshot are then deleted.
  ///
  /// Use `--dry-run` to preview the compaction without writing anything.
  CompactDoc(WorkspaceCompactDocArgs),
  /// Update workspace master data.
  Update(WorkspaceUpdateArgs),
  /// Add an accepted member.
  AddMember(WorkspaceAddMemberArgs),
  /// Change an existing member's role.
  SetMemberRole(WorkspaceSetMemberRoleArgs),
  /// Remove an existing member.
  RemoveMember(WorkspaceRemoveMemberArgs),
  /// Transfer ownership to a user or organization unit.
  TransferOwner(WorkspaceTransferOwnerArgs),
  /// Set or clear the operational management unit.
  SetManagementUnit(WorkspaceSetManagementUnitArgs),
  /// Enable or disable external link sharing.
  SetSharing(WorkspaceBooleanSettingArgs),
  /// Enable or disable public workspace access.
  SetPublic(WorkspaceBooleanSettingArgs),
  /// Soft-delete a workspace (requires --confirm).
  Delete(WorkspaceDeleteArgs),
  /// Restore a soft-deleted workspace.
  Undelete(WorkspaceUndeleteArgs),
}

#[derive(Subcommand)]
pub enum WorkspaceLabelsCommand {
  /// Read-only catalog, ordered assignment, identity and SQL/root revision report.
  Inspect { workspace_id: Uuid },
  /// Apply explicit decisions after backup, approved choices and client cutover.
  Apply {
    workspace_id: Uuid,
    /// Immutable JSON decision file containing inspected revisions and selected documents.
    #[arg(long)]
    decisions: std::path::PathBuf,
    /// Existing user recorded as the operator; no synthetic superadmin is required.
    #[arg(long)]
    actor: String,
    /// Acknowledge updated clients are deployed and editing of this workspace is stopped.
    #[arg(long, required = true)]
    cutover_acknowledged: bool,
  },
}

/// Arguments for `workspaces list`.
#[derive(Args)]
pub struct WorkspaceListArgs {
  /// Optional UUID or email of a user — list only workspaces they belong to.
  #[arg(long)]
  pub user: Option<String>,
}

#[derive(Args)]
pub struct WorkspaceCreateArgs {
  /// UUID or email of the owning user.
  #[arg(long, value_name = "UUID_OR_EMAIL")]
  pub owner_user: String,
  /// Initial workspace name.
  #[arg(long)]
  pub name: String,
}

/// Arguments for `workspaces get`.
#[derive(Args)]
pub struct WorkspaceGetArgs {
  /// UUID of the workspace.
  pub id: String,
}

/// Arguments for `workspaces members`.
#[derive(Args)]
pub struct WorkspaceMembersArgs {
  /// UUID of the workspace.
  pub id: String,
}

/// Arguments for `workspaces stats`.
#[derive(Args)]
pub struct WorkspaceStatsArgs {
  /// UUID of the workspace.
  pub id: String,
}

/// Arguments for `workspaces seed-root-doc`.
#[derive(Args)]
pub struct WorkspaceSeedRootDocArgs {
  /// UUID of the workspace, or "all" to seed all workspaces missing root doc content.
  pub id: String,
  /// Active global administrator used as `created_by`.
  /// Required for `all`; a single user-owned workspace may fall back to its owner.
  #[arg(long)]
  pub admin_user_id: Option<Uuid>,
}

/// Arguments for `workspaces delete`.
#[derive(Args)]
pub struct WorkspaceDeleteArgs {
  /// UUID of the workspace.
  pub id: String,
  /// Confirm the destructive soft-delete.
  #[arg(long)]
  pub confirm: bool,
}

#[derive(Args)]
pub struct WorkspaceUpdateArgs {
  /// UUID of the workspace.
  pub id: String,
  /// New workspace name.
  #[arg(long)]
  pub name: String,
}

#[derive(Args)]
pub struct WorkspaceAddMemberArgs {
  pub workspace_id: String,
  /// UUID or email of the member.
  pub user: String,
  /// Workspace role: Admin, Manager, Collaborator, Commenter, or Reader.
  #[arg(long, default_value = "Collaborator")]
  pub role: String,
  /// UUID or email of the explicit actor recorded for the membership change.
  #[arg(long, value_name = "UUID_OR_EMAIL")]
  pub actor: String,
}

#[derive(Args)]
pub struct WorkspaceSetMemberRoleArgs {
  pub workspace_id: String,
  /// UUID or email of the existing member.
  pub user: String,
  /// Workspace role: Admin, Manager, Collaborator, Commenter, or Reader.
  #[arg(long)]
  pub role: String,
}

#[derive(Args)]
pub struct WorkspaceRemoveMemberArgs {
  pub workspace_id: String,
  /// UUID or email of the existing member.
  pub user: String,
}

#[derive(Args)]
pub struct WorkspaceTransferOwnerArgs {
  pub workspace_id: String,
  /// UUID or email of the new user owner.
  #[arg(
    long,
    value_name = "UUID_OR_EMAIL",
    required_unless_present = "to_unit",
    conflicts_with = "to_unit"
  )]
  pub to_user: Option<String>,
  /// UUID of the new owner organization unit.
  #[arg(
    long,
    value_name = "UUID",
    required_unless_present = "to_user",
    conflicts_with = "to_user"
  )]
  pub to_unit: Option<Uuid>,
}

#[derive(Args)]
pub struct WorkspaceSetManagementUnitArgs {
  pub workspace_id: String,
  /// UUID of the operational management unit.
  #[arg(
    long,
    value_name = "UUID",
    required_unless_present = "clear",
    conflicts_with = "clear"
  )]
  pub unit: Option<Uuid>,
  /// Remove the operational management-unit assignment.
  #[arg(long, required_unless_present = "unit", conflicts_with = "unit")]
  pub clear: bool,
}

#[derive(Args)]
pub struct WorkspaceBooleanSettingArgs {
  pub workspace_id: String,
  /// New setting value.
  #[arg(long, action = clap::ArgAction::Set)]
  pub enabled: bool,
}

#[derive(Args)]
pub struct WorkspaceUndeleteArgs {
  /// UUID of the soft-deleted workspace.
  pub id: String,
}

/// Arguments for `workspaces compact-doc`.
#[derive(Args)]
pub struct WorkspaceCompactDocArgs {
  /// UUID of the workspace that owns the document.
  pub workspace_id: Uuid,
  /// UUID of the document to compact (use workspace UUID for the root doc).
  pub doc_id: Uuid,
  /// Preview compaction stats without writing a new snapshot.
  #[arg(long)]
  pub dry_run: bool,
  /// Minimum number of pending updates required to trigger compaction (default: 1).
  ///
  /// Set to 0 to compact even if there are no pending updates (re-writes the
  /// existing snapshot, useful for defragmentation).
  #[arg(long, default_value_t = 1)]
  pub min_updates: usize,
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// Summary row for workspace list.
#[derive(Tabled, Serialize)]
pub struct WorkspaceRow {
  /// Workspace UUID.
  pub id: String,
  /// Workspace name.
  pub name: String,
  /// Owner user UUID.
  pub owner_user_id: String,
  /// Whether the workspace is publicly accessible.
  pub public: bool,
  /// RFC-3339 creation timestamp.
  pub created_at: String,
}

/// Detailed workspace view.
#[derive(Tabled, Serialize)]
pub struct WorkspaceDetail {
  /// Workspace UUID.
  pub id: String,
  /// Workspace name.
  pub name: String,
  /// Owner user UUID.
  pub owner_user_id: String,
  /// Whether the workspace is publicly accessible.
  pub public: bool,
  /// Whether AI features are enabled.
  pub enable_ai: bool,
  /// Whether link sharing is enabled.
  pub enable_sharing: bool,
  /// RFC-3339 creation timestamp.
  pub created_at: String,
  /// RFC-3339 last-updated timestamp.
  pub updated_at: String,
  /// RFC-3339 deletion timestamp (empty if not deleted).
  pub deleted_at: String,
}

/// Statistics snapshot for a workspace.
#[derive(Tabled, Serialize)]
pub struct WorkspaceStats {
  /// Workspace UUID.
  pub workspace_id: String,
  /// Workspace name.
  pub name: String,
  /// Number of active (non-deleted) documents.
  pub doc_count: i64,
  /// Number of workspace members (all statuses).
  pub member_count: i64,
  /// Number of blobs (non-deleted).
  pub blob_count: i64,
  /// Total snapshot storage bytes tracked in `workspace_storage_stats`.
  pub snapshot_bytes: i64,
  /// Total blob storage bytes tracked in `workspace_storage_stats`.
  pub blob_bytes: i64,
}

/// Member row.
#[derive(Tabled, Serialize)]
pub struct WorkspaceMemberRow {
  /// User UUID.
  pub user_id: String,
  /// User email.
  pub email: String,
  /// User display name.
  pub name: String,
  /// Role in the workspace.
  pub role: String,
  /// Membership status.
  pub status: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `workspaces` subcommand via the service layer.
pub async fn run(cmd: WorkspacesCommand, svc: &Services, json: bool) -> anyhow::Result<()> {
  match cmd {
    WorkspacesCommand::Labels { command } => labels(command, svc, json).await,
    WorkspacesCommand::List(args) => list(args, svc, json).await,
    WorkspacesCommand::Create(args) => create(args, svc, json).await,
    WorkspacesCommand::Get(args) => get(args, svc, json).await,
    WorkspacesCommand::EnsureTasks { workspace_id } => {
      let record = svc.ensure_workspace_tasks(workspace_id).await?;
      #[derive(Serialize)]
      #[serde(rename_all = "camelCase")]
      struct Result {
        workspace_id: Uuid,
        database_id: Uuid,
        managed_schema: Option<myoxus_domain::database::DatabaseManagedSchema>,
      }
      let result = Result {
        workspace_id,
        database_id: record.database.id,
        managed_schema: record.managed_schema,
      };
      if json {
        print_json(&result);
      } else {
        println!("Workspace Tasks: {}", result.database_id);
        if let Some(schema) = result.managed_schema {
          println!("Readiness: {:?}", schema.readiness);
          if let Some(reason) = schema.reason_code {
            println!("Reason: {reason}");
          }
        }
      }
      Ok(())
    }
    WorkspacesCommand::Members(args) => members(args, svc, json).await,
    WorkspacesCommand::Stats(args) => stats(args, &svc.pool, json).await,
    WorkspacesCommand::SeedRootDoc(args) => seed_root_doc(args, svc).await,
    WorkspacesCommand::CompactDoc(args) => compact_doc(args, svc).await,
    WorkspacesCommand::Update(args) => update(args, svc, json).await,
    WorkspacesCommand::AddMember(args) => add_member(args, svc).await,
    WorkspacesCommand::SetMemberRole(args) => set_member_role(args, svc).await,
    WorkspacesCommand::RemoveMember(args) => remove_member(args, svc).await,
    WorkspacesCommand::TransferOwner(args) => transfer_owner(args, svc).await,
    WorkspacesCommand::SetManagementUnit(args) => set_management_unit(args, svc).await,
    WorkspacesCommand::SetSharing(args) => set_sharing(args, svc).await,
    WorkspacesCommand::SetPublic(args) => set_public(args, svc).await,
    WorkspacesCommand::Delete(args) => delete(args, svc).await,
    WorkspacesCommand::Undelete(args) => undelete(args, svc, json).await,
  }
}

async fn labels(command: WorkspaceLabelsCommand, svc: &Services, json: bool) -> anyhow::Result<()> {
  use myoxus_application::workspace_tags::migration::LabelRepairDecision;
  use std::io::Read;
  let service = svc.label_migration()?;
  let limits = svc.workspace_import_policy().await?.limits;
  match command {
    WorkspaceLabelsCommand::Inspect { workspace_id } => {
      let report = service.inspect(workspace_id, limits).await?;
      if json {
        print_json(&report);
      } else {
        #[derive(Tabled)]
        struct Row {
          external_id: String,
          sql_id: String,
          state: String,
          sql_tags: String,
          yjs_tags: String,
          unknown: String,
          retired: String,
        }
        println!(
          "Workspace: {}\nSQL revision: {}\nRoot revision: {}",
          report.workspace_id, report.sql_revision, report.root_revision
        );
        let rows = report
          .documents
          .iter()
          .map(|doc| Row {
            external_id: doc.external_id.clone(),
            sql_id: doc.doc_id.map(|id| id.to_string()).unwrap_or_else(|| "unmapped".into()),
            state: doc.status.into(),
            sql_tags: serde_json::to_string(&doc.sql_tags).expect("serializable label IDs"),
            yjs_tags: serde_json::to_string(&doc.yjs_tags).expect("serializable label IDs"),
            unknown: doc.unknown_ids.join(", "),
            retired: doc.retired_ids.join(", "),
          })
          .collect::<Vec<_>>();
        print_table(&rows);
        println!(
          "SQL catalog: {}\nLegacy catalog: {}\nLegacy identity mappings: {}\nRetired identities: {}",
          serde_json::to_string_pretty(&report.catalog)?,
          serde_json::to_string_pretty(&report.legacy_catalog)?,
          serde_json::to_string_pretty(&report.legacy_id_mappings)?,
          serde_json::to_string_pretty(&report.retired_ids)?
        );
      }
    }
    WorkspaceLabelsCommand::Apply {
      workspace_id,
      decisions,
      actor,
      cutover_acknowledged,
    } => {
      // Bound the file read itself, including a concurrent file growth. The
      // application/persistence boundary independently bounds parsed decisions.
      let mut bytes = Vec::new();
      std::fs::File::open(decisions)?
        .take(limits.max_document_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
      anyhow::ensure!(
        bytes.len() as u64 <= limits.max_document_bytes,
        "repair decision exceeds metadata limits"
      );
      let decision: LabelRepairDecision = serde_json::from_slice(&bytes)?;
      anyhow::ensure!(
        decision.workspace_id == workspace_id,
        "decision file belongs to another workspace"
      );
      let actor = resolve_user_domain(svc, &actor).await?;
      let result = service.apply(actor.id, &decision, cutover_acknowledged, limits).await?;
      if json {
        print_json(&result);
      } else {
        println!(
          "Workspace {}: {}; {} explicit documents, {} imported labels, root catalog removed: {}",
          result.workspace_id,
          if result.changed {
            "repair committed"
          } else {
            "already reconciled"
          },
          result.documents,
          result.imported_tags,
          result.root_catalog_removed
        );
      }
    }
  }
  Ok(())
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async fn create(args: WorkspaceCreateArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let owner = resolve_user_domain(svc, &args.owner_user).await?;
  // Root metadata must use the same normalized name as the persisted owner.
  let name = WorkspaceName::parse(&args.name)?.display().to_owned();
  let initial_document = yjs::create_initial_workspace_doc(&name);
  let workspace = svc
    .workspace
    .create_workspace(owner.id, Some(name), Some(initial_document))
    .await
    .map_err(|error| anyhow::anyhow!("Failed to create workspace: {error}"))?;
  print_single(&workspace_detail(workspace), json);
  Ok(())
}

async fn list(args: WorkspaceListArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspaces = if let Some(ref user_str) = args.user {
    // User-scoped listing via WorkspaceService.
    let user = resolve_user_domain(svc, user_str).await?;
    svc
      .workspace
      .list_workspaces(user.id)
      .await
      .map_err(|e| anyhow::anyhow!("{e}"))?
  } else {
    // Admin listing — all non-deleted workspaces via AdminService.
    svc
      .admin
      .list_workspaces(myoxus_application::admin::AdminWorkspaceFilter {
        take: 10_000,
        ..Default::default()
      })
      .await
      .map_err(|e| anyhow::anyhow!("{e}"))?
  };

  let display: Vec<WorkspaceRow> = workspaces
    .into_iter()
    .map(|w| WorkspaceRow {
      id: w.id.to_string(),
      name: w.name.clone(),
      owner_user_id: w
        .owner_user_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "orphaned".to_string()),
      public: w.public,
      created_at: w.created_at.to_rfc3339(),
    })
    .collect();

  print_output(&display, json);
  Ok(())
}

async fn get(args: WorkspaceGetArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let id = args
    .id
    .parse::<Uuid>()
    .map_err(|_| anyhow::anyhow!("Invalid workspace UUID: {}", args.id))?;

  // AdminService.get_workspace returns the workspace even if soft-deleted
  // (the store query doesn't filter by deleted_at).
  let workspace = svc
    .admin
    .get_workspace(id)
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?
    .ok_or_else(|| anyhow::anyhow!("Workspace not found: {}", args.id))?;

  print_single(&workspace_detail(workspace), json);
  Ok(())
}

fn workspace_detail(workspace: myoxus_domain::entities::Workspace) -> WorkspaceDetail {
  WorkspaceDetail {
    id: workspace.id.to_string(),
    name: workspace.name,
    owner_user_id: workspace
      .owner_user_id
      .map(|id| id.to_string())
      .unwrap_or_else(|| "orphaned".to_string()),
    public: workspace.public,
    enable_ai: workspace.enable_ai,
    enable_sharing: workspace.enable_sharing,
    created_at: workspace.created_at.to_rfc3339(),
    updated_at: workspace.updated_at.to_rfc3339(),
    deleted_at: workspace.deleted_at.map(|time| time.to_rfc3339()).unwrap_or_default(),
  }
}

async fn members(args: WorkspaceMembersArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let id = args
    .id
    .parse::<Uuid>()
    .map_err(|_| anyhow::anyhow!("Invalid workspace UUID: {}", args.id))?;

  // Verify workspace exists.
  svc
    .workspace
    .get_workspace(id)
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?
    .ok_or_else(|| anyhow::anyhow!("Workspace not found: {}", args.id))?;

  let workspace_members = svc
    .workspace
    .list_members(id, 0, 10_000, None)
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?;

  let display: Vec<WorkspaceMemberRow> = workspace_members
    .into_iter()
    .map(|m| WorkspaceMemberRow {
      user_id: m.user.id.to_string(),
      email: m.user.email.clone(),
      name: m.user.name.clone(),
      role: format!("{:?}", m.role),
      status: format!("{:?}", m.status),
    })
    .collect();

  if json {
    print_json(&display);
  } else {
    print_table(&display);
  }
  Ok(())
}

async fn stats(args: WorkspaceStatsArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let id = args
    .id
    .parse::<Uuid>()
    .map_err(|_| anyhow::anyhow!("Invalid workspace UUID: {}", args.id))?;

  // Fetch name.
  let name: Option<String> = sqlx::query_scalar("SELECT name FROM workspaces WHERE id = $1 AND deleted_at IS NULL")
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| anyhow::anyhow!("DB error: {e}"))?;

  let name = name.ok_or_else(|| anyhow::anyhow!("Workspace not found: {}", args.id))?;

  // Doc count (non-deleted docs in the workspace).
  let doc_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM docs WHERE workspace_id = $1 AND deleted_at IS NULL")
      .bind(id)
      .fetch_one(pool)
      .await
      .map_err(|e| anyhow::anyhow!("DB error: {e}"))?;

  // Member count.
  let member_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM workspace_memberships WHERE workspace_id = $1")
      .bind(id)
      .fetch_one(pool)
      .await
      .map_err(|e| anyhow::anyhow!("DB error: {e}"))?;

  // Blob count (non-deleted).
  let blob_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM blobs WHERE workspace_id = $1 AND deleted_at IS NULL")
      .bind(id)
      .fetch_one(pool)
      .await
      .map_err(|e| anyhow::anyhow!("DB error: {e}"))?;

  // Storage bytes from the materialized stats table (0 if no row yet).
  let (snapshot_bytes, blob_bytes): (i64, i64) = sqlx::query_as(
    "SELECT COALESCE(snapshot_size, 0)::bigint, COALESCE(blob_size, 0)::bigint FROM workspace_storage_stats WHERE workspace_id = $1",
  )
  .bind(id)
  .fetch_optional(pool)
  .await
  .map_err(|e| anyhow::anyhow!("DB error: {e}"))?
  .unwrap_or((0, 0));

  let row = WorkspaceStats {
    workspace_id: id.to_string(),
    name,
    doc_count,
    member_count,
    blob_count,
    snapshot_bytes,
    blob_bytes,
  };

  if json {
    print_json(&row);
  } else {
    print_table(std::slice::from_ref(&row));
    println!(
      "\nStorage: {} snapshot bytes + {} blob bytes = {} bytes total ({:.2} MiB)",
      snapshot_bytes,
      blob_bytes,
      snapshot_bytes + blob_bytes,
      (snapshot_bytes + blob_bytes) as f64 / 1_048_576.0
    );
  }
  Ok(())
}

async fn seed_root_doc(args: WorkspaceSeedRootDocArgs, svc: &Services) -> anyhow::Result<()> {
  if args.id == "all" && args.admin_user_id.is_none() {
    anyhow::bail!("seed-root-doc all requires --admin-user-id <UUID>");
  }

  if let Some(admin_user_id) = args.admin_user_id {
    let valid_admin: bool =
      sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND status = 'active' AND is_admin = true)")
        .bind(admin_user_id)
        .fetch_one(&svc.pool)
        .await
        .map_err(|error| anyhow::anyhow!("DB error validating --admin-user-id: {error}"))?;
    if !valid_admin {
      anyhow::bail!("--admin-user-id must reference an active global administrator");
    }
  }

  if args.id == "all" {
    // Seed all workspaces that have no update or snapshot payload for their root doc.
    // Compacted root docs can be snapshot-only; treating them as blank would
    // recreate the initial Yjs update and break seed idempotence.
    let workspaces = svc
      .admin
      .list_workspaces(myoxus_application::admin::AdminWorkspaceFilter {
        take: 10_000,
        ..Default::default()
      })
      .await
      .map_err(|e| anyhow::anyhow!("{e}"))?;

    let mut seeded = 0;
    let mut skipped = 0;
    let mut failed = 0;
    for ws in &workspaces {
      let has_content = workspace_root_doc_has_content(&svc.pool, ws.id)
        .await
        .map_err(|e| anyhow::anyhow!("DB error checking root doc content for {}: {e}", ws.id))?;

      if has_content {
        skipped += 1;
        continue;
      }

      let data = yjs::create_initial_workspace_doc(&ws.name);
      // CLI-RV-02b: Use --admin-user-id override, then workspace owner, else skip orphans.
      let owner_id = match args.admin_user_id.or(ws.owner_user_id) {
        Some(id) => id,
        None => {
          println!("Skipped (orphaned, no owner): {} ({})", ws.id, ws.name);
          skipped += 1;
          continue;
        }
      };
      match svc.workspace.seed_root_doc(ws.id, owner_id, data).await {
        Ok(_) => {
          println!("Seeded: {} ({})", ws.id, ws.name);
          seeded += 1;
        }
        Err(e) => {
          eprintln!("Failed to seed {}: {e}", ws.id);
          failed += 1;
        }
      }
    }
    println!(
      "\nDone. Seeded: {seeded}, Skipped: {skipped}, Failed: {failed}, Total: {}",
      workspaces.len()
    );
    if failed > 0 {
      anyhow::bail!("{failed} workspace root document(s) could not be seeded");
    }
  } else {
    let id = args
      .id
      .parse::<Uuid>()
      .map_err(|_| anyhow::anyhow!("Invalid workspace UUID: {}", args.id))?;

    let ws = svc
      .workspace
      .get_workspace(id)
      .await
      .map_err(|e| anyhow::anyhow!("{e}"))?
      .ok_or_else(|| anyhow::anyhow!("Workspace not found: {}", args.id))?;

    if workspace_root_doc_has_content(&svc.pool, ws.id)
      .await
      .map_err(|e| anyhow::anyhow!("DB error checking root doc content for {}: {e}", ws.id))?
    {
      println!(
        "Root doc already has content for workspace {} ({}); skipping.",
        ws.id, ws.name
      );
      return Ok(());
    }

    let data = yjs::create_initial_workspace_doc(&ws.name);
    // CLI-RV-02b: Use --admin-user-id override, then workspace owner, else error out.
    let owner_id = args.admin_user_id.or(ws.owner_user_id).ok_or_else(|| {
      anyhow::anyhow!(
        "Workspace {} ({}) has no owner. Pass --admin-user-id <UUID> to provide one.",
        ws.id,
        ws.name
      )
    })?;
    svc
      .workspace
      .seed_root_doc(ws.id, owner_id, data)
      .await
      .map_err(|e| anyhow::anyhow!("Failed to seed root doc: {e}"))?;

    println!("Root doc seeded for workspace {} ({}).", ws.id, ws.name);
  }
  Ok(())
}

async fn workspace_root_doc_has_content(pool: &PgPool, workspace_id: Uuid) -> sqlx::Result<bool> {
  sqlx::query_scalar(
    r#"
        SELECT
          EXISTS(
            SELECT 1
              FROM doc_updates
             WHERE workspace_id = $1
               AND doc_id = $1
               AND octet_length(payload) > 0
          )
          OR
          EXISTS(
            SELECT 1
              FROM doc_snapshots
             WHERE workspace_id = $1
               AND doc_id = $1
               AND octet_length(payload) > 0
          )
        "#,
  )
  .bind(workspace_id)
  .fetch_one(pool)
  .await
}

/// P102-TRASH-04: Force-compact a single doc into a snapshot.
///
/// Reads pending `doc_updates`, merges them with the existing snapshot via Y.js,
/// and writes a new snapshot (which atomically deletes the absorbed updates).
/// With `--dry-run`, only prints stats without writing.
async fn compact_doc(args: WorkspaceCompactDocArgs, svc: &Services) -> anyhow::Result<()> {
  let ws_id = args.workspace_id;
  let doc_id = args.doc_id;

  // Fetch pending update count for the preview / dry-run stats.
  let pending_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2")
      .bind(ws_id)
      .bind(doc_id)
      .fetch_one(&svc.pool)
      .await
      .map_err(|e| anyhow::anyhow!("DB error fetching update count: {e}"))?;

  let has_snapshot: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2)")
      .bind(ws_id)
      .bind(doc_id)
      .fetch_one(&svc.pool)
      .await
      .map_err(|e| anyhow::anyhow!("DB error checking snapshot: {e}"))?;

  println!(
    "Doc {doc_id} in workspace {ws_id}: {} pending update(s), snapshot: {}",
    pending_count,
    if has_snapshot { "yes" } else { "no" },
  );

  if pending_count < args.min_updates as i64 {
    println!(
      "Skipping: {} pending update(s) < min_updates ({}) — nothing to compact.",
      pending_count, args.min_updates
    );
    return Ok(());
  }

  if args.dry_run {
    println!(
      "Dry-run: would compact {} update(s) into a new snapshot.",
      pending_count
    );
    return Ok(());
  }

  let merged = svc
    .doc
    .merge_pending_updates(ws_id, doc_id, args.min_updates)
    .await
    .map_err(|e| anyhow::anyhow!("Compaction failed: {e}"))?;

  if merged == 0 {
    println!("Nothing compacted (service returned 0 merged updates).");
  } else {
    println!("Compacted {merged} update(s) into a new snapshot.");
  }

  Ok(())
}

async fn update(args: WorkspaceUpdateArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.id)?;
  let name = WorkspaceName::parse(&args.name).map_err(|error| anyhow::anyhow!(error.to_string()))?;
  let workspace = svc
    .workspace
    .update_workspace(
      workspace_id,
      UpdateWorkspace {
        name: Some(name),
        ..Default::default()
      },
    )
    .await
    .map_err(|error| anyhow::anyhow!("Failed to update workspace: {error}"))?;
  print_single(&workspace_detail(workspace), json);
  Ok(())
}

async fn add_member(args: WorkspaceAddMemberArgs, svc: &Services) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  let user = resolve_user_domain(svc, &args.user).await?;
  let actor = resolve_user_domain(svc, &args.actor).await?;
  let role = parse_workspace_role(&args.role)?;
  svc
    .workspace
    .add_member_direct(workspace_id, user.id, role, actor.id)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to add workspace member: {error}"))?;
  println!("User {} added to workspace {} as {:?}.", user.id, workspace_id, role);
  Ok(())
}

async fn set_member_role(args: WorkspaceSetMemberRoleArgs, svc: &Services) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  let user = resolve_user_domain(svc, &args.user).await?;
  let role = parse_workspace_role(&args.role)?;
  svc
    .workspace
    .update_member_role(workspace_id, user.id, role)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to update workspace member role: {error}"))?;
  println!("User {} now has {:?} in workspace {}.", user.id, role, workspace_id);
  Ok(())
}

async fn remove_member(args: WorkspaceRemoveMemberArgs, svc: &Services) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  let user = resolve_user_domain(svc, &args.user).await?;
  svc
    .workspace
    .revoke_member(workspace_id, user.id)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to remove workspace member: {error}"))?;
  println!("User {} removed from workspace {}.", user.id, workspace_id);
  Ok(())
}

async fn transfer_owner(args: WorkspaceTransferOwnerArgs, svc: &Services) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  let target = match (args.to_user, args.to_unit) {
    (Some(user), None) => WorkspaceOwnerTarget::User(resolve_user_domain(svc, &user).await?.id),
    (None, Some(unit)) => WorkspaceOwnerTarget::OrganizationUnit(unit),
    _ => unreachable!("clap enforces exactly one owner target"),
  };
  svc
    .workspace
    .transfer_workspace_owner(workspace_id, target)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to transfer workspace owner: {error}"))?;
  println!("Workspace {workspace_id} ownership transferred.");
  Ok(())
}

async fn set_management_unit(args: WorkspaceSetManagementUnitArgs, svc: &Services) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  svc
    .workspace
    .set_management_unit(workspace_id, args.unit)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to update management unit: {error}"))?;
  if let Some(unit_id) = args.unit {
    println!("Workspace {workspace_id} is managed by organization unit {unit_id}.");
  } else {
    println!("Workspace {workspace_id} no longer has a management unit.");
  }
  Ok(())
}

async fn set_sharing(args: WorkspaceBooleanSettingArgs, svc: &Services) -> anyhow::Result<()> {
  set_boolean_setting(args, svc, false).await
}

async fn set_public(args: WorkspaceBooleanSettingArgs, svc: &Services) -> anyhow::Result<()> {
  set_boolean_setting(args, svc, true).await
}

async fn set_boolean_setting(
  args: WorkspaceBooleanSettingArgs,
  svc: &Services,
  public_setting: bool,
) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.workspace_id)?;
  let update = if public_setting {
    UpdateWorkspace {
      public: Some(args.enabled),
      ..Default::default()
    }
  } else {
    UpdateWorkspace {
      enable_sharing: Some(args.enabled),
      ..Default::default()
    }
  };
  svc
    .workspace
    .update_workspace(workspace_id, update)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to update workspace setting: {error}"))?;
  PgPublicRepository::new(svc.pool.clone())
    .invalidate_workspace(workspace_id)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to invalidate public artifacts: {error}"))?;
  println!(
    "Workspace {workspace_id} {} set to {}.",
    if public_setting {
      "public access"
    } else {
      "link sharing"
    },
    args.enabled
  );
  Ok(())
}

async fn undelete(args: WorkspaceUndeleteArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_workspace_id(&args.id)?;
  let workspace = svc
    .workspace
    .undelete_workspace(workspace_id)
    .await
    .map_err(|error| anyhow::anyhow!("Failed to restore workspace: {error}"))?;
  print_single(&workspace_detail(workspace), json);
  Ok(())
}

fn parse_workspace_id(value: &str) -> anyhow::Result<Uuid> {
  value
    .parse::<Uuid>()
    .map_err(|_| anyhow::anyhow!("Invalid workspace UUID: {value}"))
}

pub(crate) fn parse_workspace_role(value: &str) -> anyhow::Result<WorkspaceRole> {
  match value.to_ascii_lowercase().as_str() {
    "admin" => Ok(WorkspaceRole::Admin),
    "manager" => Ok(WorkspaceRole::Manager),
    "collaborator" => Ok(WorkspaceRole::Collaborator),
    "commenter" => Ok(WorkspaceRole::Commenter),
    "reader" => Ok(WorkspaceRole::Reader),
    _ => anyhow::bail!("Invalid role '{value}'. Valid values: Admin, Manager, Collaborator, Commenter, Reader"),
  }
}

async fn delete(args: WorkspaceDeleteArgs, svc: &Services) -> anyhow::Result<()> {
  if !args.confirm {
    eprintln!("Are you sure? Pass --confirm to proceed.");
    std::process::exit(1);
  }

  let id = parse_workspace_id(&args.id)?;

  // Verify workspace exists before deletion.
  svc
    .workspace
    .get_workspace(id)
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?
    .ok_or_else(|| anyhow::anyhow!("Workspace not found: {}", args.id))?;

  svc
    .workspace
    .delete_workspace(id)
    .await
    .map_err(|e| anyhow::anyhow!("Failed to delete workspace: {e}"))?;

  println!("Workspace {id} soft-deleted.");
  Ok(())
}
