// SPDX-License-Identifier: AGPL-3.0-or-later

//! Explicit portable label validation and deterministic target identity planning.
//! Import-local identities never select an unrelated catalog entry by its name.

use super::{WorkspaceTagColorNormalization, WorkspaceTagService};
use chrono::{DateTime, Utc};
use myoxus_domain::workspace_tags::{WorkspaceTag, WorkspaceTagColorRole, WorkspaceTagSearchRefreshScope};
use myoxus_workspace_import::{DecodedWorkspaceTag, WorkspaceImportDiagnostic, WorkspaceImportDiagnosticCode};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use uuid::Uuid;

impl WorkspaceTagService {
  /// Retryable post-commit projection work for the durable content outbox.
  /// Authority was already admitted by the operation; this is not another
  /// actor-permission check. Catalog and assignment reads stay canonical.
  #[tracing::instrument(skip_all, fields(%workspace_id))]
  pub async fn refresh_workspace_content_tags(
    &self,
    workspace_id: Uuid,
    tag_ids: &[Uuid],
  ) -> super::WorkspaceTagResult<()> {
    for id in tag_ids.iter().copied().collect::<std::collections::BTreeSet<_>>() {
      self
        .repo
        .refresh_search_projections(workspace_id, WorkspaceTagSearchRefreshScope::CatalogTag(id))
        .await
        .map_err(super::WorkspaceTagServiceError::from_repository)?;
    }
    Ok(())
  }

  /// Same-workspace duplication reuses canonical identities and the existing
  /// transfer transaction. The source must still equal the caller's read.
  #[tracing::instrument(skip_all, fields(%workspace_id, %source_doc_id, %target_doc_id))]
  pub async fn copy_document_tags(
    &self,
    actor: Uuid,
    workspace_id: Uuid,
    source_doc_id: Uuid,
    target_doc_id: Uuid,
    expected_ids: &[Uuid],
  ) -> super::WorkspaceTagResult<Vec<WorkspaceTag>> {
    use super::{ERR_TAG_FORBIDDEN, WorkspaceTagServiceError};
    use crate::permission::{AccessController, DocResource};
    use myoxus_domain::permission::{DocAction, WorkspaceAction};
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    self.assert_document_read(actor, workspace_id, source_doc_id).await?;
    self
      .permission
      .assert(
        &DocResource {
          user_id: actor,
          workspace_id,
          doc_id: target_doc_id,
        },
        DocAction::PropertiesUpdate,
      )
      .await
      .map_err(|_| WorkspaceTagServiceError::new(ERR_TAG_FORBIDDEN, "document tags are not writable"))?;
    let tags = self
      .repo
      .copy_document_tag_ids(workspace_id, source_doc_id, target_doc_id, expected_ids, actor)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?;
    self
      .refresh_search_projections(workspace_id, WorkspaceTagSearchRefreshScope::Document(target_doc_id))
      .await;
    Ok(tags)
  }

  /// Normalize imported raw colors to an approved semantic role.
  ///
  /// Named/role values map exactly. Hex values use the canonical role palette
  /// only for deterministic import diagnostics; the UI still resolves the
  /// resulting role through the active server-owned theme.
  pub fn normalize_import_color(source: &str) -> WorkspaceTagColorNormalization {
    if let Ok(role) = WorkspaceTagColorRole::from_str(source) {
      return WorkspaceTagColorNormalization {
        source: source.to_string(),
        role,
        normalized: role.as_str() != source,
      };
    }
    let source_rgb = parse_hex_rgb(source);
    let role = source_rgb
      .map(|source_rgb| {
        CANONICAL_ROLE_RGB
          .iter()
          .min_by_key(|(_, candidate)| color_distance_squared(source_rgb, *candidate))
          .map(|(role, _)| *role)
          .unwrap_or(WorkspaceTagColorRole::Grey)
      })
      .unwrap_or(WorkspaceTagColorRole::Grey);
    WorkspaceTagColorNormalization {
      source: source.to_string(),
      role,
      normalized: true,
    }
  }
}

