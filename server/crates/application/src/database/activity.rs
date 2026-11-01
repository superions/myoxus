// SPDX-License-Identifier: AGPL-3.0-or-later
//! Fire-and-forget facade for the per-row database activity log (P-DB-24).
//!
//! [`DatabaseActivityRecorder`] wraps the [`DatabaseActivityStore`] port with
//! the same non-blocking semantics as [`crate::audit::AuditRecorder`]: a
//! failed recording must never abort the mutation that produced it.
//!
//! Activity events are user-visible (they populate the row activity drawer),
//! unlike the operator-facing [`crate::audit::AuditRecorder`]. Both facades
//! are usually wired together so a single mutation emits one audit record
//! (operator trail) and one activity record (workspace-visible trail).

use std::sync::{Arc, Mutex};

use myoxus_domain::database_activity::{
  DatabaseActivityEntry, DatabaseActivityError, DatabaseActivityEvent, DatabaseActivityFilter, DatabaseActivityStore,
};
use tracing::warn;

// Re-export domain types so callers only need to import
// `myoxus_application::database::activity::*`.
pub use myoxus_domain::database_activity::DatabaseActivityEventType;

#[derive(Clone)]
pub struct DatabaseActivityRecorder {
  store: Arc<dyn DatabaseActivityStore>,
}

impl DatabaseActivityRecorder {
  pub fn new(store: Arc<dyn DatabaseActivityStore>) -> Self {
    Self { store }
  }

  /// Record a database activity event. Storage errors are logged at `warn`
  /// and silently swallowed.
  pub async fn record(&self, event: DatabaseActivityEvent) {
    if let Err(err) = self.store.record(event).await {
      warn!(error = %err, "database activity record failed — event dropped");
    }
  }

  /// List activity entries (delegates to store — may propagate errors).
  pub async fn list(
    &self,
    filter: DatabaseActivityFilter,
    skip: i64,
    take: i64,
  ) -> Result<Vec<DatabaseActivityEntry>, DatabaseActivityError> {
    self.store.list(filter, skip, take).await
  }

  /// Count matching activity entries.
  pub async fn count(&self, filter: DatabaseActivityFilter) -> Result<i64, DatabaseActivityError> {
    self.store.count(filter).await
  }
}

// ─── No-op store for test environments ────────────────────────────────────────

/// A no-op store used in tests / builds without a database.
#[derive(Debug, Default)]
pub struct NoopDatabaseActivityStore;

#[async_trait::async_trait]
impl DatabaseActivityStore for NoopDatabaseActivityStore {
  async fn record(&self, _event: DatabaseActivityEvent) -> Result<(), DatabaseActivityError> {
    Ok(())
  }
  async fn list(
    &self,
    _filter: DatabaseActivityFilter,
    _skip: i64,
    _take: i64,
  ) -> Result<Vec<DatabaseActivityEntry>, DatabaseActivityError> {
    Ok(Vec::new())
  }
  async fn count(&self, _filter: DatabaseActivityFilter) -> Result<i64, DatabaseActivityError> {
    Ok(0)
  }
}

impl DatabaseActivityRecorder {
  /// Construct a recorder backed by a no-op store.
  pub fn noop() -> Self {
    Self::new(Arc::new(NoopDatabaseActivityStore))
  }
}

// ─── In-memory store for unit tests ──────────────────────────────────────────

/// A simple in-memory store useful for unit tests that exercise the
/// facade. Not intended for production.
#[derive(Default)]
pub struct InMemoryDatabaseActivityStore {
  rows: Mutex<Vec<DatabaseActivityEntry>>,
}

impl InMemoryDatabaseActivityStore {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn snapshot(&self) -> Vec<DatabaseActivityEntry> {
    self.rows.lock().expect("activity lock").clone()
  }
}

