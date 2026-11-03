// SPDX-License-Identifier: AGPL-3.0-or-later
//! Yjs CRDT utilities for the Myoxus server.
//!
//! This crate provides helpers for merging binary Yjs updates
//! ([`merge_updates`]), computing incremental diffs ([`get_missing_diff`]),
//! and encoding state vectors. It also re-exports the [`adapter`],
//! [`awareness`], and [`store`] sub-modules.
//!
//! The binary codec (`codec` module) is a clean reimplementation of the
//! Yjs v1 wire format with 21 documented deviations (see
//! `docs/dev/server/yjs-codec-reimplementation.md`).
//!
//! The [`markdown`] module owns pure conversion between Markdown and canonical
//! Virgultum Yjs documents. The root re-exports preserve the established crate
//! API without introducing a second implementation.
//!
//! ## Block ordering fallback (YJS-RV-03c)
//!
//! When the `affine:page` root block is present, blocks are rendered by
//! walking the tree from the root via `children` references — producing
//! semantically correct ordering. When no root is found (e.g. a partially
//! synced or non-standard document), the extractor falls back to rendering
//! all blocks in **lexicographic order of their block IDs**. This is
//! deterministic across runs but carries no semantic meaning.

use thiserror::Error;
use tracing::{debug, instrument, trace, warn};
use uuid::Uuid;
use yrs::types::text::{Diff, YChange};
use yrs::types::{AsPrelim, Attrs};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Any, Array, Doc, GetString, Map, ReadTxn, StateVector, Text, Transact, Update};

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

pub mod adapter;
pub mod annotation;
pub mod awareness;
pub mod codec;
pub mod document_mutation;
mod document_properties;
pub mod document_restore;
pub mod footnote;
pub mod markdown;
pub mod native_snapshot;
pub mod native_text;
pub use native_snapshot::document_to_snapshot;
pub mod order_key;
pub use document_restore::{DocumentRestoreError, restore_document_snapshot};
pub(crate) use markdown::extract_formatted_text;
pub use markdown::{
  MarkdownDiagnostic, MarkdownDiagnosticCode, MarkdownDocumentReference, MarkdownImportResult, MarkdownLinkResolution,
  MarkdownLinkTarget, MarkdownResolvedReference, YjsExtractResult, extract_text_from_yjs,
  extract_text_from_yjs_with_image_filter, extract_text_from_yjs_with_references,
  extract_text_from_yjs_with_references_and_images, markdown_to_yjs, markdown_to_yjs_with_link_resolver,
  markdown_to_yjs_with_references,
};
pub use page_registration::extract_page_title as extract_structural_document_title;
mod native_document_comparison;
mod native_template_repeat;
pub use native_document_comparison::native_documents_have_same_content;
pub mod page_registration;
pub mod store;

pub use document_mutation::{
  DOCUMENT_FRAGMENT_SCHEMA, DocumentBlockProperties, DocumentFragment, DocumentFragmentBlock, DocumentListKind,
  DocumentMutation, DocumentMutationError, DocumentMutationOutput, DocumentTableAppearance, DocumentTableAxis,
  DocumentTableAxisChange, DocumentTableCoordinateProperties, DocumentTableDensity, DocumentTableProperties,
  DocumentTextField, DocumentTextFormatting, DocumentTextLinkChange, DocumentTextRangeUnit, DocumentTextSegment,
  apply_document_mutation,
};

/// Redacted structural validation failure for an externally supplied Yjs v1
/// update. The decoder's internal detail can contain parser state and is not
/// part of an API response or log entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("invalid Yjs v1 update")]
pub struct YjsUpdateValidationError;

/// One bounded value supplied while instantiating a native document template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeTemplateVariable {
  String(String),
  StringList(Vec<String>),
  Records(Vec<HashMap<String, String>>),
}

/// Result of replacing template variables directly in canonical Yjs content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeTemplateInstantiation {
  pub snapshot: Vec<u8>,
  pub unresolved_variables: Vec<String>,
}

/// One occurrence in native source content. Offsets use editor/YText UTF-16 units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeTemplateDiagnostic {
  pub block_id: String,
  pub kind: String,
  pub row_id: Option<String>,
  pub column_id: Option<String>,
  pub start: usize,
  pub length: usize,
  pub name: Option<String>,
  /// `variable`, `invalid-syntax`, or `repeat-invalid`; capabilities belong to the caller.
  pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeTemplateInspection {
  /// Inventory only; diagnostics retain the actual occurrence and syntax evidence.
  pub required_variables: Vec<String>,
  pub diagnostics: Vec<NativeTemplateDiagnostic>,
}

/// Inspect the captured source without substitution, expansion or persistence.
#[instrument(skip_all)]
pub fn inspect_native_template(document_update: &[u8]) -> Result<NativeTemplateInspection, String> {
  native_template_references::inspect_native_template_references(document_update)?;
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(document_update).map_err(|_| "invalid native template snapshot")?)
      .map_err(|_| "invalid native template snapshot")?;
  }
  let mut required = BTreeSet::new();
  let (scoped, mut diagnostics) = native_template_repeat::inspect(&doc, &blocks, &mut required);
  let txn = doc.transact();
  for (block_id, value) in blocks.iter(&txn) {
    let yrs::Out::YMap(block) = value else {
      continue;
    };
    for (property, value) in block.iter(&txn) {
      let yrs::Out::YText(text) = value else {
        continue;
      };
      let cell = property
        .strip_prefix("prop:cells.")
        .and_then(|key| key.strip_suffix(".text"))
        .and_then(|key| key.split_once(':'));
      let kind = if matches!(property, "prop:title" | "title") {
        "title"
      } else if cell.is_some() {
        "cell"
      } else if matches!(property, "prop:text" | "text") {
        "text"
      } else {
        continue;
      };
      let text = text.get_string(&txn);
      for (start, end, name, valid) in native_template_tokens(&text) {
        // Keep the deployed caller-variable inventory separate from authoring
        // diagnostics. Unsupported native blocks retain literal text.
        let flavour = block_string(&block, &txn, "flavour")
          .map(|v| resolve_flavour(&v).to_owned())
          .unwrap_or_default();
        let substituted = matches!(
          (flavour.as_str(), kind),
          ("myoxus:page", "title") | ("myoxus:paragraph" | "myoxus:list", "text") | ("myoxus:table", "cell")
        );
        if valid && substituted && !name.starts_with("member.") {
          required.insert(name.to_string());
        }
        let valid = valid
          && name
            .split('.')
            .all(|part| part.chars().next().is_some_and(|c| c.is_ascii_alphabetic()))
          && !text[..start].ends_with('{')
          && !text[end..].starts_with('}');
        let repeat_invalid = name == "workspace.members"
          || (name.starts_with("member.")
            && (!scoped.contains(&(block_id.to_string(), property.to_string()))
              || !matches!(name, "member.name" | "member.email")));
        diagnostics.push(NativeTemplateDiagnostic {
          block_id: block_id.to_string(),
          kind: kind.into(),
          row_id: cell.map(|(row, _)| row.to_string()),
          column_id: cell.map(|(_, column)| column.to_string()),
          start: text[..start].encode_utf16().count(),
          length: text[start..end].encode_utf16().count(),
          name: valid.then(|| name.to_string()),
          reason: if !valid {
            "invalid-syntax"
          } else if repeat_invalid {
            "repeat-invalid"
          } else {
            "variable"
          }
          .into(),
        });
      }
    }
  }
  diagnostics.sort_by(|a, b| {
    (&a.block_id, &a.kind, &a.row_id, &a.column_id, a.start, &a.reason).cmp(&(
      &b.block_id,
      &b.kind,
      &b.row_id,
      &b.column_id,
      b.start,
      &b.reason,
    ))
  });
  Ok(NativeTemplateInspection {
    required_variables: required.into_iter().collect(),
    diagnostics,
  })
}

/// Failure while establishing the bounded decode-once worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum YjsGuardedDecodeError {
  #[error("invalid Yjs v1 update")]
  InvalidUpdate,
  #[error("Yjs decoder worker unavailable")]
  WorkerUnavailable,
}

/// One structurally valid Yjs-v1 update decoded at the external ingress edge.
///
/// Keeping the owned decoder result avoids parsing untrusted client bytes a
/// second time when persistence classifies replay and CRDT novelty. The inner
/// Yrs representation intentionally remains private so application and SQL
/// layers cannot grow a second CRDT implementation.
pub struct DecodedYjsUpdate(Update);

impl std::fmt::Debug for DecodedYjsUpdate {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter
      .debug_struct("DecodedYjsUpdate")
      .field("has_delete_set", &!self.0.delete_set().is_empty())
      .finish_non_exhaustive()
  }
}

/// Struct-clock relationship between one update and a server-derived state
/// vector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum YjsStructClockNovelty {
  /// Every inserted struct clock is already represented by the vector.
  None,
  /// The update extends every affected client contiguously. The returned
  /// vector is safe to persist atomically with the update.
  Contiguous(Vec<u8>),
  /// At least one inserted range starts after a missing clock. The update is
  /// still new and must be persisted, but the derived vector must remain null
  /// until bounded reconstruction integrates the missing dependency.
  Discontinuous,
}

impl DecodedYjsUpdate {
  /// Whether this update carries a Yjs delete set.
  pub fn has_delete_set(&self) -> bool {
    !self.0.delete_set().is_empty()
  }

  /// Classify inserted struct clocks against an encoded Yjs-v1 state vector.
  pub fn classify_struct_clocks(
    &self,
    encoded_state_vector: &[u8],
  ) -> Result<YjsStructClockNovelty, YjsDiffMaterializationError> {
    let state_vector =
      StateVector::decode_v1(encoded_state_vector).map_err(|_| YjsDiffMaterializationError::InvalidStateVector)?;
    Ok(classify_struct_clocks(&self.0, state_vector))
  }
}

/// Decode and retain a Yjs-v1 update for validation and persistence
/// classification.
pub fn decode_update_v1(update: &[u8]) -> Result<DecodedYjsUpdate, YjsUpdateValidationError> {
  Update::decode_v1(update)
    .map(DecodedYjsUpdate)
    .map_err(|_| YjsUpdateValidationError)
}

/// Send-safe handle to one decoded update retained by a bounded blocking
/// worker. Yrs updates are intentionally not `Send`; this handle preserves the
/// decode-once invariant without unsafe trait implementations.
pub struct ValidatedYjsUpdate {
  command: std::sync::mpsc::SyncSender<ValidatedYjsUpdateCommand>,
}

impl std::fmt::Debug for ValidatedYjsUpdate {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.debug_struct("ValidatedYjsUpdate").finish_non_exhaustive()
  }
}

enum ValidatedYjsUpdateCommand {
  Classify {
    current_state_vector: Option<Vec<u8>>,
    registration: page_registration::PageRegistrationRequest,
    max_input_bytes: usize,
    updates: tokio::sync::mpsc::Receiver<Vec<u8>>,
    plan: tokio::sync::oneshot::Sender<Result<YjsCandidatePlan, YjsDiffMaterializationError>>,
    materialized: tokio::sync::oneshot::Sender<Result<ClassifiedYjsCandidate, YjsDiffMaterializationError>>,
  },
}

/// Final persistence facts produced by the single decoder worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedYjsCandidate {
  pub state_vector: Option<Vec<u8>>,
  pub is_crdt_noop: bool,
  pub registration: page_registration::PageRegistrationProjection,
}

/// First classification step. The repository streams persisted state only for
/// the materialization variant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum YjsCandidatePlan {
  Complete(ClassifiedYjsCandidate),
  Materialize,
}

/// One-use bridge between the async repository cursor and the decoder worker.
pub struct YjsCandidateSession {
  sender: tokio::sync::mpsc::Sender<Vec<u8>>,
  plan: tokio::sync::oneshot::Receiver<Result<YjsCandidatePlan, YjsDiffMaterializationError>>,
  materialized: tokio::sync::oneshot::Receiver<Result<ClassifiedYjsCandidate, YjsDiffMaterializationError>>,
}

impl YjsCandidateSession {
  pub async fn send_update(&self, update: Vec<u8>) -> Result<(), YjsDiffMaterializationError> {
    self
      .sender
      .send(update)
      .await
      .map_err(|_| YjsDiffMaterializationError::WorkerUnavailable)
  }

  pub async fn plan(&mut self) -> Result<YjsCandidatePlan, YjsDiffMaterializationError> {
    (&mut self.plan)
      .await
      .unwrap_or(Err(YjsDiffMaterializationError::WorkerUnavailable))
  }

  pub async fn finish(self) -> Result<ClassifiedYjsCandidate, YjsDiffMaterializationError> {
    drop(self.sender);
    self
      .materialized
      .await
      .unwrap_or(Err(YjsDiffMaterializationError::WorkerUnavailable))
  }
}

impl ValidatedYjsUpdate {
  /// Begin one semantic classification. The returned session owns a
  /// capacity-one input channel but requests rows only when [`YjsCandidatePlan::Materialize`]
  /// is returned.
  pub fn classify(
    self,
    current_state_vector: Option<Vec<u8>>,
    max_input_bytes: usize,
  ) -> Result<YjsCandidateSession, YjsDiffMaterializationError> {
    self.classify_with_registration(current_state_vector, max_input_bytes, Default::default())
  }

  /// Derive unfinished page-registration facts on the same bounded worker and
  /// materialization as persistence classification; ordinary edits keep the fast path.
  pub fn classify_with_registration(
    self,
    current_state_vector: Option<Vec<u8>>,
    max_input_bytes: usize,
    registration: page_registration::PageRegistrationRequest,
  ) -> Result<YjsCandidateSession, YjsDiffMaterializationError> {
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    let (plan_sender, plan) = tokio::sync::oneshot::channel();
    let (materialized_sender, materialized) = tokio::sync::oneshot::channel();
    self
      .command
      .send(ValidatedYjsUpdateCommand::Classify {
        current_state_vector,
        registration,
        max_input_bytes,
        updates: receiver,
        plan: plan_sender,
        materialized: materialized_sender,
      })
      .map_err(|_| YjsDiffMaterializationError::WorkerUnavailable)?;
    Ok(YjsCandidateSession {
      sender,
      plan,
      materialized,
    })
  }
}

/// Decode one external update on a bounded blocking worker and retain the Yrs
/// value on that same thread until persistence classification completes.
pub async fn decode_update_v1_guarded(
  payload: Vec<u8>,
  permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<(Vec<u8>, ValidatedYjsUpdate), YjsGuardedDecodeError> {
  let (command, commands) = std::sync::mpsc::sync_channel(1);
  let (validation_sender, validation) = tokio::sync::oneshot::channel();
  tokio::task::spawn_blocking(move || {
    let _permit = permit;
    let decoded = match decode_update_v1(&payload) {
      Ok(decoded) => decoded,
      Err(_error) => {
        let _ = validation_sender.send(Err(YjsGuardedDecodeError::InvalidUpdate));
        return;
      }
    };
    if validation_sender.send(Ok(payload)).is_err() {
      return;
    }

    let Ok(ValidatedYjsUpdateCommand::Classify {
      current_state_vector,
      registration,
      max_input_bytes,
      mut updates,
      plan,
      materialized,
    }) = commands.recv()
    else {
      return;
    };

    let novelty = current_state_vector
      .as_deref()
      .map(|state| decoded.classify_struct_clocks(state));
    let fast = match novelty {
      Some(Ok(YjsStructClockNovelty::None)) if !decoded.has_delete_set() => Some(ClassifiedYjsCandidate {
        state_vector: current_state_vector,
        is_crdt_noop: true,
        registration: Default::default(),
      }),
      Some(Ok(YjsStructClockNovelty::Contiguous(state_vector))) => Some(ClassifiedYjsCandidate {
        state_vector: Some(state_vector),
        is_crdt_noop: false,
        registration: Default::default(),
      }),
      Some(Ok(YjsStructClockNovelty::Discontinuous)) => Some(ClassifiedYjsCandidate {
        state_vector: None,
        is_crdt_noop: false,
        registration: Default::default(),
      }),
      Some(Ok(YjsStructClockNovelty::None) | Err(YjsDiffMaterializationError::InvalidStateVector)) | None => None,
      Some(Err(error)) => {
        let _ = plan.send(Err(error));
        return;
      }
    };
    if let Some(result) = fast
      && matches!(registration, page_registration::PageRegistrationRequest::None)
    {
      let _ = plan.send(Ok(YjsCandidatePlan::Complete(result)));
      return;
    }

    if plan.send(Ok(YjsCandidatePlan::Materialize)).is_err() {
      return;
    }
    let result = materialize_candidate_with_registration(
      std::iter::from_fn(move || updates.blocking_recv()),
      decoded,
      max_input_bytes,
      || false,
      &registration,
    )
    .map(|result| {
      let is_crdt_noop = result.is_crdt_noop();
      ClassifiedYjsCandidate {
        state_vector: result.state_vector,
        is_crdt_noop,
        registration: result.registration,
      }
    });
    let _ = materialized.send(result);
  });

  let payload = validation
    .await
    .map_err(|_| YjsGuardedDecodeError::WorkerUnavailable)??;
  Ok((payload, ValidatedYjsUpdate { command }))
}

/// Canonical encoded empty Yjs-v1 state vector for a newly materialized
/// document.
pub fn empty_state_vector_v1() -> Vec<u8> {
  StateVector::default().encode_v1()
}

/// Validate the Yjs v1 wire structure without applying it to a document.
///
/// This is intentionally a decoder-only check. An incremental update may
/// refer to CRDT items that are not present in the receiving document yet;
/// dependency resolution remains the responsibility of the normal Yjs sync
/// flow. Callers handling untrusted bytes must apply their size limit before
/// invoking this function and must not expose the underlying decoder error.
pub fn validate_update_v1(update: &[u8]) -> Result<(), YjsUpdateValidationError> {
  decode_update_v1(update).map(|_| ())
}

/// Redacted failure from the bounded document load/diff materializer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum YjsDiffMaterializationError {
  #[error("document load was cancelled")]
  Cancelled,
  #[error("invalid persisted Yjs v1 update")]
  InvalidUpdate,
  #[error("failed to apply persisted Yjs v1 update")]
  ApplyFailed,
  #[error("invalid Yjs v1 state vector")]
  InvalidStateVector,
  #[error("document sync input exceeds its configured bound")]
  InputTooLarge,
  #[error("Yjs decoder worker unavailable")]
  WorkerUnavailable,
}

/// Result produced from one Yrs document and one read transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedYjsDiff {
  pub state_vector: Vec<u8>,
  pub missing: Vec<u8>,
  pub input_bytes: usize,
  pub update_count: usize,
}

/// Semantic result of applying one already-decoded candidate to the bounded
/// authoritative snapshot/tail stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedYjsCandidate {
  /// `None` means the candidate contains unresolved struct dependencies. The
  /// persisted acceleration vector must then remain null and be reconstructed
  /// lazily; the update itself is still durable CRDT information.
  pub state_vector: Option<Vec<u8>>,
  pub has_new_structs: bool,
  pub canonical_changed: bool,
  pub input_bytes: usize,
  pub update_count: usize,
  pub registration: page_registration::PageRegistrationProjection,
}

impl MaterializedYjsCandidate {
  /// A candidate is a CRDT no-op only when it adds neither struct clocks nor a
  /// canonical delete-set effect.
  pub fn is_crdt_noop(&self) -> bool {
    !self.has_new_structs && !self.canonical_changed
  }
}

fn apply_ordered_updates<I, B, C>(
  doc: &Doc,
  updates: I,
  max_input_bytes: usize,
  is_cancelled: &C,
) -> Result<(usize, usize), YjsDiffMaterializationError>
where
  I: IntoIterator<Item = B>,
  B: AsRef<[u8]>,
  C: Fn() -> bool,
{
  let mut input_bytes = 0usize;
  let mut update_count = 0usize;
  for payload in updates {
    if is_cancelled() {
      return Err(YjsDiffMaterializationError::Cancelled);
    }
    let payload = payload.as_ref();
    if payload.is_empty() {
      continue;
    }
    input_bytes = input_bytes.saturating_add(payload.len());
    if input_bytes > max_input_bytes {
      return Err(YjsDiffMaterializationError::InputTooLarge);
    }
    update_count += 1;
    let update = Update::decode_v1(payload).map_err(|_| YjsDiffMaterializationError::InvalidUpdate)?;
    doc
      .transact_mut()
      .apply_update(update)
      .map_err(|_| YjsDiffMaterializationError::ApplyFailed)?;
  }
  Ok((input_bytes, update_count))
}

fn classify_struct_clocks(update: &Update, mut state_vector: StateVector) -> YjsStructClockNovelty {
  let insertions = update.insertions(true);
  let mut has_new_structs = false;
  let mut discontinuous = false;

  for (client, ranges) in insertions.iter() {
    let mut clock = state_vector.get(client);
    for range in ranges {
      if range.end <= clock {
        continue;
      }
      has_new_structs = true;
      if range.start > clock {
        discontinuous = true;
        continue;
      }
      clock = clock.max(range.end);
    }
    state_vector.set_max(*client, clock);
  }

  if discontinuous {
    YjsStructClockNovelty::Discontinuous
  } else if has_new_structs {
    YjsStructClockNovelty::Contiguous(state_vector.encode_v1())
  } else {
    YjsStructClockNovelty::None
  }
}

/// Apply one decoded candidate to the same bounded materialization used by
/// document diff loading.
///
/// Persisted snapshot/tail payloads are consumed incrementally. New structs
/// are never discarded merely because their visible content matches existing
/// content. A delete-only candidate is a no-op only when applying it leaves the
/// canonical Yjs state unchanged.
pub fn materialize_candidate_v1<I, B, C>(
  updates: I,
  candidate: DecodedYjsUpdate,
  max_input_bytes: usize,
  is_cancelled: C,
) -> Result<MaterializedYjsCandidate, YjsDiffMaterializationError>
where
  I: IntoIterator<Item = B>,
  B: AsRef<[u8]>,
  C: Fn() -> bool,
{
  materialize_candidate_with_registration(updates, candidate, max_input_bytes, is_cancelled, &Default::default())
}

fn materialize_candidate_with_registration<I, B, C>(
  updates: I,
  candidate: DecodedYjsUpdate,
  max_input_bytes: usize,
  is_cancelled: C,
  registration: &page_registration::PageRegistrationRequest,
) -> Result<MaterializedYjsCandidate, YjsDiffMaterializationError>
where
  I: IntoIterator<Item = B>,
  B: AsRef<[u8]>,
  C: Fn() -> bool,
{
  let doc = Doc::new();
  let (input_bytes, update_count) = apply_ordered_updates(&doc, updates, max_input_bytes, &is_cancelled)?;
  if is_cancelled() {
    return Err(YjsDiffMaterializationError::Cancelled);
  }

  let (before_state_vector, before_canonical) = {
    let txn = doc.transact();
    (
      txn.state_vector(),
      txn.encode_state_as_update_v1(&StateVector::default()),
    )
  };
  let novelty = classify_struct_clocks(&candidate.0, before_state_vector);
  let has_new_structs = novelty != YjsStructClockNovelty::None;
  doc
    .transact_mut()
    .apply_update(candidate.0)
    .map_err(|_| YjsDiffMaterializationError::ApplyFailed)?;
  let registration = page_registration::project(&doc, registration);
  let (after_state_vector, after_canonical) = {
    let txn = doc.transact();
    (
      txn.state_vector().encode_v1(),
      txn.encode_state_as_update_v1(&StateVector::default()),
    )
  };

  Ok(MaterializedYjsCandidate {
    state_vector: match novelty {
      YjsStructClockNovelty::Discontinuous => None,
      YjsStructClockNovelty::None | YjsStructClockNovelty::Contiguous(_) => Some(after_state_vector),
    },
    has_new_structs,
    canonical_changed: before_canonical != after_canonical,
    input_bytes,
    update_count,
    registration,
  })
}

/// Apply an ordered snapshot/update stream once and derive state and diff.
///
/// The iterator is consumed incrementally, so callers can bridge a bounded
/// repository channel directly into this function without first collecting a
/// `Vec<Vec<u8>>`. Both response values are encoded from the same Yrs document
/// and transaction. Cancellation is checked between every persisted update;
/// no partial state is returned.
pub fn materialize_diff_v1<I, B, C>(
  updates: I,
  client_state_vector: Option<&[u8]>,
  max_input_bytes: usize,
  is_cancelled: C,
) -> Result<MaterializedYjsDiff, YjsDiffMaterializationError>
where
  I: IntoIterator<Item = B>,
  B: AsRef<[u8]>,
  C: Fn() -> bool,
{
  let doc = Doc::new();
  let client_state_vector = match client_state_vector {
    Some(encoded) => StateVector::decode_v1(encoded).map_err(|_| YjsDiffMaterializationError::InvalidStateVector)?,
    None => StateVector::default(),
  };
  let (input_bytes, update_count) = apply_ordered_updates(&doc, updates, max_input_bytes, &is_cancelled)?;

  if is_cancelled() {
    return Err(YjsDiffMaterializationError::Cancelled);
  }
  let txn = doc.transact();
  Ok(MaterializedYjsDiff {
    state_vector: txn.state_vector().encode_v1(),
    missing: txn.encode_state_as_update_v1(&client_state_vector),
    input_bytes,
    update_count,
  })
}

/// Merges multiple Yjs v1 updates into a single v1 binary update.
///
/// Uses `yrs::Doc` to apply all updates sequentially and then re-encode
/// the complete document state. This preserves CRDT semantics including
/// delete sets and parent-child relationships.
///
/// ## P101-TIMESTAMP: Why yrs-based merge, not codec binary-level
///
/// The previous implementation used the custom codec's `merge_updates_v1`
/// for binary-level merging, then re-encoded through `yrs::Doc`. This
/// two-step process produced incorrect output for complex structures
/// (YMap inside YArray): deleted items were resurrected because the
/// codec merge and yrs re-encoding handled parent references differently.
///
/// The yrs-based approach is semantically correct: it applies each update
/// to a `Doc` (which correctly processes delete sets, parent links, and
/// garbage collection), then encodes the final state.
///
/// ## Determinism note
///
/// `yrs::Doc::new()` assigns a random client ID, so the binary output
/// contains a different client ID on each call. However, the CRDT
/// *content* is identical — the client ID only affects struct metadata,
/// not the observable data. All Yjs implementations handle this
/// correctly during sync.
#[instrument(skip(updates))]
pub fn merge_updates(updates: Vec<Vec<u8>>) -> Result<Vec<u8>, String> {
  let count = updates.len();
  trace!(update_count = count, "merging yjs updates (yrs doc-based)");
  let non_empty: Vec<&[u8]> = updates.iter().filter(|u| !u.is_empty()).map(|u| u.as_slice()).collect();
  if non_empty.is_empty() {
    debug!("all updates empty, returning minimal update");
    return Ok(vec![0, 0]);
  }

  // Apply all updates to a single yrs Doc. This correctly processes
  // CRDT operations including delete sets, parent references, and
  // structural types (YArray, YMap, subdocs).
  let doc = Doc::new();
  for (i, payload) in non_empty.iter().enumerate() {
    let u = Update::decode_v1(payload).map_err(|e| format!("yrs decode update {} failed: {e}", i + 1))?;
    let mut tx = doc.transact_mut();
    tx.apply_update(u)
      .map_err(|e| format!("yrs apply update {} failed: {e}", i + 1))?;
  }

  // Encode the complete document state as a single update from the
  // beginning (empty state vector). This includes all structs and
  // the accumulated delete set.
  let result = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());

  debug!(
    input_count = count,
    output_size = result.len(),
    "successfully merged {} updates (yrs doc-based)",
    count
  );
  Ok(result)
}

const SNAPSHOT_DOCUMENT_URI_PREFIX: &str = "myoxus-snapshot-document:";
const SNAPSHOT_ASSET_URI_PREFIX: &str = "myoxus-snapshot-asset:";

fn rewrite_snapshot_any(value: &mut Any, replacements: &HashMap<String, String>) -> Result<bool, String> {
  match value {
    Any::String(current) => {
      if let Some(replacement) = replacements.get(current.as_ref()) {
        *current = replacement.clone().into();
        return Ok(true);
      }
      if current.starts_with(SNAPSHOT_DOCUMENT_URI_PREFIX) || current.starts_with(SNAPSHOT_ASSET_URI_PREFIX) {
        return Err(format!("unresolved reserved snapshot URI '{current}'"));
      }
      Ok(false)
    }
    Any::Array(values) => {
      let mut rewritten = values.to_vec();
      let mut changed = false;
      for value in &mut rewritten {
        changed |= rewrite_snapshot_any(value, replacements)?;
      }
      if changed {
        *values = rewritten.into();
      }
      Ok(changed)
    }
    Any::Map(values) => {
      let mut rewritten = values.as_ref().clone();
      let mut changed = false;
      for value in rewritten.values_mut() {
        changed |= rewrite_snapshot_any(value, replacements)?;
      }
      if changed {
        *values = rewritten.into();
      }
      Ok(changed)
    }
    _ => Ok(false),
  }
}

fn collect_any_strings(value: &Any, values: &mut HashSet<String>) {
  match value {
    Any::String(value) => {
      values.insert(value.to_string());
    }
    Any::Array(items) => {
      for item in items.iter() {
        collect_any_strings(item, values);
      }
    }
    Any::Map(items) => {
      for item in items.values() {
        collect_any_strings(item, values);
      }
    }
    _ => {}
  }
}

/// Collect string-valued resource candidates from block properties and YText
/// attributes without exposing document text. Callers intersect this set with
/// known document/blob identities before creating portable manifests.
pub fn collect_yjs_resource_values(update: &[u8]) -> Result<HashSet<String>, String> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    let update = Update::decode_v1(update).map_err(|error| format!("resource inventory decode failed: {error}"))?;
    txn
      .apply_update(update)
      .map_err(|error| format!("resource inventory apply failed: {error}"))?;
  }
  let txn = doc.transact();
  let mut resources = HashSet::new();
  for (_, block) in blocks.iter(&txn) {
    let yrs::Out::YMap(block) = block else {
      continue;
    };
    for (key, value) in block.iter(&txn) {
      match value {
        yrs::Out::Any(value) => collect_any_strings(&value, &mut resources),
        yrs::Out::YMap(props) if key == "props" => {
          for (_, value) in props.iter(&txn) {
            if let yrs::Out::Any(value) = value {
              collect_any_strings(&value, &mut resources);
            }
          }
        }
        yrs::Out::YText(text) => {
          for chunk in text.diff(&txn, YChange::identity) {
            if let Some(attrs) = chunk.attributes {
              for value in attrs.values() {
                collect_any_strings(value, &mut resources);
              }
            }
          }
        }
        _ => {}
      }
    }
  }
  Ok(resources)
}

/// Read the canonical workspace Collections from the root Yjs document.
///
/// Collections remain stored under `setting.collections`; server-side
/// Organizer links and transfer shortcut projections use this decoder rather
/// than introducing a second Collection store. Malformed entries and duplicate identities fail closed
/// because silently omitting either would lose rules or allow-list members.
pub fn extract_workspace_collections(update: &[u8]) -> Result<Vec<serde_json::Value>, String> {
  let doc = Doc::new();
  let setting = doc.get_or_insert_map("setting");
  {
    let mut txn = doc.transact_mut();
    let update = Update::decode_v1(update).map_err(|error| format!("workspace collection decode failed: {error}"))?;
    txn
      .apply_update(update)
      .map_err(|error| format!("workspace collection apply failed: {error}"))?;
  }
  let txn = doc.transact();
  let Some(collections) = setting.get(&txn, "collections") else {
    return Ok(Vec::new());
  };
  let values = match collections {
    yrs::Out::YArray(collections) => collections
      .iter(&txn)
      .map(|value| yjs_out_to_json(value, &txn))
      .collect::<Vec<_>>(),
    yrs::Out::Any(Any::Array(collections)) => collections.iter().map(yjs_any_to_json).collect(),
    _ => return Err("workspace collections must be a Yjs array".to_string()),
  };
  let mut seen = HashSet::with_capacity(values.len());
  for value in &values {
    let id = value
      .get("id")
      .and_then(serde_json::Value::as_str)
      .filter(|id| !id.trim().is_empty())
      .ok_or_else(|| "workspace collection identity is invalid".to_string())?;
    if !seen.insert(id.to_string()) {
      return Err("workspace collection identities are not unique".to_string());
    }
  }
  Ok(values)
}

/// Rewrite reserved portable snapshot URIs inside a Virgultum Yjs document.
///
/// The caller provides exact URI-to-live-value mappings. Block properties and
/// formatted text attributes are rewritten without converting through a lossy
/// text format. Any reserved URI not present in the mapping fails the whole
/// operation so portable identifiers can never leak into persisted documents.
pub fn rewrite_snapshot_resource_uris(
  update: &[u8],
  replacements: &HashMap<String, String>,
) -> Result<Vec<u8>, String> {
  rewrite_resource_values(update, replacements, None)
}

/// Rewrite mapped resource values with a deterministic local Yjs client ID.
///
/// Operation replays must produce byte-identical staged snapshots. The caller
/// therefore supplies a stable client ID derived from durable operation and
/// target identities. A collision with an existing source client fails closed
/// instead of corrupting the CRDT struct clock space.
pub fn rewrite_resource_values_deterministic(
  update: &[u8],
  replacements: &HashMap<String, String>,
  client_id: u64,
) -> Result<Vec<u8>, String> {
  rewrite_resource_values(update, replacements, Some(client_id))
}

/// One imported file reference appended to the canonical note as an attachment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedAttachment {
  pub source_id: String,
  pub name: String,
  pub mime: String,
  pub size: i64,
}

/// Append server-authorized file embeds to an already prepared document.
///
/// Markdown owns text conversion, while vault adapters use this narrow bridge
/// for file embeds that have no Markdown block representation. Source IDs are
/// intentionally left portable so the existing resource rewrite can bind them
/// to uploaded workspace blobs in the same apply transaction.
pub fn append_imported_attachments(update: &[u8], attachments: &[ImportedAttachment]) -> Result<Vec<u8>, String> {
  if attachments.is_empty() {
    return Ok(update.to_vec());
  }
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    let update = Update::decode_v1(update).map_err(|error| format!("attachment import decode failed: {error}"))?;
    txn
      .apply_update(update)
      .map_err(|error| format!("attachment import apply failed: {error}"))?;
  }
  let note_children = {
    let txn = doc.transact();
    let mut notes = blocks.iter(&txn).filter_map(|(_, value)| {
      let yrs::Out::YMap(block) = value else { return None };
      (block_string(&block, &txn, "flavour").as_deref() == Some("myoxus:note"))
        .then(|| block.get(&txn, "sys:children"))
        .flatten()
        .and_then(|value| match value {
          yrs::Out::YArray(children) => Some(children),
          _ => None,
        })
    });
    let note = notes
      .next()
      .ok_or_else(|| "attachment import requires one canonical note".to_string())?;
    if notes.next().is_some() {
      return Err("attachment import found multiple canonical notes".to_string());
    }
    note
  };
  {
    let mut txn = doc.transact_mut();
    for attachment in attachments {
      let id = format!("import-attachment-{}", Uuid::new_v4().simple());
      let (block, _) = create_yjs_block(&blocks, &mut txn, &id, "myoxus:attachment");
      block.insert(&mut txn, "prop:sourceId", attachment.source_id.as_str());
      block.insert(&mut txn, "prop:name", attachment.name.as_str());
      block.insert(&mut txn, "prop:type", attachment.mime.as_str());
      block.insert(&mut txn, "prop:size", Any::BigInt(attachment.size));
      block.insert(&mut txn, "prop:embed", false);
      note_children.push_back(&mut txn, id.as_str());
    }
  }
  Ok(doc.transact().encode_state_as_update_v1(&StateVector::default()))
}

fn rewrite_resource_values(
  update: &[u8],
  replacements: &HashMap<String, String>,
  client_id: Option<u64>,
) -> Result<Vec<u8>, String> {
  let doc = client_id.map(Doc::with_client_id).unwrap_or_default();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    let update = Update::decode_v1(update).map_err(|error| format!("snapshot URI decode failed: {error}"))?;
    txn
      .apply_update(update)
      .map_err(|error| format!("snapshot URI apply failed: {error}"))?;
  }
  if let Some(client_id) = client_id
    && doc
      .transact()
      .state_vector()
      .contains_client(&yrs::ClientID::new(client_id))
  {
    return Err("resource rewrite client identifier collides with source state".to_string());
  }

  let block_maps = {
    let txn = doc.transact();
    blocks
      .iter(&txn)
      .filter_map(|(_, value)| match value {
        yrs::Out::YMap(map) => Some(map),
        _ => None,
      })
      .collect::<Vec<_>>()
  };
  let mut txn = doc.transact_mut();
  let mut text_rewrites = Vec::new();
  for block in block_maps {
    let values = block
      .iter(&txn)
      .map(|(key, value)| (key.to_string(), value))
      .collect::<Vec<_>>();
    for (key, value) in values {
      match value {
        yrs::Out::Any(mut value) => {
          if !rewrite_snapshot_any(&mut value, replacements)? {
            continue;
          }
          block.insert(&mut txn, key, value);
        }
        yrs::Out::YMap(props) if key == "props" => {
          let values = props
            .iter(&txn)
            .map(|(key, value)| (key.to_string(), value))
            .collect::<Vec<_>>();
          for (prop_key, value) in values {
            if let yrs::Out::Any(mut value) = value
              && rewrite_snapshot_any(&mut value, replacements)?
            {
              props.insert(&mut txn, prop_key, value);
            }
          }
        }
        yrs::Out::YText(text) => {
          let mut chunks = Vec::new();
          let mut changed = false;
          for chunk in text.diff(&txn, YChange::identity) {
            let yrs::Out::Any(Any::String(value)) = chunk.insert else {
              return Err("snapshot URI rewrite does not support embedded YText values".to_string());
            };
            let mut attrs = chunk.attributes.map(|attrs| *attrs).unwrap_or_default();
            for value in attrs.values_mut() {
              changed |= rewrite_snapshot_any(value, replacements)?;
            }
            chunks.push((value.to_string(), attrs));
          }
          if changed {
            text_rewrites.push((text, chunks));
          }
        }
        _ => {}
      }
    }
  }
  for (text, chunks) in text_rewrites {
    let length = text.len(&txn);
    if length > 0 {
      text.remove_range(&mut txn, 0, length);
    }
    for (value, attrs) in chunks {
      let offset = text.len(&txn);
      text.insert_with_attributes(&mut txn, offset, &value, attrs);
    }
  }
  Ok(txn.encode_state_as_update_v1(&StateVector::default()))
}

