// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typed identity rewrites shared by internal workspace-content publication.
use crate::database::{
  DatabaseCellValueData, DatabaseDomainError, DatabaseFilterConjunction, DatabaseFilterGroup, DatabaseFilterRule,
  DatabaseFilterValue, DatabaseViewConfig,
};
use crate::ids::{DatabaseFieldId, DocId, WorkspaceId};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// Saved Tag predicates are classification usages too. Interpret operands
/// only after their field kind is known; unrelated option/string values are
/// never Tag identities.
pub fn workspace_content_view_tag_ids(
  config: &DatabaseViewConfig,
  tag_fields: &HashSet<DatabaseFieldId>,
) -> Result<Vec<Uuid>, DatabaseDomainError> {
  let mut ids = Vec::new();
  rewrite_workspace_content_view_tags(&mut config.clone(), tag_fields, |_, _, values| {
    ids.extend_from_slice(values);
    Ok(values.to_vec())
  })?;
  let mut seen = HashSet::new();
  ids.retain(|id| seen.insert(*id));
  Ok(ids)
}

/// Rewrite only typed Tag predicates, retaining operators, conjunctions and
/// every non-Tag value. Paths are snapshot-bound positions, not durable IDs;
/// callers restoring lineage must verify their container/context hashes.
pub fn rewrite_workspace_content_view_tags(
  config: &mut DatabaseViewConfig,
  tag_fields: &HashSet<DatabaseFieldId>,
  mut rewrite: impl FnMut(&str, &str, &[Uuid]) -> Result<Vec<Uuid>, DatabaseDomainError>,
) -> Result<(), DatabaseDomainError> {
  fn rules(
    rules: &mut [DatabaseFilterRule],
    fields: &HashSet<DatabaseFieldId>,
    path: &str,
    ancestors: &[DatabaseFilterConjunction],
    rewrite: &mut impl FnMut(&str, &str, &[Uuid]) -> Result<Vec<Uuid>, DatabaseDomainError>,
  ) -> Result<(), DatabaseDomainError> {
    for (index, rule) in rules
      .iter_mut()
      .enumerate()
      .filter(|(_, rule)| fields.contains(&rule.field_id))
    {
      let values: &[String] = match &rule.value {
        DatabaseFilterValue::OptionId(id) => std::slice::from_ref(id),
        DatabaseFilterValue::Ids(ids) => ids,
        DatabaseFilterValue::None => continue,
        _ => {
          return Err(DatabaseDomainError::Validation("Invalid Tag filter operand".into()));
        }
      };
      let ids = values
        .iter()
        .map(|id| {
          Uuid::parse_str(id).map_err(|_| DatabaseDomainError::Validation("Invalid Tag filter identity".into()))
        })
        .collect::<Result<Vec<_>, DatabaseDomainError>>()?;
      let operand_kind = match &rule.value {
        DatabaseFilterValue::OptionId(_) => "option_id",
        DatabaseFilterValue::Ids(_) => "ids",
        _ => unreachable!("operand validated above"),
      };
      let context = serde_json::to_vec(&(ancestors, rule.field_id, &rule.operator, operand_kind))
        .map_err(|_| DatabaseDomainError::Validation("Invalid Tag filter context".into()))?;
      let context_hash = format!("{:x}", Sha256::digest(context));
      let mut next = rewrite(&format!("{path}/{index}"), &context_hash, &ids)?;
      let mut seen = HashSet::new();
      next.retain(|id| seen.insert(*id));
      rule.value = match &rule.value {
        DatabaseFilterValue::OptionId(_) if next.len() == 1 => DatabaseFilterValue::OptionId(next[0].to_string()),
        DatabaseFilterValue::Ids(_) => DatabaseFilterValue::Ids(next.iter().map(Uuid::to_string).collect()),
        _ => {
          return Err(DatabaseDomainError::Validation(
            "Invalid mapped Tag filter operand".into(),
          ));
        }
      };
    }
    Ok(())
  }
  fn group(
    tree: &mut DatabaseFilterGroup,
    fields: &HashSet<DatabaseFieldId>,
    path: &str,
    mut ancestors: Vec<DatabaseFilterConjunction>,
    rewrite: &mut impl FnMut(&str, &str, &[Uuid]) -> Result<Vec<Uuid>, DatabaseDomainError>,
  ) -> Result<(), DatabaseDomainError> {
    ancestors.push(tree.conjunction);
    rules(&mut tree.rules, fields, &format!("{path}/rules"), &ancestors, rewrite)?;
    for (index, child) in tree.groups.iter_mut().enumerate() {
      group(
        child,
        fields,
        &format!("{path}/groups/{index}"),
        ancestors.clone(),
        rewrite,
      )?;
    }
    Ok(())
  }
  let (flat, tree) = match config {
    DatabaseViewConfig::Table(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Kanban(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::List(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Gallery(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Calendar(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Timeline(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Gantt(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Progress(c) => (&mut c.filter, &mut c.filter_tree),
  };
  rules(
    flat,
    tag_fields,
    "/filter",
    &[DatabaseFilterConjunction::And],
    &mut rewrite,
  )?;
  if let Some(tree) = tree {
    group(tree, tag_fields, "/filterTree", Vec::new(), &mut rewrite)?;
  }
  Ok(())
}

/// Typed Files/DocumentLink addresses are shared by identity-preserving
/// transfers and clones. Labels, captions and other cell kinds are inert.
pub fn rewrite_workspace_content_value(
  value: &mut DatabaseCellValueData,
  source_workspace: WorkspaceId,
  target_workspace: WorkspaceId,
  document_ids: &HashMap<DocId, DocId>,
  blob_keys: &HashMap<String, String>,
) -> Result<(), DatabaseDomainError> {
  match value {
    DatabaseCellValueData::Files(files) => {
      for file in &mut files.files {
        file.blob_key = blob_keys
          .get(&file.blob_key)
          .cloned()
          .ok_or_else(|| DatabaseDomainError::Validation("owned file mapping missing".into()))?;
      }
    }
    DatabaseCellValueData::DocumentLink(link) => {
      if link.workspace_id.unwrap_or(source_workspace) == source_workspace {
        if let Some(id) = document_ids.get(&link.doc_id) {
          link.doc_id = *id;
          link.workspace_id = Some(target_workspace);
        } else {
          link.workspace_id = Some(source_workspace);
        }
      }
    }
    _ => {}
  }
  Ok(())
}

/// Workspace-local Blob operands in both flat and nested saved filters.
pub fn rewrite_workspace_content_view_blobs(
  config: &mut DatabaseViewConfig,
  fields: &HashSet<DatabaseFieldId>,
  keys: &HashMap<String, String>,
) {
  fn rules(rules: &mut [DatabaseFilterRule], fields: &HashSet<DatabaseFieldId>, keys: &HashMap<String, String>) {
    for rule in rules.iter_mut().filter(|rule| fields.contains(&rule.field_id)) {
      let ids = match &mut rule.value {
        DatabaseFilterValue::OptionId(id) => std::slice::from_mut(id),
        DatabaseFilterValue::Ids(ids) => ids.as_mut_slice(),
        _ => continue,
      };
      for id in ids {
        if let Some(target) = keys.get(id) {
          *id = target.clone();
        }
      }
    }
  }
  fn group(tree: &mut DatabaseFilterGroup, fields: &HashSet<DatabaseFieldId>, keys: &HashMap<String, String>) {
    rules(&mut tree.rules, fields, keys);
    for child in &mut tree.groups {
      group(child, fields, keys);
    }
  }
  let (flat, tree) = match config {
    DatabaseViewConfig::Table(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Kanban(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::List(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Gallery(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Calendar(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Timeline(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Gantt(c) => (&mut c.filter, &mut c.filter_tree),
    DatabaseViewConfig::Progress(c) => (&mut c.filter, &mut c.filter_tree),
  };
  rules(flat, fields, keys);
  if let Some(tree) = tree {
    group(tree, fields, keys);
  }
}
