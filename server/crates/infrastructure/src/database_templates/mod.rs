// SPDX-License-Identifier: AGPL-3.0-or-later
//! Immutable native Database source capture, decoding and preparation boundaries.
mod capture;
mod decode;
mod preparation;

pub use capture::{
  FilesystemDatabaseTemplateSource, capture_database_template_files, capture_database_template_files_at,
  load_database_template_catalog,
};
pub use decode::decode_database_template_sources;
pub(crate) use decode::decode_database_template_sources_with_core_provider;
pub use preparation::{validate_database_template_preparation, validate_database_template_source_preparation};

#[cfg(test)]
mod tests;