/// Computes the missing diff between a Yjs v1 update and a client state vector.
///
/// Uses yrs `Doc` to decode the full update and then `encode_diff_v1` to
/// produce only the items the client is missing. This replaces the previous
/// codec-based implementation which corrupted large numeric values (Int53/
/// Float64) during encode — the root cause of the Jan-1970 date bug
/// (P101-TIMESTAMP).
///
/// Equivalent to JavaScript `Y.diffUpdate(update, stateVector)`.
#[instrument(skip(current_data, state_vector))]
pub fn get_missing_diff(current_data: &[u8], state_vector: &[u8]) -> Result<Vec<u8>, String> {
  trace!(
    data_size = current_data.len(),
    sv_size = state_vector.len(),
    "computing yjs diff (yrs-based)"
  );

  if current_data.is_empty() {
    debug!("empty current_data, returning empty update");
    return Ok(vec![0, 0]);
  }

  // Decode full update into a yrs Doc
  let doc = Doc::new();
  let update = Update::decode_v1(current_data).map_err(|e| format!("yrs decode failed: {e}"))?;
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(update)
      .map_err(|e| format!("yrs apply update failed: {e}"))?;
  }

  // Parse client state vector
  let sv = if state_vector.is_empty() || state_vector == [0] {
    yrs::StateVector::default()
  } else {
    yrs::StateVector::decode_v1(state_vector).map_err(|e| format!("yrs SV decode failed: {e}"))?
  };

  // Encode only the diff the client needs
  let txn = doc.transact();
  let result = txn.encode_diff_v1(&sv);

  debug!(diff_size = result.len(), "yrs diff computed");
  Ok(result)
}

/// Creates the minimal initial Yjs binary for a workspace root document.
///
/// The AFFiNE/Virgultum frontend expects the root doc to contain a YMap
/// called `meta` with at least a `name` (String) and `pages` (YArray).
/// Without this structure, a newly created workspace appears blank because
/// the client loads an empty Yjs doc and never auto-initializes it.
#[instrument]
pub fn create_initial_workspace_doc(name: &str) -> Vec<u8> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  let update = {
    let mut txn = doc.transact_mut();
    meta.insert(&mut txn, "name", name);
    meta.insert(&mut txn, "pages", yrs::ArrayPrelim::default());
    txn.encode_update_v1()
  };
  debug!(name, update_size = update.len(), "created initial workspace root doc");
  update
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedWorkspacePage {
  pub id: String,
  pub title: String,
  pub mode: String,
  pub parent_id: Option<String>,
  pub order: String,
  pub created_at_ms: i64,
  pub updated_at_ms: i64,
  pub is_trashed: bool,
}

/// Build the complete root metadata state for a hidden workspace import.
/// Page ordering is supplied by the validated decoder; hierarchy and trash
/// flags remain portable metadata rather than client-side reconstruction.
pub fn create_imported_workspace_doc(name: &str, pages: &[ImportedWorkspacePage]) -> Vec<u8> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  {
    let mut txn = doc.transact_mut();
    meta.insert(&mut txn, "name", name);
    let target_pages = meta.insert(&mut txn, "pages", yrs::ArrayPrelim::default());
    for page in pages {
      let mut values = HashMap::from([
        ("id".to_string(), Any::String(page.id.clone().into())),
        ("title".to_string(), Any::String(page.title.clone().into())),
        ("mode".to_string(), Any::String(page.mode.clone().into())),
        ("order".to_string(), Any::String(page.order.clone().into())),
        ("createDate".to_string(), Any::from(page.created_at_ms as f64)),
        ("updatedDate".to_string(), Any::from(page.updated_at_ms as f64)),
      ]);
      if let Some(parent_id) = &page.parent_id {
        values.insert("parentId".to_string(), Any::String(parent_id.clone().into()));
      }
      if page.is_trashed {
        values.insert("trash".to_string(), Any::Bool(true));
      }
      target_pages.push_back(&mut txn, values.into_iter().collect::<yrs::MapPrelim>());
    }
  }
  doc.transact().encode_state_as_update_v1(&StateVector::default())
}

/// Project portable labels into detached import/export root bytes. This helper
/// does not write a live document, invalidate caches or broadcast sync updates.
pub fn project_workspace_tags_in_root_doc(
  update: &[u8],
  catalog: &serde_json::Value,
  assignments: &HashMap<String, Vec<String>>,
) -> Result<Vec<u8>, String> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(update).map_err(|error| error.to_string())?)
      .map_err(|error| error.to_string())?;
    let properties = match meta.get(&txn, "properties") {
      Some(yrs::Out::YMap(properties)) => properties,
      None => meta.insert(&mut txn, "properties", yrs::MapPrelim::default()),
      _ => return Err("workspace properties must be a shared map".into()),
    };
    let tags = match properties.get(&txn, "tags") {
      Some(yrs::Out::YMap(tags)) => tags,
      None => properties.insert(&mut txn, "tags", yrs::MapPrelim::default()),
      _ => return Err("workspace tags must be a shared map".into()),
    };
    tags.insert(&mut txn, "options", json_to_yjs_any(catalog)?);
    if let Some(yrs::Out::YArray(pages)) = meta.get(&txn, "pages") {
      let pages = pages.iter(&txn).collect::<Vec<_>>();
      for page in pages {
        if let yrs::Out::YMap(page) = page {
          let id = page.get(&txn, "id").and_then(|value| match value {
            yrs::Out::Any(Any::String(id)) => Some(id.to_string()),
            _ => None,
          });
          if let Some(ids) = id.as_ref().and_then(|id| assignments.get(id)) {
            page.insert(&mut txn, "tags", json_to_yjs_any(&serde_json::json!(ids))?);
          }
        }
      }
    }
  }
  Ok(doc.transact().encode_state_as_update_v1(&StateVector::default()))
}

/// Adds page entries to the workspace root doc's `meta.pages` YArray.
///
/// The frontend reads `rootDoc.getMap('meta').get('pages')` as a
/// `YArray<YMap<{id: string, title: string}>>` to discover which pages exist
/// in the workspace sidebar.  This function merges all existing updates,
/// appends the new page entries to the `pages` array, and returns **only the
/// incremental update** (not the full doc state).
///
/// # Arguments
/// * `existing_updates` — all Yjs v1 update payloads for the root doc
/// * `pages` — list of `(doc_id_string, title)` pairs to add
///
/// # Returns
/// A Yjs v1 update containing only the new page entries.
#[instrument(skip(existing_updates, pages))]
pub fn add_pages_to_root_doc(existing_updates: &[Vec<u8>], pages: &[(String, String)]) -> Result<Vec<u8>, String> {
  if pages.is_empty() {
    return Ok(Vec::new());
  }

  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");

  // Apply each update in its own transaction to mirror normal sync replay.
  // Later delete sets must see already-integrated structs; batching the whole
  // history into one transaction can leave Rust-side phantom root entries that
  // the JS/Yjs client has already removed.
  for update_data in existing_updates {
    if !update_data.is_empty() {
      let u = Update::decode_v1(update_data).map_err(|e| e.to_string())?;
      let mut txn = doc.transact_mut();
      txn.apply_update(u).map_err(|e| e.to_string())?;
    }
  }

  // Capture state vector before our changes
  let sv_before = {
    let txn = doc.transact();
    txn.state_vector()
  };

  let mut appended_pages = 0usize;
  let mut repaired_pages = 0usize;

  // Append new pages to the pages array, or repair existing hidden entries.
  {
    let mut txn = doc.transact_mut();
    let pages_array = match meta.get(&txn, "pages") {
      Some(yrs::Out::YArray(arr)) => arr,
      _ => {
        // pages array doesn't exist yet — create it
        meta.insert(&mut txn, "pages", yrs::ArrayPrelim::default());
        match meta.get(&txn, "pages") {
          Some(yrs::Out::YArray(arr)) => arr,
          _ => return Err("Failed to create pages array in root doc".to_string()),
        }
      }
    };

    for (page_id, title) in pages {
      let existing_page = pages_array.iter(&txn).find_map(|item| {
        let yrs::Out::YMap(page) = item else {
          return None;
        };
        match page.get(&txn, "id") {
          Some(yrs::Out::Any(yrs::Any::String(id))) if id.as_ref() == page_id.as_str() => Some(page),
          _ => None,
        }
      });

      if let Some(page) = existing_page {
        // A seed/import rerun is allowed to make a live relational document
        // visible again. Repair the existing CRDT entry instead of appending a
        // duplicate, because server-side trash sync uses any-trash-wins for
        // duplicate page IDs.
        page.insert(&mut txn, "title", yrs::Any::String(title.clone().into()));
        page.remove(&mut txn, "trash");
        repaired_pages += 1;
      } else {
        let entry = yrs::MapPrelim::from([
          ("id".to_string(), yrs::Any::String(page_id.clone().into())),
          ("title".to_string(), yrs::Any::String(title.clone().into())),
        ]);
        pages_array.push_back(&mut txn, entry);
        appended_pages += 1;
      }
    }
  }

  // Encode only the diff (new entries)
  let txn = doc.transact();
  let diff = txn.encode_diff_v1(&sv_before);
  debug!(
    pages_requested = pages.len(),
    pages_appended = appended_pages,
    pages_repaired = repaired_pages,
    diff_size = diff.len(),
    "updated root doc page entries"
  );
  Ok(diff)
}

/// Incremental mutation of one existing workspace-root page entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootPageMetadataMutation {
  pub update: Vec<u8>,
  pub matched_entries: usize,
}

/// Update title, trash state and timestamps of one root `meta.pages` entry.
///
/// Every matching entry is updated so old duplicate metadata converges instead
/// of retaining contradictory title or trash values. The caller decides which
/// fields change; untouched fields preserve their current CRDT value.
#[instrument(skip(root_doc_update, title), fields(%page_id, root_size = root_doc_update.len()))]
pub fn update_root_page_metadata(
  root_doc_update: &[u8],
  page_id: &str,
  title: Option<&str>,
  is_trashed: Option<bool>,
  created_at_ms: Option<i64>,
  updated_at_ms: i64,
) -> Result<RootPageMetadataMutation, String> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  if !root_doc_update.is_empty() {
    let update = Update::decode_v1(root_doc_update)
      .map_err(|error| format!("update_root_page_metadata: decode failed: {error}"))?;
    doc
      .transact_mut()
      .apply_update(update)
      .map_err(|error| format!("update_root_page_metadata: apply failed: {error}"))?;
  }
  let state_before = doc.transact().state_vector();
  let targets = {
    let txn = doc.transact();
    let pages = match meta.get(&txn, "pages") {
      Some(yrs::Out::YArray(pages)) => pages,
      _ => {
        return Ok(RootPageMetadataMutation {
          update: Vec::new(),
          matched_entries: 0,
        });
      }
    };
    pages
      .iter(&txn)
      .filter_map(|entry| {
        let yrs::Out::YMap(page) = entry else {
          return None;
        };
        match page.get(&txn, "id") {
          Some(yrs::Out::Any(Any::String(id))) if id.as_ref() == page_id => Some(page),
          _ => None,
        }
      })
      .collect::<Vec<_>>()
  };

  if targets.is_empty() {
    return Ok(RootPageMetadataMutation {
      update: Vec::new(),
      matched_entries: 0,
    });
  }
  {
    let mut txn = doc.transact_mut();
    for page in &targets {
      if let Some(title) = title {
        page.insert(&mut txn, "title", Any::String(title.into()));
      }
      if let Some(is_trashed) = is_trashed {
        if is_trashed {
          page.insert(&mut txn, "trash", Any::Bool(true));
        } else {
          page.remove(&mut txn, "trash");
        }
      }
      if let Some(created_at_ms) = created_at_ms {
        page.insert(&mut txn, "createDate", Any::from(created_at_ms as f64));
      }
      page.insert(&mut txn, "updatedDate", Any::from(updated_at_ms as f64));
    }
  }
  let update = doc.transact().encode_diff_v1(&state_before);
  Ok(RootPageMetadataMutation {
    update,
    matched_entries: targets.len(),
  })
}

/// Replace the collaborative title of the canonical page block.
///
/// This edits only the active page-title `Y.Text` and returns its incremental
/// Yjs-v1 delta. Document body blocks and their identities remain untouched.
#[instrument(skip(document_update, title), fields(document_size = document_update.len()))]
pub fn update_document_title(document_update: &[u8], title: &str) -> Result<Vec<u8>, String> {
  if document_update.is_empty() {
    return Err("update_document_title: document is empty".to_string());
  }
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let update =
    Update::decode_v1(document_update).map_err(|error| format!("update_document_title: decode failed: {error}"))?;
  doc
    .transact_mut()
    .apply_update(update)
    .map_err(|error| format!("update_document_title: apply failed: {error}"))?;
  let state_before = doc.transact().state_vector();
  let page = {
    let txn = doc.transact();
    blocks.iter(&txn).find_map(|(_, value)| {
      let yrs::Out::YMap(block) = value else {
        return None;
      };
      let flavour = block_string(&block, &txn, "flavour")?;
      (resolve_flavour(&flavour) == "myoxus:page").then_some(block)
    })
  }
  .ok_or_else(|| "update_document_title: canonical page block is missing".to_string())?;

  let mut txn = doc.transact_mut();
  let title_text = match page.get(&txn, "prop:title").or_else(|| page.get(&txn, "title")) {
    Some(yrs::Out::YText(text)) => text,
    _ => page.insert(&mut txn, "prop:title", yrs::TextPrelim::new("")),
  };
  // A native template clone can already contain the requested title after
  // variable projection. Avoiding a byte-identical rewrite retains existing
  // YText attributes (including native inline references) in that case.
  if title_text.get_string(&txn) != title {
    let length = title_text.len(&txn);
    if length > 0 {
      title_text.remove_range(&mut txn, 0, length);
    }
    if !title.is_empty() {
      title_text.insert(&mut txn, 0, title);
    }
  }
  drop(txn);
  let update = doc.transact().encode_diff_v1(&state_before);
  Ok(update)
}

/// Replace bounded template variables in the native page title, paragraph
/// text, list text and native flat-table cells without converting through Markdown.
///
/// Rewriting the complete YText value is intentional: every unchanged chunk
/// is reinserted with its original attributes, which preserves inline document
/// references and formatting. String-list values are accepted only for a list
/// block whose complete text is the corresponding placeholder and expand into
/// sibling native list blocks in the existing parent collection.
#[instrument(skip(document_update, variables))]
pub fn instantiate_native_template(
  document_update: &[u8],
  variables: &HashMap<String, NativeTemplateVariable>,
) -> Result<NativeTemplateInstantiation, String> {
  inspect_native_template_references(document_update)?;
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    let update =
      Update::decode_v1(document_update).map_err(|error| format!("native template decode failed: {error}"))?;
    txn
      .apply_update(update)
      .map_err(|error| format!("native template apply failed: {error}"))?;
  }

  let mut unresolved = BTreeSet::new();
  let handled = native_template_repeat::expand(&doc, &blocks, variables, &mut unresolved)?;
  let block_maps = {
    let txn = doc.transact();
    blocks
      .iter(&txn)
      .filter_map(|(block_id, value)| match value {
        yrs::Out::YMap(block) => Some((block_id.to_string(), block)),
        _ => None,
      })
      .collect::<Vec<_>>()
  };
  let parents = {
    let txn = doc.transact();
    let mut parents = HashMap::new();
    for (_, block) in &block_maps {
      let Some(yrs::Out::YArray(children)) = block.get(&txn, "sys:children") else {
        continue;
      };
      for (index, child) in children.iter(&txn).enumerate() {
        if let yrs::Out::Any(Any::String(child_id)) = child {
          parents.insert(child_id.to_string(), (children.clone(), index as u32));
        }
      }
    }
    parents
  };
  let mut txn = doc.transact_mut();
  let mut rewrites = Vec::new();
  let mut list_expansions = Vec::new();
  for (block_id, block) in block_maps {
    let flavour = block_string(&block, &txn, "flavour")
      .map(|value| resolve_flavour(&value).to_string())
      .unwrap_or_default();
    let texts = if flavour == "myoxus:table" {
      // Active native cells are flattened YText properties. Reuse the same
      // marked-text substitution as paragraphs; do not rebuild table geometry.
      block
        .iter(&txn)
        .filter_map(|(key, value)| {
          if key.starts_with("prop:cells.")
            && key.ends_with(".text")
            && let yrs::Out::YText(text) = value
          {
            return Some((key.to_string(), text));
          }
          None
        })
        .collect::<Vec<_>>()
    } else {
      let property = match flavour.as_str() {
        "myoxus:page" => "prop:title",
        "myoxus:paragraph" | "myoxus:list" => "prop:text",
        _ => continue,
      };
      let Some(yrs::Out::YText(text)) = block.get(&txn, property).or_else(|| {
        (property == "prop:title")
          .then(|| block.get(&txn, "title"))
          .flatten()
          .or_else(|| (property == "prop:text").then(|| block.get(&txn, "text")).flatten())
      }) else {
        continue;
      };
      vec![(property.to_string(), text)]
    };
    for (property, text) in texts {
      if handled.contains(&(block_id.clone(), property)) {
        continue;
      }
      let chunks = text
        .diff(&txn, YChange::identity)
        .into_iter()
        .map(|chunk| {
          let yrs::Out::Any(Any::String(value)) = chunk.insert else {
            return Err("native template text contains an unsupported embedded value".to_string());
          };
          Ok((
            value.to_string(),
            chunk.attributes.map(|attrs| *attrs).unwrap_or_default(),
          ))
        })
        .collect::<Result<Vec<_>, String>>()?;
      if flavour == "myoxus:list"
        && let Some(values) = exact_native_template_list_values(&chunks, variables)
        && values.len() > 1
      {
        let has_children = block
          .get(&txn, "sys:children")
          .and_then(|value| match value {
            yrs::Out::YArray(children) => Some(children.len(&txn) > 0),
            _ => None,
          })
          .unwrap_or(false);
        if has_children {
          return Err("string-list variables cannot expand a list item with nested children".to_string());
        }
        let (parent, _) = parents
          .get(&block_id)
          .cloned()
          .ok_or_else(|| "string-list variable list parent is missing".to_string())?;
        list_expansions.push((block_id.clone(), block.clone(), parent, values));
      }
      let rewritten = rewrite_native_template_chunks(&chunks, &flavour, variables, &mut unresolved, false)?;
      if rewritten != chunks {
        rewrites.push((text, rewritten));
      }
    }
  }

  for (text, chunks) in rewrites {
    let length = text.len(&txn);
    if length > 0 {
      text.remove_range(&mut txn, 0, length);
    }
    for (value, attrs) in chunks {
      if value.is_empty() {
        continue;
      }
      let offset = text.len(&txn);
      text.insert_with_attributes(&mut txn, offset, &value, attrs);
    }
  }
  for (source_id, source_block, parent_children, values) in list_expansions {
    // Earlier sibling expansions change indices, not identities. Resolve the
    // prototype's current position before inserting this independent list.
    let source_index = parent_children
      .iter(&txn)
      .position(|value| matches!(value, yrs::Out::Any(Any::String(id)) if id.as_ref() == source_id))
      .ok_or_else(|| "template list parent is missing".to_string())? as u32;
    for (offset, value) in values.into_iter().skip(1).enumerate() {
      let prelim = source_block.as_prelim(&txn);
      let new_id = Uuid::new_v4().to_string();
      let clone = blocks.insert(&mut txn, new_id.as_str(), prelim);
      clone.insert(&mut txn, "sys:id", new_id.as_str());
      let Some(yrs::Out::YText(text)) = clone.get(&txn, "prop:text").or_else(|| clone.get(&txn, "text")) else {
        return Err("expanded list block lost its native text".to_string());
      };
      let length = text.len(&txn);
      if length > 0 {
        text.remove_range(&mut txn, 0, length);
      }
      text.insert(&mut txn, 0, &value);
      parent_children.insert(&mut txn, source_index + offset as u32 + 1, new_id.as_str());
    }
  }
  Ok(NativeTemplateInstantiation {
    snapshot: txn.encode_state_as_update_v1(&StateVector::default()),
    unresolved_variables: unresolved.into_iter().collect(),
  })
}

/// Byte ranges for rewriting; inspection projects them to native UTF-16 offsets.
fn native_template_tokens(text: &str) -> Vec<(usize, usize, &str, bool)> {
  let mut tokens = Vec::new();
  let mut cursor = 0;
  loop {
    let opening = text[cursor..].find("{{");
    let closing = text[cursor..].find("}}");
    if closing.is_some_and(|close| opening.is_none_or(|open| close < open)) {
      let start = cursor + closing.unwrap();
      tokens.push((start, start + 2, "", false));
      cursor = start + 2;
      continue;
    }
    let Some(relative) = opening else {
      break;
    };
    let start = cursor + relative;
    let Some(close) = text[start + 2..].find("}}") else {
      tokens.push((start, text.len(), "", false));
      break;
    };
    let end = start + 2 + close + 2;
    let key = text[start + 2..end - 2].trim();
    let valid = native_template_variable_name_is_valid(key);
    tokens.push((start, end, key, valid));
    cursor = end;
  }
  tokens
}

fn rewrite_native_template_chunks(
  chunks: &[(String, Attrs)],
  flavour: &str,
  variables: &HashMap<String, NativeTemplateVariable>,
  unresolved: &mut BTreeSet<String>,
  scoped: bool,
) -> Result<Vec<(String, Attrs)>, String> {
  let text = chunks.iter().map(|(value, _)| value.as_str()).collect::<String>();
  let mut ranges = Vec::with_capacity(chunks.len());
  let mut cursor = 0usize;
  for (value, attrs) in chunks {
    let end = cursor + value.len();
    ranges.push((cursor, end, attrs));
    cursor = end;
  }
  let mut output = Vec::new();
  let mut consumed = 0usize;
  for (start, placeholder_end, key, valid) in native_template_tokens(&text) {
    append_template_literal(&text, consumed, start, &ranges, &mut output);
    if key == "workspace.members"
      || (key.starts_with("member.") && (!scoped || !matches!(key, "member.name" | "member.email")))
    {
      return Err("invalid native template repeat scope".into());
    }
    if !valid {
      append_template_literal(&text, start, placeholder_end, &ranges, &mut output);
    } else if let Some(value) = variables.get(key) {
      let replacement = match value {
        NativeTemplateVariable::String(value) => value.clone(),
        NativeTemplateVariable::StringList(values) => {
          if flavour != "myoxus:list" || text.get(start..placeholder_end) != Some(text.trim()) {
            return Err(format!(
              "string-list variable '{key}' requires an exact list placeholder"
            ));
          }
          values.first().cloned().unwrap_or_default()
        }
        NativeTemplateVariable::Records(_) => return Err("record collection requires a native repeat binding".into()),
      };
      let attrs = ranges
        .iter()
        .find(|(range_start, range_end, _)| *range_start <= start && start < *range_end)
        .map(|(_, _, attrs)| (*attrs).clone())
        .unwrap_or_default();
      output.push((replacement, attrs));
    } else {
      unresolved.insert(key.to_string());
      append_template_literal(&text, start, placeholder_end, &ranges, &mut output);
    }
    consumed = placeholder_end;
  }
  append_template_literal(&text, consumed, text.len(), &ranges, &mut output);
  Ok(output)
}

fn exact_native_template_list_values(
  chunks: &[(String, Attrs)],
  variables: &HashMap<String, NativeTemplateVariable>,
) -> Option<Vec<String>> {
  let text = chunks.iter().map(|(value, _)| value.as_str()).collect::<String>();
  let trimmed = text.trim();
  let key = trimmed.strip_prefix("{{")?.strip_suffix("}}")?.trim();
  if !native_template_variable_name_is_valid(key) {
    return None;
  }
  match variables.get(key)? {
    NativeTemplateVariable::StringList(values) => Some(values.clone()),
    NativeTemplateVariable::String(_) | NativeTemplateVariable::Records(_) => None,
  }
}

fn append_template_literal(
  text: &str,
  start: usize,
  end: usize,
  ranges: &[(usize, usize, &Attrs)],
  output: &mut Vec<(String, Attrs)>,
) {
  if start >= end {
    return;
  }
  for (range_start, range_end, attrs) in ranges {
    let slice_start = start.max(*range_start);
    let slice_end = end.min(*range_end);
    if slice_start < slice_end {
      output.push((text[slice_start..slice_end].to_string(), (*attrs).clone()));
    }
  }
}

fn native_template_variable_name_is_valid(value: &str) -> bool {
  if value.is_empty() || value.len() > 128 {
    return false;
  }
  let mut chars = value.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  (first.is_ascii_alphabetic() || first == '_')
    && chars.all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
}

/// Result of removing page entries from a workspace root doc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootPageRemoval {
  /// Incremental Yjs update containing only the removals.
  pub update: Vec<u8>,
  /// Number of `meta.pages` entries removed. Duplicate entries for the same id
  /// are intentionally removed together to heal stale/phantom root metadata.
  pub removed_entries: usize,
}

/// Incremental cleanup of one retired workspace Tag from compatibility-only
/// root metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootTagRemoval {
  pub update: Vec<u8>,
  pub removed_options: usize,
  pub cleaned_pages: usize,
}

fn any_option_matches_retired_id(value: &Any, retired_ids: &HashSet<&str>) -> bool {
  let Any::Map(option) = value else {
    return false;
  };
  matches!(option.get("id"), Some(Any::String(id)) if retired_ids.contains(id.as_ref()))
}

fn remove_retired_options_from_any(value: &mut Any, retired_ids: &HashSet<&str>) -> usize {
  let Any::Array(options) = value else {
    return 0;
  };
  let before = options.len();
  let retained = options
    .iter()
    .filter(|option| !any_option_matches_retired_id(option, retired_ids))
    .cloned()
    .collect::<Vec<_>>();
  let removed = before - retained.len();
  if removed > 0 {
    *options = retained.into();
  }
  removed
}

fn remove_retired_page_tags_from_any(value: &mut Any, retired_ids: &HashSet<&str>) -> bool {
  let Any::Array(tags) = value else {
    return false;
  };
  let retained = tags
    .iter()
    .filter(|tag| !matches!(tag, Any::String(id) if retired_ids.contains(id.as_ref())))
    .cloned()
    .collect::<Vec<_>>();
  if retained.len() == tags.len() {
    return false;
  }
  *tags = retained.into();
  true
}

/// Remove retired Tag identifiers from the workspace root compatibility
/// projection (`meta.properties.tags.options` and every `meta.pages[].tags`).
///
/// Both shared Y.Map/Y.Array values and older JSON-like scalar values are
/// handled. The canonical catalog remains SQL-owned; this helper only removes
/// stale compatibility references and deliberately emits no update when the
/// semantic projection is already clean.
#[instrument(skip(root_doc_update, retired_tag_ids), fields(retired_count = retired_tag_ids.len(), root_size = root_doc_update.len()))]
pub fn remove_workspace_tags_from_root_doc(
  root_doc_update: &[u8],
  retired_tag_ids: &[String],
) -> Result<RootTagRemoval, String> {
  if root_doc_update.is_empty() || retired_tag_ids.is_empty() {
    return Ok(RootTagRemoval {
      update: Vec::new(),
      removed_options: 0,
      cleaned_pages: 0,
    });
  }
  let retired_ids = retired_tag_ids.iter().map(String::as_str).collect::<HashSet<_>>();
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  let update = Update::decode_v1(root_doc_update)
    .map_err(|error| format!("remove_workspace_tags_from_root_doc: decode failed: {error}"))?;
  doc
    .transact_mut()
    .apply_update(update)
    .map_err(|error| format!("remove_workspace_tags_from_root_doc: apply failed: {error}"))?;
  let state_before = doc.transact().state_vector();
  let mut removed_options = 0;
  let mut cleaned_pages = 0;

  {
    let mut txn = doc.transact_mut();
    match meta.get(&txn, "properties") {
      Some(yrs::Out::YMap(properties)) => match properties.get(&txn, "tags") {
        Some(yrs::Out::YMap(tags)) => match tags.get(&txn, "options") {
          Some(yrs::Out::YArray(options)) => {
            let indexes = options
              .iter(&txn)
              .enumerate()
              .filter_map(|(index, option)| match option {
                yrs::Out::YMap(option) => {
                  matches!(option.get(&txn, "id"), Some(yrs::Out::Any(Any::String(id))) if retired_ids.contains(id.as_ref()))
                    .then_some(index as u32)
                }
                yrs::Out::Any(option) => any_option_matches_retired_id(&option, &retired_ids).then_some(index as u32),
                _ => None,
              })
              .collect::<Vec<_>>();
            for index in indexes.iter().rev() {
              options.remove(&mut txn, *index);
            }
            removed_options += indexes.len();
          }
          Some(yrs::Out::Any(mut options)) => {
            let removed = remove_retired_options_from_any(&mut options, &retired_ids);
            if removed > 0 {
              tags.insert(&mut txn, "options", options);
              removed_options += removed;
            }
          }
          _ => {}
        },
        Some(yrs::Out::Any(Any::Map(tags))) => {
          let mut tags = tags.as_ref().clone();
          let removed = tags
            .get_mut("options")
            .map(|options| remove_retired_options_from_any(options, &retired_ids))
            .unwrap_or(0);
          if removed > 0 {
            properties.insert(&mut txn, "tags", Any::Map(tags.into()));
            removed_options += removed;
          }
        }
        _ => {}
      },
      Some(yrs::Out::Any(Any::Map(properties))) => {
        let mut properties = properties.as_ref().clone();
        let removed = properties
          .get_mut("tags")
          .and_then(|tags| match tags {
            Any::Map(tags) => Some(tags),
            _ => None,
          })
          .and_then(|tags| Arc::make_mut(tags).get_mut("options"))
          .map(|options| remove_retired_options_from_any(options, &retired_ids))
          .unwrap_or(0);
        if removed > 0 {
          meta.insert(&mut txn, "properties", Any::Map(properties.into()));
          removed_options += removed;
        }
      }
      _ => {}
    }

    if let Some(yrs::Out::YArray(pages)) = meta.get(&txn, "pages") {
      let pages = pages
        .iter(&txn)
        .filter_map(|page| match page {
          yrs::Out::YMap(page) => Some(page),
          _ => None,
        })
        .collect::<Vec<_>>();
      for page in pages {
        match page.get(&txn, "tags") {
          Some(yrs::Out::YArray(tags)) => {
            let indexes = tags
              .iter(&txn)
              .enumerate()
              .filter_map(|(index, tag)| {
                matches!(tag, yrs::Out::Any(Any::String(id)) if retired_ids.contains(id.as_ref()))
                  .then_some(index as u32)
              })
              .collect::<Vec<_>>();
            if !indexes.is_empty() {
              for index in indexes.iter().rev() {
                tags.remove(&mut txn, *index);
              }
              cleaned_pages += 1;
            }
          }
          Some(yrs::Out::Any(mut tags)) => {
            if remove_retired_page_tags_from_any(&mut tags, &retired_ids) {
              page.insert(&mut txn, "tags", tags);
              cleaned_pages += 1;
            }
          }
          _ => {}
        }
      }
    }
  }

  if removed_options == 0 && cleaned_pages == 0 {
    return Ok(RootTagRemoval {
      update: Vec::new(),
      removed_options,
      cleaned_pages,
    });
  }
  let update = doc.transact().encode_diff_v1(&state_before);
  Ok(RootTagRemoval {
    update,
    removed_options,
    cleaned_pages,
  })
}

/// Removes client-visible page ids from the workspace root doc's `meta.pages`.
///
/// The function accepts a merged root-doc update, reconstructs the Yjs document,
/// removes matching page entries by their `id` field and returns an incremental
/// update. It does not manipulate the binary codec directly because delete-set
/// preservation is a Yjs semantic requirement for root-doc array removals.
#[instrument(skip(root_doc_update, page_ids), fields(page_count = page_ids.len(), root_size = root_doc_update.len()))]
pub fn remove_pages_from_root_doc(root_doc_update: &[u8], page_ids: &[String]) -> Result<RootPageRemoval, String> {
  if page_ids.is_empty() || root_doc_update.is_empty() {
    return Ok(RootPageRemoval {
      update: Vec::new(),
      removed_entries: 0,
    });
  }

  let target_ids: std::collections::HashSet<&str> = page_ids.iter().map(String::as_str).collect();
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");

  {
    let mut txn = doc.transact_mut();
    let update =
      Update::decode_v1(root_doc_update).map_err(|e| format!("remove_pages_from_root_doc: decode_v1 failed: {e}"))?;
    txn
      .apply_update(update)
      .map_err(|e| format!("remove_pages_from_root_doc: apply_update failed: {e}"))?;
  }

  let sv_before = {
    let txn = doc.transact();
    txn.state_vector()
  };

  let mut indexes_to_remove = Vec::new();
  {
    let txn = doc.transact();
    let pages = match meta.get(&txn, "pages") {
      Some(yrs::Out::YArray(arr)) => arr,
      Some(other) => {
        debug!(?other, "remove_pages_from_root_doc: meta.pages is not a YArray");
        return Ok(RootPageRemoval {
          update: Vec::new(),
          removed_entries: 0,
        });
      }
      None => {
        debug!("remove_pages_from_root_doc: meta.pages missing");
        return Ok(RootPageRemoval {
          update: Vec::new(),
          removed_entries: 0,
        });
      }
    };

    for (idx, item) in pages.iter(&txn).enumerate() {
      let yrs::Out::YMap(page) = item else {
        continue;
      };
      let Some(yrs::Out::Any(yrs::Any::String(id))) = page.get(&txn, "id") else {
        continue;
      };
      if target_ids.contains(id.as_ref()) {
        indexes_to_remove.push(idx as u32);
      }
    }
  }

  if indexes_to_remove.is_empty() {
    return Ok(RootPageRemoval {
      update: Vec::new(),
      removed_entries: 0,
    });
  }

  {
    let mut txn = doc.transact_mut();
    let pages = match meta.get(&txn, "pages") {
      Some(yrs::Out::YArray(arr)) => arr,
      _ => return Err("remove_pages_from_root_doc: meta.pages disappeared before removal".to_string()),
    };
    for idx in indexes_to_remove.iter().rev() {
      pages.remove(&mut txn, *idx);
    }
  }

  let txn = doc.transact();
  let diff = txn.encode_diff_v1(&sv_before);
  debug!(
    requested_pages = page_ids.len(),
    removed_entries = indexes_to_remove.len(),
    diff_size = diff.len(),
    "removed pages from root doc"
  );
  Ok(RootPageRemoval {
    update: diff,
    removed_entries: indexes_to_remove.len(),
  })
}

/// Extracts the state vector from a Yjs v1 update binary.
///
/// Uses yrs `Doc` to decode the update and extract the state vector.
/// This replaces the previous codec-based implementation for consistency
/// with the yrs-based `merge_updates` and `get_missing_diff`.
#[instrument(skip(current_data))]
pub fn get_state_vector(current_data: &[u8]) -> Result<Vec<u8>, String> {
  trace!(data_size = current_data.len(), "extracting yjs state vector (yrs)");
  if current_data.is_empty() {
    debug!("empty input, returning empty state vector");
    return Ok(vec![0]); // encoded empty SV = single varint 0 (zero entries)
  }
  let doc = Doc::new();
  let update = Update::decode_v1(current_data).map_err(|e| format!("yrs decode failed: {e}"))?;
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(update)
      .map_err(|e| format!("yrs apply update failed: {e}"))?;
  }
  let txn = doc.transact();
  let result = txn.state_vector().encode_v1();
  debug!(sv_size = result.len(), "state vector extracted (yrs)");
  Ok(result)
}

// ── P102-TRASH-03: Root-doc page-trash extraction ────────────────────────────

/// One entry from `meta.pages` in a workspace root doc.
///
/// Produced by [`extract_page_trash_state`]. Used by the server to sync
/// SQL document projections with root CRDT metadata on every root-doc
/// push_update.
#[derive(Debug, Clone)]
pub struct TrashEntry {
  /// The page's doc ID string (UUID or system-doc key) as stored in the YMap.
  pub id: String,
  /// The page title as stored in root `meta.pages`, if present.
  pub title: Option<String>,
  /// `true` when the page's `trash` field in the CRDT is `true`.
  pub is_trashed: bool,
}

