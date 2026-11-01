// SPDX-License-Identifier: AGPL-3.0-or-later
//! Document-scoped source selectors over the current, reachable native tree.

use std::collections::HashSet;

use yrs::ReadTxn;
use yrs::updates::decoder::Decode;
use yrs::{Array, GetString, Map, Text, Transact, Update};

use crate::document_mutation::normalize_heading;
use crate::resolve_flavour;

/// One current native target. IDs survive edits/moves; heading labels follow edits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownNativeTarget {
  pub block_id: String,
  pub heading_path: Option<Vec<String>>,
  pub source_anchor: Option<String>,
  /// A trailing anchor needs an own Markdown body, not an empty container.
  pub can_export_anchor: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkdownTargetError {
  Missing,
  Ambiguous,
  Invalid,
}

/// Add portable anchors to an export-only copy, never the live document.
/// Only reachable paragraph/list/callout targets without existing provenance
/// may be annotated; literal code and annotations are not export anchor hosts.
pub fn with_markdown_export_anchors(binary: &[u8], anchors: &[(String, String)]) -> Result<Vec<u8>, String> {
  if anchors.is_empty() {
    return Ok(binary.to_vec());
  }
  let targets = markdown_native_targets(binary)?;
  let eligible = targets
    .iter()
    .filter(|target| target.source_anchor.is_none() && target.can_export_anchor)
    .map(|target| target.block_id.as_str())
    .collect::<HashSet<_>>();
  let mut ids = HashSet::new();
  let mut names = targets
    .iter()
    .filter_map(|target| target.source_anchor.as_deref())
    .collect::<HashSet<_>>();
  if anchors.len() > eligible.len() {
    return Err("export anchor count exceeds tree limits".into());
  }
  for (id, anchor) in anchors {
    if !valid_markdown_anchor(anchor)
      || !ids.insert(id.as_str())
      || !names.insert(anchor.as_str())
      || !eligible.contains(id.as_str())
    {
      return Err("invalid Markdown export anchor target".into());
    }
  }
  let doc = yrs::Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  txn
    .apply_update(Update::decode_v1(binary).map_err(|_| "invalid export snapshot")?)
    .map_err(|_| "invalid export snapshot")?;
  for (id, anchor) in anchors {
    let Some(yrs::Out::YMap(block)) = blocks.get(&txn, id) else {
      return Err("missing Markdown export target".into());
    };
    block.insert(&mut txn, "prop:markdownAnchor", anchor.as_str());
  }
  Ok(txn.encode_state_as_update_v1(&yrs::StateVector::default()))
}

/// Inspect only an already authorized snapshot. Detached/deleted blocks are not targets.
pub fn markdown_native_targets(binary: &[u8]) -> Result<Vec<MarkdownNativeTarget>, String> {
  markdown_native_targets_with_references(binary, &|_| None)
}

