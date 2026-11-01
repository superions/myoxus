// SPDX-License-Identifier: AGPL-3.0-or-later
//! Initial document sync provenance.
//!
//! First sync is the only point where a client may provide historical create
//! timestamps. After a `docs` row exists, system facts remain server-owned.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InitialDocumentProvenanceMode {
  OfflineSync,
  ExplicitImport,
}

/// Server-owned classification of the first durable document observation.
///
/// `ServerObservedFirstSync` is deliberately absent from the client request
/// enum: a client cannot assert that the server observed a document for the
/// first time. `OfflineSync` is retained only when the transport capability,
/// stable client instance and persisted creation time prove that origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolvedInitialDocumentProvenanceMode {
  ServerObservedFirstSync,
  OfflineSync,
  ExplicitImport,
}

/// Server-owned invocation boundary for provenance resolution.
///
/// This is not a wire value. In particular, a client-provided
/// `provenanceMode=explicit_import` cannot turn a sync request into a trusted
/// import operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitialDocumentProvenanceSource {
  ClientSync,
  TrustedImport,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialDocumentProvenance {
  pub idempotency_key: Option<String>,
  pub client_family: Option<String>,
  pub client_version: Option<String>,
  pub client_instance_id: Option<String>,
  #[serde(default = "default_provenance_mode")]
  pub provenance_mode: InitialDocumentProvenanceMode,
  pub client_created_at: Option<DateTime<Utc>>,
  pub client_updated_at: Option<DateTime<Utc>>,
  pub client_created_by: Option<Uuid>,
  pub client_updated_by: Option<Uuid>,
  pub historical_user_mapping_id: Option<String>,
  pub source_property_doc_revision: Option<String>,
}

