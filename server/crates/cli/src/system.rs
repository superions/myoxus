//! `system` subcommand — health, diagnostics, migrations, and queue stats.

mod external;
mod http;
mod redis;
mod smtp;
mod storage;

use chrono::{DateTime, Utc};
use clap::{Args, Subcommand};
use serde::Serialize;
use sqlx::{Connection, PgPool};
use std::{
  path::Path,
  time::{Duration, Instant},
};
use tabled::Tabled;

use crate::output::{print_json, print_output, print_table};

/// Subcommands for `system`.
#[derive(Subcommand)]
pub enum SystemCommand {
  /// Run bounded diagnostics, even when PostgreSQL cannot be reached.
  Doctor(DoctorArgs),
  /// Show DB connectivity and worker queue depths.
  Status,
  /// List applied database migrations with timestamps.
  Migrations,
  /// Show worker job queue statistics grouped by queue and status.
  Queue(QueueArgs),
  /// Call the server HTTP /health and /ready endpoints.
  Health(HealthArgs),
}

#[derive(Args)]
pub struct DoctorArgs {
  /// Treat warnings as failures as well.
  #[arg(long)]
  pub strict: bool,
  /// Check the delivered public origin, optionally including a deployment prefix.
  #[arg(long)]
  pub external_origin: Option<String>,
}

const DOCTOR_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const DOCTOR_RUN_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum DoctorStatus {
  Pass,
  Warn,
  Fail,
  Skip,
}

impl std::fmt::Display for DoctorStatus {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str(match self {
      Self::Pass => "pass",
      Self::Warn => "warn",
      Self::Fail => "fail",
      Self::Skip => "skip",
    })
  }
}

/// Fixed operator checks, not a probe registry. Preserve actionable causes and
/// non-secret target fields, never Debug-format connection options or URLs.
#[derive(Serialize, Tabled)]
struct DoctorRow {
  check_id: &'static str,
  status: DoctorStatus,
  elapsed_ms: u64,
  detail: String,
}

impl DoctorRow {
  fn new(check_id: &'static str, status: DoctorStatus, started: Instant, detail: impl Into<String>) -> Self {
    Self {
      check_id,
      status,
      elapsed_ms: started.elapsed().as_millis() as u64,
      detail: detail.into(),
    }
  }
}

/// Always print collected results before returning an unsuccessful outcome.
/// The complete deadline also bounds future independently runnable probes.
#[tracing::instrument(skip_all)]
pub async fn doctor(args: &DoctorArgs, database_url_file: Option<&Path>, json: bool) -> anyhow::Result<()> {
  let started = Instant::now();
  let deadline = tokio::time::Instant::now() + DOCTOR_RUN_TIMEOUT;
  let mut rows = Vec::new();
  let mut external_rows = Vec::new();
  if tokio::time::timeout_at(
    deadline,
    doctor_checks(
      database_url_file,
      &mut rows,
      deadline,
      args.external_origin.as_deref(),
      &mut external_rows,
    ),
  )
  .await
  .is_err()
  {
    rows.push(DoctorRow::new(
      "doctor.deadline",
      DoctorStatus::Fail,
      started,
      "complete diagnostic deadline exceeded",
    ));
  }
  rows.extend(external_rows);
  let failed = rows
    .iter()
    .any(|row| matches!(row.status, DoctorStatus::Fail) || args.strict && matches!(row.status, DoctorStatus::Warn));
  tracing::debug!(check_count = rows.len(), failed, "CLI Doctor report completed");
  print_output(&rows, json);
  anyhow::ensure!(!failed, "system doctor reported unsuccessful checks");
  Ok(())
}