/// Heading labels containing native links use the operation's current authorized
/// presentation. Missing references cannot disclose cached titles or invent a slug.
pub fn markdown_native_targets_with_references(
  binary: &[u8],
  resolve_reference: &dyn Fn(&super::MarkdownDocumentReference) -> Option<super::MarkdownResolvedReference>,
) -> Result<Vec<MarkdownNativeTarget>, String> {
  let doc = yrs::Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(binary).map_err(|_| "invalid target snapshot")?)
    .map_err(|_| "invalid target snapshot")?;
  let txn = doc.transact();
  let string = |block: &yrs::MapRef, name: &str| match block
    .get(&txn, name)
    .or_else(|| name.strip_prefix("sys:").and_then(|name| block.get(&txn, name)))
    .or_else(|| {
      name
        .strip_prefix("prop:")
        .and_then(|name| match block.get(&txn, "props") {
          Some(yrs::Out::YMap(props)) => props.get(&txn, name),
          _ => block.get(&txn, name),
        })
    }) {
    Some(yrs::Out::Any(yrs::Any::String(value))) => Some(value.to_string()),
    _ => None,
  };
  let roots = blocks
    .iter(&txn)
    .filter_map(|(id, value)| match value {
      yrs::Out::YMap(block)
        if string(&block, "sys:flavour").is_some_and(|kind| resolve_flavour(&kind) == "myoxus:page") =>
      {
        Some(id.to_string())
      }
      _ => None,
    })
    .take(2)
    .collect::<Vec<_>>();
  if roots.len() != 1 {
    return Err("target snapshot must have one document root".into());
  }
  let mut pending = vec![(roots[0].clone(), 0usize)];
  let mut scheduled = HashSet::from([roots[0].clone()]);
  let mut headings: Vec<(u8, Option<String>)> = Vec::new();
  let mut targets = Vec::new();
  while let Some((id, depth)) = pending.pop() {
    if depth > super::MAX_BLOCK_DEPTH {
      return Err("target snapshot exceeds tree limits".into());
    }
    let Some(yrs::Out::YMap(block)) = blocks.get(&txn, &id) else {
      return Err("target snapshot has a missing child".into());
    };
    let flavour = string(&block, "sys:flavour").unwrap_or_default();
    let kind = string(&block, "prop:type").unwrap_or_default();
    let heading = if resolve_flavour(&flavour) == "myoxus:paragraph" {
      kind
        .strip_prefix('h')
        .and_then(|level| level.parse::<u8>().ok())
        .filter(|level| (1..=6).contains(level))
    } else {
      None
    };
    let heading_path = heading
      .map(|level| {
        while headings.last().is_some_and(|(previous, _)| *previous >= level) {
          headings.pop();
        }
        let value = match block.get(&txn, "prop:text").or_else(|| block.get(&txn, "text")) {
          Some(yrs::Out::YText(text)) => {
            let mut label = String::new();
            let mut known = true;
            for diff in text.diff(&txn, yrs::types::text::YChange::identity) {
              if crate::annotation::annotation_id(diff.attributes.as_deref()).is_some() {
                continue;
              }
              if let Some(reference) = super::export::attr_document_reference(diff.attributes.as_deref()) {
                if let Some(resolved) = resolve_reference(&reference) {
                  label.push_str(
                    reference
                      .title
                      .as_deref()
                      .filter(|title| !title.trim().is_empty())
                      .unwrap_or(&resolved.title),
                  );
                } else {
                  known = false;
                }
              } else if diff
                .attributes
                .as_deref()
                .is_some_and(|attrs| attrs.contains_key("latex"))
              {
                known = false;
              } else if let yrs::Out::Any(yrs::Any::String(value)) = diff.insert {
                label.push_str(&value);
              } else {
                known = false;
              }
            }
            known.then_some(label)
          }
          _ => Some(String::new()),
        };
        headings.push((level, value));
        // A known descendant can still resolve by its unique suffix; an unknown
        // ancestor must never fabricate a complete heading path.
        let suffix = headings
          .iter()
          .rposition(|(_, label)| label.is_none())
          .map_or(0, |index| index + 1);
        let path = headings[suffix..]
          .iter()
          .filter_map(|(_, label)| label.clone())
          .collect::<Vec<_>>();
        (!path.is_empty()).then_some(path)
      })
      .flatten();
    if matches!(
      resolve_flavour(&flavour),
      "myoxus:paragraph" | "myoxus:list" | "myoxus:callout"
    ) {
      targets.push(MarkdownNativeTarget {
        block_id: id,
        heading_path,
        source_anchor: string(&block, "prop:markdownAnchor"),
        can_export_anchor: matches!(block.get(&txn, "prop:text").or_else(|| block.get(&txn, "text")), Some(yrs::Out::YText(text)) if !text.get_string(&txn).trim().is_empty()
          || text.diff(&txn, yrs::types::text::YChange::identity).iter().any(|diff| diff.attributes.as_ref().is_some_and(|attributes| !attributes.is_empty()))),
      });
    }
    if let Some(yrs::Out::YArray(children)) = block.get(&txn, "sys:children").or_else(|| block.get(&txn, "children")) {
      // Width is bounded by the captured native map, not a second document
      // quota. Reject duplicates/cycles before queueing, so malformed child
      // arrays cannot grow the traversal beyond that map.
      let children = children
        .iter(&txn)
        .map(|value| match value {
          yrs::Out::Any(yrs::Any::String(value))
            if scheduled.insert(value.to_string()) && blocks.contains_key(&txn, &value) =>
          {
            Ok((value.to_string(), depth + 1))
          }
          yrs::Out::Any(yrs::Any::String(_)) => Err("target snapshot has a duplicate or missing child"),
          _ => Err("target snapshot has an invalid child"),
        })
        .collect::<Result<Vec<_>, _>>()?;
      pending.extend(children.into_iter().rev());
    }
  }
  Ok(targets)
}

