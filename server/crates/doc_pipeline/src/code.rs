//! Source-code parser backed by [tree-sitter](https://tree-sitter.github.io/).
//!
//! # AST-based chunking strategy
//!
//! Instead of splitting source files on arbitrary line boundaries, this module
//! parses the file into a concrete syntax tree (CST) and extracts **top-level
//! constructs** — functions, structs, classes, impl blocks, etc. — as
//! individual [`TextChunk`]s.  This gives downstream consumers (search index,
//! embedding pipeline) semantically coherent units rather than arbitrary
//! fragments.
//!
//! ## Per-language node kinds
//!
//! | Language   | Extracted node kinds                                                       |
//! |------------|----------------------------------------------------------------------------|
//! | Rust       | `function_item`, `impl_item`, `struct_item`, `enum_item`, `mod_item`       |
//! | JS         | `function_declaration`, `class_declaration`, `method_definition`           |
//! | TypeScript | same as JS (shared grammar lineage)                                       |
//! | Python     | `function_definition`, `class_definition`                                 |
//! | Go         | `function_declaration`, `method_declaration`                               |
//! | C          | `function_definition`, `struct_specifier`                                 |
//! | C++        | `function_definition`, `struct_specifier`                                 |
//!
//! ## Small-function grouping
//!
//! Functions shorter than [`DEFAULT_MIN_CHUNK_LINES`] lines are **not** split
//! into their own chunk.  They are instead accumulated into a single "grouped
//! small items" chunk, keeping the total chunk count manageable for very
//! granular codebases.
//!
//! ## Fallback
//!
//! If the file extension is unrecognised **or** tree-sitter fails to parse the
//! file, the entire content is returned as a single [`ChunkType::Text`]
//! chunk.  This ensures the pipeline never drops data.
//!
//! # Feature gate
//!
//! This module is only compiled when the **`code`** Cargo feature is enabled.

use std::collections::HashMap;

use tracing::{debug, trace, warn};
use tree_sitter::{Language, Node, Parser};

use crate::error::{PipelineError, Result};
use crate::types::{ChunkType, DocumentFormat, ParsedDocument, TextChunk};

/// Minimum number of lines a top-level item must span to be emitted as its
/// own chunk.  Items shorter than this threshold are grouped together.
pub const DEFAULT_MIN_CHUNK_LINES: usize = 5;

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/// A recognised source language with its tree-sitter grammar and the set of
/// AST node kinds we extract as top-level chunks.
struct LangInfo {
  /// Human-readable name (e.g. `"rust"`).
  name: &'static str,
  /// The tree-sitter [`Language`] grammar.
  language: Language,
  /// Node kinds to extract from the **root** of the CST.
  top_level_kinds: &'static [&'static str],
}

/// Detect the programming language from the file extension and return
/// grammar metadata.
///
/// Returns `None` for unrecognised extensions.
fn detect_language(filename: &str) -> Option<LangInfo> {
  let ext = filename.rsplit('.').next()?;
  let info = match ext {
    "rs" => LangInfo {
      name: "rust",
      language: tree_sitter_rust::LANGUAGE.into(),
      top_level_kinds: &["function_item", "impl_item", "struct_item", "enum_item", "mod_item"],
    },
    "js" | "mjs" | "cjs" => LangInfo {
      name: "javascript",
      language: tree_sitter_javascript::LANGUAGE.into(),
      top_level_kinds: &["function_declaration", "class_declaration", "method_definition"],
    },
    "ts" | "mts" | "cts" => LangInfo {
      name: "typescript",
      language: tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
      top_level_kinds: &["function_declaration", "class_declaration", "method_definition"],
    },
    "tsx" => LangInfo {
      name: "typescript",
      language: tree_sitter_typescript::LANGUAGE_TSX.into(),
      top_level_kinds: &["function_declaration", "class_declaration", "method_definition"],
    },
    "py" => LangInfo {
      name: "python",
      language: tree_sitter_python::LANGUAGE.into(),
      top_level_kinds: &["function_definition", "class_definition"],
    },
    "go" => LangInfo {
      name: "go",
      language: tree_sitter_go::LANGUAGE.into(),
      top_level_kinds: &["function_declaration", "method_declaration"],
    },
    "c" | "h" => LangInfo {
      name: "c",
      language: tree_sitter_c::LANGUAGE.into(),
      top_level_kinds: &["function_definition", "struct_specifier"],
    },
    "cpp" | "cc" | "cxx" | "hpp" => LangInfo {
      name: "cpp",
      language: tree_sitter_cpp::LANGUAGE.into(),
      top_level_kinds: &["function_definition", "struct_specifier"],
    },
    _ => return None,
  };
  debug!(language = info.name, extension = ext, "detected source language");
  Some(info)
}