async fn doctor_checks(
  database_url_file: Option<&Path>,
  rows: &mut Vec<DoctorRow>,
  deadline: tokio::time::Instant,
  external_origin: Option<&str>,
  external_rows: &mut Vec<DoctorRow>,
) {
  let started = Instant::now();
  let path = database_url_file.map(Path::to_path_buf);
  let database = match tokio::time::timeout(
    DOCTOR_CHECK_TIMEOUT,
    tokio::task::spawn_blocking(move || myoxus_contracts::runtime_config::load_cli_database_url(path.as_deref())),
  )
  .await
  {
    Ok(Ok(Ok(url))) => {
      rows.push(DoctorRow::new(
        "database.configuration",
        DoctorStatus::Pass,
        started,
        "database configuration loaded",
      ));
      Some(url)
    }
    result => {
      let detail = match result {
        Ok(Ok(Err(error))) => error.to_string(),
        Ok(Err(_)) => "database configuration task panicked or was cancelled".into(),
        Err(_) => "database configuration read exceeded 5 seconds".into(),
        _ => unreachable!(),
      };
      rows.push(DoctorRow::new(
        "database.configuration",
        DoctorStatus::Fail,
        started,
        detail,
      ));
      None
    }
  };
  let started = Instant::now();
  let trust = match tokio::time::timeout(
    DOCTOR_CHECK_TIMEOUT,
    tokio::task::spawn_blocking(crate::services::Services::load_bootstrap_tls),
  )
  .await
  {
    Ok(Ok(Ok((bundle, _)))) => {
      rows.push(DoctorRow::new(
        "bootstrap.tls",
        DoctorStatus::Pass,
        started,
        "bootstrap CA policy validated",
      ));
      Some(bundle)
    }
    result => {
      let detail = match result {
        Ok(Ok(Err(error))) => error.to_string(),
        Ok(Err(_)) => "bootstrap TLS task panicked or was cancelled".into(),
        Err(_) => "bootstrap TLS validation exceeded 5 seconds".into(),
        _ => unreachable!(),
      };
      rows.push(DoctorRow::new("bootstrap.tls", DoctorStatus::Fail, started, detail));
      None
    }
  };
  tokio::join!(
    doctor_dependencies(database, trust.clone(), rows, deadline),
    external::inspect(external_origin, trust.as_ref(), external_rows),
  );
}

async fn doctor_dependencies(
  database: Option<String>,
  trust: Option<Option<myoxus_infrastructure::tls::ValidatedCaBundle>>,
  rows: &mut Vec<DoctorRow>,
  deadline: tokio::time::Instant,
) {
  let mut pool = None;
  // Run the only mutating diagnostic early, with a cleanup deadline strictly
  // inside the complete report deadline. Later read-only probes may be cancelled.
  if let Some(bundle) = &trust {
    rows.extend(storage::inspect(bundle.as_ref(), deadline).await);
  } else {
    rows.push(DoctorRow::new(
      "storage.roundtrip",
      DoctorStatus::Skip,
      Instant::now(),
      "requires valid bootstrap TLS; no alternate store used",
    ));
  }
  let started = Instant::now();
  if let (Some(url), Some(bundle)) = (database, trust.clone()) {
    let deadline = tokio::time::Instant::now() + DOCTOR_CHECK_TIMEOUT;
    let prepared = tokio::time::timeout_at(
      deadline,
      tokio::task::spawn_blocking(move || myoxus_infrastructure::tls::postgres::connect_options(&url, bundle.as_ref())),
    )
    .await;
    let (status, detail) = match prepared {
      Ok(Ok(Ok(options))) => {
        let target = format!(
          "host={:?} port={} database={:?} user={:?} tls={:?} socket={:?}",
          options.get_host(),
          options.get_port(),
          options.get_database().unwrap_or(options.get_username()),
          options.get_username(),
          options.get_ssl_mode(),
          options.get_socket()
        );
        // A pool retries connection errors and can replace the useful I/O/TLS
        // cause with PoolTimedOut. Probe one real connection instead.
        match tokio::time::timeout_at(deadline, sqlx::PgConnection::connect_with(&options)).await {
          Ok(Ok(connection)) => {
            drop(connection);
            pool = Some(
              sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(DOCTOR_CHECK_TIMEOUT)
                .connect_lazy_with(options),
            );
            (
              DoctorStatus::Pass,
              format!("{target}; connected (readiness reported separately)"),
            )
          }
          Ok(Err(error)) => {
            let cause = match &error {
              sqlx::Error::Database(error) => format!(
                "SQLSTATE {}: {}",
                error.code().as_deref().unwrap_or("unknown"),
                error.message()
              ),
              _ => error.to_string(),
            };
            (DoctorStatus::Fail, format!("{target}; {cause}"))
          }
          Err(_) => (DoctorStatus::Fail, format!("{target}; connection exceeded 5 seconds")),
        }
      }
      Ok(Ok(Err(error))) => (DoctorStatus::Fail, error),
      Ok(Err(_)) => (
        DoctorStatus::Fail,
        "PostgreSQL options task panicked or was cancelled".into(),
      ),
      Err(_) => (
        DoctorStatus::Fail,
        "PostgreSQL connection options exceeded 5 seconds".into(),
      ),
    };
    rows.push(DoctorRow::new("database.connection", status, started, detail));
  } else {
    rows.push(DoctorRow::new(
      "database.connection",
      DoctorStatus::Skip,
      started,
      "requires valid database configuration and bootstrap TLS",
    ));
  }
  doctor_configuration(pool.as_ref(), rows).await;
  doctor_database(pool.as_ref(), rows).await;
  if let Some(bundle) = trust {
    rows.extend(redis::inspect(bundle.as_ref(), None, true).await.checks);
    rows.push(smtp::inspect(bundle.as_ref()).await);
  } else {
    rows.push(DoctorRow::new(
      "redis.prerequisites",
      DoctorStatus::Skip,
      Instant::now(),
      "requires valid bootstrap TLS; no fallback applied",
    ));
    rows.push(DoctorRow::new(
      "smtp.connection",
      DoctorStatus::Skip,
      Instant::now(),
      "requires valid bootstrap TLS; no fallback applied",
    ));
  }
  if let Some(pool) = pool {
    pool.close().await;
  }
}