/// Resolve a decoded portable fragment uniquely. The URL owner decodes it once
/// with its existing URL parser. Block IDs remain case-sensitive;
/// heading paths use the same normalization as native section mutation.
pub fn resolve_markdown_target<'a>(
  targets: &'a [MarkdownNativeTarget],
  fragment: &str,
) -> Result<&'a MarkdownNativeTarget, MarkdownTargetError> {
  let candidates = if let Some(anchor) = fragment.strip_prefix('^') {
    if !valid_markdown_anchor(anchor) {
      return Err(MarkdownTargetError::Invalid);
    }
    targets
      .iter()
      .filter(|target| target.source_anchor.as_deref() == Some(anchor))
      .collect::<Vec<_>>()
  } else {
    let expected = fragment.split('#').map(normalize_heading).collect::<Vec<_>>();
    if expected.is_empty() || expected.iter().any(String::is_empty) {
      return Err(MarkdownTargetError::Invalid);
    }
    targets
      .iter()
      .filter(|target| {
        target.heading_path.as_ref().is_some_and(|path| {
          path.len() >= expected.len()
            && path[path.len() - expected.len()..]
              .iter()
              .map(|label| normalize_heading(label))
              .eq(expected.iter().cloned())
        })
      })
      .collect::<Vec<_>>()
  };
  match candidates.as_slice() {
    [] => Err(MarkdownTargetError::Missing),
    [target] => Ok(target),
    _ => Err(MarkdownTargetError::Ambiguous),
  }
}

