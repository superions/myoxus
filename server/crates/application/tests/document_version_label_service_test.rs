// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use uuid::Uuid;

use myoxus_application::document_version::{DocumentVersionLabelRequest, DocumentVersionLabelService};
use myoxus_domain::entities::{
  AutoVersionTrigger, DocumentVersion, DocumentVersionEvent, DocumentVersionPolicy, DocumentVersionRelation,
};
use myoxus_domain::repositories::{DocumentVersionRepository, RepoResult};

struct MockVersionRepo {
  next: Mutex<i64>,
  policy: DocumentVersionPolicy,
}

impl MockVersionRepo {
  fn new(policy: DocumentVersionPolicy) -> Self {
    Self {
      next: Mutex::new(1),
      policy,
    }
  }
}

#[async_trait]
impl DocumentVersionRepository for MockVersionRepo {
  async fn list_for_doc(&self, _doc_id: Uuid) -> RepoResult<Vec<DocumentVersion>> {
    unimplemented!()
  }

  async fn get(&self, _id: Uuid) -> RepoResult<Option<DocumentVersion>> {
    unimplemented!()
  }

  async fn latest_snapshot_for_doc(&self, _doc_id: Uuid) -> RepoResult<Option<Vec<u8>>> {
    unimplemented!()
  }

  async fn snapshot_for_version(&self, _id: Uuid) -> RepoResult<Option<(DocumentVersion, Vec<u8>)>> {
    unimplemented!()
  }

  async fn create(&self, _version: &DocumentVersion) -> RepoResult<()> {
    unimplemented!()
  }

  async fn create_relation(&self, _relation: &DocumentVersionRelation) -> RepoResult<()> {
    unimplemented!()
  }

  async fn list_relations_for_version(&self, _version_id: Uuid) -> RepoResult<Vec<DocumentVersionRelation>> {
    unimplemented!()
  }

  async fn next_counter_value(&self, _doc_id: Uuid, _counter_key: &str) -> RepoResult<i64> {
    let mut guard = self.next.lock().expect("counter lock");
    let current = *guard;
    *guard += 1;
    Ok(current)
  }

  async fn default_policy(&self, _workspace_id: Option<Uuid>) -> RepoResult<Option<DocumentVersionPolicy>> {
    Ok(Some(self.policy.clone()))
  }

  async fn list_policies(&self) -> RepoResult<Vec<DocumentVersionPolicy>> {
    unimplemented!()
  }

  async fn upsert_policy(&self, _policy: &DocumentVersionPolicy) -> RepoResult<DocumentVersionPolicy> {
    unimplemented!()
  }

  async fn pin(&self, _id: Uuid) -> RepoResult<()> {
    unimplemented!()
  }

  async fn unpin(&self, _id: Uuid) -> RepoResult<()> {
    unimplemented!()
  }

  async fn update_metadata(&self, _id: Uuid, _label: &str, _description: Option<&str>) -> RepoResult<()> {
    unimplemented!()
  }

  async fn delete(&self, _id: Uuid) -> RepoResult<()> {
    unimplemented!()
  }

  async fn gc_unpinned_older_than_count(
    &self,
    _doc_id: Uuid,
    _retention_count: i32,
  ) -> RepoResult<Vec<DocumentVersion>> {
    unimplemented!()
  }
}

fn policy(scheme_preset: &str) -> DocumentVersionPolicy {
  DocumentVersionPolicy {
    id: Uuid::new_v4(),
    scope: "global".to_string(),
    workspace_id: None,
    name: "Test policy".to_string(),
    is_default: true,
    enabled_by_default: true,
    scheme_preset: scheme_preset.to_string(),
    custom_pattern: None,
    timezone_mode: "utc".to_string(),
    auto_version_on: vec![AutoVersionTrigger::OnPdfExport],
    retention_count: 10,
    pin_manual_versions: false,
    pin_publish_versions: true,
    published_versions_protected: true,
    export_versions_protected: false,
    metadata_schema: serde_json::json!({}),
    created_by: None,
    created_at: Utc::now(),
    updated_by: None,
    updated_at: Utc::now(),
  }
}

fn custom_policy(pattern: &str) -> DocumentVersionPolicy {
  let mut policy = policy("custom_pattern");
  policy.custom_pattern = Some(pattern.to_string());
  policy
}

