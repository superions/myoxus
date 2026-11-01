//! `myoxus-cli` — admin command-line tool for the Myoxus server.
//!
//! Connects directly to PostgreSQL (through the application + infrastructure
//! service layer) to perform user, shared-workspace, workspace, storage, and system
//! management without requiring a running API server (except for the
//! `system health` sub-command which optionally calls HTTP health endpoints).
//!
//! # Usage
//! ```text
//! myoxus-cli [--database-url-file <path>] [--json] <COMMAND>
//! ```

mod audit;
mod automation;
mod backup;
mod captcha;
mod client_update;
mod config;
mod container;
mod copilot;
mod database;
mod doc_metadata;
mod doc_projection;
mod doc_versions;
mod export_docs;
mod git_sync;
mod graph;
mod import_file;
mod metrics;
mod organization;
mod organizer;
mod output;
mod pdf;
mod public;
mod search;
mod services;
mod sessions;
mod shared_workspaces;
mod storage;
mod system;
mod telemetry;
mod template_repair;
mod templates;
mod users;
mod workspace_import;
mod workspaces;

use clap::{Parser, Subcommand};
use myoxus_contracts::runtime_config::load_cli_database_url;
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

/// Myoxus admin CLI — direct PostgreSQL management tool.
#[derive(Parser)]
#[command(name = "myoxus-cli", version, about, long_about = None)]
struct Cli {
  /// Read the PostgreSQL connection URL from this file.
  #[arg(long, value_name = "PATH")]
  database_url_file: Option<std::path::PathBuf>,

  /// Emit raw JSON instead of pretty ASCII tables.
  #[arg(long, global = true)]
  json: bool,

  #[command(subcommand)]
  command: Commands,
}

/// Top-level command groups.
#[derive(Subcommand)]
enum Commands {
  /// Native OCI entrypoint and healthcheck (no database connection).
  #[command(subcommand)]
  Container(container::ContainerCommand),
  /// Read persisted audit events (list, get).
  #[command(subcommand)]
  Audit(audit::AuditCommand),

  /// User management (list, get, create, set-password, disable, enable, delete).
  #[command(subcommand)]
  Users(users::UsersCommand),

  /// OU-owned shared workspace management.
  #[command(name = "shared-workspaces", subcommand)]
  SharedWorkspaces(shared_workspaces::SharedWorkspacesCommand),

  /// Organization-unit hierarchy and membership management.
  #[command(subcommand)]
  Organization(organization::OrganizationCommand),

  /// Organizer order-key diagnostics and explicit maintenance.
  #[command(subcommand)]
  Organizer(organizer::OrganizerCommand),

  /// Workspace management (list, get, members, stats, delete).
  #[command(subcommand)]
  Workspaces(workspaces::WorkspacesCommand),

  /// Server-backed import of complete legacy workspace snapshots.
  #[command(subcommand)]
  Workspace(workspace_import::WorkspaceCommand),

  /// Storage statistics and maintenance (stats, top, orphans, gc).
  #[command(subcommand)]
  Storage(storage::StorageCommand),

  /// System health and diagnostics (doctor, status, migrations, queue, health).
  #[command(subcommand)]
  System(system::SystemCommand),

  /// Runtime config management via the `app_configs` DB table (show, set, diff).
  #[command(subcommand)]
  Config(config::ConfigCommand),

  /// Browser Web update-control state and lifecycle.
  #[command(name = "client-update", subcommand)]
  ClientUpdate(client_update::ClientUpdateCommand),

  /// Full-text search index management (reindex, stats, query).
  #[command(subcommand)]
  Search(search::SearchCommand),

  /// Session management (list, revoke).
  #[command(subcommand)]
  Sessions(sessions::SessionsCommand),

  /// Copilot provider status, embedding stats, and reindex jobs.
  #[command(subcommand)]
  Copilot(copilot::CopilotCommand),

  /// Git-sync profile and run management (profiles, status, conflicts, trigger).
  #[command(subcommand)]
  GitSync(git_sync::GitSyncCommand),

  /// Document Graph reindex and status diagnostics.
  #[command(subcommand)]
  Graph(graph::GraphCommand),

  /// Server-backed Workspace Database diagnostics and CSV operations.
  #[command(subcommand)]
  Database(database::DatabaseCommand),

