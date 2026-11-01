// SPDX-License-Identifier: AGPL-3.0-or-later
//! Operation-local document-reference resolution for Markdown conversion.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use url::Url;
use yjs::markdown::{
  MarkdownNativeTarget, MarkdownTargetError, markdown_native_targets_with_references, resolve_markdown_target,
  with_markdown_export_anchors,
};
use yjs::{MarkdownDocumentReference, MarkdownLinkResolution, MarkdownLinkTarget, MarkdownResolvedReference};

use super::ConversionError;

const MAX_REFERENCE_TARGETS: usize = 10_000;

/// One authorized workspace document exposed to a Markdown operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedMarkdownDocument {
  pub external_id: String,
  pub title: String,
}

/// One reserved document identity in a file import/export batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedMarkdownBatchDocument {
  pub external_id: String,
  pub title: String,
  pub path: String,
}

/// Bounded reference lookup shared by single-document and batch conversions.
///
/// Callers must populate this value only after normal workspace/document read
/// authorization. Consequently a missing entry is intentionally
/// indistinguishable from an inaccessible or deleted target.
#[derive(Debug, Clone)]
pub struct MarkdownReferenceLookup {
  document_base_url: Url,
  documents: Arc<HashMap<String, String>>,
}

#[derive(Debug, Clone)]
struct ReservedMarkdownImport {
  block_namespace: uuid::Uuid,
  failure: Option<String>,
}

/// Immutable operation-wide metadata and final-path index for batch conversion.
#[derive(Debug, Clone)]
pub struct MarkdownBatchReferenceInventory {
  /// Full operation-authorized metadata, including targets omitted from files.
  canonical: MarkdownReferenceLookup,
  by_path: Arc<HashMap<String, String>>,
  /// Exact basenames map only when the target is unique across the batch.
  /// Ambiguous names are retained as `None` and never guessed.
  by_unique_basename: Arc<HashMap<String, Option<String>>>,
  /// Final paths exist only for documents materialized by this batch.
  paths_by_external_id: Arc<HashMap<String, String>>,
  /// Current trees captured by the caller after document read authorization.
  native_targets: Arc<HashMap<String, Arc<Vec<MarkdownNativeTarget>>>>,
  /// Body block namespaces reserved only for this import operation.
  imports: Arc<HashMap<String, ReservedMarkdownImport>>,
}

/// Source-aware view over one shared batch reference inventory.
#[derive(Debug, Clone)]
pub struct MarkdownBatchReferenceLookup {
  inventory: MarkdownBatchReferenceInventory,
  source_path: String,
  vault_paths: bool,
}

/// Export-only frozen bodies and their matching exact-target inventory.
/// Generated anchors must be serialized from these bodies, not the original
/// snapshots, or links would point at anchors absent from the exported files.
pub struct PreparedMarkdownBatchExport {
  pub references: MarkdownBatchReferenceInventory,
  pub snapshots: HashMap<String, Vec<u8>>,
}

impl MarkdownBatchReferenceInventory {
  /// Whether a captured source needs current native target trees. Incremental
  /// outbound owners must then prepare the complete export batch: preparing
  /// only changed referrers could remove anchors still used by unchanged ones.
  pub fn requires_native_export_targets(&self, binary: &[u8]) -> Result<bool, ConversionError> {
    if binary.is_empty() || binary == [0, 0] {
      return Ok(false);
    }
    let needed = Cell::new(false);
    self.visit_exported_references(binary, &|reference| {
      if portable_markdown_block_id(reference.params.as_ref()).is_some() {
        needed.set(true);
      }
    })?;
    Ok(needed.get())
  }

  /// Observe the canonical writer, not the broader stored Document Graph.
  /// This includes table cells and excludes detached blocks and literal code.
  /// Read authorization precedes the callback; this preflight writes nothing.
  fn visit_exported_references(
    &self,
    binary: &[u8],
    visitor: &dyn Fn(&MarkdownDocumentReference),
  ) -> Result<(), ConversionError> {
    yjs::extract_text_from_yjs_with_references(binary, &|_| true, &|reference| {
      let resolved = self.canonical.resolve_export_reference(reference);
      if resolved.is_some() {
        visitor(reference);
      }
      resolved
    })
    .map_err(ConversionError::YjsDecode)?;
    Ok(())
  }

  pub fn new(
    document_base_url: &str,
    documents: impl IntoIterator<Item = AuthorizedMarkdownBatchDocument>,
  ) -> Result<Self, ConversionError> {
    Self::new_with_authorized(document_base_url, std::iter::empty(), documents)
  }

  pub fn new_with_authorized(
    document_base_url: &str,
    authorized_documents: impl IntoIterator<Item = AuthorizedMarkdownDocument>,
    documents: impl IntoIterator<Item = AuthorizedMarkdownBatchDocument>,
  ) -> Result<Self, ConversionError> {
    let documents = documents.into_iter().collect::<Vec<_>>();
    if documents.len() > MAX_REFERENCE_TARGETS {
      return Err(ConversionError::Conversion(
        "Markdown reference lookup exceeds operation limit".to_string(),
      ));
    }
    let mut by_path = HashMap::with_capacity(documents.len());
    let mut by_unique_basename = HashMap::with_capacity(documents.len());
    let mut paths_by_external_id = HashMap::with_capacity(documents.len());
    let mut authorized = HashMap::new();
    for document in authorized_documents {
      authorized.insert(document.external_id, document.title);
      if authorized.len() > MAX_REFERENCE_TARGETS {
        return Err(ConversionError::Conversion(
          "Markdown reference lookup exceeds operation limit".to_string(),
        ));
      }
    }
    for document in documents {
      let path = normalize_root_relative_path(&document.path)
        .ok_or_else(|| ConversionError::Conversion("invalid Markdown batch document path".to_string()))?;
      if by_path.insert(path.clone(), document.external_id.clone()).is_some() {
        return Err(ConversionError::Conversion(
          "duplicate Markdown batch document path".to_string(),
        ));
      }
      if let Some(basename) = path.rsplit('/').next() {
        by_unique_basename
          .entry(basename.to_string())
          .and_modify(|target| *target = None)
          .or_insert_with(|| Some(document.external_id.clone()));
      }
      paths_by_external_id.insert(document.external_id.clone(), path);
      authorized.insert(document.external_id, document.title);
      if authorized.len() > MAX_REFERENCE_TARGETS {
        return Err(ConversionError::Conversion(
          "Markdown reference lookup exceeds operation limit".to_string(),
        ));
      }
    }
    Ok(Self {
      canonical: MarkdownReferenceLookup::new(
        document_base_url,
        authorized
          .into_iter()
          .map(|(external_id, title)| AuthorizedMarkdownDocument { external_id, title }),
      )?,
      by_path: Arc::new(by_path),
      by_unique_basename: Arc::new(by_unique_basename),
      paths_by_external_id: Arc::new(paths_by_external_id),
      native_targets: Arc::new(HashMap::new()),
      imports: Arc::new(HashMap::new()),
    })
  }

