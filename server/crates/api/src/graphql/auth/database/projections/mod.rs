// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseRollupStaleState", rename_items = "PascalCase")]
pub enum DatabaseRollupStaleStateType {
  Current,
  Stale,
  Queued,
  Failed,
  RecomputePending,
}

impl From<domain::DatabaseRollupStaleState> for DatabaseRollupStaleStateType {
  fn from(value: domain::DatabaseRollupStaleState) -> Self {
    match value {
      domain::DatabaseRollupStaleState::Current => Self::Current,
      domain::DatabaseRollupStaleState::Stale => Self::Stale,
      domain::DatabaseRollupStaleState::Queued => Self::Queued,
      domain::DatabaseRollupStaleState::Failed => Self::Failed,
      domain::DatabaseRollupStaleState::RecomputePending => Self::RecomputePending,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseFormulaStaleState", rename_items = "PascalCase")]
pub enum DatabaseFormulaStaleStateType {
  Current,
  Stale,
  Queued,
  Failed,
  RecomputePending,
}

impl From<domain::DatabaseFormulaStaleState> for DatabaseFormulaStaleStateType {
  fn from(value: domain::DatabaseFormulaStaleState) -> Self {
    match value {
      domain::DatabaseFormulaStaleState::Current => Self::Current,
      domain::DatabaseFormulaStaleState::Stale => Self::Stale,
      domain::DatabaseFormulaStaleState::Queued => Self::Queued,
      domain::DatabaseFormulaStaleState::Failed => Self::Failed,
      domain::DatabaseFormulaStaleState::RecomputePending => Self::RecomputePending,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRollupValueType")]
pub struct DatabaseRollupValueObjectType {
  pub value: Option<DatabaseRollupScalarValueObjectType>,
  pub stale_state: DatabaseRollupStaleStateType,
  pub computed_at: Option<DateTime<Utc>>,
  pub failed_at: Option<DateTime<Utc>>,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFormulaValueType")]
pub struct DatabaseFormulaValueObjectType {
  pub value: Option<DatabaseFormulaScalarValueObjectType>,
  pub stale_state: DatabaseFormulaStaleStateType,
  pub computed_at: Option<DateTime<Utc>>,
  pub failed_at: Option<DateTime<Utc>>,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
}

/// P-DB-25: full-text search across database rows in a workspace. The
/// search index is the `database_row_search` table introduced
/// in the canonical schema; ACL is enforced by the workspace membership lookup
/// inside the SQL filter.
#[derive(Debug, SimpleObject)]
#[graphql(name = "DatabaseSearchHit")]
pub struct DatabaseSearchHitObjectType {
  pub row_id: ID,
  pub database_id: ID,
  pub title: String,
  pub snippet: Option<String>,
  pub has_content_document: bool,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, InputObject)]
#[graphql(name = "DatabaseSearchFilterInput")]
pub struct DatabaseSearchFilterInput {
  pub database_id: Option<ID>,
  pub query: String,
  pub first: Option<i32>,
}

pub(crate) async fn database_search(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  filter: DatabaseSearchFilterInput,
) -> Result<Vec<DatabaseSearchHitObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let trimmed = filter.query.trim().to_string();
  if trimmed.is_empty() {
    return Ok(Vec::new());
  }
  // P-DB-25: enforce workspace membership before hitting the FTS
  // index. Non-members see zero hits and the response carries no
  // metadata about the workspace content.
  let role = state
    .permission_service()
    .get_effective_workspace_role(snapshot.user.id, workspace_id)
    .await
    .ok()
    .flatten();
  if role.is_none() {
    warn!(
      user_id = %snapshot.user.id,
      workspace_id = %workspace_id,
      "non-member tried to search database rows"
    );
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  let database_id = filter
    .database_id
    .as_ref()
    .map(|raw| parse_uuid_id::<Uuid>(raw, "databaseId"))
    .transpose()?;
  let first = filter.first.unwrap_or(100).clamp(1, 500) as i64;
  let search_filter = myoxus_domain::database::DatabaseSearchFilter {
    workspace_id,
    database_id,
    query: trimmed,
    first: Some(first),
    after: None,
  };
  let services = state
    .services
    .database_services
    .as_ref()
    .ok_or_else(|| Error::new("database capabilities unavailable"))?;
  let hits = services
    .projection
    .search_rows(search_filter)
    .await
    .map_err(|error| Error::new(format!("search failed: {error}")))?;
  Ok(
    hits
      .into_iter()
      .map(|hit| DatabaseSearchHitObjectType {
        row_id: ID::from(hit.row_id.to_string()),
        database_id: ID::from(hit.database_id.to_string()),
        title: hit.title,
        snippet: hit.snippet,
        has_content_document: hit.has_content_document,
        updated_at: hit.updated_at,
      })
      .collect(),
  )
}