  /// Document operations, including named versions.
  #[command(subcommand)]
  Doc(doc_versions::DocCommand),

  /// Import Markdown files as pages into a workspace.
  ImportFile(import_file::ImportFileArgs),

  /// Export workspace documents as Markdown files.
  ExportDocs(export_docs::ExportDocsArgs),

  /// Backup and restore (create, restore, verify).
  #[command(subcommand)]
  Backup(backup::BackupCommand),

  /// Workspace Automation operations and recovery.
  #[command(subcommand)]
  Automation(automation::AutomationCommand),

  /// Template catalog management (list, import, export).
  #[command(subcommand)]
  Templates(templates::TemplatesCommand),

  /// ALTCHA CAPTCHA operations (generate HMAC key, query server status).
  #[command(subcommand)]
  Captcha(captcha::CaptchaCommand),

  /// Telemetry administration: DSGVO export/purge-per-user, stats.
  #[command(subcommand)]
  Telemetry(telemetry::TelemetryCommand),

  /// Business-metrics pipeline: snapshot, flush-now hint, stats.
  #[command(subcommand)]
  Metrics(metrics::MetricsCommand),

  /// PDF-Export V2 administration: render-audit purge, future template /
  /// brand / font subcommands.
  #[command(subcommand)]
  Pdf(pdf::PdfCommand),

  /// Public publishing static export and release activation.
  #[command(subcommand)]
  Public(public::PublicCommand),
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
  myoxus_infrastructure::tls::initialize_crypto_provider();
  // Initialise tracing at WARN unless RUST_LOG is set.
  tracing_subscriber::fmt()
    .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")))
    .with_writer(std::io::stderr)
    .init();

  let raw_args = std::env::args_os().collect::<Vec<_>>();
  if let Some(error) = legacy_secret_argument_error(&raw_args) {
    eprintln!("Error: {error}");
    std::process::exit(2);
  }
  let cli = match Cli::try_parse_from(raw_args) {
    Ok(cli) => cli,
    Err(error) => error.exit(),
  };
  if let Commands::Container(command) = &cli.command {
    if let Err(error) = container::run(command).await {
      eprintln!("myoxus container: {error}");
      std::process::exit(1);
    }
    return;
  }
  if let Commands::Audit(command) = &cli.command {
    if let Err(error) = command.validate() {
      error.exit();
    }
  }

  // Doctor owns bounded bootstrap and dependency failures itself. In particular,
  // the mandatory pool below must not prevent its diagnostic report.
  if let Commands::System(system::SystemCommand::Doctor(args)) = &cli.command {
    if let Err(error) = system::doctor(args, cli.database_url_file.as_deref(), cli.json).await {
      eprintln!("Error: {error}");
      // A timed-out bootstrap read/validation must not make Tokio shutdown wait
      // indefinitely for a blocked filesystem read after the report is printed.
      std::process::exit(1);
    }
    return;
  }
  // Public HTTP probes must remain operable without PostgreSQL or Services.
  if let Commands::System(system::SystemCommand::Health(args)) = &cli.command {
    if let Err(error) = system::health(args, cli.json).await {
      eprintln!("Error: {error}");
      std::process::exit(1);
    }
    return;
  }

  // Template preparation validates file bytes before publishing its catalog;
  // it must work before PostgreSQL or the runtime service graph is available.
  if let Commands::Templates(templates::TemplatesCommand::FeatureBundle(command)) = &cli.command {
    if let Err(error) = templates::run_feature_bundle(command) {
      eprintln!("Error: {error:#}");
      std::process::exit(1);
    }
    return;
  }
  if let Commands::Templates(templates::TemplatesCommand::ValidateSourceSet {
    root,
    against_root,
    release_manifest,
    optional_catalog,
    prepared_root,
  }) = &cli.command
  {
    if let Err(error) = templates::validate_source_set(
      root,
      against_root.as_deref(),
      release_manifest.as_deref(),
      optional_catalog.as_deref(),
      prepared_root.as_deref(),
    ) {
      eprintln!("Error: {error}");
      std::process::exit(1);
    }
    println!("Feature release source set is valid");
    return;
  }
  if let Commands::Templates(templates::TemplatesCommand::ValidateDatabases { root, against_root }) = &cli.command {
    let validation = if let Some(installed) = against_root {
      myoxus_infrastructure::database_templates::validate_database_template_preparation(root, installed)
    } else {
      myoxus_infrastructure::database_templates::load_database_template_catalog(root).map(|_| ())
    };
    if let Err(error) = validation {
      eprintln!("Error: {error}");
      std::process::exit(1);
    }
    println!("Database template catalog is valid");
    return;
  }

