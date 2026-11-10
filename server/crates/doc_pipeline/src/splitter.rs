//! Text splitting and token counting for the document pipeline.
//!
//! Provides token-aware text chunking using [`text_splitter`] with tiktoken
//! tokenizers. Supports both plain-text and Markdown-aware splitting that
//! respects heading boundaries.

use crate::types::{ChunkType, TextChunk};

/// Which tiktoken tokenizer model to use for token counting and splitting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TokenizerModel {
  /// OpenAI `cl100k_base` — used by text-embedding-3-small/large, GPT-4,
  /// GPT-3.5-turbo.
  #[default]
  Cl100kBase,
  /// OpenAI `o200k_base` — used by GPT-4o, o1, o3.
  O200kBase,
}

/// Configuration for the text splitter.
#[derive(Debug, Clone)]
pub struct SplitConfig {
  /// Maximum number of tokens per chunk (default: 512).
  pub max_chunk_tokens: usize,
  /// Number of overlapping tokens between consecutive chunks (default: 50).
  pub overlap_tokens: usize,
  /// Which tokenizer model to use (default: Cl100kBase).
  pub model: TokenizerModel,
}

impl Default for SplitConfig {
  fn default() -> Self {
    Self {
      max_chunk_tokens: 512,
      overlap_tokens: 50,
      model: TokenizerModel::Cl100kBase,
    }
  }
}

/// Reuse each model's process-local vocabulary. Sizing and counting retain
/// their existing ordinary/special-token encoding modes.
fn get_bpe(model: &TokenizerModel) -> &'static tiktoken_rs::CoreBPE {
  match model {
    TokenizerModel::Cl100kBase => tiktoken_rs::cl100k_base_singleton(),
    TokenizerModel::O200kBase => tiktoken_rs::o200k_base_singleton(),
  }
}

/// Count the number of tokens in `text` using the given tokenizer model.
pub fn count_tokens(text: &str, model: &TokenizerModel) -> usize {
  let bpe = get_bpe(model);
  bpe.encode_with_special_tokens(text).len()
}

/// Split plain text into token-bounded chunks with overlap.
///
/// Uses [`text_splitter::TextSplitter`] with a tiktoken sizer so that chunk
/// boundaries fall on semantic boundaries (paragraphs > sentences > words)
/// while respecting the token budget.
pub fn split_text(text: &str, config: &SplitConfig) -> Vec<TextChunk> {
  if text.is_empty() {
    return vec![];
  }

  let bpe = get_bpe(&config.model);

  let chunk_config = text_splitter::ChunkConfig::new(config.max_chunk_tokens)
    .with_sizer(bpe)
    .with_overlap(config.overlap_tokens)
    .expect("overlap must be < max_chunk_tokens");

  let splitter = text_splitter::TextSplitter::new(chunk_config);

  splitter
    .chunks(text)
    .enumerate()
    .map(|(idx, chunk_text)| {
      let start_offset = byte_offset_in(text, chunk_text);
      let token_count = count_tokens(chunk_text, &config.model);

      TextChunk {
        content: chunk_text.to_owned(),
        index: idx,
        start_offset: Some(start_offset),
        end_offset: Some(start_offset + chunk_text.len()),
        token_count: Some(token_count),
        chunk_type: ChunkType::Text,
      }
    })
    .collect()
}

/// Split Markdown text into token-bounded chunks respecting heading boundaries.
///
/// Uses [`text_splitter::MarkdownSplitter`] which parses CommonMark structure
/// and avoids splitting in the middle of a headed section when possible.
pub fn split_markdown(text: &str, config: &SplitConfig) -> Vec<TextChunk> {
  if text.is_empty() {
    return vec![];
  }

  let bpe = get_bpe(&config.model);

  let chunk_config = text_splitter::ChunkConfig::new(config.max_chunk_tokens)
    .with_sizer(bpe)
    .with_overlap(config.overlap_tokens)
    .expect("overlap must be < max_chunk_tokens");

  let splitter = text_splitter::MarkdownSplitter::new(chunk_config);

  splitter
    .chunks(text)
    .enumerate()
    .map(|(idx, chunk_text)| {
      let start_offset = byte_offset_in(text, chunk_text);
      let token_count = count_tokens(chunk_text, &config.model);

      // Detect whether this chunk starts with a heading.
      let chunk_type = if chunk_text.trim_start().starts_with('#') {
        ChunkType::Heading
      } else {
        ChunkType::Text
      };

      TextChunk {
        content: chunk_text.to_owned(),
        index: idx,
        start_offset: Some(start_offset),
        end_offset: Some(start_offset + chunk_text.len()),
        token_count: Some(token_count),
        chunk_type,
      }
    })
    .collect()
}

