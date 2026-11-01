//! GraphQL contract for server-authoritative Databases.
//!
//! The API exposes typed field, view and cell envelopes instead of raw JSON
//! blobs. Serialization to JSON stays at the SQL repository boundary; GraphQL
//! mirrors the Rust domain contract so Web/Core codegen cannot drift into a
//! second schema truth.

mod assistance;
pub use assistance::*;
mod definition;
pub use definition::*;
mod editing;
pub use editing::*;
mod project;
pub use project::*;
mod views;
pub use views::*;
mod reminders;
pub use reminders::*;
mod import_export;
pub use import_export::*;
mod projections;
pub use projections::*;

use async_graphql::{
  ComplexObject, Context, Enum, Error, ErrorExtensions, ID, InputObject, Json, MaybeUndefined, OneofObject, Result,
  SimpleObject, Upload,
};
use chrono::{DateTime, NaiveDate, Utc};
use myoxus_application::database::{
  CreateDatabaseFromTemplate, CreateDatabaseProject, DatabaseLimits, DatabaseProjectOptionPreset, DatabaseServiceError,
  DatabaseServices, InitialDatabaseViewKind, LegacyDatabaseMigrationApplyResult, LegacyDatabaseMigrationPlan,
  editing::templates::{CreateDatabaseRowTemplate, UpdateDatabaseRowTemplate},
};
use myoxus_application::workspace_import::WorkspaceImportPolicyProvider;
use myoxus_domain::database as domain;
use myoxus_domain::database::{
  DatabaseBulkCellIntent, DatabaseBulkCellUpdate, DatabaseBulkOperationResult, DatabaseBulkPositionUpdate,
  DatabaseBulkRowOutcome, DatabaseBulkRowPatch, DatabaseProjectStructurePreset, DatabaseStarterTemplateCategory,
};
use myoxus_domain::ids::{DatabaseFieldId, DatabaseRowId, WorkspaceId};
use myoxus_domain::repositories::PageRequest;
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::str::FromStr;
use std::sync::Arc;
use tracing::warn;
use uuid::Uuid;

use crate::graphql::utils::{map_gql_error, require_session};
use crate::state::ApiState;
use myoxus_application::auth::AuthError;

fn service(state: &ApiState) -> Result<Arc<DatabaseServices>> {
  state
    .database_services()
    .ok_or_else(|| database_error("MIX_DATABASE_STORAGE", "database capabilities are not configured"))
}

fn page_request(first: Option<i32>, offset: Option<i32>, default_first: i64) -> PageRequest {
  let default = default_first.max(1);
  PageRequest {
    limit: first.map(|value| value.max(1) as i64).unwrap_or(default),
    offset: offset.unwrap_or(0).max(0) as i64,
  }
}

pub(crate) fn parse_uuid_id<T>(id: &ID, field: &'static str) -> Result<T>
where
  T: From<Uuid>,
{
  Uuid::parse_str(id.as_str())
    .map(T::from)
    .map_err(|_| database_error("MIX_DATABASE_FIELD_INVALID", format!("{field} must be a UUID")))
}

fn parse_id_vec(ids: Vec<ID>, field: &'static str) -> Result<Vec<Uuid>> {
  ids.iter().map(|id| parse_uuid_id(id, field)).collect()
}

fn read_csv_upload(ctx: &Context<'_>, upload: Upload, max_bytes: usize) -> Result<Vec<u8>> {
  let value = upload
    .value(ctx)
    .map_err(|error| database_error("MIX_DATABASE_CSV_INVALID", format!("invalid CSV upload: {error}")))?;
  let mut data = Vec::new();
  let mut limited = value.content.take(max_bytes.saturating_add(1) as u64);
  limited.read_to_end(&mut data).map_err(|error| {
    database_error(
      "MIX_DATABASE_CSV_INVALID",
      format!("failed to read CSV upload: {error}"),
    )
  })?;
  if data.is_empty() {
    return Err(database_error("MIX_DATABASE_CSV_INVALID", "CSV upload is empty"));
  }
  if data.len() > max_bytes {
    return Err(database_error(
      "MIX_DATABASE_CSV_TOO_LARGE",
      "CSV upload exceeds csv_max_bytes",
    ));
  }
  Ok(data)
}

fn read_json_upload(ctx: &Context<'_>, upload: Upload, max_bytes: usize) -> Result<Vec<u8>> {
  let value = upload
    .value(ctx)
    .map_err(|error| database_error("MIX_DATABASE_JSON_INVALID", format!("invalid JSON upload: {error}")))?;
  let mut data = Vec::new();
  let mut limited = value.content.take(max_bytes.saturating_add(1) as u64);
  limited.read_to_end(&mut data).map_err(|error| {
    database_error(
      "MIX_DATABASE_JSON_INVALID",
      format!("failed to read JSON upload: {error}"),
    )
  })?;
  if data.is_empty() {
    return Err(database_error("MIX_DATABASE_JSON_INVALID", "JSON upload is empty"));
  }
  if data.len() > max_bytes {
    return Err(database_error(
      "MIX_DATABASE_JSON_INVALID",
      "JSON upload exceeds database import size limit",
    ));
  }
  Ok(data)
}

fn database_error(code: &'static str, message: impl Into<String>) -> Error {
  Error::new(message.into()).extend_with(|_, e| {
    e.set("code", code);
    e.set("type", code);
    e.set("name", code);
  })
}

fn map_database_error(error: DatabaseServiceError) -> Error {
  let code = error.code;
  let message = error.message;
  let latest_state = error.latest_state;
  let task_relation_reason = error.task_relation_reason;
  let select_update = error.select_update;
  let mut err = Error::new(message).extend_with(|_, e| {
    e.set("code", code);
    e.set("type", code);
    e.set("name", code);
  });
  if let Some(reason) = task_relation_reason {
    err = err.extend_with(|_, e| e.set("reason", reason.as_str()));
  }
  if let Some(diagnostic) = select_update {
    err = err.extend_with(|_, e| {
      e.set(
        "reason",
        serde_json::to_value(diagnostic.reason)
          .expect("native reason serializes")
          .as_str()
          .expect("native reason is a string"),
      );
      e.set("path", diagnostic.path);
    });
  }
  // P-DB-29B-C: stale-write conflicts carry a `latestState` JSON blob
  // mirroring the entity's current server-side shape so the client can
  // render a conflict-resolution modal without a follow-up query.
  // `async_graphql::Value` has no `From<serde_json::Value>`, so we
  // round-trip through a string — clients parse it back. The exact
  // JSON shape is documented in the Optimistic Editing And Realtime
  // Collaboration section of `docs/dev/server/databases-data-model.md`.
  if let Some(state) = latest_state {
    let serialized = state.to_string();
    err = err.extend_with(|_, e| {
      e.set("latestState", serialized);
    });
  }
  err
}
