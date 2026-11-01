// SPDX-License-Identifier: AGPL-3.0-or-later
//! Derived persistence orchestration reads canonical sources through explicit ports.
pub(in crate::database) mod formula;
mod recompute;
mod search;

use self::formula::{analyze_formula, evaluate_formula};
use super::{
  DATABASE_QUEUE, DatabaseCapability, DatabaseJobEnqueuer, DatabaseLimits, DatabaseResult, DatabaseServiceError,
  ERR_FORMULA_DEPENDENCY_INVALID, ERR_FORMULA_EVAL_LIMIT_EXCEEDED, ERR_FORMULA_PARSE_FAILED,
  ERR_FORMULA_RECOMPUTE_FAILED, ERR_FORMULA_TYPE_INVALID, ERR_NOT_FOUND, ERR_ROLLUP_CONFIG_INVALID,
  ERR_ROLLUP_RECOMPUTE_FAILED, ERR_STORAGE, JOB_INDEX_ROW, JOB_REINDEX_SEARCH,
};
use crate::workspace_tags::WorkspaceTagService;
use chrono::NaiveDate;
use myoxus_domain::database::*;
use myoxus_domain::ids::*;
use myoxus_domain::repositories::{PageRequest, RepositoryError};
use myoxus_domain::workspace_tags::WorkspaceTagSearchProjection;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tracing::{debug, error, info, instrument, warn};
use uuid::Uuid;

#[derive(Clone)]
pub struct DatabaseProjectionService {
  schema_repo: Arc<dyn DatabaseDefinitionRepository>,
  row_repo: Arc<dyn DatabaseEditingRepository>,
  view_query_repo: Arc<dyn DatabaseViewRepository>,
  projection_repo: Arc<dyn DatabaseProjectionRepository>,
  limits: DatabaseLimits,
  pub(super) job_queue: DatabaseCapability<Arc<dyn DatabaseJobEnqueuer>>,
  pub(super) workspace_tags: DatabaseCapability<Arc<WorkspaceTagService>>,
}

#[derive(Debug, Clone, Default)]
pub struct DatabaseRollupRecomputeOutcome {
  pub requested_count: i64,
  pub recomputed_count: i64,
  pub failed_count: i64,
  pub skipped_count: i64,
}

#[derive(Debug, Clone, Default)]
pub struct DatabaseFormulaRecomputeOutcome {
  pub requested_count: i64,
  pub recomputed_count: i64,
  pub failed_count: i64,
  pub skipped_count: i64,
}

impl DatabaseProjectionService {
  /// Construct the existing projection owner for native callers. Optional queue
  /// and Tag adapters are attached by the normal service composition root.
  pub fn new(
    schema_repo: Arc<dyn DatabaseDefinitionRepository>,
    row_repo: Arc<dyn DatabaseEditingRepository>,
    view_query_repo: Arc<dyn DatabaseViewRepository>,
    projection_repo: Arc<dyn DatabaseProjectionRepository>,
    limits: DatabaseLimits,
  ) -> Self {
    Self {
      schema_repo,
      row_repo,
      view_query_repo,
      projection_repo,
      limits,
      job_queue: DatabaseCapability::Disabled,
      workspace_tags: DatabaseCapability::Disabled,
    }
  }
  /// Resolve Database-backed references for document search results while
  /// keeping projection persistence private to the application layer.
  pub async fn list_document_references_for_targets(
    &self,
    workspace_id: WorkspaceId,
    target_doc_ids: &[DocId],
    page: PageRequest,
  ) -> DatabaseResult<Vec<DatabaseDocumentReference>> {
    Ok(
      self
        .projection_repo
        .list_document_references_for_targets(workspace_id, target_doc_ids, page)
        .await?,
    )
  }
}
