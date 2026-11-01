// SPDX-License-Identifier: AGPL-3.0-or-later

use chrono::{Duration, Utc};
use uuid::Uuid;

use myoxus_application::document_metadata_policy::{DocumentMetadataAction, DocumentMetadataValidationService};
use myoxus_domain::entities::{
  DocumentMetadataFieldDefinition, DocumentMetadataIndexRow, DocumentMetadataIndexSnapshot, DocumentMetadataState,
  DocumentMetadataValidationCode, DocumentMetadataValidationSeverity,
};

fn definition(
  key: &str,
  required_mode: &str,
  export_mode: &str,
  validation_config: serde_json::Value,
) -> DocumentMetadataFieldDefinition {
  DocumentMetadataFieldDefinition {
    key: key.to_string(),
    label: key.to_string(),
    enabled: true,
    required_mode: required_mode.to_string(),
    editable_by: "editor".to_string(),
    visible_in_header: true,
    visible_in_properties: true,
    visible_in_lists: true,
    export_mode: export_mode.to_string(),
    validation_config,
    metadata: serde_json::json!({}),
    updated_by: None,
    updated_at: Utc::now(),
  }
}

fn state() -> DocumentMetadataState {
  DocumentMetadataState {
    doc_id: Uuid::new_v4(),
    status_id: None,
    type_id: None,
    current_version_id: None,
    dirty_since_current_version: false,
    version_display_mode: "show".to_string(),
    last_versioned_at: None,
    responsible_principals: serde_json::json!([]),
    review_due_at: None,
    valid_from: None,
    valid_until: None,
    classification_id: None,
    document_number: None,
    language: None,
    audience_ids: Vec::new(),
    retention_policy_id: None,
    updated_by: None,
    updated_at: Utc::now(),
    metadata: serde_json::json!({}),
  }
}

#[test]
fn document_metadata_required_always_blocks_missing_value() {
  let service = DocumentMetadataValidationService::new();
  let validation = service.validate(
    &[definition(
      "classification",
      "always",
      "optional",
      serde_json::json!({}),
    )],
    Some(&state()),
    DocumentMetadataAction::SetMetadata,
  );

  assert!(!validation.valid());
  assert_eq!(validation.missing_required_metadata_fields, vec!["classification"]);
  assert_eq!(
    validation.errors[0].code,
    DocumentMetadataValidationCode::DocumentMetadataRequired
  );
}

#[test]
fn document_metadata_required_by_status_only_applies_when_status_set() {
  let service = DocumentMetadataValidationService::new();
  let def = definition(
    "classification",
    "by_status",
    "optional",
    serde_json::json!({ "requiredWhenStatusSet": true }),
  );

  let without_status = service.validate(
    std::slice::from_ref(&def),
    Some(&state()),
    DocumentMetadataAction::TransitionStatus,
  );
  assert!(
    without_status.valid(),
    "by_status must not fire without a status context"
  );

  let mut with_status = state();
  with_status.status_id = Some(Uuid::new_v4());
  let validation = service.validate(&[def], Some(&with_status), DocumentMetadataAction::TransitionStatus);
  assert!(
    !validation.valid(),
    "by_status must fire when status context is present"
  );
}

#[test]
fn document_metadata_expired_valid_until_warns_or_blocks_by_action() {
  let service = DocumentMetadataValidationService::new();
  let mut expired = state();
  expired.valid_until = Some(Utc::now() - Duration::days(1));

  let read_validation = service.validate(&[], Some(&expired), DocumentMetadataAction::Read);
  assert!(read_validation.valid());
  assert_eq!(
    read_validation.warnings[0].severity,
    DocumentMetadataValidationSeverity::Warning
  );

  let export_validation = service.validate(&[], Some(&expired), DocumentMetadataAction::ExportPdf);
  assert!(!export_validation.valid());
  assert!(export_validation.blocked_actions.contains(&"export_pdf".to_string()));
}

#[test]
fn document_metadata_restricted_classification_blocks_public_share_only() {
  let service = DocumentMetadataValidationService::new();
  let mut restricted = state();
  restricted.metadata = serde_json::json!({ "classificationKey": "restricted" });

  let read_validation = service.validate(&[], Some(&restricted), DocumentMetadataAction::Read);
  assert!(read_validation.valid());

  let share_validation = service.validate(&[], Some(&restricted), DocumentMetadataAction::SharePublic);
  assert!(!share_validation.valid());
  assert_eq!(
    share_validation.errors[0].code,
    DocumentMetadataValidationCode::DocumentClassificationBlocksShare
  );
}

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use myoxus_application::doc::DocCachePort;
use myoxus_application::document_metadata::{DocumentMetadataProjectionMode, DocumentMetadataService};
use myoxus_application::document_metadata_policy::{
  DocumentMetadataPolicyService, DocumentStatusTransitionRequest, DocumentStatusTransitionService,
};
use myoxus_application::document_version::DocumentVersionHistoryPort;
use myoxus_domain::entities::{
  AutoVersionTrigger, DocumentMetadataFieldDefinitionPatch, DocumentMetadataJournal,
  DocumentMetadataMaterializationSummary, DocumentMetadataPatch, DocumentMetadataPolicy, DocumentMetadataProjection,
  DocumentMetadataSystemFacts, DocumentMetadataValueDefinition, DocumentOkfStatus, DocumentRuntimeOverview,
  DocumentStatusSchema, DocumentStatusTransition, DocumentStatusValue, DocumentTypeDefinition, DocumentVersion,
  DocumentVersionEvent, DocumentVersionKind, DocumentVersionPolicy, DocumentVersionRelation, DocumentWorkspaceSettings,
};
use myoxus_domain::repositories::{
  DocumentMetadataPolicyRepository, DocumentMetadataRepository, DocumentVersionRepository, RepoResult, RepositoryError,
};

