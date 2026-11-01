use crate::ir::{Block, PublicDocIr, WorkspaceIndex};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeoMetadata {
  pub title: String,
  pub description: String,
  pub canonical_url: String,
  pub noindex: bool,
}

pub fn build_document_seo(ir: &PublicDocIr, canonical_url: String, noindex: bool) -> SeoMetadata {
  let title = stable_title(&ir.document.title, "Untitled public document");
  SeoMetadata {
    title,
    description: truncate_description(&document_description(ir)),
    canonical_url,
    noindex,
  }
}

pub fn build_workspace_seo(index: &WorkspaceIndex, canonical_url: String, noindex: bool) -> SeoMetadata {
  let workspace_title = stable_title(&index.title, "Public workspace");
  let title = index.folder_title.as_ref().map_or_else(
    || workspace_title.clone(),
    |folder| format!("{folder} · {workspace_title}"),
  );
  let description = if !index.description.trim().is_empty() {
    index.description.clone()
  } else if let Some(introduction) = &index.introduction {
    document_description(introduction)
  } else if index.items.is_empty() {
    "Public Myoxus workspace".to_string()
  } else {
    let names = index
      .items
      .iter()
      .take(5)
      .map(|item| item.title.as_str())
      .collect::<Vec<_>>()
      .join(", ");
    format!("Public Myoxus workspace with {names}")
  };
  SeoMetadata {
    title,
    description: truncate_description(&description),
    canonical_url,
    noindex,
  }
}

pub fn truncate_description(value: &str) -> String {
  const MAX: usize = 180;
  let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
  if normalized.chars().count() <= MAX {
    return normalized;
  }
  let mut out = normalized.chars().take(MAX).collect::<String>();
  out.push_str("...");
  out
}

fn stable_title(value: &str, fallback: &str) -> String {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    fallback.to_string()
  } else {
    trimmed.to_string()
  }
}

fn document_description(ir: &PublicDocIr) -> String {
  description_from_blocks(&ir.document.blocks).unwrap_or_else(|| "Public Myoxus document".to_string())
}

fn description_from_blocks(blocks: &[Block]) -> Option<String> {
  for block in blocks {
    match block {
      Block::Paragraph { text, .. } | Block::Quote { text, .. } => {
        let value = text.iter().map(|part| part.text.as_str()).collect::<Vec<_>>().join("");
        if !value.trim().is_empty() {
          return Some(value);
        }
      }
      Block::Heading { text, .. } => {
        let value = text.iter().map(|part| part.text.as_str()).collect::<Vec<_>>().join("");
        if !value.trim().is_empty() {
          return Some(value);
        }
      }
      Block::Callout {
        title, text, children, ..
      } => {
        if let Some(title) = title.as_ref().filter(|title| !title.is_empty()) {
          return Some(title.clone());
        }
        let value = text.iter().map(|part| part.text.as_str()).collect::<Vec<_>>().join("");
        if !value.trim().is_empty() {
          return Some(value);
        }
        if let Some(value) = description_from_blocks(children) {
          return Some(value);
        }
      }
      Block::FootnoteDefinition { children, .. } => {
        if let Some(value) = description_from_blocks(children) {
          return Some(value);
        }
      }
      Block::Table { rows, .. } => {
        if let Some(value) = rows.iter().flatten().find_map(|cell| {
          let value = cell.iter().map(|part| part.text.as_str()).collect::<Vec<_>>().join("");
          (!value.trim().is_empty()).then_some(value)
        }) {
          return Some(value);
        }
      }
      _ => {}
    }
  }
  None
}

/// A bounded opening excerpt without public-page or title fallback semantics.
/// Shared with private OKF reads and indexed search summaries.
pub fn knowledge_excerpt(value: &str, title: &str) -> Option<String> {
  let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
  if value.is_empty() || value == title.split_whitespace().collect::<Vec<_>>().join(" ") {
    return None;
  }
  let end = value.char_indices().find_map(|(i, c)| {
    (matches!(c, '.' | '!' | '?')
      && value[..i].chars().count() < 180
      && value[i + c.len_utf8()..].chars().next().is_none_or(char::is_whitespace))
    .then_some(i + c.len_utf8())
  });
  Some(truncate_description(&value[..end.unwrap_or(value.len())]))
}

pub fn knowledge_document_excerpt(ir: &PublicDocIr, title: &str) -> Option<String> {
  fn first(blocks: &[Block], title: &str) -> Option<String> {
    for block in blocks {
      let text = match block {
        Block::Paragraph { text, .. } | Block::Quote { text, .. } => {
          Some(text.iter().map(|part| part.text.as_str()).collect::<String>())
        }
        Block::Callout { text, children, .. } => {
          let text = text.iter().map(|part| part.text.as_str()).collect::<String>();
          if let Some(value) = knowledge_excerpt(&text, title) {
            return Some(value);
          }
          if let Some(value) = first(children, title) {
            return Some(value);
          }
          None
        }
        _ => None,
      };
      if let Some(value) = text.and_then(|value| knowledge_excerpt(&value, title)) {
        return Some(value);
      }
    }
    None
  }
  first(&ir.document.blocks, title)
}