#[async_trait::async_trait]
impl DatabaseActivityStore for InMemoryDatabaseActivityStore {
  async fn record(&self, event: DatabaseActivityEvent) -> Result<(), DatabaseActivityError> {
    let entry = DatabaseActivityEntry {
      id: uuid::Uuid::new_v4(),
      workspace_id: event.workspace_id,
      database_id: event.database_id,
      row_id: event.row_id,
      event_type: event.event_type,
      actor_user_id: event.actor_user_id,
      actor_display_name: None,
      payload: event.payload,
      created_at: chrono::Utc::now(),
    };
    self.rows.lock().expect("activity lock").push(entry);
    Ok(())
  }

  async fn list(
    &self,
    filter: DatabaseActivityFilter,
    skip: i64,
    take: i64,
  ) -> Result<Vec<DatabaseActivityEntry>, DatabaseActivityError> {
    let rows = self.rows.lock().expect("activity lock");
    let mut filtered: Vec<DatabaseActivityEntry> = rows
      .iter()
      .filter(|row| row.workspace_id == filter.workspace_id)
      .filter(|row| filter.database_id.is_none_or(|id| row.database_id == id))
      .filter(|row| filter.row_id.is_none_or(|id| row.row_id == Some(id)))
      .filter(|row| filter.actor_user_id.is_none_or(|id| row.actor_user_id == Some(id)))
      .filter(|row| filter.event_types.is_empty() || filter.event_types.iter().any(|t| &row.event_type == t))
      .filter(|row| filter.from.is_none_or(|from| row.created_at >= from))
      .filter(|row| filter.to.is_none_or(|to| row.created_at <= to))
      .cloned()
      .collect();
    filtered.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    let start = skip.max(0) as usize;
    if start >= filtered.len() {
      return Ok(Vec::new());
    }
    let end = (start + take.max(1) as usize).min(filtered.len());
    Ok(filtered[start..end].to_vec())
  }