/// Portable root-document metadata needed by full-workspace import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRootMetadata {
  pub workspace_tags: serde_json::Value,
  pub name: Option<String>,
  pub pages: Vec<WorkspaceRootPage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRootPage {
  pub tags: serde_json::Value,
  /// Distinguishes an explicitly empty legacy assignment from an absent field.
  pub tags_present: bool,
  pub id: String,
  pub title: Option<String>,
  /// Server-authoritative creation time projected into the client directory.
  pub created_at_ms: Option<i64>,
  /// Last server-authoritative update time projected into the client directory.
  pub updated_at_ms: Option<i64>,
  pub order: usize,
  pub is_trashed: bool,
}

// Label metadata has only a catalog array, option maps and scalar values (or an
// assignment string array). Reject nested payloads before recursive conversion.
fn workspace_label_value(
  value: yrs::Out,
  txn: &yrs::Transaction<'_>,
  depth: usize,
) -> Result<serde_json::Value, String> {
  if depth > 3 {
    return Err("workspace label metadata exceeds its nesting limit".into());
  }
  match value {
    yrs::Out::YArray(values) => values
      .iter(txn)
      .map(|value| workspace_label_value(value, txn, depth + 1))
      .collect::<Result<Vec<_>, _>>()
      .map(serde_json::Value::Array),
    yrs::Out::YMap(values) => values
      .iter(txn)
      .map(|(key, value)| Ok((key.to_string(), workspace_label_value(value, txn, depth + 1)?)))
      .collect::<Result<serde_json::Map<_, _>, String>>()
      .map(serde_json::Value::Object),
    yrs::Out::Any(Any::Array(values)) => values
      .iter()
      .cloned()
      .map(|value| workspace_label_value(yrs::Out::Any(value), txn, depth + 1))
      .collect::<Result<Vec<_>, _>>()
      .map(serde_json::Value::Array),
    yrs::Out::Any(Any::Map(values)) => values
      .iter()
      .map(|(key, value)| {
        Ok((
          key.clone(),
          workspace_label_value(yrs::Out::Any(value.clone()), txn, depth + 1)?,
        ))
      })
      .collect::<Result<serde_json::Map<_, _>, String>>()
      .map(serde_json::Value::Object),
    yrs::Out::Any(value) => Ok(yjs_any_to_json(&value)),
    _ => Err("workspace label metadata has an unsupported value type".into()),
  }
}

fn workspace_label_child(value: yrs::Out, key: &str, txn: &yrs::Transaction<'_>) -> Result<Option<yrs::Out>, String> {
  match value {
    yrs::Out::YMap(map) => Ok(map.get(txn, key)),
    yrs::Out::Any(Any::Map(map)) => Ok(map.get(key).cloned().map(yrs::Out::Any)),
    _ => Err("workspace label metadata container must be a map".into()),
  }
}

/// Read workspace name and portable page metadata from a merged root-document
/// update. Trash state is retained because silently dropping those documents
/// would make a full-workspace import lossy. Account and sync metadata remain
/// deliberately excluded.
pub fn extract_workspace_root_metadata(update: &[u8]) -> Result<WorkspaceRootMetadata, String> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  if !update.is_empty() {
    let update = Update::decode_v1(update).map_err(|error| format!("workspace root decode failed: {error}"))?;
    doc
      .transact_mut()
      .apply_update(update)
      .map_err(|error| format!("workspace root apply failed: {error}"))?;
  }
  let txn = doc.transact();
  let name = meta.get(&txn, "name").and_then(|value| match value {
    yrs::Out::Any(Any::String(value)) if !value.trim().is_empty() => Some(value.to_string()),
    _ => None,
  });
  let mut pages = Vec::new();
  let page_values = match meta.get(&txn, "pages") {
    Some(yrs::Out::YArray(values)) => values.iter(&txn).collect::<Vec<_>>(),
    Some(yrs::Out::Any(Any::Array(values))) => values.iter().cloned().map(yrs::Out::Any).collect(),
    None => Vec::new(),
    _ => return Err("workspace root pages must be an array".into()),
  };
  for (order, page) in page_values.into_iter().enumerate() {
    let id = workspace_label_child(page.clone(), "id", &txn)?.and_then(|value| match value {
      yrs::Out::Any(Any::String(value)) if !value.trim().is_empty() => Some(value.to_string()),
      _ => None,
    });
    let id = id.ok_or("workspace root page identity is invalid")?;
    let title = workspace_label_child(page.clone(), "title", &txn)?.and_then(|value| match value {
      yrs::Out::Any(Any::String(value)) if !value.trim().is_empty() => Some(value.to_string()),
      _ => None,
    });
    let timestamp = |key| {
      workspace_label_child(page.clone(), key, &txn).map(|value| {
        value.and_then(|value| match value {
          yrs::Out::Any(Any::Number(value)) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .map(|value| value as i64),
          _ => None,
        })
      })
    };
    let created_at_ms = timestamp("createDate")?;
    let updated_at_ms = timestamp("updatedDate")?;
    let tag_value = workspace_label_child(page.clone(), "tags", &txn)?;
    let tags_present = tag_value.is_some();
    let tags = tag_value
      .map(|value| workspace_label_value(value, &txn, 0))
      .transpose()?
      .unwrap_or_else(|| serde_json::json!([]));
    pages.push(WorkspaceRootPage {
      id,
      title,
      created_at_ms,
      updated_at_ms,
      order,
      tags,
      tags_present,
      is_trashed: matches!(
        workspace_label_child(page, "trash", &txn)?,
        Some(yrs::Out::Any(Any::Bool(true)))
      ),
    });
  }
  let mut options = meta.get(&txn, "properties");
  for key in ["tags", "options"] {
    options = match options {
      Some(value) => workspace_label_child(value, key, &txn)?,
      None => None,
    };
  }
  let workspace_tags = options
    .map(|value| workspace_label_value(value, &txn, 0))
    .transpose()?
    .unwrap_or_else(|| serde_json::json!([]));
  Ok(WorkspaceRootMetadata {
    name,
    pages,
    workspace_tags,
  })
}

pub struct RootLabelReconciliation {
  pub update: Vec<u8>,
  pub catalog_removed: bool,
}

/// Remove only explicitly reconciled page label fields. Unselected fields,
/// including empty arrays, prevent removal of the shared legacy catalog. The
/// caller persists this delta together with its authoritative SQL decisions.
/// Plain JSON values retain their original granularity; no whole-document
/// snapshot replacement or live synchronization policy is introduced here.
pub fn reconcile_workspace_labels_in_root_doc(
  update: &[u8],
  selected: &HashSet<String>,
) -> Result<RootLabelReconciliation, String> {
  let metadata = extract_workspace_root_metadata(update)?;
  let remove_catalog = metadata
    .pages
    .iter()
    .all(|page| !page.tags_present || selected.contains(&page.id));
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  if !update.is_empty() {
    let update = Update::decode_v1(update).map_err(|_| "invalid workspace root update")?;
    doc
      .transact_mut()
      .apply_update(update)
      .map_err(|_| "invalid workspace root state")?;
  }
  let before = doc.transact().state_vector();
  let mut changed = false;
  let mut catalog_removed = false;
  {
    let mut txn = doc.transact_mut();
    match meta.get(&txn, "pages") {
      Some(yrs::Out::YArray(pages)) => {
        for index in 0..pages.len(&txn) {
          match pages.get(&txn, index) {
            Some(yrs::Out::YMap(page)) => {
              if matches!(page.get(&txn, "id"), Some(yrs::Out::Any(Any::String(id))) if selected.contains(id.as_ref()))
              {
                changed |= page.remove(&mut txn, "tags").is_some();
              }
            }
            Some(yrs::Out::Any(Any::Map(page))) => {
              if matches!(page.get("id"), Some(Any::String(id)) if selected.contains(id.as_ref())) {
                let mut page = page.as_ref().clone();
                if page.remove("tags").is_some() {
                  pages.remove(&mut txn, index);
                  pages.insert(&mut txn, index, Any::Map(page.into()));
                  changed = true;
                }
              }
            }
            _ => return Err("invalid workspace root page".into()),
          }
        }
      }
      Some(yrs::Out::Any(Any::Array(pages))) => {
        let mut pages = pages.to_vec();
        for page in &mut pages {
          let Any::Map(page) = page else {
            return Err("invalid workspace root page".into());
          };
          if matches!(page.get("id"), Some(Any::String(id)) if selected.contains(id.as_ref())) {
            changed |= Arc::make_mut(page).remove("tags").is_some();
          }
        }
        if changed {
          meta.insert(&mut txn, "pages", Any::Array(pages.into()));
        }
      }
      None => {}
      _ => return Err("invalid workspace root page list".into()),
    }
    if remove_catalog {
      match meta.get(&txn, "properties") {
        Some(yrs::Out::YMap(properties)) => {
          catalog_removed = properties.remove(&mut txn, "tags").is_some();
        }
        Some(yrs::Out::Any(Any::Map(properties))) => {
          let mut properties = properties.as_ref().clone();
          catalog_removed = properties.remove("tags").is_some();
          if catalog_removed {
            meta.insert(&mut txn, "properties", Any::Map(properties.into()));
          }
        }
        None => {}
        _ => return Err("invalid workspace root properties".into()),
      }
    }
  }
  let update = if changed || catalog_removed {
    doc.transact().encode_diff_v1(&before)
  } else {
    Vec::new()
  };
  Ok(RootLabelReconciliation {
    update,
    catalog_removed,
  })
}

fn extract_page_trash_state_from_doc(doc: &Doc, meta: &yrs::MapRef) -> Vec<TrashEntry> {
  let txn = doc.transact();

  let pages_arr = match meta.get(&txn, "pages") {
    Some(yrs::Out::YArray(arr)) => arr,
    Some(other) => {
      debug!("extract_page_trash_state: meta.pages is not a YArray ({other:?}), returning empty");
      return Vec::new();
    }
    None => {
      debug!("extract_page_trash_state: meta.pages not found, returning empty");
      return Vec::new();
    }
  };

  let mut entries = Vec::new();
  let mut skipped = 0usize;

  for item in pages_arr.iter(&txn) {
    if let yrs::Out::YMap(map) = item {
      // Extract the page ID — skip entries without a valid string id.
      let id = match map.get(&txn, "id") {
        Some(yrs::Out::Any(yrs::Any::String(s))) => s.to_string(),
        _ => {
          skipped += 1;
          continue;
        }
      };
      let title = match map.get(&txn, "title") {
        Some(yrs::Out::Any(yrs::Any::String(s))) => Some(s.to_string()),
        None | Some(yrs::Out::Any(yrs::Any::Undefined)) => None,
        Some(unexpected) => {
          warn!(%id, ?unexpected, "extract_page_trash_state: title field has unexpected type, ignoring");
          None
        }
      };
      // Only a boolean true marks a page as trashed. Accepting string/number
      // lookalikes here would make malformed root metadata silently destructive.
      let is_trashed = match map.get(&txn, "trash") {
        Some(yrs::Out::Any(yrs::Any::Bool(b))) => b,
        None | Some(yrs::Out::Any(yrs::Any::Undefined)) => false,
        Some(unexpected) => {
          warn!(%id, ?unexpected, "extract_page_trash_state: trash field has unexpected type, treating as false");
          false
        }
      };
      trace!(%id, ?title, is_trashed, "page root metadata entry extracted");
      entries.push(TrashEntry { id, title, is_trashed });
    } else {
      skipped += 1;
    }
  }

  // Deduplicate by page_id: any-trash-wins (LRN-20260405-290).
  // CRDT merge can produce two YMap entries for the same page_id when clients
  // with different client IDs each insert the page into the YArray. In that case
  // both entries survive the merge. If one says trash=true and the other doesn't,
  // the page is treated as trashed (conservative — data preservation over visibility).
  let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::with_capacity(entries.len());
  let mut deduped: Vec<TrashEntry> = Vec::with_capacity(entries.len());
  let mut duplicate_count = 0usize;

  for entry in entries {
    if let Some(&idx) = seen.get(&entry.id) {
      duplicate_count += 1;
      if entry.is_trashed && !deduped[idx].is_trashed {
        warn!(
          id = %entry.id,
          "extract_page_trash_state: duplicate page_id, upgrading to trashed (any-trash-wins, LRN-20260405-290)"
        );
        deduped[idx].is_trashed = true;
      } else {
        warn!(
          id = %entry.id,
          is_trashed = entry.is_trashed,
          "extract_page_trash_state: duplicate page_id discarded (LRN-20260405-290)"
        );
      }
      if entry.title.as_deref().is_some_and(|title| !title.is_empty()) {
        let existing_title = deduped[idx].title.as_deref().unwrap_or("");
        if existing_title != entry.title.as_deref().unwrap_or("") {
          warn!(
            id = %entry.id,
            existing_title,
            incoming_title = entry.title.as_deref().unwrap_or(""),
            "extract_page_trash_state: duplicate page_id title conflict, preferring latest non-empty root title"
          );
        }
        deduped[idx].title = entry.title;
      }
    } else {
      seen.insert(entry.id.clone(), deduped.len());
      deduped.push(entry);
    }
  }

  if duplicate_count > 0 {
    warn!(
      duplicate_count,
      unique_pages = deduped.len(),
      "extract_page_trash_state: root-doc has duplicate page entries — CRDT state is inconsistent"
    );
  }

  debug!(
    entries = deduped.len(),
    skipped,
    duplicate_count,
    trashed = deduped.iter().filter(|e| e.is_trashed).count(),
    "extract_page_trash_state complete"
  );
  deduped
}

/// Extracts page/trash state from root-doc updates applied in storage order.
///
/// This mirrors the state reconstructed by syncing clients and by
/// [`add_pages_to_root_doc`]: optional compacted snapshot first, then pending
/// root updates in sequence. Out-of-band writers such as the seed importer must
/// dedupe against this client-visible state, not against raw strings that may
/// still be present in tombstoned CRDT structs.
#[instrument(skip(updates), fields(update_count = updates.len()))]
pub fn extract_page_trash_state_from_updates(updates: &[Vec<u8>]) -> Result<Vec<TrashEntry>, String> {
  if updates.iter().all(Vec::is_empty) {
    debug!("extract_page_trash_state_from_updates: empty input, returning empty list");
    return Ok(Vec::new());
  }

  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");

  for (index, data) in updates.iter().enumerate() {
    if data.is_empty() {
      continue;
    }
    let update = Update::decode_v1(data).map_err(|e| {
      format!(
        "extract_page_trash_state_from_updates: decode_v1 update {} failed: {e}",
        index + 1
      )
    })?;
    {
      let mut txn = doc.transact_mut();
      txn.apply_update(update).map_err(|e| {
        format!(
          "extract_page_trash_state_from_updates: apply_update update {} failed: {e}",
          index + 1
        )
      })?;
    }
  }

  Ok(extract_page_trash_state_from_doc(&doc, &meta))
}

/// Extracts the trash state of all pages from a merged root-doc Yjs binary.
///
/// Reads `rootDoc.getMap('meta').get('pages')` — a `YArray<YMap>` where each
/// entry represents a workspace page. For each entry that has a valid `id`
/// string, one [`TrashEntry`] is returned. Pages without an `id` field are
/// skipped silently (malformed entries).
///
/// **Input contract**: `data` must be a FULLY MERGED Yjs v1 binary — i.e. the
/// merged result of `merge_updates(snapshot + pending_updates)`. Passing a
/// single delta update will produce an incomplete page list. Behavior on
/// partially-merged input: incomplete pages list (some trash state may be
/// missing). No error is returned in that case.
///
/// **Duplicate page IDs**: If `meta.pages` contains two YMap entries with the
/// same `id` (can occur with certain CRDT merge patterns / LRN-20260405-290),
/// duplicates are deduplicated with **any-trash-wins** semantics: if ANY entry
/// for a page_id has `trash = true`, the returned `TrashEntry` has
/// `is_trashed = true`. A `warn!` is emitted for each deduplicated entry.
/// The returned `Vec` always has at most one entry per page_id.
///
/// **`trash` field type safety**: Only `Bool(true)` is treated as trashed.
/// Unexpected types (String, Number, etc.) emit a WARN log and are treated as
/// false (not trashed). This prevents silent data loss if the client serializes
/// the trash flag incorrectly.
///
/// # Arguments
/// * `data` — merged root-doc Yjs v1 binary
///
/// # Returns
/// `Vec<TrashEntry>` — one entry per valid `meta.pages` element. Empty if no
/// `meta.pages` array is found (e.g. freshly created workspace without pages).
///
/// # Errors
/// Returns `Err(String)` if the binary cannot be decoded as a Yjs v1 update.
/// This should only happen if `data` is corrupt or not a Yjs binary at all.
#[instrument(skip(data), fields(data_size = data.len()))]
pub fn extract_page_trash_state(data: &[u8]) -> Result<Vec<TrashEntry>, String> {
  if data.is_empty() {
    debug!("extract_page_trash_state: empty input, returning empty list");
    return Ok(Vec::new());
  }

  let doc = Doc::new();
  // Pre-register the meta map BEFORE applying the update.
  // yrs panics if get_or_insert_* is called while any transaction is open.
  let meta = doc.get_or_insert_map("meta");

  {
    let mut txn = doc.transact_mut();
    let update = Update::decode_v1(data).map_err(|e| format!("extract_page_trash_state: decode_v1 failed: {e}"))?;
    txn
      .apply_update(update)
      .map_err(|e| format!("extract_page_trash_state: apply_update failed: {e}"))?;
  }

  Ok(extract_page_trash_state_from_doc(&doc, &meta))
}

/// Normalises a block flavour string for server-side import/read boundaries.
///
/// True one-to-one legacy `affine:*` aliases map to their canonical
/// `myoxus:*` names. Semantic exceptions such as `affine:heading` project to
/// the active storage flavour (`myoxus:paragraph`) and must be interpreted from
/// their props by the caller. The function returns canonical or unknown names
/// unchanged.
pub fn resolve_flavour(flavour: &str) -> &str {
  match flavour {
    "affine:page" => "myoxus:page",
    "affine:note" => "myoxus:note",
    "affine:paragraph" => "myoxus:paragraph",
    // There is no active `myoxus:heading` storage schema. Legacy headings are
    // projected onto the active paragraph storage flavour and rendered by
    // their level/type props in reader code.
    "affine:heading" => "myoxus:paragraph",
    "affine:list" => "myoxus:list",
    "affine:code" => "myoxus:code",
    "affine:divider" => "myoxus:divider",
    "affine:callout" => "myoxus:callout",
    "affine:image" => "myoxus:image",
    "affine:attachment" => "myoxus:attachment",
    "affine:bookmark" => "myoxus:bookmark",
    "affine:database" => "myoxus:database",
    "affine:table" => "myoxus:table",
    "affine:latex" => "myoxus:latex",
    "affine:frame" => "myoxus:frame",
    "affine:surface-ref" => "myoxus:surface-ref",
    "affine:edgeless-text" => "myoxus:edgeless-text",
    "affine:surface" => "myoxus:surface",
    "affine:embed-iframe" => "myoxus:embed-iframe",
    "affine:embed-figma" => "myoxus:embed-figma",
    "affine:embed-github" => "myoxus:embed-github",
    "affine:embed-youtube" => "myoxus:embed-youtube",
    "affine:embed-loom" => "myoxus:embed-loom",
    "affine:embed-html" => "myoxus:embed-html",
    "affine:embed-linked-doc" => "myoxus:embed-linked-doc",
    "affine:embed-synced-doc" => "myoxus:embed-synced-doc",
    other => other,
  }
}

/// Minimal, stable block projection for server-side document-version diffs.
///
/// The projection intentionally keeps only fields that are meaningful for a
/// user-visible diff: canonical block flavour, rendered text content and child
/// references. Rich renderer-only properties stay out of this contract so the
/// diff remains stable across unrelated export/presentation changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YjsBlockInfo {
  pub id: String,
  pub flavour: String,
  /// Deployed named-version summary, including native rich-text formatting.
  pub text: String,
  /// Authored prose only; presentation and embeds are reported separately.
  pub plain_text: String,
  pub children_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YjsBlockExtractResult {
  pub blocks: Vec<YjsBlockInfo>,
  pub extraction_partial: bool,
}

/// Neutral document-reference kind extracted from a Yjs document snapshot.
///
/// This type deliberately lives in the `yjs` crate, not in the domain crate: it
/// describes only what the CRDT snapshot contains. The application layer maps
/// it to the Document Graph domain model and performs workspace/document
/// existence checks, ACL redaction and persistence decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentReferenceLinkKind {
  InlineReference,
  EmbedLinkedDoc,
  EmbedSyncedDoc,
  SurfaceRef,
  DatabaseCellReference,
}

impl DocumentReferenceLinkKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::InlineReference => "inline_reference",
      Self::EmbedLinkedDoc => "embed_linked_doc",
      Self::EmbedSyncedDoc => "embed_synced_doc",
      Self::SurfaceRef => "surface_ref",
      Self::DatabaseCellReference => "database_cell_reference",
    }
  }
}

/// Exact native location, independent of application resource identities or policy.
/// Text offsets use the document's UTF-16 coordinate space; ordinary string
/// properties, block IDs and local footnote definition IDs are never selectors.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeReferencePosition {
  BlockProperty {
    block_id: String,
    property: String,
  },
  TextAttribute {
    block_id: String,
    property: String,
    start: u32,
    length: u32,
    attribute: String,
    path: Vec<String>,
  },
}

/// A caller-admitted change at one extracted native occurrence. IDs here are
/// codec values: workspace/kind resolution and keep/remap/omit policy belong
/// to application, whose qualified resource addresses remain authoritative.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NativeReferenceRewrite {
  pub position: NativeReferencePosition,
  pub expected_id: String,
  pub expected_workspace_id: Option<String>,
  /// None omits only a reference annotation/atom or reference-only block.
  pub replacement: Option<NativeReferenceReplacement>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NativeReferenceReplacement {
  pub id: String,
  pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeReferenceRewriteResult {
  pub full_state: Vec<u8>,
  pub incremental_update: Vec<u8>,
}

/// One raw document-reference occurrence found inside a Yjs snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentReferenceOccurrence {
  pub source_block_id: String,
  pub source_parent_block_id: Option<String>,
  pub source_parent_flavour: Option<String>,
  pub raw_target_doc_id: String,
  /// Absence is legacy containing-workspace meaning. A present malformed value
  /// must not be converted to absence by application resolution.
  pub target_workspace_id: Option<String>,
  pub position: NativeReferencePosition,
  pub link_kind: DocumentReferenceLinkKind,
  pub params_json: serde_json::Value,
  pub markdown_preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentReferenceExtraction {
  pub occurrences: Vec<DocumentReferenceOccurrence>,
  pub extraction_partial: bool,
}

/// Native Database properties have the same scoped/flat/nested reader contract.
/// Undefined optional schema defaults are absent; null or malformed values are
/// present and must not expose cached table contents.
fn has_database_reference_property<T: ReadTxn>(block: &yrs::MapRef, txn: &T, key: &str) -> bool {
  let scoped = format!("prop:{key}");
  let dotted = format!("{key}.");
  let scoped_dotted = format!("{scoped}.");
  // Portable snapshots flatten object properties; their descendants still mark
  // a private reference, even when the marker is malformed or incomplete.
  let matches_property = |candidate: &str| candidate == key || candidate.starts_with(&dotted);
  block.iter(txn).any(|(candidate, value)| {
    (matches_property(candidate) || candidate == scoped || candidate.starts_with(&scoped_dotted))
      && !matches!(value, yrs::Out::Any(Any::Undefined))
  }) || match block.get(txn, "props") {
    Some(yrs::Out::YMap(props)) => props
      .iter(txn)
      .any(|(candidate, value)| matches_property(candidate) && !matches!(value, yrs::Out::Any(Any::Undefined))),
    Some(yrs::Out::Any(Any::Map(props))) => props
      .iter()
      .any(|(candidate, value)| matches_property(candidate) && !matches!(value, Any::Undefined)),
    _ => false,
  }
}

/// Presence, including malformed data, prevents fallthrough to legacy table payloads.
pub fn has_database_row_reference<T: ReadTxn>(block: &yrs::MapRef, txn: &T) -> bool {
  has_database_reference_property(block, txn, "serverRowId")
}

/// Compact references and authoring slots are opaque even if malformed. A
/// missing Row identity must never turn their cached children into public data.
pub fn has_opaque_database_reference<T: ReadTxn>(block: &yrs::MapRef, txn: &T) -> bool {
  has_database_row_reference(block, txn)
    || has_database_reference_property(block, txn, "serverReferencePresentation")
    || has_database_reference_property(block, txn, "templateReference")
}

/// Exclude opaque descendants before rich-text/footer materialization, including
/// the rootless renderer fallback.
pub fn opaque_database_reference_descendants<T: ReadTxn>(blocks: &yrs::MapRef, txn: &T) -> HashSet<String> {
  let mut pending = blocks
    .iter(txn)
    .flat_map(|(_, value)| match value {
      yrs::Out::YMap(block)
        if resolve_flavour(&block_string(&block, txn, "flavour").unwrap_or_default()) == "myoxus:database"
          && has_opaque_database_reference(&block, txn) =>
      {
        block_children(&block, txn)
      }
      _ => Vec::new(),
    })
    .collect::<Vec<_>>();
  let mut hidden = HashSet::new();
  while let Some(id) = pending.pop() {
    if !hidden.insert(id.clone()) {
      continue;
    }
    if let Some(yrs::Out::YMap(block)) = blocks.get(txn, &id) {
      pending.extend(block_children(&block, txn));
    }
  }
  hidden
}

/// A Row is addressed by the complete scoped tuple, never a View or bare Row ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseRowReference {
  pub workspace_id: Uuid,
  pub database_id: Uuid,
  pub row_id: Uuid,
}

/// Rewrite only complete tuples admitted by the caller's actual publication mapping.
/// Missing/malformed/foreign references and prose keep their original values.
#[instrument(skip_all)]
pub fn rewrite_database_row_references(
  update: &[u8],
  mappings: &[(DatabaseRowReference, DatabaseRowReference)],
  client_id: u64,
) -> Result<NativeReferenceRewriteResult, String> {
  if mappings.is_empty() {
    return Ok(NativeReferenceRewriteResult {
      full_state: update.to_vec(),
      incremental_update: Vec::new(),
    });
  }
  let doc = Doc::with_client_id(client_id);
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(update).map_err(|_| "Row reference decode failed")?)
      .map_err(|_| "Row reference apply failed")?;
  }
  let before = doc.transact().state_vector();
  let mut txn = doc.transact_mut();
  let mut changed = false;
  let database_blocks = blocks
    .iter(&txn)
    .filter_map(|(_, value)| match value {
      yrs::Out::YMap(block) => Some(block),
      _ => None,
    })
    .collect::<Vec<_>>();
  for block in database_blocks {
    if resolve_flavour(&block_string(&block, &txn, "flavour").unwrap_or_default()) != "myoxus:database" {
      continue;
    }
    if block_prop_json(&block, &txn, "serverViewId").is_some_and(|value| !value.is_null()) {
      continue;
    }
    let parse = |key| block_prop_string(&block, &txn, key).and_then(|id| Uuid::parse_str(&id).ok());
    let (Some(workspace_id), Some(database_id), Some(row_id)) = (
      parse("serverWorkspaceId"),
      parse("serverDatabaseId"),
      parse("serverRowId"),
    ) else {
      continue;
    };
    let current = DatabaseRowReference {
      workspace_id,
      database_id,
      row_id,
    };
    let Some((_, target)) = mappings.iter().find(|(source, _)| source == &current) else {
      continue;
    };
    if &current == target {
      continue;
    }
    if before.contains_client(&yrs::ClientID::new(client_id)) {
      return Err("Row reference writer collides with source".into());
    }
    changed = true;
    for (key, value) in [
      ("serverWorkspaceId", target.workspace_id),
      ("serverDatabaseId", target.database_id),
      ("serverRowId", target.row_id),
    ] {
      let prefixed = format!("prop:{key}");
      if block.get(&txn, &prefixed).is_some() {
        block.insert(&mut txn, prefixed, value.to_string());
      } else if block.get(&txn, key).is_some() {
        block.insert(&mut txn, key, value.to_string());
      } else if let Some(yrs::Out::YMap(props)) = block.get(&txn, "props") {
        props.insert(&mut txn, key, value.to_string());
      } else {
        return Err("Row reference property disappeared".into());
      }
    }
  }
  // An encoded empty Yjs diff can still carry a historical delete set. Return
  // the caller's actual no-change signal without manufacturing a stream write.
  if !changed {
    return Ok(NativeReferenceRewriteResult {
      full_state: update.to_vec(),
      incremental_update: Vec::new(),
    });
  }
  Ok(NativeReferenceRewriteResult {
    full_state: txn.encode_state_as_update_v1(&StateVector::default()),
    incremental_update: txn.encode_state_as_update_v1(&before),
  })
}

/// One row owned by an editor-local Database block before server migration.
#[derive(Debug, Clone, PartialEq)]
pub struct LegacyDatabaseRow {
  pub source_id: String,
  pub title: String,
}

/// Neutral legacy Database payload extracted from a persisted Yjs document.
///
/// The extractor intentionally does not understand Myoxus Database domain
/// rules. The application migration planner validates and maps these source
/// values, while this type preserves enough structure to distinguish a full
/// editor-local payload from an already reference-only block.
#[derive(Debug, Clone, PartialEq)]
pub struct LegacyDatabaseBlock {
  pub block_id: String,
  pub source_database_id: Option<String>,
  pub title: String,
  pub columns: serde_json::Value,
  pub views: serde_json::Value,
  pub cells: serde_json::Value,
  pub rows: Vec<LegacyDatabaseRow>,
  pub server_database_id: Option<String>,
  pub server_view_id: Option<String>,
}

/// One blob-backed source reference retained by a portable Yjs block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableAssetReference {
  pub block_id: String,
  pub source_key: String,
  pub raw_source_key: String,
  pub workspace_id: Option<String>,
  pub position: NativeReferencePosition,
}

/// Target reference for one validated editor-local Database block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyDatabaseReferenceRewrite {
  pub block_id: String,
  pub server_database_id: Uuid,
  pub server_view_id: Option<Uuid>,
}

/// Both persistence forms produced by a Database reference rewrite.
/// Existing documents append `incremental_update`; newly imported documents
/// persist only `full_state` and therefore never expose the legacy payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyDatabaseRewriteResult {
  pub incremental_update: Vec<u8>,
  pub full_state: Vec<u8>,
  pub rewritten_block_count: usize,
}

impl LegacyDatabaseBlock {
  pub fn is_reference_only(&self) -> bool {
    self.server_database_id.as_ref().is_some_and(|id| !id.trim().is_empty())
      && self.columns.as_array().is_some_and(Vec::is_empty)
      && self.views.as_array().is_some_and(Vec::is_empty)
      && self.cells.as_object().is_some_and(serde_json::Map::is_empty)
      && self.rows.is_empty()
  }
}

fn yjs_any_to_json(value: &Any) -> serde_json::Value {
  match value {
    Any::Null | Any::Undefined => serde_json::Value::Null,
    Any::Bool(value) => serde_json::Value::Bool(*value),
    Any::Number(value) => value
      .as_f64()
      .and_then(serde_json::Number::from_f64)
      .or_else(|| value.as_i64().map(Into::into))
      .map(serde_json::Value::Number)
      .unwrap_or(serde_json::Value::Null),
    Any::BigInt(value) => serde_json::Value::Number(serde_json::Number::from(*value)),
    Any::String(value) => serde_json::Value::String(value.to_string()),
    Any::Array(values) => serde_json::Value::Array(values.iter().map(yjs_any_to_json).collect()),
    Any::Map(map) => {
      let mut out = serde_json::Map::new();
      for (key, value) in map.iter() {
        out.insert(key.to_string(), yjs_any_to_json(value));
      }
      serde_json::Value::Object(out)
    }
    _ => serde_json::Value::Null,
  }
}

fn yjs_out_to_json<T: ReadTxn>(value: yrs::Out, txn: &T) -> serde_json::Value {
  match value {
    yrs::Out::Any(value) => yjs_any_to_json(&value),
    yrs::Out::YArray(array) => {
      serde_json::Value::Array(array.iter(txn).map(|value| yjs_out_to_json(value, txn)).collect())
    }
    yrs::Out::YMap(map) => {
      let mut output = serde_json::Map::new();
      for (key, value) in map.iter(txn) {
        output.insert(key.to_string(), yjs_out_to_json(value, txn));
      }
      serde_json::Value::Object(output)
    }
    yrs::Out::YText(text) => serde_json::Value::String(text.get_string(txn)),
    _ => serde_json::Value::Null,
  }
}

fn yjs_any_to_string(value: &Any) -> Option<String> {
  match value {
    Any::String(value) => Some(value.to_string()),
    Any::Number(value) => Some(value.to_string()),
    Any::BigInt(value) => Some(value.to_string()),
    _ => None,
  }
}

fn block_string<T: ReadTxn>(block_map: &yrs::MapRef, txn: &T, key: &str) -> Option<String> {
  let prefixed = format!("sys:{key}");
  block_map
    .get(txn, &prefixed)
    .or_else(|| block_map.get(txn, key))
    .and_then(|value| match value {
      yrs::Out::Any(Any::String(value)) => Some(value.to_string()),
      _ => None,
    })
}

fn block_prop_string<T: ReadTxn>(block_map: &yrs::MapRef, txn: &T, key: &str) -> Option<String> {
  let prefixed = format!("prop:{key}");
  if let Some(value) = block_map.get(txn, &prefixed).or_else(|| block_map.get(txn, key)) {
    match value {
      yrs::Out::Any(Any::String(value)) => return Some(value.to_string()),
      yrs::Out::Any(Any::Number(value)) => return Some(value.to_string()),
      yrs::Out::Any(Any::BigInt(value)) => return Some(value.to_string()),
      yrs::Out::YText(text) => return Some(text.get_string(txn)),
      _ => {}
    }
  }
  block_map.get(txn, "props").and_then(|value| match value {
    yrs::Out::YMap(props) => props.get(txn, key).and_then(|value| match value {
      yrs::Out::Any(Any::String(value)) => Some(value.to_string()),
      yrs::Out::Any(Any::Number(value)) => Some(value.to_string()),
      yrs::Out::Any(Any::BigInt(value)) => Some(value.to_string()),
      yrs::Out::YText(text) => Some(text.get_string(txn)),
      _ => None,
    }),
    _ => None,
  })
}

fn insert_json_path(target: &mut serde_json::Map<String, serde_json::Value>, path: &[&str], value: serde_json::Value) {
  let Some((head, tail)) = path.split_first() else {
    return;
  };
  if tail.is_empty() {
    target.insert((*head).to_string(), value);
    return;
  }
  let child = target
    .entry((*head).to_string())
    .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
  if !child.is_object() {
    *child = serde_json::Value::Object(serde_json::Map::new());
  }
  insert_json_path(
    child
      .as_object_mut()
      .expect("JSON path child was initialized as an object"),
    tail,
    value,
  );
}

fn collect_flat_block_prop<T: ReadTxn>(
  map: &yrs::MapRef,
  txn: &T,
  prefix: &str,
  output: &mut serde_json::Map<String, serde_json::Value>,
) {
  for (stored_key, value) in map.iter(txn) {
    let Some(path) = stored_key.strip_prefix(prefix) else {
      continue;
    };
    let segments = path
      .split('.')
      .filter(|segment| !segment.is_empty())
      .collect::<Vec<_>>();
    if !segments.is_empty() {
      insert_json_path(output, &segments, yjs_out_to_json(value, txn));
    }
  }
}

fn block_prop_json<T: ReadTxn>(block_map: &yrs::MapRef, txn: &T, key: &str) -> Option<serde_json::Value> {
  let prefixed = format!("prop:{key}");
  if let Some(value) = block_map.get(txn, &prefixed).or_else(|| block_map.get(txn, key)) {
    return Some(yjs_out_to_json(value, txn));
  }
  let mut flattened = serde_json::Map::new();
  collect_flat_block_prop(block_map, txn, &format!("{prefixed}."), &mut flattened);
  collect_flat_block_prop(block_map, txn, &format!("{key}."), &mut flattened);
  if let Some(yrs::Out::YMap(props)) = block_map.get(txn, "props") {
    if let Some(value) = props.get(txn, key) {
      return Some(yjs_out_to_json(value, txn));
    }
    collect_flat_block_prop(&props, txn, &format!("{key}."), &mut flattened);
  }
  (!flattened.is_empty()).then_some(serde_json::Value::Object(flattened))
}

fn block_children<T: ReadTxn>(block_map: &yrs::MapRef, txn: &T) -> Vec<String> {
  block_map
    .get(txn, "sys:children")
    .or_else(|| block_map.get(txn, "children"))
    .and_then(|value| match value {
      yrs::Out::YArray(array) => Some(
        array
          .iter(txn)
          .filter_map(|item| match item {
            yrs::Out::Any(Any::String(value)) => Some(value.to_string()),
            _ => None,
          })
          .collect(),
      ),
      yrs::Out::Any(Any::Array(array)) => Some(array.iter().filter_map(yjs_any_to_string).collect()),
      _ => None,
    })
    .unwrap_or_default()
}