  /// Bind already authorized operation snapshots, never cached client bodies.
  /// Membership in the caller-authorized inventory is checked before decoding;
  /// inaccessible documents
  /// cannot contribute a title, heading or anchor to the target inventory.
  pub fn with_target_snapshots<'a>(
    mut self,
    snapshots: impl IntoIterator<Item = (&'a str, &'a [u8])>,
  ) -> Result<Self, ConversionError> {
    let mut targets = (*self.native_targets).clone();
    let mut seen = HashSet::new();
    for (external_id, binary) in snapshots.into_iter().take(MAX_REFERENCE_TARGETS + 1) {
      if !self.canonical.documents.contains_key(external_id) {
        return Err(ConversionError::Conversion(
          "unauthorized Markdown target snapshot".into(),
        ));
      }
      if seen.len() >= MAX_REFERENCE_TARGETS || !seen.insert(external_id) {
        return Err(ConversionError::Conversion(
          "invalid Markdown target snapshot inventory".into(),
        ));
      }
      let current = if binary.is_empty() || binary == [0, 0] {
        Vec::new()
      } else {
        markdown_native_targets_with_references(binary, &|reference| self.canonical.resolve_export_reference(reference))
          .map_err(ConversionError::Conversion)?
      };
      targets.insert(external_id.to_string(), Arc::new(current));
    }
    self.native_targets = Arc::new(targets);
    Ok(self)
  }

  /// Recover export-only aliases for unchanged, already authorized targets.
  /// The caller supplies their actually observed portable bodies, not incoming
  /// replacements. An alias must occur exactly once outside literals and match
  /// the shared allocator for a current native ID. Never infer identity from
  /// Markdown position, text, an unobserved anchor or a deleted native block.
  pub fn with_exported_target_sources<'a>(
    mut self,
    sources: impl IntoIterator<Item = (&'a str, &'a str)>,
  ) -> Result<Self, ConversionError> {
    let mut targets = (*self.native_targets).clone();
    let mut seen = HashSet::new();
    for (id, source) in sources.into_iter().take(MAX_REFERENCE_TARGETS + 1) {
      if !self.canonical.documents.contains_key(id)
        || !self.paths_by_external_id.contains_key(id)
        || seen.len() >= MAX_REFERENCE_TARGETS
        || !seen.insert(id)
      {
        return Err(ConversionError::Conversion(
          "invalid exported Markdown target inventory".into(),
        ));
      }
      let Some(current) = targets.get(id) else {
        return Err(ConversionError::Conversion(
          "missing current exported Markdown target tree".into(),
        ));
      };
      // Ordinary unchanged Markdown needs no extra syntax conversion. This
      // cheap negative check cannot establish an alias; the codec below does.
      if !source.contains("^myoxus-") {
        continue;
      }
      let aliases = generated_export_anchors(current);
      if aliases.is_empty() {
        continue;
      }
      let parsed = yjs::markdown_to_yjs("", source).map_err(ConversionError::Conversion)?;
      let observed = yjs::markdown::markdown_native_targets(&parsed).map_err(ConversionError::Conversion)?;
      // The temporary codec IDs are deliberately ignored; only observed
      // portable provenance can validate an alias for the captured live tree.
      let mut occurrences = HashMap::<String, usize>::new();
      for anchor in observed.into_iter().filter_map(|target| target.source_anchor) {
        *occurrences.entry(anchor).or_default() += 1;
      }
      let mut current = (**current).clone();
      for target in &mut current {
        if let Some(anchor) = aliases.get(&target.block_id)
          && occurrences.get(anchor) == Some(&1)
        {
          target.source_anchor = Some(anchor.clone());
        }
      }
      targets.insert(id.to_string(), Arc::new(current));
    }
    self.native_targets = Arc::new(targets);
    Ok(self)
  }

  /// Bound exact native targets to the actual emitted Markdown, not a pending
  /// current tree. Reuse codec parsing/resolution and the observed alias owner;
  /// remove targets whose portable fragment is absent from the materialized file.
  /// Whole-document file links remain available even when an exact block is not.
  pub fn with_materialized_target_sources<'a>(
    self,
    sources: impl IntoIterator<Item = (&'a str, &'a str)>,
  ) -> Result<Self, ConversionError> {
    let sources = sources.into_iter().collect::<Vec<_>>();
    let mut inventory = self.with_exported_target_sources(sources.iter().copied())?;
    let targets = Arc::make_mut(&mut inventory.native_targets);
    for (id, source) in sources {
      let binary = yjs::markdown_to_yjs("", source).map_err(ConversionError::Conversion)?;
      let observed = yjs::markdown::markdown_native_targets(&binary).map_err(ConversionError::Conversion)?;
      if let Some(current) = targets.get_mut(id) {
        let retained = current
          .iter()
          .filter(|target| {
            portable_fragment(current, target)
              .is_some_and(|fragment| resolve_markdown_target(&observed, &fragment).is_ok())
          })
          .cloned()
          .collect();
        *current = Arc::new(retained);
      }
    }
    Ok(inventory)
  }

  /// Allocate deterministic portable anchors only for actually referenced native
  /// targets. Source provenance remains untouched and no live Yjs writes occur.
  pub fn prepare_export_snapshots(
    self,
    mut snapshots: HashMap<String, Vec<u8>>,
  ) -> Result<PreparedMarkdownBatchExport, ConversionError> {
    let mut inventory =
      self.with_target_snapshots(snapshots.iter().map(|(id, binary)| (id.as_str(), binary.as_slice())))?;
    let referenced = RefCell::new(BTreeMap::<String, BTreeSet<String>>::new());
    for (_, binary) in snapshots.iter().filter(|(id, binary)| {
      inventory.paths_by_external_id.contains_key(*id) && !binary.is_empty() && binary.as_slice() != [0, 0]
    }) {
      inventory.visit_exported_references(binary, &|reference| {
        if let Some(block_id) = portable_markdown_block_id(reference.params.as_ref())
          && inventory.paths_by_external_id.contains_key(&reference.page_id)
          && inventory.native_targets.contains_key(&reference.page_id)
        {
          referenced
            .borrow_mut()
            .entry(reference.page_id.clone())
            .or_default()
            .insert(block_id.to_string());
        }
      })?;
    }
    for (id, blocks) in referenced.into_inner() {
      let targets = &inventory.native_targets[&id];
      let aliases = generated_export_anchors(targets);
      let anchors = blocks
        .into_iter()
        .filter_map(|block| aliases.get(&block).map(|anchor| (block.clone(), anchor.clone())))
        .collect::<Vec<_>>();
      let binary = with_markdown_export_anchors(&snapshots[&id], &anchors).map_err(ConversionError::Conversion)?;
      snapshots.insert(id, binary);
    }
    inventory =
      inventory.with_target_snapshots(snapshots.iter().map(|(id, binary)| (id.as_str(), binary.as_slice())))?;
    Ok(PreparedMarkdownBatchExport {
      references: inventory,
      snapshots,
    })
  }

  /// Preflight all source trees through the existing codec before final conversion.
  /// The same reserved native block identities are reused by every batch member.
  /// Callers must retain these source bodies for final conversion; only existing
  /// resource rewriting that preserves the native block structure may intervene.
  /// Per-document codec failures are replayed by `prepare_markdown_batch_import`;
  /// the preview or persistence owner retains its existing failure lifecycle.
  pub fn with_import_sources<'a>(
    self,
    sources: impl IntoIterator<Item = (&'a str, &'a str)>,
  ) -> Result<Self, ConversionError> {
    self.reserve_import_targets(sources, false)
  }

  pub fn with_vault_import_sources<'a>(
    self,
    sources: impl IntoIterator<Item = (&'a str, &'a str)>,
  ) -> Result<Self, ConversionError> {
    self.reserve_import_targets(sources, true)
  }

  fn reserve_import_targets<'a>(
    mut self,
    sources: impl IntoIterator<Item = (&'a str, &'a str)>,
    vault: bool,
  ) -> Result<Self, ConversionError> {
    let mut planned = Vec::new();
    let mut imports = HashMap::new();
    for (path, source) in sources.into_iter().take(MAX_REFERENCE_TARGETS + 1) {
      let path = normalize_root_relative_path(path)
        .ok_or_else(|| ConversionError::Conversion("invalid Markdown import source path".into()))?;
      let id = self
        .by_path
        .get(&path)
        .ok_or_else(|| ConversionError::Conversion("Markdown import source is not in the reserved batch".into()))?
        .clone();
      if imports.len() >= MAX_REFERENCE_TARGETS
        || imports
          .insert(
            id.clone(),
            ReservedMarkdownImport {
              block_namespace: uuid::Uuid::new_v4(),
              failure: None,
            },
          )
          .is_some()
      {
        return Err(ConversionError::Conversion(
          "invalid Markdown import source inventory".into(),
        ));
      }
      planned.push((id, path, source));
    }
    self.imports = Arc::new(imports);
    let mut targets = (*self.native_targets).clone();
    for (id, _, _) in &planned {
      targets.remove(id);
    }
    self.native_targets = Arc::new(targets);
    let mut snapshots = Vec::with_capacity(planned.len());
    let mut failures = Vec::new();
    for (id, path, source) in &planned {
      let references = if vault {
        self.for_vault_source(path)?
      } else {
        self.for_source(path)?
      };
      let title = self
        .canonical
        .documents
        .get(id)
        .expect("reserved batch metadata was validated");
      match super::prepare_markdown_batch_import(title, source, &references) {
        Ok(imported) => snapshots.push((id.clone(), imported.yjs_binary)),
        Err(ConversionError::Conversion(message) | ConversionError::YjsDecode(message)) => {
          failures.push((id.clone(), message))
        }
      }
    }
    for (id, failure) in failures {
      Arc::make_mut(&mut self.imports)
        .get_mut(&id)
        .expect("source identity was reserved")
        .failure = Some(failure);
    }
    self.with_target_snapshots(snapshots.iter().map(|(id, binary)| (id.as_str(), binary.as_slice())))
  }

  /// Bind the shared indexes to one source path without rebuilding them.
  pub fn for_source(&self, source_path: &str) -> Result<MarkdownBatchReferenceLookup, ConversionError> {
    let source_path = normalize_root_relative_path(source_path)
      .ok_or_else(|| ConversionError::Conversion("invalid Markdown batch source path".to_string()))?;
    Ok(MarkdownBatchReferenceLookup {
      inventory: self.clone(),
      source_path,
      vault_paths: false,
    })
  }

  /// Bind Obsidian's vault-root and unique-basename lookup rules without
  /// changing ordinary Markdown/Git relative-path semantics.
  pub fn for_vault_source(&self, source_path: &str) -> Result<MarkdownBatchReferenceLookup, ConversionError> {
    let mut lookup = self.for_source(source_path)?;
    lookup.vault_paths = true;
    Ok(lookup)
  }
}

impl MarkdownBatchReferenceLookup {
  pub(super) fn reserved_import_id(&self) -> Option<uuid::Uuid> {
    let id = self.inventory.by_path.get(&self.source_path)?;
    self.inventory.imports.get(id).map(|import| import.block_namespace)
  }

