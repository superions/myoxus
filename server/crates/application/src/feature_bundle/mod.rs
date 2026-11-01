// SPDX-License-Identifier: AGPL-3.0-or-later
//! Delivery admission produces native catalogs. Workspace, Definition and the
//! Template Registry retain their existing execution and persistence owners.
mod artwork;
mod artwork_presentation;
mod catalog;
mod document_components;
mod document_presentation;
mod documents;
mod preparation;
mod references;
mod release;
pub use artwork_presentation::{FeatureArtworkResource, resolve_feature_artwork};
pub use catalog::{ResolvedFeatureCatalogs, assemble_feature_catalogs, validate_feature_native_sources};
pub use documents::{
  FeatureDocumentRegistrationReport, register_feature_document_sources, stage_feature_document_sources,
};
pub use preparation::prepare_feature_release_catalog;
pub use release::validate_feature_release_candidate;
mod validation;
mod workflows;
pub use references::{resolve_feature_task_core, validate_feature_references};
pub use validation::{canonical_feature_path, validate_feature_manifest};
pub use workflows::validate_assistant_workflow_source;

use myoxus_domain::{assistant_package::*, database::*, feature_bundle::*};
use std::collections::BTreeMap;

/// Shared admission bound for authoring capture and packed Feature manifests.
pub const MAX_FEATURE_COMPONENTS: usize = 256;

#[derive(Debug, Clone)]
pub struct FeatureDatabaseSources {
  pub catalog: DatabaseTemplateCatalogSource,
  pub definitions: Vec<DatabaseTemplateDefinitionSource>,
  pub updates: Vec<(DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>,
}

#[derive(Debug, Clone)]
pub struct FeatureAssistantSources {
  pub catalog: AssistantPackageCatalogSource,
  pub definitions: Vec<(AssistantPackageSource, String)>,
}

/// A bounded capture has no open filesystem paths. Native YAML decoding happens
/// once at capture; assembled selection admission happens against these facts.
#[derive(Debug, Clone)]
pub struct CapturedFeatureBundle {
  pub manifest: FeatureBundleManifest,
  pub archive_sha256: String,
  pub archive_bytes: Vec<u8>,
  pub files: BTreeMap<String, Vec<u8>>,
  pub databases: BTreeMap<String, FeatureDatabaseSources>,
  pub assistants: BTreeMap<String, FeatureAssistantSources>,
  pub workflows: BTreeMap<String, AssistantWorkflowSource>,
}
impl CapturedFeatureBundle {
  pub fn pin(&self) -> FeatureBundlePin {
    FeatureBundlePin {
      id: self.manifest.id.clone(),
      version: self.manifest.version.clone(),
      sha256: self.archive_sha256.clone(),
    }
  }
}