struct MockAttributesRepo {
  definitions: Vec<DocumentMetadataFieldDefinition>,
  transition: Option<DocumentStatusTransition>,
  state: Mutex<Option<DocumentMetadataState>>,
  workspace_settings: Option<DocumentWorkspaceSettings>,
  status_schemas: Vec<DocumentStatusSchema>,
  status_values: Vec<DocumentStatusValue>,
  document_types: Vec<DocumentTypeDefinition>,
  value_definitions: BTreeMap<String, Vec<DocumentMetadataValueDefinition>>,
  index_snapshot_reads: AtomicUsize,
}

impl MockAttributesRepo {
  fn new(definitions: Vec<DocumentMetadataFieldDefinition>, state: Option<DocumentMetadataState>) -> Self {
    Self {
      definitions,
      transition: None,
      state: Mutex::new(state),
      workspace_settings: None,
      status_schemas: Vec::new(),
      status_values: Vec::new(),
      document_types: Vec::new(),
      value_definitions: BTreeMap::new(),
      index_snapshot_reads: AtomicUsize::new(0),
    }
  }

  fn with_transition(mut self, transition: DocumentStatusTransition) -> Self {
    self.transition = Some(transition);
    self
  }

  fn with_workspace_policy(
    mut self,
    settings: DocumentWorkspaceSettings,
    status_schemas: Vec<DocumentStatusSchema>,
    status_values: Vec<DocumentStatusValue>,
    document_types: Vec<DocumentTypeDefinition>,
    value_definitions: BTreeMap<String, Vec<DocumentMetadataValueDefinition>>,
  ) -> Self {
    self.workspace_settings = Some(settings);
    self.status_schemas = status_schemas;
    self.status_values = status_values;
    self.document_types = document_types;
    self.value_definitions = value_definitions;
    self
  }

  fn state(&self) -> Option<DocumentMetadataState> {
    self.state.lock().expect("state lock").clone()
  }
}

#[async_trait]
impl DocumentMetadataPolicyRepository for MockAttributesRepo {
  async fn list_metadata_field_definitions(&self) -> RepoResult<Vec<DocumentMetadataFieldDefinition>> {
    Ok(self.definitions.clone())
  }

  async fn get_metadata_field_definition(&self, _key: &str) -> RepoResult<Option<DocumentMetadataFieldDefinition>> {
    unimplemented!()
  }

  async fn create_metadata_field_definition(&self, _definition: &DocumentMetadataFieldDefinition) -> RepoResult<()> {
    unimplemented!()
  }

  async fn update_metadata_field_definition(
    &self,
    _key: &str,
    _patch: &DocumentMetadataFieldDefinitionPatch,
  ) -> RepoResult<DocumentMetadataFieldDefinition> {
    unimplemented!()
  }

  async fn list_metadata_value_definitions(
    &self,
    _field_key: &str,
  ) -> RepoResult<Vec<DocumentMetadataValueDefinition>> {
    Ok(self.value_definitions.get(_field_key).cloned().unwrap_or_default())
  }

  async fn create_metadata_value_definition(
    &self,
    _value: &DocumentMetadataValueDefinition,
  ) -> RepoResult<DocumentMetadataValueDefinition> {
    unimplemented!()
  }

  async fn upsert_metadata_value_definition(
    &self,
    _value: &DocumentMetadataValueDefinition,
  ) -> RepoResult<DocumentMetadataValueDefinition> {
    unimplemented!()
  }

  async fn list_status_schemas(&self) -> RepoResult<Vec<DocumentStatusSchema>> {
    Ok(self.status_schemas.clone())
  }

  async fn upsert_status_schema(&self, _schema: &DocumentStatusSchema) -> RepoResult<DocumentStatusSchema> {
    unimplemented!()
  }

  async fn list_status_values(&self, _schema_key: &str) -> RepoResult<Vec<DocumentStatusValue>> {
    Ok(self.status_values.clone())
  }

  async fn upsert_status_value(
    &self,
    _value: &DocumentStatusValue,
    _okf_status: Option<DocumentOkfStatus>,
  ) -> RepoResult<DocumentStatusValue> {
    unimplemented!()
  }

  async fn transition_exists(&self, _from_status_id: Uuid, _to_status_id: Uuid) -> RepoResult<bool> {
    Ok(self.transition.as_ref().is_some_and(|transition| {
      transition.from_status_id == _from_status_id && transition.to_status_id == _to_status_id
    }))
  }

  async fn get_transition(
    &self,
    from_status_id: Uuid,
    to_status_id: Uuid,
  ) -> RepoResult<Option<DocumentStatusTransition>> {
    Ok(
      self
        .transition
        .clone()
        .filter(|transition| transition.from_status_id == from_status_id && transition.to_status_id == to_status_id),
    )
  }

