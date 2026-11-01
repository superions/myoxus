// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! # myoxus-doc-indexer
//!
//! Clean-room Y-Doc block parser for indexing collaborative documents.
//!
//! Public extraction API consumed by `storage/src/indexer.rs`:
//!
//! - [`BlockInfo`] — per-block extraction result
//! - [`CrawlResult`] — full document crawl result
//! - [`ParseError`] — error type
//! - [`parse_doc_from_binary`] — main entry point
//!
//! Uses `yrs` (MIT) for Y-Doc parsing instead of `y-octo`.

mod parser;
mod types;

pub use parser::parse_doc_from_binary;
pub use types::{BlockInfo, CrawlResult, ParseError};
