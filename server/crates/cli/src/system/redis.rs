// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only Redis role and queue measurements shared by CLI diagnostics.

use myoxus_api::config::{RedisConfig, RedisRole};
use myoxus_infrastructure::{redis::RedisAdapter, tls::ValidatedCaBundle};
use myoxus_worker::RedisQueue;

use super::{DOCTOR_CHECK_TIMEOUT, DoctorRow, DoctorStatus, Instant, QueueStatsRow};

pub(super) struct RedisReport {
  pub checks: Vec<DoctorRow>,
  pub counts: Vec<QueueStatsRow>,
}

/// Queue-only inspection does not depend on unrelated roles. Doctor/status
/// inspect all roles using the same required/optional policy as API startup.
pub(super) async fn inspect(
  additional_ca: Option<&ValidatedCaBundle>,
  queue_filter: Option<&str>,
  all_roles: bool,
) -> RedisReport {
  let mut report = RedisReport {
    checks: Vec::new(),
    counts: Vec::new(),
  };
  let started = Instant::now();
  let configuration = tokio::time::timeout(
    DOCTOR_CHECK_TIMEOUT,
    tokio::task::spawn_blocking(|| {
      myoxus_contracts::runtime_config::load_server_config_sources()?
        .config
        .get::<RedisConfig>("redis")
    }),
  )
  .await;
  let configuration = match configuration {
    Ok(Ok(Ok(configuration))) => configuration,
    result => {
      let detail = match result {
        Ok(Ok(Err(error))) => error.to_string(),
        Ok(Err(_)) => "Redis configuration task panicked or was cancelled".into(),
        Err(_) => "Redis configuration read exceeded 5 seconds".into(),
        _ => unreachable!(),
      };
      report.checks.push(DoctorRow::new(
        "redis.configuration",
        DoctorStatus::Fail,
        started,
        detail,
      ));
      return report;
    }
  };

  // Start independent roles together so one unreachable role cannot consume
  // the report deadline before the healthy roles have been inspected.
  let mut roles = tokio::task::JoinSet::new();
  for (index, role) in RedisRole::ALL.into_iter().enumerate() {
    if !all_roles && role != RedisRole::Queue {
      continue;
    }
    let configuration = configuration.clone();
    let additional_ca = additional_ca.cloned();
    roles.spawn(async move { (index, role_probe(&configuration, role, additional_ca.as_ref()).await) });
  }
  let mut measured = Vec::new();
  while let Some(result) = roles.join_next().await {
    match result {
      Ok(result) => measured.push(result),
      Err(error) => report.checks.push(DoctorRow::new(
        "redis.probe",
        DoctorStatus::Fail,
        started,
        format!("Redis probe task failed: {error}"),
      )),
    }
  }
  measured.sort_by_key(|(index, _)| *index);
  let mut queue = None;
  for (_, (check, adapter)) in measured {
    report.checks.push(check);
    if adapter.is_some() {
      queue = adapter;
    }
  }
  if let Some(queue) = queue {
    let names = queue_filter.map_or_else(
      || myoxus_api::admin_queue::ADMIN_QUEUE_NAMES.to_vec(),
      |name| vec![name],
    );
    let mut measurements = tokio::task::JoinSet::new();
    for (index, name) in names.into_iter().enumerate() {
      let queue = queue.clone();
      let name = name.to_string();
      measurements.spawn(async move {
        let started = Instant::now();
        let measured = tokio::time::timeout(DOCTOR_CHECK_TIMEOUT, queue.queue_stats(&name)).await;
        let (status, detail, stats) = match measured {
          Ok(Ok(stats)) if !stats.degraded => (
            DoctorStatus::Pass,
            format!(
              "queue={name:?}; waiting={} active={} completed={} failed={} delayed={} stalled={}",
              stats.waiting, stats.active, stats.completed, stats.failed, stats.delayed, stats.stalled
            ),
            Some(stats),
          ),
          Ok(Ok(_)) => (
            DoctorStatus::Fail,
            format!(
              "queue={name:?}; partial stats failure (degraded); all count rows omitted; see command errors on stderr"
            ),
            None,
          ),
          Ok(Err(error)) => (DoctorStatus::Fail, format!("queue={name:?}; {error}"), None),
          Err(_) => (
            DoctorStatus::Fail,
            format!("queue={name:?}; stats measurement exceeded 5 seconds"),
            None,
          ),
        };
        (
          index,
          DoctorRow::new("worker.queue_stats", status, started, detail),
          stats,
        )
      });
    }
    let mut measured = Vec::new();
    while let Some(result) = measurements.join_next().await {
      match result {
        Ok(result) => measured.push(result),
        Err(error) => report.checks.push(DoctorRow::new(
          "worker.queue_stats",
          DoctorStatus::Fail,
          Instant::now(),
          format!("queue measurement task failed: {error}"),
        )),
      }
    }
    measured.sort_by_key(|(index, _, _)| *index);
    for (_, check, stats) in measured {
      report.checks.push(check);
      if let Some(stats) = stats {
        // A degraded snapshot contains replacement zeroes, not measurements.
        // Never emit even its successful buckets as a complete queue result.
        for (status, count) in [
          ("waiting", stats.waiting),
          ("active", stats.active),
          ("completed", stats.completed),
          ("failed", stats.failed),
          ("delayed", stats.delayed),
          ("stalled", stats.stalled),
        ] {
          report.counts.push(QueueStatsRow {
            queue: stats.queue.clone(),
            status: status.into(),
            count,
          });
        }
      }
    }
  } else {
    report.checks.push(DoctorRow::new(
      "worker.queue_stats",
      DoctorStatus::Skip,
      Instant::now(),
      "requires successful queue role connectivity",
    ));
  }
  report.checks.push(DoctorRow::new("worker.processing", DoctorStatus::Warn, Instant::now(), "worker processing not verified; Redis connectivity and queue counts, including empty queues, do not prove a running worker"));
  report
}

