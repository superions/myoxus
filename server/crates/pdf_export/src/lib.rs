// SPDX-License-Identifier: AGPL-3.0-or-later
//! Myoxus PDF export crate.
//!
//! Pipeline: Yjs binary snapshot → IR document → Typst source → PDF bytes.
//!
//! ```text
//! [Yjs binary]
//!      │  YjsIrBuilder<R: AssetResolver>
//!      ▼
//! [IrDocument]  ←── versioned, serialisable IR (migration module)
//!      │  typst_engine::render_to_pdf_v2
//!      ▼
//! [PDF bytes]
//! ```
//!
//! Templates are no longer compiled into this crate. The V2 registry
//! ([`template_v2::registry::PdfTemplateRegistry`]) loads templates from
//! the database / blob store and hands a `HashMap<String, Vec<u8>>` bundle
//! to [`render_to_pdf_v2`] / [`render_to_pdf_v2_with_snapshot_limits`].

pub mod builder;
pub mod error;
pub mod execution;
pub mod ir;
pub mod mermaid;
pub mod render_v2;
pub mod template_v2;
pub mod typst_engine;

pub use builder::{AssetResolver, NullAssetResolver, YjsIrBuilder};
pub use error::{IrBuildError, PdfExportError, RenderError, TemplateError};
pub use ir::{
  CURRENT_IR_VERSION, IrDocument,
  block::{EdgelessSnapshot, EdgelessSnapshotLimits, SnapshotLimitViolation},
};
pub use typst_engine::{RenderReport, render_to_pdf_v2, render_to_pdf_v2_with_snapshot_limits};