/// Extract every canonical or aliased editor-local Database block from a Yjs
/// v1 document. `affine:database` is resolved through [`resolve_flavour`], so
/// callers never implement a second alias branch.
#[instrument(skip(update))]
pub fn extract_legacy_database_blocks(update: &[u8]) -> Result<Vec<LegacyDatabaseBlock>, String> {
  if update.is_empty() {
    return Ok(Vec::new());
  }
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    let update = Update::decode_v1(update).map_err(|error| format!("legacy Database decode failed: {error}"))?;
    txn
      .apply_update(update)
      .map_err(|error| format!("legacy Database apply failed: {error}"))?;
  }
  let txn = doc.transact();
  let block_maps = blocks
    .iter(&txn)
    .filter_map(|(id, value)| match value {
      yrs::Out::YMap(map) => Some((id.to_string(), map)),
      _ => None,
    })
    .collect::<HashMap<_, _>>();
  let mut databases = Vec::new();
  for (block_id, block) in &block_maps {
    let raw_flavour = block_string(block, &txn, "flavour").unwrap_or_default();
    if resolve_flavour(&raw_flavour) != "myoxus:database" {
      continue;
    }
    if has_opaque_database_reference(block, &txn) {
      continue;
    }
    let rows = block_children(block, &txn)
      .into_iter()
      .map(|source_id| {
        let title = block_maps
          .get(&source_id)
          .and_then(|row| block_prop_string(row, &txn, "text").or_else(|| block_prop_string(row, &txn, "title")))
          .unwrap_or_default();
        LegacyDatabaseRow { source_id, title }
      })
      .collect();
    databases.push(LegacyDatabaseBlock {
      source_database_id: block_prop_string(block, &txn, "databaseId"),
      title: block_prop_string(block, &txn, "title").unwrap_or_default(),
      columns: block_prop_json(block, &txn, "columns").unwrap_or_else(|| serde_json::json!([])),
      views: block_prop_json(block, &txn, "views").unwrap_or_else(|| serde_json::json!([])),
      cells: block_prop_json(block, &txn, "cells").unwrap_or_else(|| serde_json::json!({})),
      rows,
      server_database_id: block_prop_string(block, &txn, "serverDatabaseId"),
      server_view_id: block_prop_string(block, &txn, "serverViewId"),
      block_id: block_id.clone(),
    });
  }
  databases.sort_by(|left, right| left.block_id.cmp(&right.block_id));
  Ok(databases)
}

/// Replace validated editor-local Database blocks with reference-only props.
///
/// The function is intentionally structural: it removes every legacy schema,
/// view, cell and row source from all supported historical property layouts,
/// removes the Database-owned row blocks, and emits a Yjs delta against the
/// supplied state. Callers never construct or persist replacement snapshots.
#[instrument(skip(update, rewrites))]
pub fn rewrite_legacy_database_references(
  update: &[u8],
  rewrites: &[LegacyDatabaseReferenceRewrite],
) -> Result<LegacyDatabaseRewriteResult, String> {
  if rewrites.is_empty() {
    return Ok(LegacyDatabaseRewriteResult {
      incremental_update: vec![0, 0],
      full_state: update.to_vec(),
      rewritten_block_count: 0,
    });
  }
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    let update =
      Update::decode_v1(update).map_err(|error| format!("legacy Database rewrite decode failed: {error}"))?;
    txn
      .apply_update(update)
      .map_err(|error| format!("legacy Database rewrite apply failed: {error}"))?;
  }
  let state_before = doc.transact().state_vector();
  let mut rewritten_block_count = 0;
  {
    let mut txn = doc.transact_mut();
    for rewrite in rewrites {
      let block = blocks
        .get(&txn, &rewrite.block_id)
        .and_then(|value| match value {
          yrs::Out::YMap(block) => Some(block),
          _ => None,
        })
        .ok_or_else(|| format!("legacy Database rewrite block '{}' is missing", rewrite.block_id))?;
      let raw_flavour = block_string(&block, &txn, "flavour").unwrap_or_default();
      if resolve_flavour(&raw_flavour) != "myoxus:database" {
        return Err(format!(
          "legacy Database rewrite block '{}' has the wrong flavour",
          rewrite.block_id
        ));
      }
      let row_ids = block_children(&block, &txn);
      for key in [
        "databaseId",
        "title",
        "columns",
        "views",
        "cells",
        "prop:databaseId",
        "prop:title",
        "prop:columns",
        "prop:views",
        "prop:cells",
      ] {
        block.remove(&mut txn, key);
      }
      let flattened_payload_keys = block
        .iter(&txn)
        .map(|(key, _)| key.to_string())
        .filter(|key| {
          ["databaseId", "title", "columns", "views", "cells"]
            .iter()
            .any(|property| key.starts_with(&format!("{property}.")) || key.starts_with(&format!("prop:{property}.")))
        })
        .collect::<Vec<_>>();
      for key in flattened_payload_keys {
        block.remove(&mut txn, &key);
      }
      if let Some(yrs::Out::YMap(props)) = block.get(&txn, "props") {
        for key in ["databaseId", "title", "columns", "views", "cells"] {
          props.remove(&mut txn, key);
        }
        let flattened_payload_keys = props
          .iter(&txn)
          .map(|(key, _)| key.to_string())
          .filter(|key| {
            ["databaseId", "title", "columns", "views", "cells"]
              .iter()
              .any(|property| key.starts_with(&format!("{property}.")))
          })
          .collect::<Vec<_>>();
        for key in flattened_payload_keys {
          props.remove(&mut txn, &key);
        }
        props.insert(&mut txn, "serverDatabaseId", rewrite.server_database_id.to_string());
        if let Some(view_id) = rewrite.server_view_id {
          props.insert(&mut txn, "serverViewId", view_id.to_string());
        } else {
          props.remove(&mut txn, "serverViewId");
        }
      } else {
        block.insert(
          &mut txn,
          "prop:serverDatabaseId",
          rewrite.server_database_id.to_string(),
        );
        if let Some(view_id) = rewrite.server_view_id {
          block.insert(&mut txn, "prop:serverViewId", view_id.to_string());
        } else {
          block.remove(&mut txn, "prop:serverViewId");
        }
      }
      block.remove(&mut txn, "sys:children");
      block.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
      block.remove(&mut txn, "children");
      for row_id in row_ids {
        blocks.remove(&mut txn, row_id.as_str());
      }
      rewritten_block_count += 1;
    }
  }
  let txn = doc.transact();
  let incremental_update = txn.encode_state_as_update_v1(&state_before);
  let full_state = txn.encode_state_as_update_v1(&StateVector::default());
  drop(txn);

  let remaining = extract_legacy_database_blocks(&full_state)?;
  if remaining.iter().any(|block| !block.is_reference_only()) {
    return Err("legacy Database rewrite retained editor-local payload".to_string());
  }
  Ok(LegacyDatabaseRewriteResult {
    incremental_update,
    full_state,
    rewritten_block_count,
  })
}

/// Convert the allowlisted snapshot block representation into a normal Yjs v1
/// document before application-owned reference rewrites run.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSnapshotBlock {
  pub id: String,
  pub flavour: String,
  // The Snapshot decoder accepts an absent version, but not an explicit null.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub version: Option<u64>,
  #[serde(default)]
  pub props: serde_json::Map<String, serde_json::Value>,
  #[serde(default)]
  pub children: Vec<String>,
}

const SNAPSHOT_TEXT_MARKERS: [&str; 2] = ["$blocksuite:internal:text$", "$virgultum:internal:text$"];
// Canonical writes use Virgultum; readers retain historical snapshot support.
const NATIVE_BOXED_MARKER: &str = "$virgultum:internal:native$";
const SNAPSHOT_NATIVE_MARKERS: [&str; 2] = ["$blocksuite:internal:native$", "$virgultum:internal:native$"];
const SNAPSHOT_SURFACE_TEXT_MARKERS: [&str; 2] = ["affine:surface:text", "myoxus:surface:text"];
const SNAPSHOT_SURFACE_MAP_MARKERS: [&str; 2] = ["affine:surface:ymap", "myoxus:surface:ymap"];

fn snapshot_marker<'a>(
  value: &'a serde_json::Value,
  markers: &[&str],
) -> Option<&'a serde_json::Map<String, serde_json::Value>> {
  let value = value.as_object()?;
  markers
    .iter()
    .any(|marker| value.get(*marker).and_then(serde_json::Value::as_bool) == Some(true))
    .then_some(value)
}

fn snapshot_text_chunks(value: &serde_json::Value) -> Result<Vec<(String, Attrs)>, String> {
  if let Some(value) = value.as_str() {
    return Ok(vec![(value.to_string(), Attrs::new())]);
  }
  let marker = snapshot_marker(value, &SNAPSHOT_TEXT_MARKERS)
    .or_else(|| snapshot_marker(value, &SNAPSHOT_SURFACE_TEXT_MARKERS))
    .ok_or_else(|| "snapshot rich-text value has an unsupported representation".to_string())?;
  let delta = marker
    .get("delta")
    .and_then(serde_json::Value::as_array)
    .ok_or_else(|| "snapshot rich-text value is missing its delta".to_string())?;
  delta
    .iter()
    .map(|operation| {
      let operation = operation
        .as_object()
        .ok_or_else(|| "snapshot rich-text delta operation must be an object".to_string())?;
      let insert = operation
        .get("insert")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "snapshot rich-text delta operation must insert text".to_string())?;
      let attributes = operation
        .get("attributes")
        .map(|attributes| {
          attributes
            .as_object()
            .ok_or_else(|| "snapshot rich-text attributes must be an object".to_string())?
            .iter()
            .map(|(key, value)| Ok((key.as_str().into(), json_to_yjs_any(value)?)))
            .collect::<Result<Attrs, String>>()
        })
        .transpose()?
        .unwrap_or_default();
      Ok((insert.to_string(), attributes))
    })
    .collect()
}

/// Extract display text from a canonical snapshot Text value without losing
/// the formatted delta used by the document materializer.
pub fn snapshot_rich_text_plain_text(value: &serde_json::Value) -> Result<String, String> {
  snapshot_text_chunks(value).map(|chunks| chunks.into_iter().map(|(text, _)| text).collect())
}

fn insert_snapshot_text(
  target: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  key: String,
  value: &serde_json::Value,
) -> Result<(), String> {
  let text = target.insert(txn, key, yrs::TextPrelim::new(""));
  for (value, attributes) in snapshot_text_chunks(value)? {
    // `Doc::new()` uses byte offsets. Computing UTF-16 offsets here corrupts
    // formatted non-ASCII text (and panics in debug builds inside yrs).
    let offset = text.len(txn);
    text.insert_with_attributes(txn, offset, &value, attributes);
  }
  Ok(())
}

fn insert_snapshot_text_into_array(
  target: &yrs::ArrayRef,
  txn: &mut yrs::TransactionMut<'_>,
  value: &serde_json::Value,
) -> Result<(), String> {
  let text = target.push_back(txn, yrs::TextPrelim::new(""));
  for (value, attributes) in snapshot_text_chunks(value)? {
    let offset = text.len(txn);
    text.insert_with_attributes(txn, offset, &value, attributes);
  }
  Ok(())
}

fn insert_snapshot_native(
  target: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  key: String,
  marker: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
  let boxed = target.insert(txn, key, yrs::MapPrelim::default());
  boxed.insert(txn, "type", NATIVE_BOXED_MARKER);
  boxed.insert(
    txn,
    "value",
    json_to_yjs_any(marker.get("value").unwrap_or(&serde_json::Value::Null))?,
  );
  Ok(())
}

fn insert_snapshot_value(
  target: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  key: String,
  value: &serde_json::Value,
) -> Result<(), String> {
  if snapshot_marker(value, &SNAPSHOT_TEXT_MARKERS).is_some() {
    return insert_snapshot_text(target, txn, key, value);
  }
  if let Some(marker) = snapshot_marker(value, &SNAPSHOT_NATIVE_MARKERS) {
    return insert_snapshot_native(target, txn, key, marker);
  }
  match value {
    serde_json::Value::Array(values) => {
      let array = target.insert(txn, key, yrs::ArrayPrelim::default());
      for value in values {
        push_snapshot_value(&array, txn, value)?;
      }
    }
    serde_json::Value::Object(values) => {
      let map = target.insert(txn, key, yrs::MapPrelim::default());
      for (key, value) in values {
        insert_snapshot_value(&map, txn, key.clone(), value)?;
      }
    }
    _ => {
      target.insert(txn, key, json_to_yjs_any(value)?);
    }
  }
  Ok(())
}

fn insert_snapshot_property(
  target: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  key: String,
  value: &serde_json::Value,
) -> Result<(), String> {
  if snapshot_marker(value, &SNAPSHOT_TEXT_MARKERS).is_some()
    || snapshot_marker(value, &SNAPSHOT_NATIVE_MARKERS).is_some()
  {
    return insert_snapshot_value(target, txn, key, value);
  }
  if let serde_json::Value::Object(values) = value {
    // Virgultum's table model uses a flat Y.Map: nested plain-object
    // properties are stored as `prop:columns.role.width`, not as a Y.Map under
    // `prop:columns`. The latter cannot be loaded by ReactiveFlatYMap. Marker
    // objects remain real Y.Text/Boxed values and arrays remain collaborative.
    for (child_key, child_value) in values {
      insert_snapshot_property(target, txn, format!("{key}.{child_key}"), child_value)?;
    }
    return Ok(());
  }
  insert_snapshot_value(target, txn, key, value)
}

fn push_snapshot_value(
  target: &yrs::ArrayRef,
  txn: &mut yrs::TransactionMut<'_>,
  value: &serde_json::Value,
) -> Result<(), String> {
  if snapshot_marker(value, &SNAPSHOT_TEXT_MARKERS).is_some() {
    return insert_snapshot_text_into_array(target, txn, value);
  }
  if let Some(marker) = snapshot_marker(value, &SNAPSHOT_NATIVE_MARKERS) {
    let boxed = target.push_back(txn, yrs::MapPrelim::default());
    boxed.insert(txn, "type", NATIVE_BOXED_MARKER);
    boxed.insert(
      txn,
      "value",
      json_to_yjs_any(marker.get("value").unwrap_or(&serde_json::Value::Null))?,
    );
    return Ok(());
  }
  match value {
    serde_json::Value::Array(values) => {
      let array = target.push_back(txn, yrs::ArrayPrelim::default());
      for value in values {
        push_snapshot_value(&array, txn, value)?;
      }
    }
    serde_json::Value::Object(values) => {
      let map = target.push_back(txn, yrs::MapPrelim::default());
      for (key, value) in values {
        insert_snapshot_value(&map, txn, key.clone(), value)?;
      }
    }
    _ => {
      target.push_back(txn, json_to_yjs_any(value)?);
    }
  }
  Ok(())
}

fn insert_surface_elements(
  target: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  key: String,
  value: &serde_json::Value,
) -> Result<(), String> {
  let elements = value
    .as_object()
    .ok_or_else(|| "snapshot surface elements must be an object".to_string())?;
  let boxed = target.insert(txn, key, yrs::MapPrelim::default());
  boxed.insert(txn, "type", NATIVE_BOXED_MARKER);
  let value_map = boxed.insert(txn, "value", yrs::MapPrelim::default());
  for (element_id, element) in elements {
    let element = element
      .as_object()
      .ok_or_else(|| "snapshot surface element must be an object".to_string())?;
    let element_map = value_map.insert(txn, element_id.clone(), yrs::MapPrelim::default());
    for (property, value) in element {
      if snapshot_marker(value, &SNAPSHOT_SURFACE_TEXT_MARKERS).is_some() {
        insert_snapshot_text(&element_map, txn, property.clone(), value)?;
      } else if let Some(marker) = snapshot_marker(value, &SNAPSHOT_SURFACE_MAP_MARKERS) {
        let map = element_map.insert(txn, property.clone(), yrs::MapPrelim::default());
        let values = marker
          .get("json")
          .and_then(serde_json::Value::as_object)
          .ok_or_else(|| "snapshot surface map is missing its JSON value".to_string())?;
        for (key, value) in values {
          map.insert(txn, key.clone(), json_to_yjs_any(value)?);
        }
      } else {
        element_map.insert(txn, property.clone(), json_to_yjs_any(value)?);
      }
    }
  }
  Ok(())
}

pub fn snapshot_blocks_to_yjs(source_blocks: &[PortableSnapshotBlock]) -> Result<Vec<u8>, String> {
  let doc = Doc::new();
  let target_blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    let mut ids = HashSet::new();
    for source in source_blocks {
      if !ids.insert(source.id.clone()) {
        return Err("snapshot block collection contains duplicate identities".to_string());
      }
      let id = source.id.clone();
      let block = target_blocks.insert(
        &mut txn,
        id.clone(),
        std::iter::empty::<(String, Any)>().collect::<yrs::MapPrelim>(),
      );
      block.insert(&mut txn, "sys:id", id);
      let flavour = resolve_flavour(&source.flavour);
      block.insert(&mut txn, "sys:flavour", flavour);
      if let Some(version) = source.version {
        block.insert(&mut txn, "sys:version", version as f64);
      }
      // Virgultum's block model requires a collaborative Y.Array here. An
      // Any::Array has the same JSON shape but is a scalar Y.Map value, so the
      // editor rejects the imported block before it can construct its model.
      let target_children = block.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
      for child in &source.children {
        target_children.push_back(&mut txn, child.as_str());
      }
      for (key, value) in &source.props {
        let target_key = format!("prop:{key}");
        if snapshot_property_is_opaque_reference(flavour, key) && value.is_object() {
          // These are raw protocol objects, not ordinary reactive properties.
          // Keep valid binder markers and malformed/empty privacy sentinels.
          block.insert(&mut txn, target_key, json_to_yjs_any(value)?);
        } else if snapshot_property_is_rich_text(flavour, key) {
          insert_snapshot_text(&block, &mut txn, target_key, value)?;
        } else if flavour == "myoxus:surface" && key == "elements" {
          insert_surface_elements(&block, &mut txn, target_key, value)?;
        } else if flavour == "myoxus:table" {
          // Only the table uses FlatSyncController. Other block properties use
          // native shared maps, including empty objects and repeat bindings.
          insert_snapshot_property(&block, &mut txn, target_key, value)?;
        } else {
          insert_snapshot_value(&block, &mut txn, target_key, value)?;
        }
      }
    }
  }
  Ok(doc.transact().encode_state_as_update_v1(&StateVector::default()))
}

fn snapshot_property_is_opaque_reference(flavour: &str, property: &str) -> bool {
  flavour == "myoxus:database"
    && matches!(
      property,
      "templateReference" | "serverRowId" | "serverReferencePresentation"
    )
}

fn snapshot_property_is_rich_text(flavour: &str, property: &str) -> bool {
  matches!(
    (flavour, property),
    ("myoxus:page", "title")
      | ("myoxus:paragraph", "text")
      | ("myoxus:list", "text")
      | ("myoxus:code", "text")
      | ("myoxus:callout", "text")
      | ("myoxus:frame", "title")
      | ("myoxus:database", "title")
      | ("myoxus:bpmn", "title")
      | ("myoxus:mermaid", "source")
      | ("myoxus:mermaid", "title")
  )
}

fn json_to_yjs_any(value: &serde_json::Value) -> Result<Any, String> {
  match value {
    serde_json::Value::Null => Ok(Any::Null),
    serde_json::Value::Bool(value) => Ok(Any::Bool(*value)),
    serde_json::Value::Number(value) => value
      .as_f64()
      .map(Any::from)
      .ok_or_else(|| "snapshot numeric property is outside the supported range".to_string()),
    serde_json::Value::String(value) => Ok(Any::String(value.clone().into())),
    serde_json::Value::Array(values) => values
      .iter()
      .map(json_to_yjs_any)
      .collect::<Result<Vec<_>, _>>()
      .map(|values| Any::Array(values.into())),
    serde_json::Value::Object(values) => values
      .iter()
      .map(|(key, value)| Ok((key.clone(), json_to_yjs_any(value)?)))
      .collect::<Result<HashMap<_, _>, String>>()
      .map(|values| Any::Map(Arc::new(values))),
  }
}

/// Extract blob-backed references from portable block flavours without
/// interpreting URLs as workspace assets. The workspace decoder uses this to
/// reject incomplete SQLite inputs before any product write is planned.
#[instrument(skip(update))]
pub fn extract_portable_asset_references(update: &[u8]) -> Result<Vec<PortableAssetReference>, String> {
  if update.is_empty() {
    return Ok(Vec::new());
  }
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    let update = Update::decode_v1(update).map_err(|error| format!("portable asset decode failed: {error}"))?;
    txn
      .apply_update(update)
      .map_err(|error| format!("portable asset apply failed: {error}"))?;
  }
  let txn = doc.transact();
  let mut references = Vec::new();
  for (block_id, value) in blocks.iter(&txn) {
    let yrs::Out::YMap(block) = value else {
      continue;
    };
    let raw_flavour = block_string(&block, &txn, "flavour").unwrap_or_default();
    let flavour = resolve_flavour(&raw_flavour);
    if matches!(flavour, "myoxus:image" | "myoxus:attachment" | "myoxus:bookmark")
      && let Some(source_key) = block_prop_string(&block, &txn, "sourceId")
      && portable_asset_key(&source_key)
    {
      references.push(PortableAssetReference {
        block_id: block_id.into(),
        source_key: source_key.trim().trim_start_matches('/').into(),
        raw_source_key: source_key.clone(),
        workspace_id: native_block_workspace(&block, &txn),
        position: NativeReferencePosition::BlockProperty {
          block_id: block_id.into(),
          property: native_block_property(&block, &txn, "sourceId"),
        },
      });
    }
    for (property, value) in block.iter(&txn) {
      let yrs::Out::YText(text) = value else {
        continue;
      };
      let mut offset = 0;
      for chunk in text.diff(&txn, YChange::identity) {
        let start = offset;
        let length = match &chunk.insert {
          yrs::Out::Any(Any::String(value)) => value.encode_utf16().count() as u32,
          _ => 1,
        };
        offset += length;
        if annotation::annotation_id(chunk.attributes.as_deref()).is_some() {
          continue;
        }
        let Some(Any::Map(footnote)) = chunk.attributes.as_deref().and_then(|attrs| attrs.get("footnote")) else {
          continue;
        };
        let Some(Any::Map(reference)) = footnote.get("reference") else {
          continue;
        };
        if reference.get("type").and_then(yjs_any_to_string).as_deref() != Some("attachment") {
          continue;
        }
        let Some(source_key) = reference
          .get("blobId")
          .and_then(yjs_any_to_string)
          .filter(|key| portable_asset_key(key))
        else {
          continue;
        };
        references.push(PortableAssetReference {
          block_id: block_id.into(),
          raw_source_key: source_key.clone(),
          source_key,
          workspace_id: native_workspace_qualification(reference.get("workspaceId")),
          position: NativeReferencePosition::TextAttribute {
            block_id: block_id.into(),
            property: property.into(),
            start,
            length,
            attribute: "footnote".into(),
            path: vec!["reference".into(), "blobId".into()],
          },
        });
      }
    }
  }
  references.sort_by(|left, right| {
    left
      .block_id
      .cmp(&right.block_id)
      .then_with(|| left.source_key.cmp(&right.source_key))
  });
  Ok(references)
}

fn portable_asset_key(value: &str) -> bool {
  let key = value.trim().trim_start_matches('/');
  !key.is_empty()
    && !["http://", "https://", "data:", "blob:"]
      .iter()
      .any(|scheme| key.starts_with(scheme))
}

fn native_workspace_qualification(value: Option<&Any>) -> Option<String> {
  value.map(|value| yjs_any_to_string(value).unwrap_or_else(|| yjs_any_to_json(value).to_string()))
}

fn native_block_property<T: ReadTxn>(block: &yrs::MapRef, txn: &T, property: &str) -> String {
  let qualified = format!("prop:{property}");
  if block.get(txn, property).is_some() && block.get(txn, &qualified).is_none() {
    property.into()
  } else {
    qualified
  }
}

fn native_block_workspace<T: ReadTxn>(block: &yrs::MapRef, txn: &T) -> Option<String> {
  block
    .get(txn, "prop:workspaceId")
    .or_else(|| block.get(txn, "workspaceId"))
    .map(|value| match value {
      yrs::Out::Any(value) => native_workspace_qualification(Some(&value)).unwrap(),
      value => yjs_out_to_json(value, txn).to_string(),
    })
}

fn truncate_preview(value: &str) -> String {
  const PREVIEW_MAX_CHARS: usize = 256;
  let trimmed = value.trim();
  trimmed.chars().take(PREVIEW_MAX_CHARS).collect()
}

fn reference_params_json(payload: &HashMap<String, Any>) -> serde_json::Value {
  let mut params = serde_json::Map::new();
  for (key, value) in payload {
    if key.as_str() == "type" || key.as_str() == "pageId" || key.as_str() == "docId" || key.as_str() == "workspaceId" {
      continue;
    }
    params.insert(key.to_string(), yjs_any_to_json(value));
  }
  serde_json::Value::Object(params)
}

fn extract_ytext_document_references<T: ReadTxn>(
  text: &yrs::TextRef,
  txn: &T,
  source_block_id: &str,
  property: &str,
  source_parent_block_id: Option<String>,
  source_parent_flavour: Option<String>,
  link_kind: DocumentReferenceLinkKind,
  occurrences: &mut Vec<DocumentReferenceOccurrence>,
) {
  let mut offset = 0;
  for chunk in text.diff(txn, YChange::identity) {
    let start = offset;
    let length = match &chunk.insert {
      yrs::Out::Any(Any::String(value)) => value.encode_utf16().count() as u32,
      _ => 1,
    };
    offset += length;
    // Native annotation text is literal even when adjacent Yjs formatting
    // deltas retain reference attributes. Match the Markdown/read projection.
    if annotation::annotation_id(chunk.attributes.as_deref()).is_some() {
      continue;
    }
    let preview = match &chunk.insert {
      yrs::Out::Any(Any::String(value)) => truncate_preview(value),
      _ => String::new(),
    };
    let Some(attrs) = chunk.attributes.as_ref() else {
      continue;
    };
    let linked = attrs.get("reference").and_then(|value| match value {
      Any::Map(reference) if reference.get("type").and_then(yjs_any_to_string).as_deref() == Some("LinkedPage") => {
        Some(reference.as_ref())
      }
      _ => None,
    });
    let citation = attrs
      .get("footnote")
      .and_then(|value| match value {
        Any::Map(footnote) => footnote.get("reference"),
        _ => None,
      })
      .and_then(|value| match value {
        Any::Map(reference) if reference.get("type").and_then(yjs_any_to_string).as_deref() == Some("doc") => {
          Some(reference.as_ref())
        }
        _ => None,
      });
    for (reference, attribute, prefix) in linked
      .into_iter()
      .map(|reference| (reference, "reference", Vec::<String>::new()))
      .chain(
        citation
          .into_iter()
          .map(|reference| (reference, "footnote", vec!["reference".into()])),
      )
    {
      let key = if reference.contains_key("pageId") {
        "pageId"
      } else {
        "docId"
      };
      // Recognized malformed targets remain typed occurrences. Do not coerce
      // numeric IDs into unrelated valid routes; the bound writer omits them.
      let raw_target_doc_id = reference
        .get(key)
        .and_then(|value| match value {
          Any::String(value) => Some(value.to_string()),
          _ => None,
        })
        .unwrap_or_default();
      let mut path = prefix;
      path.push(key.into());
      occurrences.push(DocumentReferenceOccurrence {
        source_block_id: source_block_id.to_string(),
        source_parent_block_id: source_parent_block_id.clone(),
        source_parent_flavour: source_parent_flavour.clone(),
        raw_target_doc_id,
        target_workspace_id: native_workspace_qualification(reference.get("workspaceId")),
        position: NativeReferencePosition::TextAttribute {
          block_id: source_block_id.into(),
          property: property.into(),
          start,
          length,
          attribute: attribute.into(),
          path,
        },
        link_kind,
        params_json: reference_params_json(reference),
        markdown_preview: preview.clone(),
      });
    }
  }
}

/// Extract internal document references from a Virgultum Yjs v1 snapshot.
///
/// The extractor is intentionally narrow: it reads explicit internal document
/// references and document citations only. External links, attachments, local
/// footnote definitions, Mermaid edges,
/// database row/document ownership and sync provenance stay out of P5 so the
/// Document Graph cannot accidentally become a catch-all provenance graph.
#[instrument(skip(update))]
pub fn extract_document_references_from_yjs(update: &[u8]) -> Result<DocumentReferenceExtraction, String> {
  if update.is_empty() {
    return Ok(DocumentReferenceExtraction {
      occurrences: Vec::new(),
      extraction_partial: false,
    });
  }

  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    let update = Update::decode_v1(update).map_err(|error| format!("document reference decode failed: {error}"))?;
    txn
      .apply_update(update)
      .map_err(|error| format!("document reference apply failed: {error}"))?;
  }

  let txn = doc.transact();
  let mut occurrences = Vec::new();
  let mut extraction_partial = false;
  let mut parent_by_child: HashMap<String, (String, String)> = HashMap::new();
  let mut block_maps: Vec<(String, yrs::MapRef)> = Vec::new();

  for (block_id, value) in blocks_map.iter(&txn) {
    let yrs::Out::YMap(block_map) = value else {
      extraction_partial = true;
      continue;
    };
    let raw_flavour = block_string(&block_map, &txn, "flavour").unwrap_or_default();
    let flavour = resolve_flavour(&raw_flavour).to_string();
    for child_id in block_children(&block_map, &txn) {
      parent_by_child.insert(child_id, (block_id.to_string(), flavour.clone()));
    }
    block_maps.push((block_id.to_string(), block_map));
  }

  block_maps.sort_by(|a, b| a.0.cmp(&b.0));
  for (block_id, block_map) in block_maps {
    let raw_flavour = block_string(&block_map, &txn, "flavour").unwrap_or_default();
    let flavour = resolve_flavour(&raw_flavour).to_string();
    if flavour == "myoxus:annotation" {
      continue;
    }
    let parent = parent_by_child.get(&block_id).cloned();

    match flavour.as_str() {
      "myoxus:embed-linked-doc" | "myoxus:embed-synced-doc" | "myoxus:surface-ref" => {
        let property = native_block_property(&block_map, &txn, "pageId");
        let target = block_map.get(&txn, &property);
        // Surface references without a document target can represent local
        // canvas geometry. Linked/synced blocks are document-only references.
        if target.is_some() || flavour != "myoxus:surface-ref" {
          let raw_target_doc_id = match target {
            Some(yrs::Out::Any(Any::String(value))) => value.to_string(),
            _ => String::new(),
          };
          let link_kind = match flavour.as_str() {
            "myoxus:embed-linked-doc" => DocumentReferenceLinkKind::EmbedLinkedDoc,
            "myoxus:embed-synced-doc" => DocumentReferenceLinkKind::EmbedSyncedDoc,
            _ => DocumentReferenceLinkKind::SurfaceRef,
          };
          occurrences.push(DocumentReferenceOccurrence {
            source_block_id: block_id.clone(),
            source_parent_block_id: parent.as_ref().map(|(id, _)| id.clone()),
            source_parent_flavour: parent.as_ref().map(|(_, flavour)| flavour.clone()),
            raw_target_doc_id,
            target_workspace_id: native_block_workspace(&block_map, &txn),
            position: NativeReferencePosition::BlockProperty {
              block_id: block_id.clone(),
              property: native_block_property(&block_map, &txn, "pageId"),
            },
            link_kind,
            params_json: block_prop_json(&block_map, &txn, "params")
              .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new())),
            markdown_preview: String::new(),
          });
        }
      }
      _ => {}
    }

    for (key, value) in block_map.iter(&txn) {
      let yrs::Out::YText(text) = value else {
        continue;
      };
      let is_database_cell = flavour == "myoxus:database" && key.starts_with("prop:cells.") && key.ends_with(".text");
      let is_regular_text = key == "prop:text" || key == "text" || key == "prop:title";
      if !is_database_cell && !is_regular_text {
        continue;
      }
      let link_kind = if is_database_cell {
        DocumentReferenceLinkKind::DatabaseCellReference
      } else {
        DocumentReferenceLinkKind::InlineReference
      };
      extract_ytext_document_references(
        &text,
        &txn,
        &block_id,
        &key,
        parent.as_ref().map(|(id, _)| id.clone()),
        parent.as_ref().map(|(_, flavour)| flavour.clone()),
        link_kind,
        &mut occurrences,
      );
    }
  }

  debug!(
    occurrence_count = occurrences.len(),
    extraction_partial, "document reference extraction complete"
  );
  Ok(DocumentReferenceExtraction {
    occurrences,
    extraction_partial,
  })
}

/// Write exact native occurrences while preserving native CRDT identities.
/// Selectors are bound by the caller's immutable snapshot/manifest. No arbitrary
/// string property, caption, URL, element ID or local definition ID is searched.
pub fn rewrite_native_references(
  update: &[u8],
  rewrites: &[NativeReferenceRewrite],
  client_id: u64,
) -> Result<NativeReferenceRewriteResult, String> {
  // A typed selector must be a canonical occurrence of this snapshot, not
  // merely an arbitrary property/range that happens to contain the same text.
  let positions = extract_document_references_from_yjs(update)?
    .occurrences
    .into_iter()
    .map(|item| (item.position, (item.raw_target_doc_id, item.target_workspace_id)))
    .chain(
      extract_portable_asset_references(update)?
        .into_iter()
        .map(|item| (item.position, (item.raw_source_key, item.workspace_id))),
    )
    .collect::<std::collections::BTreeMap<_, _>>();
  // Historical numeric block selectors are checked against the exact scalar
  // below. They must not turn an arbitrary property or text range into a target.
  if rewrites.iter().any(|rewrite| {
    !positions.get(&rewrite.position).is_some_and(|(id, workspace)| {
      workspace == &rewrite.expected_workspace_id
        && (id == &rewrite.expected_id
          || (id.is_empty()
            && !rewrite.expected_id.is_empty()
            && matches!(rewrite.position, NativeReferencePosition::BlockProperty { .. })))
    })
  }) {
    return Err("native reference selector is not a canonical occurrence".into());
  }
  let mut options = yrs::Options::with_client_id(yrs::ClientID::new(client_id));
  options.offset_kind = yrs::OffsetKind::Utf16;
  let doc = Doc::with_options(options);
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(update).map_err(|_| "native reference decode failed")?)
      .map_err(|_| "native reference apply failed")?;
  }
  let before = doc.transact().state_vector();
  if before.contains_client(&yrs::ClientID::new(client_id)) {
    return Err("native reference writer client collides with source".into());
  }
  let mut ordered = rewrites.iter().collect::<Vec<_>>();
  ordered.sort_by(|left, right| right.position.cmp(&left.position));
  if ordered.windows(2).any(|pair| pair[0].position == pair[1].position) {
    return Err("native reference selectors are not unique".into());
  }
  let mut txn = doc.transact_mut();
  for rewrite in ordered {
    match &rewrite.position {
      NativeReferencePosition::BlockProperty { block_id, property } => {
        let Some(yrs::Out::YMap(block)) = blocks.get(&txn, block_id) else {
          return Err("native reference block is missing".into());
        };
        let actual = block
          .get(&txn, property)
          .and_then(|value| match value {
            yrs::Out::Any(Any::String(value)) => Some(value.to_string()),
            // Committed version-2 block selectors admitted numeric IDs. Keep
            // that exact binding for historical readers; new document captures use an
            // empty malformed ID and omit it. The value check still rejects
            // stale or arbitrary selectors before any mutation.
            yrs::Out::Any(value @ (Any::Number(_) | Any::BigInt(_))) if !rewrite.expected_id.is_empty() => {
              yjs_any_to_string(&value)
            }
            _ => None,
          })
          .unwrap_or_default();
        if actual != rewrite.expected_id || native_block_workspace(&block, &txn) != rewrite.expected_workspace_id {
          return Err("native reference selector is stale".into());
        }
        if let Some(target) = &rewrite.replacement {
          block.insert(&mut txn, property.as_str(), target.id.as_str());
          let scope_property = native_block_property(&block, &txn, "workspaceId");
          if let Some(workspace_id) = &target.workspace_id {
            block.insert(&mut txn, scope_property.as_str(), workspace_id.as_str());
          } else {
            block.remove(&mut txn, &scope_property);
          }
        } else {
          let flavour = block_string(&block, &txn, "flavour").unwrap_or_default();
          // Unknown historical attachment provenance makes the asset
          // unavailable without dropping its block, caption or child content.
          if matches!(
            resolve_flavour(&flavour),
            "myoxus:image" | "myoxus:attachment" | "myoxus:bookmark"
          ) && property == &native_block_property(&block, &txn, "sourceId")
          {
            block.remove(&mut txn, property);
            let scope = native_block_property(&block, &txn, "workspaceId");
            block.remove(&mut txn, &scope);
            continue;
          }
          if !matches!(
            resolve_flavour(&flavour),
            "myoxus:embed-linked-doc" | "myoxus:embed-synced-doc" | "myoxus:surface-ref"
          ) {
            return Err("native omission requires a reference-only block".into());
          }
          let children = block_children(&block, &txn);
          let parents = blocks
            .iter(&txn)
            .filter_map(|(_, value)| match value {
              yrs::Out::YMap(parent) => Some(parent),
              _ => None,
            })
            .collect::<Vec<_>>();
          for parent in parents {
            let children_property = if parent.get(&txn, "sys:children").is_some() {
              "sys:children"
            } else {
              "children"
            };
            let edges = match parent.get(&txn, children_property) {
              Some(yrs::Out::YArray(edges)) => edges,
              Some(yrs::Out::Any(Any::Array(edges))) => {
                let mut next = Vec::new();
                for edge in edges.iter() {
                  if matches!(edge, Any::String(value) if value.as_ref() == block_id) {
                    next.extend(children.iter().map(|id| Any::String(id.clone().into())));
                  } else {
                    next.push(edge.clone());
                  }
                }
                parent.insert(&mut txn, children_property, Any::Array(next.into()));
                continue;
              }
              _ => continue,
            };
            let matches = edges
              .iter(&txn)
              .enumerate()
              .filter_map(|(index, value)| match value {
                yrs::Out::Any(Any::String(value)) if value.as_ref() == block_id => Some(index as u32),
                _ => None,
              })
              .collect::<Vec<_>>();
            for index in matches.into_iter().rev() {
              edges.remove_range(&mut txn, index, 1);
              edges.insert_range(&mut txn, index, children.iter().map(String::as_str));
            }
          }
          blocks.remove(&mut txn, block_id);
        }
      }
      NativeReferencePosition::TextAttribute {
        block_id,
        property,
        start,
        length,
        attribute,
        path,
      } => {
        let Some(yrs::Out::YMap(block)) = blocks.get(&txn, block_id) else {
          return Err("native reference block is missing".into());
        };
        let Some(yrs::Out::YText(text)) = block.get(&txn, property) else {
          return Err("native reference text is missing".into());
        };
        let mut offset = 0;
        let (chunk_start, chunk) = text
          .diff(&txn, YChange::identity)
          .into_iter()
          .filter_map(|chunk| {
            let begin = offset;
            offset += match &chunk.insert {
              yrs::Out::Any(Any::String(value)) => value.encode_utf16().count() as u32,
              _ => 1,
            };
            (begin <= *start && offset >= start.saturating_add(*length)).then_some((begin, chunk))
          })
          .next()
          .ok_or("native reference text selector is stale")?;
        let value = chunk
          .attributes
          .as_deref()
          .and_then(|attrs| attrs.get(attribute.as_str()))
          .ok_or("native reference annotation is missing")?;
        let mut value = yjs_any_to_json(value);
        let mut container = &mut value;
        let (key, parents) = path.split_last().ok_or("native reference path is empty")?;
        for parent in parents {
          container = container.get_mut(parent).ok_or("native reference path is stale")?;
        }
        if container
          .get(key)
          .and_then(serde_json::Value::as_str)
          .unwrap_or_default()
          != rewrite.expected_id
          || container
            .get("workspaceId")
            .map(|value| value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))
            != rewrite.expected_workspace_id
        {
          return Err("native reference annotation selector is stale".into());
        }
        if let Some(target) = &rewrite.replacement {
          let object = container
            .as_object_mut()
            .ok_or("native reference annotation is malformed")?;
          object.insert(key.clone(), serde_json::Value::String(target.id.clone()));
          if let Some(workspace_id) = &target.workspace_id {
            object.insert("workspaceId".into(), serde_json::Value::String(workspace_id.clone()));
          } else {
            object.remove("workspaceId");
          }
          text.format(
            &mut txn,
            *start,
            *length,
            Attrs::from([(attribute.clone().into(), json_to_yjs_any(&value)?)]),
          );
        } else {
          let atom = match &chunk.insert {
            yrs::Out::Any(Any::String(value)) => {
              let units = value
                .encode_utf16()
                .skip((*start - chunk_start) as usize)
                .take(*length as usize)
                .collect::<Vec<_>>();
              // Native ReferenceNode uses exactly one annotated space. Ordinary
              // annotated text, including longer whitespace, keeps its content.
              units.as_slice() == [0x20] || units.iter().all(|unit| matches!(unit, 0xfffc | 0x200b))
            }
            _ => true,
          };
          if atom {
            text.remove_range(&mut txn, *start, *length);
          } else {
            text.format(
              &mut txn,
              *start,
              *length,
              Attrs::from([(attribute.clone().into(), Any::Null)]),
            );
          }
        }
      }
    }
  }
  Ok(NativeReferenceRewriteResult {
    full_state: txn.encode_state_as_update_v1(&StateVector::default()),
    incremental_update: txn.encode_state_as_update_v1(&before),
  })
}

