// SPDX-License-Identifier: AGPL-3.0-or-later
//! Delivery admission produces native catalogs. Workspace, Definition and the
//! Template Registry retain their existing execution and persistence owners.
mod input;
pub use input::FeatureInput;
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
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, ops::Deref, sync::Arc};

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

#[derive(Debug, Clone)]
pub struct FeatureInventory {
  pub manifest: FeatureBundleManifest,
  pub files: BTreeMap<String, Vec<u8>>,
}

/// Shares the exact manifest and payloads whose checksums and artwork were admitted.
#[derive(Debug, Clone)]
pub struct ValidatedFeatureInventory(Arc<FeatureInventory>);

impl FeatureInventory {
  pub fn validate(self) -> Result<ValidatedFeatureInventory, String> {
    validate_feature_manifest(&self.manifest, &self.files)?;
    Ok(ValidatedFeatureInventory(Arc::new(self)))
  }
}

impl Deref for ValidatedFeatureInventory {
  type Target = FeatureInventory;

  fn deref(&self) -> &Self::Target {
    &self.0
  }
}

/// The pin and bytes stay together as the same archive moves from capture to publication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeatureArchive {
  bytes: Arc<Vec<u8>>,
  sha256: String,
}

impl FeatureArchive {
  pub fn new(bytes: Vec<u8>) -> Self {
    Self {
      sha256: format!("{:x}", Sha256::digest(&bytes)),
      bytes: Arc::new(bytes),
    }
  }

  pub fn sha256(&self) -> &str {
    &self.sha256
  }
}

impl AsRef<[u8]> for FeatureArchive {
  fn as_ref(&self) -> &[u8] {
    &self.bytes
  }
}

/// A bounded capture has no open filesystem paths. Native YAML decoding happens
/// once at capture; assembled selection admission happens against these facts.
#[derive(Debug, Clone)]
pub struct CapturedFeatureBundle {
  pub inventory: ValidatedFeatureInventory,
  pub archive: FeatureArchive,
  pub databases: BTreeMap<String, FeatureDatabaseSources>,
  pub assistants: BTreeMap<String, FeatureAssistantSources>,
  pub workflows: BTreeMap<String, AssistantWorkflowSource>,
}
impl Deref for CapturedFeatureBundle {
  type Target = FeatureInventory;

  fn deref(&self) -> &Self::Target {
    &self.inventory
  }
}

impl CapturedFeatureBundle {
  pub fn pin(&self) -> FeatureBundlePin {
    FeatureBundlePin {
      id: self.manifest.id.clone(),
      version: self.manifest.version.clone(),
      sha256: self.archive.sha256().to_owned(),
    }
  }
}