fn default_provenance_mode() -> InitialDocumentProvenanceMode {
  InitialDocumentProvenanceMode::OfflineSync
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedInitialDocumentProvenance {
  pub idempotency_key: String,
  pub provenance_mode: ResolvedInitialDocumentProvenanceMode,
  pub received_at_server: DateTime<Utc>,
  pub applied_created_at: DateTime<Utc>,
  pub applied_updated_at: DateTime<Utc>,
  pub applied_created_by: Option<Uuid>,
  pub applied_updated_by: Option<Uuid>,
  pub decision_code: String,
  pub rejected_fields: serde_json::Value,
  pub normalized_provenance: serde_json::Value,
}

pub const DEFAULT_INITIAL_SYNC_CLOCK_SKEW_SECONDS: i64 = 300;
pub const OFFLINE_ORIGIN_CAPABILITY: &str = "offline-origin-v1";

pub fn is_native_client_format(client_format: Option<&str>) -> bool {
  client_format
    .map(|value| value.eq_ignore_ascii_case("myoxus-native"))
    .unwrap_or(false)
}

pub fn server_first_sync_key(workspace_id: Uuid, doc_id: Uuid) -> String {
  format!("server-first-sync:{workspace_id}:{doc_id}")
}

fn has_capability(client_capabilities: Option<&str>, capability: &str) -> bool {
  client_capabilities.is_some_and(|values| {
    values
      .split(',')
      .any(|value| value.trim().eq_ignore_ascii_case(capability))
  })
}

/// Resolve untrusted first-sync context into server-owned document facts.
///
/// Missing provenance is the normal native-client path and uses server time,
/// actor and a workspace/document-derived idempotency key. Only a trusted
/// server import invocation may retain an explicit-import source. Offline
/// timestamps are accepted only from a
/// native client that advertises `offline-origin-v1`, supplies a UUID client
/// instance and includes the creation time captured when the document was
/// actually created. Rejected fields are recorded by name and reason; this
/// resolver never logs or returns their raw values as an error.
#[expect(
  clippy::too_many_arguments,
  reason = "document provenance records each independent trust-boundary value"
)]
pub fn resolve_initial_document_provenance(
  workspace_id: Uuid,
  doc_id: Uuid,
  actor_user_id: Option<Uuid>,
  source: InitialDocumentProvenanceSource,
  client_format: Option<&str>,
  client_capabilities: Option<&str>,
  provenance: Option<&InitialDocumentProvenance>,
  received_at_server: DateTime<Utc>,
) -> ResolvedInitialDocumentProvenance {
  let requested_mode = provenance.map(|value| value.provenance_mode);
  let offline_requested = matches!(requested_mode, Some(InitialDocumentProvenanceMode::OfflineSync));
  let explicit_import_requested = matches!(requested_mode, Some(InitialDocumentProvenanceMode::ExplicitImport));
  let explicit_import = explicit_import_requested && matches!(source, InitialDocumentProvenanceSource::TrustedImport);
  let max_client_time = received_at_server + Duration::seconds(DEFAULT_INITIAL_SYNC_CLOCK_SKEW_SECONDS);
  let mut rejected = serde_json::Map::new();

  let offline_capability = has_capability(client_capabilities, OFFLINE_ORIGIN_CAPABILITY);
  let stable_client_instance = provenance
    .and_then(|value| value.client_instance_id.as_deref())
    .and_then(|value| Uuid::parse_str(value.trim()).ok())
    .is_some_and(|value| !value.is_nil());
  let has_offline_created_at = provenance.is_some_and(|value| value.client_created_at.is_some());
  let offline_accepted = offline_requested
    && is_native_client_format(client_format)
    && offline_capability
    && stable_client_instance
    && has_offline_created_at;

  if offline_requested && !offline_accepted {
    rejected.insert(
      "provenanceMode".to_string(),
      serde_json::json!("offline_origin_requirements_not_met"),
    );
    if !is_native_client_format(client_format) {
      rejected.insert("clientFormat".to_string(), serde_json::json!("myoxus_native_required"));
    }
    if !offline_capability {
      rejected.insert(
        "clientCapabilities".to_string(),
        serde_json::json!("offline_origin_v1_required"),
      );
    }
    if !stable_client_instance {
      rejected.insert(
        "clientInstanceId".to_string(),
        serde_json::json!("stable_uuid_required"),
      );
    }
    if !has_offline_created_at {
      rejected.insert(
        "clientCreatedAt".to_string(),
        serde_json::json!("persisted_origin_required"),
      );
    }
    if provenance.is_some_and(|value| value.client_updated_at.is_some()) {
      rejected.insert(
        "clientUpdatedAt".to_string(),
        serde_json::json!("offline_origin_rejected"),
      );
    }
  }
  if explicit_import_requested && !explicit_import {
    rejected.insert(
      "provenanceMode".to_string(),
      serde_json::json!("explicit_import_requires_server_path"),
    );
  }
  if !explicit_import
    && provenance
      .and_then(|value| value.idempotency_key.as_deref())
      .is_some_and(|value| !value.trim().is_empty())
  {
    rejected.insert("idempotencyKey".to_string(), serde_json::json!("server_derived"));
  }

  let mode = if explicit_import {
    ResolvedInitialDocumentProvenanceMode::ExplicitImport
  } else if offline_accepted {
    ResolvedInitialDocumentProvenanceMode::OfflineSync
  } else {
    ResolvedInitialDocumentProvenanceMode::ServerObservedFirstSync
  };

  let idempotency_key = if explicit_import {
    provenance
      .and_then(|value| value.idempotency_key.as_deref())
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(ToOwned::to_owned)
      .unwrap_or_else(|| server_first_sync_key(workspace_id, doc_id))
  } else {
    server_first_sync_key(workspace_id, doc_id)
  };

  let accept_client_times = explicit_import || offline_accepted;
  let mut created_at = if accept_client_times {
    provenance
      .and_then(|value| value.client_created_at)
      .unwrap_or(received_at_server)
  } else {
    received_at_server
  };
  if created_at > max_client_time {
    rejected.insert(
      "clientCreatedAt".to_string(),
      serde_json::json!("future_timestamp_clamped"),
    );
    created_at = received_at_server;
  }

  let mut updated_at = if accept_client_times {
    provenance
      .and_then(|value| value.client_updated_at)
      .unwrap_or(created_at)
  } else {
    received_at_server
  };
  if updated_at > max_client_time {
    rejected.insert(
      "clientUpdatedAt".to_string(),
      serde_json::json!("future_timestamp_clamped"),
    );
    updated_at = received_at_server;
  }
  if updated_at < created_at {
    rejected.insert(
      "clientUpdatedAt".to_string(),
      serde_json::json!("before_created_at_clamped"),
    );
    updated_at = created_at;
  }

  if provenance.is_some_and(|p| p.client_created_by.is_some()) {
    // Historical actor mapping is intentionally not guessed at this boundary.
    // Until an explicit mapping service exists, the authenticated sync/import
    // actor remains the canonical docs.created_by/updated_by value.
    rejected.insert(
      "clientCreatedBy".to_string(),
      serde_json::json!("historical_user_mapping_required"),
    );
  }
  if provenance.is_some_and(|p| p.client_updated_by.is_some()) {
    rejected.insert(
      "clientUpdatedBy".to_string(),
      serde_json::json!("historical_user_mapping_required"),
    );
  }

  let decision_code = if matches!(mode, ResolvedInitialDocumentProvenanceMode::ServerObservedFirstSync) {
    if explicit_import_requested {
      "client_explicit_import_rejected"
    } else if provenance.is_some() {
      "client_offline_provenance_rejected"
    } else {
      "server_observed_first_sync"
    }
  } else if rejected.is_empty() {
    "client_provenance_applied"
  } else {
    "client_provenance_partially_rejected"
  }
  .to_string();

  ResolvedInitialDocumentProvenance {
    idempotency_key,
    provenance_mode: mode,
    received_at_server,
    applied_created_at: created_at,
    applied_updated_at: updated_at,
    applied_created_by: actor_user_id,
    applied_updated_by: actor_user_id,
    decision_code,
    rejected_fields: serde_json::Value::Object(rejected),
    normalized_provenance: serde_json::json!({
      "docId": doc_id,
      "workspaceId": workspace_id,
      "clientFormat": client_format,
      "clientFamily": provenance.and_then(|p| p.client_family.as_deref()),
      "clientVersion": provenance.and_then(|p| p.client_version.as_deref()),
      "clientInstanceId": if explicit_import || offline_accepted {
        provenance.and_then(|p| p.client_instance_id.as_deref())
      } else {
        None
      },
      "provenanceMode": mode,
      "requestedProvenanceMode": requested_mode,
      "provenanceSource": match source {
        InitialDocumentProvenanceSource::ClientSync => "client_sync",
        InitialDocumentProvenanceSource::TrustedImport => "trusted_import",
      },
      "clientCreatedAt": if accept_client_times { provenance.and_then(|p| p.client_created_at) } else { None },
      "clientUpdatedAt": if accept_client_times { provenance.and_then(|p| p.client_updated_at) } else { None },
      "clientCreatedBy": provenance.and_then(|p| p.client_created_by),
      "clientUpdatedBy": provenance.and_then(|p| p.client_updated_by),
      "historicalUserMappingId": provenance.and_then(|p| p.historical_user_mapping_id.as_deref()),
      "sourcePropertyDocRevision": provenance.and_then(|p| p.source_property_doc_revision.as_deref()),
      "receivedAtServer": received_at_server,
      "offlineOriginCapabilityAccepted": offline_accepted,
    }),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn native_first_sync_without_provenance_is_server_observed() {
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let received = Utc::now();

    let resolved = resolve_initial_document_provenance(
      workspace_id,
      doc_id,
      Some(actor),
      InitialDocumentProvenanceSource::ClientSync,
      Some("myoxus-native"),
      Some("document-metadata,sync"),
      None,
      received,
    );

    assert_eq!(
      resolved.provenance_mode,
      ResolvedInitialDocumentProvenanceMode::ServerObservedFirstSync
    );
    assert_eq!(resolved.idempotency_key, server_first_sync_key(workspace_id, doc_id));
    assert_eq!(resolved.applied_created_at, received);
    assert_eq!(resolved.applied_updated_at, received);
    assert_eq!(resolved.applied_created_by, Some(actor));
    assert_eq!(resolved.decision_code, "server_observed_first_sync");
    assert_eq!(resolved.rejected_fields, serde_json::json!({}));
  }

  #[test]
  fn legacy_offline_claim_without_capability_is_downgraded_without_raw_normalization() {
    let received = Utc::now();
    let provenance = InitialDocumentProvenance {
      idempotency_key: Some("client-invented-key".to_string()),
      client_family: Some("electron".to_string()),
      client_version: Some("1".to_string()),
      client_instance_id: Some("legacy-instance".to_string()),
      provenance_mode: InitialDocumentProvenanceMode::OfflineSync,
      client_created_at: Some(received - Duration::days(10)),
      client_updated_at: Some(received - Duration::days(9)),
      client_created_by: None,
      client_updated_by: None,
      historical_user_mapping_id: None,
      source_property_doc_revision: None,
    };
    let resolved = resolve_initial_document_provenance(
      Uuid::new_v4(),
      Uuid::new_v4(),
      Some(Uuid::new_v4()),
      InitialDocumentProvenanceSource::ClientSync,
      Some("myoxus-native"),
      Some("document-metadata,sync"),
      Some(&provenance),
      received,
    );

    assert_eq!(
      resolved.provenance_mode,
      ResolvedInitialDocumentProvenanceMode::ServerObservedFirstSync
    );
    assert_eq!(resolved.applied_created_at, received);
    assert_eq!(resolved.applied_updated_at, received);
    assert_eq!(resolved.decision_code, "client_offline_provenance_rejected");
    assert_eq!(
      resolved.rejected_fields.get("clientCapabilities"),
      Some(&serde_json::json!("offline_origin_v1_required"))
    );
    assert_eq!(
      resolved.rejected_fields.get("clientInstanceId"),
      Some(&serde_json::json!("stable_uuid_required"))
    );
    assert_eq!(
      resolved.normalized_provenance["clientInstanceId"],
      serde_json::Value::Null
    );
    assert_eq!(
      resolved.normalized_provenance["clientCreatedAt"],
      serde_json::Value::Null
    );
    assert!(!resolved.normalized_provenance.to_string().contains("legacy-instance"));
  }

  #[test]
  fn valid_offline_origin_preserves_persisted_times_with_server_idempotency() {
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let received = Utc::now();
    let created = received - Duration::days(3650);
    let updated = created + Duration::days(1);
    let provenance = InitialDocumentProvenance {
      idempotency_key: Some("ignored-client-key".to_string()),
      client_family: Some("electron".to_string()),
      client_version: Some("1".to_string()),
      client_instance_id: Some(Uuid::new_v4().to_string()),
      provenance_mode: InitialDocumentProvenanceMode::OfflineSync,
      client_created_at: Some(created),
      client_updated_at: Some(updated),
      client_created_by: None,
      client_updated_by: None,
      historical_user_mapping_id: None,
      source_property_doc_revision: None,
    };

    let resolved = resolve_initial_document_provenance(
      workspace_id,
      doc_id,
      Some(Uuid::new_v4()),
      InitialDocumentProvenanceSource::ClientSync,
      Some("myoxus-native"),
      Some("sync, offline-origin-v1,document-metadata"),
      Some(&provenance),
      received,
    );

    assert_eq!(
      resolved.provenance_mode,
      ResolvedInitialDocumentProvenanceMode::OfflineSync
    );
    assert_eq!(resolved.idempotency_key, server_first_sync_key(workspace_id, doc_id));
    assert_eq!(resolved.applied_created_at, created);
    assert_eq!(resolved.applied_updated_at, updated);
    assert_eq!(resolved.decision_code, "client_provenance_partially_rejected");
    assert_eq!(
      resolved.rejected_fields,
      serde_json::json!({ "idempotencyKey": "server_derived" })
    );
  }

  #[test]
  fn exact_clock_skew_boundary_is_allowed() {
    let received = Utc::now();
    let boundary = received + Duration::seconds(DEFAULT_INITIAL_SYNC_CLOCK_SKEW_SECONDS);
    let provenance = InitialDocumentProvenance {
      idempotency_key: None,
      client_family: Some("mobile".to_string()),
      client_version: Some("1".to_string()),
      client_instance_id: Some(Uuid::new_v4().to_string()),
      provenance_mode: InitialDocumentProvenanceMode::OfflineSync,
      client_created_at: Some(boundary),
      client_updated_at: Some(boundary),
      client_created_by: None,
      client_updated_by: None,
      historical_user_mapping_id: None,
      source_property_doc_revision: None,
    };

    let resolved = resolve_initial_document_provenance(
      Uuid::new_v4(),
      Uuid::new_v4(),
      Some(Uuid::new_v4()),
      InitialDocumentProvenanceSource::ClientSync,
      Some("myoxus-native"),
      Some("offline-origin-v1"),
      Some(&provenance),
      received,
    );

    assert_eq!(resolved.applied_created_at, boundary);
    assert_eq!(resolved.applied_updated_at, boundary);
    assert_eq!(resolved.rejected_fields, serde_json::json!({}));
  }

  #[test]
  fn explicit_import_retains_source_key_and_rejects_unmapped_actors() {
    let received = Utc::now();
    let historical_actor = Uuid::new_v4();
    let provenance = InitialDocumentProvenance {
      idempotency_key: Some("explicit-import-key".to_string()),
      client_family: Some("git-sync".to_string()),
      client_version: Some("1".to_string()),
      client_instance_id: Some(Uuid::new_v4().to_string()),
      provenance_mode: InitialDocumentProvenanceMode::ExplicitImport,
      client_created_at: None,
      client_updated_at: None,
      client_created_by: Some(historical_actor),
      client_updated_by: Some(historical_actor),
      historical_user_mapping_id: None,
      source_property_doc_revision: Some("path/to/document.md".to_string()),
    };

    let resolved = resolve_initial_document_provenance(
      Uuid::new_v4(),
      Uuid::new_v4(),
      Some(Uuid::new_v4()),
      InitialDocumentProvenanceSource::TrustedImport,
      Some("myoxus-git-sync-import"),
      None,
      Some(&provenance),
      received,
    );

    assert_eq!(
      resolved.provenance_mode,
      ResolvedInitialDocumentProvenanceMode::ExplicitImport
    );
    assert_eq!(resolved.idempotency_key, "explicit-import-key");
    assert_eq!(resolved.decision_code, "client_provenance_partially_rejected");
    assert!(resolved.rejected_fields.get("clientCreatedBy").is_some());
    assert_eq!(
      resolved.normalized_provenance["sourcePropertyDocRevision"],
      serde_json::json!("path/to/document.md")
    );
  }

  #[test]
  fn client_sync_cannot_promote_itself_to_explicit_import() {
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let received = Utc::now();
    let provenance = InitialDocumentProvenance {
      idempotency_key: Some("untrusted-import-key".to_string()),
      client_family: Some("storage".to_string()),
      client_version: Some("1".to_string()),
      client_instance_id: Some(Uuid::new_v4().to_string()),
      provenance_mode: InitialDocumentProvenanceMode::ExplicitImport,
      client_created_at: Some(received - Duration::days(30)),
      client_updated_at: Some(received - Duration::days(29)),
      client_created_by: None,
      client_updated_by: None,
      historical_user_mapping_id: None,
      source_property_doc_revision: Some("untrusted.md".to_string()),
    };

    let resolved = resolve_initial_document_provenance(
      workspace_id,
      doc_id,
      Some(Uuid::new_v4()),
      InitialDocumentProvenanceSource::ClientSync,
      Some("myoxus-native"),
      Some("document-metadata,sync"),
      Some(&provenance),
      received,
    );

    assert_eq!(
      resolved.provenance_mode,
      ResolvedInitialDocumentProvenanceMode::ServerObservedFirstSync
    );
    assert_eq!(resolved.applied_created_at, received);
    assert_eq!(resolved.applied_updated_at, received);
    assert_eq!(resolved.idempotency_key, server_first_sync_key(workspace_id, doc_id));
    assert_eq!(resolved.decision_code, "client_explicit_import_rejected");
    assert_eq!(
      resolved.rejected_fields.get("provenanceMode"),
      Some(&serde_json::json!("explicit_import_requires_server_path"))
    );
  }
}
