// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only page projection audit and explicit, idempotent repair planning.

use std::{
  collections::{BTreeMap, BTreeSet},
  sync::Arc,
  time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
  auth::{AuthError, AuthResult},
  metrics::{MetricsCategory, MetricsService},
};

use super::{
  DocLoadCancellation, DocLoadService, DocStore,
  traits::{PageLifecycleAuditState, PageLifecycleRepairCommand, PageLifecycleRepairCommit, PageProjectionSqlRow},
};

const PAGE_LIFECYCLE_REPORT_FORMAT_PREFIX: &str = "d0c1d01b20260828";
const PAGE_PROJECTION_CURSOR_VERSION: u8 = 1;
const PAGE_PROJECTION_DEFAULT_LIMIT: u16 = 50;
const PAGE_PROJECTION_MAX_LIMIT: u16 = 200;
const PAGE_PROJECTION_LOAD_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageProjectionScanLane {
  Sql,
  Root,
  Leaf,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageProjectionCompleteness {
  Complete,
  Incomplete,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageProjectionFinding {
  pub external_doc_id: Option<String>,
  /// Only leaf-only orphan evidence has no workspace-local external key.
  pub internal_source_id: Option<Uuid>,
  pub drift_class: PageLifecycleDriftClass,
  pub repairable: bool,
  pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageProjectionPresenceEvidence {
  pub source_id: String,
  pub external_doc_id: Option<String>,
  /// Present only for a leaf-only orphan that has no external key.
  pub internal_source_id: Option<Uuid>,
  pub sql_present: bool,
  pub root_present: bool,
  pub leaf_present: bool,
  pub root_entry_count: usize,
  pub identity_conflict: bool,
  pub findings: Vec<PageProjectionFinding>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageProjectionScanResult {
  pub workspace_id: Uuid,
  pub items: Vec<PageProjectionPresenceEvidence>,
  pub next_cursor: Option<String>,
  pub observed_root_sequence: i64,
  pub completeness: PageProjectionCompleteness,
  /// Health is meaningful only for one complete bounded traversal.
  pub healthy: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageProjectionInspection {
  pub workspace_id: Uuid,
  pub external_doc_id: String,
  pub sql_present: bool,
  pub root_present: bool,
  pub leaf_present: bool,
  pub normalized_title: Option<String>,
  pub is_trashed: Option<bool>,
  pub findings: Vec<PageProjectionFinding>,
  pub fingerprint: String,
  #[serde(skip)]
  state: PageLifecycleAuditState,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageProjectionRepairResult {
  pub external_doc_id: String,
  pub fingerprint: String,
  pub mode: PageLifecycleRepairMode,
  pub changed: bool,
  pub findings: Vec<PageProjectionFinding>,
  pub commit: Option<PageLifecycleRepairCommit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PageProjectionCursor {
  version: u8,
  workspace_id: Uuid,
  lane: PageProjectionScanLane,
  last_key: Option<String>,
  observed_root_sequence: i64,
  findings_seen: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum PageLifecycleDriftClass {
  /// SQL metadata identifies a page absent from workspace-root `meta.pages`.
  MissingRootEntry,
  /// Workspace-root metadata identifies a page absent from `docs`.
  MissingSqlMetadata,
  /// A SQL or root page identity has no persisted leaf Yjs state.
  MissingLeaf,
  /// Available SQL, root, and leaf titles do not agree.
  TitleMismatch,
  /// SQL soft-delete state and workspace-root trash state do not agree.
  TrashMismatch,
  /// The observed identity cannot be linked safely across projections.
  Orphan,
}

impl PageLifecycleDriftClass {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::MissingRootEntry => "missing_root_entry",
      Self::MissingSqlMetadata => "missing_sql_metadata",
      Self::MissingLeaf => "missing_leaf",
      Self::TitleMismatch => "title_mismatch",
      Self::TrashMismatch => "trash_mismatch",
      Self::Orphan => "orphan",
    }
  }
}

/// One exact drift classification. Multiple findings may refer to one page.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageLifecycleAuditFinding {
  pub source_id: String,
  pub doc_id: Option<Uuid>,
  pub external_doc_id: Option<String>,
  pub drift_class: PageLifecycleDriftClass,
  pub repairable: bool,
  pub reason: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageLifecycleRepairMode {
  DryRun,
  Apply,
}

impl PageLifecycleRepairMode {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::DryRun => "dry_run",
      Self::Apply => "apply",
    }
  }
}

#[derive(Clone)]
pub struct PageLifecycleRepairService {
  store: Arc<dyn DocStore>,
  load: Arc<DocLoadService>,
  max_decoded_bytes: usize,
  metrics: Option<Arc<MetricsService>>,
}

impl PageLifecycleRepairService {
  pub fn new(store: Arc<dyn DocStore>) -> Self {
    Self::new_with_load(
      store.clone(),
      Arc::new(DocLoadService::new(store)),
      super::write::DEFAULT_EXTERNAL_UPDATE_MAX_BYTES,
    )
  }

  pub(crate) fn new_with_load(store: Arc<dyn DocStore>, load: Arc<DocLoadService>, max_decoded_bytes: usize) -> Self {
    Self {
      store,
      load,
      max_decoded_bytes,
      metrics: None,
    }
  }

  pub fn with_metrics_service(mut self, metrics: Arc<MetricsService>) -> Self {
    self.metrics = Some(metrics);
    self
  }

  /// Discover projection drift in bounded SQL, root-only and leaf-only lanes.
  pub async fn scan(
    &self,
    workspace_id: Uuid,
    cursor: Option<&str>,
    limit: Option<u16>,
    cancellation: DocLoadCancellation,
  ) -> AuthResult<PageProjectionScanResult> {
    let started = Instant::now();
    let limit = limit.unwrap_or(PAGE_PROJECTION_DEFAULT_LIMIT);
    if !(1..=PAGE_PROJECTION_MAX_LIMIT).contains(&limit) {
      return Err(AuthError::InvalidInput("MIX_PAGE_PROJECTION_LIMIT_INVALID".to_string()));
    }
    if cancellation.is_cancelled() {
      return Err(AuthError::DocSyncCancelled);
    }

    let sequence_before = self.store.page_projection_root_sequence(workspace_id).await?;
    let cursor = match cursor {
      Some(cursor) => decode_projection_cursor(cursor, workspace_id, sequence_before)?,
      None => PageProjectionCursor {
        version: PAGE_PROJECTION_CURSOR_VERSION,
        workspace_id,
        lane: PageProjectionScanLane::Sql,
        last_key: None,
        observed_root_sequence: sequence_before,
        findings_seen: false,
      },
    };
    let (root_payload, decoded_bytes) = self
      .load_bounded_payload(workspace_id, workspace_id, cancellation.clone())
      .await?;
    let root_pages = self.decode_root_pages(root_payload, cancellation.clone()).await?;
    let sequence_after = self.store.page_projection_root_sequence(workspace_id).await?;
    if sequence_before != sequence_after || cursor.observed_root_sequence != sequence_after {
      return Err(AuthError::InvalidInput("MIX_PAGE_PROJECTION_ROOT_CHANGED".to_string()));
    }
    let mut root_by_external_id = BTreeMap::<String, Vec<yjs::WorkspaceRootPage>>::new();
    for page in root_pages {
      root_by_external_id.entry(page.id.clone()).or_default().push(page);
    }

    let (items, next_lane, next_last_key) = match cursor.lane {
      PageProjectionScanLane::Sql => {
        let mut rows = self
          .store
          .scan_page_projection_sql(workspace_id, cursor.last_key.as_deref(), usize::from(limit) + 1)
          .await?;
        let has_more = rows.len() > usize::from(limit);
        rows.truncate(usize::from(limit));
        let doc_ids = rows.iter().map(|row| row.doc_id).collect::<Vec<_>>();
        let leaf_ids = self
          .store
          .page_projection_leaf_presence(workspace_id, &doc_ids)
          .await?
          .into_iter()
          .collect::<BTreeSet<_>>();
        let items = rows
          .iter()
          .map(|row| evidence_for_sql_row(row, root_by_external_id.get(&row.external_doc_id), &leaf_ids))
          .collect::<Vec<_>>();
        if has_more {
          (
            items,
            Some(PageProjectionScanLane::Sql),
            rows.last().map(|row| row.external_doc_id.clone()),
          )
        } else {
          (items, Some(PageProjectionScanLane::Root), None)
        }
      }
      PageProjectionScanLane::Root => {
        let candidates = root_by_external_id
          .iter()
          .filter(|(key, _)| cursor.last_key.as_ref().is_none_or(|last| *key > last))
          .take(usize::from(limit) + 1)
          .map(|(key, entries)| (key.clone(), entries.clone()))
          .collect::<Vec<_>>();
        let consumed = candidates.iter().take(usize::from(limit)).cloned().collect::<Vec<_>>();
        let external_ids = consumed.iter().map(|(key, _)| key.clone()).collect::<Vec<_>>();
        let sql_by_external = self
          .store
          .page_projection_sql_by_external_ids(workspace_id, &external_ids)
          .await?
          .into_iter()
          .map(|row| (row.external_doc_id.clone(), row))
          .collect::<BTreeMap<_, _>>();
        let orphan_doc_ids = consumed
          .iter()
          .filter(|(key, _)| !sql_by_external.contains_key(key))
          .filter_map(|(key, _)| Uuid::parse_str(key).ok())
          .collect::<Vec<_>>();
        let leaf_ids = self
          .store
          .page_projection_leaf_presence(workspace_id, &orphan_doc_ids)
          .await?
          .into_iter()
          .collect::<BTreeSet<_>>();
        let existing_ids = self
          .store
          .page_projection_existing_doc_ids(&orphan_doc_ids)
          .await?
          .into_iter()
          .collect::<BTreeSet<_>>();
        let items = consumed
          .iter()
          .filter(|(key, _)| !sql_by_external.contains_key(key))
          .map(|(key, entries)| evidence_for_root_only(key, entries, &leaf_ids, &existing_ids))
          .collect::<Vec<_>>();
        if candidates.len() > usize::from(limit) {
          (
            items,
            Some(PageProjectionScanLane::Root),
            consumed.last().map(|(key, _)| key.clone()),
          )
        } else {
          (items, Some(PageProjectionScanLane::Leaf), None)
        }
      }
      PageProjectionScanLane::Leaf => {
        let after_doc_id = cursor
          .last_key
          .as_deref()
          .map(Uuid::parse_str)
          .transpose()
          .map_err(|_| AuthError::InvalidInput("MIX_PAGE_PROJECTION_CURSOR_INVALID".to_string()))?;
        let mut candidates = self
          .store
          .scan_page_projection_leaf_ids(workspace_id, after_doc_id, usize::from(limit) + 1)
          .await?;
        let has_more = candidates.len() > usize::from(limit);
        candidates.truncate(usize::from(limit));
        let sql_ids = self
          .store
          .page_projection_sql_by_doc_ids(workspace_id, &candidates)
          .await?
          .into_iter()
          .map(|row| row.doc_id)
          .collect::<BTreeSet<_>>();
        let root_uuid_ids = root_by_external_id
          .keys()
          .filter_map(|key| Uuid::parse_str(key).ok())
          .collect::<BTreeSet<_>>();
        let orphan_ids = candidates
          .iter()
          .filter(|doc_id| !sql_ids.contains(doc_id) && !root_uuid_ids.contains(doc_id))
          .copied()
          .collect::<Vec<_>>();
        let existing_ids = self
          .store
          .page_projection_existing_doc_ids(&orphan_ids)
          .await?
          .into_iter()
          .collect::<BTreeSet<_>>();
        let items = orphan_ids
          .iter()
          .map(|doc_id| evidence_for_leaf_only(*doc_id, existing_ids.contains(doc_id)))
          .collect::<Vec<_>>();
        if has_more {
          (
            items,
            Some(PageProjectionScanLane::Leaf),
            candidates.last().map(Uuid::to_string),
          )
        } else {
          (items, None, None)
        }
      }
    };

    let findings_seen = cursor.findings_seen || items.iter().any(|item| !item.findings.is_empty());
    let next_cursor = next_lane
      .map(|lane| {
        encode_projection_cursor(&PageProjectionCursor {
          version: PAGE_PROJECTION_CURSOR_VERSION,
          workspace_id,
          lane,
          last_key: next_last_key,
          observed_root_sequence: sequence_after,
          findings_seen,
        })
      })
      .transpose()?;
    let completeness = if next_cursor.is_some() {
      PageProjectionCompleteness::Incomplete
    } else {
      PageProjectionCompleteness::Complete
    };
    let healthy = completeness == PageProjectionCompleteness::Complete && !findings_seen;
    tracing::info!(
      workspace_id = %workspace_id,
      lane = ?cursor.lane,
      rows = items.len(),
      decoded_bytes,
      duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64,
      outcome = if healthy { "healthy" } else if next_cursor.is_some() { "incomplete" } else { "findings" },
      "bounded page projection scan completed"
    );
    Ok(PageProjectionScanResult {
      workspace_id,
      items,
      next_cursor,
      observed_root_sequence: sequence_after,
      completeness,
      healthy,
    })
  }

  /// Inspect one exact workspace-local external key and at most one leaf.
  pub async fn inspect(
    &self,
    workspace_id: Uuid,
    external_doc_id: &str,
    cancellation: DocLoadCancellation,
  ) -> AuthResult<PageProjectionInspection> {
    let started = Instant::now();
    if external_doc_id.is_empty() {
      return Err(AuthError::InvalidInput(
        "MIX_PAGE_PROJECTION_EXTERNAL_ID_REQUIRED".to_string(),
      ));
    }
    if cancellation.is_cancelled() {
      return Err(AuthError::DocSyncCancelled);
    }
    let sequence_before = self.store.page_projection_root_sequence(workspace_id).await?;
    let (root_payload, mut decoded_bytes) = self
      .load_bounded_payload(workspace_id, workspace_id, cancellation.clone())
      .await?;
    let root_pages = self.decode_root_pages(root_payload, cancellation.clone()).await?;
    let sql = self
      .store
      .page_projection_sql_by_external_ids(workspace_id, &[external_doc_id.to_string()])
      .await?
      .into_iter()
      .next();
    let root_entries = root_pages
      .into_iter()
      .filter(|page| page.id == external_doc_id)
      .collect::<Vec<_>>();
    let root = (root_entries.len() == 1).then(|| &root_entries[0]);
    let doc_id = sql
      .as_ref()
      .map(|row| row.doc_id)
      .or_else(|| Uuid::parse_str(external_doc_id).ok());
    let existing_id_conflict = if sql.is_none() {
      match doc_id {
        Some(doc_id) => !self.store.page_projection_existing_doc_ids(&[doc_id]).await?.is_empty(),
        None => false,
      }
    } else {
      false
    };
    let leaf_exists = match doc_id {
      Some(doc_id) => !self
        .store
        .page_projection_leaf_presence(workspace_id, &[doc_id])
        .await?
        .is_empty(),
      None => false,
    };
    let leaf_title = if leaf_exists {
      let doc_id = doc_id.expect("leaf presence requires an internal identifier");
      let (leaf_payload, leaf_bytes) = self
        .load_bounded_payload(workspace_id, doc_id, cancellation.clone())
        .await?;
      decoded_bytes = decoded_bytes.saturating_add(leaf_bytes);
      self.decode_leaf_title(leaf_payload, cancellation.clone()).await?
    } else {
      None
    };
    let sequence_after = self.store.page_projection_root_sequence(workspace_id).await?;
    if sequence_before != sequence_after {
      return Err(AuthError::InvalidInput("MIX_PAGE_PROJECTION_ROOT_CHANGED".to_string()));
    }
    let state = PageLifecycleAuditState {
      source_id: sql
        .as_ref()
        .map(|row| row.doc_id.to_string())
        .unwrap_or_else(|| external_doc_id.to_string()),
      doc_id,
      external_doc_id: Some(external_doc_id.to_string()),
      identity_conflict: root_entries.len() > 1 || existing_id_conflict,
      sql_title: sql.as_ref().map(|row| row.title.clone()),
      sql_trashed: sql.as_ref().map(|row| row.is_trashed),
      root_title: root.and_then(|entry| entry.title.clone()),
      root_trashed: root.map(|entry| entry.is_trashed),
      leaf_exists,
      leaf_title,
    };
    let findings = projection_findings(&state, None);
    let fingerprint = exact_projection_fingerprint(workspace_id, external_doc_id, &state)?;
    let inspection = PageProjectionInspection {
      workspace_id,
      external_doc_id: external_doc_id.to_string(),
      sql_present: sql.is_some(),
      root_present: !root_entries.is_empty(),
      leaf_present: leaf_exists,
      normalized_title: authoritative_title(&state),
      is_trashed: state.root_trashed.or(state.sql_trashed),
      findings,
      fingerprint,
      state,
    };
    tracing::info!(
      workspace_id = %workspace_id,
      rows = 1,
      decoded_bytes,
      duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64,
      outcome = if inspection.findings.is_empty() { "consistent" } else { "findings" },
      "exact page projection inspection completed"
    );
    Ok(inspection)
  }

  /// Preview or apply exactly one fingerprinted external-key projection state.
  pub async fn repair_exact(
    &self,
    workspace_id: Uuid,
    external_doc_id: &str,
    actor_user_id: Uuid,
    fingerprint: &str,
    mode: PageLifecycleRepairMode,
    cancellation: DocLoadCancellation,
  ) -> AuthResult<PageProjectionRepairResult> {
    let inspection = self.inspect(workspace_id, external_doc_id, cancellation).await?;
    if inspection.fingerprint != fingerprint {
      if exact_projection_fingerprint_binds(fingerprint, workspace_id, external_doc_id)
        && inspection.findings.is_empty()
      {
        self.record_metrics(&[], mode, "unchanged");
        return Ok(PageProjectionRepairResult {
          external_doc_id: external_doc_id.to_string(),
          fingerprint: inspection.fingerprint,
          mode,
          changed: false,
          findings: Vec::new(),
          commit: None,
        });
      }
      return Err(AuthError::InvalidInput("MIX_PAGE_REPAIR_REPORT_STALE".to_string()));
    }
    if inspection.findings.is_empty() {
      self.record_metrics(&[], mode, "unchanged");
      return Ok(PageProjectionRepairResult {
        external_doc_id: external_doc_id.to_string(),
        fingerprint: inspection.fingerprint,
        mode,
        changed: false,
        findings: Vec::new(),
        commit: None,
      });
    }
    if !inspection.findings.iter().any(|finding| finding.repairable) {
      return Err(AuthError::InvalidInput(
        "MIX_PAGE_REPAIR_TARGET_NOT_REPAIRABLE".to_string(),
      ));
    }
    let command = build_repair_command(workspace_id, actor_user_id, &inspection.state)?;
    if mode == PageLifecycleRepairMode::DryRun {
      let lifecycle_findings = classify_state(&inspection.state);
      let refs = lifecycle_findings.iter().collect::<Vec<_>>();
      self.record_metrics(&refs, mode, "previewed");
      return Ok(PageProjectionRepairResult {
        external_doc_id: external_doc_id.to_string(),
        fingerprint: inspection.fingerprint,
        mode,
        changed: false,
        findings: inspection.findings,
        commit: None,
      });
    }
    let commit = self.store.commit_page_lifecycle_repair(command).await?;
    let lifecycle_findings = classify_state(&inspection.state);
    let refs = lifecycle_findings.iter().collect::<Vec<_>>();
    self.record_metrics(&refs, mode, if commit.changed { "repaired" } else { "unchanged" });
    Ok(PageProjectionRepairResult {
      external_doc_id: external_doc_id.to_string(),
      fingerprint: inspection.fingerprint,
      mode,
      changed: commit.changed,
      findings: inspection.findings,
      commit: Some(commit),
    })
  }

  async fn load_bounded_payload(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    cancellation: DocLoadCancellation,
  ) -> AuthResult<(Vec<u8>, usize)> {
    let load = self.load.load_diff_with_meta(
      Uuid::new_v4(),
      workspace_id,
      doc_id,
      None,
      self.max_decoded_bytes,
      cancellation.clone(),
    );
    let loaded = match tokio::time::timeout(PAGE_PROJECTION_LOAD_TIMEOUT, load).await {
      Ok(result) => result?,
      Err(_) => {
        cancellation.cancel();
        return Err(AuthError::Storage("MIX_PAGE_PROJECTION_LOAD_TIMEOUT".to_string()));
      }
    };
    Ok((loaded.missing, loaded.input_bytes))
  }

  async fn decode_root_pages(
    &self,
    payload: Vec<u8>,
    cancellation: DocLoadCancellation,
  ) -> AuthResult<Vec<yjs::WorkspaceRootPage>> {
    if cancellation.is_cancelled() {
      return Err(AuthError::DocSyncCancelled);
    }
    let permit = tokio::select! {
      _ = cancellation.cancelled() => return Err(AuthError::DocSyncCancelled),
      permit = self.load.decoder_semaphore.clone().acquire_owned() => {
        permit.map_err(|_| AuthError::YjsDecoderUnavailable)?
      }
    };
    let pages = tokio::task::spawn_blocking(move || {
      let _permit = permit;
      yjs::extract_workspace_root_metadata(&payload).map(|metadata| metadata.pages)
    })
    .await
    .map_err(|_| AuthError::YjsDecoderUnavailable)?
    .map_err(|_| AuthError::Storage("workspace root page metadata is invalid".to_string()))?;
    if cancellation.is_cancelled() {
      return Err(AuthError::DocSyncCancelled);
    }
    Ok(pages)
  }

  async fn decode_leaf_title(&self, payload: Vec<u8>, cancellation: DocLoadCancellation) -> AuthResult<Option<String>> {
    if cancellation.is_cancelled() {
      return Err(AuthError::DocSyncCancelled);
    }
    let permit = tokio::select! {
      _ = cancellation.cancelled() => return Err(AuthError::DocSyncCancelled),
      permit = self.load.decoder_semaphore.clone().acquire_owned() => {
        permit.map_err(|_| AuthError::YjsDecoderUnavailable)?
      }
    };
    let title = tokio::task::spawn_blocking(move || {
      let _permit = permit;
      yjs::page_registration::extract_page_title(&payload)
    })
    .await
    .map_err(|_| AuthError::YjsDecoderUnavailable)?
    .map_err(|_| AuthError::Storage("persisted page leaf state is invalid".to_string()))?
    .map(|title| title.trim().to_string());
    if cancellation.is_cancelled() {
      return Err(AuthError::DocSyncCancelled);
    }
    Ok(title)
  }

  fn record_metrics(
    &self,
    findings: &[&PageLifecycleAuditFinding],
    mode: PageLifecycleRepairMode,
    outcome: &'static str,
  ) {
    let Some(metrics) = &self.metrics else {
      return;
    };
    if findings.is_empty() {
      metrics.record(
        MetricsCategory::Collab,
        "page_lifecycle_repair_total",
        &[("drift_class", "none"), ("mode", mode.as_str()), ("outcome", outcome)],
      );
      return;
    }
    for finding in findings {
      metrics.record(
        MetricsCategory::Collab,
        "page_lifecycle_repair_total",
        &[
          ("drift_class", finding.drift_class.as_str()),
          ("mode", mode.as_str()),
          ("outcome", outcome),
        ],
      );
    }
  }
}

fn encode_projection_cursor(cursor: &PageProjectionCursor) -> AuthResult<String> {
  serde_json::to_vec(cursor)
    .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
    .map_err(|_| AuthError::Storage("page projection cursor serialization failed".to_string()))
}

fn exact_projection_binding(workspace_id: Uuid, external_doc_id: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(workspace_id.as_bytes());
  hasher.update([0]);
  hasher.update(external_doc_id.as_bytes());
  hex::encode(&hasher.finalize()[..8])
}

fn exact_projection_fingerprint(
  workspace_id: Uuid,
  external_doc_id: &str,
  state: &PageLifecycleAuditState,
) -> AuthResult<String> {
  Ok(format!(
    "{}.{}",
    report_fingerprint(workspace_id, std::slice::from_ref(state))?,
    exact_projection_binding(workspace_id, external_doc_id)
  ))
}

fn exact_projection_fingerprint_binds(fingerprint: &str, workspace_id: Uuid, external_doc_id: &str) -> bool {
  fingerprint.split_once('.').is_some_and(|(state, binding)| {
    state.starts_with(PAGE_LIFECYCLE_REPORT_FORMAT_PREFIX)
      && binding == exact_projection_binding(workspace_id, external_doc_id)
  })
}

fn decode_projection_cursor(
  cursor: &str,
  workspace_id: Uuid,
  observed_root_sequence: i64,
) -> AuthResult<PageProjectionCursor> {
  let decoded = URL_SAFE_NO_PAD
    .decode(cursor)
    .ok()
    .and_then(|bytes| serde_json::from_slice::<PageProjectionCursor>(&bytes).ok())
    .filter(|cursor| {
      cursor.version == PAGE_PROJECTION_CURSOR_VERSION
        && cursor.workspace_id == workspace_id
        && cursor.observed_root_sequence == observed_root_sequence
    })
    .ok_or_else(|| AuthError::InvalidInput("MIX_PAGE_PROJECTION_CURSOR_INVALID".to_string()))?;
  Ok(decoded)
}

fn evidence_from_state(
  state: PageLifecycleAuditState,
  root_entry_count: usize,
  internal_source_id: Option<Uuid>,
) -> PageProjectionPresenceEvidence {
  let source_id = state.external_doc_id.clone().unwrap_or_else(|| state.source_id.clone());
  let findings = projection_findings(&state, internal_source_id);
  PageProjectionPresenceEvidence {
    source_id,
    external_doc_id: state.external_doc_id.clone(),
    internal_source_id,
    sql_present: state.sql_title.is_some(),
    root_present: root_entry_count > 0,
    leaf_present: state.leaf_exists,
    root_entry_count,
    identity_conflict: state.identity_conflict,
    findings,
  }
}

fn projection_findings(
  state: &PageLifecycleAuditState,
  internal_source_id: Option<Uuid>,
) -> Vec<PageProjectionFinding> {
  classify_state(state)
    .into_iter()
    .map(|finding| PageProjectionFinding {
      external_doc_id: state.external_doc_id.clone(),
      internal_source_id,
      drift_class: finding.drift_class,
      repairable: finding.repairable,
      reason: finding.reason,
    })
    .collect()
}

fn evidence_for_sql_row(
  row: &PageProjectionSqlRow,
  root_entries: Option<&Vec<yjs::WorkspaceRootPage>>,
  leaf_ids: &BTreeSet<Uuid>,
) -> PageProjectionPresenceEvidence {
  let root_entries = root_entries.map(Vec::as_slice).unwrap_or_default();
  let root = (root_entries.len() == 1).then(|| &root_entries[0]);
  evidence_from_state(
    PageLifecycleAuditState {
      source_id: row.doc_id.to_string(),
      doc_id: Some(row.doc_id),
      external_doc_id: Some(row.external_doc_id.clone()),
      identity_conflict: root_entries.len() > 1,
      sql_title: Some(row.title.clone()),
      sql_trashed: Some(row.is_trashed),
      root_title: root.and_then(|entry| entry.title.clone()),
      root_trashed: root.map(|entry| entry.is_trashed),
      leaf_exists: leaf_ids.contains(&row.doc_id),
      leaf_title: None,
    },
    root_entries.len(),
    None,
  )
}

fn evidence_for_root_only(
  external_doc_id: &str,
  root_entries: &[yjs::WorkspaceRootPage],
  leaf_ids: &BTreeSet<Uuid>,
  existing_ids: &BTreeSet<Uuid>,
) -> PageProjectionPresenceEvidence {
  let doc_id = Uuid::parse_str(external_doc_id).ok();
  let root = (root_entries.len() == 1).then(|| &root_entries[0]);
  evidence_from_state(
    PageLifecycleAuditState {
      source_id: external_doc_id.to_string(),
      doc_id,
      external_doc_id: Some(external_doc_id.to_string()),
      identity_conflict: root_entries.len() > 1 || doc_id.is_some_and(|id| existing_ids.contains(&id)),
      sql_title: None,
      sql_trashed: None,
      root_title: root.and_then(|entry| entry.title.clone()),
      root_trashed: root.map(|entry| entry.is_trashed),
      leaf_exists: doc_id.is_some_and(|id| leaf_ids.contains(&id)),
      leaf_title: None,
    },
    root_entries.len(),
    None,
  )
}

fn evidence_for_leaf_only(doc_id: Uuid, identity_conflict: bool) -> PageProjectionPresenceEvidence {
  evidence_from_state(
    PageLifecycleAuditState {
      source_id: doc_id.to_string(),
      doc_id: Some(doc_id),
      external_doc_id: None,
      identity_conflict,
      sql_title: None,
      sql_trashed: None,
      root_title: None,
      root_trashed: None,
      leaf_exists: true,
      leaf_title: None,
    },
    0,
    Some(doc_id),
  )
}

fn classify_state(state: &PageLifecycleAuditState) -> Vec<PageLifecycleAuditFinding> {
  let mut findings = Vec::new();
  let mut add = |drift_class, repairable, reason: &str| {
    findings.push(PageLifecycleAuditFinding {
      source_id: state.source_id.clone(),
      doc_id: state.doc_id,
      external_doc_id: state.external_doc_id.clone(),
      drift_class,
      repairable,
      reason: reason.to_string(),
    });
  };
  if state.identity_conflict {
    add(
      PageLifecycleDriftClass::Orphan,
      false,
      "identity has duplicate or non-bijective root observations",
    );
    return findings;
  }
  if state.doc_id.is_none() || (state.leaf_exists && state.sql_title.is_none() && state.root_trashed.is_none()) {
    add(
      PageLifecycleDriftClass::Orphan,
      false,
      "identity cannot be linked to both SQL and root projections",
    );
    return findings;
  }
  if state.sql_title.is_some() && state.root_trashed.is_none() {
    add(
      PageLifecycleDriftClass::MissingRootEntry,
      true,
      "SQL page has no workspace-root entry",
    );
  }
  if state.root_trashed.is_some() && state.sql_title.is_none() {
    add(
      PageLifecycleDriftClass::MissingSqlMetadata,
      true,
      "workspace-root page has no SQL metadata",
    );
  }
  if (state.sql_title.is_some() || state.root_trashed.is_some()) && !state.leaf_exists {
    add(
      PageLifecycleDriftClass::MissingLeaf,
      true,
      "page identity has no leaf document state",
    );
  }
  let titles = [&state.sql_title, &state.root_title, &state.leaf_title]
    .into_iter()
    .filter_map(|title| title.as_deref())
    .filter(|title| !title.trim().is_empty())
    .collect::<BTreeSet<_>>();
  if titles.len() > 1 {
    add(
      PageLifecycleDriftClass::TitleMismatch,
      authoritative_title(state).is_some(),
      "SQL, root and leaf titles do not agree",
    );
  }
  if state
    .sql_trashed
    .zip(state.root_trashed)
    .is_some_and(|(sql, root)| sql != root)
  {
    add(
      PageLifecycleDriftClass::TrashMismatch,
      true,
      "SQL and root trash state do not agree",
    );
  }
  findings
}

fn authoritative_title(state: &PageLifecycleAuditState) -> Option<String> {
  if state.leaf_title.as_deref().is_some_and(|title| title.trim().is_empty()) {
    return [&state.sql_title, &state.root_title]
      .into_iter()
      .flatten()
      .all(|title| title.trim().is_empty())
      .then(String::new);
  }
  if let Some(leaf_title) = state
    .leaf_title
    .as_deref()
    .map(str::trim)
    .filter(|title| !title.is_empty())
  {
    return Some(leaf_title.to_string());
  }
  let titles = [&state.sql_title, &state.root_title]
    .into_iter()
    .filter_map(|title| title.as_deref())
    .map(str::trim)
    .filter(|title| !title.is_empty())
    .collect::<Vec<_>>();
  if titles.len() == 2 && titles[0] != titles[1] {
    return None;
  }
  titles.first().map(|title| (*title).to_string())
}

fn build_repair_command(
  workspace_id: Uuid,
  actor_user_id: Uuid,
  state: &PageLifecycleAuditState,
) -> AuthResult<PageLifecycleRepairCommand> {
  if state.leaf_exists && state.leaf_title.is_none() {
    return Err(AuthError::InvalidInput("MIX_PAGE_REPAIR_TITLE_AMBIGUOUS".to_string()));
  }
  let doc_id = state
    .doc_id
    .ok_or_else(|| AuthError::InvalidInput("MIX_PAGE_REPAIR_ORPHAN_AMBIGUOUS".to_string()))?;
  let title =
    authoritative_title(state).ok_or_else(|| AuthError::InvalidInput("MIX_PAGE_REPAIR_TITLE_AMBIGUOUS".to_string()))?;
  let is_trashed = state.root_trashed.or(state.sql_trashed).unwrap_or(false);
  Ok(PageLifecycleRepairCommand {
    workspace_id,
    doc_id,
    external_doc_id: state
      .external_doc_id
      .clone()
      .ok_or_else(|| AuthError::InvalidInput("MIX_PAGE_REPAIR_EXTERNAL_ID_REQUIRED".to_string()))?,
    actor_user_id,
    title,
    is_trashed,
    ensure_sql_metadata: state.sql_title.is_none(),
    ensure_leaf: !state.leaf_exists,
    ensure_root_entry: state.root_trashed.is_none(),
    expected_state: state.clone(),
  })
}

fn report_fingerprint(workspace_id: Uuid, states: &[PageLifecycleAuditState]) -> AuthResult<String> {
  let bytes = serde_json::to_vec(&(workspace_id, states))
    .map_err(|_| AuthError::Storage("page lifecycle report serialization failed".to_string()))?;
  let digest = hex::encode(Sha256::digest(bytes));
  Ok(format!(
    "{PAGE_LIFECYCLE_REPORT_FORMAT_PREFIX}{}",
    &digest[PAGE_LIFECYCLE_REPORT_FORMAT_PREFIX.len()..]
  ))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn state() -> PageLifecycleAuditState {
    PageLifecycleAuditState {
      source_id: Uuid::nil().to_string(),
      doc_id: Some(Uuid::nil()),
      external_doc_id: Some(Uuid::nil().to_string()),
      identity_conflict: false,
      sql_title: Some("Canonical".to_string()),
      sql_trashed: Some(false),
      root_title: Some("Canonical".to_string()),
      root_trashed: Some(false),
      leaf_exists: true,
      leaf_title: Some("Canonical".to_string()),
    }
  }

  #[test]
  fn audit_classifies_every_contract_drift_without_guessing_ambiguous_titles() {
    let mut missing_root = state();
    missing_root.root_title = None;
    missing_root.root_trashed = None;
    assert!(
      classify_state(&missing_root)
        .iter()
        .any(|finding| { finding.drift_class == PageLifecycleDriftClass::MissingRootEntry && finding.repairable })
    );

    let mut missing_sql = state();
    missing_sql.sql_title = None;
    missing_sql.sql_trashed = None;
    assert!(
      classify_state(&missing_sql)
        .iter()
        .any(|finding| { finding.drift_class == PageLifecycleDriftClass::MissingSqlMetadata && finding.repairable })
    );

    let mut missing_leaf = state();
    missing_leaf.leaf_exists = false;
    missing_leaf.leaf_title = None;
    assert!(
      classify_state(&missing_leaf)
        .iter()
        .any(|finding| { finding.drift_class == PageLifecycleDriftClass::MissingLeaf && finding.repairable })
    );

    let mut leaf_authoritative = state();
    leaf_authoritative.sql_title = Some("SQL".to_string());
    leaf_authoritative.root_title = Some("Root".to_string());
    leaf_authoritative.leaf_title = Some("Leaf".to_string());
    assert!(
      classify_state(&leaf_authoritative)
        .iter()
        .any(|finding| { finding.drift_class == PageLifecycleDriftClass::TitleMismatch && finding.repairable })
    );
    assert_eq!(authoritative_title(&leaf_authoritative).as_deref(), Some("Leaf"));

    let mut ambiguous = state();
    ambiguous.sql_title = Some("SQL".to_string());
    ambiguous.root_title = Some("Root".to_string());
    ambiguous.leaf_exists = false;
    ambiguous.leaf_title = None;
    assert!(
      classify_state(&ambiguous)
        .iter()
        .any(|finding| { finding.drift_class == PageLifecycleDriftClass::TitleMismatch && !finding.repairable })
    );

    let mut trash = state();
    trash.sql_trashed = Some(true);
    assert!(
      classify_state(&trash)
        .iter()
        .any(|finding| { finding.drift_class == PageLifecycleDriftClass::TrashMismatch && finding.repairable })
    );

    let mut orphan = state();
    orphan.source_id = "invalid-root-id".to_string();
    orphan.doc_id = None;
    orphan.sql_title = None;
    orphan.sql_trashed = None;
    orphan.leaf_exists = false;
    orphan.leaf_title = None;
    assert_eq!(classify_state(&orphan)[0].drift_class, PageLifecycleDriftClass::Orphan);
    assert!(!classify_state(&orphan)[0].repairable);

    let mut cross_workspace = state();
    cross_workspace.identity_conflict = true;
    assert_eq!(
      classify_state(&cross_workspace)[0].drift_class,
      PageLifecycleDriftClass::Orphan
    );
    assert!(!classify_state(&cross_workspace)[0].repairable);

    let mut untitled = state();
    untitled.sql_title = Some(String::new());
    untitled.leaf_title = Some(String::new());
    untitled.root_title = None;
    untitled.root_trashed = None;
    let command = build_repair_command(Uuid::nil(), Uuid::nil(), &untitled).unwrap();
    assert_eq!(command.title, "");
    assert!(command.ensure_root_entry);
    assert!(!command.ensure_leaf);
    untitled.sql_title = Some("Conflicting title".to_string());
    assert!(build_repair_command(Uuid::nil(), Uuid::nil(), &untitled).is_err());
    untitled.leaf_title = None;
    assert!(build_repair_command(Uuid::nil(), Uuid::nil(), &untitled).is_err());
  }

  #[test]
  fn p01b_report_fingerprint_is_versioned_and_binds_external_identity() {
    let original = state();
    let original_id = report_fingerprint(Uuid::nil(), std::slice::from_ref(&original)).unwrap();
    assert_eq!(original_id.len(), 64);
    assert!(original_id.starts_with(PAGE_LIFECYCLE_REPORT_FORMAT_PREFIX));

    let mut changed = original;
    changed.external_doc_id = Some("different-external-key".to_string());
    let changed_id = report_fingerprint(Uuid::nil(), &[changed]).unwrap();
    assert_ne!(changed_id, original_id);
  }

  #[test]
  fn exact_projection_fingerprint_cannot_replay_against_another_external_key() {
    let workspace_id = Uuid::new_v4();
    let fingerprint = exact_projection_fingerprint(workspace_id, "external-a", &state()).unwrap();
    assert!(exact_projection_fingerprint_binds(
      &fingerprint,
      workspace_id,
      "external-a"
    ));
    assert!(!exact_projection_fingerprint_binds(
      &fingerprint,
      workspace_id,
      "external-b"
    ));
    assert!(!exact_projection_fingerprint_binds(
      &fingerprint,
      Uuid::new_v4(),
      "external-a"
    ));
  }
}
