// SPDX-License-Identifier: AGPL-3.0-or-later
//! Error types for the Yjs v1 codec.
//!
//! Clean reimplementation — no y-octo code. All error variants are
//! purpose-built for the codec layer with descriptive messages.

use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum CodecError {
  #[error("unexpected end of input: need {need} more bytes at offset {offset}")]
  UnexpectedEof { offset: usize, need: usize },

  #[error("invalid content tag: {0}")]
  InvalidTag(u8),

  #[error("invalid UTF-8 in var_string at offset {0}")]
  InvalidUtf8(usize),

  #[error("content type {tag} does not support splitting at offset {offset}")]
  ContentSplitNotSupported { tag: &'static str, offset: u64 },

  #[error("unknown Yjs type reference: {0}")]
  UnknownTypeRef(u64),

  #[error("damaged JSON in embed/format content: {0}")]
  DamagedJson(String),

  #[error("update not fully consumed: {remaining} bytes left")]
  UpdateNotFullyConsumed { remaining: usize },

  #[error("{0}")]
  Other(String),
}

pub type CodecResult<T = ()> = Result<T, CodecError>;