  let db_url = match load_cli_database_url(cli.database_url_file.as_deref()) {
    Ok(url) => url,
    Err(error) => {
      eprintln!("Error: could not load database configuration: {error}");
      std::process::exit(1);
    }
  };

  let (additional_ca, global_configured) = match services::Services::load_bootstrap_tls() {
    Ok(snapshot) => snapshot,
    Err(error) => {
      eprintln!("Error: invalid bootstrap TLS configuration: {error}");
      std::process::exit(1);
    }
  };

  // Build a small connection pool (CLI doesn't need many connections).
  let database_options = match myoxus_infrastructure::tls::postgres::connect_options(&db_url, additional_ca.as_ref()) {
    Ok(options) => options,
    Err(error) => {
      eprintln!("Error: {error}");
      std::process::exit(1);
    }
  };
  let pool = match PgPoolOptions::new()
    .max_connections(5)
    .acquire_timeout(std::time::Duration::from_secs(5))
    .connect_with(database_options)
    .await
  {
    Ok(p) => p,
    Err(_) => {
      tracing::debug!("operator CLI database connection failed");
      eprintln!("Error: could not connect to the configured database");
      std::process::exit(1);
    }
  };

  let json = cli.json;
  let result = dispatch(cli.command, pool, json, &db_url, additional_ca, global_configured).await;

  if let Err(e) = result {
    eprintln!("Error: {e}");
    std::process::exit(1);
  }
}

