//! Document parsing pipeline for Myoxus.
//!
//! Converts various file formats into a structured [`ParsedDocument`]
//! representation with [`TextChunk`]s suitable for indexing, search, and
//! embedding.
//!
//! # Architecture
//!
//! ```text
//!   raw bytes + filename
//!         │
//!         ▼
//!   ┌─────────────┐
//!   │  router.rs   │  detect format → dispatch
//!   └──────┬───────┘
//!          │
//!    ┌─────┼─────┬──────┬──────┐
//!    ▼     ▼     ▼      ▼      ▼
//!   pdf  docx   html   code  plain
//!    │     │     │      │      │
//!    └─────┴─────┴──────┴──────┘
//!          │
//!          ▼
//!    ParsedDocument { text, chunks, metadata }
//! ```
//!
//! Each parser is gated behind a feature flag so downstream crates only pay
//! for the formats they need.
//!
//! # Feature flags
//!
//! | Feature | Parser | Backend crate |
//! |---------|--------|---------------|
//! | `pdf`   | PDF    | `pdf_oxide`   |
//! | `docx`  | DOCX   | `docx-rs`     |
//! | `html`  | HTML   | `readability` + `html2text` + `scraper` |
//! | `code`  | Source code | `tree-sitter` + language grammars |
//! | `splitting` | Text chunking | `text-splitter` |
//! | `tokenizer-tiktoken` | Token counting | `tiktoken-rs` |

pub mod error;
pub mod router;
pub mod types;

#[cfg(feature = "pdf")]
pub mod pdf;

#[cfg(feature = "docx")]
pub mod docx;

#[cfg(feature = "html")]
pub mod html;

#[cfg(feature = "code")]
pub mod code;

#[cfg(feature = "splitting")]
pub mod splitter;

pub mod pipeline;

// Re-exports for convenience.
pub use error::{PipelineError, Result};
pub use pipeline::DefaultDocumentParser;
pub use router::{detect_format, parse};
pub use types::{ChunkType, DocumentFormat, ParsedDocument, TextChunk};

#[cfg(feature = "splitting")]
pub use splitter::{SplitConfig, TokenizerModel};
