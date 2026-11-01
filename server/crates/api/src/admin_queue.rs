// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Canonical AdminRoot queue operations.
//!
//! The admin frontend consumes queue state through GraphQL. Keeping the queue
//! shape and mutations here prevents the client from reconstructing tRPC
//! payloads or interpreting Redis/BullMQ internals itself.

use serde::Serialize;
use serde_json::Value;
use tracing::{info, instrument, warn};

use crate::state::ApiState;

/// All queues registered by the worker runtime.
pub const ADMIN_QUEUE_NAMES: &[&str] = &[
  "notification",
  "doc",
  "nightly",
  "workspace",
  myoxus_application::workspace_import::WORKSPACE_IMPORT_QUEUE,
  crate::telemetry_worker::TELEMETRY_QUEUE,
  crate::metrics_worker::METRICS_QUEUE,
  "copilot",
  "indexer",
  "document-graph",
  "calendar-reminder",
  "git-sync",
  "template-registry",
  "caldav-sync",
  "google-calendar-sync",
  "pdf-export",
  "database",
  "workspace-automation",
  "workspace-content-operation",
];

#[derive(Clone, Debug, Serialize)]
pub struct AdminQueueCounts {
  pub waiting: i64,
  pub active: i64,
  pub completed: i64,
  pub failed: i64,
  pub delayed: i64,
  pub stalled: i64,
}

impl AdminQueueCounts {
  fn empty() -> Self {
    Self {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      stalled: 0,
    }
  }
}