async fn dispatch(
  command: Commands,
  pool: sqlx::PgPool,
  json: bool,
  database_url: &str,
  additional_ca: Option<myoxus_infrastructure::tls::ValidatedCaBundle>,
  global_configured: bool,
) -> anyhow::Result<()> {
  match command {
    // Audit reads need only PostgreSQL, including while other services are down.
    Commands::Audit(command) => audit::run(command, &pool, json).await,
    // Update control intentionally depends only on PostgreSQL. It must remain
    // usable while API, Redis, object storage, or the wider service graph is
    // unavailable during an operator-managed rollout.
    Commands::ClientUpdate(command) => client_update::run(command, &pool, json).await,
    // A recovery preflight must work before migrations and unrelated runtime
    // services. Its planner reads one read-only database snapshot.
    Commands::Templates(templates::TemplatesCommand::RecoverRelease(args)) => {
      if !args.apply {
        return templates::preview_release_recovery(args, &pool, json).await;
      }
      anyhow::ensure!(
        (args.orphan_sources.is_empty() && args.unknown_sources.is_empty()) || args.confirm_unmodified_system_documents,
        "exact source replacement requires --confirm-unmodified-system-documents"
      );
      myoxus_infrastructure::migrations::run(&pool).await?;
      let svc = services::Services::from_pool(pool, additional_ca, global_configured).await?;
      templates::run(templates::TemplatesCommand::RecoverRelease(args), &svc, json).await
    }
    // The engine cutover is intentionally available before candidate schema
    // migrations have canonicalized every historical app_configs key. It
    // needs only PostgreSQL and the static server-owned storage projection,
    // not the complete live service graph.
    Commands::Pdf(pdf::PdfCommand::Templates(pdf::TemplatesCommand::MigrateEngine(args))) => {
      pdf::run_template_engine_migration(
        args,
        &pool,
        services::Services::configured_blob_storage(additional_ca.as_ref())?,
        json,
      )
      .await
    }
    // These maintenance handlers own their PostgreSQL or validated transport
    // dependencies directly; unrelated Feature/Workspace admission must not gate them.
    Commands::Storage(cmd) => storage::run(cmd, &pool, json).await,
    Commands::System(cmd) => system::run(cmd, &pool, json, additional_ca.as_ref()).await,
    Commands::Config(cmd) => config::run(cmd, &pool, json).await,
    Commands::Search(cmd) => search::run(cmd, &pool, json).await,
    Commands::Copilot(cmd) => copilot::run(cmd, &pool, json).await,
    Commands::Backup(cmd) => backup::run(cmd, &pool, database_url, json, additional_ca.as_ref()).await,
    Commands::Captcha(cmd) => captcha::run(cmd, json, additional_ca.as_ref()).await,
    Commands::Telemetry(cmd) => telemetry::run(cmd, &pool, json).await,
    Commands::Metrics(cmd) => metrics::run(cmd, &pool, json).await,
    command => {
      let svc = services::Services::from_pool(pool, additional_ca, global_configured)
        .await
        .map_err(|error| anyhow::anyhow!("could not initialize CLI services: {error:#}"))?;
      tracing::debug!(
        additional_ca_count = svc.additional_ca.as_ref().map_or(0, |bundle| bundle.certificate_count),
        snapshot_id = svc
          .additional_ca
          .as_ref()
          .map_or("library-public-roots", |bundle| bundle.snapshot_id.as_str()),
        "CLI bootstrap trust snapshot"
      );
      match command {
        Commands::Users(cmd) => users::run(cmd, &svc, json).await,
        Commands::SharedWorkspaces(cmd) => shared_workspaces::run(cmd, &svc, json).await,
        Commands::Organization(cmd) => organization::run(cmd, &svc, json).await,
        Commands::Organizer(cmd) => organizer::run(cmd, &svc, json).await,
        Commands::Workspaces(cmd) => workspaces::run(cmd, &svc, json).await,
        Commands::Workspace(cmd) => workspace_import::run(cmd, &svc, json).await,
        Commands::Sessions(cmd) => sessions::run(cmd, &svc.pool, &svc.auth, json).await,
        Commands::GitSync(cmd) => git_sync::run(cmd, &svc, json).await,
        Commands::Graph(cmd) => graph::run(cmd, &svc, json).await,
        Commands::Database(cmd) => database::run(cmd, &svc, json).await,
        Commands::Doc(cmd) => doc_versions::run(cmd, &svc, json).await,
        Commands::ImportFile(args) => import_file::run(args, &svc).await,
        Commands::ExportDocs(args) => export_docs::run(args, &svc, json).await,
        Commands::Automation(cmd) => automation::run(cmd, &svc, json).await,
        Commands::Templates(cmd) => templates::run(cmd, &svc, json).await,
        Commands::Pdf(cmd) => pdf::run(cmd, &svc, json).await,
        Commands::Public(cmd) => public::run(cmd, &svc).await,
        Commands::ClientUpdate(_) => unreachable!("client-update dispatched before service initialization"),
        Commands::Audit(_) => unreachable!("audit dispatched before service initialization"),
        Commands::Container(_)
        | Commands::Storage(_)
        | Commands::System(_)
        | Commands::Config(_)
        | Commands::Search(_)
        | Commands::Copilot(_)
        | Commands::Backup(_)
        | Commands::Captcha(_)
        | Commands::Telemetry(_)
        | Commands::Metrics(_) => unreachable!("maintenance command dispatched before service initialization"),
      }
    }
  }
}