/// Extract a deterministic block projection from a Yjs v1 snapshot.
///
/// Supports the currently emitted `sys:*`/`prop:*` keys and the older
/// unprefixed block fields in older snapshots.
#[instrument(skip(data))]
pub fn extract_blocks_from_yjs(data: &[u8]) -> Result<YjsBlockExtractResult, String> {
  if data.is_empty() {
    return Ok(YjsBlockExtractResult {
      blocks: Vec::new(),
      extraction_partial: false,
    });
  }

  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  {
    let mut tx = doc.transact_mut();
    let update = Update::decode_v1(data).map_err(|e| e.to_string())?;
    tx.apply_update(update).map_err(|e| e.to_string())?;
  }

  fn get_block_string(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<String> {
    let prefixed = format!("sys:{key}");
    block_map
      .get(txn, &prefixed)
      .or_else(|| block_map.get(txn, key))
      .and_then(|v| match v {
        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
        _ => None,
      })
  }

  fn get_text(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, flavour: &str, partial: &mut bool) -> String {
    // The native page title is authored prose too, not a renderer property.
    let (prefixed, legacy) = if flavour == "myoxus:page" {
      ("prop:title", "title")
    } else {
      ("prop:text", "text")
    };
    let value = block_map.get(txn, prefixed).or_else(|| block_map.get(txn, legacy));
    match value {
      Some(yrs::Out::YText(text)) => {
        // Plain runs cannot establish equality of native embeds or attributes.
        // Retain useful prose, while reporting what this reading projection omits.
        *partial |= text.diff(txn, YChange::identity).iter().any(|run| {
          !matches!(&run.insert, yrs::Out::Any(Any::String(_)))
            || run.attributes.as_ref().is_some_and(|attributes| !attributes.is_empty())
        });
        text
          .diff(txn, YChange::identity)
          .iter()
          .filter_map(|run| match &run.insert {
            yrs::Out::Any(Any::String(text)) => Some(text.as_ref()),
            _ => None,
          })
          .collect()
      }
      // Older native blocks store plain text directly. Reading a complete
      // string loses no text attributes and must not reject canonical imports.
      Some(yrs::Out::Any(Any::String(text))) => text.to_string(),
      Some(_) => {
        *partial = true;
        String::new()
      }
      None => String::new(),
    }
  }

  let txn = doc.transact_mut();
  let mut blocks = Vec::new();
  // Nonempty CRDT state without native blocks is outside this prose projection.
  let mut partial = blocks_map.len(&txn) == 0 && !txn.state_vector().is_empty();

  for (id, value) in blocks_map.iter(&txn) {
    let yrs::Out::YMap(block_map) = value else {
      partial = true;
      continue;
    };

    let raw_flavour = get_block_string(&block_map, &txn, "flavour").unwrap_or_default();
    if raw_flavour.is_empty() {
      partial = true;
    }
    let children = block_map
      .get(&txn, "sys:children")
      .or_else(|| block_map.get(&txn, "children"));
    let children_ids = match children {
      Some(yrs::Out::YArray(children)) => children
        .iter(&txn)
        .filter_map(|child| match child {
          yrs::Out::Any(Any::String(id)) => Some(id.to_string()),
          _ => {
            partial = true;
            None
          }
        })
        .collect(),
      Some(_) => {
        partial = true;
        Vec::new()
      }
      None => Vec::new(),
    };

    blocks.push(YjsBlockInfo {
      id: id.to_string(),
      flavour: resolve_flavour(&raw_flavour).to_string(),
      text: match block_map.get(&txn, "prop:text").or_else(|| block_map.get(&txn, "text")) {
        Some(yrs::Out::YText(text)) => extract_formatted_text(&text, &txn),
        _ => String::new(),
      },
      plain_text: get_text(&block_map, &txn, resolve_flavour(&raw_flavour), &mut partial),
      children_ids,
    });
  }

  blocks.sort_by(|a, b| a.id.cmp(&b.id));
  debug!(block_count = blocks.len(), partial, "yjs block extraction complete");
  Ok(YjsBlockExtractResult {
    blocks,
    extraction_partial: partial,
  })
}

/// Editor-native person atom. New authored objects intentionally omit notification links.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeMemberMention {
  pub member: String,
}

/// One attributed text run accepted by [`YjsDocumentBuilder`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct YjsTextSegment {
  pub text: String,
  pub bold: bool,
  pub italic: bool,
  pub strike: bool,
  pub code: bool,
  pub underline: bool,
  pub color: Option<String>,
  pub label_tone: Option<String>,
  pub background: Option<String>,
  pub link: Option<String>,
  pub reference: Option<markdown::MarkdownDocumentReference>,
  pub annotation: Option<String>,
  pub mention: Option<NativeMemberMention>,
  /// Virgultum atomic inline math: one space carries the authored formula.
  pub latex: Option<String>,
  pub(crate) native_latex_attributes: Option<serde_json::Value>,
  /// Native local block target or an existing citation; never a rich inline body.
  pub footnote: Option<serde_json::Value>,
  image_source: Option<String>,
  image_caption: Option<String>,
}

impl YjsTextSegment {
  pub fn plain(text: impl Into<String>) -> Self {
    Self {
      text: text.into(),
      ..Self::default()
    }
  }

  fn to_attrs(&self) -> Option<Attrs> {
    if let Some(Any::Map(attributes)) = self
      .native_latex_attributes
      .as_ref()
      .and_then(|value| json_to_yjs_any(value).ok())
    {
      return Some(
        attributes
          .iter()
          .map(|(key, value)| (Arc::from(key.as_str()), value.clone()))
          .collect(),
      );
    }
    let mut attrs = Attrs::new();
    if let Some(id) = &self.annotation {
      attrs.insert(
        Arc::from("annotation"),
        Any::Map(Arc::new(HashMap::from([(
          "id".to_string(),
          Any::String(id.clone().into()),
        )]))),
      );
      // Annotation bodies are literal, but explicitly authored rich marks are
      // real content. Do not attach mention/reference/math atom semantics.
      self.visual_attrs(&mut attrs);
      return Some(attrs);
    }
    if let Some(mention) = &self.mention {
      attrs.insert(
        Arc::from("mention"),
        Any::Map(Arc::new(HashMap::from([(
          "member".into(),
          Any::String(mention.member.clone().into()),
        )]))),
      );
    }
    if let Some(footnote) = &self.footnote {
      if let Ok(value) = json_to_yjs_any(footnote) {
        attrs.insert(Arc::from("footnote"), value);
      }
    }
    if let Some(latex) = &self.latex {
      attrs.insert(Arc::from("latex"), Any::String(latex.clone().into()));
    }
    self.visual_attrs(&mut attrs);
    if let Some(reference) = &self.reference {
      let mut payload = HashMap::new();
      payload.insert("type".to_string(), Any::String(Arc::from("LinkedPage")));
      payload.insert("pageId".to_string(), Any::String(reference.page_id.clone().into()));
      if let Some(title) = &reference.title {
        payload.insert("title".to_string(), Any::String(title.clone().into()));
      }
      if let Some(description) = &reference.description {
        payload.insert("description".to_string(), Any::String(description.clone().into()));
      }
      if let Some(params) = &reference.params {
        if let Ok(params) = json_to_yjs_any(params) {
          payload.insert("params".to_string(), params);
        }
      }
      attrs.insert(Arc::from("reference"), Any::Map(Arc::new(payload)));
    }
    if self.image_source.is_some() {
      // The text remains ordinary Markdown for client compatibility. This
      // marker only prevents the server exporter from escaping that owned
      // syntax as though it were user-authored literal punctuation.
      attrs.insert(Arc::from("markdown-image"), Any::Bool(true));
      attrs.insert(
        Arc::from("markdown-image-source"),
        Any::String(self.image_source.clone().expect("checked image source").into()),
      );
      attrs.insert(
        Arc::from("markdown-image-caption"),
        Any::String(self.image_caption.clone().unwrap_or_default().into()),
      );
    }
    (!attrs.is_empty()).then_some(attrs)
  }

  fn visual_attrs(&self, attrs: &mut Attrs) {
    for (name, enabled) in [
      ("bold", self.bold),
      ("italic", self.italic),
      ("strike", self.strike),
      ("underline", self.underline),
      ("code", self.code),
    ] {
      if enabled {
        attrs.insert(Arc::from(name), Any::Bool(true));
      }
    }
    for (name, value) in [
      ("color", &self.color),
      ("labelTone", &self.label_tone),
      ("background", &self.background),
      ("link", &self.link),
    ] {
      if let Some(value) = value {
        attrs.insert(Arc::from(name), Any::String(value.clone().into()));
      }
    }
  }
}

/// Saved nesting; restore it on the same builder after finishing the container.
pub struct YjsContentContext {
  parent: Option<String>,
  list_parents: Vec<String>,
}

/// Low-level writer for the canonical Virgultum page/surface/note/block Yjs
/// shape. The empty surface is required even for page-first imports because
/// native diagram blocks materialize their editable projection through it.
///
/// Import adapters own parsing and normalization; this builder only owns block
/// identity, parent/child wiring, attributed text and binary update encoding.
/// It deliberately carries no Markdown, HTML or Notion types.
/// Explicit parent IDs in child writers must come from this builder, never the
/// source file. Omitted parents use the active native content container.
pub struct YjsDocumentBuilder {
  doc: Doc,
  blocks: yrs::MapRef,
  note_children: yrs::ArrayRef,
  import_id: String,
  counter: u64,
  block_count: usize,
  list_parent_ids: Vec<String>,
  content_parent: Option<String>,
}

impl YjsDocumentBuilder {
  pub fn new(title: &str) -> Self {
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let import_id = Uuid::new_v4().simple().to_string();
    let page_id = format!("mcp-block-{import_id}-{:016x}", 1);
    let surface_id = format!("mcp-block-{import_id}-{:016x}", 2);
    let note_id = format!("mcp-block-{import_id}-{:016x}", 3);
    let note_children = {
      let mut txn = doc.transact_mut();
      let (page, page_children) = create_yjs_block(&blocks, &mut txn, &page_id, "myoxus:page");
      page_children.push_back(&mut txn, surface_id.as_str());
      page_children.push_back(&mut txn, note_id.as_str());
      page.insert(&mut txn, "prop:title", yrs::TextPrelim::new(title));
      let (surface, _) = create_yjs_block(&blocks, &mut txn, &surface_id, "myoxus:surface");
      let boxed_elements = surface.insert(&mut txn, "prop:elements", yrs::MapPrelim::default());
      boxed_elements.insert(&mut txn, "type", "$virgultum:internal:native$");
      boxed_elements.insert(&mut txn, "value", yrs::MapPrelim::default());
      let (_, note_children) = create_yjs_block(&blocks, &mut txn, &note_id, "myoxus:note");
      note_children
    };
    Self {
      doc,
      blocks,
      note_children,
      import_id,
      counter: 3,
      block_count: 0,
      list_parent_ids: Vec::new(),
      content_parent: None,
    }
  }

  /// Reserve a detached native definition before resolving forward inline targets.
  /// Format adapters fill/attach it through `begin_footnote_body` after the main body.
  pub fn reserve_footnote_definition(&mut self, label: &str) -> String {
    let id = self.next_id();
    let mut txn = self.doc.transact_mut();
    let (block, _) = create_yjs_block(&self.blocks, &mut txn, &id, "myoxus:footnote-definition");
    block.insert(&mut txn, "prop:label", label);
    block.insert(&mut txn, "prop:placement", "footnote");
    drop(txn);
    self.block_count += 1;
    id
  }

  /// Route the ordinary native block writers into one reserved note definition.
  /// Definitions are root content, never nested in a preceding list or note.
  pub fn begin_footnote_body(&mut self, id: &str, placement: footnote::FootnotePlacement) -> Result<(), &'static str> {
    if self.content_parent.is_some() {
      return Err("Nested native note definitions are unsupported");
    }
    let mut txn = self.doc.transact_mut();
    let Some(yrs::Out::YMap(block)) = self.blocks.get(&txn, id) else {
      return Err("Native note definition is missing");
    };
    if !matches!(block.get(&txn, "sys:flavour"), Some(yrs::Out::Any(Any::String(kind))) if kind.as_ref() == "myoxus:footnote-definition")
      || self
        .note_children
        .iter(&txn)
        .any(|child| matches!(child, yrs::Out::Any(Any::String(value)) if value.as_ref() == id))
    {
      return Err("Invalid or already attached native note definition");
    }
    block.insert(
      &mut txn,
      "prop:placement",
      match placement {
        footnote::FootnotePlacement::Footnote => "footnote",
        footnote::FootnotePlacement::Endnote => "endnote",
      },
    );
    self.note_children.push_back(&mut txn, id);
    self.content_parent = Some(id.to_string());
    self.list_parent_ids.clear();
    Ok(())
  }

  /// Finish a note body before writing another root block; empty notes still own
  /// an editable paragraph, just like the existing Markdown note importer.
  pub fn end_footnote_body(&mut self) {
    if let Some(id) = self.content_parent.take() {
      let empty = {
        let txn = self.doc.transact();
        matches!(self.blocks.get(&txn, &id), Some(yrs::Out::YMap(block)) if matches!(block.get(&txn, "sys:children"), Some(yrs::Out::YArray(children)) if children.len(&txn) == 0))
      };
      if empty {
        self.push_paragraph_under(&[], Some(&id));
      }
    }
    self.list_parent_ids.clear();
  }

  /// Enter children of a container created by this builder, retaining the outer
  /// list context for restoration. Never pass an untrusted source-format ID.
  pub fn enter_content_parent(&mut self, parent: String) -> YjsContentContext {
    YjsContentContext {
      parent: self.content_parent.replace(parent),
      list_parents: std::mem::take(&mut self.list_parent_ids),
    }
  }

  pub fn restore_content_parent(&mut self, context: YjsContentContext) {
    self.content_parent = context.parent;
    self.list_parent_ids = context.list_parents;
  }

  /// An ordinary indented continuation belongs to the already-created list
  /// item at that depth; absent ancestors stay in the current content parent.
  pub fn parent_at_list_depth(&self, depth: usize) -> Option<&str> {
    depth
      .checked_sub(1)
      .and_then(|index| self.list_parent_ids.get(index))
      .map(String::as_str)
      .or(self.content_parent.as_deref())
  }

  fn next_id(&mut self) -> String {
    self.counter += 1;
    format!("mcp-block-{}-{:016x}", self.import_id, self.counter)
  }

  fn finish_root_block(&mut self) {
    self.block_count += 1;
    self.list_parent_ids.clear();
  }

  fn attach_block(
    blocks: &yrs::MapRef,
    note_children: &yrs::ArrayRef,
    txn: &mut yrs::TransactionMut<'_>,
    id: &str,
    parent_id: Option<&str>,
  ) {
    if let Some(parent_id) = parent_id
      && let Some(yrs::Out::YMap(parent)) = blocks.get(txn, parent_id)
      && let Some(yrs::Out::YArray(children)) = parent.get(txn, "sys:children")
    {
      children.push_back(txn, id);
    } else {
      note_children.push_back(txn, id);
    }
  }

  pub fn push_paragraph_under(&mut self, segments: &[YjsTextSegment], parent_id: Option<&str>) -> String {
    self.push_paragraph_typed_under(segments, None, parent_id)
  }

  pub fn push_quote_under(&mut self, segments: &[YjsTextSegment], parent_id: Option<&str>) -> String {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let block = create_yjs_text_block(&self.blocks, &mut txn, &id, "myoxus:paragraph", segments);
      block.insert(&mut txn, "prop:type", "quote");
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        parent_id.or(self.content_parent.as_deref()),
      );
    }
    self.block_count += 1;
    id
  }

  pub fn push_callout_under(
    &mut self,
    kind: &str,
    title: &str,
    foldable: bool,
    default_open: bool,
    parent_id: Option<&str>,
  ) -> String {
    let id = self.next_id();
    let mut txn = self.doc.transact_mut();
    let block = create_yjs_text_block(&self.blocks, &mut txn, &id, "myoxus:callout", &[]);
    block.insert(&mut txn, "prop:type", kind);
    block.insert(&mut txn, "prop:foldable", foldable);
    block.insert(&mut txn, "prop:defaultOpen", default_open);
    block.insert(&mut txn, "prop:title", yrs::TextPrelim::new(title));
    let (icon, background) = match kind.to_ascii_lowercase().as_str() {
      "warning" | "caution" | "attention" => ("⚠️", "yellow"),
      "danger" | "error" | "failure" | "fail" | "missing" | "bug" => ("⛔", "red"),
      "tip" | "hint" | "important" => ("💡", "green"),
      "success" | "check" | "done" => ("✅", "green"),
      "question" | "help" | "faq" => ("❓", "yellow"),
      "info" | "todo" | "abstract" | "summary" | "tldr" => ("ℹ️", "blue"),
      "example" => ("💡", "purple"),
      "quote" | "cite" => ("💬", "grey"),
      _ => ("💡", "grey"),
    };
    block.insert(&mut txn, "prop:backgroundColorName", background);
    block.insert(
      &mut txn,
      "prop:icon",
      Any::Map(std::sync::Arc::new(std::collections::HashMap::from([
        ("type".to_string(), Any::String("emoji".into())),
        ("unicode".to_string(), Any::String(icon.into())),
      ]))),
    );
    Self::attach_block(
      &self.blocks,
      &self.note_children,
      &mut txn,
      &id,
      parent_id.or(self.content_parent.as_deref()),
    );
    self.block_count += 1;
    id
  }

  /// Fill a newly imported text container before any child owns its body order.
  pub fn set_container_body(&mut self, id: &str, segments: &[YjsTextSegment]) {
    let mut txn = self.doc.transact_mut();
    if let Some(yrs::Out::YMap(block)) = self.blocks.get(&txn, id) {
      let text = block.insert(&mut txn, "prop:text", yrs::TextPrelim::new(""));
      insert_yjs_segments(&text, &mut txn, 0, segments);
    }
  }

  pub(crate) fn push_synced_doc_under(
    &mut self,
    reference: &MarkdownDocumentReference,
    parent_id: Option<&str>,
  ) -> String {
    let id = self.next_id();
    let mut txn = self.doc.transact_mut();
    let (block, _) = create_yjs_block(&self.blocks, &mut txn, &id, "myoxus:embed-synced-doc");
    block.insert(&mut txn, "prop:pageId", reference.page_id.as_str());
    block.insert(&mut txn, "prop:style", "syncedDoc");
    block.insert(&mut txn, "prop:index", "a0");
    block.insert(&mut txn, "prop:xywh", "[0,0,800,100]");
    if let Some(description) = &reference.description {
      block.insert(&mut txn, "prop:description", description.as_str());
    }
    if let Some(title) = &reference.title {
      block.insert(&mut txn, "prop:title", title.as_str());
    }
    if let Some(params) = &reference.params {
      block.insert(
        &mut txn,
        "prop:params",
        json_to_yjs_any(params).expect("JSON reference parameters"),
      );
    }
    Self::attach_block(
      &self.blocks,
      &self.note_children,
      &mut txn,
      &id,
      parent_id.or(self.content_parent.as_deref()),
    );
    self.block_count += 1;
    id
  }

  pub fn push_paragraph(&mut self, segments: &[YjsTextSegment]) {
    self.push_paragraph_typed(segments, None);
  }

  pub(crate) fn push_annotation_under(&mut self, body: &str, parent_id: Option<&str>) -> String {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      create_yjs_text_block(
        &self.blocks,
        &mut txn,
        &id,
        "myoxus:annotation",
        &[YjsTextSegment::plain(body)],
      );
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        parent_id.or(self.content_parent.as_deref()),
      );
    }
    self.block_count += 1;
    id
  }

  pub fn push_heading(&mut self, level: u8, segments: &[YjsTextSegment]) {
    self.push_paragraph_typed(segments, Some(level.clamp(1, 6)));
  }

  pub fn push_quote(&mut self, segments: &[YjsTextSegment]) {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let block = create_yjs_text_block(&self.blocks, &mut txn, &id, "myoxus:paragraph", segments);
      block.insert(&mut txn, "prop:type", "quote");
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        self.content_parent.as_deref(),
      );
    }
    self.finish_root_block();
  }

  fn push_paragraph_typed(&mut self, segments: &[YjsTextSegment], heading: Option<u8>) {
    self.push_paragraph_typed_under(segments, heading, None);
    self.list_parent_ids.clear();
  }

  pub fn push_paragraph_typed_under(
    &mut self,
    segments: &[YjsTextSegment],
    heading: Option<u8>,
    parent_id: Option<&str>,
  ) -> String {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let block = create_yjs_text_block(&self.blocks, &mut txn, &id, "myoxus:paragraph", segments);
      if let Some(level) = heading {
        block.insert(&mut txn, "prop:type", format!("h{level}"));
        block.insert(&mut txn, "prop:collapsed", false);
      }
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        parent_id.or(self.content_parent.as_deref()),
      );
    }
    self.block_count += 1;
    id
  }

  pub(crate) fn push_list_item_under(
    &mut self,
    segments: &[YjsTextSegment],
    ordered: bool,
    order: Option<u64>,
    checked: Option<bool>,
    parent_id: Option<&str>,
  ) -> String {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let block = create_yjs_text_block(&self.blocks, &mut txn, &id, "myoxus:list", segments);
      if let Some(checked) = checked {
        block.insert(&mut txn, "prop:type", "todo");
        block.insert(&mut txn, "prop:checked", checked);
      } else {
        block.insert(&mut txn, "prop:type", if ordered { "numbered" } else { "bulleted" });
        block.insert(&mut txn, "prop:checked", false);
      }
      if ordered {
        // The native ListProps contract uses a JavaScript number, not bigint.
        block.insert(&mut txn, "prop:order", Any::from(order.unwrap_or(1) as f64));
      }
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        parent_id.or(self.content_parent.as_deref()),
      );
    }
    self.block_count += 1;
    id
  }

  pub fn push_code_under(&mut self, language: &str, text: &str, parent_id: Option<&str>) -> String {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let (block, _) = create_yjs_block(&self.blocks, &mut txn, &id, "myoxus:code");
      block.insert(&mut txn, "prop:text", yrs::TextPrelim::new(text));
      block.insert(&mut txn, "prop:language", language);
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        parent_id.or(self.content_parent.as_deref()),
      );
    }
    self.block_count += 1;
    id
  }

  /// Store a complete display-formula source. Parsing and any format-specific
  /// limits belong to the caller; inline math uses `YjsTextSegment::latex`.
  pub fn push_latex_under(&mut self, latex: &str, parent_id: Option<&str>) -> String {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let (block, _) = create_yjs_block(&self.blocks, &mut txn, &id, "myoxus:latex");
      block.insert(&mut txn, "sys:version", 1.0);
      block.insert(&mut txn, "prop:latex", latex);
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        parent_id.or(self.content_parent.as_deref()),
      );
    }
    self.block_count += 1;
    id
  }

  pub fn push_table_under(
    &mut self,
    rows: &[Vec<Vec<YjsTextSegment>>],
    alignments: &[Option<String>],
    parent_id: Option<&str>,
    header_rows: Option<usize>,
  ) -> Option<String> {
    let id = self.next_id();
    let inserted = {
      let mut txn = self.doc.transact_mut();
      let inserted = create_yjs_table_block(&self.blocks, &mut txn, &id, rows, alignments, header_rows).is_some();
      if inserted {
        Self::attach_block(
          &self.blocks,
          &self.note_children,
          &mut txn,
          &id,
          parent_id.or(self.content_parent.as_deref()),
        );
      }
      inserted
    };
    if inserted {
      self.block_count += 1;
      Some(id)
    } else {
      None
    }
  }

  pub fn push_list_item(&mut self, segments: &[YjsTextSegment], ordered: bool, depth: usize, checked: Option<bool>) {
    self.push_list_item_with_order(segments, ordered, depth, checked, None);
  }

  /// Add an imported list item with an explicit Word numbering value. The
  /// editor's `order` is a JavaScript number and cannot represent larger u64s.
  pub fn push_list_item_with_order(
    &mut self,
    segments: &[YjsTextSegment],
    ordered: bool,
    depth: usize,
    checked: Option<bool>,
    order: Option<u64>,
  ) {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let block = create_yjs_text_block(&self.blocks, &mut txn, &id, "myoxus:list", segments);
      if let Some(checked) = checked {
        block.insert(&mut txn, "prop:type", "todo");
        block.insert(&mut txn, "prop:checked", checked);
      } else {
        block.insert(&mut txn, "prop:type", if ordered { "numbered" } else { "bulleted" });
        block.insert(&mut txn, "prop:checked", false);
      }
      if ordered && let Some(order) = order {
        block.insert(
          &mut txn,
          "prop:order",
          Any::from(order.min(9_007_199_254_740_991) as f64),
        );
      }
      let attached = if depth == 0 {
        false
      } else if let Some(parent_id) = self.list_parent_ids.get(depth - 1) {
        if let Some(yrs::Out::YMap(parent)) = self.blocks.get(&txn, parent_id.as_str())
          && let Some(yrs::Out::YArray(children)) = parent.get(&txn, "sys:children")
        {
          children.push_back(&mut txn, id.as_str());
          true
        } else {
          false
        }
      } else {
        false
      };
      if !attached {
        Self::attach_block(
          &self.blocks,
          &self.note_children,
          &mut txn,
          &id,
          self.content_parent.as_deref(),
        );
      }
    }
    self.list_parent_ids.truncate(depth);
    self.list_parent_ids.push(id);
    self.block_count += 1;
  }

  pub fn push_code(&mut self, language: &str, text: &str) {
    self.push_code_under(language, text, None);
    self.list_parent_ids.clear();
  }

  /// Adds the editor's native Mermaid block without interpreting its source.
  pub fn push_mermaid(&mut self, source: &str, title: &str, caption: &str) {
    self.push_mermaid_under(source, title, caption, None);
    self.list_parent_ids.clear();
  }

  /// Adds a native Mermaid block below the supplied container while keeping
  /// source bytes authoritative and native-only metadata separate.
  pub fn push_mermaid_under(&mut self, source: &str, title: &str, caption: &str, parent_id: Option<&str>) {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let (block, _) = create_yjs_block(&self.blocks, &mut txn, &id, "myoxus:mermaid");
      block.insert(&mut txn, "prop:source", yrs::TextPrelim::new(source));
      block.insert(&mut txn, "prop:title", yrs::TextPrelim::new(title));
      if !caption.is_empty() {
        block.insert(&mut txn, "prop:caption", caption);
      }
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        parent_id.or(self.content_parent.as_deref()),
      );
    }
    self.block_count += 1;
  }

  pub fn push_divider(&mut self) {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let (block, _) = create_yjs_block(&self.blocks, &mut txn, &id, "myoxus:divider");
      block.insert(&mut txn, "prop:text", yrs::TextPrelim::new(""));
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        self.content_parent.as_deref(),
      );
    }
    self.finish_root_block();
  }

  pub fn push_table(&mut self, rows: &[Vec<Vec<YjsTextSegment>>]) {
    self.push_table_with_alignments(rows, &[]);
  }

  /// Adds a flat table while preserving optional GFM alignment by column index.
  pub fn push_table_with_alignments(&mut self, rows: &[Vec<Vec<YjsTextSegment>>], alignments: &[Option<String>]) {
    if self.push_table_under(rows, alignments, None, None).is_some() {
      self.list_parent_ids.clear();
    }
  }

  /// Preserve the source's consecutive header rows in a native editable table.
  pub fn push_table_with_header_rows(&mut self, rows: &[Vec<Vec<YjsTextSegment>>], header_rows: usize) {
    if self.push_table_under(rows, &[], None, Some(header_rows)).is_some() {
      self.list_parent_ids.clear();
    }
  }

  pub fn push_image(&mut self, source_id: &str, caption: &str) {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let (block, _) = create_yjs_block(&self.blocks, &mut txn, &id, "myoxus:image");
      block.insert(&mut txn, "prop:sourceId", source_id);
      block.insert(&mut txn, "prop:caption", caption);
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        self.content_parent.as_deref(),
      );
    }
    self.finish_root_block();
  }

  pub fn push_file(&mut self, source_id: &str, name: &str, mime: &str, size: i64) {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let (block, _) = create_yjs_block(&self.blocks, &mut txn, &id, "myoxus:attachment");
      block.insert(&mut txn, "prop:sourceId", source_id);
      block.insert(&mut txn, "prop:name", name);
      block.insert(&mut txn, "prop:type", mime);
      block.insert(&mut txn, "prop:size", Any::BigInt(size));
      block.insert(&mut txn, "prop:embed", false);
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        self.content_parent.as_deref(),
      );
    }
    self.finish_root_block();
  }

  pub fn push_bookmark(&mut self, url: &str, title: &str) {
    let id = self.next_id();
    {
      let mut txn = self.doc.transact_mut();
      let (block, _) = create_yjs_block(&self.blocks, &mut txn, &id, "myoxus:bookmark");
      block.insert(&mut txn, "prop:url", url);
      block.insert(&mut txn, "prop:title", title);
      block.insert(&mut txn, "prop:caption", title);
      block.insert(&mut txn, "prop:style", "horizontal");
      Self::attach_block(
        &self.blocks,
        &self.note_children,
        &mut txn,
        &id,
        self.content_parent.as_deref(),
      );
    }
    self.finish_root_block();
  }

  pub fn block_count(&self) -> usize {
    self.block_count
  }

  /// Latest allocation only when it already materialized a block. Importers
  /// use this after writing content, never to predict or manufacture identities.
  pub fn last_created_block_id(&self) -> Option<String> {
    let id = format!("mcp-block-{}-{:016x}", self.import_id, self.counter);
    self.blocks.get(&self.doc.transact(), &id).map(|_| id)
  }

  /// Bind source fragments only after all native targets exist. A relative
  /// query selects an actual generated block on the newly published Page.
  /// Unresolved names lose only their link, not the authored visible alias.
  pub fn bind_local_bookmark_links(&mut self, targets: &BTreeMap<String, String>) -> usize {
    let mut txn = self.doc.transact_mut();
    let mut missing = 0;
    let blocks = self
      .blocks
      .iter(&txn)
      .filter_map(|(_, value)| match value {
        yrs::Out::YMap(block) => Some(block),
        _ => None,
      })
      .collect::<Vec<_>>();
    for block in blocks {
      let texts = block
        .iter(&txn)
        .filter_map(|(_, value)| match value {
          yrs::Out::YText(text) => Some(text),
          _ => None,
        })
        .collect::<Vec<_>>();
      for text in texts {
        let mut offset = 0;
        for run in text.diff(&txn, |_| ()) {
          let length = match &run.insert {
            yrs::Out::Any(Any::String(text)) => text.len() as u32,
            _ => 1,
          };
          if let Some(Any::String(link)) = run.attributes.as_deref().and_then(|attrs| attrs.get("link"))
            && let Some(name) = link.strip_prefix('#')
          {
            // Targets come from this builder's URI-safe generated identities.
            let value = if let Some(target) = targets.get(name) {
              Any::String(format!("?blockIds={target}").into())
            } else {
              missing += 1;
              Any::Null
            };
            text.format(&mut txn, offset, length, Attrs::from([(Arc::from("link"), value)]));
          }
          offset += length;
        }
      }
    }
    missing
  }

  pub fn state_vector(&self) -> StateVector {
    self.doc.transact().state_vector()
  }

  pub fn encode_state(&self) -> Vec<u8> {
    self.doc.transact().encode_state_as_update_v1(&StateVector::default())
  }

  pub fn encode_diff(&self, state_vector: &StateVector) -> Vec<u8> {
    self.doc.transact().encode_diff_v1(state_vector)
  }

  pub fn encode(self) -> Vec<u8> {
    self.encode_state()
  }
}

fn create_yjs_block(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  id: &str,
  flavour: &str,
) -> (yrs::MapRef, yrs::ArrayRef) {
  let block = blocks.insert(txn, id, yrs::MapPrelim::default());
  block.insert(txn, "sys:id", id);
  block.insert(txn, "sys:flavour", flavour);
  let children = block.insert(txn, "sys:children", yrs::ArrayPrelim::default());
  (block, children)
}

fn insert_yjs_segments(
  text: &yrs::TextRef,
  txn: &mut yrs::TransactionMut<'_>,
  mut offset: u32,
  segments: &[YjsTextSegment],
) {
  for segment in segments {
    let len = segment.text.len() as u32;
    if len > 0 {
      // Explicit attributes (including an empty set) prevent adjacent formatting
      // or semantic atoms from leaking into an admitted rich replacement.
      text.insert_with_attributes(txn, offset, &segment.text, segment.to_attrs().unwrap_or_default());
    }
    offset += len;
  }
}

fn create_yjs_text_block(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  id: &str,
  flavour: &str,
  segments: &[YjsTextSegment],
) -> yrs::MapRef {
  let (block, _) = create_yjs_block(blocks, txn, id, flavour);
  let text = block.insert(txn, "prop:text", yrs::TextPrelim::new(""));
  insert_yjs_segments(&text, txn, 0, segments);
  block
}