#[derive(Clone, Debug, Serialize)]
pub struct AdminQueue {
  pub name: String,
  pub display_name: String,
  pub paused: bool,
  pub degraded: bool,
  pub counts: AdminQueueCounts,
  pub history: Option<Vec<myoxus_worker::metrics::QueueHistoryPoint>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AdminQueueStatus {
  pub redis_available: bool,
  pub degraded: bool,
  pub queues: Vec<AdminQueue>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AdminQueueJob {
  pub id: String,
  pub name: String,
  pub timestamp: Option<i64>,
  pub attempts_made: i32,
  pub finished_on: Option<i64>,
  pub failed_reason: Option<String>,
  pub data: Value,
  pub return_value: Option<Value>,
  pub workspace_content_operation: Option<myoxus_domain::workspace_content_operation::WorkspaceContentOperationRecord>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AdminQueueJobs {
  pub total_count: i64,
  pub num_of_pages: i64,
  pub next_cursor: Option<i64>,
  pub jobs: Vec<AdminQueueJob>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AdminQueueMutationResult {
  pub ok: bool,
  pub name: Option<String>,
  pub job_id: Option<String>,
  pub removed: Option<i64>,
  pub failed: Option<i64>,
  pub error: Option<String>,
}

fn validate_queue_name(queue_name: &str) -> Result<(), String> {
  if ADMIN_QUEUE_NAMES.contains(&queue_name) {
    Ok(())
  } else {
    Err(format!("unknown queue '{queue_name}'"))
  }
}

/// Sampling belongs to the runtime, not to an Admin read. Partial Redis stats
/// leave a gap and minute replacement bounds multi-instance duplication.
pub async fn run_queue_history_sampler(
  queue: myoxus_worker::RedisQueue,
  mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
  let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
  interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
  loop {
    if *shutdown.borrow() {
      break;
    }
    tokio::select! {
      _ = shutdown.changed() => break,
      _ = interval.tick() => {
        let sample = async {
          for name in ADMIN_QUEUE_NAMES {
            match queue.queue_stats(name).await {
              Ok(stats) => {
                if let Err(err) = queue.record_history(&stats, chrono::Utc::now().timestamp_millis()).await {
                  warn!(queue = %name, error = %err, "queue history sample failed");
                }
              }
              Err(err) => warn!(queue = %name, error = %err, "queue history stats unavailable"),
            }
          }
        };
        tokio::select! {
          _ = shutdown.changed() => break,
          _ = sample => {}
        }
      }
    }
  }
}

fn display_name(queue_name: &str) -> String {
  queue_name.to_string()
}

/// Build the live queue status without transport/auth concerns.
#[instrument(skip_all, level = "debug")]
pub async fn queue_status_snapshot(state: &ApiState) -> AdminQueueStatus {
  let Some(queue) = state.redis_queue() else {
    return AdminQueueStatus {
      redis_available: false,
      degraded: true,
      queues: ADMIN_QUEUE_NAMES
        .iter()
        .map(|name| AdminQueue {
          name: (*name).to_string(),
          display_name: display_name(name),
          paused: false,
          degraded: true,
          counts: AdminQueueCounts::empty(),
          history: None,
        })
        .collect(),
    };
  };

  let mut degraded = false;
  let mut queues = Vec::with_capacity(ADMIN_QUEUE_NAMES.len());
  for name in ADMIN_QUEUE_NAMES {
    let paused = match queue.is_paused(name).await {
      Ok(paused) => paused,
      Err(err) => {
        degraded = true;
        warn!(queue = %name, error = %err, "admin queue pause-state lookup failed");
        false
      }
    };

    let (counts, queue_degraded) = match queue.queue_stats(name).await {
      Ok(stats) => (
        AdminQueueCounts {
          waiting: stats.waiting,
          active: stats.active,
          completed: stats.completed,
          failed: stats.failed,
          delayed: stats.delayed,
          stalled: stats.stalled,
        },
        stats.degraded,
      ),
      Err(err) => {
        warn!(queue = %name, error = %err, "admin queue stats lookup failed");
        (AdminQueueCounts::empty(), true)
      }
    };
    degraded |= queue_degraded;
    let history = match queue.history(name, chrono::Utc::now().timestamp_millis()).await {
      Ok(points) => Some(points),
      Err(err) => {
        warn!(queue = %name, error = %err, "admin queue history lookup failed");
        None
      }
    };
    queues.push(AdminQueue {
      name: (*name).to_string(),
      display_name: display_name(name),
      paused,
      degraded: queue_degraded,
      counts,
      history,
    });
  }

  AdminQueueStatus {
    redis_available: true,
    degraded,
    queues,
  }
}

/// Return paginated jobs for one queue/status.
#[instrument(skip_all, fields(queue = %queue_name, status = %status), level = "debug")]
pub async fn queue_jobs(
  state: &ApiState,
  queue_name: &str,
  status: &str,
  cursor: i64,
  limit: i64,
) -> Result<AdminQueueJobs, String> {
  validate_queue_name(queue_name)?;
  let status = match status {
    "waiting" | "active" | "completed" | "failed" | "delayed" => status,
    other => return Err(format!("unknown queue job status '{other}'")),
  };
  let cursor = cursor.max(0);
  let limit = limit.clamp(1, 100);
  let Some(queue) = state.redis_queue() else {
    return Ok(AdminQueueJobs {
      total_count: 0,
      num_of_pages: 0,
      next_cursor: None,
      jobs: Vec::new(),
    });
  };

  let (jobs, total_count) = queue
    .list_jobs(queue_name, status, cursor, limit)
    .await
    .map_err(|err| err.to_string())?;
  let num_of_pages = if limit > 0 {
    (total_count + limit - 1) / limit
  } else {
    0
  };
  let next_cursor = if cursor + limit < total_count {
    Some(cursor + limit)
  } else {
    None
  };

  let mut jobs = jobs.into_iter().map(admin_queue_job_from_json).collect::<Vec<_>>();
  if queue_name == "workspace-content-operation" {
    if let Some(service) = state.workspace_content_control_service() {
      for job in &mut jobs {
        if let Some(operation_id) = job
          .data
          .get("operationId")
          .and_then(Value::as_str)
          .and_then(|id| uuid::Uuid::parse_str(id).ok())
        {
          match service.operator_status(operation_id).await {
            Ok(projection) => job.workspace_content_operation = Some(projection.record),
            Err(_) => warn!(%operation_id, "workspace content Admin job status is unavailable"),
          }
        }
      }
    }
  }
  Ok(AdminQueueJobs {
    total_count,
    num_of_pages,
    next_cursor,
    jobs,
  })
}

fn admin_queue_job_from_json(value: Value) -> AdminQueueJob {
  let id = value.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
  let name = value
    .get("name")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string();
  let attempts_made = value
    .get("attemptsMade")
    .and_then(value_to_i64)
    .unwrap_or(0)
    .clamp(0, i64::from(i32::MAX)) as i32;
  AdminQueueJob {
    id,
    name,
    timestamp: value.get("timestamp").and_then(value_to_i64),
    attempts_made,
    finished_on: value.get("finishedOn").and_then(value_to_i64),
    failed_reason: value
      .get("failedReason")
      .and_then(Value::as_str)
      .filter(|s| !s.is_empty())
      .map(str::to_string),
    data: value.get("data").cloned().unwrap_or(Value::Object(Default::default())),
    return_value: value.get("returnvalue").cloned(),
    workspace_content_operation: None,
  }
}

fn value_to_i64(value: &Value) -> Option<i64> {
  value.as_i64().or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

pub async fn pause_queue(state: &ApiState, queue_name: &str) -> Result<AdminQueueMutationResult, String> {
  validate_queue_name(queue_name)?;
  let Some(queue) = state.redis_queue() else {
    return Ok(queue_unavailable(queue_name));
  };
  queue.pause_queue(queue_name).await.map_err(|err| err.to_string())?;
  info!(queue = %queue_name, "admin queue paused");
  Ok(AdminQueueMutationResult {
    ok: true,
    name: Some(queue_name.to_string()),
    job_id: None,
    removed: None,
    failed: None,
    error: None,
  })
}

pub async fn resume_queue(state: &ApiState, queue_name: &str) -> Result<AdminQueueMutationResult, String> {
  validate_queue_name(queue_name)?;
  let Some(queue) = state.redis_queue() else {
    return Ok(queue_unavailable(queue_name));
  };
  queue.resume_queue(queue_name).await.map_err(|err| err.to_string())?;
  info!(queue = %queue_name, "admin queue resumed");
  Ok(AdminQueueMutationResult {
    ok: true,
    name: Some(queue_name.to_string()),
    job_id: None,
    removed: None,
    failed: None,
    error: None,
  })
}

pub async fn pause_all_queues(state: &ApiState) -> AdminQueueMutationResult {
  apply_all_queues(state, true).await
}

pub async fn resume_all_queues(state: &ApiState) -> AdminQueueMutationResult {
  apply_all_queues(state, false).await
}

async fn apply_all_queues(state: &ApiState, pause: bool) -> AdminQueueMutationResult {
  let Some(queue) = state.redis_queue() else {
    return AdminQueueMutationResult {
      ok: false,
      name: None,
      job_id: None,
      removed: None,
      failed: None,
      error: Some("redis queue not available".to_string()),
    };
  };
  let mut failed = 0_i64;
  for name in ADMIN_QUEUE_NAMES {
    let result = if pause {
      queue.pause_queue(name).await
    } else {
      queue.resume_queue(name).await
    };
    if let Err(err) = result {
      failed += 1;
      warn!(queue = %name, error = %err, pause, "admin queue bulk operation failed for one queue");
    }
  }
  AdminQueueMutationResult {
    ok: failed == 0,
    name: None,
    job_id: None,
    removed: None,
    failed: Some(failed),
    error: (failed > 0).then(|| format!("{failed} queue operations failed")),
  }
}

pub async fn clean_queue(
  state: &ApiState,
  queue_name: &str,
  status: &str,
  grace_period_ms: i64,
) -> Result<AdminQueueMutationResult, String> {
  validate_queue_name(queue_name)?;
  if !matches!(status, "completed" | "failed") {
    return Err(format!("queue clean does not support status '{status}'"));
  }
  let Some(queue) = state.redis_queue() else {
    return Ok(queue_unavailable(queue_name));
  };
  let removed = queue
    .clean_queue(queue_name, status, grace_period_ms.max(0))
    .await
    .map_err(|err| err.to_string())? as i64;
  info!(queue = %queue_name, status, removed, "admin queue cleaned");
  Ok(AdminQueueMutationResult {
    ok: true,
    name: Some(queue_name.to_string()),
    job_id: None,
    removed: Some(removed),
    failed: None,
    error: None,
  })
}

pub async fn empty_queue(state: &ApiState, queue_name: &str) -> Result<AdminQueueMutationResult, String> {
  validate_queue_name(queue_name)?;
  let Some(queue) = state.redis_queue() else {
    return Ok(queue_unavailable(queue_name));
  };
  let removed = queue.empty_queue(queue_name).await.map_err(|err| err.to_string())? as i64;
  info!(queue = %queue_name, removed, "admin queue emptied");
  Ok(AdminQueueMutationResult {
    ok: true,
    name: Some(queue_name.to_string()),
    job_id: None,
    removed: Some(removed),
    failed: None,
    error: None,
  })
}

pub async fn retry_job(state: &ApiState, queue_name: &str, job_id: &str) -> Result<AdminQueueMutationResult, String> {
  validate_queue_name(queue_name)?;
  // Replaying a transport envelope does not reset the durable aggregate. Only
  // feature-owned actions can validate its revision, authorization and cleanup.
  if queue_name == myoxus_application::workspace_content_operation::coordination::WORKSPACE_CONTENT_QUEUE {
    return Err("workspace content jobs require the operation retry or cleanup action".to_string());
  }
  let Some(queue) = state.redis_queue() else {
    return Ok(queue_unavailable_job(queue_name, job_id));
  };
  queue
    .retry_job(queue_name, job_id)
    .await
    .map_err(|err| err.to_string())?;
  info!(queue = %queue_name, job_id, "admin queue job retried");
  Ok(AdminQueueMutationResult {
    ok: true,
    name: Some(queue_name.to_string()),
    job_id: Some(job_id.to_string()),
    removed: None,
    failed: None,
    error: None,
  })
}

pub async fn promote_job(state: &ApiState, queue_name: &str, job_id: &str) -> Result<AdminQueueMutationResult, String> {
  validate_queue_name(queue_name)?;
  let Some(queue) = state.redis_queue() else {
    return Ok(queue_unavailable_job(queue_name, job_id));
  };
  queue
    .promote_job(queue_name, job_id)
    .await
    .map_err(|err| err.to_string())?;
  info!(queue = %queue_name, job_id, "admin queue job promoted");
  Ok(AdminQueueMutationResult {
    ok: true,
    name: Some(queue_name.to_string()),
    job_id: Some(job_id.to_string()),
    removed: None,
    failed: None,
    error: None,
  })
}

fn queue_unavailable(queue_name: &str) -> AdminQueueMutationResult {
  AdminQueueMutationResult {
    ok: false,
    name: Some(queue_name.to_string()),
    job_id: None,
    removed: None,
    failed: None,
    error: Some("redis queue not available".to_string()),
  }
}

fn queue_unavailable_job(queue_name: &str, job_id: &str) -> AdminQueueMutationResult {
  AdminQueueMutationResult {
    ok: false,
    name: Some(queue_name.to_string()),
    job_id: Some(job_id.to_string()),
    removed: None,
    failed: None,
    error: Some("redis queue not available".to_string()),
  }
}