#[tokio::test]
async fn document_version_label_service_allocates_unique_counter_labels() {
  let repo = Arc::new(MockVersionRepo::new(policy("simple_counter")));
  let service = DocumentVersionLabelService::new(repo);
  let doc_id = Uuid::new_v4();
  let request = DocumentVersionLabelRequest {
    doc_id,
    workspace_id: None,
    event: DocumentVersionEvent::Manual,
    requested_label: None,
    force_requested_label: false,
    doc_slug: None,
    workspace_slug: None,
    author_slug: None,
  };

  let (first, second) = tokio::join!(service.next_label(request.clone()), service.next_label(request));
  let first = first.expect("first label");
  let second = second.expect("second label");

  assert_ne!(first.label, second.label);
  assert_eq!(first.label, "v1");
  assert_eq!(second.label, "v2");
}

#[tokio::test]
async fn document_version_label_service_uses_manual_label_for_semver_policy() {
  let repo = Arc::new(MockVersionRepo::new(policy("semver_manual")));
  let service = DocumentVersionLabelService::new(repo);
  let label = service
    .next_label(DocumentVersionLabelRequest {
      doc_id: Uuid::new_v4(),
      workspace_id: None,
      event: DocumentVersionEvent::Manual,
      requested_label: Some("  v1.2.3  ".to_string()),
      force_requested_label: false,
      doc_slug: None,
      workspace_slug: None,
      author_slug: None,
    })
    .await
    .expect("manual label");

  assert_eq!(label.label, "v1.2.3");
  assert_eq!(label.counter_key, None);
}

#[tokio::test]
async fn document_version_label_service_can_force_requested_restore_label() {
  let repo = Arc::new(MockVersionRepo::new(policy("simple_counter")));
  let service = DocumentVersionLabelService::new(repo);
  let label = service
    .next_label(DocumentVersionLabelRequest {
      doc_id: Uuid::new_v4(),
      workspace_id: None,
      event: DocumentVersionEvent::Restore,
      requested_label: Some(" restore from source ".to_string()),
      force_requested_label: true,
      doc_slug: None,
      workspace_slug: None,
      author_slug: None,
    })
    .await
    .expect("forced restore label");

  assert_eq!(label.label, "restore-from-source");
  assert_eq!(label.counter_key, None);
}

#[tokio::test]
async fn document_version_label_service_uses_event_day_counter_for_auto_semver_fallback() {
  let repo = Arc::new(MockVersionRepo::new(policy("semver_manual")));
  let service = DocumentVersionLabelService::new(repo);
  let label = service
    .next_label(DocumentVersionLabelRequest {
      doc_id: Uuid::new_v4(),
      workspace_id: None,
      event: DocumentVersionEvent::PdfExport,
      requested_label: None,
      force_requested_label: false,
      doc_slug: None,
      workspace_slug: None,
      author_slug: None,
    })
    .await
    .expect("auto fallback label");

  assert!(label.label.starts_with("auto-"));
  assert!(
    label
      .counter_key
      .expect("counter key")
      .starts_with("event:pdf_export:day:")
  );
}

#[tokio::test]
async fn document_version_label_service_supports_custom_pattern_tokens() {
  let repo = Arc::new(MockVersionRepo::new(custom_policy(
    "{workspace_slug}-{doc_slug}-{author}-{event}-{seq_event_day}",
  )));
  let service = DocumentVersionLabelService::new(repo);
  let label = service
    .next_label(DocumentVersionLabelRequest {
      doc_id: Uuid::new_v4(),
      workspace_id: Some(Uuid::new_v4()),
      event: DocumentVersionEvent::Restore,
      requested_label: None,
      force_requested_label: false,
      doc_slug: Some("Quality Plan".to_string()),
      workspace_slug: Some("Main WS".to_string()),
      author_slug: Some("Ada Lovelace".to_string()),
    })
    .await
    .expect("custom label");

  assert_eq!(label.label, "Main-WS-Quality-Plan-Ada-Lovelace-restore-1");
  assert!(
    label
      .counter_key
      .expect("counter key")
      .starts_with("event:restore:day:")
  );
}

#[tokio::test]
async fn document_version_label_service_rejects_unsupported_custom_token() {
  let repo = Arc::new(MockVersionRepo::new(custom_policy("{doc_slug}-{unknown}-{seq}")));
  let service = DocumentVersionLabelService::new(repo);
  let err = service
    .next_label(DocumentVersionLabelRequest {
      doc_id: Uuid::new_v4(),
      workspace_id: None,
      event: DocumentVersionEvent::Manual,
      requested_label: None,
      force_requested_label: false,
      doc_slug: Some("doc".to_string()),
      workspace_slug: None,
      author_slug: None,
    })
    .await
    .expect_err("unsupported token must fail");

  assert!(err.to_string().contains("{unknown}"));
}