  async fn upsert_status_transition(
    &self,
    _transition: &DocumentStatusTransition,
  ) -> RepoResult<DocumentStatusTransition> {
    unimplemented!()
  }

  async fn list_document_types(&self) -> RepoResult<Vec<DocumentTypeDefinition>> {
    Ok(self.document_types.clone())
  }

  async fn upsert_document_type(&self, _doc_type: &DocumentTypeDefinition) -> RepoResult<DocumentTypeDefinition> {
    unimplemented!()
  }

  async fn get_workspace_settings(&self, _workspace_id: Uuid) -> RepoResult<Option<DocumentWorkspaceSettings>> {
    Ok(self.workspace_settings.clone())
  }

  async fn get_persisted_workspace_settings(
    &self,
    _workspace_id: Uuid,
  ) -> RepoResult<Option<DocumentWorkspaceSettings>> {
    Ok(self.workspace_settings.clone())
  }

  async fn upsert_workspace_settings(&self, _settings: &DocumentWorkspaceSettings) -> RepoResult<()> {
    unimplemented!()
  }

  async fn get_metadata_state(&self, _doc_id: Uuid) -> RepoResult<Option<DocumentMetadataState>> {
    Ok(self.state.lock().expect("state lock").clone())
  }

  async fn list_metadata_index(&self, _workspace_id: Uuid) -> RepoResult<Vec<DocumentMetadataIndexRow>> {
    Ok(
      self
        .state
        .lock()
        .expect("state lock")
        .clone()
        .map(|state| {
          vec![DocumentMetadataIndexRow {
            doc_id: state.doc_id,
            external_id: state.doc_id.to_string(),
            created_by: None,
            updated_by: None,
            journal_date: None,
            is_template: false,
            template_state: None,
            template_origin: None,
            template_category: None,
            template_tags: None,
            primary_mode: None,
            page_width: None,
            edgeless_color_theme: None,
            integration_type: None,
            status_id: state.status_id,
            document_type_id: state.type_id,
            current_version_id: state.current_version_id,
            dirty_since_current_version: state.dirty_since_current_version,
            review_due_at: state.review_due_at,
            valid_until: state.valid_until,
            classification_id: state.classification_id,
          }]
        })
        .unwrap_or_default(),
    )
  }

  async fn metadata_index_version(&self, _workspace_id: Uuid) -> RepoResult<String> {
    Ok("test-index-v2".to_string())
  }

