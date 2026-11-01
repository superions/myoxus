// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-time OKF representation of native facts and retained import declarations.
//! This module never persists frontmatter or infers production/verification from ACLs.

use myoxus_domain::entities::{DocumentMetadataProjection, DocumentMetadataSource, DocumentOkfStatus};
use myoxus_domain::workspace_tags::WorkspaceTag;
use serde::Serialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct OkfReadContext {
  pub workspace_id: Uuid,
  pub external_id: String,
  pub title: String,
  pub imported_properties: Map<String, Value>,
  pub metadata: DocumentMetadataProjection,
  pub status_mapping: Option<DocumentOkfStatus>,
  pub tags: Vec<WorkspaceTag>,
  pub markdown_references: Option<crate::markdown::MarkdownReferenceLookup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct OkfProjection {
  pub frontmatter: Map<String, Value>,
  pub retained_frontmatter: Map<String, Value>,
  pub retrieval_reference: String,
  /// Identifies the native metadata projection, independently of Yjs content and catalog revisions.
  pub metadata_revision: i64,
  pub metadata_projection_version: String,
  pub tags: Vec<OkfTag>,
  pub diagnostics: Vec<&'static str>,
  #[serde(skip)]
  declared_keys: std::collections::HashSet<String>,
  #[serde(skip)]
  attachment_sources: std::collections::HashSet<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OkfTag {
  pub id: Uuid,
  pub label: String,
}

impl OkfProjection {
  pub fn diagnostic(&mut self, code: &'static str) {
    if self.diagnostics.len() < 32 && !self.diagnostics.contains(&code) {
      self.diagnostics.push(code);
    }
  }

  pub fn markdown(&self, body: &str) -> Result<String, yaml_serde::Error> {
    let yaml = yaml_serde::to_string(&self.frontmatter)?;
    Ok(format!("---\n{yaml}---\n{body}"))
  }

  fn canonical(&mut self, key: &str, value: Value) {
    if let Some(declared) = self.frontmatter.insert(key.to_owned(), value.clone())
      && self.declared_keys.contains(key)
      && declared != value
    {
      // Multiple enrichment passes must retain the original import declaration.
      self.retained_frontmatter.entry(key.to_owned()).or_insert(declared);
      self.diagnostic("declaration_superseded");
    }
  }
}

fn nonempty(value: Option<&Value>) -> Option<&str> {
  value.and_then(Value::as_str).filter(|value| !value.trim().is_empty())
}

pub fn projected_type(metadata: &DocumentMetadataProjection, properties: &Map<String, Value>) -> String {
  let native = metadata.fields.iter().find(|field| field.key == "documentType");
  let key = native
    .and_then(|field| field.reference.as_ref())
    .map(|reference| reference.key.as_str())
    .filter(|key| !key.trim().is_empty());
  let declared = nonempty(properties.get("type"));
  if native.is_some_and(|field| field.source == DocumentMetadataSource::Document) {
    key.or(declared).unwrap_or("Document").to_owned()
  } else {
    declared.or(key).unwrap_or("Document").to_owned()
  }
}

/// Pure projection; source authorization and enrichment are performed separately.
pub fn project(context: &OkfReadContext, description: Option<String>, citations: &[(String, Value)]) -> OkfProjection {
  let mut output = OkfProjection {
    frontmatter: context.imported_properties.clone(),
    retained_frontmatter: Map::new(),
    retrieval_reference: format!("myoxus://{}/{}", context.workspace_id, context.external_id),
    metadata_revision: context.metadata.metadata_revision,
    metadata_projection_version: context.metadata.projection_version.clone(),
    tags: context
      .tags
      .iter()
      .map(|tag| OkfTag {
        id: tag.id,
        label: tag.name.clone(),
      })
      .collect(),
    diagnostics: Vec::new(),
    declared_keys: context.imported_properties.keys().cloned().collect(),
    attachment_sources: std::collections::HashSet::new(),
  };
  output.canonical(
    "type",
    json!(projected_type(&context.metadata, &context.imported_properties)),
  );
  output.canonical("title", json!(context.title));
  output.canonical(
    "tags",
    json!(output.tags.iter().map(|tag| &tag.label).collect::<Vec<_>>()),
  );
  let explicit_status = context
    .metadata
    .fields
    .iter()
    .find(|field| field.key == "status")
    .is_some_and(|field| field.source == DocumentMetadataSource::Document);
  let imported_status = nonempty(context.imported_properties.get("status"))
    .filter(|status| matches!(*status, "draft" | "stable" | "deprecated"));
  let mapping = context.status_mapping.map(DocumentOkfStatus::as_str);
  let status = if explicit_status {
    mapping.or(imported_status)
  } else {
    imported_status.or(mapping)
  }
  .unwrap_or("stable");
  output.canonical("status", json!(status));
  let deadline = context
    .metadata
    .fields
    .iter()
    .filter(|field| matches!(field.key.as_str(), "reviewDueAt" | "validUntil"))
    .filter_map(|field| field.timestamp_value)
    .min();
  if let Some(deadline) = deadline {
    output.canonical("stale_after", json!(deadline.to_rfc3339()));
  } else if output.frontmatter.get("stale_after").is_some_and(|value| {
    value
      .as_str()
      .is_none_or(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
  }) {
    if let Some(value) = output.frontmatter.remove("stale_after") {
      output.retained_frontmatter.insert("stale_after".into(), value);
    }
    output.diagnostic("invalid_stale_after_declaration");
  }
  if nonempty(output.frontmatter.get("description")).is_none() {
    if let Some(description) = description {
      output.canonical("description", json!(description));
      output.diagnostic("description_derived_from_content");
    }
  }
  if nonempty(output.frontmatter.get("resource")).is_none() {
    output.diagnostic("underlying_resource_unknown");
  }
  if let Some(value) = output.frontmatter.get("generated")
    && nonempty(value.get("by")).is_none()
  {
    let value = output.frontmatter.remove("generated").expect("present declaration");
    output.retained_frontmatter.insert("generated".into(), value);
    output.diagnostic("producer_declaration_missing_by");
  }
  if let Some(value) = output
    .frontmatter
    .get("verified")
    .filter(|value| value.is_object())
    .cloned()
  {
    output.frontmatter.insert("verified".into(), json!([value]));
  }
  if let Some(generated) = output.frontmatter.get("generated")
    && generated.get("at").is_some_and(|at| {
      at.as_str()
        .is_none_or(|at| chrono::DateTime::parse_from_rfc3339(at).is_err())
    })
  {
    output.diagnostic("noncanonical_generation_timestamp");
  }
  if let Some(verified) = output.frontmatter.get("verified")
    && verified.as_array().is_none_or(|events| {
      events.iter().any(|event| {
        nonempty(event.get("by")).is_none()
          || event
            .get("at")
            .and_then(Value::as_str)
            .is_none_or(|at| chrono::DateTime::parse_from_rfc3339(at).is_err())
      })
    })
  {
    output.diagnostic("noncanonical_verification_declaration");
  }
  let mut sources = match output.frontmatter.get("sources") {
    Some(Value::Array(values)) => values.clone(),
    Some(_) => {
      output.diagnostic("noncanonical_sources_declaration");
      Vec::new()
    }
    None => Vec::new(),
  };
  let mut declared_ids = std::collections::HashMap::new();
  sources.retain(|source| {
    if nonempty(source.get("resource")).is_none() {
      output.diagnostic("noncanonical_sources_declaration");
    }
    let Some(id) = nonempty(source.get("id")) else {
      return true;
    };
    if let Some(previous) = declared_ids.get(id) {
      if previous != &source["resource"] {
        output.diagnostic("source_declaration_conflict");
      }
      // The first explicit ID wins; canonical() retains the full imported list.
      return false;
    }
    declared_ids.insert(id.to_owned(), source["resource"].clone());
    true
  });
  for (label, reference) in citations {
    let resource = match reference["type"].as_str() {
      Some("doc") => {
        // An explicit scope is authoritative, including when malformed. Falling
        // back would resolve an unrelated document with the same opaque key.
        let workspace = match reference.get("workspaceId") {
          None => Some(context.workspace_id),
          Some(value) => value.as_str().and_then(|id| Uuid::parse_str(id).ok()),
        };
        workspace
          .zip(nonempty(reference.get("docId")))
          .map(|(workspace, id)| format!("myoxus://{workspace}/{id}"))
      }
      Some("url") => nonempty(reference.get("url")).map(|url| {
        context
          .markdown_references
          .as_ref()
          .and_then(|lookup| lookup.resolve_import_url(url))
          .map_or_else(
            || url.to_owned(),
            |reference| format!("myoxus://{}/{}", context.workspace_id, reference.page_id),
          )
      }),
      Some("attachment") => nonempty(reference.get("blobId")).map(|id| {
        let resource = format!("myoxus://{}/blob/{id}", context.workspace_id);
        output.attachment_sources.insert((label.clone(), resource.clone()));
        resource
      }),
      _ => None,
    };
    let Some(resource) = resource else {
      output.diagnostic("citation_target_unavailable");
      continue;
    };
    if let Some(existing) = sources.iter().find(|source| source["id"].as_str() == Some(label)) {
      if existing["resource"].as_str() != Some(&resource) {
        output.diagnostic("source_declaration_conflict");
      }
      continue;
    }
    let mut source = json!({"id": label, "resource": resource});
    if let Some(title) = nonempty(reference.get("title")).or_else(|| nonempty(reference.get("fileName"))) {
      source["title"] = json!(title);
    }
    sources.push(source);
  }
  if !sources.is_empty() {
    output.canonical("sources", json!(sources));
  }
  if ["runtime", "parameters", "computation", "executor", "attester"]
    .iter()
    .any(|key| output.frontmatter.contains_key(*key))
    || output.frontmatter.get("type").and_then(Value::as_str) == Some("Attested Computation")
  {
    output.diagnostic("computation_declarations_not_executed_or_attested");
    if output.frontmatter.get("type").and_then(Value::as_str) == Some("Attested Computation")
      && nonempty(output.frontmatter.get("runtime")).is_none()
    {
      output.diagnostic("computation_runtime_unavailable");
    }
  }
  output
}

/// Enrich only distinct currently readable source identities. No source body,
/// actor inference, external request or analytics write is performed here.
#[tracing::instrument(skip_all)]
pub async fn enrich_sources(
  output: &mut OkfProjection,
  actor: Uuid,
  docs: &crate::doc::DocService,
  permissions: &crate::permission::PermissionService,
  metadata: &dyn crate::mcp::McpDocumentOperations,
  source_lookup: Option<(Uuid, &crate::markdown::MarkdownReferenceLookup)>,
  blobs: Option<&crate::ports::blob_service::BlobService>,
) {
  use crate::doc::DocSpaceKind;
  use crate::permission::{AccessController, WorkspaceResource};
  use myoxus_domain::document_key::DocumentKey;
  use myoxus_domain::permission::WorkspaceAction;
  use std::collections::{HashMap, HashSet};
  let Some(mut sources) = output.frontmatter.get("sources").and_then(Value::as_array).cloned() else {
    return;
  };
  let mut cache = HashMap::<(Uuid, String), Option<Value>>::new();
  let mut identities = HashSet::new();
  let mut asset_cache = HashMap::<(Uuid, String), Option<Value>>::new();
  let mut attempted = HashSet::new();
  let mut workspace_access = HashMap::new();
  let window = docs.analytics_window().await.ok().flatten();
  for source in &mut sources {
    let Some(resource) = source["resource"].as_str() else {
      output.diagnostic("source_resource_unavailable");
      continue;
    };
    let canonical = source_lookup.and_then(|(workspace, lookup)| {
      lookup
        .resolve_import_url(resource)
        .map(|reference| format!("myoxus://{workspace}/{}", reference.page_id))
    });
    let resource = canonical.as_deref().unwrap_or(resource);
    if !resource.starts_with("myoxus://") {
      if url::Url::parse(resource).is_err() {
        output.diagnostic("source_path_unresolved");
      }
      continue;
    }
    let Some((workspace, external)) = internal_source_key(resource) else {
      output.diagnostic("source_path_unresolved");
      continue;
    };
    let external = external.to_owned();
    // Bound unsuccessful targets too, before any permission or source I/O.
    let identity = (workspace, external.clone());
    if !attempted.contains(&identity) {
      if attempted.len() >= 50 {
        output.diagnostic("source_enrichment_limit");
        continue;
      }
      attempted.insert(identity);
    }
    if let std::collections::hash_map::Entry::Vacant(entry) = workspace_access.entry(workspace) {
      entry.insert(
        permissions
          .assert(
            &WorkspaceResource {
              user_id: actor,
              workspace_id: workspace,
            },
            WorkspaceAction::Read,
          )
          .await
          .is_ok(),
      );
    }
    if !workspace_access[&workspace] {
      output.diagnostic("source_facts_unavailable");
      continue;
    }
    // Opaque document keys may start with blob/. Only the same citation's typed
    // attachment evidence selects the asset owner, never the URI prefix alone.
    if let Some(blob_key) = external.strip_prefix("blob/").filter(|_| {
      source["id"].as_str().is_some_and(|id| {
        output
          .attachment_sources
          .contains(&(id.to_owned(), resource.to_owned()))
      })
    }) {
      let identity = (workspace, blob_key.to_owned());
      if !asset_cache.contains_key(&identity) {
        if cache.len() + asset_cache.len() >= 50 {
          output.diagnostic("source_enrichment_limit");
          continue;
        }
        asset_cache.insert(identity.clone(), None);
        if permissions
          .assert(
            &WorkspaceResource {
              user_id: actor,
              workspace_id: workspace,
            },
            WorkspaceAction::BlobsRead,
          )
          .await
          .is_err()
        {
          output.diagnostic("source_asset_enrichment_unavailable");
          continue;
        }
        match blobs {
          Some(blobs) => match blobs.get_blob_metadata(workspace, blob_key).await {
            Ok(Some(blob)) if blob.deleted_at.is_none() && blob.status == crate::ports::blob::BlobStatus::Completed => {
              asset_cache.insert(identity.clone(), Some(json!(blob.updated_at.to_rfc3339())));
            }
            _ => output.diagnostic("source_asset_enrichment_unavailable"),
          },
          None => output.diagnostic("source_asset_enrichment_unavailable"),
        }
      }
      if let Some(Some(modified)) = asset_cache.get(&identity)
        && let Some(source) = source.as_object_mut()
      {
        source.insert("last_modified".into(), modified.clone());
      }
      continue;
    }
    let key = (workspace, external.clone());
    if !cache.contains_key(&key) {
      if cache.len() + asset_cache.len() >= 50 {
        output.diagnostic("source_enrichment_limit");
        continue;
      }
      // Cache failures as well as success. Repeated declarations never amplify reads.
      cache.insert(key.clone(), None);
      let Ok(document_key) = DocumentKey::parse(external) else {
        output.diagnostic("source_path_unresolved");
        continue;
      };
      let Ok(Some(id)) = docs
        .resolve_document_key(workspace, DocSpaceKind::Workspace, &document_key)
        .await
      else {
        output.diagnostic("source_facts_unavailable");
        continue;
      };
      if identities.insert(id) && identities.len() > 50 {
        output.diagnostic("source_enrichment_limit");
        continue;
      }
      let Ok(readable) = permissions.readable_doc_ids(actor, workspace, &[id]).await else {
        output.diagnostic("source_facts_unavailable");
        continue;
      };
      if !readable.contains(&id) {
        output.diagnostic("source_facts_unavailable");
        continue;
      }
      let Ok(current) = docs.get_metadata_batch(&[id]).await else {
        output.diagnostic("source_facts_unavailable");
        continue;
      };
      let Some(doc) = current
        .get(&id)
        .filter(|doc| !doc.blocked && doc.deleted_at.is_none() && doc.workspace_id == Some(workspace))
      else {
        output.diagnostic("source_facts_unavailable");
        continue;
      };
      let mut facts = json!({"title":doc.title,"last_modified":doc.updated_at.to_rfc3339()});
      match metadata.projection(id, workspace).await {
        Ok(projection) => {
          if let Some(modified) = projection.metadata_updated_at.filter(|time| *time > doc.updated_at) {
            facts["last_modified"] = json!(modified.to_rfc3339());
          }
        }
        Err(_) => output.diagnostic("source_metadata_time_unavailable"),
      }
      let days = match &window {
        Some(window) => docs
          .list_doc_view_daily(workspace, &id.to_string(), window.start, window.end)
          .await
          .ok(),
        None => None,
      };
      match source_usage(window.as_ref(), days.as_deref()) {
        Ok((count, window)) => {
          facts["usage_count"] = json!(count);
          facts["usage_window"] = window;
        }
        Err(code) => output.diagnostic(code),
      }
      cache.insert(key.clone(), Some(facts));
    }
    if let Some(Some(facts)) = cache.get(&key)
      && let Some(source) = source.as_object_mut()
    {
      for (field, value) in facts.as_object().expect("fact mapping") {
        source.insert(field.clone(), value.clone());
      }
    }
  }
  output.canonical("sources", json!(sources));
}

/// Match the shipped MCP resource contract: everything after the first slash
/// is the opaque external key, including percent, query and fragment characters.
fn internal_source_key(resource: &str) -> Option<(Uuid, &str)> {
  let (workspace, external) = resource.strip_prefix("myoxus://")?.split_once('/')?;
  Some((Uuid::parse_str(workspace).ok()?, external))
}

/// Counts are meaningful only with exactly the persistence owner's complete buckets.
fn source_usage(
  window: Option<&crate::doc::traits::DocViewAnalyticsWindow>,
  days: Option<&[crate::doc::DocViewDaily]>,
) -> Result<(i64, Value), &'static str> {
  let window = window.ok_or("source_usage_window_unestablished")?;
  let days = days.ok_or("source_usage_unavailable")?;
  if days.len() != 28
    || window.start.checked_add_days(chrono::Days::new(27)) != Some(window.end)
    || window.from >= window.to
    || !days
      .iter()
      .enumerate()
      .all(|(offset, day)| Some(day.date) == window.start.checked_add_days(chrono::Days::new(offset as u64)))
  {
    return Err("source_usage_unavailable");
  }
  let count = days
    .iter()
    .try_fold(0_i64, |sum, day| sum.checked_add(day.total_views))
    .ok_or("source_usage_unavailable")?;
  Ok((
    count,
    json!({"from":window.from.to_rfc3339(),"to":window.to.to_rfc3339()}),
  ))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn context(properties: Value) -> OkfReadContext {
    let now = chrono::Utc::now();
    let metadata = serde_json::from_value(json!({
      "doc_id": Uuid::new_v4(), "workspace_id": Uuid::nil(), "metadata_revision": 7,
      "projection_version": "catalog-epoch", "metadata_updated_at": null, "metadata_updated_by": null,
      "system": {"created_at":now,"updated_at":now,"created_by":null,"updated_by":null,"metadata_updated_at":null,"metadata_updated_by":null},
      "fields":[], "audience":[], "template":null, "journal":{"journal_date":null},
      "presentation":null,"integration":null,"policy":{"locks":[]}
    })).expect("native metadata fixture");
    OkfReadContext {
      workspace_id: Uuid::nil(),
      external_id: "opaque-ä".into(),
      title: "Canonical title".into(),
      imported_properties: properties.as_object().unwrap().clone(),
      metadata,
      status_mapping: Some(DocumentOkfStatus::Draft),
      tags: Vec::new(),
      markdown_references: None,
    }
  }

  #[test]
  fn native_citation_scopes_are_authoritative_without_malformed_fallback() {
    let context = context(json!({}));
    let other = Uuid::new_v4();
    let mut citations = vec![
      ("local".into(), json!({"type":"doc","docId":"same-key"})),
      (
        "other".into(),
        json!({"type":"doc","docId":"same-key","workspaceId":other}),
      ),
    ];
    for (index, scope) in [Value::Null, json!(""), json!("invalid"), json!(17)]
      .into_iter()
      .enumerate()
    {
      citations.push((
        format!("invalid-{index}"),
        json!({"type":"doc","docId":"same-key","workspaceId":scope}),
      ));
    }
    let projected = project(&context, None, &citations);
    let sources = projected.frontmatter["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 2);
    assert_eq!(
      sources[0]["resource"],
      format!("myoxus://{}/same-key", context.workspace_id)
    );
    assert_eq!(sources[1]["resource"], format!("myoxus://{other}/same-key"));
    assert!(projected.diagnostics.contains(&"citation_target_unavailable"));
  }
}
