// SPDX-License-Identifier: AGPL-3.0-or-later
//! Confined authoring capture and deterministic transport of native components.
mod archive;
mod capture;
mod pack;
mod preparation;
mod source_set;

pub use archive::{read_feature_bundle, read_feature_bundle_file, read_feature_bundle_with_platform};
pub use capture::{capture_feature_source, capture_feature_source_with_platform, read_feature_source_file};
pub use pack::{pack_captured_feature_bundle, pack_feature_source};
pub use preparation::{PreparedFeatureSourceSet, prepare_feature_source_set, write_prepared_feature_source_set};
pub use source_set::{
  CapturedFeatureSourceSet, capture_feature_selection, capture_feature_source_set, packaged_feature_release_manifest,
};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod preparation_tests;