async fn role_probe(
  configuration: &RedisConfig,
  role: RedisRole,
  additional_ca: Option<&ValidatedCaBundle>,
) -> (DoctorRow, Option<RedisQueue>) {
  let started = Instant::now();
  let id = match role {
    RedisRole::Cache => "redis.cache",
    RedisRole::Session => "redis.session",
    RedisRole::Queue => "redis.queue",
    RedisRole::Socket => "redis.socket",
    RedisRole::Lock => "redis.lock",
  };
  let Some(url) = configuration.role_url(role) else {
    let required = matches!(role, RedisRole::Session | RedisRole::Queue | RedisRole::Lock);
    let status = if required {
      DoctorStatus::Fail
    } else {
      DoctorStatus::Skip
    };
    return (
      DoctorRow::new(
        id,
        status,
        started,
        format!(
          "role={}; {} role has no URL",
          role.as_str(),
          if required { "required" } else { "optional" }
        ),
      ),
      None,
    );
  };
  let client = match myoxus_infrastructure::tls::redis::client(&url, additional_ca) {
    Ok(client) => client,
    Err(error) => return (DoctorRow::new(id, DoctorStatus::Fail, started, error), None),
  };
  let namespace = configuration.role_namespace(role);
  // ConnectionAddr excludes authentication; never format Client/ConnectionInfo.
  let target = format!(
    "target={} db={} namespace={namespace:?}",
    client.get_connection_info().addr(),
    client.get_connection_info().redis_settings().db()
  );
  let queue = (role == RedisRole::Queue)
    .then(|| RedisQueue::from_client(client.clone(), crate::services::redis_queue_prefix(&namespace)));
  let adapter = RedisAdapter::from_client(client, namespace);
  let ping = tokio::time::timeout(DOCTOR_CHECK_TIMEOUT, async {
    adapter.ping().await.map_err(|error| error.to_string())?;
    if let Some(queue) = &queue {
      queue.ping().await.map_err(|error| error.to_string())?;
    }
    Ok::<_, String>(())
  })
  .await;
  match ping {
    Ok(Ok(())) => (
      DoctorRow::new(id, DoctorStatus::Pass, started, format!("{target}; PING succeeded")),
      queue,
    ),
    Ok(Err(error)) => (
      DoctorRow::new(id, DoctorStatus::Fail, started, format!("{target}; {error}")),
      None,
    ),
    Err(_) => (
      DoctorRow::new(
        id,
        DoctorStatus::Fail,
        started,
        format!("{target}; connectivity check exceeded 5 seconds"),
      ),
      None,
    ),
  }
}