  async fn count(&self, filter: DatabaseActivityFilter) -> Result<i64, DatabaseActivityError> {
    let rows = self.rows.lock().expect("activity lock");
    let count = rows
      .iter()
      .filter(|row| row.workspace_id == filter.workspace_id)
      .filter(|row| filter.database_id.is_none_or(|id| row.database_id == id))
      .filter(|row| filter.row_id.is_none_or(|id| row.row_id == Some(id)))
      .filter(|row| filter.actor_user_id.is_none_or(|id| row.actor_user_id == Some(id)))
      .filter(|row| filter.event_types.is_empty() || filter.event_types.iter().any(|t| &row.event_type == t))
      .filter(|row| filter.from.is_none_or(|from| row.created_at >= from))
      .filter(|row| filter.to.is_none_or(|to| row.created_at <= to))
      .count() as i64;
    Ok(count)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_domain::database_activity::DatabaseActivityEventType;
  use uuid::Uuid;

  #[tokio::test]
  async fn recorder_persists_and_lists_events() {
    let store = Arc::new(InMemoryDatabaseActivityStore::new());
    let recorder = DatabaseActivityRecorder::new(store.clone());

    let workspace_id = Uuid::new_v4();
    let database_id = Uuid::new_v4();
    let row_id = Uuid::new_v4();
    let actor = Uuid::new_v4();

    recorder
      .record(
        DatabaseActivityEvent::new(workspace_id, database_id, DatabaseActivityEventType::RowCreated)
          .with_row(row_id)
          .with_actor(actor),
      )
      .await;

    let entries = recorder
      .list(
        DatabaseActivityFilter {
          workspace_id,
          database_id: Some(database_id),
          ..Default::default()
        },
        0,
        10,
      )
      .await
      .expect("list");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].event_type, DatabaseActivityEventType::RowCreated);
    assert_eq!(entries[0].row_id, Some(row_id));
    assert_eq!(entries[0].actor_user_id, Some(actor));
  }

  #[tokio::test]
  async fn noop_recorder_swallows_errors() {
    let recorder = DatabaseActivityRecorder::noop();
    recorder
      .record(DatabaseActivityEvent::new(
        Uuid::new_v4(),
        Uuid::new_v4(),
        DatabaseActivityEventType::RowUpdated,
      ))
      .await;
    let count = recorder
      .count(DatabaseActivityFilter {
        workspace_id: Uuid::new_v4(),
        ..Default::default()
      })
      .await
      .expect("count");
    assert_eq!(count, 0);
  }

  #[tokio::test]
  async fn in_memory_recorder_filters_by_event_type_and_actor() {
    let store = Arc::new(InMemoryDatabaseActivityStore::new());
    let recorder = DatabaseActivityRecorder::new(store.clone());

    let workspace_id = Uuid::new_v4();
    let database_id = Uuid::new_v4();
    let row_a = Uuid::new_v4();
    let row_b = Uuid::new_v4();
    let actor_one = Uuid::new_v4();
    let actor_two = Uuid::new_v4();

    recorder
      .record(
        DatabaseActivityEvent::new(workspace_id, database_id, DatabaseActivityEventType::RowCreated)
          .with_row(row_a)
          .with_actor(actor_one),
      )
      .await;
    recorder
      .record(
        DatabaseActivityEvent::new(workspace_id, database_id, DatabaseActivityEventType::CellChanged)
          .with_row(row_a)
          .with_actor(actor_two),
      )
      .await;
    recorder
      .record(
        DatabaseActivityEvent::new(workspace_id, database_id, DatabaseActivityEventType::CellCleared)
          .with_row(row_b)
          .with_actor(actor_one),
      )
      .await;

    let created_only = recorder
      .list(
        DatabaseActivityFilter {
          workspace_id,
          event_types: vec![DatabaseActivityEventType::RowCreated],
          ..Default::default()
        },
        0,
        10,
      )
      .await
      .expect("list created");
    assert_eq!(created_only.len(), 1);
    assert_eq!(created_only[0].event_type, DatabaseActivityEventType::RowCreated);
    assert_eq!(created_only[0].actor_user_id, Some(actor_one));

    let by_actor = recorder
      .list(
        DatabaseActivityFilter {
          workspace_id,
          actor_user_id: Some(actor_one),
          ..Default::default()
        },
        0,
        10,
      )
      .await
      .expect("list by actor");
    assert_eq!(by_actor.len(), 2);
    let mut event_types: Vec<_> = by_actor.iter().map(|e| e.event_type).collect();
    event_types.sort_by_key(|t| t.as_str());
    assert_eq!(
      event_types,
      vec![
        DatabaseActivityEventType::CellCleared,
        DatabaseActivityEventType::RowCreated,
      ]
    );

    let row_a_events = recorder
      .list(
        DatabaseActivityFilter {
          workspace_id,
          row_id: Some(row_a),
          ..Default::default()
        },
        0,
        10,
      )
      .await
      .expect("list by row");
    assert_eq!(row_a_events.len(), 2);

    let total = recorder
      .count(DatabaseActivityFilter {
        workspace_id,
        ..Default::default()
      })
      .await
      .expect("count");
    assert_eq!(total, 3);
  }

  #[tokio::test]
  async fn in_memory_recorder_paginates_with_stable_ordering() {
    let store = Arc::new(InMemoryDatabaseActivityStore::new());
    let recorder = DatabaseActivityRecorder::new(store.clone());

    let workspace_id = Uuid::new_v4();
    let database_id = Uuid::new_v4();
    let row_id = Uuid::new_v4();
    for _ in 0..5 {
      recorder
        .record(
          DatabaseActivityEvent::new(workspace_id, database_id, DatabaseActivityEventType::CellChanged)
            .with_row(row_id),
        )
        .await;
    }
    let first_page = recorder
      .list(
        DatabaseActivityFilter {
          workspace_id,
          ..Default::default()
        },
        0,
        2,
      )
      .await
      .expect("first page");
    let second_page = recorder
      .list(
        DatabaseActivityFilter {
          workspace_id,
          ..Default::default()
        },
        2,
        2,
      )
      .await
      .expect("second page");
    assert_eq!(first_page.len(), 2);
    assert_eq!(second_page.len(), 2);
    // No overlap between consecutive pages.
    let first_ids: std::collections::HashSet<_> = first_page.iter().map(|e| e.id).collect();
    let second_ids: std::collections::HashSet<_> = second_page.iter().map(|e| e.id).collect();
    assert!(first_ids.is_disjoint(&second_ids));
  }
}