async fn doctor_database(pool: Option<&PgPool>, rows: &mut Vec<DoctorRow>) {
  let Some(pool) = pool else {
    for id in ["database.readiness", "database.migrations"] {
      rows.push(DoctorRow::new(
        id,
        DoctorStatus::Skip,
        Instant::now(),
        "requires a successful database connection with validated bootstrap TLS",
      ));
    }
    return;
  };
  let started = Instant::now();
  let (status, detail) = match tokio::time::timeout(
    DOCTOR_CHECK_TIMEOUT,
    myoxus_api::startup_checks::verify_database_readiness(pool),
  )
  .await
  {
    Ok(Ok(())) => (
      DoctorStatus::Pass,
      "connectivity, required tables and required privileges verified".to_string(),
    ),
    Ok(Err(error)) => (DoctorStatus::Fail, format!("{}: {error}", error.code())),
    Err(_) => (
      DoctorStatus::Fail,
      "database readiness check exceeded 5 seconds".to_string(),
    ),
  };
  rows.push(DoctorRow::new("database.readiness", status, started, detail));
  let started = Instant::now();
  let (status, detail) =
    match tokio::time::timeout(DOCTOR_CHECK_TIMEOUT, myoxus_infrastructure::migrations::inspect(pool)).await {
      Ok(Ok(inspection)) => {
        let status = if inspection.pending_versions.is_empty() {
          DoctorStatus::Pass
        } else {
          DoctorStatus::Warn
        };
        (
          status,
          format!(
            "class={} highest_applied={:?} pending_versions={:?}; inspection is read-only",
            inspection.ledger_class, inspection.highest_applied, inspection.pending_versions
          ),
        )
      }
      Ok(Err(error)) => {
        let detail = match error {
          myoxus_infrastructure::migrations::MigrationRunError::Database(error) => error.to_string(),
          error => error.to_string(),
        };
        (DoctorStatus::Fail, detail)
      }
      Err(_) => (
        DoctorStatus::Fail,
        "read-only migration ledger inspection exceeded 5 seconds".to_string(),
      ),
    };
  rows.push(DoctorRow::new("database.migrations", status, started, detail));
}