/// Compute the byte offset of a sub-slice within the parent string.
///
/// `text_splitter` returns `&str` slices that borrow from the input, so
/// pointer arithmetic gives us the offset without scanning.
fn byte_offset_in(parent: &str, sub: &str) -> usize {
  let parent_start = parent.as_ptr() as usize;
  let sub_start = sub.as_ptr() as usize;
  debug_assert!(
    sub_start >= parent_start && sub_start <= parent_start + parent.len(),
    "sub-slice is not within parent"
  );
  sub_start - parent_start
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;

  fn default_config() -> SplitConfig {
    SplitConfig {
      max_chunk_tokens: 512,
      overlap_tokens: 50,
      model: TokenizerModel::Cl100kBase,
    }
  }

  #[test]
  fn short_text_single_chunk() {
    let text = "Hello, world! This is a short sentence.";
    let chunks = split_text(text, &default_config());
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].content, text);
    assert!(chunks[0].token_count.unwrap() < 512);
  }

  #[test]
  fn long_text_multiple_chunks() {
    // Build a text that exceeds 512 tokens.
    let sentence = "The quick brown fox jumps over the lazy dog. ";
    let text: String = sentence.repeat(200);

    let config = SplitConfig {
      max_chunk_tokens: 100,
      overlap_tokens: 10,
      model: TokenizerModel::Cl100kBase,
    };
    let chunks = split_text(&text, &config);

    assert!(chunks.len() > 1, "should produce multiple chunks");
    for chunk in &chunks {
      assert!(
        chunk.token_count.unwrap() <= 100,
        "chunk {} has {} tokens, exceeds max 100",
        chunk.index,
        chunk.token_count.unwrap()
      );
    }
    // Verify chunk indices are sequential.
    for (i, chunk) in chunks.iter().enumerate() {
      assert_eq!(chunk.index, i);
    }
  }

  #[test]
  fn token_count_matches_tiktoken() {
    let text = "fn main() { println!(\"hello world\"); }";
    let count = count_tokens(text, &TokenizerModel::Cl100kBase);
    // Verify against a direct tiktoken call.
    let bpe = tiktoken_rs::cl100k_base().unwrap();
    let expected = bpe.encode_with_special_tokens(text).len();
    assert_eq!(count, expected);
  }

  #[test]
  fn markdown_heading_boundaries() {
    let md = "\
## Introduction

This is the introduction paragraph with enough content to test.

## Methods

Description of the methods section with substantial text.

## Results

The results are presented here with data analysis.
";
    let config = SplitConfig {
      max_chunk_tokens: 512,
      overlap_tokens: 0,
      model: TokenizerModel::Cl100kBase,
    };
    let _chunks = split_markdown(md, &config);

    // With a generous token limit, the entire doc fits in one chunk.
    // Use a smaller limit to force splits at heading boundaries.
    let small_config = SplitConfig {
      max_chunk_tokens: 20,
      overlap_tokens: 0,
      model: TokenizerModel::Cl100kBase,
    };
    let chunks_small = split_markdown(md, &small_config);
    assert!(chunks_small.len() > 1, "should split markdown into multiple chunks");

    // At least one chunk should start with a heading marker.
    let has_heading = chunks_small.iter().any(|c| c.chunk_type == ChunkType::Heading);
    assert!(has_heading, "at least one chunk should be a Heading type");
  }

  #[test]
  fn overlap_present_between_chunks() {
    let sentence = "The quick brown fox jumps over the lazy dog. ";
    let text: String = sentence.repeat(100);

    let config = SplitConfig {
      max_chunk_tokens: 50,
      overlap_tokens: 10,
      model: TokenizerModel::Cl100kBase,
    };
    let chunks = split_text(&text, &config);

    assert!(chunks.len() >= 2, "need at least two chunks for overlap test");

    // With overlap, consecutive chunks should share some trailing/leading
    // content. We verify by checking that the end of chunk[i] overlaps
    // textually with the beginning of chunk[i+1].
    let mut found_overlap = false;
    for pair in chunks.windows(2) {
      let tail = &pair[0].content;
      let head = &pair[1].content;
      // Check if last 20 chars of chunk i appear somewhere in chunk i+1.
      if tail.len() >= 20 {
        let suffix = &tail[tail.len() - 20..];
        if head.contains(suffix) {
          found_overlap = true;
          break;
        }
      }
    }
    assert!(found_overlap, "consecutive chunks should share overlapping text");
  }

  #[test]
  fn empty_text_no_chunks() {
    let chunks = split_text("", &default_config());
    assert!(chunks.is_empty());
  }

  #[test]
  fn o200k_model_works() {
    let text = "Testing the o200k_base tokenizer model.";
    let count = count_tokens(text, &TokenizerModel::O200kBase);
    assert!(count > 0);
    let config = SplitConfig {
      max_chunk_tokens: 512,
      overlap_tokens: 0,
      model: TokenizerModel::O200kBase,
    };
    let chunks = split_text(text, &config);
    assert_eq!(chunks.len(), 1);
  }

  #[test]
  fn offsets_are_valid() {
    let text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    let config = SplitConfig {
      max_chunk_tokens: 10,
      overlap_tokens: 0,
      model: TokenizerModel::Cl100kBase,
    };
    let chunks = split_text(text, &config);
    for chunk in &chunks {
      let start = chunk.start_offset.unwrap();
      let end = chunk.end_offset.unwrap();
      assert!(end <= text.len(), "end offset out of bounds");
      assert!(start <= end, "start > end");
      // The content should match the slice of the original text
      // (after trimming, text-splitter may trim whitespace).
      assert!(
        text[start..end].contains(chunk.content.trim()),
        "chunk content not found at stated offsets"
      );
    }
  }
}