pub fn valid_markdown_anchor(value: &str) -> bool {
  !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Exact unescaped trailing source token, checked again against plain text runs
/// by the importer. Code and annotation nodes never enter this recognizer.
pub(crate) fn trailing_source_anchor(source: &str) -> Option<&str> {
  let source = source.trim_end_matches([' ', '\t', '\r', '\n']);
  let (_, anchor) = source.rsplit_once('^')?;
  let prefix = &source[..source.len() - anchor.len() - 1];
  (valid_markdown_anchor(anchor) && (prefix.is_empty() || prefix.ends_with(char::is_whitespace))).then_some(anchor)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::markdown::{extract_text_from_yjs, markdown_to_yjs};
  use yrs::ReadTxn;

  #[test]
  fn wide_native_documents_use_the_document_tree_not_a_second_width_quota() {
    let source = (0..10_001)
      .map(|index| format!("Instruction {index}\n\n"))
      .collect::<String>();
    let binary = markdown_to_yjs("Wide runbook", &source).expect("supported wide document");
    let targets = markdown_native_targets(&binary).expect("every reachable paragraph remains addressable");
    assert_eq!(targets.len(), 10_001);
    let last = targets.last().expect("last paragraph").block_id.clone();
    let exported = with_markdown_export_anchors(&binary, &[(last.clone(), "last-instruction".into())])
      .expect("export anchor at the end of the current tree");
    assert_eq!(
      resolve_markdown_target(
        &markdown_native_targets(&exported).expect("export tree"),
        "^last-instruction"
      )
      .expect("last target")
      .block_id,
      last
    );
    assert!(
      markdown_native_targets(&binary)
        .expect("live tree unchanged")
        .iter()
        .all(|target| target.source_anchor.is_none())
    );

    let doc = yrs::Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&binary).expect("decode tree"))
      .expect("load tree");
    let root = {
      let txn = doc.transact();
      blocks.iter(&txn).find_map(|(id, value)| match value {
        yrs::Out::YMap(block) if matches!(block.get(&txn, "sys:flavour"), Some(yrs::Out::Any(yrs::Any::String(kind))) if resolve_flavour(&kind) == "myoxus:page") => Some(id.to_string()),
        _ => None,
      }).expect("page root")
    };
    for malformed in [last, root.clone(), "missing-native-child".into()] {
      let mut txn = doc.transact_mut();
      let Some(yrs::Out::YMap(page)) = blocks.get(&txn, &root) else {
        panic!("page exists")
      };
      let Some(yrs::Out::YArray(children)) = page.get(&txn, "sys:children") else {
        panic!("page children exist")
      };
      children.push_back(&mut txn, malformed.as_str());
      let broken = txn.encode_state_as_update_v1(&yrs::StateVector::default());
      drop(txn);
      assert!(
        markdown_native_targets(&broken).is_err(),
        "duplicate, cyclic and missing children must fail closed"
      );
      let mut txn = doc.transact_mut();
      let length = children.len(&txn);
      children.remove(&mut txn, length - 1);
    }
  }

  #[test]
  fn source_anchors_are_native_provenance_and_roundtrip_without_touching_literals() {
    let source = "# Guide ^top\n\nPlain body ^paragraph\n\n- List body ^item\n  - Nested checklist ^child\n- Code instructions ^instructions\n  ```text\n  Fenced ^nested-literal\n  ```\n\nEscaped \\^literal\n\n`Inline ^code`\n\n%%Hidden ^annotation%%\n\n```text\nFenced ^literal\n```\n";
    let binary = markdown_to_yjs("Guide", source).expect("import anchors");
    let targets = markdown_native_targets(&binary).expect("index current tree");
    let exported = extract_text_from_yjs(&binary).expect("export anchors");
    let again = markdown_to_yjs("Guide", &exported.markdown).expect("reimport anchors");
    let again = markdown_native_targets(&again).expect("index roundtrip");
    for (anchor, text) in [
      ("top", "Guide"),
      ("paragraph", "Plain body"),
      ("item", "List body"),
      ("child", "Nested checklist"),
      ("instructions", "Code instructions"),
    ] {
      let target = resolve_markdown_target(&targets, &format!("^{anchor}")).expect("unique native block");
      assert_ne!(target.block_id, anchor, "source provenance is not a native ID");
      assert!(exported.markdown.contains(&format!("{text} ^{anchor}")));
      assert!(resolve_markdown_target(&again, &format!("^{anchor}")).is_ok());
      assert!(resolve_markdown_target(&again, "^literal").is_err());
    }
    for literal in ["literal", "code", "annotation"] {
      assert_eq!(
        resolve_markdown_target(&targets, &format!("^{literal}")),
        Err(MarkdownTargetError::Missing)
      );
    }
    assert!(exported.markdown.contains("Fenced ^literal"));
    assert!(exported.markdown.contains("`Inline ^code`"));
    assert!(exported.markdown.contains("%%Hidden ^annotation%%"));
    assert!(exported.markdown.contains("Escaped \\^literal"));
  }

  #[test]
  fn heading_paths_are_normalized_but_duplicate_targets_are_never_guessed() {
    let binary = markdown_to_yjs(
      "Paths",
      "# Über Größe\n\n## Résumé\n\nText ^repeated\n\n# Other\n\n## Résumé\n\nAnother ^repeated\n",
    )
    .expect("import heading paths");
    let targets = markdown_native_targets(&binary).expect("index paths");
    assert_eq!(
      resolve_markdown_target(&targets, "Résumé"),
      Err(MarkdownTargetError::Ambiguous)
    );
    assert_eq!(
      resolve_markdown_target(&targets, "^repeated"),
      Err(MarkdownTargetError::Ambiguous)
    );
    let heading = resolve_markdown_target(&targets, " über   GRÖßE # RÉSUMÉ ").expect("unique normalized path");
    assert_eq!(heading.heading_path.as_ref().unwrap(), &["Über Größe", "Résumé"]);
    assert_eq!(
      resolve_markdown_target(&targets, "^Repeated"),
      Err(MarkdownTargetError::Missing)
    );
    assert_eq!(
      resolve_markdown_target(&targets, "#"),
      Err(MarkdownTargetError::Invalid)
    );
  }

  #[test]
  fn source_tokens_require_unescaped_plain_trailing_boundaries() {
    assert_eq!(trailing_source_anchor("body ^valid-id\n"), Some("valid-id"));
    for source in [
      "body^not-anchor",
      "body \\^escaped",
      "body ^invalid_id",
      "body ^id trailing",
    ] {
      assert_eq!(trailing_source_anchor(source), None);
    }
    let binary = markdown_to_yjs(
      "Boundaries",
      "**Formatted ^not-anchor**\n\nText ^middle\ncontinued\n\nOnly ^final\n\n^standalone\n",
    )
    .expect("import boundaries");
    let targets = markdown_native_targets(&binary).expect("index boundaries");
    assert_eq!(
      resolve_markdown_target(&targets, "^not-anchor"),
      Err(MarkdownTargetError::Missing)
    );
    assert_eq!(
      resolve_markdown_target(&targets, "^middle"),
      Err(MarkdownTargetError::Missing)
    );
    assert!(resolve_markdown_target(&targets, "^final").is_ok());
    assert_eq!(
      resolve_markdown_target(&targets, "^standalone"),
      Err(MarkdownTargetError::Missing)
    );
  }

  #[test]
  fn renamed_or_detached_heading_is_resolved_from_the_current_tree() {
    let binary = markdown_to_yjs("Edits", "# Before ^keep\n\nBody\n").expect("import");
    let original = markdown_native_targets(&binary).expect("index");
    let id = resolve_markdown_target(&original, "Before")
      .expect("original heading")
      .block_id
      .clone();
    let doc = yrs::Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&binary).expect("decode"))
      .expect("load");
    {
      let mut txn = doc.transact_mut();
      let Some(yrs::Out::YMap(block)) = blocks.get(&txn, &id) else {
        panic!("heading exists")
      };
      let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
        panic!("heading text exists")
      };
      let length = text.len(&txn);
      text.remove_range(&mut txn, 0, length);
      text.insert(&mut txn, 0, "After");
    }
    let renamed = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
    let current = markdown_native_targets(&renamed).expect("index edited tree");
    assert_eq!(
      resolve_markdown_target(&current, "After")
        .expect("current heading")
        .block_id,
      id
    );
    assert_eq!(
      resolve_markdown_target(&current, "^keep")
        .expect("retained provenance")
        .block_id,
      id
    );
    assert_eq!(
      resolve_markdown_target(&current, "Before"),
      Err(MarkdownTargetError::Missing)
    );
    {
      let mut txn = doc.transact_mut();
      let values = blocks.iter(&txn).map(|(_, value)| value).collect::<Vec<_>>();
      for value in values {
        if let yrs::Out::YMap(block) = value
          && let Some(yrs::Out::YArray(children)) = block.get(&txn, "sys:children")
          && let Some(index) = children
            .iter(&txn)
            .position(|value| matches!(value, yrs::Out::Any(yrs::Any::String(value)) if value.as_ref() == id))
        {
          children.remove(&mut txn, index as u32);
        }
      }
    }
    let detached = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
    let targets = markdown_native_targets(&detached).expect("index without detached block");
    assert_eq!(
      resolve_markdown_target(&targets, "^keep"),
      Err(MarkdownTargetError::Missing)
    );
  }
}