// ---------------------------------------------------------------------------
// Node text extraction
// ---------------------------------------------------------------------------

/// Extract the UTF-8 text that a CST node spans from the original source
/// bytes.
///
/// Returns an empty string (and logs a warning) if the byte range is not
/// valid UTF-8.
fn node_text<'a>(node: &Node<'_>, source: &'a [u8]) -> &'a str {
  let start = node.start_byte();
  let end = node.end_byte();
  match std::str::from_utf8(&source[start..end]) {
    Ok(s) => s,
    Err(e) => {
      warn!(
          start_byte = start,
          end_byte = end,
          error = %e,
          "node byte range is not valid UTF-8; returning empty string",
      );
      ""
    }
  }
}

/// Try to extract a human-readable name for a CST node.
///
/// Heuristic: look for the first `identifier` or `name` child.  Falls back
/// to the node kind itself.
fn node_label(node: &Node<'_>, source: &[u8]) -> String {
  let mut cursor = node.walk();
  for child in node.named_children(&mut cursor) {
    let kind = child.kind();
    if kind == "identifier" || kind == "name" || kind == "type_identifier" || kind == "property_identifier" {
      let text = node_text(&child, source);
      if !text.is_empty() {
        return text.to_owned();
      }
    }
  }
  node.kind().to_owned()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse a source-code file into structured [`TextChunk`]s using tree-sitter.
///
/// `data` is the raw file content and `filename` is used for language
/// detection (only the extension matters).  Top-level AST constructs are
/// emitted as individual chunks; items shorter than
/// [`DEFAULT_MIN_CHUNK_LINES`] are grouped together.
///
/// If the language is unrecognised or parsing fails, the entire content is
/// returned as a single plain-text chunk.
pub fn parse_source_code(data: &[u8], filename: &str) -> Result<ParsedDocument> {
  parse_source_code_with_threshold(data, filename, DEFAULT_MIN_CHUNK_LINES)
}

/// Like [`parse_source_code`] but with a configurable minimum-chunk-lines
/// threshold.
pub fn parse_source_code_with_threshold(data: &[u8], filename: &str, min_chunk_lines: usize) -> Result<ParsedDocument> {
  let Some(lang_info) = detect_language(filename) else {
    debug!(filename, "unknown extension — falling back to plain text");
    return Ok(plain_text_fallback(data, filename));
  };

  let mut parser = Parser::new();
  parser
    .set_language(&lang_info.language)
    .map_err(|e| PipelineError::ParseError(format!("failed to set tree-sitter language: {e}")))?;

  let tree = match parser.parse(data, None) {
    Some(t) => t,
    None => {
      warn!(
        filename,
        language = lang_info.name,
        "tree-sitter parse returned None — falling back to plain text",
      );
      return Ok(plain_text_fallback(data, filename));
    }
  };

  let root = tree.root_node();
  if root.has_error() {
    warn!(
      filename,
      language = lang_info.name,
      "tree-sitter CST contains error nodes — proceeding with best-effort extraction",
    );
  }

  // Collect raw extracted items, then we build the final chunks with
  // correct indices and offsets.
  struct RawItem {
    content: String,
    start_byte: usize,
    #[allow(dead_code)]
    end_byte: usize,
    label: String,
  }

  let mut large_items: Vec<RawItem> = Vec::new();
  let mut small_items: Vec<RawItem> = Vec::new();

  let mut cursor = root.walk();
  for child in root.named_children(&mut cursor) {
    let kind = child.kind();
    if !lang_info.top_level_kinds.contains(&kind) {
      continue;
    }

    let text = node_text(&child, data);
    if text.is_empty() {
      continue;
    }

    let label = node_label(&child, data);
    let start_line = child.start_position().row;
    let end_line = child.end_position().row;
    let line_count = end_line.saturating_sub(start_line) + 1;

    trace!(
        label = %label,
        kind,
        start_line,
        end_line,
        line_count,
        "extracted top-level item",
    );

    let item = RawItem {
      content: text.to_owned(),
      start_byte: child.start_byte(),
      end_byte: child.end_byte(),
      label,
    };

    if line_count < min_chunk_lines {
      small_items.push(item);
    } else {
      large_items.push(item);
    }
  }

  // Build the final ordered chunk list.  We interleave large items at
  // their natural position and group small items.
  let mut all_items: Vec<(usize, String)> = Vec::new(); // (start_byte, content)

  // Group all small items into one merged chunk (if any).
  if !small_items.is_empty() {
    let start_byte = small_items.first().map_or(0, |i| i.start_byte);
    let end_byte = small_items.last().map_or(0, |i| i.end_byte);
    let labels: Vec<&str> = small_items.iter().map(|i| i.label.as_str()).collect();

    if small_items.len() == 1 {
      // Single small item — emit directly.
      let item = small_items.remove(0);
      all_items.push((item.start_byte, item.content));
    } else {
      trace!(
          items = labels.len(),
          labels = ?labels,
          "grouping small items into single chunk",
      );
      let merged = small_items
        .iter()
        .map(|i| i.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
      // Use the start_byte of the first small item for ordering.
      let _ = end_byte; // used implicitly via last item
      all_items.push((start_byte, merged));
    }
  }

  for item in &large_items {
    all_items.push((item.start_byte, item.content.clone()));
  }

  // Sort by position in the source.
  all_items.sort_by_key(|(pos, _)| *pos);

  // Build full text and chunks.
  let full_text = String::from_utf8_lossy(data).into_owned();

  let chunks: Vec<TextChunk> = all_items
    .into_iter()
    .enumerate()
    .map(|(idx, (start_byte, content))| {
      let end_byte = start_byte + content.len();
      TextChunk {
        content,
        index: idx,
        start_offset: Some(start_byte),
        end_offset: Some(end_byte),
        token_count: None,
        chunk_type: ChunkType::Code,
      }
    })
    .collect();

  debug!(
    filename,
    language = lang_info.name,
    chunk_count = chunks.len(),
    "source code parsing complete",
  );

  Ok(ParsedDocument {
    title: Some(filename.to_owned()),
    text: full_text,
    chunks,
    metadata: HashMap::new(),
    language: Some(lang_info.name.to_owned()),
    format: DocumentFormat::SourceCode(lang_info.name.to_owned()),
    page_count: None,
  })
}

/// Produce a single plain-text chunk from the entire file content.
fn plain_text_fallback(data: &[u8], filename: &str) -> ParsedDocument {
  let text = String::from_utf8_lossy(data).into_owned();

  let chunks = if text.trim().is_empty() {
    Vec::new()
  } else {
    vec![TextChunk {
      content: text.clone(),
      index: 0,
      start_offset: Some(0),
      end_offset: Some(text.len()),
      token_count: None,
      chunk_type: ChunkType::Text,
    }]
  };

  ParsedDocument {
    title: Some(filename.to_owned()),
    text,
    chunks,
    metadata: HashMap::new(),
    language: None,
    format: DocumentFormat::PlainText,
    page_count: None,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;

  /// Rust source with 3 functions (each > DEFAULT_MIN_CHUNK_LINES) produces
  /// 3 separate chunks.
  #[test]
  fn rust_three_functions_three_chunks() {
    let src = r#"
fn alpha() {
    let a = 1;
    let b = 2;
    let c = 3;
    let d = 4;
    println!("{}", a + b + c + d);
}

fn beta() {
    let x = 10;
    let y = 20;
    let z = 30;
    let w = 40;
    println!("{}", x + y + z + w);
}

fn gamma() {
    let p = 100;
    let q = 200;
    let r = 300;
    let s = 400;
    println!("{}", p + q + r + s);
}
"#;

    let doc = parse_source_code(src.as_bytes(), "example.rs").unwrap();
    assert_eq!(doc.chunks.len(), 3, "expected 3 chunks, got: {:#?}", doc.chunks);
    assert_eq!(doc.format, DocumentFormat::SourceCode("rust".into()));
    assert_eq!(doc.language, Some("rust".into()));

    for chunk in &doc.chunks {
      assert_eq!(chunk.chunk_type, ChunkType::Code);
      assert!(chunk.content.contains("let "));
    }
  }

  /// Python source with a class containing methods: the class is extracted
  /// as a single top-level chunk (methods are nested children, not siblings).
  #[test]
  fn python_class_with_methods() {
    let src = r#"
class MyClass:
    def __init__(self, value):
        self.value = value
        self.data = []
        self.ready = False

    def process(self):
        result = self.value * 2
        self.data.append(result)
        self.ready = True
        return result

    def reset(self):
        self.value = 0
        self.data = []
        self.ready = False
        return self
"#;

    let doc = parse_source_code(src.as_bytes(), "example.py").unwrap();
    assert_eq!(doc.language, Some("python".into()));

    // The class_definition is the top-level node; the methods are children
    // of the class, not siblings — so we get 1 chunk containing everything.
    assert_eq!(doc.chunks.len(), 1, "got: {:#?}", doc.chunks);
    let class_chunk = &doc.chunks[0];
    assert!(class_chunk.content.contains("class MyClass"));
    assert!(class_chunk.content.contains("def __init__"));
    assert!(class_chunk.content.contains("def process"));
    assert!(class_chunk.content.contains("def reset"));
    assert_eq!(class_chunk.chunk_type, ChunkType::Code);
  }

  /// Unknown file extension produces a single plain-text fallback chunk.
  #[test]
  fn unknown_extension_plain_text_fallback() {
    let src = b"some random content\nline two\nline three";
    let doc = parse_source_code(src, "data.xyz").unwrap();

    assert_eq!(doc.chunks.len(), 1);
    assert_eq!(doc.chunks[0].chunk_type, ChunkType::Text);
    assert!(doc.chunks[0].content.contains("some random content"));
    assert_eq!(doc.format, DocumentFormat::PlainText);
  }

  /// Empty file produces zero chunks.
  #[test]
  fn empty_file_no_chunks() {
    let doc = parse_source_code(b"", "empty.rs").unwrap();
    assert!(doc.chunks.is_empty(), "expected no chunks for empty file");
  }

  /// Small functions below the threshold are grouped into a single chunk.
  #[test]
  fn small_functions_grouped() {
    let src = r#"
fn tiny_a() { 1 }
fn tiny_b() { 2 }
fn tiny_c() { 3 }
"#;

    let doc = parse_source_code(src.as_bytes(), "small.rs").unwrap();

    // All three are below the threshold → grouped into a single chunk.
    assert_eq!(doc.chunks.len(), 1, "expected 1 grouped chunk, got: {:#?}", doc.chunks,);
    assert!(doc.chunks[0].content.contains("tiny_a"));
    assert!(doc.chunks[0].content.contains("tiny_b"));
    assert!(doc.chunks[0].content.contains("tiny_c"));
    assert_eq!(doc.chunks[0].chunk_type, ChunkType::Code);
  }

  /// Go source with function and method declarations.
  #[test]
  fn go_functions_extracted() {
    let src = r#"
package main

import "fmt"

func Hello(name string) string {
    greeting := "Hello, "
    result := greeting + name
    extra := "!"
    final_result := result + extra
    return final_result
}

func (s *Server) Start() error {
    s.running = true
    s.port = 8080
    s.host = "localhost"
    fmt.Println("starting")
    return nil
}
"#;

    let doc = parse_source_code(src.as_bytes(), "main.go").unwrap();
    assert_eq!(doc.chunks.len(), 2, "expected 2 chunks, got: {:#?}", doc.chunks,);
    assert_eq!(doc.language, Some("go".into()));

    for chunk in &doc.chunks {
      assert_eq!(chunk.chunk_type, ChunkType::Code);
    }
  }

  /// JavaScript class and function declarations are extracted.
  #[test]
  fn javascript_class_extracted() {
    let src = r#"
function helper() {
    const a = 1;
    const b = 2;
    const c = 3;
    return a + b + c;
}

class Widget {
    constructor(name) {
        this.name = name;
        this.active = false;
        this.count = 0;
    }
    render() {
        return `<div>${this.name}</div>`;
    }
}
"#;

    let doc = parse_source_code(src.as_bytes(), "app.js").unwrap();
    assert_eq!(doc.language, Some("javascript".into()));

    // helper() = 6 lines, Widget class = ~10 lines → both above threshold.
    assert!(
      doc.chunks.len() >= 2,
      "expected at least 2 chunks, got: {:#?}",
      doc.chunks,
    );
  }
}
