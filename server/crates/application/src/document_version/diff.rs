// SPDX-License-Identifier: AGPL-3.0-or-later
//! Diff computation for user-visible document-version snapshots.
//!
//! The service consumes immutable `doc_histories.snapshot` bytes and returns a
//! stable block/text projection for GraphQL and future CLI/MCP callers. It does
//! not mutate document state and intentionally keeps renderer/export concerns
//! out of the contract.

use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};
use similar::{ChangeTag, TextDiff};
use thiserror::Error;
use tracing::{debug, instrument};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Error)]
pub enum DocumentVersionDiffError {
  #[error("failed to decode yjs snapshot: {0}")]
  Yjs(String),
  #[error("history comparison exceeds its {0} limit; compare a smaller document")]
  Limit(&'static str),
}

/// A bounded reading projection; runs never split a Unicode grapheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentTextRunKind {
  Unchanged,
  Added,
  Removed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentTextRun {
  pub kind: DocumentTextRunKind,
  pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentComparisonBlockKind {
  Unchanged,
  Added,
  Removed,
  Modified,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentComparisonBlock {
  pub block_id: String,
  pub kind: DocumentComparisonBlockKind,
  pub flavour: String,
  pub runs: Vec<DocumentTextRun>,
  /// False deletions have no unambiguous surviving native tree anchor.
  pub placement_known: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentComparisonNoticeKind {
  PresentationNotCompared,
  UnsupportedContent,
  PartialExtraction,
  IncompleteStructure,
  StructureChanged,
  AmbiguousRemovalAnchor,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentComparisonNotice {
  pub kind: DocumentComparisonNoticeKind,
  pub block_id: Option<String>,
}

const MAX_COMPARISON_BLOCKS: usize = 10_000;
const MAX_COMPARISON_DEPTH: usize = 128;
const MAX_DIFF_WORK: usize = 4_000_000;

/// Deterministic work admission instead of Similar's deadline approximation.
/// Exhaustion is an error, never a coarse successful edit sequence.
struct DiffBudget(usize);
impl DiffBudget {
  fn charge(&mut self, work: usize) -> Result<(), DocumentVersionDiffError> {
    self.0 = self
      .0
      .checked_sub(work)
      .ok_or(DocumentVersionDiffError::Limit("diff work"))?;
    Ok(())
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentVersionStateVectorDiff {
  pub from_state_vector_sha256: String,
  pub to_state_vector_sha256: String,
  pub changed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentVersionBlockDiffKind {
  Added,
  Removed,
  Modified,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentVersionBlockDiff {
  pub block_id: String,
  pub kind: DocumentVersionBlockDiffKind,
  pub from_flavour: Option<String>,
  pub to_flavour: Option<String>,
  pub from_text: Option<String>,
  pub to_text: Option<String>,
  pub from_children: Vec<String>,
  pub to_children: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentVersionTextDiff {
  pub block_id: String,
  pub from_text: String,
  pub to_text: String,
  pub removed_lines: Vec<String>,
  pub added_lines: Vec<String>,
  pub removed_words: Vec<String>,
  pub added_words: Vec<String>,
  pub runs: Vec<DocumentTextRun>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentVersionDiff {
  pub state_vector: DocumentVersionStateVectorDiff,
  pub block_diffs: Vec<DocumentVersionBlockDiff>,
  pub text_diffs: Vec<DocumentVersionTextDiff>,
  pub from_block_count: i32,
  pub to_block_count: i32,
  pub extraction_partial: bool,
  pub comparison_blocks: Vec<DocumentComparisonBlock>,
  pub notices: Vec<DocumentComparisonNotice>,
}

#[instrument(skip(from_snapshot, to_snapshot), level = "debug")]
pub fn diff_snapshots(
  from_snapshot: &[u8],
  to_snapshot: &[u8],
) -> Result<DocumentVersionDiff, DocumentVersionDiffError> {
  if from_snapshot.len() > crate::doc::write::DEFAULT_EXTERNAL_UPDATE_MAX_BYTES
    || to_snapshot.len() > crate::doc::write::DEFAULT_EXTERNAL_UPDATE_MAX_BYTES
  {
    return Err(DocumentVersionDiffError::Limit("materialization bytes"));
  }
  let from_state_vector = yjs::get_state_vector(from_snapshot).map_err(DocumentVersionDiffError::Yjs)?;
  let to_state_vector = yjs::get_state_vector(to_snapshot).map_err(DocumentVersionDiffError::Yjs)?;
  let from_blocks = yjs::extract_blocks_from_yjs(from_snapshot).map_err(DocumentVersionDiffError::Yjs)?;
  let to_blocks = yjs::extract_blocks_from_yjs(to_snapshot).map_err(DocumentVersionDiffError::Yjs)?;

  let from_by_id: BTreeMap<String, yjs::YjsBlockInfo> = from_blocks
    .blocks
    .iter()
    .cloned()
    .map(|block| (block.id.clone(), block))
    .collect();
  let to_by_id: BTreeMap<String, yjs::YjsBlockInfo> = to_blocks
    .blocks
    .iter()
    .cloned()
    .map(|block| (block.id.clone(), block))
    .collect();
  let all_ids: BTreeSet<String> = from_by_id.keys().chain(to_by_id.keys()).cloned().collect();
  if all_ids.len() > MAX_COMPARISON_BLOCKS {
    return Err(DocumentVersionDiffError::Limit("block count"));
  }
  let text_bytes: usize = from_blocks
    .blocks
    .iter()
    .chain(&to_blocks.blocks)
    .map(|block| block.text.len().max(block.plain_text.len()))
    .sum();
  if text_bytes > crate::doc::DEFAULT_DOCUMENT_EXPORT_MAX_BYTES {
    return Err(DocumentVersionDiffError::Limit("extracted text bytes"));
  }
  let mut budget = DiffBudget(MAX_DIFF_WORK);
  let mut projected = BTreeMap::new();

  let mut block_diffs = Vec::new();
  let mut text_diffs = Vec::new();
  for block_id in all_ids {
    let from = from_by_id.get(&block_id);
    let to = to_by_id.get(&block_id);
    let runs = ordered_text_runs(
      from.map_or("", |block| block.plain_text.as_str()),
      to.map_or("", |block| block.plain_text.as_str()),
      &mut budget,
    )?;
    projected.insert(
      block_id.clone(),
      DocumentComparisonBlock {
        block_id: block_id.clone(),
        kind: match (from, to) {
          (None, Some(_)) => DocumentComparisonBlockKind::Added,
          (Some(_), None) => DocumentComparisonBlockKind::Removed,
          (Some(a), Some(b)) if block_changed(a, b) => DocumentComparisonBlockKind::Modified,
          _ => DocumentComparisonBlockKind::Unchanged,
        },
        flavour: to.or(from).expect("union block identity").flavour.clone(),
        runs: runs.clone(),
        placement_known: true,
      },
    );
    match (from_by_id.get(&block_id), to_by_id.get(&block_id)) {
      (None, Some(to)) => block_diffs.push(DocumentVersionBlockDiff {
        block_id,
        kind: DocumentVersionBlockDiffKind::Added,
        from_flavour: None,
        to_flavour: Some(to.flavour.clone()),
        from_text: None,
        to_text: Some(to.text.clone()),
        from_children: Vec::new(),
        to_children: to.children_ids.clone(),
      }),
      (Some(from), None) => block_diffs.push(DocumentVersionBlockDiff {
        block_id,
        kind: DocumentVersionBlockDiffKind::Removed,
        from_flavour: Some(from.flavour.clone()),
        to_flavour: None,
        from_text: Some(from.text.clone()),
        to_text: None,
        from_children: from.children_ids.clone(),
        to_children: Vec::new(),
      }),
      (Some(from), Some(to)) if block_changed(from, to) => {
        if from.text != to.text {
          let summary_runs = if from.text == from.plain_text && to.text == to.plain_text {
            runs
          } else {
            ordered_text_runs(&from.text, &to.text, &mut budget)?
          };
          text_diffs.push(diff_text_block(&block_id, &from.text, &to.text, summary_runs));
        }
        block_diffs.push(DocumentVersionBlockDiff {
          block_id,
          kind: DocumentVersionBlockDiffKind::Modified,
          from_flavour: Some(from.flavour.clone()),
          to_flavour: Some(to.flavour.clone()),
          from_text: Some(from.text.clone()),
          to_text: Some(to.text.clone()),
          from_children: from.children_ids.clone(),
          to_children: to.children_ids.clone(),
        });
      }
      _ => {}
    }
  }
  let mut notices = vec![DocumentComparisonNotice {
    kind: DocumentComparisonNoticeKind::PresentationNotCompared,
    block_id: None,
  }];
  let (comparison_blocks, structural_partial) =
    ordered_comparison_blocks(&from_by_id, &to_by_id, projected, &mut notices, &mut budget)?;
  let mut unsupported = BTreeSet::new();
  for block in from_by_id.values().chain(to_by_id.values()) {
    if !matches!(
      block.flavour.as_str(),
      "myoxus:page"
        | "myoxus:note"
        | "myoxus:paragraph"
        | "myoxus:list"
        | "myoxus:code"
        | "myoxus:quote"
        | "myoxus:heading"
        | "myoxus:divider"
    ) {
      let notice = DocumentComparisonNotice {
        kind: DocumentComparisonNoticeKind::UnsupportedContent,
        block_id: Some(block.id.clone()),
      };
      if unsupported.insert(block.id.clone()) {
        notices.push(notice);
      }
    }
  }
  let extraction_partial = from_blocks.extraction_partial
    || to_blocks.extraction_partial
    || structural_partial
    || notices
      .iter()
      .any(|notice| notice.kind == DocumentComparisonNoticeKind::UnsupportedContent);
  if extraction_partial {
    notices.push(DocumentComparisonNotice {
      kind: DocumentComparisonNoticeKind::PartialExtraction,
      block_id: None,
    });
  }

  debug!(
    from_blocks = from_blocks.blocks.len(),
    to_blocks = to_blocks.blocks.len(),
    block_diffs = block_diffs.len(),
    text_diffs = text_diffs.len(),
    state_vector_changed = from_state_vector != to_state_vector,
    extraction_partial,
    "document version diff computed"
  );

  Ok(DocumentVersionDiff {
    state_vector: DocumentVersionStateVectorDiff {
      from_state_vector_sha256: sha256_hex(&from_state_vector),
      to_state_vector_sha256: sha256_hex(&to_state_vector),
      changed: from_state_vector != to_state_vector,
    },
    block_diffs,
    text_diffs,
    from_block_count: from_blocks.blocks.len() as i32,
    to_block_count: to_blocks.blocks.len() as i32,
    extraction_partial,
    comparison_blocks,
    notices,
  })
}

fn block_changed(from: &yjs::YjsBlockInfo, to: &yjs::YjsBlockInfo) -> bool {
  from.flavour != to.flavour
    || from.text != to.text
    || from.plain_text != to.plain_text
    || from.children_ids != to.children_ids
}

fn diff_text_block(
  block_id: &str,
  from_text: &str,
  to_text: &str,
  runs: Vec<DocumentTextRun>,
) -> DocumentVersionTextDiff {
  // Preserve deployed whole-word/line summaries with ordered Similar edits.
  // The readable projection is the lossless grapheme run sequence above.
  let lines = TextDiff::from_lines(from_text, to_text);
  let words = TextDiff::from_words(from_text, to_text);
  let summary = |tag| {
    lines
      .iter_all_changes()
      .filter(|change| change.tag() == tag)
      .map(|change| change.value().trim_end_matches(['\r', '\n']).to_owned())
      .collect()
  };
  DocumentVersionTextDiff {
    block_id: block_id.to_string(),
    from_text: from_text.to_string(),
    to_text: to_text.to_string(),
    removed_lines: summary(ChangeTag::Delete),
    added_lines: summary(ChangeTag::Insert),
    removed_words: words
      .iter_all_changes()
      .filter(|change| change.tag() == ChangeTag::Delete)
      .flat_map(|change| change.value().split_whitespace().map(str::to_owned))
      .collect(),
    added_words: words
      .iter_all_changes()
      .filter(|change| change.tag() == ChangeTag::Insert)
      .flat_map(|change| change.value().split_whitespace().map(str::to_owned))
      .collect(),
    runs,
  }
}

fn append_run(runs: &mut Vec<DocumentTextRun>, kind: DocumentTextRunKind, text: &str) {
  if text.is_empty() {
    return;
  }
  if let Some(last) = runs.last_mut().filter(|run| run.kind == kind) {
    last.text.push_str(text);
  } else {
    runs.push(DocumentTextRun {
      kind,
      text: text.to_owned(),
    });
  }
}

fn ordered_text_runs(
  from: &str,
  to: &str,
  budget: &mut DiffBudget,
) -> Result<Vec<DocumentTextRun>, DocumentVersionDiffError> {
  let mut runs = Vec::new();
  if from == to {
    append_run(&mut runs, DocumentTextRunKind::Unchanged, from);
    return Ok(runs);
  }
  budget.charge(from.len().saturating_add(to.len()))?;
  let old: Vec<&str> = from.graphemes(true).collect();
  let new: Vec<&str> = to.graphemes(true).collect();
  // Admission discounts equal boundaries; Similar still owns every edit.
  // This keeps a small edit in a long paragraph from exhausting the work bound.
  let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
  let suffix = old[prefix..]
    .iter()
    .rev()
    .zip(new[prefix..].iter().rev())
    .take_while(|(a, b)| a == b)
    .count();
  let old_middle = &old[prefix..old.len() - suffix];
  let new_middle = &new[prefix..new.len() - suffix];
  let work = old_middle
    .len()
    .checked_mul(new_middle.len())
    .and_then(|work| work.checked_add(old_middle.len() + new_middle.len()))
    .ok_or(DocumentVersionDiffError::Limit("diff work"))?;
  budget.charge(work)?;
  append_run(&mut runs, DocumentTextRunKind::Unchanged, &old[..prefix].concat());
  for change in TextDiff::configure()
    .diff_slices(old_middle, new_middle)
    .iter_all_changes()
  {
    append_run(
      &mut runs,
      match change.tag() {
        ChangeTag::Equal => DocumentTextRunKind::Unchanged,
        ChangeTag::Insert => DocumentTextRunKind::Added,
        ChangeTag::Delete => DocumentTextRunKind::Removed,
      },
      change.value(),
    );
  }
  append_run(
    &mut runs,
    DocumentTextRunKind::Unchanged,
    &old[old.len() - suffix..].concat(),
  );
  Ok(runs)
}

#[derive(Default)]
struct NativeOrder {
  order: Vec<String>,
  parents: BTreeMap<String, String>,
  positions: BTreeMap<String, usize>,
  subtree_ends: BTreeMap<String, usize>,
  incomplete: bool,
}

fn native_order(
  blocks: &BTreeMap<String, yjs::YjsBlockInfo>,
  budget: &mut DiffBudget,
) -> Result<NativeOrder, DocumentVersionDiffError> {
  let mut tree = NativeOrder::default();
  let roots: Vec<_> = blocks.values().filter(|block| block.flavour == "myoxus:page").collect();
  if roots.len() != 1 {
    tree.incomplete = !blocks.is_empty();
    return Ok(tree);
  }
  let mut visited = BTreeSet::new();
  let mut stack = vec![(roots[0].id.clone(), None::<String>, 0, false)];
  while let Some((id, parent, depth, exit)) = stack.pop() {
    budget.charge(1)?;
    if exit {
      tree.subtree_ends.insert(id, tree.order.len());
      continue;
    }
    let Some(block) = blocks.get(&id) else {
      tree.incomplete = true;
      continue;
    };
    if depth > MAX_COMPARISON_DEPTH || !visited.insert(id.clone()) {
      tree.incomplete = true;
      continue;
    }
    if let Some(parent) = &parent {
      tree.parents.insert(id.clone(), parent.clone());
    }
    tree.positions.insert(id.clone(), tree.order.len());
    tree.order.push(id.clone());
    stack.push((id.clone(), parent, depth, true));
    budget.charge(block.children_ids.len())?;
    for child in block.children_ids.iter().rev() {
      stack.push((child.clone(), Some(id.clone()), depth + 1, false));
    }
  }
  tree.incomplete |= visited.len() != blocks.len();
  Ok(tree)
}

/// A removed subtree uses its historical sibling anchor under a surviving
/// parent. Reordered or missing anchors remain explicitly unplaced.
fn removal_slot(
  id: &str,
  from: &NativeOrder,
  to: &NativeOrder,
  from_blocks: &BTreeMap<String, yjs::YjsBlockInfo>,
  to_blocks: &BTreeMap<String, yjs::YjsBlockInfo>,
  budget: &mut DiffBudget,
) -> Result<Option<usize>, DocumentVersionDiffError> {
  let mut branch = id;
  let mut parent = from.parents.get(branch);
  while let Some(ancestor) = parent {
    budget.charge(1)?;
    if to.positions.contains_key(ancestor) {
      break;
    }
    branch = ancestor;
    parent = from.parents.get(branch);
  }
  let Some(parent) = parent else {
    return Ok(None);
  };
  let siblings = &from_blocks[parent].children_ids;
  budget.charge(siblings.len())?;
  let Some(index) = siblings.iter().position(|sibling| sibling == branch) else {
    return Ok(None);
  };
  let valid = |sibling: &&String| to.parents.get(*sibling) == Some(parent);
  let previous = siblings[..index]
    .iter()
    .rev()
    .find(valid)
    .and_then(|id| to.subtree_ends.get(id))
    .copied();
  let next = siblings[index + 1..]
    .iter()
    .find(valid)
    .and_then(|id| to.positions.get(id))
    .copied();
  match (previous, next) {
    (Some(previous), Some(next)) if previous > next => Ok(None),
    (_, Some(next)) => Ok(Some(next)),
    (Some(previous), None) => Ok(Some(previous)),
    _ if to_blocks[parent].children_ids.is_empty() => Ok(Some(to.positions[parent] + 1)),
    _ => Ok(None),
  }
}

fn ordered_comparison_blocks(
  from: &BTreeMap<String, yjs::YjsBlockInfo>,
  to: &BTreeMap<String, yjs::YjsBlockInfo>,
  mut projected: BTreeMap<String, DocumentComparisonBlock>,
  notices: &mut Vec<DocumentComparisonNotice>,
  budget: &mut DiffBudget,
) -> Result<(Vec<DocumentComparisonBlock>, bool), DocumentVersionDiffError> {
  let old_tree = native_order(from, budget)?;
  let current_tree = native_order(to, budget)?;
  let incomplete = old_tree.incomplete || current_tree.incomplete;
  if incomplete {
    notices.push(DocumentComparisonNotice {
      kind: DocumentComparisonNoticeKind::IncompleteStructure,
      block_id: None,
    });
  }
  for (id, old) in from {
    if let Some(current) = to.get(id) {
      if old.flavour != current.flavour
        || old.children_ids != current.children_ids
        || old_tree.parents.get(id) != current_tree.parents.get(id)
      {
        notices.push(DocumentComparisonNotice {
          kind: DocumentComparisonNoticeKind::StructureChanged,
          block_id: Some(id.clone()),
        });
      }
    }
  }
  let mut slots = vec![Vec::new(); current_tree.order.len() + 1];
  let mut unplaced = Vec::new();
  for id in &old_tree.order {
    if to.contains_key(id) {
      continue;
    }
    if let Some(slot) = removal_slot(id, &old_tree, &current_tree, from, to, budget)? {
      slots[slot].push(id.clone());
    } else {
      notices.push(DocumentComparisonNotice {
        kind: DocumentComparisonNoticeKind::AmbiguousRemovalAnchor,
        block_id: Some(id.clone()),
      });
      unplaced.push(id.clone());
    }
  }
  let mut ordered = Vec::new();
  for (index, ids) in slots.into_iter().enumerate() {
    for id in ids {
      if let Some(block) = projected.remove(&id) {
        ordered.push(block);
      }
    }
    if let Some(id) = current_tree.order.get(index) {
      if let Some(block) = projected.remove(id) {
        ordered.push(block);
      }
    }
  }
  // These are identified deletions, not an invented position in current prose.
  for id in unplaced {
    if let Some(mut block) = projected.remove(&id) {
      block.placement_known = false;
      ordered.push(block);
    }
  }
  Ok((ordered, incomplete))
}

fn sha256_hex(bytes: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  hex::encode(hasher.finalize())
}