  async fn list_metadata_index_versioned(&self, workspace_id: Uuid) -> RepoResult<DocumentMetadataIndexSnapshot> {
    self.index_snapshot_reads.fetch_add(1, Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    Ok(DocumentMetadataIndexSnapshot {
      version: "test-index-v2".to_string(),
      rows: self.list_metadata_index(workspace_id).await?,
    })
  }

  async fn metadata_index_labels(
    &self,
    _rows: &[DocumentMetadataIndexRow],
  ) -> RepoResult<std::collections::BTreeMap<Uuid, myoxus_domain::entities::DocumentMetadataIndexLabels>> {
    Ok(Default::default())
  }

  async fn document_runtime_overview(&self) -> RepoResult<DocumentRuntimeOverview> {
    Ok(DocumentRuntimeOverview {
      total_documents: 0,
      by_status: Vec::new(),
      by_document_type: Vec::new(),
      by_classification: Vec::new(),
      by_review_due: Vec::new(),
      by_version_state: Vec::new(),
    })
  }
}

#[tokio::test]
async fn document_status_transition_blocks_missing_required_attribute_without_persisting() {
  let from_status_id = Uuid::new_v4();
  let to_status_id = Uuid::new_v4();
  let mut initial = state();
  initial.status_id = Some(from_status_id);
  initial.classification_id = None;
  let repo = Arc::new(
    MockAttributesRepo::new(
      vec![definition("classification", "never", "optional", serde_json::json!({}))],
      Some(initial.clone()),
    )
    .with_transition(DocumentStatusTransition {
      from_status_id,
      to_status_id,
      required_metadata_fields: vec!["classification".to_string()],
      required_roles: Vec::new(),
      creates_version: "never".to_string(),
      sets_version_kind: None,
      date_enforcement: "warn".to_string(),
      metadata: serde_json::json!({}),
    }),
  );
  let metadata_repo = Arc::new(MockMetadataRepo::default());
  let service = DocumentStatusTransitionService::new(repo.clone(), DocumentMetadataService::new(metadata_repo));

  let validation = service
    .transition(initial.doc_id, from_status_id, to_status_id, Some(Uuid::new_v4()))
    .await
    .expect("transition returns validation result");

  assert!(!validation.valid());
  assert_eq!(repo.state().expect("state").status_id, Some(from_status_id));
}

#[tokio::test]
async fn document_status_transition_requires_declared_role_without_persisting() {
  let from_status_id = Uuid::new_v4();
  let to_status_id = Uuid::new_v4();
  let mut initial = state();
  initial.status_id = Some(from_status_id);
  let repo = Arc::new(
    MockAttributesRepo::new(Vec::new(), Some(initial.clone())).with_transition(DocumentStatusTransition {
      from_status_id,
      to_status_id,
      required_metadata_fields: Vec::new(),
      required_roles: vec!["quality_admin".to_string()],
      creates_version: "never".to_string(),
      sets_version_kind: None,
      date_enforcement: "warn".to_string(),
      metadata: serde_json::json!({}),
    }),
  );
  let metadata_repo = Arc::new(MockMetadataRepo::default());
  let service = DocumentStatusTransitionService::new(repo.clone(), DocumentMetadataService::new(metadata_repo));

  let validation = service
    .transition_with_roles(initial.doc_id, from_status_id, to_status_id, Some(Uuid::new_v4()), &[])
    .await
    .expect("transition returns validation result");

  assert!(!validation.valid());
  assert_eq!(
    validation.errors[0].code,
    DocumentMetadataValidationCode::DocumentMetadataForbidden
  );
  assert_eq!(repo.state().expect("state").status_id, Some(from_status_id));
}

fn workspace_settings(
  workspace_id: Uuid,
  status_schema_id: Uuid,
  default_document_type_id: Uuid,
  default_classification_id: Uuid,
) -> DocumentWorkspaceSettings {
  DocumentWorkspaceSettings {
    workspace_id,
    status_schema_id: Some(status_schema_id),
    default_status_id: None,
    version_policy_id: None,
    default_document_type_id: Some(default_document_type_id),
    default_classification_id: Some(default_classification_id),
    default_retention_policy_id: None,
    updated_by: None,
    updated_at: Utc::now(),
  }
}

fn status_schema(id: Uuid, key: &str) -> DocumentStatusSchema {
  DocumentStatusSchema {
    id,
    key: key.to_string(),
    label: key.to_string(),
    description: None,
    complexity: "simple".to_string(),
    is_preset: true,
    is_active: true,
    metadata: serde_json::json!({}),
  }
}

fn status_value(id: Uuid, schema_id: Uuid, key: &str, sort_order: i32) -> DocumentStatusValue {
  DocumentStatusValue {
    id,
    schema_id,
    key: key.to_string(),
    label: key.to_string(),
    description: None,
    color: None,
    icon: None,
    sort_order,
    terminal: false,
    is_active: true,
    okf_status: DocumentOkfStatus::Draft,
    metadata: serde_json::json!({}),
  }
}

fn document_type(id: Uuid) -> DocumentTypeDefinition {
  DocumentTypeDefinition {
    id,
    key: "policy".to_string(),
    label: "Policy".to_string(),
    description: None,
    icon: None,
    color: None,
    is_active: true,
    is_suggested: true,
  }
}

fn value_definition(id: Uuid, field_key: &str, key: &str) -> DocumentMetadataValueDefinition {
  DocumentMetadataValueDefinition {
    id,
    field_key: field_key.to_string(),
    key: key.to_string(),
    label: key.to_string(),
    description: None,
    color: None,
    icon: None,
    sort_order: 0,
    is_active: true,
    metadata: serde_json::json!({}),
  }
}

#[tokio::test]
async fn document_metadata_policy_service_applies_typed_workspace_defaults_without_json_overrides() {
  let workspace_id = Uuid::new_v4();
  let schema_id = Uuid::new_v4();
  let draft_status_id = Uuid::new_v4();
  let type_id = Uuid::new_v4();
  let classification_id = Uuid::new_v4();
  let mut classification_definition = definition("classification", "never", "optional", serde_json::json!({}));
  classification_definition.metadata = serde_json::json!({ "allowWorkspaceOverride": true });
  let status_definition = definition("status", "never", "optional", serde_json::json!({}));
  let mut value_definitions = BTreeMap::new();
  value_definitions.insert(
    "classification".to_string(),
    vec![value_definition(classification_id, "classification", "restricted")],
  );
  let repo = Arc::new(
    MockAttributesRepo::new(vec![classification_definition, status_definition], None).with_workspace_policy(
      workspace_settings(workspace_id, schema_id, type_id, classification_id),
      vec![status_schema(schema_id, "controlled")],
      vec![
        status_value(draft_status_id, schema_id, "draft", 10),
        status_value(Uuid::new_v4(), schema_id, "released", 20),
      ],
      vec![document_type(type_id)],
      value_definitions,
    ),
  );
  let service = DocumentMetadataPolicyService::new(repo);

  let policy = service
    .load_policy(Uuid::new_v4(), workspace_id)
    .await
    .expect("policy loads");

  let classification = policy
    .definitions
    .iter()
    .find(|definition| definition.key == "classification")
    .expect("classification definition");
  let status = policy
    .definitions
    .iter()
    .find(|definition| definition.key == "status")
    .expect("status definition");
  let state = policy.state.expect("defaulted state");

  assert_eq!(
    classification.required_mode, "never",
    "workspace JSON overrides were removed; field policy now comes from the typed admin policy layer"
  );
  assert_eq!(classification.export_mode, "optional");
  assert_eq!(
    status.required_mode, "never",
    "workspace settings must not mutate admin-owned field definitions"
  );
  assert_eq!(state.type_id, Some(type_id));
  assert_eq!(state.classification_id, Some(classification_id));
  assert_eq!(state.status_id, Some(draft_status_id));
  assert_eq!(policy.status_values.len(), 2);
  assert_eq!(policy.value_definitions["classification"].len(), 1);
}

#[tokio::test]
async fn document_metadata_index_coalesces_a_cold_wave_and_is_shared_between_services() {
  let workspace_id = Uuid::new_v4();
  let expected_doc_id = Uuid::new_v4();
  let mut indexed_state = state();
  indexed_state.doc_id = expected_doc_id;
  let repo = Arc::new(MockAttributesRepo::new(Vec::new(), Some(indexed_state)));
  let cache = Arc::new(ProjectionCache {
    values: Mutex::new(HashMap::new()),
    index_values: Mutex::new(HashMap::new()),
    version_changes: AtomicUsize::new(0),
  });
  let service = DocumentMetadataPolicyService::new(repo.clone()).with_index_cache(cache.clone());
  let barrier = Arc::new(tokio::sync::Barrier::new(24));
  let mut tasks = Vec::new();
  for _ in 0..24 {
    let service = service.clone();
    let barrier = barrier.clone();
    tasks.push(tokio::spawn(async move {
      barrier.wait().await;
      service.list_metadata_index(workspace_id).await
    }));
  }
  for task in tasks {
    let rows = task.await.expect("index task joins").expect("index loads");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].doc_id, expected_doc_id);
  }
  assert_eq!(
    repo.index_snapshot_reads.load(Ordering::SeqCst),
    1,
    "one application instance must coalesce a cold same-version wave"
  );

  let second_service = DocumentMetadataPolicyService::new(repo.clone()).with_index_cache(cache);
  let rows = second_service
    .list_metadata_index(workspace_id)
    .await
    .expect("shared cached index loads");
  assert_eq!(rows[0].doc_id, expected_doc_id);
  assert_eq!(
    repo.index_snapshot_reads.load(Ordering::SeqCst),
    1,
    "a second application instance must reuse the shared versioned value"
  );
}