async fn doctor_configuration(pool: Option<&PgPool>, rows: &mut Vec<DoctorRow>) {
  let started = Instant::now();
  let mut verified_overrides = false;
  let overrides = if let Some(pool) = pool {
    match tokio::time::timeout(
      DOCTOR_CHECK_TIMEOUT,
      myoxus_infrastructure::app_config::load_validated_app_config_values(pool),
    )
    .await
    {
      Ok(Ok(overrides)) => {
        verified_overrides = true;
        rows.push(DoctorRow::new(
          "configuration.overrides",
          DoctorStatus::Pass,
          started,
          "registered database overrides loaded",
        ));
        overrides
      }
      Ok(Err(error)) => {
        let status = if matches!(
          error,
          myoxus_infrastructure::app_config::AppConfigLoadError::Database(_)
        ) {
          DoctorStatus::Warn
        } else {
          DoctorStatus::Fail
        };
        rows.push(DoctorRow::new(
          "configuration.overrides",
          status,
          started,
          format!("database overrides unverified: {error}"),
        ));
        Default::default()
      }
      Err(_) => {
        rows.push(DoctorRow::new(
          "configuration.overrides",
          DoctorStatus::Warn,
          started,
          "database override read exceeded 5 seconds; overrides unverified",
        ));
        Default::default()
      }
    }
  } else {
    rows.push(DoctorRow::new(
      "configuration.overrides",
      DoctorStatus::Warn,
      started,
      "database unavailable; overrides and pending-restart state are unverified, not assumed absent",
    ));
    Default::default()
  };
  let started = Instant::now();
  let inspected = tokio::time::timeout(
    DOCTOR_CHECK_TIMEOUT,
    tokio::task::spawn_blocking(move || {
      use myoxus_contracts::effective_config::{CONFIG_REGISTRY, RuntimeEffectiveState};
      let sources = myoxus_contracts::runtime_config::load_server_config_sources()?;
      let findings =
        crate::config::collect_check_results(&crate::config::ConfigCheckArgs { verbose: false }, &sources, &overrides)?;
      // Use the existing no-write startup validator: AppConfig::load itself may
      // bootstrap/persist secrets and is not a diagnostic operation.
      use myoxus_application::config_validation::{PreparedConfigCandidate, StartupConfigValidator};
      let overlay = match sources.paths.runtime_overlay_path.as_ref().map(std::fs::read_to_string) {
        Some(Ok(yaml)) => Some(yaml),
        Some(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => None,
        Some(Err(error)) => {
          return Err(anyhow::anyhow!(
            "runtime configuration overlay could not be read: {error}"
          ));
        }
        None => None,
      };
      let validity = myoxus_api::config::AppConfigStartupValidator.validate(&PreparedConfigCandidate {
        database_overrides: overrides.clone(),
        runtime_overlay_yaml: overlay,
      });
      let fields = CONFIG_REGISTRY
        .iter()
        .map(|descriptor| sources.source_snapshot.resolve(descriptor, &overrides))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
      let pending = fields
        .iter()
        .filter(|field| field.runtime_effective_state == RuntimeEffectiveState::PendingRestart)
        .map(|field| field.path.as_str())
        .collect::<Vec<_>>()
        .join(", ");
      Ok::<_, anyhow::Error>((findings, pending, validity))
    }),
  )
  .await;
  match inspected {
    Ok(Ok(Ok((findings, pending, validity)))) => {
      let (status, detail) = match validity {
        Ok(()) => (
          DoctorStatus::Pass,
          if verified_overrides {
            "typed CLI startup configuration validated without writes".to_string()
          } else {
            "typed file/ENV snapshot validated; database overrides remain unverified".to_string()
          },
        ),
        Err(error) => (DoctorStatus::Fail, error),
      };
      rows.push(DoctorRow::new("configuration.validity", status, started, detail));
      let level = findings
        .iter()
        .map(|finding| finding.level)
        .max()
        .unwrap_or(crate::config::CheckLevel::Info);
      let status = match level {
        crate::config::CheckLevel::Critical => DoctorStatus::Fail,
        crate::config::CheckLevel::Warning => DoctorStatus::Warn,
        crate::config::CheckLevel::Info => DoctorStatus::Pass,
      };
      let coverage = if verified_overrides {
        "file/ENV and verified DB overrides"
      } else {
        "file/ENV only; DB overrides unverified"
      };
      let detail = findings
        .iter()
        .map(|finding| format!("{}: {}", finding.title, finding.message))
        .collect::<Vec<_>>()
        .join("\n");
      rows.push(DoctorRow::new(
        "configuration.readiness",
        status,
        started,
        format!("CLI snapshot ({coverage}), not running API state:\n{detail}"),
      ));
      let status = if !verified_overrides || !pending.is_empty() {
        DoctorStatus::Warn
      } else {
        DoctorStatus::Pass
      };
      let detail = if !verified_overrides {
        "DB pending-restart state unverified".to_string()
      } else if pending.is_empty() {
        "no pending restart in this CLI configuration snapshot".to_string()
      } else {
        format!("pending restart: {pending}")
      };
      rows.push(DoctorRow::new("configuration.pending_restart", status, started, detail));
      rows.push(DoctorRow::new("authentication.capabilities", DoctorStatus::Skip, started, "configuration presence is reported above; actual account/provider/SMTP-dependent capabilities of the running API are not established by a CLI snapshot"));
    }
    result => {
      let detail = match result {
        Ok(Ok(Err(error))) => error.to_string(),
        Ok(Err(_)) => "configuration inspection task panicked or was cancelled".into(),
        Err(_) => "configuration inspection exceeded 5 seconds".into(),
        _ => unreachable!(),
      };
      rows.push(DoctorRow::new(
        "configuration.readiness",
        DoctorStatus::Fail,
        started,
        detail,
      ));
      rows.push(DoctorRow::new(
        "authentication.capabilities",
        DoctorStatus::Skip,
        started,
        "requires valid configuration sources",
      ));
    }
  }
}

/// Arguments for `system queue`.
#[derive(Args)]
pub struct QueueArgs {
  /// Filter to a specific queue name; if omitted shows all queues.
  #[arg(long)]
  pub queue: Option<String>,
}

/// Arguments for `system health`.
#[derive(Args)]
pub struct HealthArgs {
  /// Base URL of the running API server.
  #[arg(long, default_value = "http://localhost:3001")]
  pub url: String,
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// Summary status line for the `status` command.
#[derive(Tabled, Serialize)]
pub struct StatusRow {
  /// Component name.
  pub component: String,
  /// Current status (`ok`, `error`, `warn` or `skip`).
  pub status: String,
  /// Additional detail string.
  pub detail: String,
}

/// Applied migration row.
#[derive(Tabled, Serialize)]
pub struct MigrationRow {
  /// Sequential migration version number.
  pub version: i64,
  /// Human-readable migration description.
  pub description: String,
  /// When the migration was applied.
  pub applied_on: String,
  /// SQLx SHA-384 checksum (hex-encoded).
  pub checksum: String,
}

/// Queue stats row.
#[derive(Tabled, Serialize)]
pub struct QueueStatsRow {
  /// Queue name.
  pub queue: String,
  /// Job status bucket.
  pub status: String,
  /// Number of jobs in this bucket.
  pub count: i64,
}

/// HTTP endpoint health check row.
#[derive(Tabled, Serialize)]
pub struct HealthRow {
  /// Full endpoint URL.
  pub endpoint: String,
  /// HTTP status code string.
  pub http_status: String,
  /// Bounded diagnostic summary; response bodies are never echoed.
  pub body_snippet: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `system` subcommand.
pub async fn run(
  cmd: SystemCommand,
  pool: &PgPool,
  json: bool,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> anyhow::Result<()> {
  match cmd {
    SystemCommand::Doctor(_) => anyhow::bail!("Doctor must be dispatched before database initialization"),
    SystemCommand::Status => status(pool, json, additional_ca).await,
    SystemCommand::Migrations => migrations(pool, json).await,
    SystemCommand::Queue(args) => queue(args, json, additional_ca).await,
    SystemCommand::Health(_) => anyhow::bail!("HTTP health must be dispatched before database initialization"),
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async fn status(
  pool: &PgPool,
  json: bool,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> anyhow::Result<()> {
  let mut rows: Vec<StatusRow> = Vec::new();

  // DB ping.
  match tokio::time::timeout(DOCTOR_CHECK_TIMEOUT, sqlx::query("SELECT 1").execute(pool)).await {
    Ok(Ok(_)) => rows.push(StatusRow {
      component: "postgres".to_string(),
      status: "ok".to_string(),
      detail: "connection pool live".to_string(),
    }),
    result => rows.push(StatusRow {
      component: "postgres".to_string(),
      status: "error".to_string(),
      detail: match result {
        Ok(Err(error)) => error.to_string(),
        _ => "database ping exceeded 5 seconds".into(),
      },
    }),
  }

  let report = redis::inspect(additional_ca, None, true).await;
  let queue_failed = report.checks.iter().any(|check| {
    matches!(check.status, DoctorStatus::Fail)
      && matches!(
        check.check_id,
        "redis.configuration" | "redis.probe" | "redis.queue" | "worker.queue_stats"
      )
  });
  rows.push(StatusRow {
    component: "worker_queue".into(),
    status: if queue_failed { "error" } else { "ok" }.into(),
    detail: if queue_failed {
      "queue connectivity or measurement failed; see individual results"
    } else {
      "queue connectivity and all counts measured; worker processing remains unverified"
    }
    .into(),
  });
  for check in report.checks {
    rows.push(StatusRow {
      component: check.check_id.to_string(),
      status: match check.status {
        DoctorStatus::Pass => "ok",
        DoctorStatus::Fail => "error",
        DoctorStatus::Warn => "warn",
        DoctorStatus::Skip => "skip",
      }
      .into(),
      detail: check.detail,
    });
  }

  if json {
    print_json(&rows);
  } else {
    print_table(&rows);
  }
  anyhow::ensure!(
    !rows.iter().any(|row| row.status == "error"),
    "system status reported failed measurements"
  );
  Ok(())
}

async fn migrations(pool: &PgPool, json: bool) -> anyhow::Result<()> {
  // sqlx stores migration history in _sqlx_migrations.
  let rows: Vec<(i64, String, DateTime<Utc>, Vec<u8>)> = sqlx::query_as(
    r#"SELECT version, description, installed_on, checksum
           FROM _sqlx_migrations
           ORDER BY version"#,
  )
  .fetch_all(pool)
  .await?;

  let display: Vec<MigrationRow> = rows
    .into_iter()
    .map(|(version, description, installed_on, checksum)| MigrationRow {
      version,
      description,
      applied_on: installed_on.to_rfc3339(),
      checksum: hex_encode(&checksum),
    })
    .collect();

  if json {
    print_json(&display);
  } else {
    print_table(&display);
  }
  Ok(())
}

async fn queue(
  args: QueueArgs,
  json: bool,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> anyhow::Result<()> {
  let report = redis::inspect(additional_ca, args.queue.as_deref(), false).await;
  for check in &report.checks {
    if !matches!(check.status, DoctorStatus::Pass) {
      eprintln!("{} {}: {}", check.status, check.check_id, check.detail);
    }
  }
  print_output(&report.counts, json);
  anyhow::ensure!(
    !report.checks.iter().any(|row| matches!(row.status, DoctorStatus::Fail)),
    "system queue reported failed measurements"
  );
  Ok(())
}

pub async fn health(args: &HealthArgs, json: bool) -> anyhow::Result<()> {
  let base = http::base_url(&args.url).map_err(anyhow::Error::msg)?;
  let client = tokio::time::timeout(
    DOCTOR_CHECK_TIMEOUT,
    tokio::task::spawn_blocking(|| {
      let (bundle, _) = crate::services::Services::load_bootstrap_tls()?;
      http::client(bundle.as_ref()).map_err(anyhow::Error::msg)
    }),
  )
  .await;
  let client = match client {
    Ok(Ok(result)) => result,
    Ok(Err(_)) => Err(anyhow::anyhow!("HTTP bootstrap task panicked or was cancelled")),
    Err(_) => Err(anyhow::anyhow!("HTTP bootstrap exceeded 5 seconds")),
  };
  let mut rows = Vec::new();
  let mut failed = false;
  for (path, ready) in [("health", false), ("ready", true)] {
    let endpoint = base.join(path)?;
    let result = match &client {
      Ok(client) => http::get(client, endpoint.clone(), http::JSON_LIMIT).await,
      Err(error) => Err(http::Failure {
        http_status: "configuration_error".into(),
        detail: error.to_string(),
      }),
    };
    let (http_status, detail) = match result {
      Ok(response) => {
        let status = response.status.to_string();
        match http::health_contract(&response, ready) {
          Ok(detail) => (status, detail),
          Err(detail) => {
            failed = true;
            (status, detail)
          }
        }
      }
      Err(error) => {
        failed = true;
        (error.http_status, error.detail)
      }
    };
    rows.push(HealthRow {
      endpoint: endpoint.to_string(),
      http_status,
      body_snippet: detail.chars().take(120).collect(),
    });
  }
  print_output(&rows, json);
  anyhow::ensure!(!failed, "system health reported unsuccessful endpoint checks");
  Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Encode a byte slice as lowercase hexadecimal.
fn hex_encode(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}