fn create_yjs_table_block(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  id: &str,
  rows: &[Vec<Vec<YjsTextSegment>>],
  alignments: &[Option<String>],
  header_rows: Option<usize>,
) -> Option<yrs::MapRef> {
  let column_count = rows.iter().map(Vec::len).max().unwrap_or(0);
  if rows.is_empty() || column_count == 0 || header_rows.is_some_and(|count| count > rows.len()) {
    return None;
  }
  let (block, _) = create_yjs_block(blocks, txn, id, "myoxus:table");
  if let Some(count) = header_rows {
    block.insert(txn, "prop:headerRows", count as f64);
  }
  // These keys are also consumed by the editor's fractional-index generator.
  // The nonzero suffix keeps ordinal zeroes from becoming an invalid fraction.
  for row_index in 0..rows.len() {
    let row_id = format!("row-{row_index:04}");
    block.insert(txn, format!("prop:rows.{row_id}.rowId").as_str(), row_id.as_str());
    block.insert(
      txn,
      format!("prop:rows.{row_id}.order").as_str(),
      format!("a0{row_index:08}1").as_str(),
    );
  }
  for column_index in 0..column_count {
    let column_id = format!("col-{column_index:04}");
    block.insert(
      txn,
      format!("prop:columns.{column_id}.columnId").as_str(),
      column_id.as_str(),
    );
    block.insert(
      txn,
      format!("prop:columns.{column_id}.order").as_str(),
      format!("a0{column_index:08}1").as_str(),
    );
    if let Some(alignment @ ("left" | "center" | "right")) = alignments.get(column_index).and_then(Option::as_deref) {
      block.insert(txn, format!("prop:columns.{column_id}.textAlign").as_str(), alignment);
    }
  }
  for (row_index, row) in rows.iter().enumerate() {
    let row_id = format!("row-{row_index:04}");
    for column_index in 0..column_count {
      let column_id = format!("col-{column_index:04}");
      let text = block.insert(
        txn,
        format!("prop:cells.{row_id}:{column_id}.text").as_str(),
        yrs::TextPrelim::new(""),
      );
      if let Some(segments) = row.get(column_index) {
        insert_yjs_segments(&text, txn, 0, segments);
      }
    }
  }
  Some(block)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Arc;
  use yrs::{GetString, Text};

  #[test]
  fn yrs_selective_undo_clear_preserves_other_stack_and_reports_actual_changes() {
    use std::sync::{Arc, Mutex};
    use yrs::{Doc, GetString, Text, Transact, UndoManager};

    for (clear_undo, clear_redo) in [(true, false), (false, true), (true, true)] {
      let doc = Doc::new();
      let text = doc.get_or_insert_text("text");
      let mut undo = UndoManager::new();
      undo.expand_scope(&doc, &text);
      text.insert(&mut doc.transact_mut(), 0, "a");
      undo.reset();
      text.insert(&mut doc.transact_mut(), 1, "b");
      assert!(undo.undo_blocking());
      assert!(undo.can_undo() && undo.can_redo());
      let events = Arc::new(Mutex::new(Vec::new()));
      let observed = events.clone();
      undo.observe_stack_cleared("selective-clear-regression", move |event| {
        observed
          .lock()
          .unwrap()
          .push((event.undo_stack_cleared, event.redo_stack_cleared));
      });
      for _ in 0..2 {
        match (clear_undo, clear_redo) {
          (true, false) => undo.clear_undo(),
          (false, true) => undo.clear_redo(),
          _ => undo.clear_all(),
        }
        assert_eq!(undo.can_undo(), !clear_undo);
        assert_eq!(undo.can_redo(), !clear_redo);
        assert_eq!(text.get_string(&doc.transact()), "a");
        assert_eq!(*events.lock().unwrap(), vec![(clear_undo, clear_redo)]);
      }
      if !clear_undo {
        assert!(undo.undo_blocking());
        assert_eq!(text.get_string(&doc.transact()), "");
      } else if !clear_redo {
        assert!(undo.redo_blocking());
        assert_eq!(text.get_string(&doc.transact()), "ab");
      }
    }
  }

  fn valid_text_update() -> Vec<u8> {
    let doc = Doc::new();
    let text = doc.get_or_insert_text("body");
    let mut txn = doc.transact_mut();
    text.insert(&mut txn, 0, "incremental content");
    txn.encode_update_v1()
  }

  fn incremental_update_without_its_predecessor() -> Vec<u8> {
    let doc = Doc::new();
    let text = doc.get_or_insert_text("body");
    {
      let mut txn = doc.transact_mut();
      text.insert(&mut txn, 0, "predecessor");
    }
    let mut txn = doc.transact_mut();
    text.insert(&mut txn, 10, " successor");
    txn.encode_update_v1()
  }

  #[test]
  fn validate_update_v1_accepts_structurally_valid_incremental_update() {
    let update = valid_text_update();
    assert!(validate_update_v1(&update).is_ok());
  }

  #[test]
  fn decode_only_accepts_update_with_missing_dependencies() {
    // Decoder-only validation must not require a receiving document or an
    // already-present CRDT state vector. A valid update remains admissible for
    // a client that is still synchronizing its missing structs.
    let update = incremental_update_without_its_predecessor();
    assert!(validate_update_v1(&update).is_ok());
  }

  #[test]
  fn materialize_diff_applies_ordered_updates_once_and_returns_incremental_tail() {
    let source = Doc::new();
    let text = source.get_or_insert_text("body");
    {
      let mut txn = source.transact_mut();
      text.insert(&mut txn, 0, "base");
    }
    let snapshot = source.transact().encode_state_as_update_v1(&StateVector::default());
    let client_state = source.transact().state_vector().encode_v1();
    let before = source.transact().state_vector();
    {
      let mut txn = source.transact_mut();
      text.insert(&mut txn, 4, " tail");
    }
    let tail = source.transact().encode_state_as_update_v1(&before);

    let result =
      materialize_diff_v1([&snapshot, &tail], Some(&client_state), 1024, || false).expect("ordered materialization");
    assert_eq!(result.update_count, 2);
    assert_eq!(result.input_bytes, snapshot.len() + tail.len());
    assert!(result.missing.len() < snapshot.len() + tail.len());

    let client = Doc::new();
    let client_text = client.get_or_insert_text("body");
    let mut txn = client.transact_mut();
    txn
      .apply_update(Update::decode_v1(&snapshot).expect("decode snapshot"))
      .expect("apply snapshot");
    txn
      .apply_update(Update::decode_v1(&result.missing).expect("decode tail"))
      .expect("apply tail");
    drop(txn);
    assert_eq!(client_text.get_string(&client.transact()), "base tail");
  }

  #[test]
  fn materialize_diff_fails_closed_for_state_size_and_cancellation() {
    let update = valid_text_update();
    assert_eq!(
      materialize_diff_v1([&update], Some(&[0xff]), usize::MAX, || false),
      Err(YjsDiffMaterializationError::InvalidStateVector)
    );
    assert_eq!(
      materialize_diff_v1([&update], None, update.len() - 1, || false),
      Err(YjsDiffMaterializationError::InputTooLarge)
    );
    assert_eq!(
      materialize_diff_v1([&update], None, usize::MAX, || true),
      Err(YjsDiffMaterializationError::Cancelled)
    );
  }

  #[test]
  fn candidate_classification_preserves_new_structs_with_equal_visible_text() {
    let existing = valid_text_update();
    let candidate = valid_text_update();
    let result = materialize_candidate_v1(
      [&existing],
      decode_update_v1(&candidate).expect("decode candidate"),
      usize::MAX,
      || false,
    )
    .expect("classify candidate");

    assert!(result.has_new_structs, "new client clocks are durable CRDT information");
    assert!(!result.is_crdt_noop());
    assert!(result.state_vector.is_some());
  }

  #[test]
  fn candidate_classification_rejects_reencoded_known_structs_and_repeated_delete_set() {
    let source = Doc::new();
    let text = source.get_or_insert_text("body");
    let insert = {
      let mut txn = source.transact_mut();
      text.insert(&mut txn, 0, "temporary");
      txn.encode_update_v1()
    };
    let delete = {
      let mut txn = source.transact_mut();
      text.remove_range(&mut txn, 0, 9);
      txn.encode_update_v1()
    };
    let known_state = source.transact().state_vector().encode_v1();
    let known_insert = decode_update_v1(&insert).expect("decode known insert");
    assert_eq!(
      known_insert
        .classify_struct_clocks(&known_state)
        .expect("classify known clocks"),
      YjsStructClockNovelty::None
    );

    let result = materialize_candidate_v1(
      [&insert, &delete],
      decode_update_v1(&delete).expect("decode repeated delete"),
      usize::MAX,
      || false,
    )
    .expect("classify repeated delete");
    assert!(!result.has_new_structs);
    assert!(!result.canonical_changed);
    assert!(result.is_crdt_noop());
  }

  #[test]
  fn candidate_classification_keeps_discontinuous_structs_reconstructable() {
    let candidate = incremental_update_without_its_predecessor();
    let decoded = decode_update_v1(&candidate).expect("decode incremental candidate");
    assert_eq!(
      decoded
        .classify_struct_clocks(&StateVector::default().encode_v1())
        .expect("classify clocks"),
      YjsStructClockNovelty::Discontinuous
    );

    let result = materialize_candidate_v1(std::iter::empty::<&[u8]>(), decoded, usize::MAX, || false)
      .expect("materialize pending candidate");
    assert!(result.has_new_structs);
    assert!(!result.is_crdt_noop());
    assert_eq!(result.state_vector, None);
  }

  #[tokio::test]
  async fn guarded_decoder_retains_one_decode_across_fast_and_materialized_plans() {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
    let payload = valid_text_update();
    let permit = semaphore.clone().acquire_owned().await.expect("decoder permit");
    let (_payload, guarded) = decode_update_v1_guarded(payload, permit).await.expect("guarded decode");
    let mut session = guarded
      .classify(Some(empty_state_vector_v1()), usize::MAX)
      .expect("start fast classification");
    let YjsCandidatePlan::Complete(fast) = session.plan().await.expect("fast plan") else {
      panic!("new contiguous structs must not materialize persisted state");
    };
    assert!(!fast.is_crdt_noop);
    assert!(fast.state_vector.is_some());

    let source = Doc::new();
    let text = source.get_or_insert_text("body");
    let insert = {
      let mut txn = source.transact_mut();
      text.insert(&mut txn, 0, "delete me");
      txn.encode_update_v1()
    };
    let state_after_insert = source.transact().state_vector().encode_v1();
    let delete = {
      let mut txn = source.transact_mut();
      text.remove_range(&mut txn, 0, 9);
      txn.encode_update_v1()
    };
    let permit = semaphore.clone().acquire_owned().await.expect("decoder permit");
    let (_payload, guarded) = decode_update_v1_guarded(delete, permit)
      .await
      .expect("guarded delete decode");
    let mut session = guarded
      .classify(Some(state_after_insert), usize::MAX)
      .expect("start delete classification");
    assert_eq!(
      session.plan().await.expect("delete plan"),
      YjsCandidatePlan::Materialize
    );
    session.send_update(insert).await.expect("stream current state");
    let materialized = session.finish().await.expect("materialized delete");
    assert!(!materialized.is_crdt_noop);
    assert!(materialized.state_vector.is_some());
  }

  #[test]
  fn validate_update_v1_rejects_malformed_wire_data_without_detail() {
    let error = validate_update_v1(&[0xff]).expect_err("malformed bytes must be rejected");
    assert_eq!(error.to_string(), "invalid Yjs v1 update");
  }

  #[test]
  fn row_reference_copy_is_atomic_and_static_projection_is_opaque() {
    let original = DatabaseRowReference {
      workspace_id: Uuid::new_v4(),
      database_id: Uuid::new_v4(),
      row_id: Uuid::new_v4(),
    };
    let target = DatabaseRowReference {
      workspace_id: Uuid::new_v4(),
      database_id: Uuid::new_v4(),
      row_id: Uuid::new_v4(),
    };
    let props =
      serde_json::json!({"serverWorkspaceId": original.workspace_id, "serverDatabaseId": original.database_id,
      "serverRowId": original.row_id, "title": "Private cached title", "cells": {"secret":"Private table payload"}})
      .as_object()
      .unwrap()
      .clone();
    let mut blocks = vec![
      PortableSnapshotBlock {
        id: "page".into(),
        flavour: "myoxus:page".into(),
        version: None,
        props: serde_json::Map::new(),
        children: vec!["note".into()],
      },
      PortableSnapshotBlock {
        id: "note".into(),
        flavour: "myoxus:note".into(),
        version: None,
        props: serde_json::Map::new(),
        children: vec!["reference".into()],
      },
      PortableSnapshotBlock {
        id: "reference".into(),
        flavour: "myoxus:database".into(),
        version: None,
        props,
        children: vec!["private-child".into()],
      },
      PortableSnapshotBlock {
        id: "private-child".into(),
        flavour: "myoxus:paragraph".into(),
        version: None,
        props: serde_json::json!({"text":"Private nested content"})
          .as_object()
          .unwrap()
          .clone(),
        children: Vec::new(),
      },
    ];
    blocks[2].children.push("private-note".into());
    blocks.push(PortableSnapshotBlock {
      id: "private-note".into(),
      flavour: "myoxus:footnote-definition".into(),
      version: None,
      props: serde_json::json!({"label":"private-label","placement":"endnote"})
        .as_object()
        .unwrap()
        .clone(),
      children: vec!["private-footer".into()],
    });
    blocks.push(PortableSnapshotBlock {
      id: "private-footer".into(),
      flavour: "myoxus:paragraph".into(),
      version: None,
      props: serde_json::json!({"text":"Private footer content"})
        .as_object()
        .unwrap()
        .clone(),
      children: Vec::new(),
    });
    let with_private_citation = |update: Vec<u8>| {
      let native = Doc::new();
      let maps = native.get_or_insert_map("blocks");
      let mut txn = native.transact_mut();
      txn.apply_update(Update::decode_v1(&update).unwrap()).unwrap();
      for id in ["reference", "private-child"] {
        let Some(yrs::Out::YMap(block)) = maps.get(&txn, id) else {
          panic!("citation block")
        };
        let text = block.insert(&mut txn, "prop:privateCitation", yrs::TextPrelim::new("Secret"));
        let payload = json_to_yjs_any(&serde_json::json!({"label":format!("private-{id}"),"reference":{"type":"url","url":"https://private.invalid/citation","title":"Private citation title"}})).unwrap();
        text.format(&mut txn, 0, 6, Attrs::from([(Arc::from("footnote"), payload)]));
      }
      txn.encode_state_as_update_v1(&StateVector::default())
    };
    let source = with_private_citation(snapshot_blocks_to_yjs(&blocks).unwrap());
    let mappings = vec![(original.clone(), target.clone())];
    let rewritten = rewrite_database_row_references(&source, &mappings, 820341).unwrap();
    let inspect = |bytes: &[u8]| {
      let doc = Doc::new();
      let map = doc.get_or_insert_map("blocks");
      let mut txn = doc.transact_mut();
      txn.apply_update(Update::decode_v1(bytes).unwrap()).unwrap();
      let yrs::Out::YMap(block) = map.get(&txn, "reference").unwrap() else {
        panic!("reference")
      };
      ["serverWorkspaceId", "serverDatabaseId", "serverRowId"].map(|key| block_prop_string(&block, &txn, key).unwrap())
    };
    assert_eq!(
      inspect(&rewritten.full_state),
      [
        target.workspace_id.to_string(),
        target.database_id.to_string(),
        target.row_id.to_string()
      ]
    );
    let reconstructed = merge_updates(vec![source.clone(), rewritten.incremental_update]).unwrap();
    assert_eq!(inspect(&reconstructed), inspect(&rewritten.full_state));
    assert_eq!(
      rewrite_database_row_references(&source, &[], 820342)
        .unwrap()
        .full_state,
      source,
      "no admitted Database means original scope"
    );
    let unchanged = rewrite_database_row_references(&source, &[(original.clone(), original.clone())], 820344).unwrap();
    assert!(
      unchanged.incremental_update.is_empty(),
      "identity mapping is a genuine no-op"
    );
    assert_eq!(
      unchanged.full_state, source,
      "a no-op preserves the exact original stream bytes"
    );
    blocks[2]
      .props
      .insert("serverViewId".into(), serde_json::json!(Uuid::new_v4()));
    let invalid = snapshot_blocks_to_yjs(&blocks).unwrap();
    let invalid_result = rewrite_database_row_references(&invalid, &mappings, 820343).unwrap();
    assert!(
      invalid_result.incremental_update.is_empty(),
      "nonempty mappings cannot manufacture a delta for an invalid Row+View"
    );
    assert_eq!(invalid_result.full_state, invalid);
    assert_eq!(
      inspect(&invalid_result.full_state),
      inspect(&invalid),
      "Row+View must remain unavailable, never repaired by copy"
    );
    let export = extract_text_from_yjs(&source).unwrap();
    assert!(
      export.citations.is_empty(),
      "opaque properties do not allocate citations"
    );
    let markdown = export.markdown;
    assert!(markdown.contains("Target unavailable"));
    for secret in [
      "Private cached title",
      "Private table payload",
      "Private nested content",
      "Private footer content",
      "Private citation title",
      "private.invalid",
    ] {
      assert!(!markdown.contains(secret), "{secret}");
    }
    blocks.remove(0);
    let rootless = with_private_citation(snapshot_blocks_to_yjs(&blocks).unwrap());
    let rootless_export = extract_text_from_yjs(&rootless).unwrap();
    assert!(rootless_export.citations.is_empty());
    let rootless_markdown = rootless_export.markdown;
    assert!(rootless_markdown.contains("Target unavailable"));
    assert!(!rootless_markdown.contains("Private nested content"));
    assert!(!rootless_markdown.contains("Private footer content"));
    assert!(!rootless_markdown.contains("Private citation title"));
    assert!(!rootless_markdown.contains("private.invalid"));
    assert!(
      extract_legacy_database_blocks(&source).unwrap().is_empty(),
      "a Row reference must not create a legacy Database"
    );
  }

  fn linked_page_attrs(page_id: &str) -> Attrs {
    let mut payload: HashMap<String, Any> = HashMap::new();
    payload.insert("type".to_string(), Any::String(Arc::from("LinkedPage")));
    payload.insert("pageId".to_string(), Any::String(Arc::from(page_id.to_string())));
    payload.insert("mode".to_string(), Any::String(Arc::from("page")));
    payload.insert(
      "blockIds".to_string(),
      Any::Array(vec![Any::String(Arc::from("block-a"))].into()),
    );
    payload.insert("xywh".to_string(), Any::String(Arc::from("[0,0,100,80]")));
    Attrs::from([(Arc::from("reference"), Any::Map(Arc::new(payload)))])
  }

  fn document_graph_test_update(build: impl FnOnce(&mut yrs::TransactionMut<'_>, &yrs::MapRef)) -> Vec<u8> {
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    build(&mut txn, &blocks);
    txn.encode_update_v1()
  }

  fn insert_page_with_note(txn: &mut yrs::TransactionMut<'_>, blocks: &yrs::MapRef, child_ids: &[&str]) {
    let page = blocks.insert(txn, "page1", yrs::MapPrelim::default());
    page.insert(txn, "sys:flavour", "myoxus:page");
    let page_children = page.insert(txn, "sys:children", yrs::ArrayPrelim::default());
    page_children.push_back(txn, "note1");

    let note = blocks.insert(txn, "note1", yrs::MapPrelim::default());
    note.insert(txn, "sys:flavour", "myoxus:note");
    let note_children = note.insert(txn, "sys:children", yrs::ArrayPrelim::default());
    for child_id in child_ids {
      note_children.push_back(txn, *child_id);
    }
  }

  fn reference_slot_fixture() -> Vec<u8> {
    document_graph_test_update(|txn, blocks| {
      insert_page_with_note(txn, blocks, &["container", "task", "paragraph"]);
      for id in ["page1", "note1"] {
        let Some(yrs::Out::YMap(block)) = blocks.get(txn, id) else {
          panic!("reference fixture root")
        };
        block.insert(txn, "sys:id", id);
      }
      for (id, key, kind) in [
        ("container", "context.container", "database"),
        ("task", "context.task", "task"),
      ] {
        let block = blocks.insert(txn, id, yrs::MapPrelim::default());
        block.insert(txn, "sys:id", id);
        block.insert(txn, "sys:flavour", "myoxus:database");
        block.insert(txn, "sys:children", yrs::ArrayPrelim::default());
        block.insert(txn, "prop:serverReferencePresentation", "compact");
        block.insert(
          txn,
          "prop:templateReference",
          json_to_yjs_any(&serde_json::json!({"key":key,"kind":kind,"optional":true})).unwrap(),
        );
      }
      let paragraph = blocks.insert(txn, "paragraph", yrs::MapPrelim::default());
      paragraph.insert(txn, "sys:id", "paragraph");
      paragraph.insert(txn, "sys:flavour", "myoxus:paragraph");
      paragraph.insert(txn, "sys:children", yrs::ArrayPrelim::default());
      paragraph.insert(txn, "prop:text", yrs::TextPrelim::new("Topic {{preparation.title}}"));
    })
  }

  #[test]
  fn native_reference_slots_survive_inspection_then_bind_once_or_disappear_in_library() {
    let source = reference_slot_fixture();
    let captured = document_to_snapshot(&source, "reference-source", "Reference source").unwrap();
    let blocks: Vec<PortableSnapshotBlock> = serde_json::from_value(captured["blocks"].clone()).unwrap();
    let source = snapshot_blocks_to_yjs(&blocks).unwrap();
    assert_eq!(inspect_native_template_references(&source).unwrap().len(), 2);
    let rendered = instantiate_native_template(
      &source,
      &HashMap::from([(
        "preparation.title".into(),
        NativeTemplateVariable::String("{{workspace.name}}".into()),
      )]),
    )
    .unwrap();
    assert_eq!(inspect_native_template_references(&rendered.snapshot).unwrap().len(), 2);
    let targets = NativeTemplateReferenceTargets {
      workspace_id: Uuid::new_v4(),
      database_id: Uuid::new_v4(),
      task_id: Some(Uuid::new_v4()),
    };
    let bound = bind_native_template_references(&rendered.snapshot, Some(&targets)).unwrap();
    assert!(inspect_native_template_references(&bound).unwrap().is_empty());
    let doc = Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&bound).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let txn = doc.transact();
    for id in ["container", "task"] {
      let Some(yrs::Out::YMap(block)) = blocks.get(&txn, id) else {
        panic!("bound reference absent")
      };
      assert_eq!(
        block.get(&txn, "prop:serverWorkspaceId").unwrap().to_string(&txn),
        targets.workspace_id.to_string()
      );
      assert_eq!(
        block.get(&txn, "prop:serverDatabaseId").unwrap().to_string(&txn),
        targets.database_id.to_string()
      );
      assert_eq!(
        block.get(&txn, "prop:serverRowId").map(|v| v.to_string(&txn)),
        if id == "task" {
          targets.task_id.map(|id| id.to_string())
        } else {
          None
        }
      );
    }
    assert!(
      extract_text_from_yjs(&bound)
        .unwrap()
        .markdown
        .contains("Topic {{workspace.name}}")
    );
    let library = bind_native_template_references(&rendered.snapshot, None).unwrap();
    let library_doc = Doc::new();
    library_doc
      .transact_mut()
      .apply_update(Update::decode_v1(&library).unwrap())
      .unwrap();
    let library_blocks = library_doc.get_or_insert_map("blocks");
    let library_txn = library_doc.transact();
    assert!(library_blocks.get(&library_txn, "container").is_none());
    assert!(library_blocks.get(&library_txn, "task").is_none());
    assert!(library_blocks.get(&library_txn, "paragraph").is_some());
    assert!(
      extract_text_from_yjs(&library)
        .unwrap()
        .markdown
        .contains("Topic {{workspace.name}}")
    );
    let container_only = bind_native_template_references(
      &rendered.snapshot,
      Some(&NativeTemplateReferenceTargets {
        task_id: None,
        ..targets
      }),
    )
    .unwrap();
    let partial = Doc::new();
    partial
      .transact_mut()
      .apply_update(Update::decode_v1(&container_only).unwrap())
      .unwrap();
    let partial_blocks = partial.get_or_insert_map("blocks");
    assert!(partial_blocks.get(&partial.transact(), "container").is_some());
    assert!(partial_blocks.get(&partial.transact(), "task").is_none());
  }

  #[test]
  fn undefined_optional_defaults_preserve_native_table_and_marked_database_descendants_are_opaque() {
    let source = markdown_to_yjs("Table", "| Name |\n| --- |\n| Visible ordinary cell |").unwrap();
    let doc = Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&source).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let table = {
      let txn = doc.transact();
      let table = blocks
        .iter(&txn)
        .find_map(|(_, value)| match value {
          yrs::Out::YMap(block)
            if block
              .get(&txn, "sys:flavour")
              .is_some_and(|value| value.to_string(&txn) == "myoxus:table") =>
          {
            Some(block)
          }
          _ => None,
        })
        .expect("actual imported native table");
      table
    };
    let snapshot = || doc.transact().encode_state_as_update_v1(&StateVector::default());
    let ordinary = extract_text_from_yjs(&snapshot()).unwrap().markdown;
    assert!(ordinary.contains("Visible ordinary cell"));
    {
      let mut txn = doc.transact_mut();
      for key in ["serverRowId", "serverReferencePresentation", "templateReference"] {
        for property in [key.to_string(), format!("{key}.key")] {
          table.insert(&mut txn, format!("prop:{property}"), Any::Undefined);
          table.insert(&mut txn, property, Any::Undefined);
        }
      }
      let props = table.insert(&mut txn, "props", yrs::MapPrelim::default());
      for key in ["serverRowId", "serverReferencePresentation", "templateReference"] {
        props.insert(&mut txn, key, Any::Undefined);
        props.insert(&mut txn, format!("{key}.key"), Any::Undefined);
      }
      assert!(!has_opaque_database_reference(&table, &txn));
    }
    assert_eq!(extract_text_from_yjs(&snapshot()).unwrap().markdown, ordinary);
    {
      let mut txn = doc.transact_mut();
      table.insert(
        &mut txn,
        "props",
        Any::Map(Arc::new(HashMap::from([
          ("templateReference.key".into(), Any::Undefined),
          ("serverReferencePresentation.key".into(), Any::Undefined),
          ("serverRowId.key".into(), Any::Undefined),
        ]))),
      );
      assert!(!has_opaque_database_reference(&table, &txn));
    }
    assert_eq!(extract_text_from_yjs(&snapshot()).unwrap().markdown, ordinary);
    {
      let mut txn = doc.transact_mut();
      // Database references use a different native model than flat tables.
      // Give its cached subtree actual visible content before testing opacity.
      table.insert(&mut txn, "sys:flavour", "myoxus:database");
      table.insert(&mut txn, "prop:title", "PRIVATE cached Database title");
      let children = table.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
      children.push_back(&mut txn, "private-reference-child");
      let child = blocks.insert(&mut txn, "private-reference-child", yrs::MapPrelim::default());
      child.insert(&mut txn, "sys:id", "private-reference-child");
      child.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
      child.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
      child.insert(
        &mut txn,
        "prop:text",
        yrs::TextPrelim::new("PRIVATE native paragraph descendant"),
      );
      assert!(!has_opaque_database_reference(&table, &txn));
    }
    assert!(
      extract_text_from_yjs(&snapshot())
        .unwrap()
        .markdown
        .contains("PRIVATE native paragraph descendant")
    );
    for (location, key, value) in [
      ("flat", "serverReferencePresentation", Any::String("compact".into())),
      ("flat", "serverReferencePresentation", Any::Null),
      ("flat", "serverReferencePresentation", Any::Bool(false)),
      ("scoped", "serverReferencePresentation", Any::Null),
      ("nested-map", "templateReference", Any::Null),
      ("nested-any", "templateReference", Any::Null),
      ("flat", "templateReference.key", Any::String("context.task".into())),
      ("scoped", "templateReference.key", Any::String("context.task".into())),
      ("nested-map", "templateReference.key", Any::Null),
      ("nested-any", "templateReference.key", Any::Null),
      ("flat", "serverReferencePresentation.kind", Any::Bool(false)),
      ("scoped", "serverReferencePresentation.kind", Any::Null),
      ("nested-map", "serverRowId.key", Any::Null),
      ("nested-any", "serverRowId.key", Any::Bool(false)),
    ] {
      {
        let mut txn = doc.transact_mut();
        for key in ["serverRowId", "serverReferencePresentation", "templateReference"] {
          for property in [key.to_string(), format!("{key}.key"), format!("{key}.kind")] {
            table.insert(&mut txn, format!("prop:{property}"), Any::Undefined);
            table.insert(&mut txn, property, Any::Undefined);
          }
        }
        let props = table.insert(&mut txn, "props", yrs::MapPrelim::default());
        match location {
          "flat" => {
            table.insert(&mut txn, key, value);
          }
          "scoped" => {
            table.insert(&mut txn, format!("prop:{key}"), value);
          }
          "nested-map" => {
            props.insert(&mut txn, key, value);
          }
          "nested-any" => {
            table.insert(
              &mut txn,
              "props",
              Any::Map(Arc::new(HashMap::from([(key.to_string(), value)]))),
            );
          }
          _ => unreachable!(),
        }
        assert!(has_opaque_database_reference(&table, &txn), "{location}");
      }
      let markdown = extract_text_from_yjs(&snapshot()).unwrap().markdown;
      assert!(
        !markdown.contains("PRIVATE"),
        "{location} must hide cached and descendant text: {markdown}"
      );
      assert!(!markdown.contains("Visible ordinary cell"));
    }
  }

  #[test]
  fn malformed_compact_reference_is_rejected_as_source_and_opaque_in_markdown() {
    for property in ["prop:serverReferencePresentation", "prop:templateReference"] {
      let doc = Doc::new();
      doc
        .transact_mut()
        .apply_update(Update::decode_v1(&reference_slot_fixture()).unwrap())
        .unwrap();
      let blocks = doc.get_or_insert_map("blocks");
      {
        let mut txn = doc.transact_mut();
        let Some(yrs::Out::YMap(block)) = blocks.get(&txn, "container") else {
          panic!("slot absent")
        };
        block.remove(&mut txn, "prop:templateReference");
        block.remove(&mut txn, "prop:serverReferencePresentation");
        block.insert(&mut txn, property, Any::Bool(false));
        block.insert(&mut txn, "prop:title", "PRIVATE cached title");
        let Some(yrs::Out::YArray(children)) = block.get(&txn, "sys:children") else {
          panic!("children absent")
        };
        children.push_back(&mut txn, "private");
        let child = blocks.insert(&mut txn, "private", yrs::MapPrelim::default());
        child.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
        child.insert(&mut txn, "prop:text", yrs::TextPrelim::new("PRIVATE cached body"));
        assert!(has_opaque_database_reference(&block, &txn));
      }
      let snapshot = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
      if property == "prop:templateReference" {
        assert!(inspect_native_template_references(&snapshot).is_err());
        assert!(instantiate_native_template(&snapshot, &HashMap::new()).is_err());
      }
      let markdown = extract_text_from_yjs(&snapshot).unwrap().markdown;
      assert!(
        !markdown.contains("PRIVATE"),
        "opaque marker must hide cached data: {markdown}"
      );
    }
    let mut blocks: Vec<PortableSnapshotBlock> = serde_json::from_value(serde_json::json!([
      {"id":"page","flavour":"myoxus:page","props":{},"children":["note"]},
      {"id":"note","flavour":"myoxus:note","props":{},"children":["database"]},
      {"id":"database","flavour":"myoxus:database","props":{"title":"PRIVATE cached title"},"children":["child"]},
      {"id":"child","flavour":"myoxus:paragraph","props":{"text":"PRIVATE descendant"},"children":[]}
    ]))
    .unwrap();
    let ordinary = snapshot_blocks_to_yjs(&blocks).unwrap();
    assert!(
      extract_text_from_yjs(&ordinary)
        .unwrap()
        .markdown
        .contains("PRIVATE descendant")
    );
    for property in ["templateReference", "serverRowId", "serverReferencePresentation"] {
      blocks[2].props.insert(property.into(), serde_json::json!({}));
      let snapshot = snapshot_blocks_to_yjs(&blocks).unwrap();
      let doc = Doc::new();
      doc
        .transact_mut()
        .apply_update(Update::decode_v1(&snapshot).unwrap())
        .unwrap();
      let native_blocks = doc.get_or_insert_map("blocks");
      let txn = doc.transact();
      let Some(yrs::Out::YMap(block)) = native_blocks.get(&txn, "database") else {
        panic!("portable Database absent")
      };
      assert!(
        matches!(block.get(&txn, &format!("prop:{property}")), Some(yrs::Out::Any(Any::Map(value))) if value.is_empty())
      );
      assert!(has_opaque_database_reference(&block, &txn));
      if property == "templateReference" {
        assert!(inspect_native_template_references(&snapshot).is_err());
      }
      let markdown = extract_text_from_yjs(&snapshot).unwrap().markdown;
      assert!(!markdown.contains("PRIVATE"), "{property}: {markdown}");
      blocks[2].props.remove(property);
    }
  }

  #[test]
  fn typed_native_rewrite_separates_equal_document_and_asset_keys_and_preserves_literals() {
    let mut options = yrs::Options::with_client_id(yrs::ClientID::new(17));
    options.offset_kind = yrs::OffsetKind::Utf16;
    let doc = Doc::with_options(options);
    let blocks = doc.get_or_insert_map("blocks");
    let update = {
      let mut txn = doc.transact_mut();
      insert_page_with_note(&mut txn, &blocks, &["paragraph", "image", "surface"]);
      let paragraph = blocks.insert(&mut txn, "paragraph", yrs::MapPrelim::default());
      paragraph.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
      paragraph.insert(&mut txn, "prop:caption", "same-key");
      let text = paragraph.insert(
        &mut txn,
        "prop:text",
        yrs::TextPrelim::new("😀 same-key literal same-key"),
      );
      let mut reference = serde_json::json!({"type":"LinkedPage","pageId":"same-key","workspaceId":"source","title":"Alias","params":{"blockIds":["same-key"]}});
      text.format(
        &mut txn,
        3,
        8,
        Attrs::from([(Arc::from("reference"), json_to_yjs_any(&reference).unwrap())]),
      );
      reference = serde_json::json!({"type":"doc","docId":"same-key","workspaceId":"source"});
      let footnote = serde_json::json!({"type":"citation","id":"same-key","reference":reference});
      text.format(
        &mut txn,
        12,
        7,
        Attrs::from([(Arc::from("footnote"), json_to_yjs_any(&footnote).unwrap())]),
      );
      let image = blocks.insert(&mut txn, "image", yrs::MapPrelim::default());
      image.insert(&mut txn, "sys:flavour", "myoxus:image");
      image.insert(&mut txn, "prop:sourceId", "same-key");
      let surface = blocks.insert(&mut txn, "surface", yrs::MapPrelim::default());
      surface.insert(&mut txn, "sys:flavour", "myoxus:surface-ref");
      surface.insert(&mut txn, "prop:reference", "same-key");
      txn.encode_state_as_update_v1(&StateVector::default())
    };
    let documents = extract_document_references_from_yjs(&update).unwrap();
    assert_eq!(documents.occurrences.len(), 2, "element IDs are not document edges");
    let assets = extract_portable_asset_references(&update).unwrap();
    assert_eq!(assets.len(), 1);
    let mut rewrites = documents
      .occurrences
      .iter()
      .map(|occurrence| NativeReferenceRewrite {
        position: occurrence.position.clone(),
        expected_id: occurrence.raw_target_doc_id.clone(),
        expected_workspace_id: occurrence.target_workspace_id.clone(),
        replacement: Some(NativeReferenceReplacement {
          id: "cloned-document".into(),
          workspace_id: Some("target".into()),
        }),
      })
      .collect::<Vec<_>>();
    rewrites.push(NativeReferenceRewrite {
      position: assets[0].position.clone(),
      expected_id: assets[0].raw_source_key.clone(),
      expected_workspace_id: assets[0].workspace_id.clone(),
      replacement: Some(NativeReferenceReplacement {
        id: "private-asset".into(),
        workspace_id: Some("target".into()),
      }),
    });
    let result = rewrite_native_references(&update, &rewrites, 19).unwrap();
    let projected = extract_document_references_from_yjs(&result.full_state).unwrap();
    assert_eq!(projected.occurrences.len(), 2);
    assert!(
      projected.occurrences.iter().all(
        |item| item.raw_target_doc_id == "cloned-document" && item.target_workspace_id.as_deref() == Some("target")
      )
    );
    assert_eq!(
      extract_portable_asset_references(&result.full_state).unwrap()[0].source_key,
      "private-asset"
    );
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&result.incremental_update).unwrap())
      .unwrap();
    let yrs::Out::YMap(paragraph) = blocks.get(&txn, "paragraph").unwrap() else {
      panic!("paragraph retained")
    };
    let yrs::Out::YText(text) = paragraph.get(&txn, "prop:text").unwrap() else {
      panic!("text retained")
    };
    assert_eq!(text.get_string(&txn), "😀 same-key literal same-key");
    assert_eq!(
      block_prop_string(&paragraph, &txn, "caption").as_deref(),
      Some("same-key")
    );
    let yrs::Out::YMap(surface) = blocks.get(&txn, "surface").unwrap() else {
      panic!("surface retained")
    };
    assert_eq!(
      block_prop_string(&surface, &txn, "reference").as_deref(),
      Some("same-key")
    );
    let attributes = text.diff(&txn, YChange::identity);
    assert!(
      attributes
        .iter()
        .any(|chunk| chunk.attributes.as_ref().is_some_and(|attrs| attrs
          .get("footnote")
          .is_some_and(|value| yjs_any_to_json(value)["id"] == "same-key")))
    );
  }

  #[test]
  fn typed_native_omission_preserves_text_and_promotes_embed_children() {
    for legacy_children in [false, true] {
      let update = document_graph_test_update(|txn, blocks| {
        insert_page_with_note(txn, blocks, &["embed", "paragraph", "malformed"]);
        let note = match blocks.get(txn, "note1").unwrap() {
          yrs::Out::YMap(value) => value,
          _ => unreachable!(),
        };
        if legacy_children {
          note.insert(
            txn,
            "sys:children",
            Any::Array(
              vec![
                Any::String("embed".into()),
                Any::String("paragraph".into()),
                Any::String("malformed".into()),
              ]
              .into(),
            ),
          );
        }
        let embed = blocks.insert(txn, "embed", yrs::MapPrelim::default());
        embed.insert(txn, "sys:flavour", "myoxus:embed-linked-doc");
        embed.insert(txn, "prop:pageId", "missing");
        let children = embed.insert(txn, "sys:children", yrs::ArrayPrelim::default());
        children.push_back(txn, "child");
        let child = blocks.insert(txn, "child", yrs::MapPrelim::default());
        child.insert(txn, "sys:flavour", "myoxus:paragraph");
        child.insert(txn, "prop:text", yrs::TextPrelim::new("Retained child"));
        let paragraph = blocks.insert(txn, "paragraph", yrs::MapPrelim::default());
        paragraph.insert(txn, "sys:flavour", "myoxus:paragraph");
        let text = paragraph.insert(
          txn,
          "prop:text",
          yrs::TextPrelim::new("Readable text |   |   literal missing"),
        );
        text.format(txn, 0, 8, linked_page_attrs("missing"));
        text.format(txn, 16, 1, linked_page_attrs("missing"));
        text.format(txn, 20, 1, linked_page_attrs("valid"));
        paragraph.insert(txn, "prop:caption", "missing");
        let malformed = blocks.insert(txn, "malformed", yrs::MapPrelim::default());
        malformed.insert(txn, "sys:flavour", "myoxus:embed-synced-doc");
        malformed.insert(txn, "prop:pageId", 42);
      });
      let legacy = NativeReferenceRewrite {
        position: NativeReferencePosition::BlockProperty {
          block_id: "malformed".into(),
          property: "prop:pageId".into(),
        },
        expected_id: "42".into(),
        expected_workspace_id: None,
        replacement: Some(NativeReferenceReplacement {
          id: "historical-target".into(),
          workspace_id: Some("source-workspace".into()),
        }),
      };
      let historical = rewrite_native_references(&update, &[legacy.clone()], 113).unwrap();
      let occurrence = extract_document_references_from_yjs(&historical.full_state)
        .unwrap()
        .occurrences
        .into_iter()
        .find(|occurrence| occurrence.source_block_id == "malformed")
        .unwrap();
      assert_eq!(occurrence.raw_target_doc_id, "historical-target");
      assert_eq!(occurrence.target_workspace_id.as_deref(), Some("source-workspace"));
      assert!(
        rewrite_native_references(
          &update,
          &[NativeReferenceRewrite {
            expected_id: "43".into(),
            ..legacy
          }],
          113
        )
        .is_err()
      );
      let rewrites = extract_document_references_from_yjs(&update)
        .unwrap()
        .occurrences
        .into_iter()
        .map(|occurrence| NativeReferenceRewrite {
          position: occurrence.position,
          expected_id: occurrence.raw_target_doc_id.clone(),
          expected_workspace_id: occurrence.target_workspace_id,
          replacement: (occurrence.raw_target_doc_id == "valid").then(|| NativeReferenceReplacement {
            id: "valid".into(),
            workspace_id: Some("source-workspace".into()),
          }),
        })
        .collect::<Vec<_>>();
      let result = rewrite_native_references(&update, &rewrites, 112).unwrap();
      let retained = extract_document_references_from_yjs(&result.full_state)
        .unwrap()
        .occurrences;
      assert_eq!(retained.len(), 1);
      assert_eq!(retained[0].raw_target_doc_id, "valid");
      assert_eq!(retained[0].target_workspace_id.as_deref(), Some("source-workspace"));
      let doc = Doc::new();
      let blocks = doc.get_or_insert_map("blocks");
      let mut txn = doc.transact_mut();
      txn
        .apply_update(Update::decode_v1(&result.full_state).unwrap())
        .unwrap();
      assert!(blocks.get(&txn, "embed").is_none());
      assert!(blocks.get(&txn, "malformed").is_none());
      let yrs::Out::YMap(note) = blocks.get(&txn, "note1").unwrap() else {
        unreachable!()
      };
      assert_eq!(block_children(&note, &txn), vec!["child", "paragraph"]);
      let yrs::Out::YMap(paragraph) = blocks.get(&txn, "paragraph").unwrap() else {
        unreachable!()
      };
      let yrs::Out::YText(text) = paragraph.get(&txn, "prop:text").unwrap() else {
        unreachable!()
      };
      assert_eq!(text.get_string(&txn), "Readable text |  |   literal missing");
      assert_eq!(
        block_prop_string(&paragraph, &txn, "caption").as_deref(),
        Some("missing")
      );
    }
  }

  #[test]
  fn snapshot_resource_rewrite_updates_block_properties_and_text_attributes() {
    let update = document_graph_test_update(|txn, blocks| {
      let image = blocks.insert(txn, "image", yrs::MapPrelim::default());
      image.insert(txn, "sys:flavour", "myoxus:image");
      image.insert(txn, "prop:sourceId", "myoxus-snapshot-asset:image-0");
      let paragraph = blocks.insert(txn, "paragraph", yrs::MapPrelim::default());
      paragraph.insert(txn, "sys:flavour", "myoxus:paragraph");
      let text = paragraph.insert(txn, "prop:text", yrs::TextPrelim::new("Tärget"));
      text.format(txn, 0, 7, linked_page_attrs("myoxus-snapshot-document:row-content-1"));
    });
    let replacements = HashMap::from([
      (
        "myoxus-snapshot-asset:image-0".to_string(),
        "workspace/image.png".to_string(),
      ),
      (
        "myoxus-snapshot-document:row-content-1".to_string(),
        "11111111-1111-4111-8111-111111111111".to_string(),
      ),
    ]);

    let resources = collect_yjs_resource_values(&update).expect("resource inventory succeeds");
    assert!(resources.contains("myoxus-snapshot-asset:image-0"));
    assert!(resources.contains("myoxus-snapshot-document:row-content-1"));

    let rewritten = rewrite_snapshot_resource_uris(&update, &replacements).expect("rewrite succeeds");
    let references = extract_document_references_from_yjs(&rewritten).expect("references decode");
    assert_eq!(references.occurrences.len(), 1);
    assert_eq!(
      references.occurrences[0].raw_target_doc_id,
      "11111111-1111-4111-8111-111111111111"
    );
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&rewritten).expect("rewritten update decodes"))
      .expect("rewritten update applies");
    let image = match blocks.get(&txn, "image") {
      Some(yrs::Out::YMap(image)) => image,
      _ => panic!("image block missing"),
    };
    assert_eq!(
      block_prop_string(&image, &txn, "sourceId").as_deref(),
      Some("workspace/image.png")
    );
  }

  #[test]
  fn snapshot_resource_rewrite_rejects_unresolved_reserved_uri() {
    let update = document_graph_test_update(|txn, blocks| {
      let image = blocks.insert(txn, "image", yrs::MapPrelim::default());
      image.insert(txn, "prop:sourceId", "myoxus-snapshot-asset:missing");
    });

    let error = rewrite_snapshot_resource_uris(&update, &HashMap::new()).expect_err("URI must resolve");
    assert!(error.contains("unresolved reserved snapshot URI"));
  }

  #[test]
  fn document_reference_extractor_reads_inline_linked_page_attrs() {
    let update = document_graph_test_update(|txn, blocks| {
      insert_page_with_note(txn, blocks, &["para1"]);
      let para = blocks.insert(txn, "para1", yrs::MapPrelim::default());
      para.insert(txn, "sys:flavour", "myoxus:paragraph");
      para.insert(txn, "sys:children", yrs::ArrayPrelim::default());
      let text = para.insert(txn, "prop:text", yrs::TextPrelim::new("See target document"));
      text.format(txn, 4, 6, linked_page_attrs("target-doc-raw"));
    });

    let result = extract_document_references_from_yjs(&update).expect("extract document references");
    assert_eq!(result.occurrences.len(), 1);
    let occurrence = &result.occurrences[0];
    assert_eq!(occurrence.source_block_id, "para1");
    assert_eq!(occurrence.source_parent_block_id.as_deref(), Some("note1"));
    assert_eq!(occurrence.source_parent_flavour.as_deref(), Some("myoxus:note"));
    assert_eq!(occurrence.raw_target_doc_id, "target-doc-raw");
    assert_eq!(occurrence.link_kind, DocumentReferenceLinkKind::InlineReference);
    assert_eq!(occurrence.markdown_preview, "target");
    assert_eq!(occurrence.params_json["mode"], "page");
    assert_eq!(occurrence.params_json["blockIds"][0], "block-a");
    assert!(
      occurrence.params_json.get("pageId").is_none(),
      "raw target id must not be duplicated into params_json"
    );
  }

  #[test]
  fn native_template_instantiation_preserves_references_and_expands_list_blocks() {
    let update = document_graph_test_update(|txn, blocks| {
      insert_page_with_note(txn, blocks, &["para1", "list1"]);
      let page = match blocks.get(txn, "page1") {
        Some(yrs::Out::YMap(page)) => page,
        _ => panic!("page block missing"),
      };
      page.insert(txn, "prop:title", yrs::TextPrelim::new("Plan {{name}}"));
      let para = blocks.insert(txn, "para1", yrs::MapPrelim::default());
      para.insert(txn, "sys:id", "para1");
      para.insert(txn, "sys:flavour", "myoxus:paragraph");
      para.insert(txn, "sys:children", yrs::ArrayPrelim::default());
      let text = para.insert(txn, "prop:text", yrs::TextPrelim::new("See target for {{name}}"));
      text.format(txn, 4, 6, linked_page_attrs("target-doc-raw"));
      let list = blocks.insert(txn, "list1", yrs::MapPrelim::default());
      list.insert(txn, "sys:id", "list1");
      list.insert(txn, "sys:flavour", "myoxus:list");
      list.insert(txn, "sys:children", yrs::ArrayPrelim::default());
      list.insert(txn, "prop:type", "bulleted");
      list.insert(txn, "prop:text", yrs::TextPrelim::new("{{items}}"));
    });
    let result = instantiate_native_template(
      &update,
      &HashMap::from([
        ("name".to_string(), NativeTemplateVariable::String("Atlas".to_string())),
        (
          "items".to_string(),
          NativeTemplateVariable::StringList(vec!["First".to_string(), "Second".to_string()]),
        ),
      ]),
    )
    .expect("instantiate native template");
    assert!(result.unresolved_variables.is_empty());
    let extracted = extract_text_from_yjs(&result.snapshot).expect("extract instantiated content");
    assert_eq!(extracted.title.as_deref(), Some("Plan Atlas"));
    assert!(extracted.markdown.contains("See target for Atlas"));
    assert!(extracted.markdown.contains("First"));
    assert!(extracted.markdown.contains("Second"));
    let references = extract_document_references_from_yjs(&result.snapshot).expect("extract preserved reference");
    assert_eq!(references.occurrences.len(), 1);
    assert_eq!(references.occurrences[0].raw_target_doc_id, "target-doc-raw");

    let unresolved = instantiate_native_template(&update, &HashMap::new()).expect("scan unresolved variables");
    assert_eq!(unresolved.unresolved_variables, vec!["items", "name"]);
  }

  #[test]
  fn native_template_cells_preserve_marks_and_geometry_without_changing_source() {
    let update = document_graph_test_update(|txn, blocks| {
      insert_page_with_note(txn, blocks, &["table"]);
      let table = blocks.insert(txn, "table", yrs::MapPrelim::default());
      table.insert(txn, "sys:id", "table");
      table.insert(txn, "sys:flavour", "myoxus:table");
      table.insert(txn, "sys:children", yrs::ArrayPrelim::default());
      table.insert(txn, "prop:rows.r.rowId", "r");
      table.insert(txn, "prop:columns.c.width", 240);
      let text = table.insert(
        txn,
        "prop:cells.r:c.text",
        yrs::TextPrelim::new("{{organization_name}}"),
      );
      text.format(txn, 0, 21, yrs::types::Attrs::from([("bold".into(), Any::Bool(true))]));
    });
    let source = update.clone();
    let result = instantiate_native_template(
      &update,
      &HashMap::from([(
        "organization_name".into(),
        NativeTemplateVariable::String("My organization".into()),
      )]),
    )
    .expect("instantiate native cell");
    assert!(result.unresolved_variables.is_empty());
    let doc = Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&result.snapshot).expect("decode result"))
      .expect("apply result");
    let blocks = doc.get_or_insert_map("blocks");
    let txn = doc.transact();
    let Some(yrs::Out::YMap(table)) = blocks.get(&txn, "table") else {
      panic!("same table missing")
    };
    assert_eq!(table.get(&txn, "prop:rows.r.rowId").unwrap().to_string(&txn), "r");
    assert_eq!(table.get(&txn, "prop:columns.c.width").unwrap().to_string(&txn), "240");
    let Some(yrs::Out::YText(text)) = table.get(&txn, "prop:cells.r:c.text") else {
      panic!("native cell missing")
    };
    assert_eq!(text.get_string(&txn), "My organization");
    let segments = text.diff(&txn, yrs::types::text::YChange::identity);
    assert_eq!(segments.len(), 1);
    assert_eq!(
      segments[0].attributes.as_ref().unwrap().get("bold"),
      Some(&Any::Bool(true))
    );
    assert_eq!(update, source);
    assert_eq!(
      instantiate_native_template(&update, &HashMap::new())
        .unwrap()
        .unresolved_variables,
      vec!["organization_name"]
    );
  }

  #[test]
  fn document_reference_extractor_reads_embed_and_surface_refs() {
    let update = document_graph_test_update(|txn, blocks| {
      insert_page_with_note(txn, blocks, &["linked1", "synced1", "surface1"]);
      for (id, flavour, page_id) in [
        ("linked1", "myoxus:embed-linked-doc", "linked-doc"),
        ("synced1", "myoxus:embed-synced-doc", "synced-doc"),
        ("surface1", "myoxus:surface-ref", "surface-doc"),
      ] {
        let block = blocks.insert(txn, id, yrs::MapPrelim::default());
        block.insert(txn, "sys:flavour", flavour);
        block.insert(txn, "sys:children", yrs::ArrayPrelim::default());
        block.insert(txn, "prop:pageId", page_id);
      }
    });

    let result = extract_document_references_from_yjs(&update).expect("extract document references");
    let kinds: Vec<_> = result
      .occurrences
      .iter()
      .map(|occurrence| (occurrence.raw_target_doc_id.as_str(), occurrence.link_kind))
      .collect();
    assert_eq!(
      kinds,
      vec![
        ("linked-doc", DocumentReferenceLinkKind::EmbedLinkedDoc),
        ("surface-doc", DocumentReferenceLinkKind::SurfaceRef),
        ("synced-doc", DocumentReferenceLinkKind::EmbedSyncedDoc),
      ],
      "block IDs sort deterministically while preserving link kinds"
    );
  }

  #[test]
  fn document_reference_extractor_marks_database_cell_references() {
    let update = document_graph_test_update(|txn, blocks| {
      insert_page_with_note(txn, blocks, &["db1"]);
      let database = blocks.insert(txn, "db1", yrs::MapPrelim::default());
      database.insert(txn, "sys:flavour", "myoxus:database");
      database.insert(txn, "sys:children", yrs::ArrayPrelim::default());
      let cell = database.insert(
        txn,
        "prop:cells.row-1:field-1.text",
        yrs::TextPrelim::new("Cell target"),
      );
      cell.format(txn, 5, 6, linked_page_attrs("cell-linked-doc"));
    });

    let result = extract_document_references_from_yjs(&update).expect("extract document references");
    assert_eq!(result.occurrences.len(), 1);
    assert_eq!(
      result.occurrences[0].link_kind,
      DocumentReferenceLinkKind::DatabaseCellReference
    );
    assert_eq!(result.occurrences[0].raw_target_doc_id, "cell-linked-doc");
    assert_eq!(result.occurrences[0].markdown_preview, "target");
  }

  #[test]
  fn document_reference_extractor_keeps_invalid_page_id_raw() {
    let update = document_graph_test_update(|txn, blocks| {
      insert_page_with_note(txn, blocks, &["para1"]);
      let para = blocks.insert(txn, "para1", yrs::MapPrelim::default());
      para.insert(txn, "sys:flavour", "myoxus:paragraph");
      para.insert(txn, "sys:children", yrs::ArrayPrelim::default());
      let text = para.insert(txn, "prop:text", yrs::TextPrelim::new("Broken target"));
      text.format(txn, 7, 6, linked_page_attrs("not-a-uuid"));
    });

    let result = extract_document_references_from_yjs(&update).expect("extract document references");
    assert_eq!(result.occurrences.len(), 1);
    assert_eq!(result.occurrences[0].raw_target_doc_id, "not-a-uuid");
  }

  #[test]
  fn document_reference_extractor_ignores_non_document_graph_edges() {
    let update = document_graph_test_update(|txn, blocks| {
      insert_page_with_note(txn, blocks, &["para1", "attachment1"]);
      let para = blocks.insert(txn, "para1", yrs::MapPrelim::default());
      para.insert(txn, "sys:flavour", "myoxus:paragraph");
      para.insert(txn, "sys:children", yrs::ArrayPrelim::default());
      let text = para.insert(txn, "prop:text", yrs::TextPrelim::new("URL footnote"));
      text.format(
        txn,
        0,
        3,
        Attrs::from([(Arc::from("link"), Any::String(Arc::from("https://example.com")))]),
      );
      let mut footnote_payload: HashMap<String, Any> = HashMap::new();
      footnote_payload.insert(
        "label".to_string(),
        Any::String(Arc::from("https://example.com/footnote")),
      );
      text.format(
        txn,
        4,
        8,
        Attrs::from([(Arc::from("footnote"), Any::Map(Arc::new(footnote_payload)))]),
      );

      let attachment = blocks.insert(txn, "attachment1", yrs::MapPrelim::default());
      attachment.insert(txn, "sys:flavour", "myoxus:attachment");
      attachment.insert(txn, "sys:children", yrs::ArrayPrelim::default());
      attachment.insert(txn, "prop:sourceId", "blob-id");
    });

    let result = extract_document_references_from_yjs(&update).expect("extract document references");
    assert!(
      result.occurrences.is_empty(),
      "URL links, footnotes and attachments must not become Document Graph edges"
    );
  }

  #[test]
  fn test_merge_updates() {
    let doc1 = Doc::new();
    let text = doc1.get_or_insert_text("content");
    let update1 = {
      let mut tx = doc1.transact_mut();
      text.insert(&mut tx, 0, "Hello ");
      tx.encode_update_v1()
    };

    let doc2 = Doc::new();
    let text2 = doc2.get_or_insert_text("content");
    let update2 = {
      let mut tx = doc2.transact_mut();
      text2.insert(&mut tx, 0, "World");
      tx.encode_update_v1()
    };

    let merged = merge_updates(vec![update1, update2]).expect("Merge failed");

    let final_doc = Doc::new();
    let final_text = final_doc.get_or_insert_text("content");
    {
      let mut tx = final_doc.transact_mut();
      tx.apply_update(Update::decode_v1(&merged).unwrap())
        .expect("apply yjs update");
    }

    let content = final_text.get_string(&final_doc.transact());
    assert!(content.contains("Hello"));
    assert!(content.contains("World"));
  }

  #[test]
  fn test_remove_pages_from_root_doc_removes_only_target_page() {
    let initial = create_initial_workspace_doc("Workspace");
    let add = add_pages_to_root_doc(
      std::slice::from_ref(&initial),
      &[
        ("page-alpha".to_string(), "Alpha".to_string()),
        ("page-beta".to_string(), "Beta".to_string()),
      ],
    )
    .expect("add pages");
    let full_before = merge_updates(vec![initial, add]).expect("merge before removal");

    let removal =
      remove_pages_from_root_doc(&full_before, &["page-alpha".to_string()]).expect("remove page-alpha from root doc");
    assert_eq!(removal.removed_entries, 1);
    assert!(
      !removal.update.is_empty(),
      "removal must produce an incremental Yjs update"
    );

    let full_after = merge_updates(vec![full_before, removal.update]).expect("merge after removal");
    let page_ids: Vec<String> = extract_page_trash_state(&full_after)
      .expect("extract pages")
      .into_iter()
      .map(|entry| entry.id)
      .collect();
    assert_eq!(page_ids, vec!["page-beta".to_string()]);
  }

  #[test]
  fn test_extract_page_trash_state_from_updates_uses_client_visible_sequence() {
    let initial = create_initial_workspace_doc("Workspace");
    let add = add_pages_to_root_doc(
      std::slice::from_ref(&initial),
      &[("page-alpha".to_string(), "Alpha".to_string())],
    )
    .expect("add page");
    let full_before = merge_updates(vec![initial.clone(), add.clone()]).expect("merge before removal");
    let removal =
      remove_pages_from_root_doc(&full_before, &["page-alpha".to_string()]).expect("remove page-alpha from root doc");

    let entries =
      extract_page_trash_state_from_updates(&[initial, add, removal.update]).expect("extract sequential root updates");

    assert!(
      entries.is_empty(),
      "sequential root extraction must match the client-visible array and ignore removed page structs"
    );
  }

  #[test]
  fn test_add_pages_to_root_doc_repairs_existing_trashed_page_without_duplicate() {
    let initial = create_initial_workspace_doc("Workspace");
    let add = add_pages_to_root_doc(
      std::slice::from_ref(&initial),
      &[("page-alpha".to_string(), "Alpha".to_string())],
    )
    .expect("add page");
    let full = merge_updates(vec![initial.clone(), add.clone()]).expect("merge before trash");
    let trash = set_root_page_trash(&full, "page-alpha", true);

    let repair = add_pages_to_root_doc(
      &[initial, add, trash],
      &[("page-alpha".to_string(), "Alpha restored".to_string())],
    )
    .expect("repair hidden seed page");
    let repaired = merge_updates(vec![full, repair]).expect("merge repaired root doc");
    let entries = extract_page_trash_state(&repaired).expect("extract repaired root state");

    assert_eq!(entries.len(), 1, "repair must not append a duplicate root entry");
    assert_eq!(entries[0].id, "page-alpha");
    assert_eq!(entries[0].title.as_deref(), Some("Alpha restored"));
    assert!(
      !entries[0].is_trashed,
      "repair must clear root meta.pages trash state for a live imported page"
    );
  }

  #[test]
  fn update_root_page_metadata_changes_only_the_requested_page_projection() {
    let initial = create_initial_workspace_doc("Workspace");
    let add = add_pages_to_root_doc(
      std::slice::from_ref(&initial),
      &[
        ("page-alpha".to_string(), "Alpha".to_string()),
        ("page-beta".to_string(), "Beta".to_string()),
      ],
    )
    .expect("add pages");
    let full = merge_updates(vec![initial, add]).expect("merge root state");
    let mutation = update_root_page_metadata(
      &full,
      "page-alpha",
      Some("Alpha renamed"),
      Some(true),
      Some(1_700_000_000_000),
      1_700_000_000_123,
    )
    .expect("update page metadata");
    assert_eq!(mutation.matched_entries, 1);
    assert!(!mutation.update.is_empty());

    let updated = merge_updates(vec![full, mutation.update]).expect("merge metadata delta");
    let entries = extract_page_trash_state(&updated).expect("extract root page projections");
    let alpha = entries.iter().find(|entry| entry.id == "page-alpha").expect("alpha");
    let beta = entries.iter().find(|entry| entry.id == "page-beta").expect("beta");
    assert_eq!(alpha.title.as_deref(), Some("Alpha renamed"));
    assert!(alpha.is_trashed);
    assert_eq!(beta.title.as_deref(), Some("Beta"));
    assert!(!beta.is_trashed);
  }

  #[test]
  fn update_document_title_preserves_existing_body_blocks() {
    let initial = markdown_to_yjs("Old title", "Body marker that must survive").expect("create canonical document");
    let delta = update_document_title(&initial, "New title").expect("update canonical title");
    assert!(!delta.is_empty());
    let updated = merge_updates(vec![initial, delta]).expect("merge title delta");
    let extracted = extract_text_from_yjs(&updated).expect("extract updated document");
    assert_eq!(extracted.title.as_deref(), Some("New title"));
    assert!(extracted.markdown.contains("Body marker that must survive"));
  }

  #[test]
  fn test_workspace_root_metadata_preserves_trashed_pages() {
    let initial = create_initial_workspace_doc("Workspace");
    let add = add_pages_to_root_doc(
      std::slice::from_ref(&initial),
      &[("page-alpha".to_string(), "Alpha".to_string())],
    )
    .expect("add page");
    let full = merge_updates(vec![initial, add]).expect("merge root doc");
    let trash = set_root_page_trash(&full, "page-alpha", true);
    let with_trash = merge_updates(vec![full, trash]).expect("merge trash state");

    let metadata = extract_workspace_root_metadata(&with_trash).expect("extract portable root metadata");
    assert_eq!(metadata.pages.len(), 1, "trash must not drop a portable document");
    assert_eq!(metadata.pages[0].id, "page-alpha");
    assert!(metadata.pages[0].is_trashed);
    let catalog = serde_json::json!([{"id": "archived", "value": "Archived", "color": "tag.blue", "archived": true, "description": "Portable"}]);
    let projected = project_workspace_tags_in_root_doc(
      &with_trash,
      &catalog,
      &HashMap::from([("page-alpha".to_string(), vec!["archived".to_string()])]),
    )
    .unwrap();
    let portable = extract_workspace_root_metadata(&projected).unwrap();
    assert_eq!(portable.workspace_tags, catalog);
    assert_eq!(portable.pages[0].tags, serde_json::json!(["archived"]));
    assert!(portable.pages[0].is_trashed);
    assert_eq!(
      extract_workspace_root_metadata(&with_trash).unwrap(),
      metadata,
      "detached projection must not change its source"
    );
    // Deployed scalar JSON containers require the same selective cleanup as
    // shared Y.Map/Y.Array metadata, without dropping unrelated properties.
    let plain = Doc::new();
    let meta = plain.get_or_insert_map("meta");
    {
      let mut txn = plain.transact_mut();
      meta.insert(
        &mut txn,
        "properties",
        json_to_yjs_any(&serde_json::json!({"other":"retained", "tags":{"options":catalog}})).unwrap(),
      );
      meta.insert(
        &mut txn,
        "pages",
        json_to_yjs_any(&serde_json::json!([
          {"id":"first", "title":"First", "tags":["archived"]},
          {"id":"second", "title":"Second", "trash":true, "tags":[]}
        ]))
        .unwrap(),
      );
    }
    let original = plain.transact().encode_state_as_update_v1(&StateVector::default());
    let partial = reconcile_workspace_labels_in_root_doc(&original, &HashSet::from(["first".to_string()])).unwrap();
    assert!(
      !partial.catalog_removed,
      "unconfirmed empty fields still require a decision"
    );
    let partial_state = merge_updates(vec![original.clone(), partial.update]).unwrap();
    let partial_meta = extract_workspace_root_metadata(&partial_state).unwrap();
    assert!(!partial_meta.pages[0].tags_present);
    assert!(partial_meta.pages[1].tags_present);
    assert_eq!(partial_meta.workspace_tags, catalog);
    let completed =
      reconcile_workspace_labels_in_root_doc(&partial_state, &HashSet::from(["second".to_string()])).unwrap();
    assert!(completed.catalog_removed);
    let completed_state = merge_updates(vec![partial_state, completed.update]).unwrap();
    let final_meta = extract_workspace_root_metadata(&completed_state).unwrap();
    assert_eq!(final_meta.pages[0].title.as_deref(), Some("First"));
    assert!(final_meta.pages[1].is_trashed);
    assert!(final_meta.pages.iter().all(|page| !page.tags_present));
    let restored = Doc::new();
    restored
      .transact_mut()
      .apply_update(Update::decode_v1(&completed_state).unwrap())
      .unwrap();
    let other = workspace_label_child(
      restored
        .get_or_insert_map("meta")
        .get(&restored.transact(), "properties")
        .unwrap(),
      "other",
      &restored.transact(),
    )
    .unwrap();
    assert!(matches!(other, Some(yrs::Out::Any(Any::String(value))) if value.as_ref() == "retained"));
    assert!(
      reconcile_workspace_labels_in_root_doc(
        &completed_state,
        &HashSet::from(["first".to_string(), "second".to_string()])
      )
      .unwrap()
      .update
      .is_empty()
    );
    assert!(
      extract_workspace_root_metadata(&original)
        .unwrap()
        .pages
        .iter()
        .all(|page| page.tags_present)
    );
  }

  #[test]
  fn test_remove_pages_from_root_doc_removes_duplicate_entries_idempotently() {
    let initial = create_initial_workspace_doc("Workspace");
    let add = append_raw_root_pages_update(
      &initial,
      &[
        ("page-dup".to_string(), "Duplicate A".to_string()),
        ("page-keep".to_string(), "Keep".to_string()),
        ("page-dup".to_string(), "Duplicate B".to_string()),
      ],
    )
    .expect("create legacy duplicate pages");
    let full_before = merge_updates(vec![initial, add]).expect("merge before removal");

    let removal =
      remove_pages_from_root_doc(&full_before, &["page-dup".to_string()]).expect("remove duplicate page entries");
    assert_eq!(
      removal.removed_entries, 2,
      "all duplicate root-meta entries must be removed"
    );

    let full_after = merge_updates(vec![full_before.clone(), removal.update]).expect("merge after removal");
    let page_ids: Vec<String> = extract_page_trash_state(&full_after)
      .expect("extract pages")
      .into_iter()
      .map(|entry| entry.id)
      .collect();
    assert_eq!(page_ids, vec!["page-keep".to_string()]);

    let second = remove_pages_from_root_doc(&full_after, &["page-dup".to_string()]).expect("second remove is no-op");
    assert_eq!(second.removed_entries, 0);
    assert!(
      second.update.is_empty(),
      "idempotent no-op must not write a root-doc update"
    );
  }

  fn append_raw_root_pages_update(root_doc_update: &[u8], pages: &[(String, String)]) -> Result<Vec<u8>, String> {
    let doc = Doc::new();
    let meta = doc.get_or_insert_map("meta");
    {
      let update = Update::decode_v1(root_doc_update).map_err(|e| e.to_string())?;
      let mut txn = doc.transact_mut();
      txn.apply_update(update).map_err(|e| e.to_string())?;
    }
    let sv_before = doc.transact().state_vector();
    {
      let mut txn = doc.transact_mut();
      let pages_array = match meta.get(&txn, "pages") {
        Some(yrs::Out::YArray(arr)) => arr,
        _ => return Err("append_raw_root_pages_update: root meta.pages missing".to_string()),
      };
      for (page_id, title) in pages {
        // This intentionally bypasses add_pages_to_root_doc's repair logic so
        // the removal test covers stale legacy root metadata with duplicates.
        let entry = yrs::MapPrelim::from([
          ("id".to_string(), yrs::Any::String(page_id.clone().into())),
          ("title".to_string(), yrs::Any::String(title.clone().into())),
        ]);
        pages_array.push_back(&mut txn, entry);
      }
    }
    Ok(doc.transact().encode_diff_v1(&sv_before))
  }

  fn set_root_page_trash(root_doc_update: &[u8], page_id: &str, is_trashed: bool) -> Vec<u8> {
    let doc = Doc::new();
    let meta = doc.get_or_insert_map("meta");
    {
      let update = Update::decode_v1(root_doc_update).expect("decode root doc update");
      let mut txn = doc.transact_mut();
      txn.apply_update(update).expect("apply root doc update");
    }

    let sv_before = doc.transact().state_vector();
    {
      let mut txn = doc.transact_mut();
      let Some(yrs::Out::YArray(pages)) = meta.get(&txn, "pages") else {
        panic!("root meta.pages missing");
      };
      let page = pages
        .iter(&txn)
        .find_map(|item| {
          let yrs::Out::YMap(page) = item else {
            return None;
          };
          match page.get(&txn, "id") {
            Some(yrs::Out::Any(yrs::Any::String(id))) if id.as_ref() == page_id => Some(page),
            _ => None,
          }
        })
        .expect("root page entry exists");

      if is_trashed {
        page.insert(&mut txn, "trash", yrs::Any::Bool(true));
      } else {
        page.remove(&mut txn, "trash");
      }
    }

    doc.transact().encode_diff_v1(&sv_before)
  }

  #[test]
  fn test_diffing() {
    let doc = Doc::new();
    let text = doc.get_or_insert_text("test");
    let update1 = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 0, "ABC");
      tx.encode_update_v1()
    };
    let state_vector = get_state_vector(&update1).unwrap();

    let full_data = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 3, "DEF");
      tx.encode_update_v1()
    };

    let diff = get_missing_diff(&full_data, &state_vector).expect("Diff failed");

    let client_doc = Doc::new();
    let _client_text = client_doc.get_or_insert_text("test");
    {
      let mut tx = client_doc.transact_mut();
      tx.apply_update(Update::decode_v1(&diff).unwrap())
        .expect("apply yjs update");
    }

    assert!(!diff.is_empty());
  }

  #[test]
  fn test_initial_workspace_doc() {
    let update = create_initial_workspace_doc("Test Workspace");
    assert!(!update.is_empty());

    // Apply to a fresh doc and verify structure
    let doc = Doc::new();
    let meta = doc.get_or_insert_map("meta");
    {
      let mut txn = doc.transact_mut();
      txn
        .apply_update(Update::decode_v1(&update).unwrap())
        .expect("apply yjs update");
    }

    let txn = doc.transact();
    // Verify name
    let name = meta.get(&txn, "name").unwrap();
    assert_eq!(name.to_string(&txn), "Test Workspace");
    // Verify pages array exists (YArray variant)
    let pages = meta.get(&txn, "pages").unwrap();
    match pages {
      yrs::Out::YArray(_) => {} // expected
      other => panic!("expected YArray, got: {:?}", other),
    }
  }

  // ─── P101-TIMESTAMP: Delete set preservation ────────────────────────────────

  /// P101-TIMESTAMP: merge_updates must preserve CRDT delete sets.
  ///
  /// When items are deleted from a YArray (e.g. pages removed from `meta.pages`),
  /// the delete set must survive the merge process. If it is dropped, deleted
  /// items are resurrected — causing phantom documents with stale timestamps
  /// to appear in the client's doc list.
  #[test]
  fn inv_p101_merge_preserves_delete_set() {
    // Step 1: Create a doc with 2 items in an array, then delete one.
    let doc = Doc::new();
    let arr = doc.get_or_insert_array("items");

    // Capture each transaction as a separate update.
    let upd1 = {
      let mut tx = doc.transact_mut();
      arr.push_back(&mut tx, "item_a");
      arr.push_back(&mut tx, "item_b");
      tx.encode_update_v1()
    };
    assert_eq!(arr.len(&doc.transact()), 2);

    let upd2 = {
      let mut tx = doc.transact_mut();
      arr.remove(&mut tx, 1); // delete "item_b"
      tx.encode_update_v1()
    };
    assert_eq!(arr.len(&doc.transact()), 1);

    // Step 2: Merge the two updates using our merge_updates function.
    let merged = merge_updates(vec![upd1, upd2]).expect("merge should succeed");

    // Step 3: Apply merged binary to a fresh doc — the array MUST contain
    // exactly 1 item. If the delete set was dropped, it will contain 2.
    let fresh = Doc::new();
    let fresh_arr = fresh.get_or_insert_array("items");
    {
      let mut tx = fresh.transact_mut();
      tx.apply_update(Update::decode_v1(&merged).unwrap())
        .expect("apply yjs update");
    }

    let len = fresh_arr.len(&fresh.transact());
    assert_eq!(
      len, 1,
      "merge_updates must preserve delete set: expected 1 item but got {} (deleted item resurrected)",
      len
    );
  }

  /// P101-TIMESTAMP: merge_updates must preserve delete set for YMap entries in YArray.
  ///
  /// Simulates the real-world scenario: workspace root doc has `meta.pages`
  /// (YArray of YMap). A page is added then removed. After merge, the removed
  /// page must NOT reappear.
  #[test]
  fn inv_p101_merge_preserves_delete_set_ymap_in_yarray() {
    use yrs::Map as _;

    let doc = Doc::new();
    let meta = doc.get_or_insert_map("meta");

    // Transaction 1: create pages array and add two pages
    let upd1 = {
      let mut tx = doc.transact_mut();
      let pages = meta.insert(&mut tx, "pages", yrs::ArrayPrelim::default());
      let page1 = yrs::MapPrelim::from([
        (String::from("id"), Any::String("page1".into())),
        (String::from("createDate"), Any::from(1775170563828.0)),
      ]);
      pages.push_back(&mut tx, page1);
      let page2 = yrs::MapPrelim::from([
        (String::from("id"), Any::String("page2".into())),
        (String::from("createDate"), Any::from(1775232588194.0)),
      ]);
      pages.push_back(&mut tx, page2);
      tx.encode_update_v1()
    };

    // Transaction 2: delete second page
    let upd2 = {
      let pages = {
        let tx = doc.transact();
        match meta.get(&tx, "pages") {
          Some(yrs::Out::YArray(arr)) => arr,
          _ => panic!("pages should be YArray"),
        }
      };
      let mut tx = doc.transact_mut();
      pages.remove(&mut tx, 1);
      tx.encode_update_v1()
    };
    assert_eq!(
      {
        let tx = doc.transact();
        match meta.get(&tx, "pages") {
          Some(yrs::Out::YArray(arr)) => arr.len(&tx),
          _ => 0,
        }
      },
      1
    );

    // Merge
    let merged = merge_updates(vec![upd1, upd2]).expect("merge should succeed");

    // Apply to fresh doc
    let fresh = Doc::new();
    let fresh_meta = fresh.get_or_insert_map("meta");
    {
      let mut tx = fresh.transact_mut();
      tx.apply_update(Update::decode_v1(&merged).unwrap())
        .expect("apply yjs update");
    }

    let tx = fresh.transact();
    let pages_val = fresh_meta.get(&tx, "pages");
    match pages_val {
      Some(yrs::Out::YArray(pages_ref)) => {
        let len = pages_ref.len(&tx);
        assert_eq!(
          len, 1,
          "deleted page must not reappear after merge: expected 1 page but got {}",
          len
        );
        // Verify it's the correct page
        if let Some(yrs::Out::YMap(page)) = pages_ref.get(&tx, 0)
          && let Some(yrs::Out::Any(Any::String(id))) = page.get(&tx, "id")
        {
          assert_eq!(id.as_ref(), "page1", "surviving page should be page1");
        }
      }
      other => {
        // Dump all meta keys for diagnosis
        let keys: Vec<String> = fresh_meta.keys(&tx).map(|k| k.to_string()).collect();
        panic!(
          "pages should be a YArray but got {:?}. meta keys: {:?}",
          other.as_ref().map(std::mem::discriminant),
          keys
        );
      }
    }
  }

  /// P101-TIMESTAMP: merge_updates must preserve delete set using real-world
  /// Yjs update payloads from the JS client.
  ///
  /// These 4 updates create `meta.pages` with 2 YMap entries, then delete
  /// the second. After merge, only 1 page must remain.
  #[test]
  fn inv_p101_merge_preserves_delete_set_real_payloads() {
    fn from_hex(s: &str) -> Vec<u8> {
      (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
    }
    let payloads: Vec<Vec<u8>> = vec![
      from_hex("0101c2c5b6e10d002701046d6574610570616765730000"),
      from_hex(
        "0103c2c5b6e10d010700c2c5b6e10d00012800c2c5b6e10d0102696401770570616765312800c2c5b6e10d010a63726561746544617465017b4271f71fb045000000",
      ),
      from_hex(
        "0103c2c5b6e10d0487c2c5b6e10d01012800c2c5b6e10d0402696401770570616765322800c2c5b6e10d040a63726561746544617465017b42a1f71fb304200000",
      ),
      from_hex("0001c2c5b6e10d010403"),
    ];

    // Verify: apply sequentially — should yield 1 page
    {
      let doc = Doc::new();
      for p in &payloads {
        let mut tx = doc.transact_mut();
        tx.apply_update(Update::decode_v1(p).unwrap())
          .expect("apply yjs update");
      }
      let meta = doc.get_or_insert_map("meta");
      let tx = doc.transact();
      if let Some(yrs::Out::YArray(pages)) = meta.get(&tx, "pages") {
        assert_eq!(pages.len(&tx), 1, "sequential apply should yield 1 page");
      }
    }

    // Test: merge_updates then apply — must also yield 1 page
    let merged = merge_updates(payloads).expect("merge should succeed");
    let fresh = Doc::new();
    let fresh_meta = fresh.get_or_insert_map("meta");
    {
      let mut tx = fresh.transact_mut();
      tx.apply_update(Update::decode_v1(&merged).unwrap())
        .expect("apply yjs update");
    }
    let tx = fresh.transact();
    match fresh_meta.get(&tx, "pages") {
      Some(yrs::Out::YArray(pages)) => {
        let len = pages.len(&tx);
        assert_eq!(
          len, 1,
          "merge_updates must preserve delete set: expected 1 page but got {} (deleted page resurrected)",
          len
        );
        if let Some(yrs::Out::YMap(page)) = pages.get(&tx, 0)
          && let Some(yrs::Out::Any(Any::String(id))) = page.get(&tx, "id")
        {
          assert_eq!(id.as_ref(), "page1", "surviving page should be page1");
        }
      }
      other => panic!(
        "pages should be a YArray, got {:?}",
        other.as_ref().map(std::mem::discriminant)
      ),
    }
  }

  // ─── P28 Invariant Tests ───────────────────────────────────────────────────

  #[test]
  fn inv_p28_10_merge_deterministic() {
    let doc = Doc::new();
    let text = doc.get_or_insert_text("t");
    let u1 = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 0, "Hello");
      tx.encode_update_v1()
    };
    let u2 = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 5, " World");
      tx.encode_update_v1()
    };

    let result_a = merge_updates(vec![u1.clone(), u2.clone()]).unwrap();
    let result_b = merge_updates(vec![u1, u2]).unwrap();
    assert_eq!(result_a, result_b, "merge_updates must be deterministic");
  }

  #[test]
  fn inv_p28_11_merge_empty_inputs() {
    let empty = merge_updates(vec![]).unwrap();
    assert!(!empty.is_empty(), "empty merge must return valid binary");

    let with_empties = merge_updates(vec![vec![], vec![]]).unwrap();
    assert!(
      !with_empties.is_empty(),
      "merge of empty updates must return valid binary"
    );
  }

  #[test]
  fn inv_p28_12_merge_yrs_interop() {
    let doc = Doc::new();
    let text = doc.get_or_insert_text("x");
    let u1 = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 0, "ABC");
      tx.encode_update_v1()
    };
    let u2 = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 3, "DEF");
      tx.encode_update_v1()
    };

    let merged = merge_updates(vec![u1, u2]).unwrap();

    // Must be decodable by yrs
    let verify_doc = Doc::new();
    let verify_text = verify_doc.get_or_insert_text("x");
    {
      let mut tx = verify_doc.transact_mut();
      tx.apply_update(Update::decode_v1(&merged).expect("yrs must decode codec output"))
        .expect("apply yjs update");
    }
    let content = verify_text.get_string(&verify_doc.transact());
    assert!(
      content.contains("ABC"),
      "merged content must contain ABC, got: {content}"
    );
    assert!(
      content.contains("DEF"),
      "merged content must contain DEF, got: {content}"
    );
  }

  #[test]
  fn inv_p28_20_state_vector_deterministic() {
    let doc = Doc::new();
    let text = doc.get_or_insert_text("t");
    let update = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 0, "test data");
      tx.encode_update_v1()
    };

    let sv_a = get_state_vector(&update).unwrap();
    let sv_b = get_state_vector(&update).unwrap();
    assert_eq!(sv_a, sv_b, "get_state_vector must be deterministic");
  }

  #[test]
  fn inv_p28_21_state_vector_yrs_interop() {
    let doc = Doc::new();
    let text = doc.get_or_insert_text("t");
    let update = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 0, "interop test");
      tx.encode_update_v1()
    };

    let sv_bytes = get_state_vector(&update).unwrap();
    // Must be decodable by yrs
    let sv = yrs::StateVector::decode_v1(&sv_bytes).expect("yrs must decode codec state vector");
    assert!(!sv.is_empty(), "state vector must not be empty");
  }

  #[test]
  fn inv_p28_30_diff_deterministic() {
    let doc = Doc::new();
    let text = doc.get_or_insert_text("t");
    let full = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 0, "full content");
      tx.encode_update_v1()
    };
    let sv = get_state_vector(&{
      let d = Doc::new();
      let t = d.get_or_insert_text("t");
      let mut tx = d.transact_mut();
      t.insert(&mut tx, 0, "part");
      tx.encode_update_v1()
    })
    .unwrap();

    let diff_a = get_missing_diff(&full, &sv).unwrap();
    let diff_b = get_missing_diff(&full, &sv).unwrap();
    assert_eq!(diff_a, diff_b, "get_missing_diff must be deterministic");
  }

  #[test]
  fn inv_p28_31_diff_yrs_decodable() {
    let doc = Doc::new();
    let text = doc.get_or_insert_text("t");
    let update = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 0, "test data for diff");
      tx.encode_update_v1()
    };

    let diff = get_missing_diff(&update, &[0]).unwrap();
    // Must be decodable by yrs
    let decoded = Update::decode_v1(&diff);
    assert!(decoded.is_ok(), "yrs must decode codec diff: {:?}", decoded.err());
  }

  #[test]
  fn inv_p28_32_diff_completeness() {
    // Create two updates from the same doc
    let doc = Doc::new();
    let text = doc.get_or_insert_text("content");
    let u1 = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 0, "Hello ");
      tx.encode_update_v1()
    };
    let sv_after_u1 = get_state_vector(&u1).unwrap();
    let full = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 6, "World");
      tx.encode_update_v1()
    };
    let merged_full = merge_updates(vec![u1.clone(), full]).unwrap();

    // Diff: what does a client with u1 need to catch up?
    let diff = get_missing_diff(&merged_full, &sv_after_u1).unwrap();

    // Apply u1 + diff to a fresh doc — must contain full content
    let verify = Doc::new();
    let vtext = verify.get_or_insert_text("content");
    {
      let mut tx = verify.transact_mut();
      tx.apply_update(Update::decode_v1(&u1).unwrap())
        .expect("apply yjs update");
      tx.apply_update(Update::decode_v1(&diff).unwrap())
        .expect("apply yjs update");
    }
    let content = vtext.get_string(&verify.transact());
    assert!(
      content.contains("Hello"),
      "diff must complete the document, got: {content}"
    );
    assert!(content.contains("World"), "diff must include new data, got: {content}");
  }

  /// YJS-RV-01b: delete-only updates must be transported by get_missing_diff.
  #[test]
  fn inv_yjs_rv01_diff_transports_deletions() {
    let doc = Doc::new();
    let text = doc.get_or_insert_text("t");

    // Phase 1: insert text
    let u1 = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 0, "ABCDEF");
      tx.encode_update_v1()
    };
    let sv_after_insert = get_state_vector(&u1).unwrap();

    // Phase 2: delete some characters (produces a delete-set update)
    let u2 = {
      let mut tx = doc.transact_mut();
      text.remove_range(&mut tx, 2, 2); // remove "CD"
      tx.encode_update_v1()
    };

    let merged = merge_updates(vec![u1.clone(), u2]).unwrap();
    let diff = get_missing_diff(&merged, &sv_after_insert).unwrap();

    // Apply u1 + diff to a fresh doc — must reflect the deletion
    let verify = Doc::new();
    let vtext = verify.get_or_insert_text("t");
    {
      let mut tx = verify.transact_mut();
      tx.apply_update(Update::decode_v1(&u1).unwrap())
        .expect("apply yjs update");
      tx.apply_update(Update::decode_v1(&diff).unwrap())
        .expect("apply yjs update");
    }
    let result = vtext.get_string(&verify.transact());
    assert_eq!(result, "ABEF", "diff must include deletion, got: {result}");
  }

  /// YJS-RV-01c: apply(base + diff) produces the same visible state as full update.
  #[test]
  fn inv_yjs_rv01_diff_plus_base_equals_full() {
    let doc = Doc::new();
    let text = doc.get_or_insert_text("t");

    let u1 = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 0, "Hello ");
      tx.encode_update_v1()
    };
    let sv1 = get_state_vector(&u1).unwrap();

    let _u2 = {
      let mut tx = doc.transact_mut();
      text.insert(&mut tx, 6, "World");
      tx.encode_update_v1()
    };
    let _u3 = {
      let mut tx = doc.transact_mut();
      text.remove_range(&mut tx, 5, 1); // remove space
      tx.encode_update_v1()
    };

    let full = {
      let tx = doc.transact();
      tx.encode_state_as_update_v1(&yrs::StateVector::default())
    };

    let diff = get_missing_diff(&full, &sv1).unwrap();

    // Apply u1 + diff to fresh doc
    let via_diff = Doc::new();
    let vt1 = via_diff.get_or_insert_text("t");
    {
      let mut tx = via_diff.transact_mut();
      tx.apply_update(Update::decode_v1(&u1).unwrap())
        .expect("apply yjs update");
      tx.apply_update(Update::decode_v1(&diff).unwrap())
        .expect("apply yjs update");
    }

    // Apply full to another fresh doc
    let via_full = Doc::new();
    let vt2 = via_full.get_or_insert_text("t");
    {
      let mut tx = via_full.transact_mut();
      tx.apply_update(Update::decode_v1(&full).unwrap())
        .expect("apply yjs update");
    }

    let s1 = vt1.get_string(&via_diff.transact());
    let s2 = vt2.get_string(&via_full.transact());
    assert_eq!(s1, s2, "base+diff must equal full update: diff='{s1}' full='{s2}'");
  }

  // ─── Inline Formatting Tests ─────────────────────────────────────────────

  #[test]
  fn snapshot_block_import_emits_collaborative_children_arrays() {
    let source = serde_json::from_value::<Vec<PortableSnapshotBlock>>(serde_json::json!([
      {
        "id": "page",
        "flavour": "affine:page",
        "children": ["note"],
        "props": { "title": "Imported page" }
      },
      {
        "id": "note",
        "flavour": "affine:note",
        "children": ["paragraph", "linked"],
        "props": {}
      },
      {
        "id": "paragraph",
        "flavour": "affine:paragraph",
        "children": [],
        "props": { "text": "Imported text" }
      },
      {
        "id": "linked",
        "flavour": "affine:embed-linked-doc",
        "children": [],
        "props": { "pageId": "target" }
      }
    ]))
    .expect("portable snapshot blocks");
    let update = snapshot_blocks_to_yjs(&source).expect("encode snapshot blocks");

    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    {
      let mut txn = doc.transact_mut();
      txn
        .apply_update(Update::decode_v1(&update).expect("decode snapshot update"))
        .expect("apply snapshot update");
    }

    let txn = doc.transact();
    for (block_id, expected_children) in [
      ("page", vec!["note"]),
      ("note", vec!["paragraph", "linked"]),
      ("paragraph", Vec::new()),
      ("linked", Vec::new()),
    ] {
      let yrs::Out::YMap(block) = blocks.get(&txn, block_id).expect("imported block") else {
        panic!("snapshot block {block_id} must be a Y.Map");
      };
      let yrs::Out::YArray(children) = block.get(&txn, "sys:children").expect("canonical children property") else {
        panic!("snapshot block {block_id} children must be a Y.Array");
      };
      let actual_children = children
        .iter(&txn)
        .map(|child| match child {
          yrs::Out::Any(yrs::Any::String(child)) => child.to_string(),
          other => panic!("snapshot child must be a string, got {other:?}"),
        })
        .collect::<Vec<_>>();
      assert_eq!(actual_children, expected_children);
    }

    let yrs::Out::YMap(page) = blocks.get(&txn, "page").expect("page block") else {
      panic!("page block must be a Y.Map");
    };
    assert!(
      matches!(page.get(&txn, "prop:title"), Some(yrs::Out::YText(_))),
      "root title must be a collaborative Y.Text"
    );
    let yrs::Out::YMap(paragraph) = blocks.get(&txn, "paragraph").expect("paragraph block") else {
      panic!("paragraph block must be a Y.Map");
    };
    assert!(
      matches!(paragraph.get(&txn, "prop:text"), Some(yrs::Out::YText(_))),
      "paragraph text must be a collaborative Y.Text"
    );
    let yrs::Out::YMap(linked) = blocks.get(&txn, "linked").expect("linked block") else {
      panic!("linked block must be a Y.Map");
    };
    assert!(matches!(
      linked.get(&txn, "sys:flavour"),
      Some(yrs::Out::Any(yrs::Any::String(flavour))) if flavour.as_ref() == "myoxus:embed-linked-doc"
    ));
  }

  #[test]
  fn snapshot_block_import_preserves_rich_text_versions_and_surface_storage() {
    let source = vec![
      PortableSnapshotBlock {
        id: "page".into(),
        flavour: "myoxus:page".into(),
        version: Some(2),
        props: serde_json::from_value(serde_json::json!({"title": "Native source"})).unwrap(),
        children: vec!["note".into(), "surface".into()],
      },
      PortableSnapshotBlock {
        id: "note".into(),
        flavour: "myoxus:note".into(),
        version: None,
        props: Default::default(),
        children: vec!["paragraph".into(), "table".into(), "callout".into()],
      },
      PortableSnapshotBlock {
        id: "paragraph".to_string(),
        flavour: "affine:paragraph".to_string(),
        version: Some(1),
        props: serde_json::from_value(serde_json::json!({
          "text": {
            "$blocksuite:internal:text$": true,
            "delta": [
              { "insert": "Übersicht {{input.subject}}", "attributes": { "bold": true } },
              { "insert": " link", "attributes": { "link": "https://example.com" } }
            ]
          },
          "style": { "tones": ["neutral"], "empty": {}, "nested": [{"enabled": true}] },
          "repeat": { "source": "input.members", "alias": "member" },
          "boxed": { "$virgultum:internal:native$": true, "value": { "options": ["open", null] } }
        }))
        .expect("paragraph props"),
        children: Vec::new(),
      },
      serde_json::from_value(serde_json::json!({
        "id": "callout", "flavour": "myoxus:callout", "version": 1,
        "props": { "text": "{{actor.name}}", "icon": {"type":"emoji","unicode":"⚠️"} }
      })).unwrap(),
      serde_json::from_value(serde_json::json!({
        "id": "table", "flavour": "myoxus:table", "version": 1,
        "props": {
          "headerRows": 1, "appearance": "ruled", "density": "compact",
          "columns": {
            "role": {"columnId":"role","order":"a0","width":240,"textAlign":"left"},
            "value": {"columnId":"value","order":"a1","width":120,"textAlign":"center"}
          },
          "rows": { "header":{"rowId":"header","order":"a0"}, "body":{"rowId":"body","order":"a1"} },
          "cells": {
            "header:role":{"text":{"$virgultum:internal:text$":true,"delta":[{"insert":"Role","attributes":{"bold":true}}]}},
            "body:value":{"text":{"$virgultum:internal:text$":true,"delta":[{"insert":"{{input.score}}"}]}}
          }
        }
      })).unwrap(),
      PortableSnapshotBlock {
        id: "surface".to_string(),
        flavour: "affine:surface".to_string(),
        version: Some(5),
        props: serde_json::from_value(serde_json::json!({
          "elements": {
            "shape": {
              "id": "shape",
              "type": "shape",
              "text": {
                "affine:surface:text": true,
                "delta": [{ "insert": "Canvas label" }]
              },
              "geometry": {
                "affine:surface:ymap": true,
                "json": { "x": 10, "options": [true, null] }
              }
            }
          }
        }))
        .expect("surface props"),
        children: Vec::new(),
      },
    ];
    let canonical_update = snapshot_blocks_to_yjs(&source).expect("encode canonical snapshot blocks");
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let creation = doc.get_or_insert_map("meta");
    {
      let mut txn = doc.transact_mut();
      txn
        .apply_update(Update::decode_v1(&canonical_update).expect("decode snapshot update"))
        .expect("apply snapshot update");
      creation.insert(&mut txn, "pageCreationId", "source-id");
      creation.insert(&mut txn, "pageCreationIntent", "native-editor-create");
      let Some(yrs::Out::YMap(callout)) = blocks.get(&txn, "callout") else {
        panic!("callout fixture");
      };
      callout.insert(
        &mut txn,
        "prop:icon",
        Any::from_json(r#"{"type":"emoji","unicode":"⚠️"}"#).unwrap(),
      );
      let Some(yrs::Out::YMap(table)) = blocks.get(&txn, "table") else {
        panic!("table fixture");
      };
      table.insert(&mut txn, "prop:comments", Any::Undefined);
      table.insert(&mut txn, "prop:textAlign", Any::Undefined);
    }
    let update = doc.transact().encode_state_as_update_v1(&StateVector::default());
    let txn = doc.transact();
    let yrs::Out::YMap(paragraph) = blocks.get(&txn, "paragraph").expect("paragraph") else {
      panic!("paragraph must be a Y.Map");
    };
    assert!(matches!(
      paragraph.get(&txn, "sys:version"),
      Some(yrs::Out::Any(yrs::Any::Number(version))) if version.as_f64() == Some(1.0)
    ));
    let yrs::Out::YText(text) = paragraph.get(&txn, "prop:text").expect("paragraph text") else {
      panic!("paragraph text must be a Y.Text");
    };
    let chunks = text.diff(&txn, YChange::identity);
    assert_eq!(chunks.len(), 2);
    assert_eq!(text.get_string(&txn), "Übersicht {{input.subject}} link");
    assert!(matches!(
      chunks[0].attributes.as_deref().and_then(|attrs| attrs.get("bold")),
      Some(Any::Bool(true))
    ));
    assert!(paragraph.get(&txn, "prop:style.tones").is_none());
    let yrs::Out::YMap(style) = paragraph.get(&txn, "prop:style").expect("native nested object") else {
      panic!("normal block properties must use SyncController's shared map");
    };
    let yrs::Out::YArray(tones) = style.get(&txn, "tones").expect("nested shared array") else {
      panic!("style tones must remain a collaborative Y.Array");
    };
    assert_eq!(tones.len(&txn), 1);

    let yrs::Out::YMap(surface) = blocks.get(&txn, "surface").expect("surface") else {
      panic!("surface must be a Y.Map");
    };
    assert!(matches!(
      surface.get(&txn, "sys:version"),
      Some(yrs::Out::Any(yrs::Any::Number(version))) if version.as_f64() == Some(5.0)
    ));
    let yrs::Out::YMap(boxed) = surface.get(&txn, "prop:elements").expect("boxed elements") else {
      panic!("surface elements must use Boxed storage");
    };
    assert!(matches!(
      boxed.get(&txn, "type"),
      Some(yrs::Out::Any(yrs::Any::String(marker))) if marker.as_ref() == "$virgultum:internal:native$"
    ));
    let yrs::Out::YMap(elements) = boxed.get(&txn, "value").expect("surface element map") else {
      panic!("boxed surface value must be a Y.Map");
    };
    let yrs::Out::YMap(shape) = elements.get(&txn, "shape").expect("surface shape") else {
      panic!("surface element must be a Y.Map");
    };
    assert!(matches!(shape.get(&txn, "text"), Some(yrs::Out::YText(_))));

    let exported = document_to_snapshot(&update, "source-id", "Native source").expect("capture native source");
    let exported_blocks: Vec<PortableSnapshotBlock> = serde_json::from_value(exported["blocks"].clone()).unwrap();
    let reimported = snapshot_blocks_to_yjs(&exported_blocks).expect("reconstruct editable native content");
    // The independent fixture retains every expected property and mark, while
    // raw icons and unset defaults normalize to its editable representation.
    assert!(native_documents_have_same_content(&canonical_update, &reimported).expect("full native content fidelity"));
    assert_eq!(
      exported_blocks
        .iter()
        .map(|block| (&block.id, &block.children))
        .collect::<std::collections::BTreeMap<_, _>>(),
      source
        .iter()
        .map(|block| (&block.id, &block.children))
        .collect::<std::collections::BTreeMap<_, _>>()
    );
    let exported_again = document_to_snapshot(&reimported, "source-id", "Native source").unwrap();
    assert_eq!(
      exported_again, exported,
      "all logical values and text/native markers survive editable collection normalization"
    );
  }

  #[test]
  fn imported_workspace_page_preserves_source_timestamps() {
    let timestamp = 1_710_000_000_123_i64;
    let update = create_imported_workspace_doc(
      "Imported workspace",
      &[ImportedWorkspacePage {
        id: "document".to_string(),
        title: "Document".to_string(),
        mode: "page".to_string(),
        parent_id: None,
        order: "a0".to_string(),
        created_at_ms: timestamp,
        updated_at_ms: timestamp,
        is_trashed: false,
      }],
    );
    let doc = Doc::new();
    let meta = doc.get_or_insert_map("meta");
    {
      let mut txn = doc.transact_mut();
      txn
        .apply_update(Update::decode_v1(&update).expect("decode workspace metadata"))
        .expect("apply workspace metadata");
    }
    let txn = doc.transact();
    let yrs::Out::YArray(pages) = meta.get(&txn, "pages").expect("workspace pages") else {
      panic!("workspace pages must be a Y.Array");
    };
    let yrs::Out::YMap(page) = pages.iter(&txn).next().expect("imported page") else {
      panic!("imported page must be a Y.Map");
    };
    assert!(matches!(
      page.get(&txn, "createDate"),
      Some(yrs::Out::Any(Any::Number(value))) if value.as_f64() == Some(timestamp as f64)
    ));
    assert!(matches!(
      page.get(&txn, "updatedDate"),
      Some(yrs::Out::Any(Any::Number(value))) if value.as_f64() == Some(timestamp as f64)
    ));
  }

  #[test]
  fn legacy_database_rewrite_retains_a_collaborative_children_array() {
    let source = serde_json::from_value::<Vec<PortableSnapshotBlock>>(serde_json::json!([
      {
        "id": "database",
        "flavour": "affine:database",
        "children": ["row"],
        "props": {
          "databaseId": "legacy-database",
          "title": "Legacy database",
          "columns": [],
          "views": [],
          "cells": {
            "row": {
              "status": { "columnId": "status", "value": "Open" }
            }
          }
        }
      },
      {
        "id": "row",
        "flavour": "affine:paragraph",
        "children": [],
        "props": { "text": "Legacy row" }
      }
    ]))
    .expect("portable Database snapshot blocks");
    let source_update = snapshot_blocks_to_yjs(&source).expect("encode legacy Database blocks");
    let extracted = extract_legacy_database_blocks(&source_update).expect("extract legacy Database cells");
    assert_eq!(
      extracted[0].cells["row"]["status"]["value"], "Open",
      "flat Virgultum property paths must reconstruct the portable nested Cell payload"
    );
    let rewritten = rewrite_legacy_database_references(
      &source_update,
      &[LegacyDatabaseReferenceRewrite {
        block_id: "database".to_string(),
        server_database_id: Uuid::new_v4(),
        server_view_id: Some(Uuid::new_v4()),
      }],
    )
    .expect("rewrite legacy Database reference");

    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    {
      let mut txn = doc.transact_mut();
      txn
        .apply_update(Update::decode_v1(&rewritten.full_state).expect("decode rewritten state"))
        .expect("apply rewritten state");
    }
    let txn = doc.transact();
    let yrs::Out::YMap(database) = blocks.get(&txn, "database").expect("Database reference") else {
      panic!("Database reference must be a Y.Map");
    };
    let yrs::Out::YArray(children) = database.get(&txn, "sys:children").expect("Database children") else {
      panic!("Database reference children must be a Y.Array");
    };
    assert_eq!(children.len(&txn), 0);
    assert!(blocks.get(&txn, "row").is_none(), "legacy row block must be removed");
  }

  // ─── Comprehensive Markdown Conversion Tests ──────────────────────────────

  // ─── GFM Table Tests ──────────────────────────────────────────────────

  // ─── Nested List Tests (P49-B-07) ──────────────────────────────────────

  // ─── YouTube Embed Tests (P49-B-10) ───────────────────────────────────

  // ─── P49-C-05: Edge Case Tests ─────────────────────────────────────────

  // ─── P51-D-07: Bidirectional Roundtrip Test ──────────────────────────────

  // ─── P49-B-10: YouTube Embed Tests ────────────────────────────────────

  // ─── P101-TIMESTAMP: Diff must preserve large numeric values ─────────────

  /// P101-TIMESTAMP: get_missing_diff must preserve Int53/Float64 values
  /// like millisecond timestamps (e.g. createDate = 1775388290315).
  ///
  /// Root cause: the old codec-based get_missing_diff truncated large
  /// numbers during encode, producing values like 1566797067 from
  /// 1775388290315 — which the client displayed as "19. Jan. 1970".
  #[test]
  fn inv_p101_diff_preserves_large_numbers() {
    let doc = Doc::new();
    let meta = doc.get_or_insert_map("meta");
    let u1 = {
      let mut tx = doc.transact_mut();
      meta.insert(&mut tx, "name", "Test");
      meta.insert(&mut tx, "pages", yrs::ArrayPrelim::default());
      tx.encode_update_v1()
    };

    let u2 = {
      let mut tx = doc.transact_mut();
      let pages = match meta.get(&tx, "pages") {
        Some(yrs::Out::YArray(arr)) => arr,
        _ => panic!("pages not found"),
      };
      pages.push_back(
        &mut tx,
        yrs::MapPrelim::from([
          ("id".to_string(), Any::String("test-page".into())),
          ("title".to_string(), Any::String("Test Page".into())),
          ("createDate".to_string(), Any::from(1775388290315.0)),
          ("updatedDate".to_string(), Any::from(1775388296942.0)),
        ]),
      );
      tx.encode_update_v1()
    };

    // Merge both updates and compute diff from empty state
    let full = merge_updates(vec![u1, u2]).unwrap();
    let empty_sv = vec![0u8];
    let diff = get_missing_diff(&full, &empty_sv).unwrap();

    // Apply diff to a fresh doc — must contain the full state with correct numbers
    let verify = Doc::new();
    let vmeta = verify.get_or_insert_map("meta");
    {
      let mut tx = verify.transact_mut();
      tx.apply_update(Update::decode_v1(&diff).unwrap())
        .expect("apply yjs update");
    }

    let txn = verify.transact();
    let pages = match vmeta.get(&txn, "pages") {
      Some(yrs::Out::YArray(arr)) => arr,
      _ => panic!("pages not found after diff"),
    };
    assert_eq!(pages.len(&txn), 1, "should have 1 page");
    let page = pages.get(&txn, 0).unwrap();
    if let yrs::Out::YMap(m) = page {
      let cd = m.get(&txn, "createDate");
      match cd {
        Some(yrs::Out::Any(Any::Number(n))) => {
          assert_eq!(
            n.as_f64(),
            Some(1775388290315.0),
            "createDate must be preserved exactly through diff, got {n}"
          );
        }
        other => panic!("createDate should be Number, got {:?}", other),
      }
    } else {
      panic!("page entry should be YMap");
    }
  }

  #[test]
  fn test_extract_page_trash_state_dedup_any_trash_wins() {
    // Simulate CRDT duplicate-entry (LRN-20260405-290): two YArray entries for
    // the same page_id, one with trash=true and one without.
    // Expected: extract_page_trash_state returns exactly ONE entry with is_trashed=true.
    use yrs::{Any, Array, Map, Transact};

    let doc = Doc::new();
    let meta = doc.get_or_insert_map("meta");
    let mut txn = doc.transact_mut();
    meta.insert(&mut txn, "pages", yrs::ArrayPrelim::default());
    let pages_arr = match meta.get(&txn, "pages") {
      Some(yrs::Out::YArray(arr)) => arr,
      _ => panic!("pages array missing"),
    };
    // Entry 1: trash=true
    pages_arr.push_back(
      &mut txn,
      yrs::MapPrelim::from([
        ("id".to_string(), Any::String("page-abc".into())),
        ("trash".to_string(), Any::Bool(true)),
      ]),
    );
    // Entry 2: same page_id, no trash field
    pages_arr.push_back(
      &mut txn,
      yrs::MapPrelim::from([("id".to_string(), Any::String("page-abc".into()))]),
    );
    // Entry 3: different page, not trashed
    pages_arr.push_back(
      &mut txn,
      yrs::MapPrelim::from([("id".to_string(), Any::String("page-xyz".into()))]),
    );
    drop(txn);
    let data = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());

    let entries = extract_page_trash_state(&data).expect("extract should succeed");

    // Must return exactly 2 unique pages (page-abc deduplicated, page-xyz normal)
    assert_eq!(
      entries.len(),
      2,
      "expected 2 unique pages, got {}: {:?}",
      entries.len(),
      entries
    );

    let abc = entries.iter().find(|e| e.id == "page-abc").expect("page-abc missing");
    let xyz = entries.iter().find(|e| e.id == "page-xyz").expect("page-xyz missing");

    // any-trash-wins: page-abc had one trash=true entry → must be trashed
    assert!(
      abc.is_trashed,
      "page-abc: any-trash-wins should result in is_trashed=true, got false"
    );
    // page-xyz: no trash entry → not trashed
    assert!(
      !xyz.is_trashed,
      "page-xyz: no trash entry, should be is_trashed=false, got true"
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V6-A-T-09 — flavour_alias_text_extraction
  // Invariant: resolve_flavour() normalises both legacy affine:* and canonical
  // myoxus:* flavours, so extract_text_from_yjs works on both document formats.
  // ─────────────────────────────────────────────────────────────────────────

  /// resolve_flavour: canonical myoxus:* flavours pass through unchanged.
  #[test]
  fn resolve_flavour_canonical_passthrough() {
    assert_eq!(resolve_flavour("myoxus:page"), "myoxus:page");
    assert_eq!(resolve_flavour("myoxus:paragraph"), "myoxus:paragraph");
    assert_eq!(resolve_flavour("myoxus:note"), "myoxus:note");
    assert_eq!(resolve_flavour("myoxus:code"), "myoxus:code");
    assert_eq!(resolve_flavour("myoxus:embed-github"), "myoxus:embed-github");
    assert_eq!(resolve_flavour("myoxus:surface"), "myoxus:surface");
  }

  /// resolve_flavour: legacy affine:* flavours resolve to canonical myoxus:*.
  #[test]
  fn resolve_flavour_legacy_aliasing() {
    assert_eq!(resolve_flavour("affine:page"), "myoxus:page");
    assert_eq!(resolve_flavour("affine:paragraph"), "myoxus:paragraph");
    assert_eq!(
      resolve_flavour("affine:heading"),
      "myoxus:paragraph",
      "legacy affine:heading projects to the active paragraph storage flavour"
    );
    assert_eq!(resolve_flavour("affine:note"), "myoxus:note");
    assert_eq!(resolve_flavour("affine:code"), "myoxus:code");
    assert_eq!(resolve_flavour("affine:embed-github"), "myoxus:embed-github");
    assert_eq!(resolve_flavour("affine:surface"), "myoxus:surface");
    assert_eq!(resolve_flavour("affine:list"), "myoxus:list");
    assert_eq!(resolve_flavour("affine:image"), "myoxus:image");
    assert_eq!(resolve_flavour("affine:attachment"), "myoxus:attachment");
    assert_eq!(resolve_flavour("affine:bookmark"), "myoxus:bookmark");
    assert_eq!(resolve_flavour("affine:database"), "myoxus:database");
    assert_eq!(resolve_flavour("affine:latex"), "myoxus:latex");
    assert_eq!(resolve_flavour("affine:frame"), "myoxus:frame");
    assert_eq!(resolve_flavour("affine:embed-linked-doc"), "myoxus:embed-linked-doc");
    assert_eq!(resolve_flavour("affine:embed-synced-doc"), "myoxus:embed-synced-doc");
  }

  /// resolve_flavour: unknown / custom flavours pass through unchanged.
  #[test]
  fn resolve_flavour_unknown_passthrough() {
    assert_eq!(resolve_flavour("custom:block"), "custom:block");
    assert_eq!(resolve_flavour(""), "");
    assert_eq!(resolve_flavour("affine:unknown-block"), "affine:unknown-block");
  }

  #[test]
  fn workspace_collection_decoder_preserves_rules_and_rejects_duplicate_ids() {
    let encode = |collections: serde_json::Value| {
      let doc = Doc::new();
      let setting = doc.get_or_insert_map("setting");
      let mut txn = doc.transact_mut();
      setting.insert(&mut txn, "collections", json_to_yjs_any(&collections).unwrap());
      txn.encode_update_v1()
    };
    let update = encode(serde_json::json!([{
      "id": "delivery",
      "name": "Delivery",
      "rules": {"filters": [{"type": "system", "key": "status"}]},
      "allowList": ["doc-a"],
      "futureRule": {"preserved": true}
    }]));
    let collections = extract_workspace_collections(&update).unwrap();
    assert_eq!(collections.len(), 1);
    assert_eq!(
      collections[0].pointer("/futureRule/preserved"),
      Some(&serde_json::Value::Bool(true))
    );

    let duplicate = encode(serde_json::json!([
      {"id": "delivery", "name": "A"},
      {"id": "delivery", "name": "B"}
    ]));
    assert!(
      extract_workspace_collections(&duplicate)
        .unwrap_err()
        .contains("not unique")
    );
  }
}

mod native_template_references;
pub use native_template_references::{
  NativeTemplateReferenceTargets, bind_native_template_references, inspect_native_template_references,
};
