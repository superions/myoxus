// SPDX-License-Identifier: AGPL-3.0-or-later
//! Server-authoritative document-version label generation.
//!
//! The service owns label preview and allocation. Callers provide an event and
//! optional manual label; they must not build final labels themselves.

use std::sync::Arc;

use chrono::{Datelike, NaiveDate, Utc};
use thiserror::Error;
use tracing::{debug, instrument};
use uuid::Uuid;

use myoxus_domain::entities::{DocumentVersionEvent, DocumentVersionPolicy};
use myoxus_domain::repositories::{DocumentVersionRepository, RepositoryError};

pub(crate) const MAX_LABEL_LEN: usize = 96;

#[derive(Debug, Error)]
pub enum DocumentVersionLabelError {
  #[error(transparent)]
  Repository(#[from] RepositoryError),
  #[error("manual label is required for this scheme")]
  ManualLabelRequired,
  #[error("label pattern contains unsupported token: {0}")]
  UnsupportedToken(String),
  #[error("label pattern renders to an empty label")]
  EmptyLabel,
}

#[derive(Debug, Clone)]
pub struct DocumentVersionLabelRequest {
  pub doc_id: Uuid,
  pub workspace_id: Option<Uuid>,
  pub event: DocumentVersionEvent,
  pub requested_label: Option<String>,
  pub force_requested_label: bool,
  pub doc_slug: Option<String>,
  pub workspace_slug: Option<String>,
  pub author_slug: Option<String>,
}

impl DocumentVersionLabelRequest {
  pub fn new(doc_id: Uuid, workspace_id: Option<Uuid>, event: DocumentVersionEvent) -> Self {
    Self {
      doc_id,
      workspace_id,
      event,
      requested_label: None,
      force_requested_label: false,
      doc_slug: None,
      workspace_slug: None,
      author_slug: None,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentVersionLabelOutcome {
  pub label: String,
  pub counter_key: Option<String>,
  pub counter_value: Option<i64>,
  pub policy_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentVersionLabelPreview {
  pub event: DocumentVersionEvent,
  pub label: String,
}

/// Validated naming rules without a reserved counter. Persistence allocates the
/// counter in the transaction that captures the document and inserts its version.
#[derive(Debug, Clone)]
pub struct PreparedDocumentVersionLabel {
  request: DocumentVersionLabelRequest,
  pattern: Option<String>,
  manual: Option<String>,
  date: NaiveDate,
  pub counter_key: Option<String>,
  pub policy_id: Option<Uuid>,
}

impl PreparedDocumentVersionLabel {
  pub fn render(&self, counter: Option<i64>) -> Result<DocumentVersionLabelOutcome, DocumentVersionLabelError> {
    let label = match (&self.pattern, &self.manual, counter) {
      (Some(pattern), None, Some(value)) => render_pattern(pattern, &self.request, value, self.date)?,
      (None, Some(label), None) => label.clone(),
      _ => return Err(DocumentVersionLabelError::EmptyLabel),
    };
    Ok(DocumentVersionLabelOutcome {
      label,
      counter_key: self.counter_key.clone(),
      counter_value: counter,
      policy_id: self.policy_id,
    })
  }
}

#[derive(Clone)]
pub struct DocumentVersionLabelService {
  repo: Arc<dyn DocumentVersionRepository>,
}

impl DocumentVersionLabelService {
  pub fn new(repo: Arc<dyn DocumentVersionRepository>) -> Self {
    Self { repo }
  }

  #[instrument(skip(self, request), fields(doc_id = %request.doc_id, workspace_id = ?request.workspace_id, event = request.event.as_str()), err)]
  pub async fn next_label(
    &self,
    request: DocumentVersionLabelRequest,
  ) -> Result<DocumentVersionLabelOutcome, DocumentVersionLabelError> {
    let prepared = self.prepare(request).await?;
    let counter = match &prepared.counter_key {
      Some(key) => Some(self.repo.next_counter_value(prepared.request.doc_id, key).await?),
      None => None,
    };
    prepared.render(counter)
  }

  pub async fn prepare(
    &self,
    request: DocumentVersionLabelRequest,
  ) -> Result<PreparedDocumentVersionLabel, DocumentVersionLabelError> {
    let policy = self.repo.default_policy(request.workspace_id).await?;
    let scheme = policy
      .as_ref()
      .map(|policy| policy.scheme_preset.as_str())
      .unwrap_or("simple_counter");
    debug!(scheme, "preparing document-version label");
    let date = Utc::now().date_naive();
    if request.force_requested_label || (scheme == "semver_manual" && request.event == DocumentVersionEvent::Manual) {
      let manual = manual_label(request.clone(), policy.as_ref())?;
      return Ok(PreparedDocumentVersionLabel {
        request,
        pattern: None,
        manual: Some(manual.label),
        date,
        counter_key: None,
        policy_id: manual.policy_id,
      });
    }
    let (scope, pattern) = match scheme {
      "semver_manual" => (CounterScope::EventDay, "auto-{yyyy}{mm}{dd}-{seq_event_day}"),
      "date_counter" => (CounterScope::Day, "{yyyy}-{mm}-{dd}.{seq_day}"),
      "event_counter" => (CounterScope::EventDay, "{event}-{yyyy}{mm}{dd}-{seq_event_day}"),
      "custom_pattern" => {
        let pattern = policy
          .as_ref()
          .and_then(|policy| policy.custom_pattern.as_deref())
          .unwrap_or("v{seq}");
        (counter_scope_for_pattern(pattern), pattern)
      }
      _ => (CounterScope::Global, "v{seq}"),
    };
    // Invalid patterns fail before any snapshot or counter write. A single UTC
    // date binds the counter scope and label even across a midnight boundary.
    render_pattern(pattern, &request, 1, date)?;
    Ok(PreparedDocumentVersionLabel {
      counter_key: Some(scope.key(request.event, date)),
      request,
      pattern: Some(pattern.to_string()),
      manual: None,
      date,
      policy_id: policy.as_ref().map(|policy| policy.id),
    })
  }

  pub fn preview(
    policy: &DocumentVersionPolicy,
    events: &[DocumentVersionEvent],
  ) -> Result<Vec<DocumentVersionLabelPreview>, DocumentVersionLabelError> {
    events
      .iter()
      .copied()
      .map(|event| {
        let pattern = pattern_for_policy(policy, event);
        let request = DocumentVersionLabelRequest::new(Uuid::nil(), policy.workspace_id, event);
        Ok(DocumentVersionLabelPreview {
          event,
          label: render_pattern(pattern, &request, 1, Utc::now().date_naive())?,
        })
      })
      .collect()
  }
}

fn manual_label(
  request: DocumentVersionLabelRequest,
  policy: Option<&DocumentVersionPolicy>,
) -> Result<DocumentVersionLabelOutcome, DocumentVersionLabelError> {
  let raw = request
    .requested_label
    .ok_or(DocumentVersionLabelError::ManualLabelRequired)?;
  let label = sanitize_label(&raw)?;
  Ok(DocumentVersionLabelOutcome {
    label,
    counter_key: None,
    counter_value: None,
    policy_id: policy.map(|policy| policy.id),
  })
}

fn pattern_for_policy(policy: &DocumentVersionPolicy, event: DocumentVersionEvent) -> &str {
  match policy.scheme_preset.as_str() {
    "semver_manual" if event == DocumentVersionEvent::Manual => "1.0.0",
    "semver_manual" => "auto-{yyyy}{mm}{dd}-{seq_event_day}",
    "date_counter" => "{yyyy}-{mm}-{dd}.{seq_day}",
    "event_counter" => "{event}-{yyyy}{mm}{dd}-{seq_event_day}",
    "custom_pattern" => policy.custom_pattern.as_deref().unwrap_or("v{seq}"),
    _ => "v{seq}",
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CounterScope {
  Global,
  Day,
  EventDay,
}

impl CounterScope {
  fn key(self, event: DocumentVersionEvent, today: NaiveDate) -> String {
    match self {
      Self::Global => "seq".to_string(),
      Self::Day => format!("day:{:04}-{:02}-{:02}", today.year(), today.month(), today.day()),
      Self::EventDay => format!(
        "event:{}:day:{:04}-{:02}-{:02}",
        event.as_str(),
        today.year(),
        today.month(),
        today.day()
      ),
    }
  }
}

fn counter_scope_for_pattern(pattern: &str) -> CounterScope {
  if pattern.contains("{seq_event_day}") {
    CounterScope::EventDay
  } else if pattern.contains("{seq_day}") {
    CounterScope::Day
  } else {
    CounterScope::Global
  }
}

fn render_pattern(
  pattern: &str,
  request: &DocumentVersionLabelRequest,
  seq: i64,
  today: NaiveDate,
) -> Result<String, DocumentVersionLabelError> {
  let replacements = [
    ("{seq}", seq.to_string()),
    ("{seq_day}", seq.to_string()),
    ("{seq_event_day}", seq.to_string()),
    ("{event}", request.event.as_str().replace('_', "-")),
    ("{yyyy}", format!("{:04}", today.year())),
    ("{mm}", format!("{:02}", today.month())),
    ("{dd}", format!("{:02}", today.day())),
    (
      "{date}",
      format!("{:04}{:02}{:02}", today.year(), today.month(), today.day()),
    ),
    (
      "{doc_slug}",
      request.doc_slug.clone().unwrap_or_else(|| "doc".to_string()),
    ),
    (
      "{workspace_slug}",
      request
        .workspace_slug
        .clone()
        .unwrap_or_else(|| "workspace".to_string()),
    ),
    (
      "{author}",
      request.author_slug.clone().unwrap_or_else(|| "system".to_string()),
    ),
  ];

  let mut rendered = pattern.to_string();
  for (token, replacement) in replacements {
    rendered = rendered.replace(token, &replacement);
  }
  if let Some(start) = rendered.find('{') {
    let end = rendered[start..]
      .find('}')
      .map(|offset| start + offset + 1)
      .unwrap_or(rendered.len());
    return Err(DocumentVersionLabelError::UnsupportedToken(
      rendered[start..end].to_string(),
    ));
  }
  sanitize_label(&rendered)
}

fn sanitize_label(raw: &str) -> Result<String, DocumentVersionLabelError> {
  let mut out = String::with_capacity(raw.len().min(MAX_LABEL_LEN));
  let mut last_was_separator = false;
  for ch in raw.trim().chars() {
    let mapped = if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
      ch
    } else {
      '-'
    };
    let is_separator = matches!(mapped, '.' | '_' | '-');
    if is_separator && last_was_separator {
      continue;
    }
    if out.len() >= MAX_LABEL_LEN {
      break;
    }
    out.push(mapped);
    last_was_separator = is_separator;
  }
  let label = out.trim_matches(['.', '_', '-']).to_string();
  if label.is_empty() {
    return Err(DocumentVersionLabelError::EmptyLabel);
  }
  Ok(label)
}