#[derive(Default)]
struct MockHistoryPort {
  captured: Mutex<Vec<DocumentVersion>>,
}

#[async_trait]
impl DocumentVersionHistoryPort for MockHistoryPort {
  async fn capture_named(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    request: myoxus_application::doc::history::NamedHistoryCapture,
  ) -> Result<Option<DocumentVersion>, myoxus_application::doc::history::HistoryCaptureError> {
    let label = request.label.render(Some(1))?;
    let version = DocumentVersion::new_for_create(myoxus_domain::entities::DocumentVersionCreateInput {
      id: Uuid::new_v4(),
      doc_id,
      workspace_id,
      doc_history_id: 777,
      label: label.label,
      description: request.description,
      event: request.event,
      kind: request.kind,
      created_by: request.actor_id,
      created_at: Utc::now(),
      is_pinned: false,
      is_protected: false,
      policy_id: label.policy_id,
      policy_snapshot: serde_json::json!({}),
      content_hash: None,
      metadata: serde_json::json!({}),
    });
    self.captured.lock().expect("captured lock").push(version.clone());
    Ok(Some(version))
  }
  async fn restore_history(
    &self,
    _: myoxus_application::doc::history::HistoryRestoreRequest,
  ) -> Result<
    myoxus_application::doc::history::HistoryRestoreCommit,
    myoxus_application::doc::history::HistoryCaptureError,
  > {
    panic!("status capture must never restore content");
  }
}

#[derive(Default)]
struct MockMetadataRepo {
  marked: Mutex<Vec<(Uuid, Uuid, Uuid)>>,
  transitioned: Mutex<Vec<(Uuid, Uuid, Uuid)>>,
}

#[async_trait]
impl DocumentMetadataRepository for MockMetadataRepo {
  async fn workspace_id_for_document(&self, _doc_id: Uuid) -> RepoResult<Option<Uuid>> {
    unimplemented!()
  }

  async fn get_projection(&self, _doc_id: Uuid, _workspace_id: Uuid) -> RepoResult<Option<DocumentMetadataProjection>> {
    unimplemented!()
  }

  async fn get_projection_versioned(
    &self,
    _doc_id: Uuid,
    _workspace_id: Uuid,
  ) -> RepoResult<Option<(String, DocumentMetadataProjection)>> {
    unimplemented!()
  }

  async fn projection_version(&self, _doc_id: Uuid, _workspace_id: Uuid) -> RepoResult<Option<String>> {
    unimplemented!()
  }

  async fn apply_patch(&self, _doc_id: Uuid, _actor_id: Uuid, _patch: &DocumentMetadataPatch) -> RepoResult<()> {
    unimplemented!()
  }

  async fn rematerialize_workspace_defaults(
    &self,
    _workspace_id: Uuid,
    _actor_id: Option<Uuid>,
  ) -> RepoResult<DocumentMetadataMaterializationSummary> {
    unimplemented!()
  }

  async fn mark_current_version(
    &self,
    doc_id: Uuid,
    version_id: Uuid,
    _versioned_at: chrono::DateTime<Utc>,
    actor_id: Uuid,
  ) -> RepoResult<()> {
    self
      .marked
      .lock()
      .expect("metadata marked lock")
      .push((doc_id, version_id, actor_id));
    Ok(())
  }

  async fn transition_status(&self, doc_id: Uuid, status_id: Uuid, actor_id: Uuid) -> RepoResult<()> {
    self
      .transitioned
      .lock()
      .expect("metadata transitioned lock")
      .push((doc_id, status_id, actor_id));
    Ok(())
  }
}