/// Reject removed secret-bearing forms before Clap can quote the supplied
/// value in its diagnostic. This is deliberately narrow: ordinary parse
/// errors retain Clap's useful context, while known legacy credential forms
/// return a value-free migration message.
fn legacy_secret_argument_error(args: &[std::ffi::OsString]) -> Option<&'static str> {
  let args = args
    .iter()
    .map(|arg| arg.to_string_lossy().into_owned())
    .collect::<Vec<_>>();
  if args
    .iter()
    .any(|arg| arg == "--database-url" || arg.starts_with("--database-url="))
  {
    return Some("raw database URL arguments are not supported; use --database-url-file");
  }
  if args
    .iter()
    .any(|arg| arg == "--redis-url" || arg.starts_with("--redis-url="))
  {
    return Some("raw Redis URL arguments are not supported; use REDIS_URL or MYOXUS__REDIS__URL");
  }
  if args
    .iter()
    .any(|arg| arg == "--password" || arg.starts_with("--password="))
  {
    return Some("plaintext password arguments are not supported; use users set-password with a secure input source");
  }

  let command_index = args
    .windows(2)
    .position(|pair| pair[0] == "users" && pair[1] == "set-password")?;
  let mut identity_seen = false;
  let mut index = command_index + 2;
  while index < args.len() {
    match args[index].as_str() {
      "--password-stdin" | "--json" => index += 1,
      "--password-file" | "--database-url-file" => index += 2,
      value if value.starts_with("--password-file=") || value.starts_with("--database-url-file=") => index += 1,
      value if !value.starts_with('-') && !identity_seen => {
        identity_seen = true;
        index += 1;
      }
      _ => {
        return Some(
          "positional or unknown password arguments are not supported; use --password-stdin or --password-file",
        );
      }
    }
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn workspace_import_command_family_matches_the_operator_contract() {
    let actor = uuid::Uuid::new_v4().to_string();
    let import_id = uuid::Uuid::new_v4().to_string();
    for args in [
      vec![
        "myoxus-cli",
        "workspace",
        "import",
        "preview",
        "--file",
        "legacy.db",
        "--actor-id",
        &actor,
      ],
      vec![
        "myoxus-cli",
        "workspace",
        "import",
        "apply",
        "--file",
        "legacy.zip",
        "--actor-id",
        &actor,
        "--format",
        "obsidian",
      ],
      vec!["myoxus-cli", "workspace", "import", "status", "--import-id", &import_id],
      vec![
        "myoxus-cli",
        "workspace",
        "import",
        "cleanup",
        "--import-id",
        &import_id,
      ],
    ] {
      Cli::try_parse_from(args).expect("workspace import CLI command must parse");
    }
  }

  #[test]
  fn client_update_status_accepts_its_documented_json_form() {
    let cli = Cli::try_parse_from(["myoxus-cli", "client-update", "status", "--json"])
      .expect("client-update status --json must parse");

    assert!(cli.json);
    assert!(matches!(
      cli.command,
      Commands::ClientUpdate(client_update::ClientUpdateCommand::Status)
    ));
  }

  #[test]
  fn shared_workspace_command_replaces_the_legacy_team_product_path() {
    let unit = uuid::Uuid::new_v4().to_string();
    let admin = uuid::Uuid::new_v4().to_string();
    Cli::try_parse_from([
      "myoxus-cli",
      "shared-workspaces",
      "create",
      "--name",
      "Operations",
      "--unit",
      &unit,
      "--admin",
      &admin,
    ])
    .expect("shared workspace command must parse");
    assert!(
      Cli::try_parse_from(["myoxus-cli", "teams", "list"]).is_err(),
      "legacy team product command must no longer parse"
    );
  }

  #[test]
  fn shared_workspace_mutations_require_explicit_administrative_principals() {
    let unit = uuid::Uuid::new_v4().to_string();
    let workspace = uuid::Uuid::new_v4().to_string();
    let user = uuid::Uuid::new_v4().to_string();
    let admin = uuid::Uuid::new_v4().to_string();

    assert!(
      Cli::try_parse_from([
        "myoxus-cli",
        "shared-workspaces",
        "create",
        "--name",
        "Operations",
        "--unit",
        &unit,
      ])
      .is_err(),
      "create must not guess an administrator when --admin is absent"
    );
    Cli::try_parse_from([
      "myoxus-cli",
      "shared-workspaces",
      "create",
      "--name",
      "Operations",
      "--unit",
      &unit,
      "--admin",
      &admin,
    ])
    .expect("create must accept an explicit administrator");

    assert!(
      Cli::try_parse_from(["myoxus-cli", "shared-workspaces", "add-member", &workspace, &user,]).is_err(),
      "add-member must not guess an actor when --actor is absent"
    );
    Cli::try_parse_from([
      "myoxus-cli",
      "shared-workspaces",
      "add-member",
      &workspace,
      &user,
      "--actor",
      &admin,
    ])
    .expect("add-member must accept an explicit actor");
  }

  #[test]
  fn workspace_lifecycle_parser_requires_explicit_principals_and_exclusive_targets() {
    let workspace = uuid::Uuid::new_v4().to_string();
    let user = uuid::Uuid::new_v4().to_string();
    let unit = uuid::Uuid::new_v4().to_string();

    assert!(
      Cli::try_parse_from(["myoxus-cli", "workspaces", "create", "--name", "Operations"]).is_err(),
      "generic workspace creation must name its user owner"
    );
    assert!(
      Cli::try_parse_from(["myoxus-cli", "workspaces", "transfer-owner", &workspace]).is_err(),
      "ownership transfer must name exactly one target"
    );
    assert!(
      Cli::try_parse_from([
        "myoxus-cli",
        "workspaces",
        "transfer-owner",
        &workspace,
        "--to-user",
        &user,
        "--to-unit",
        &unit,
      ])
      .is_err(),
      "ownership transfer must reject ambiguous targets"
    );
    Cli::try_parse_from([
      "myoxus-cli",
      "workspaces",
      "transfer-owner",
      &workspace,
      "--to-user",
      &user,
    ])
    .expect("user ownership target must parse");
    for enabled in ["true", "false"] {
      Cli::try_parse_from([
        "myoxus-cli",
        "workspaces",
        "set-sharing",
        &workspace,
        "--enabled",
        enabled,
      ])
      .expect("explicit Boolean setting value must parse");
    }
  }

  #[test]
  fn persisted_legacy_database_migration_commands_are_explicit_preview_and_apply_paths() {
    let actor = uuid::Uuid::new_v4().to_string();
    let workspace = uuid::Uuid::new_v4().to_string();
    let document = uuid::Uuid::new_v4().to_string();
    for command in ["migrate-legacy-preview", "migrate-legacy"] {
      Cli::try_parse_from([
        "myoxus-cli",
        "database",
        command,
        "--actor-user-id",
        &actor,
        "--workspace-id",
        &workspace,
        "--document-id",
        &document,
      ])
      .expect("persisted legacy Database migration command must parse");
    }
  }

  #[test]
  fn database_credentials_are_file_only_cli_inputs() {
    let parsed = Cli::try_parse_from([
      "myoxus-cli",
      "--database-url-file",
      "/run/myoxus/database-url",
      "users",
      "list",
    ])
    .expect("database URL file must parse");
    assert_eq!(
      parsed.database_url_file.as_deref(),
      Some(std::path::Path::new("/run/myoxus/database-url"))
    );
    assert!(
      Cli::try_parse_from([
        "myoxus-cli",
        "--database-url",
        "postgres://credential@example.invalid/database",
        "users",
        "list",
      ])
      .is_err(),
      "raw database URLs must not be accepted as process arguments"
    );
  }

  #[test]
  fn redis_credentials_are_environment_only_cli_inputs() {
    let workspace = uuid::Uuid::new_v4().to_string();
    let document = uuid::Uuid::new_v4().to_string();
    Cli::try_parse_from([
      "myoxus-cli",
      "graph",
      "enqueue-doc",
      "--workspace-id",
      &workspace,
      "--doc-id",
      &document,
    ])
    .expect("graph enqueue must use protected runtime environment for Redis");

    let redis_url = "redis://:REDIS-SENTINEL@example.invalid:6379";
    let run = uuid::Uuid::new_v4().to_string();
    let actor = uuid::Uuid::new_v4().to_string();
    for args in [
      vec![
        "myoxus-cli",
        "graph",
        "enqueue-doc",
        "--workspace-id",
        &workspace,
        "--doc-id",
        &document,
        "--redis-url",
        redis_url,
      ],
      vec![
        "myoxus-cli",
        "automation",
        "retry",
        &run,
        "--actor-user-id",
        &actor,
        "--redis-url",
        redis_url,
      ],
    ] {
      let args = args.into_iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
      let error = legacy_secret_argument_error(&args).expect("raw Redis URL must be rejected");
      assert!(!error.contains(redis_url));
    }
  }

  #[test]
  fn removed_secret_arguments_are_rejected_without_reflecting_values() {
    let password = "PASSWORD-SENTINEL-never-print";
    let database_url = "postgres://DATABASE-SENTINEL@example.invalid/myoxus";
    for args in [
      vec!["myoxus-cli", "users", "set-password", "user@example.test", password],
      vec![
        "myoxus-cli",
        "users",
        "create",
        "--email",
        "user@example.test",
        "--name",
        "User",
        "--password",
        password,
      ],
      vec!["myoxus-cli", "--database-url", database_url, "users", "list"],
    ] {
      let args = args.into_iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
      let error = legacy_secret_argument_error(&args).expect("legacy credential form must be rejected");
      assert!(!error.contains(password));
      assert!(!error.contains(database_url));
    }
  }
}
