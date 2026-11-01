// SPDX-License-Identifier: AGPL-3.0-or-later
//! V2 render-pipeline modules.
//!
//! Container for sub-systems that the V2 worker (`P-PDF-TPL-13`) will
//! eventually consume. Today only the image-compression pipeline is
//! wired here; the cross-reference resolver, accessibility tagger, and
//! PDF/A validator land here in their respective Mikropakete.

pub mod cross_refs;
pub mod image_pipeline;
pub mod pdfa;
pub mod tagged_pdf;