  pub(super) fn preflight_failure(&self) -> Option<&str> {
    let id = self.inventory.by_path.get(&self.source_path)?;
    self.inventory.imports.get(id)?.failure.as_deref()
  }
  pub fn new(
    document_base_url: &str,
    documents: impl IntoIterator<Item = AuthorizedMarkdownBatchDocument>,
    source_path: &str,
  ) -> Result<Self, ConversionError> {
    MarkdownBatchReferenceInventory::new(document_base_url, documents)?.for_source(source_path)
  }

  pub fn new_with_authorized(
    document_base_url: &str,
    authorized_documents: impl IntoIterator<Item = AuthorizedMarkdownDocument>,
    documents: impl IntoIterator<Item = AuthorizedMarkdownBatchDocument>,
    source_path: &str,
  ) -> Result<Self, ConversionError> {
    MarkdownBatchReferenceInventory::new_with_authorized(document_base_url, authorized_documents, documents)?
      .for_source(source_path)
  }

  pub fn resolve_link(&self, target: MarkdownLinkTarget<'_>) -> MarkdownLinkResolution {
    match target {
      MarkdownLinkTarget::Url(candidate) if Url::parse(candidate).is_ok() => {
        if let Ok(mut url) = Url::parse(candidate)
          && let Some(fragment) = url.fragment().map(str::to_string)
        {
          url.set_fragment(None);
          if let Some(page_id) = self.inventory.canonical.own_external_id(&url) {
            if url.query().is_some() {
              return MarkdownLinkResolution::Unsupported;
            }
            return self.reference_for_fragment(&page_id, Some(&fragment));
          }
        }
        self.inventory.canonical.resolve_link(target)
      }
      MarkdownLinkTarget::Url(candidate) => {
        let (path, fragment) = candidate
          .split_once('#')
          .map_or((candidate, None), |(path, fragment)| (path, Some(fragment)));
        if fragment.is_some() && self.inventory.native_targets.is_empty() {
          return MarkdownLinkResolution::Unsupported;
        }
        if path.is_empty() && fragment.is_none() {
          return MarkdownLinkResolution::Ordinary;
        }
        if !path.is_empty() && !path.to_ascii_lowercase().ends_with(".md") {
          return MarkdownLinkResolution::Ordinary;
        }
        self
          .resolve_document_path(path)
          .map_or(MarkdownLinkResolution::Unresolved, |page_id| {
            self.reference_for_fragment(page_id, fragment)
          })
      }
      MarkdownLinkTarget::Wiki(target) => {
        let (path, fragment) = target
          .split_once('#')
          .map_or((target, None), |(path, fragment)| (path, Some(fragment)));
        if let Some(page_id) = self.resolve_document_path(path).or_else(|| {
          (!path.to_ascii_lowercase().ends_with(".md"))
            .then(|| self.resolve_batch_path(&format!("{path}.md")))
            .flatten()
        }) {
          return self.reference_for_fragment(page_id, fragment);
        }
        if is_path_like_wiki_target(path) {
          return MarkdownLinkResolution::Unresolved;
        }
        match self.inventory.canonical.resolve_link(MarkdownLinkTarget::Wiki(path)) {
          MarkdownLinkResolution::Reference(reference) => self.reference_for_fragment(&reference.page_id, fragment),
          resolution => resolution,
        }
      }
    }
  }

  pub fn resolve_export_reference(&self, reference: &MarkdownDocumentReference) -> Option<MarkdownResolvedReference> {
    let canonical = self.inventory.canonical.resolve_export_reference(reference)?;
    if let Some(targets) = self.inventory.native_targets.get(&reference.page_id)
      && let Some(block_id) = portable_markdown_block_id(reference.params.as_ref())
    {
      let target = targets.iter().find(|target| target.block_id == block_id)?;
      let Some(target_path) = self.inventory.paths_by_external_id.get(&reference.page_id) else {
        return Some(canonical);
      };
      let fragment = portable_fragment(targets, target)?;
      let path = if self.source_path == *target_path {
        String::new()
      } else {
        relative_markdown_path(&self.source_path, target_path)
      };
      return Some(MarkdownResolvedReference {
        url: format!("{path}#{}", urlencoding::encode(&fragment)),
        title: canonical.title,
      });
    }
    if reference.params.is_some() {
      return Some(canonical);
    }
    Some(match self.inventory.paths_by_external_id.get(&reference.page_id) {
      Some(target) => MarkdownResolvedReference {
        url: relative_markdown_path(&self.source_path, target),
        title: canonical.title,
      },
      None => canonical,
    })
  }

  /// Resolve one already planned archive asset to a path relative to this
  /// document. The same normalization used for document references rejects
  /// traversal or absolute paths before serialization.
  pub fn resolve_export_asset_path(&self, target_path: &str) -> Option<String> {
    let target = normalize_root_relative_path(target_path)?;
    Some(relative_markdown_path(&self.source_path, &target))
  }

  /// Resolve an image destination against this source's normal batch path.
  /// Callers must still find it in their authorized asset inventory.
  pub fn resolve_import_asset_path(&self, candidate: &str) -> Option<String> {
    let decoded = decode_reference_path(candidate)?;
    let parent = self.source_path.rsplit_once('/').map_or("", |(parent, _)| parent);
    let joined = if parent.is_empty() {
      decoded
    } else {
      format!("{parent}/{decoded}")
    };
    normalize_root_relative_path(&joined)
  }

  fn resolve_batch_path(&self, candidate: &str) -> Option<&str> {
    let vault_root = self.vault_paths && candidate.starts_with('/');
    let decoded = if vault_root {
      decode_reference_path(candidate.trim_start_matches('/'))?
    } else {
      decode_reference_path(candidate)?
    };
    let parent = self.source_path.rsplit_once('/').map_or("", |(parent, _)| parent);
    let joined = if vault_root || parent.is_empty() {
      decoded.clone()
    } else {
      format!("{parent}/{decoded}")
    };
    let normalized = normalize_root_relative_path(&joined)?;
    if let Some(target) = self.inventory.by_path.get(&normalized) {
      return Some(target);
    }
    if self.vault_paths && !vault_root {
      if let Some(target) = normalize_root_relative_path(&decoded).and_then(|path| self.inventory.by_path.get(&path)) {
        return Some(target);
      }
      if !decoded.contains('/') {
        return self
          .inventory
          .by_unique_basename
          .get(&decoded)
          .and_then(Option::as_deref);
      }
    }
    None
  }

  fn resolve_document_path(&self, candidate: &str) -> Option<&str> {
    if candidate.is_empty() {
      self.inventory.by_path.get(&self.source_path).map(String::as_str)
    } else {
      self.resolve_batch_path(candidate)
    }
  }

  fn reference_for_fragment(&self, page_id: &str, fragment: Option<&str>) -> MarkdownLinkResolution {
    let Some(title) = self.inventory.canonical.documents.get(page_id) else {
      return MarkdownLinkResolution::Unresolved;
    };
    let params = if let Some(fragment) = fragment {
      let Some(targets) = self.inventory.native_targets.get(page_id) else {
        return MarkdownLinkResolution::Unsupported;
      };
      let Ok(fragment) = urlencoding::decode(fragment) else {
        return MarkdownLinkResolution::Unsupported;
      };
      let target = match resolve_markdown_target(targets, &fragment) {
        Ok(target) => target,
        Err(MarkdownTargetError::Invalid) => return MarkdownLinkResolution::Unsupported,
        Err(MarkdownTargetError::Missing | MarkdownTargetError::Ambiguous) => {
          return MarkdownLinkResolution::Unresolved;
        }
      };
      Some(serde_json::json!({"mode":"page", "blockIds":[target.block_id]}))
    } else {
      None
    };
    MarkdownLinkResolution::Reference(MarkdownDocumentReference {
      page_id: page_id.to_string(),
      title: Some(title.clone()),
      description: None,
      params,
    })
  }
}

/// Allocate over the complete tree so aliases do not depend on which referrers
/// changed. Only requested aliases are written into export snapshot copies.
fn generated_export_anchors(targets: &[MarkdownNativeTarget]) -> BTreeMap<String, String> {
  let mut occupied = targets
    .iter()
    .filter_map(|target| target.source_anchor.clone())
    .collect::<HashSet<_>>();
  let blocks = targets
    .iter()
    .filter(|target| target.source_anchor.is_none() && target.can_export_anchor)
    .map(|target| target.block_id.clone())
    .collect::<BTreeSet<_>>();
  blocks
    .into_iter()
    .map(|block| {
      let base = format!("myoxus-{}", super::content_hash(&block));
      let mut anchor = base.clone();
      let mut suffix = 1usize;
      while !occupied.insert(anchor.clone()) {
        anchor = format!("{base}-{suffix}");
        suffix += 1;
      }
      (block, anchor)
    })
    .collect()
}

/// A portable single block selector must not discard unrelated navigation data.
pub fn portable_markdown_block_id(params: Option<&serde_json::Value>) -> Option<&str> {
  let params = params?.as_object()?;
  if params.keys().any(|key| !matches!(key.as_str(), "mode" | "blockIds"))
    || params.get("mode").is_some_and(|mode| mode.as_str() != Some("page"))
  {
    return None;
  }
  let blocks = params.get("blockIds")?.as_array()?;
  if blocks.len() != 1 {
    return None;
  }
  blocks[0].as_str().filter(|id| !id.is_empty())
}