const CANONICAL_ROLE_RGB: [(WorkspaceTagColorRole, [u8; 3]); 9] = [
  (WorkspaceTagColorRole::Red, [237, 63, 63]),
  (WorkspaceTagColorRole::Magenta, [230, 96, 164]),
  (WorkspaceTagColorRole::Orange, [255, 175, 56]),
  (WorkspaceTagColorRole::Yellow, [255, 211, 56]),
  (WorkspaceTagColorRole::Green, [124, 194, 112]),
  (WorkspaceTagColorRole::Teal, [122, 226, 213]),
  (WorkspaceTagColorRole::Blue, [79, 144, 255]),
  (WorkspaceTagColorRole::Purple, [110, 82, 223]),
  (WorkspaceTagColorRole::Grey, [191, 192, 191]),
];

fn parse_hex_rgb(source: &str) -> Option<[u8; 3]> {
  let hex = source.trim().strip_prefix('#')?;
  if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return None;
  }
  Some([
    u8::from_str_radix(&hex[0..2], 16).ok()?,
    u8::from_str_radix(&hex[2..4], 16).ok()?,
    u8::from_str_radix(&hex[4..6], 16).ok()?,
  ])
}

fn color_distance_squared(left: [u8; 3], right: [u8; 3]) -> u32 {
  left
    .into_iter()
    .zip(right)
    .map(|(left, right)| {
      let delta = i32::from(left) - i32::from(right);
      (delta * delta) as u32
    })
    .sum()
}

#[derive(Debug, Clone)]
pub struct WorkspaceTagTransferPlan {
  pub tags: Vec<WorkspaceTag>,
  pub mappings: HashMap<String, Uuid>,
  pub diagnostics: Vec<WorkspaceImportDiagnostic>,
}

/// The caller supplies its durable import namespace. Retries have identical IDs;
/// separate imports cannot merge tags merely because their names coincide.
pub fn plan_import(
  namespace: Uuid,
  workspace_id: Uuid,
  actor: Uuid,
  source: &[DecodedWorkspaceTag],
  assignments: impl IntoIterator<Item = impl AsRef<[String]>>,
) -> Result<WorkspaceTagTransferPlan, WorkspaceImportDiagnostic> {
  let invalid = || {
    WorkspaceImportDiagnostic::blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportApplyBlocked,
      "workspace label metadata contains invalid identities, values or unresolved references",
    )
  };
  let mut plan = WorkspaceTagTransferPlan {
    tags: Vec::new(),
    mappings: HashMap::new(),
    diagnostics: Vec::new(),
  };
  let mut slugs = HashSet::new();
  let now = Utc::now();
  for entry in source {
    if entry.id.trim().is_empty() || entry.id.len() > 1024 || plan.mappings.contains_key(&entry.id) {
      return Err(invalid());
    }
    let id = Uuid::new_v5(&namespace, format!("tag:{}", entry.id).as_bytes());
    let name = WorkspaceTag::normalize_name(&entry.name).map_err(|_| invalid())?;
    let mut slug = WorkspaceTag::slug_base(&name).map_err(|_| invalid())?;
    if !slugs.insert(slug.clone()) {
      slug = format!("{slug}-{id}");
      if !slugs.insert(slug.clone()) {
        return Err(invalid());
      }
    }
    let color = WorkspaceTagService::normalize_import_color(&entry.color_role);
    if color.normalized {
      plan.diagnostics.push(WorkspaceImportDiagnostic::informational(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportLabelColorNormalized,
        "portable label color normalized to a supported semantic role",
      ));
    }
    let archived_at = entry
      .archived_at
      .as_ref()
      .map(|value| DateTime::parse_from_rfc3339(value).map(|value| value.with_timezone(&Utc)))
      .transpose()
      .map_err(|_| invalid())?
      .or_else(|| entry.archived.then_some(now));
    plan.mappings.insert(entry.id.clone(), id);
    plan.tags.push(WorkspaceTag {
      id,
      workspace_id,
      name,
      slug,
      color_role: color.role,
      description: entry.description.clone(),
      archived_at,
      created_at: now,
      updated_at: now,
      created_by: Some(actor),
      updated_by: Some(actor),
    });
  }
  for ids in assignments {
    let mut seen = HashSet::new();
    if ids
      .as_ref()
      .iter()
      .any(|id| !plan.mappings.contains_key(id) || !seen.insert(id))
    {
      return Err(invalid());
    }
  }
  Ok(plan)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableDocumentTags {
  pub source_id: String,
  pub external_id: String,
  pub tags: Vec<String>,
}