struct MockVersionRepo {
  next: Mutex<i64>,
  created: Mutex<Vec<DocumentVersion>>,
  policy: DocumentVersionPolicy,
}

impl MockVersionRepo {
  fn new() -> Self {
    Self {
      next: Mutex::new(1),
      created: Mutex::new(Vec::new()),
      policy: DocumentVersionPolicy {
        id: Uuid::new_v4(),
        scope: "global".to_string(),
        workspace_id: None,
        name: "Transition policy".to_string(),
        is_default: true,
        enabled_by_default: true,
        scheme_preset: "simple_counter".to_string(),
        custom_pattern: None,
        timezone_mode: "utc".to_string(),
        auto_version_on: vec![AutoVersionTrigger::OnPublish],
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
      },
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

  async fn create(&self, version: &DocumentVersion) -> RepoResult<()> {
    self.created.lock().expect("created lock").push(version.clone());
    Ok(())
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

#[tokio::test]
async fn document_status_transition_requires_atomic_capture_with_its_configured_kind() {
  let from_status_id = Uuid::new_v4();
  let to_status_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let actor_id = Uuid::new_v4();
  let mut initial = state();
  initial.status_id = Some(from_status_id);
  let attr_repo = Arc::new(
    MockAttributesRepo::new(Vec::new(), Some(initial.clone())).with_transition(DocumentStatusTransition {
      from_status_id,
      to_status_id,
      required_metadata_fields: Vec::new(),
      required_roles: Vec::new(),
      creates_version: "required".to_string(),
      sets_version_kind: Some(DocumentVersionKind::Milestone),
      date_enforcement: "warn".to_string(),
      metadata: serde_json::json!({}),
    }),
  );
  let history = Arc::new(MockHistoryPort::default());
  let version_repo = Arc::new(MockVersionRepo::new());
  let metadata_repo = Arc::new(MockMetadataRepo::default());
  let metadata_service = DocumentMetadataService::new(metadata_repo.clone());
  let service = DocumentStatusTransitionService::with_versioning(
    attr_repo.clone(),
    history.clone(),
    version_repo.clone(),
    metadata_service,
  );

  let validation = service
    .transition_with_request(DocumentStatusTransitionRequest {
      doc_id: initial.doc_id,
      workspace_id,
      from_status_id,
      to_status_id,
      actor_id: Some(actor_id),
      actor_roles: Vec::new(),
      create_version: false,
    })
    .await
    .expect("transition succeeds");

  assert!(validation.valid());
  let state = attr_repo.state().expect("updated state");
  let created = history.captured.lock().expect("captured lock");
  assert_eq!(created.len(), 1);
  assert_eq!(created[0].doc_history_id, 777);
  assert_eq!(created[0].event, DocumentVersionEvent::Manual);
  assert_eq!(created[0].kind, DocumentVersionKind::Milestone);
  assert_eq!(
    *metadata_repo.transitioned.lock().expect("metadata transitioned lock"),
    vec![(initial.doc_id, to_status_id, actor_id)],
    "status transition must update the native document metadata head"
  );
  assert_eq!(
    state.status_id,
    Some(from_status_id),
    "status transition must not persist status through DocumentMetadataState"
  );
  assert!(
    metadata_repo.marked.lock().expect("metadata marked lock").is_empty(),
    "the capture transaction owns the version head; the status caller must not repeat that write"
  );
  assert_eq!(
    state.current_version_id, initial.current_version_id,
    "status transition state upsert must not author the version head through DocumentMetadataState"
  );
  assert_eq!(created[0].doc_id, initial.doc_id);
  assert_eq!(created[0].workspace_id, workspace_id);
  assert_eq!(created[0].created_by, actor_id);
}

struct RacingProjectionRepo {
  version_reads: AtomicUsize,
  projection_reads: AtomicUsize,
  fail_projection_reads: AtomicUsize,
  racing_version: bool,
  current: DocumentMetadataProjection,
}

#[async_trait]
impl DocumentMetadataRepository for RacingProjectionRepo {
  async fn workspace_id_for_document(&self, _doc_id: Uuid) -> RepoResult<Option<Uuid>> {
    unimplemented!()
  }

  async fn get_projection(&self, _doc_id: Uuid, _workspace_id: Uuid) -> RepoResult<Option<DocumentMetadataProjection>> {
    Ok(Some(self.current.clone()))
  }

  async fn get_projection_versioned(
    &self,
    _doc_id: Uuid,
    _workspace_id: Uuid,
  ) -> RepoResult<Option<(String, DocumentMetadataProjection)>> {
    self.projection_reads.fetch_add(1, Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    if self
      .fail_projection_reads
      .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| remaining.checked_sub(1))
      .is_ok()
    {
      return Err(RepositoryError::Storage("controlled projection failure".to_string()));
    }
    Ok(Some(("v2".to_string(), self.current.clone())))
  }

  async fn projection_version(&self, _doc_id: Uuid, _workspace_id: Uuid) -> RepoResult<Option<String>> {
    let read = self.version_reads.fetch_add(1, Ordering::SeqCst);
    Ok(Some(
      if self.racing_version && read == 0 { "v1" } else { "v2" }.to_string(),
    ))
  }

  async fn apply_patch(&self, _doc_id: Uuid, _actor_id: Uuid, _patch: &DocumentMetadataPatch) -> RepoResult<()> {
    Ok(())
  }

  async fn rematerialize_workspace_defaults(
    &self,
    _workspace_id: Uuid,
    _actor_id: Option<Uuid>,
  ) -> RepoResult<DocumentMetadataMaterializationSummary> {
    unimplemented!()
  }

  async fn mark_current_version(
    &self,
    _doc_id: Uuid,
    _version_id: Uuid,
    _versioned_at: chrono::DateTime<Utc>,
    _actor_id: Uuid,
  ) -> RepoResult<()> {
    Ok(())
  }

  async fn transition_status(&self, _doc_id: Uuid, _status_id: Uuid, _actor_id: Uuid) -> RepoResult<()> {
    Ok(())
  }
}

struct ProjectionCache {
  values: Mutex<HashMap<String, DocumentMetadataProjection>>,
  index_values: Mutex<HashMap<String, Vec<DocumentMetadataIndexRow>>>,
  version_changes: AtomicUsize,
}

#[async_trait]
impl DocCachePort for ProjectionCache {
  async fn get_snapshot(&self, _ws: Uuid, _doc: Uuid) -> Option<Vec<u8>> {
    None
  }
  async fn set_snapshot(&self, _ws: Uuid, _doc: Uuid, _payload: &[u8]) {}
  async fn invalidate_snapshot(&self, _ws: Uuid, _doc: Uuid) {}
  async fn get_metadata(&self, _doc: Uuid) -> Option<serde_json::Value> {
    None
  }
  async fn set_metadata(&self, _doc: Uuid, _meta: &serde_json::Value) {}
  async fn invalidate_metadata(&self, _doc: Uuid) {}
  async fn get_metadata_projection(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _projection_mode: &str,
    projection_version: &str,
  ) -> Option<DocumentMetadataProjection> {
    self
      .values
      .lock()
      .expect("projection cache lock")
      .get(projection_version)
      .cloned()
  }
  async fn set_metadata_projection(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _projection_mode: &str,
    projection_version: &str,
    projection: &DocumentMetadataProjection,
  ) {
    self
      .values
      .lock()
      .expect("projection cache lock")
      .insert(projection_version.to_string(), projection.clone());
  }
  async fn record_metadata_projection_version_change(&self) {
    self.version_changes.fetch_add(1, Ordering::SeqCst);
  }
  async fn invalidate_metadata_projection(&self, _workspace_id: Uuid, _doc_id: Uuid) {
    panic!("ordinary versioned projection mutations must not scan Redis")
  }
  async fn get_document_metadata_index(
    &self,
    _workspace_id: Uuid,
    version: &str,
  ) -> Option<Vec<DocumentMetadataIndexRow>> {
    self
      .index_values
      .lock()
      .expect("index cache lock")
      .get(version)
      .cloned()
  }
  async fn set_document_metadata_index(&self, _workspace_id: Uuid, version: &str, rows: &[DocumentMetadataIndexRow]) {
    self
      .index_values
      .lock()
      .expect("index cache lock")
      .insert(version.to_string(), rows.to_vec());
  }
  async fn check_and_set_view_dedup(&self, _user: Uuid, _ws: Uuid, _doc: &str, _date: chrono::NaiveDate) -> bool {
    true
  }
  async fn acquire_compaction_lock(&self, _doc: Uuid, _instance_id: Uuid) -> bool {
    true
  }
  async fn release_compaction_lock(&self, _doc: Uuid) {}
  async fn get_timestamps(&self, _ws: Uuid) -> Option<HashMap<String, i64>> {
    None
  }
  async fn set_timestamps(&self, _ws: Uuid, _timestamps: &HashMap<String, i64>) {}
  async fn invalidate_timestamps(&self, _ws: Uuid) {}
}

fn projection_for_race(doc_id: Uuid, workspace_id: Uuid, revision: i64) -> DocumentMetadataProjection {
  let now = Utc::now();
  DocumentMetadataProjection {
    doc_id,
    workspace_id,
    projection_version: String::new(),
    metadata_revision: revision,
    metadata_updated_at: Some(now),
    metadata_updated_by: None,
    system: DocumentMetadataSystemFacts {
      created_at: now,
      updated_at: now,
      created_by: None,
      updated_by: None,
      metadata_updated_at: Some(now),
      metadata_updated_by: None,
    },
    fields: Vec::new(),
    audience: Vec::new(),
    template: None,
    journal: DocumentMetadataJournal { journal_date: None },
    presentation: None,
    integration: None,
    policy: DocumentMetadataPolicy::default(),
  }
}

#[tokio::test]
async fn document_metadata_projection_rechecks_a_racing_cache_hit() {
  let doc_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let old = projection_for_race(doc_id, workspace_id, 1);
  let current = projection_for_race(doc_id, workspace_id, 2);
  let repo = Arc::new(RacingProjectionRepo {
    version_reads: AtomicUsize::new(0),
    projection_reads: AtomicUsize::new(0),
    fail_projection_reads: AtomicUsize::new(0),
    racing_version: true,
    current: current.clone(),
  });
  let cache = Arc::new(ProjectionCache {
    values: Mutex::new(HashMap::from([("v1".to_string(), old)])),
    index_values: Mutex::new(HashMap::new()),
    version_changes: AtomicUsize::new(0),
  });
  let service = DocumentMetadataService::new(repo).with_projection_cache(cache.clone());

  let returned = service
    .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
    .await
    .expect("racing projection read succeeds");

  assert_eq!(returned.metadata_revision, 2, "the stale v1 hit must not escape");
  assert_eq!(returned.projection_version, "v2");
  assert_eq!(
    cache.version_changes.load(Ordering::SeqCst),
    1,
    "the observed freshness race must not be recorded as an expiry miss"
  );
  assert_eq!(
    cache
      .values
      .lock()
      .expect("projection cache lock")
      .get("v2")
      .map(|projection| projection.metadata_revision),
    Some(2),
    "only the projection read with v2 may populate the current key"
  );
}

#[tokio::test]
async fn document_metadata_mutations_do_not_scan_versioned_projection_keys() {
  let doc_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let current = projection_for_race(doc_id, workspace_id, 2);
  let repo = Arc::new(RacingProjectionRepo {
    version_reads: AtomicUsize::new(0),
    projection_reads: AtomicUsize::new(0),
    fail_projection_reads: AtomicUsize::new(0),
    racing_version: false,
    current,
  });
  let cache = Arc::new(ProjectionCache {
    values: Mutex::new(HashMap::new()),
    index_values: Mutex::new(HashMap::new()),
    version_changes: AtomicUsize::new(0),
  });
  let service = DocumentMetadataService::new(repo).with_projection_cache(cache);
  let actor_id = Uuid::new_v4();

  service
    .set_metadata(doc_id, actor_id, DocumentMetadataPatch::default())
    .await
    .expect("metadata mutation succeeds without a projection scan");
  service
    .mark_current_version(doc_id, Uuid::new_v4(), Utc::now(), actor_id)
    .await
    .expect("version-head mutation succeeds without a projection scan");
  service
    .transition_status(doc_id, Uuid::new_v4(), actor_id)
    .await
    .expect("status mutation succeeds without a projection scan");
}

#[tokio::test]
async fn document_metadata_projection_coalesces_one_successful_load_per_version() {
  let doc_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let repo = Arc::new(RacingProjectionRepo {
    version_reads: AtomicUsize::new(0),
    projection_reads: AtomicUsize::new(0),
    fail_projection_reads: AtomicUsize::new(0),
    racing_version: false,
    current: projection_for_race(doc_id, workspace_id, 2),
  });
  let cache = Arc::new(ProjectionCache {
    values: Mutex::new(HashMap::new()),
    index_values: Mutex::new(HashMap::new()),
    version_changes: AtomicUsize::new(0),
  });
  let service = DocumentMetadataService::new(repo.clone()).with_projection_cache(cache.clone());
  let barrier = Arc::new(tokio::sync::Barrier::new(32));
  let mut tasks = Vec::new();
  for _ in 0..32 {
    let service = service.clone();
    let barrier = barrier.clone();
    tasks.push(tokio::spawn(async move {
      barrier.wait().await;
      service
        .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
        .await
    }));
  }
  for task in tasks {
    assert_eq!(
      task
        .await
        .expect("projection task joins")
        .expect("projection loads")
        .metadata_revision,
      2
    );
  }
  assert_eq!(
    repo.projection_reads.load(Ordering::SeqCst),
    1,
    "a cold successful wave must execute one backing projection load"
  );
  let second_instance = DocumentMetadataService::new(repo.clone()).with_projection_cache(cache);
  assert_eq!(
    second_instance
      .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
      .await
      .expect("shared warm projection loads")
      .metadata_revision,
    2
  );
  assert_eq!(
    repo.projection_reads.load(Ordering::SeqCst),
    1,
    "a shared warm cache must avoid another backing projection load"
  );
  assert!(
    repo.version_reads.load(Ordering::SeqCst) >= 64,
    "version/freshness reads remain separate from the coalesced projection load"
  );
}

#[tokio::test]
async fn document_metadata_projection_failure_is_released_for_retry() {
  let doc_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let repo = Arc::new(RacingProjectionRepo {
    version_reads: AtomicUsize::new(0),
    projection_reads: AtomicUsize::new(0),
    fail_projection_reads: AtomicUsize::new(1),
    racing_version: false,
    current: projection_for_race(doc_id, workspace_id, 2),
  });
  let service = DocumentMetadataService::new(repo.clone());

  assert!(
    service
      .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
      .await
      .is_err()
  );
  assert!(
    service
      .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
      .await
      .is_ok()
  );
  assert_eq!(repo.projection_reads.load(Ordering::SeqCst), 2);
}

#[test]
fn native_metadata_policy_service_does_not_recreate_document_metadata_aggregate_guard() {
  let application_source = include_str!("../src/document_metadata_policy/mod.rs");
  let domain_source = include_str!("../../domain/src/entities.rs");

  assert!(
    !application_source.contains("load_effective("),
    "policy code must not rebuild the retired DocumentAttributes aggregate"
  );
  assert!(
    !domain_source.contains("pub struct DocumentAttributes"),
    "domain must not expose the retired Myoxus-internal DocumentAttributes aggregate"
  );
  assert!(
    !application_source.contains("SetAttributes"),
    "native metadata validation must use SetMetadata, not the retired SetAttributes action"
  );
}