fn portable_fragment(targets: &[MarkdownNativeTarget], target: &MarkdownNativeTarget) -> Option<String> {
  let fragment = if let Some(anchor) = &target.source_anchor {
    // An emptied target retains its native identity but cannot export a
    // standalone caret token as if it still owned a portable Markdown body.
    if !target.can_export_anchor {
      return None;
    }
    format!("^{anchor}")
  } else {
    target.heading_path.as_ref()?.join("#")
  };
  (resolve_markdown_target(targets, &fragment).ok()?.block_id == target.block_id).then_some(fragment)
}

fn normalize_root_relative_path(path: &str) -> Option<String> {
  if is_absolute_path_syntax(path) || contains_encoded_separator(path) {
    return None;
  }
  let mut components = Vec::new();
  let normalized_separators = path.replace('\\', "/");
  for component in normalized_separators.split('/') {
    match component {
      "" | "." => {}
      ".." => {
        components.pop()?;
      }
      value => components.push(value.to_string()),
    }
  }
  (!components.is_empty()).then(|| components.join("/"))
}

fn decode_reference_path(path: &str) -> Option<String> {
  if is_absolute_path_syntax(path) || contains_encoded_separator(path) {
    return None;
  }
  let decoded = urlencoding::decode(path).ok()?.into_owned();
  if decoded.contains('\0') || is_absolute_path_syntax(&decoded) || contains_encoded_separator(&decoded) {
    return None;
  }
  Some(decoded.replace('\\', "/"))
}

fn contains_encoded_separator(path: &str) -> bool {
  let lower = path.to_ascii_lowercase();
  lower.contains("%2f") || lower.contains("%5c")
}