impl WorkspaceTagService {
  /// Preflight validates before client document creation; apply revalidates the
  /// same immutable source and authorizes every target before the atomic write.
  #[tracing::instrument(skip_all)]
  pub async fn import_document_tags(
    &self,
    actor: Uuid,
    workspace_id: Uuid,
    import_id: Uuid,
    source: &[DecodedWorkspaceTag],
    documents: &[PortableDocumentTags],
    validate_only: bool,
    limits: myoxus_workspace_import::WorkspaceImportLimits,
  ) -> super::WorkspaceTagResult<WorkspaceTagTransferPlan> {
    use crate::permission::{AccessController, DocResource};
    use myoxus_domain::permission::{DocAction, WorkspaceAction};
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    let invalid = |message: &str| super::WorkspaceTagServiceError::new(super::ERR_TAG_INVALID_REQUEST, message);
    if documents.len() > limits.max_documents
      || serde_json::to_vec(&(source, documents))
        .map_err(|_| invalid("invalid portable label metadata"))?
        .len() as u64
        > limits.max_document_bytes
    {
      return Err(invalid("portable label metadata exceeds the import limits"));
    }
    let mut identities = HashSet::new();
    let mut targets = HashSet::new();
    for document in documents {
      if document.source_id.trim().is_empty()
        || !identities.insert(&document.source_id)
        || !targets.insert(&document.external_id)
      {
        return Err(invalid("import document identities must be nonempty and unique"));
      }
    }
    let mut plan = plan_import(
      Uuid::new_v5(&workspace_id, import_id.as_bytes()),
      workspace_id,
      actor,
      source,
      documents.iter().map(|doc| &doc.tags),
    )
    .map_err(|_| invalid("invalid portable workspace labels"))?;
    if validate_only {
      return Ok(plan);
    }
    let mut assignments = Vec::with_capacity(documents.len());
    for documents in documents.chunks(myoxus_domain::workspace_tags::WORKSPACE_TAG_DOCUMENT_BATCH_LIMIT) {
      let keys = documents
        .iter()
        .map(|doc| myoxus_domain::document_key::DocumentKey::parse(&doc.external_id))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid("invalid external document key"))?;
      let stored = self
        .repo
        .list_document_assignments(workspace_id, &keys)
        .await
        .map_err(super::WorkspaceTagServiceError::from_repository)?;
      for document in documents {
        let stored = stored
          .iter()
          .find(|stored| stored.external_id == document.external_id)
          .ok_or_else(|| invalid("import target document is unavailable"))?;
        self
          .permission
          .assert(
            &DocResource {
              user_id: actor,
              workspace_id,
              doc_id: stored.doc_id,
            },
            DocAction::PropertiesUpdate,
          )
          .await
          .map_err(|_| {
            super::WorkspaceTagServiceError::new(super::ERR_TAG_FORBIDDEN, "import target is not writable")
          })?;
        assignments.push((
          stored.doc_id,
          document.tags.iter().map(|id| plan.mappings[id]).collect(),
        ));
      }
    }
    plan.tags = self
      .repo
      .import_tags(workspace_id, actor, &plan.tags, &assignments)
      .await
      .map_err(|error| match error {
        myoxus_domain::repositories::RepositoryError::Validation(message) => invalid(&message),
        error => super::WorkspaceTagServiceError::from_repository(error),
      })?;
    self
      .refresh_search_projections(workspace_id, WorkspaceTagSearchRefreshScope::Workspace)
      .await;
    Ok(plan)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn explicit_import_preserves_order_archival_and_identity_without_name_matching() {
    let namespace = Uuid::new_v4();
    let workspace = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let source: Vec<DecodedWorkspaceTag> = serde_json::from_value(serde_json::json!([
      {"id": "old-b", "value": "Same name", "color": "tag.blue", "description": "retain exactly"},
      {"id": "old-a", "name": "Same name", "colorRole": "unsupported", "archivedAt": "2024-01-02T03:04:05Z"}
    ]))
    .unwrap();
    let assignments = vec![vec!["old-a".to_owned(), "old-b".to_owned()], vec![]];
    let plan = plan_import(namespace, workspace, actor, &source, &assignments).unwrap();
    let retry = plan_import(namespace, workspace, actor, &source, &assignments).unwrap();
    assert_eq!(plan.mappings, retry.mappings);
    assert_ne!(plan.tags[0].id, plan.tags[1].id);
    assert_ne!(plan.tags[0].slug, plan.tags[1].slug);
    assert_eq!(plan.tags[0].description.as_deref(), Some("retain exactly"));
    assert_eq!(
      plan.tags[1].archived_at.unwrap().to_rfc3339(),
      "2024-01-02T03:04:05+00:00"
    );
    assert_eq!(plan.tags[1].color_role, WorkspaceTagColorRole::Grey);
    assert_eq!(plan.diagnostics.len(), 1);
    let mapped = assignments[0].iter().map(|id| plan.mappings[id]).collect::<Vec<_>>();
    assert_eq!(mapped, [plan.tags[1].id, plan.tags[0].id]);
    assert!(plan_import(namespace, workspace, actor, &source, [vec!["unknown".to_owned()]]).is_err());
    assert!(
      plan_import(
        namespace,
        workspace,
        actor,
        &source,
        [vec!["old-a".to_owned(), "old-a".to_owned()]]
      )
      .is_err()
    );
    assert!(
      plan_import(namespace, workspace, actor, &[], [Vec::<String>::new()])
        .unwrap()
        .tags
        .is_empty()
    );
  }
}

