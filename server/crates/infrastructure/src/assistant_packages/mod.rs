// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native assistant source capture, decoding and immutable-pin preparation.
mod capture;
mod decode;
mod preparation;

pub use capture::{
  FilesystemAssistantPackageSource, capture_assistant_package_files, capture_assistant_package_files_at,
  load_assistant_package_catalog,
};
pub(crate) use decode::decode_assistant_package_catalog;
pub use decode::decode_assistant_package_sources;
pub use preparation::{validate_assistant_package_source_preparation, validate_assistant_template_preparation};

#[cfg(test)]
mod tests;