fn is_absolute_path_syntax(path: &str) -> bool {
  let bytes = path.as_bytes();
  path.starts_with('/')
    || path.starts_with('\\')
    || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

fn is_path_like_wiki_target(target: &str) -> bool {
  if target.contains('/')
    || target.contains('\\')
    || target.starts_with('.')
    || target.to_ascii_lowercase().ends_with(".md")
    || is_absolute_path_syntax(target)
    || contains_encoded_separator(target)
  {
    return true;
  }
  urlencoding::decode(target)
    .ok()
    .is_some_and(|decoded| decoded.starts_with('.') || is_absolute_path_syntax(&decoded))
}

fn relative_markdown_path(source: &str, target: &str) -> String {
  let source = source.split('/').collect::<Vec<_>>();
  let source_parent = &source[..source.len().saturating_sub(1)];
  let target = target.split('/').collect::<Vec<_>>();
  let common = source_parent
    .iter()
    .zip(&target)
    .take_while(|(left, right)| left == right)
    .count();
  let mut parts = vec!["..".to_string(); source_parent.len() - common];
  parts.extend(
    target[common..]
      .iter()
      .map(|part| urlencoding::encode(part).into_owned()),
  );
  parts.join("/")
}

impl MarkdownReferenceLookup {
  pub fn new(
    document_base_url: &str,
    documents: impl IntoIterator<Item = AuthorizedMarkdownDocument>,
  ) -> Result<Self, ConversionError> {
    let document_base_url = Url::parse(document_base_url)
      .map_err(|_| ConversionError::Conversion("invalid Markdown document base URL".to_string()))?;
    if !matches!(document_base_url.scheme(), "http" | "https") || document_base_url.cannot_be_a_base() {
      return Err(ConversionError::Conversion(
        "invalid Markdown document base URL".to_string(),
      ));
    }
    let documents = documents
      .into_iter()
      .take(MAX_REFERENCE_TARGETS + 1)
      .map(|document| (document.external_id, document.title))
      .collect::<HashMap<_, _>>();
    if documents.len() > MAX_REFERENCE_TARGETS {
      return Err(ConversionError::Conversion(
        "Markdown reference lookup exceeds operation limit".to_string(),
      ));
    }
    Ok(Self {
      document_base_url,
      documents: Arc::new(documents),
    })
  }

  pub fn resolve_import_url(&self, candidate: &str) -> Option<MarkdownDocumentReference> {
    let candidate = Url::parse(candidate).ok()?;
    let external_id = self.own_external_id(&candidate)?;
    let title = self.documents.get(&external_id)?.clone();
    Some(MarkdownDocumentReference {
      page_id: external_id,
      title: Some(title),
      description: None,
      params: navigation_params(&candidate),
    })
  }

  pub fn resolve_link(&self, target: MarkdownLinkTarget<'_>) -> MarkdownLinkResolution {
    match target {
      MarkdownLinkTarget::Url(candidate) => {
        let Ok(url) = Url::parse(candidate) else {
          return MarkdownLinkResolution::Ordinary;
        };
        let Some(external_id) = self.own_external_id(&url) else {
          return MarkdownLinkResolution::Ordinary;
        };
        self
          .documents
          .get(&external_id)
          .map(|title| {
            MarkdownLinkResolution::Reference(MarkdownDocumentReference {
              page_id: external_id,
              title: Some(title.clone()),
              description: None,
              params: navigation_params(&url),
            })
          })
          .unwrap_or(MarkdownLinkResolution::Unresolved)
      }
      MarkdownLinkTarget::Wiki(target) => {
        if target.contains('#') {
          return MarkdownLinkResolution::Unsupported;
        }
        let title = target.strip_suffix(".md").unwrap_or(target);
        let mut matches = self
          .documents
          .iter()
          .filter(|(_, candidate_title)| candidate_title.as_str() == title);
        let Some((external_id, title)) = matches.next() else {
          return MarkdownLinkResolution::Unresolved;
        };
        if matches.next().is_some() {
          return MarkdownLinkResolution::Unresolved;
        }
        MarkdownLinkResolution::Reference(MarkdownDocumentReference {
          page_id: external_id.clone(),
          title: Some(title.clone()),
          description: None,
          params: None,
        })
      }
    }
  }

  pub fn resolve_export_reference(&self, reference: &MarkdownDocumentReference) -> Option<MarkdownResolvedReference> {
    let title = self.documents.get(&reference.page_id)?.clone();
    let mut url = self.document_base_url.clone();
    {
      let mut segments = url.path_segments_mut().ok()?;
      segments.pop_if_empty();
      segments.push(&reference.page_id);
    }
    append_navigation_params(&mut url, reference.params.as_ref());
    Some(MarkdownResolvedReference { url: url.into(), title })
  }

  fn own_external_id(&self, candidate: &Url) -> Option<String> {
    if candidate.origin() != self.document_base_url.origin()
      || candidate.fragment().is_some()
      || !candidate.username().is_empty()
      || candidate.password().is_some()
    {
      return None;
    }
    let base_path = self.document_base_url.path().trim_end_matches('/');
    let suffix = candidate.path().strip_prefix(base_path)?.strip_prefix('/')?;
    if suffix.is_empty() || suffix.contains('/') {
      return None;
    }
    let external_id = urlencoding::decode(suffix).ok()?.into_owned();
    (!external_id.is_empty() && !external_id.contains('/')).then_some(external_id)
  }
}

fn navigation_params(url: &Url) -> Option<serde_json::Value> {
  let mut params = serde_json::Map::new();
  for (key, value) in url.query_pairs() {
    match key.as_ref() {
      "mode" if matches!(value.as_ref(), "page" | "edgeless") => {
        params.insert(key.into_owned(), serde_json::Value::String(value.into_owned()));
      }
      "blockIds" | "elementIds" => {
        params.insert(
          key.into_owned(),
          serde_json::Value::Array(
            value
              .split(',')
              .filter(|item| !item.is_empty())
              .map(|item| serde_json::Value::String(item.to_string()))
              .collect(),
          ),
        );
      }
      "databaseId" | "databaseRowId" | "xywh" | "commentId" if !value.is_empty() => {
        params.insert(key.into_owned(), serde_json::Value::String(value.into_owned()));
      }
      _ => {}
    }
  }
  (!params.is_empty()).then_some(serde_json::Value::Object(params))
}

fn append_navigation_params(url: &mut Url, params: Option<&serde_json::Value>) {
  let Some(serde_json::Value::Object(params)) = params else {
    return;
  };
  let mut query = url.query_pairs_mut();
  for key in [
    "mode",
    "blockIds",
    "elementIds",
    "databaseId",
    "databaseRowId",
    "xywh",
    "commentId",
  ] {
    let Some(value) = params.get(key) else {
      continue;
    };
    match value {
      serde_json::Value::String(value) if !value.is_empty() => {
        query.append_pair(key, value);
      }
      serde_json::Value::Array(values) => {
        let value = values
          .iter()
          .filter_map(serde_json::Value::as_str)
          .collect::<Vec<_>>()
          .join(",");
        if !value.is_empty() {
          query.append_pair(key, &value);
        }
      }
      _ => {}
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use yjs::markdown::markdown_native_targets;

  fn lookup() -> MarkdownReferenceLookup {
    MarkdownReferenceLookup::new(
      "https://myoxus.test/workspace/workspace-key",
      [AuthorizedMarkdownDocument {
        external_id: "target-key".to_string(),
        title: "Renamed target".to_string(),
      }],
    )
    .expect("valid lookup")
  }

  fn target_inventory<'a>(snapshots: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> MarkdownBatchReferenceInventory {
    MarkdownBatchReferenceInventory::new(
      "https://myoxus.test/workspace/ws",
      [
        AuthorizedMarkdownBatchDocument {
          external_id: "source".into(),
          title: "Source".into(),
          path: "guides/source.md".into(),
        },
        AuthorizedMarkdownBatchDocument {
          external_id: "target".into(),
          title: "Current title".into(),
          path: "reference/target.md".into(),
        },
      ],
    )
    .expect("authorized metadata")
    .with_target_snapshots(snapshots)
    .expect("authorized current trees")
  }

  #[test]
  fn batch_fragments_resolve_current_native_blocks_and_decode_exactly_once() {
    let source = yjs::markdown_to_yjs("Source", "Local instruction ^local").expect("source");
    let target = yjs::markdown_to_yjs(
      "Target",
      "# Über Größe\n\n## Résumé\n\nInstruction ^release\n\n## Literal%20value\n",
    )
    .expect("target");
    let inventory = target_inventory([("source", source.as_slice()), ("target", target.as_slice())]);
    let lookup = inventory.for_source("guides/source.md").expect("source view");
    let targets = markdown_native_targets(&target).expect("current native targets");
    let expected = resolve_markdown_target(&targets, "Über Größe#Résumé").expect("native heading");
    for candidate in [
      MarkdownLinkTarget::Wiki("../reference/target#Über Größe#Résumé"),
      MarkdownLinkTarget::Url("../reference/target.md#%C3%9Cber%20Gr%C3%B6%C3%9Fe%23R%C3%A9sum%C3%A9"),
      MarkdownLinkTarget::Url("https://myoxus.test/workspace/ws/target#%C3%9Cber%20Gr%C3%B6%C3%9Fe%23R%C3%A9sum%C3%A9"),
    ] {
      let MarkdownLinkResolution::Reference(reference) = lookup.resolve_link(candidate) else {
        panic!("exact heading must resolve");
      };
      assert_eq!(reference.page_id, "target");
      assert_eq!(
        reference.params,
        Some(serde_json::json!({"mode":"page","blockIds":[expected.block_id]}))
      );
      assert_eq!(reference.title.as_deref(), Some("Current title"));
    }
    let MarkdownLinkResolution::Reference(reference) = lookup.resolve_link(MarkdownLinkTarget::Wiki("#^local")) else {
      panic!("local target");
    };
    assert_eq!(reference.page_id, "source");
    assert!(reference.params.unwrap()["blockIds"][0].as_str().unwrap() != "local");
    assert!(matches!(
      lookup.resolve_link(MarkdownLinkTarget::Url("../reference/target.md#Literal%2520value")),
      MarkdownLinkResolution::Reference(_)
    ));
    assert_eq!(
      lookup.resolve_link(MarkdownLinkTarget::Url("../reference/target.md#Literal%20value")),
      MarkdownLinkResolution::Unresolved
    );
    assert_eq!(
      lookup.resolve_link(MarkdownLinkTarget::Url(
        "https://myoxus.test/workspace/ws/target?mode=edgeless#Résumé"
      )),
      MarkdownLinkResolution::Unsupported
    );
  }

  #[test]
  fn native_target_ambiguity_missing_and_unauthorized_trees_fail_closed() {
    let binary =
      yjs::markdown_to_yjs("Duplicates", "# Same\n\nText ^same\n\n# Same\n\nOther ^same\n").expect("snapshot");
    let inventory = target_inventory([("target", binary.as_slice())]);
    let lookup = inventory.for_source("guides/source.md").expect("source");
    for selector in [
      "../reference/target#Same",
      "../reference/target#^same",
      "../reference/target#^missing",
      "../reference/missing#Same",
    ] {
      assert_eq!(
        lookup.resolve_link(MarkdownLinkTarget::Wiki(selector)),
        MarkdownLinkResolution::Unresolved
      );
    }
    let unauthorized = inventory
      .with_target_snapshots([("private", b"not even a valid snapshot".as_slice())])
      .expect_err("authorization before decoding");
    assert_eq!(
      unauthorized.to_string(),
      "markdown conversion failed: unauthorized Markdown target snapshot"
    );
    assert!(
      lookup
        .resolve_export_reference(&MarkdownDocumentReference {
          page_id: "private".into(),
          title: Some("Cached secret title".into()),
          params: Some(serde_json::json!({"mode":"page","blockIds":["private-block"]})),
          ..Default::default()
        })
        .is_none()
    );
  }

  #[test]
  fn heading_reference_labels_use_authorized_current_metadata_and_hide_cached_missing_titles() {
    let binary = yjs::markdown_to_yjs_with_link_resolver(
      "Target",
      "# Intro [[Source]]\n\n## Details\n\n# Private [[Private|Cached secret]]\n\n## Public suffix\n",
      &|target| match target {
        MarkdownLinkTarget::Wiki("Source") => MarkdownLinkResolution::Reference(MarkdownDocumentReference {
          page_id: "source".into(),
          ..Default::default()
        }),
        MarkdownLinkTarget::Wiki("Private") => MarkdownLinkResolution::Reference(MarkdownDocumentReference {
          page_id: "private".into(),
          ..Default::default()
        }),
        _ => MarkdownLinkResolution::Unresolved,
      },
    )
    .expect("native linked headings")
    .yjs_binary;
    let inventory = target_inventory([("target", binary.as_slice())]);
    let lookup = inventory.for_source("guides/source.md").expect("source view");
    assert!(matches!(
      lookup.resolve_link(MarkdownLinkTarget::Wiki("../reference/target#Intro Source#Details")),
      MarkdownLinkResolution::Reference(_)
    ));
    assert_eq!(
      lookup.resolve_link(MarkdownLinkTarget::Wiki("../reference/target#Private Cached secret")),
      MarkdownLinkResolution::Unresolved
    );
    assert!(matches!(
      lookup.resolve_link(MarkdownLinkTarget::Wiki("../reference/target#Public suffix")),
      MarkdownLinkResolution::Reference(_)
    ));
  }

  #[test]
  fn export_anchor_collection_follows_real_table_cells_not_detached_or_literal_references() {
    use yrs::updates::decoder::Decode;
    use yrs::{Array, GetString, Map, ReadTxn, Text, Transact};
    let target = yjs::markdown_to_yjs(
      "Target",
      "Table instruction\n\nRemoved instruction\n\nLiteral instruction\n",
    )
    .unwrap();
    let targets = markdown_native_targets(&target).unwrap();
    let resolve = |link: MarkdownLinkTarget<'_>| {
      let MarkdownLinkTarget::Wiki(label) = link else {
        return MarkdownLinkResolution::Ordinary;
      };
      let index = match label {
        "table" => 0,
        "removed" => 1,
        _ => return MarkdownLinkResolution::Unresolved,
      };
      MarkdownLinkResolution::Reference(MarkdownDocumentReference {
        page_id: "target".into(),
        title: Some(label.into()),
        description: None,
        params: Some(serde_json::json!({"mode":"page","blockIds":[targets[index].block_id]})),
      })
    };
    let table = "| Reference |\n| --- |\n| [[table]] |\n";
    let table_only = yjs::markdown_to_yjs_with_link_resolver("Source", table, &resolve)
      .unwrap()
      .yjs_binary;
    let source = yjs::markdown_to_yjs_with_link_resolver(
      "Source",
      &format!("{table}\n[[removed]]\n\n```text\nLiteral sample\n```\n\n`Inline sample`\n\n$z^2$\n"),
      &resolve,
    )
    .unwrap()
    .yjs_binary;
    let removed = markdown_native_targets(&source)
      .unwrap()
      .into_iter()
      .next()
      .expect("removable paragraph")
      .block_id;
    let doc = yrs::Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    doc
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(&source).unwrap())
      .unwrap();
    {
      let mut txn = doc.transact_mut();
      let values = blocks.iter(&txn).map(|(_, value)| value).collect::<Vec<_>>();
      for value in values {
        let yrs::Out::YMap(block) = value else { continue };
        if let Some(yrs::Out::YArray(children)) = block.get(&txn, "sys:children") {
          let position = children
            .iter(&txn)
            .position(|value| matches!(value, yrs::Out::Any(yrs::Any::String(id)) if id.as_ref() == removed));
          if let Some(position) = position {
            children.remove(&mut txn, position as u32);
          }
        }
        let is_table = matches!(block.get(&txn, "sys:flavour"), Some(yrs::Out::Any(yrs::Any::String(kind))) if kind.ends_with(":table"));
        let text = match block.get(&txn, "prop:text") {
          Some(yrs::Out::YText(text))
            if text.get_string(&txn).contains("sample")
              || text.diff(&txn, yrs::types::text::YChange::identity).iter().any(|diff| {
                diff
                  .attributes
                  .as_ref()
                  .is_some_and(|attrs| attrs.contains_key("latex"))
              }) =>
          {
            Some(text)
          }
          _ if is_table => Some(block.insert(
            &mut txn,
            "prop:cells.deleted-row:deleted-column.text",
            yrs::TextPrelim::new("Orphan sample"),
          )),
          _ => None,
        };
        if let Some(text) = text {
          // Conversion to a code block can leave old rich-text attributes.
          // The literal code writer must not let them request a target anchor.
          let reference = yrs::Any::Map(Arc::new(HashMap::from([
            ("type".into(), yrs::Any::String("LinkedPage".into())),
            ("pageId".into(), yrs::Any::String("target".into())),
            (
              "params".into(),
              yrs::Any::Map(Arc::new(HashMap::from([
                ("mode".into(), yrs::Any::String("page".into())),
                (
                  "blockIds".into(),
                  yrs::Any::Array(Arc::from([yrs::Any::String(targets[2].block_id.clone().into())])),
                ),
              ]))),
            ),
          ])));
          let length = text.len(&txn);
          text.format(
            &mut txn,
            0,
            length,
            yrs::types::Attrs::from([("reference".into(), reference)]),
          );
        }
      }
    }
    let source = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
    let inventory = MarkdownBatchReferenceInventory::new(
      "https://myoxus.test/workspace/ws",
      [
        AuthorizedMarkdownBatchDocument {
          external_id: "source".into(),
          title: "Source".into(),
          path: "source.md".into(),
        },
        AuthorizedMarkdownBatchDocument {
          external_id: "target".into(),
          title: "Target".into(),
          path: "target.md".into(),
        },
      ],
    )
    .unwrap();
    assert!(
      inventory.requires_native_export_targets(&table_only).unwrap(),
      "table-only precise references need current target trees too"
    );
    let prepared = inventory
      .prepare_export_snapshots(HashMap::from([("source".into(), source), ("target".into(), target)]))
      .unwrap();
    let exported_targets = markdown_native_targets(&prepared.snapshots["target"]).unwrap();
    assert!(
      exported_targets[0]
        .source_anchor
        .as_ref()
        .unwrap()
        .starts_with("myoxus-")
    );
    assert!(
      exported_targets[1..]
        .iter()
        .all(|target| target.source_anchor.is_none()),
      "detached and literal references must not allocate ghost anchors"
    );
    let source = super::super::project_document_in_batch(
      &prepared.snapshots["source"],
      "Source",
      Default::default(),
      &prepared.references.for_source("source.md").unwrap(),
    )
    .unwrap();
    assert!(
      source.markdown.contains(&format!(
        "[Target](target.md#%5E{})",
        exported_targets[0].source_anchor.as_ref().unwrap()
      )),
      "table reference must point to the emitted anchor: {}",
      source.markdown
    );
    assert!(source.markdown.contains("```text\nLiteral sample\n```"));
    assert!(source.markdown.contains("`Inline sample`"));
    assert!(source.markdown.contains("$z^2$"));
    assert!(!source.markdown.contains("Orphan sample"));
    assert!(!source.markdown.contains("removed"));
  }

  #[test]
  fn export_preparation_generates_only_referenced_anchors_without_live_writes_and_roundtrips() {
    let target = yjs::markdown_to_yjs("Target", "# Editable heading\n\nRelease instruction\n\n- Check backup\n\nUnreferenced\n\nRetained ^source-anchor\n\n```text\n^literal\n```\n\n%%Hidden ^annotation%%\n").unwrap();
    let target_tree = markdown_native_targets(&target).unwrap();
    let referenced_ids = target_tree
      .iter()
      .take(3)
      .map(|target| target.block_id.clone())
      .collect::<Vec<_>>();
    assert_eq!(referenced_ids.len(), 3);
    let retained_id = target_tree
      .iter()
      .find(|target| target.source_anchor.as_deref() == Some("source-anchor"))
      .unwrap()
      .block_id
      .clone();
    let source =
      yjs::markdown_to_yjs_with_link_resolver("Source", "[[heading]] [[paragraph]] [[list]] [[retained]]", &|link| {
        let MarkdownLinkTarget::Wiki(label) = link else {
          return MarkdownLinkResolution::Ordinary;
        };
        let id = match label {
          "heading" => &referenced_ids[0],
          "paragraph" => &referenced_ids[1],
          "list" => &referenced_ids[2],
          "retained" => &retained_id,
          _ => return MarkdownLinkResolution::Unresolved,
        };
        MarkdownLinkResolution::Reference(MarkdownDocumentReference {
          page_id: "target".into(),
          title: None,
          description: None,
          params: Some(serde_json::json!({"mode":"page", "blockIds":[id]})),
        })
      })
      .unwrap()
      .yjs_binary;
    let inventory = || {
      MarkdownBatchReferenceInventory::new(
        "https://myoxus.test/workspace/ws",
        [
          AuthorizedMarkdownBatchDocument {
            external_id: "source".into(),
            title: "Source".into(),
            path: "guides/source.md".into(),
          },
          AuthorizedMarkdownBatchDocument {
            external_id: "target".into(),
            title: "Target".into(),
            path: "reference/target.md".into(),
          },
        ],
      )
      .unwrap()
    };
    let snapshots = || HashMap::from([("source".into(), source.clone()), ("target".into(), target.clone())]);
    assert!(inventory().requires_native_export_targets(&source).unwrap());
    assert!(!inventory().requires_native_export_targets(&target).unwrap());
    assert!(!inventory().requires_native_export_targets(&[0, 0]).unwrap());
    assert!(inventory().requires_native_export_targets(&[255]).is_err());
    assert!(
      !MarkdownBatchReferenceInventory::new("https://myoxus.test/workspace/ws", [])
        .unwrap()
        .requires_native_export_targets(&source)
        .unwrap(),
      "inaccessible metadata must not trigger target reads"
    );
    let exported = inventory().prepare_export_snapshots(snapshots()).unwrap();
    let prepared_tree = markdown_native_targets(&exported.snapshots["target"]).unwrap();
    assert_eq!(
      markdown_native_targets(&target).unwrap(),
      target_tree,
      "live/source snapshot is unchanged"
    );
    for id in &referenced_ids {
      let original = target_tree.iter().find(|target| target.block_id == *id).unwrap();
      let prepared = prepared_tree.iter().find(|target| target.block_id == *id).unwrap();
      assert!(original.source_anchor.is_none());
      assert_eq!(
        prepared.source_anchor.as_deref(),
        Some(format!("myoxus-{}", super::super::content_hash(id)).as_str())
      );
    }
    assert_eq!(
      prepared_tree
        .iter()
        .filter(|target| target.source_anchor.is_some())
        .count(),
      4
    );
    let repeated = inventory().prepare_export_snapshots(snapshots()).unwrap();
    assert_eq!(
      markdown_native_targets(&repeated.snapshots["target"]).unwrap(),
      prepared_tree
    );
    let project = |id: &str, path: &str| {
      super::super::project_document_in_batch(
        &exported.snapshots[id],
        id,
        super::super::MarkdownProjectionPolicy::default(),
        &exported.references.for_source(path).unwrap(),
      )
      .unwrap()
    };
    let source_md = project("source", "guides/source.md");
    let target_md = project("target", "reference/target.md");
    assert!(!source_md.partial && !target_md.partial);
    assert!(source_md.markdown.contains("../reference/target.md#%5Esource-anchor"));
    assert_eq!(target_md.markdown.matches("^myoxus-").count(), 3);
    assert!(target_md.markdown.contains("^source-anchor"));
    assert!(target_md.markdown.contains("^literal") && target_md.markdown.contains("%%Hidden ^annotation%%"));

    let existing = inventory()
      .with_target_snapshots([("target", target.as_slice())])
      .unwrap()
      .with_exported_target_sources([("target", target_md.markdown.as_str())])
      .unwrap()
      .with_import_sources([("guides/source.md", source_md.markdown.as_str())])
      .unwrap();
    let source_only = super::super::prepare_markdown_batch_import(
      "Source",
      &source_md.markdown,
      &existing.for_source("guides/source.md").unwrap(),
    )
    .unwrap();
    assert!(source_only.diagnostics.is_empty());
    let source_only_refs = yjs::extract_document_references_from_yjs(&source_only.yjs_binary).unwrap();
    assert_eq!(source_only_refs.occurrences.len(), 4);
    for (reference, id) in source_only_refs
      .occurrences
      .iter()
      .zip(referenced_ids.iter().chain([&retained_id]))
    {
      assert_eq!(reference.params_json["params"]["blockIds"], serde_json::json!([id]));
    }
    let anchor = format!("myoxus-{}", super::super::content_hash(&referenced_ids[0]));
    let unobserved = format!("myoxus-{}", super::super::content_hash(&target_tree[3].block_id));
    assert!(matches!(
      existing
        .for_source("guides/source.md")
        .unwrap()
        .resolve_link(MarkdownLinkTarget::Wiki(&format!("../reference/target#^{unobserved}"))),
      MarkdownLinkResolution::Unresolved
    ));
    for invalid_body in [
      target_md.markdown.replace(&format!(" ^{anchor}"), ""),
      format!("{}\n\nAnother paragraph ^{anchor}\n", target_md.markdown),
      format!("```text\nLiteral ^{anchor}\n```\n\n%%Hidden ^{anchor}%%\n"),
    ] {
      let invalid = inventory()
        .with_target_snapshots([("target", target.as_slice())])
        .unwrap()
        .with_exported_target_sources([("target", invalid_body.as_str())])
        .unwrap();
      assert!(
        matches!(
          invalid
            .for_source("guides/source.md")
            .unwrap()
            .resolve_link(MarkdownLinkTarget::Wiki(&format!("../reference/target#^{anchor}"))),
          MarkdownLinkResolution::Unresolved
        ),
        "unobserved, repeated and literal aliases cannot bind native targets"
      );
    }
    assert!(inventory().with_exported_target_sources([("target", "body")]).is_err());
    assert!(
      inventory()
        .with_target_snapshots([("target", target.as_slice())])
        .unwrap()
        .with_exported_target_sources([("inaccessible", "body")])
        .is_err()
    );

    let imported = inventory()
      .with_import_sources([
        ("guides/source.md", source_md.markdown.as_str()),
        ("reference/target.md", target_md.markdown.as_str()),
      ])
      .unwrap();
    let import = |title, body: &str, path| {
      super::super::prepare_markdown_batch_import(title, body, &imported.for_source(path).unwrap()).unwrap()
    };
    let target_again = import("Target", &target_md.markdown, "reference/target.md");
    let source_again = import("Source", &source_md.markdown, "guides/source.md");
    assert!(target_again.diagnostics.is_empty() && source_again.diagnostics.is_empty());
    let current = markdown_native_targets(&target_again.yjs_binary).unwrap();
    let references = yjs::extract_document_references_from_yjs(&source_again.yjs_binary).unwrap();
    assert_eq!(references.occurrences.len(), 4);
    for (reference, previous) in references.occurrences.iter().zip(
      prepared_tree.iter().take(3).chain(
        prepared_tree
          .iter()
          .filter(|target| target.source_anchor.as_deref() == Some("source-anchor")),
      ),
    ) {
      let anchor = previous.source_anchor.as_ref().unwrap();
      let current_target = resolve_markdown_target(&current, &format!("^{anchor}")).unwrap();
      assert_eq!(reference.params_json["params"]["blockIds"][0], current_target.block_id);
      assert_ne!(
        current_target.block_id, previous.block_id,
        "new import identity is bound by provenance, not reused native IDs"
      );
    }
  }

  #[test]
  fn portable_export_follows_current_heading_identity_and_retained_source_anchors() {
    use yrs::updates::decoder::Decode;
    use yrs::{Map, ReadTxn, Text, Transact};
    let binary = yjs::markdown_to_yjs("Target", "# Before\n\nInstruction ^release\n").expect("target");
    let inventory = target_inventory([("target", binary.as_slice())]);
    let lookup = inventory.for_source("guides/source.md").expect("source");
    let MarkdownLinkResolution::Reference(heading) =
      lookup.resolve_link(MarkdownLinkTarget::Wiki("../reference/target#Before"))
    else {
      panic!("heading target");
    };
    let MarkdownLinkResolution::Reference(block) =
      lookup.resolve_link(MarkdownLinkTarget::Wiki("../reference/target#^release"))
    else {
      panic!("paragraph target");
    };
    assert_eq!(
      lookup.resolve_export_reference(&heading).expect("portable heading").url,
      "../reference/target.md#Before"
    );
    assert_eq!(
      lookup.resolve_export_reference(&block).expect("portable anchor").url,
      "../reference/target.md#%5Erelease"
    );
    let local = inventory.for_source("reference/target.md").expect("local source");
    assert_eq!(
      local.resolve_export_reference(&block).expect("local anchor").url,
      "#%5Erelease"
    );

    let doc = yrs::Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    doc
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(&binary).expect("decode"))
      .expect("load");
    let id = portable_markdown_block_id(heading.params.as_ref()).expect("native ID");
    {
      let mut txn = doc.transact_mut();
      let Some(yrs::Out::YMap(block)) = blocks.get(&txn, id) else {
        panic!("native heading");
      };
      let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
        panic!("native heading text");
      };
      let length = text.len(&txn);
      text.remove_range(&mut txn, 0, length);
      text.insert(&mut txn, 0, "Après modification");
    }
    let renamed = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
    let current = target_inventory([("target", renamed.as_slice())]);
    let materialized = current
      .clone()
      .with_materialized_target_sources([("target", "# Before\n\nInstruction ^release\n")])
      .unwrap()
      .for_source("guides/source.md")
      .unwrap();
    assert!(
      materialized.resolve_export_reference(&heading).is_none(),
      "pending heading must not link to an unmaterialized fragment"
    );
    assert!(
      materialized.resolve_export_reference(&block).is_some(),
      "verified existing anchors remain addressable"
    );
    let current = current.for_source("guides/source.md").expect("edited source view");
    assert_eq!(
      current
        .resolve_export_reference(&heading)
        .expect("same identity, current name")
        .url,
      "../reference/target.md#Apr%C3%A8s%20modification"
    );
    assert_eq!(
      current.resolve_link(MarkdownLinkTarget::Wiki("../reference/target#Before")),
      MarkdownLinkResolution::Unresolved
    );
    {
      let mut txn = doc.transact_mut();
      let id = portable_markdown_block_id(block.params.as_ref()).expect("anchored paragraph ID");
      let Some(yrs::Out::YMap(paragraph)) = blocks.get(&txn, id) else {
        panic!("anchored paragraph");
      };
      let Some(yrs::Out::YText(text)) = paragraph.get(&txn, "prop:text") else {
        panic!("anchored paragraph text");
      };
      let length = text.len(&txn);
      text.remove_range(&mut txn, 0, length);
    }
    let emptied = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
    let emptied_inventory = target_inventory([("target", emptied.as_slice())]);
    assert!(
      emptied_inventory
        .for_source("guides/source.md")
        .unwrap()
        .resolve_export_reference(&block)
        .is_none(),
      "removing the target body cannot produce an orphan portable anchor or a whole-document fallback"
    );
    let emptied_export = yjs::extract_text_from_yjs(&emptied).expect("diagnosed export");
    assert!(!emptied_export.markdown.contains("^release"));
    assert!(
      emptied_export
        .diagnostics
        .iter()
        .any(|finding| { finding.code == yjs::MarkdownDiagnosticCode::UnsupportedNativeContent })
    );
    {
      let mut txn = doc.transact_mut();
      let parents = blocks.iter(&txn).map(|(_, block)| block).collect::<Vec<_>>();
      for parent in parents {
        if let yrs::Out::YMap(parent) = parent
          && let Some(yrs::Out::YArray(children)) = parent.get(&txn, "sys:children")
        {
          use yrs::Array;
          if let Some(index) = children
            .iter(&txn)
            .position(|value| matches!(value, yrs::Out::Any(yrs::Any::String(value)) if value.as_ref() == id))
          {
            children.remove(&mut txn, index as u32);
          }
        }
      }
    }
    let deleted = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
    let deleted = target_inventory([("target", deleted.as_slice())]);
    assert!(
      deleted
        .for_source("guides/source.md")
        .expect("deleted source view")
        .resolve_export_reference(&heading)
        .is_none(),
      "deleted block must not silently become a whole-document or stale canonical link"
    );
  }

  #[test]
  fn own_workspace_urls_are_structural_and_authorized() {
    let lookup = lookup();
    let reference = lookup
      .resolve_import_url(
        "https://myoxus.test/workspace/workspace-key/target-key?mode=page&blockIds=one,two&commentId=c-1",
      )
      .expect("authorized local URL");
    assert_eq!(reference.page_id, "target-key");
    assert_eq!(reference.title.as_deref(), Some("Renamed target"));
    assert_eq!(
      reference.params.as_ref().and_then(|value| value["mode"].as_str()),
      Some("page")
    );

    assert!(
      lookup
        .resolve_import_url("https://myoxus.test/workspace/other/target-key")
        .is_none()
    );
    assert!(
      lookup
        .resolve_import_url("https://myoxus.test.evil/workspace/workspace-key/target-key")
        .is_none()
    );
    assert!(
      lookup
        .resolve_import_url("https://myoxus.test/workspace/workspace-key/inaccessible-key")
        .is_none()
    );
    assert!(
      lookup
        .resolve_import_url("https://myoxus.test/workspace/workspace-key/target%2Fkey")
        .is_none()
    );
  }

  #[test]
  fn wiki_title_resolution_is_exact_and_ambiguous_titles_fail_closed() {
    let unique = lookup().resolve_link(MarkdownLinkTarget::Wiki("Renamed target.md"));
    assert!(matches!(unique, MarkdownLinkResolution::Reference(reference) if reference.page_id == "target-key"));

    let ambiguous = MarkdownReferenceLookup::new(
      "https://myoxus.test/workspace/ws",
      [
        AuthorizedMarkdownDocument {
          external_id: "one".to_string(),
          title: "Duplicate".to_string(),
        },
        AuthorizedMarkdownDocument {
          external_id: "two".to_string(),
          title: "Duplicate".to_string(),
        },
      ],
    )
    .expect("lookup");
    assert_eq!(
      ambiguous.resolve_link(MarkdownLinkTarget::Wiki("Duplicate")),
      MarkdownLinkResolution::Unresolved
    );
    assert_eq!(
      ambiguous.resolve_link(MarkdownLinkTarget::Wiki("duplicate")),
      MarkdownLinkResolution::Unresolved
    );
  }

  #[test]
  fn batch_paths_win_over_titles_and_cannot_escape_the_root() {
    let documents = [
      AuthorizedMarkdownBatchDocument {
        external_id: "source".into(),
        title: "Source".into(),
        path: "guides/source.md".into(),
      },
      AuthorizedMarkdownBatchDocument {
        external_id: "target".into(),
        title: "Different title".into(),
        path: "reference/target.md".into(),
      },
    ];
    let lookup = MarkdownBatchReferenceLookup::new("https://myoxus.test/workspace/ws", documents, "guides/source.md")
      .expect("batch lookup");
    assert!(matches!(
      lookup.resolve_link(MarkdownLinkTarget::Wiki("../reference/target")),
      MarkdownLinkResolution::Reference(reference) if reference.page_id == "target"
    ));
    assert_eq!(
      lookup.resolve_link(MarkdownLinkTarget::Wiki("../../outside")),
      MarkdownLinkResolution::Unresolved
    );
    assert_eq!(
      lookup.resolve_link(MarkdownLinkTarget::Url("../reference/target.md#heading")),
      MarkdownLinkResolution::Unsupported
    );
  }

  #[test]
  fn batch_paths_reject_platform_absolute_and_encoded_separator_targets() {
    let lookup = MarkdownBatchReferenceLookup::new_with_authorized(
      "https://myoxus.test/workspace/ws",
      [
        AuthorizedMarkdownDocument {
          external_id: "legitimate".into(),
          title: "Legitimate title".into(),
        },
        AuthorizedMarkdownDocument {
          external_id: "unsafe-title".into(),
          title: "/root.md".into(),
        },
      ],
      [
        AuthorizedMarkdownBatchDocument {
          external_id: "source".into(),
          title: "Source".into(),
          path: "guides/deep/source.md".into(),
        },
        AuthorizedMarkdownBatchDocument {
          external_id: "target".into(),
          title: "Target".into(),
          path: "ziel/über.md".into(),
        },
      ],
      "guides/deep/source.md",
    )
    .expect("batch lookup");

    assert!(matches!(
      lookup.resolve_link(MarkdownLinkTarget::Wiki("../../ziel/über")),
      MarkdownLinkResolution::Reference(reference) if reference.page_id == "target"
    ));
    assert!(matches!(
      lookup.resolve_link(MarkdownLinkTarget::Wiki("Legitimate title")),
      MarkdownLinkResolution::Reference(reference) if reference.page_id == "legitimate"
    ));
    for target in [
      "/root.md",
      "C:\\root.md",
      "C:/root.md",
      "\\\\server\\share.md",
      "../../../outside.md",
      "%2Froot.md",
      "nested%5Ctarget.md",
      "nested%252Ftarget.md",
      "%2E%2E",
      "%2Froot",
      "%43%3Aroot",
    ] {
      assert_eq!(
        lookup.resolve_link(MarkdownLinkTarget::Wiki(target)),
        MarkdownLinkResolution::Unresolved,
        "unsafe target {target} must not resolve through an exact title"
      );
    }
  }

  #[test]
  fn batch_source_inventory_rejects_absolute_and_normalized_collisions() {
    for path in [
      "/root.md",
      "C:\\root.md",
      "C:/root.md",
      "\\\\server\\share.md",
      "../outside.md",
      "%2Froot.md",
    ] {
      let result = MarkdownBatchReferenceLookup::new(
        "https://myoxus.test/workspace/ws",
        [AuthorizedMarkdownBatchDocument {
          external_id: "source".into(),
          title: "Source".into(),
          path: path.into(),
        }],
        "source.md",
      );
      assert!(result.is_err(), "unsafe source path {path} must fail");
    }

    let collision = MarkdownBatchReferenceLookup::new(
      "https://myoxus.test/workspace/ws",
      [
        AuthorizedMarkdownBatchDocument {
          external_id: "one".into(),
          title: "One".into(),
          path: "docs/./target.md".into(),
        },
        AuthorizedMarkdownBatchDocument {
          external_id: "two".into(),
          title: "Two".into(),
          path: "docs/target.md".into(),
        },
      ],
      "source.md",
    );
    assert!(collision.is_err());
  }

  #[test]
  fn batch_export_uses_relative_paths_unless_navigation_is_present() {
    let documents = [
      AuthorizedMarkdownBatchDocument {
        external_id: "source".into(),
        title: "Source".into(),
        path: "guides/source.md".into(),
      },
      AuthorizedMarkdownBatchDocument {
        external_id: "target".into(),
        title: "Target".into(),
        path: "reference/target file.md".into(),
      },
    ];
    let lookup = MarkdownBatchReferenceLookup::new("https://myoxus.test/workspace/ws", documents, "guides/source.md")
      .expect("batch lookup");
    let relative = lookup
      .resolve_export_reference(&MarkdownDocumentReference {
        page_id: "target".into(),
        title: Some("Alias".into()),
        description: None,
        params: None,
      })
      .expect("relative target");
    assert_eq!(relative.url, "../reference/target%20file.md");
    let canonical = lookup
      .resolve_export_reference(&MarkdownDocumentReference {
        page_id: "target".into(),
        title: None,
        description: None,
        params: Some(serde_json::json!({"mode":"page"})),
      })
      .expect("canonical target");
    assert!(canonical.url.starts_with("https://myoxus.test/workspace/ws/target?"));
  }

  #[test]
  fn batch_export_keeps_canonical_links_for_authorized_omitted_targets() {
    let lookup = MarkdownBatchReferenceLookup::new_with_authorized(
      "https://myoxus.test/workspace/ws",
      [AuthorizedMarkdownDocument {
        external_id: "omitted".into(),
        title: "Current omitted title".into(),
      }],
      [AuthorizedMarkdownBatchDocument {
        external_id: "source".into(),
        title: "Source".into(),
        path: "guides/source.md".into(),
      }],
      "guides/source.md",
    )
    .expect("batch lookup");

    let omitted = lookup
      .resolve_export_reference(&MarkdownDocumentReference {
        page_id: "omitted".into(),
        title: Some("Stable alias".into()),
        description: None,
        params: None,
      })
      .expect("authorized omitted target");
    assert_eq!(omitted.title, "Current omitted title");
    assert_eq!(omitted.url, "https://myoxus.test/workspace/ws/omitted");

    let navigated = lookup
      .resolve_export_reference(&MarkdownDocumentReference {
        page_id: "omitted".into(),
        title: Some("Stable alias".into()),
        description: None,
        params: Some(serde_json::json!({"mode":"page","blockIds":["block-1"]})),
      })
      .expect("authorized omitted target with navigation");
    assert_eq!(
      navigated.url,
      "https://myoxus.test/workspace/ws/omitted?mode=page&blockIds=block-1"
    );

    assert!(
      lookup
        .resolve_export_reference(&MarkdownDocumentReference {
          page_id: "not-authorized".into(),
          title: Some("Do not disclose".into()),
          description: None,
          params: None,
        })
        .is_none(),
      "deleted or inaccessible targets must remain indistinguishable"
    );
  }

  #[test]
  fn vault_lookup_resolves_root_relative_and_only_unique_basenames() {
    let inventory = MarkdownBatchReferenceInventory::new(
      "https://myoxus.test/workspace/ws",
      [
        AuthorizedMarkdownBatchDocument {
          external_id: "source".into(),
          title: "Source".into(),
          path: "Projects/source.md".into(),
        },
        AuthorizedMarkdownBatchDocument {
          external_id: "root".into(),
          title: "Root target".into(),
          path: "People/root.md".into(),
        },
        AuthorizedMarkdownBatchDocument {
          external_id: "unique".into(),
          title: "Unique".into(),
          path: "Archive/unique.md".into(),
        },
        AuthorizedMarkdownBatchDocument {
          external_id: "shared-a".into(),
          title: "Shared A".into(),
          path: "People/shared.md".into(),
        },
        AuthorizedMarkdownBatchDocument {
          external_id: "shared-b".into(),
          title: "Shared B".into(),
          path: "Archive/shared.md".into(),
        },
      ],
    )
    .expect("inventory");
    let lookup = inventory.for_vault_source("Projects/source.md").expect("vault lookup");

    assert!(matches!(
      lookup.resolve_link(MarkdownLinkTarget::Wiki("/People/root")),
      MarkdownLinkResolution::Reference(reference) if reference.page_id == "root"
    ));
    assert!(matches!(
      lookup.resolve_link(MarkdownLinkTarget::Wiki("unique")),
      MarkdownLinkResolution::Reference(reference) if reference.page_id == "unique"
    ));
    assert_eq!(
      lookup.resolve_link(MarkdownLinkTarget::Wiki("shared")),
      MarkdownLinkResolution::Unresolved
    );
  }
}