/// Detached portable envelope. External source keys remain unchanged here; the
/// serializer maps them to its output IDs without changing canonical identities.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTagExport {
  pub workspace_tags: Vec<DecodedWorkspaceTag>,
  pub documents: Vec<PortableDocumentTags>,
}

impl WorkspaceTagService {
  #[tracing::instrument(skip_all)]
  pub async fn export_document_tags(
    &self,
    actor: Uuid,
    workspace_id: Uuid,
    keys: &[myoxus_domain::document_key::DocumentKey],
    limits: myoxus_workspace_import::WorkspaceImportLimits,
  ) -> super::WorkspaceTagResult<WorkspaceTagExport> {
    self
      .assert_workspace(actor, workspace_id, myoxus_domain::permission::WorkspaceAction::Read)
      .await?;
    let invalid = |message: &str| super::WorkspaceTagServiceError::new(super::ERR_TAG_INVALID_REQUEST, message);
    if keys.len() > limits.max_documents
      || keys.iter().map(|key| key.as_str()).collect::<HashSet<_>>().len() != keys.len()
    {
      return Err(invalid(
        "export requires unique document keys within the import/export limit",
      ));
    }
    let (tags, assignments) = self
      .repo
      .export_tags(workspace_id, keys, limits.max_document_bytes)
      .await
      .map_err(super::WorkspaceTagServiceError::from_repository)?;
    if assignments.len() != keys.len() {
      return Err(invalid("export document is unavailable"));
    }
    for batch in assignments.chunks(myoxus_domain::workspace_tags::WORKSPACE_TAG_DOCUMENT_BATCH_LIMIT) {
      let ids = batch.iter().map(|entry| entry.doc_id).collect::<Vec<_>>();
      let readable = self
        .permission
        .readable_doc_ids(actor, workspace_id, &ids)
        .await
        .map_err(|_| {
          super::WorkspaceTagServiceError::new(super::ERR_TAG_FORBIDDEN, "export document is unavailable")
        })?;
      if readable.len() != ids.len() {
        return Err(super::WorkspaceTagServiceError::new(
          super::ERR_TAG_FORBIDDEN,
          "export document is unavailable",
        ));
      }
    }
    let result = WorkspaceTagExport {
      workspace_tags: tags
        .into_iter()
        .map(|tag| DecodedWorkspaceTag {
          id: tag.id.to_string(),
          name: tag.name,
          color_role: tag.color_role.to_string(),
          description: tag.description,
          archived: tag.archived_at.is_some(),
          archived_at: tag.archived_at.map(|at| at.to_rfc3339()),
        })
        .collect(),
      documents: assignments
        .into_iter()
        .map(|entry| PortableDocumentTags {
          source_id: entry.external_id.clone(),
          external_id: entry.external_id,
          tags: entry.tag_ids.into_iter().map(|id| id.to_string()).collect(),
        })
        .collect(),
    };
    if serde_json::to_vec(&result)
      .map_err(|_| invalid("invalid portable labels"))?
      .len() as u64
      > limits.max_document_bytes
    {
      return Err(invalid("portable labels exceed metadata limits"));
    }
    Ok(result)
  }
}
