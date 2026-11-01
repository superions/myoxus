// SPDX-License-Identifier: AGPL-3.0-or-later
//! Feature delivery composes native sources. It grants neither execution nor
//! system ownership; those remain with native owners and the release descriptor.
use crate::assistant_package::{AssistantLocalizedText, AssistantPackageContext, AssistantValueType};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureBundleIdentity {
  pub id: String,
  pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureBundlePin {
  pub id: String,
  pub version: String,
  pub sha256: String,
}
impl FeatureBundlePin {
  pub fn identity(&self) -> FeatureBundleIdentity {
    FeatureBundleIdentity {
      id: self.id.clone(),
      version: self.version.clone(),
    }
  }
  pub fn archive_path(&self) -> String {
    format!("{}/{}.myoxus.zip", self.id, self.version)
  }
}

/// A release expectation is shipped outside the configurable template root.
/// Archives cannot designate themselves as the base or claim platform priority.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureReleaseDescriptor {
  pub format_version: u32,
  pub base: FeatureBundlePin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureBundleCatalogSource {
  pub format_version: u32,
  pub base: FeatureBundlePin,
  pub optional: Vec<FeatureBundlePin>,
  pub retained: Vec<FeatureBundlePin>,
}

/// Only implemented native adapters are represented. New kinds require their
/// real admission and consumer before becoming part of this format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeatureComponentKind {
  DatabaseCatalog,
  TaskCore,
  AssistantCatalog,
  DocumentTemplate,
  Workflow,
  Artwork,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureArtwork {
  /// Omission retains the historical full-width diagram presentation.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub role: Option<FeatureArtworkRole>,
  pub media_type: String,
  pub width: u32,
  pub height: u32,
  pub alternative: AssistantLocalizedText,
  pub caption: Option<AssistantLocalizedText>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureComponentSource {
  pub id: String,
  pub kind: FeatureComponentKind,
  pub path: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub artwork: Option<FeatureArtwork>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureComponent {
  pub id: String,
  pub kind: FeatureComponentKind,
  pub path: String,
  pub sha256: String,
  /// Present only when the native component defines a single versioned identity.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub native_identity: Option<FeatureBundleIdentity>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub artwork: Option<FeatureArtwork>,
}

/// A local endpoint selects an actual export of an admitted native component.
/// The optional key selects its stable View, input, context or result key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureNativeReference {
  pub component: String,
  pub export: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
  tag = "scope",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum FeatureReference {
  Local { reference: FeatureNativeReference },
  Platform { bundle: FeatureBundlePin, export: String },
}

/// Links verify supported native references. They never define execution order,
/// expressions, permissions or a second component graph executor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum FeatureLink {
  Workflow {
    from: FeatureNativeReference,
    to: FeatureReference,
  },
  TaskCore {
    from: FeatureNativeReference,
    to: FeatureReference,
  },
  Schema {
    from: FeatureNativeReference,
    to: FeatureReference,
  },
  View {
    from: FeatureNativeReference,
    to: FeatureReference,
  },
  DocumentComponent {
    from: FeatureNativeReference,
    to: FeatureReference,
  },
  DocumentSource {
    from: FeatureNativeReference,
    to: FeatureReference,
  },
  Artwork {
    from: FeatureNativeReference,
    to: FeatureReference,
  },
  Input {
    from: FeatureNativeReference,
    to: FeatureReference,
    value_type: AssistantValueType,
  },
  Context {
    from: FeatureNativeReference,
    to: FeatureReference,
    value_type: AssistantValueType,
  },
  PriorResult {
    from: FeatureNativeReference,
    to: FeatureReference,
    value_type: AssistantValueType,
  },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureDocumentPolicy {
  pub new_workspace_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureExport {
  pub id: String,
  pub source: FeatureNativeReference,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub contexts: Vec<AssistantPackageContext>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub document: Option<FeatureDocumentPolicy>,
}

/// Source manifests name native roots. Packing derives the closed file inventory,
/// hashes and native identities from one confined capture of those roots.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureBundleSource {
  pub format_version: u32,
  pub id: String,
  pub version: String,
  pub capabilities: BTreeMap<String, u32>,
  pub components: Vec<FeatureComponentSource>,
  pub links: Vec<FeatureLink>,
  pub exports: Vec<FeatureExport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureBundleManifest {
  pub format_version: u32,
  pub id: String,
  pub version: String,
  pub capabilities: BTreeMap<String, u32>,
  pub components: Vec<FeatureComponent>,
  /// Every payload file occurs exactly once. The manifest itself is excluded.
  pub files: BTreeMap<String, String>,
  pub links: Vec<FeatureLink>,
  pub exports: Vec<FeatureExport>,
}

/// Presentation intent is authored metadata, never inferred from asset geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeatureArtworkRole {
  Illustration,
  Diagram,
}
