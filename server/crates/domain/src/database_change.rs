// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Database change event contract (P-DB-29B-C).
//
// These types are the cross-layer contract used to broadcast server-side
// Database mutations to subscribed WebSocket clients.
//
// The shape is deliberately small and serializable so it can be:
//   - emitted from the application layer through the
//     `DatabaseChangeNotificationPort`;
//   - delivered to clients via the `database:change` Socket.IO event.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ids::{DatabaseFieldId, DatabaseRowId, DatabaseViewId, WorkspaceId};

/// Database identifier alias (UUID). Kept inline so this module stays in
/// `domain` without forcing a new ids import.
pub type DatabaseId = Uuid;

/// The kind of mutation a [`DatabaseChangeEvent`] represents.
///
/// Each kind maps to a dedicated server code path that re-emits a
/// `database:change` event after the underlying transaction commits.
/// Failed transactions MUST NOT emit `database:change` (see
/// `DatabaseChangeNotificationPort`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseChangeKind {
  /// A database was created.
  DatabaseCreated,
  /// A database's metadata (title, description) was updated.
  DatabaseUpdated,
  /// A database was moved to the recoverable workspace trash.
  DatabaseTrashed,
  /// A database was restored from the workspace trash.
  DatabaseRestored,
  /// A trashed database was permanently deleted.
  DatabaseDeleted,
  /// A row was created (single-row bulk insert counts as one row).
  RowCreated,
  /// A row's title or other row-scoped attribute was updated.
  RowUpdated,
  /// A row was soft-deleted (archive) — recoverable via `RowRestored`.
  RowDeleted,
  /// A row was restored from soft-delete.
  RowRestored,
  /// A row's position was changed within a view / group.
  RowMoved,
  /// A cell value was set or cleared.
  CellUpdated,
  /// A field was created.
  FieldCreated,
  /// A field's metadata (label, type, config) was updated.
  FieldUpdated,
  /// A field was deleted.
  FieldDeleted,
  /// A field was reordered inside a view.
  FieldReordered,
  /// A view was created.
  ViewCreated,
  /// A view's metadata was updated.
  ViewUpdated,
  /// The database's complete view order changed.
  ViewReordered,
  /// A view was deleted.
  ViewDeleted,
  /// A bulk import/export job mutated one or more rows.
  /// `actor_user_id` is the operator that initiated the job; per-row
  /// writes happen inside the worker and emit per-row change events
  /// through the same port.
  BulkImported,
  /// A bulk-export job completed. Useful for dashboards but never
  /// invalidates another open client's draft.
  BulkExported,
}

/// Optional row, field, and view context for a change event.
///
/// At least one of these is set for the vast majority of events; empty
/// contexts are reserved for database-scoped events such as
/// `BulkImported` / `BulkExported`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseChangeTarget {
  /// Row that the change touched, if any.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub row_id: Option<DatabaseRowId>,
  /// Field that the change touched, if any.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub field_id: Option<DatabaseFieldId>,
  /// View that the change touched, if any.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub view_id: Option<DatabaseViewId>,
}

/// Server-emitted change event.
///
/// Change events are idempotent invalidation hints, not record state or an
/// ordering source. Entity-level `edit_revision` values carried by GraphQL
/// projections own optimistic concurrency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseChangeEvent {
  /// Identifier of the workspace the database belongs to. Used both for
  /// authorisation on `database:join` and for room routing on the
  /// WebSocket layer.
  pub workspace_id: WorkspaceId,
  /// Identifier of the database the change happened against.
  pub database_id: DatabaseId,
  /// Kind of mutation this event represents.
  pub kind: DatabaseChangeKind,
  /// The initiating person; server-owned schema reconciliation has no person actor.
  pub actor_user_id: Option<Uuid>,
  /// Unique event identity used to deduplicate fanout retries.
  pub event_id: Uuid,
  /// Wall-clock time the server committed the change.
  pub committed_at: DateTime<Utc>,
  /// Optional row / field / view context.
  #[serde(default, skip_serializing_if = "DatabaseChangeTarget::is_empty")]
  pub target: DatabaseChangeTarget,
}

impl DatabaseChangeEvent {
  /// Convenience constructor that fills `committed_at` and an empty
  /// target.
  pub fn new(
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
    kind: DatabaseChangeKind,
    actor_user_id: Uuid,
  ) -> Self {
    Self {
      workspace_id,
      database_id,
      kind,
      actor_user_id: Some(actor_user_id),
      event_id: Uuid::new_v4(),
      committed_at: Utc::now(),
      target: DatabaseChangeTarget::default(),
    }
  }

  /// Actor-independent invalidation after a server-owned schema transaction.
  pub fn system(workspace_id: WorkspaceId, database_id: DatabaseId, kind: DatabaseChangeKind) -> Self {
    Self {
      workspace_id,
      database_id,
      kind,
      actor_user_id: None,
      event_id: Uuid::new_v4(),
      committed_at: Utc::now(),
      target: DatabaseChangeTarget::default(),
    }
  }

  /// Attach a row, field, and/or view target to a freshly built event.
  pub fn with_target(mut self, target: DatabaseChangeTarget) -> Self {
    self.target = target;
    self
  }
}

impl DatabaseChangeTarget {
  /// True when no row / field / view identifier is set.
  pub fn is_empty(&self) -> bool {
    self.row_id.is_none() && self.field_id.is_none() && self.view_id.is_none()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn empty_target_reports_empty() {
    let target = DatabaseChangeTarget::default();
    assert!(target.is_empty());
  }

  #[test]
  fn target_with_row_only_is_not_empty() {
    let target = DatabaseChangeTarget {
      row_id: Some(DatabaseRowId::new_v4()),
      field_id: None,
      view_id: None,
    };
    assert!(!target.is_empty());
  }

  #[test]
  fn event_serializes_kind_in_snake_case() {
    let event = DatabaseChangeEvent::new(
      WorkspaceId::new_v4(),
      DatabaseId::new_v4(),
      DatabaseChangeKind::CellUpdated,
      Uuid::new_v4(),
    );
    let json = serde_json::to_value(&event).expect("serialize");
    assert_eq!(json["kind"], "cell_updated");
    assert!(Uuid::parse_str(json["event_id"].as_str().expect("event id")).is_ok());
  }
}
