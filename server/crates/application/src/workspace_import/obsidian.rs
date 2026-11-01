// SPDX-License-Identifier: AGPL-3.0-or-later
//! Pure Obsidian-vault planning shared by preview and apply.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use myoxus_domain::workspace_import::WorkspaceImportRecord;
use myoxus_workspace_import::{
  DecodedDocumentContent, DecodedWorkspace, DecodedWorkspaceTag, WorkspaceImportDiagnostic,
  WorkspaceImportDiagnosticCode,
};
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::markdown::{
  AuthorizedMarkdownBatchDocument, MarkdownBatchReferenceInventory, markdown_image_sources,
  prepare_markdown_batch_import, rewrite_markdown_image_sources,
};

use super::WorkspaceImportTargetPlan;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultPreservation {
  Native,
  Normalized,
  SourcePreserved,
  Blocking,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultClassification {
  pub source_path: String,
  pub code: String,
  pub preservation: VaultPreservation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultDocumentPlan {
  pub source_path: String,
  pub target_document_id: Uuid,
  pub display_title: String,
  pub organizer_folder_ids: Vec<Uuid>,
  pub aliases: Vec<String>,
  pub properties: JsonValue,
  pub tags: Vec<String>,
  pub prepared_content_hash: String,
  pub recovery_source_required: bool,
  pub recovery_source_asset_id: Option<Uuid>,
  /// Prepared once by the pure preview/apply codec. Durable previews omit the
  /// bytes while a freshly rebuilt Apply plan carries them to persistence.
  #[serde(skip)]
  pub(crate) prepared_yjs: Vec<u8>,
}

impl PartialEq for VaultDocumentPlan {
  fn eq(&self, other: &Self) -> bool {
    self.source_path == other.source_path
      && self.target_document_id == other.target_document_id
      && self.display_title == other.display_title
      && self.organizer_folder_ids == other.organizer_folder_ids
      && self.aliases == other.aliases
      && self.properties == other.properties
      && self.tags == other.tags
      && self.prepared_content_hash == other.prepared_content_hash
      && self.recovery_source_required == other.recovery_source_required
      && self.recovery_source_asset_id == other.recovery_source_asset_id
  }
}

impl Eq for VaultDocumentPlan {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultAssetPlan {
  pub source_path: String,
  pub target_asset_id: Uuid,
  pub content_hash: String,
  pub recovery_source: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFolderPlan {
  pub source_path: String,
  pub target_folder_id: Uuid,
  pub parent_folder_id: Option<Uuid>,
  pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianVaultPlan {
  pub documents: Vec<VaultDocumentPlan>,
  pub assets: Vec<VaultAssetPlan>,
  pub folders: Vec<VaultFolderPlan>,
  pub labels: Vec<DecodedWorkspaceTag>,
  pub classifications: Vec<VaultClassification>,
  #[serde(default)]
  pub diagnostics: Vec<WorkspaceImportDiagnostic>,
}

pub(super) fn plan_vault(
  record: &WorkspaceImportRecord,
  decoded: &DecodedWorkspace,
) -> Result<ObsidianVaultPlan, WorkspaceImportDiagnostic> {
  let assets_by_path = decoded
    .assets
    .iter()
    .map(|asset| (asset.source_key.clone(), asset.size_bytes))
    .collect::<BTreeMap<_, _>>();
  // Retain the normalized bodies for both passes. Re-parsing or rewriting a
  // different body after reservation could bind links to unrelated native IDs.
  let notes = decoded
    .documents
    .iter()
    .map(|document| {
      let DecodedDocumentContent::MarkdownUtf8(bytes) = &document.content else {
        return Err(blocking("Obsidian note content is not Markdown", &document.source_id));
      };
      let source = std::str::from_utf8(bytes)
        .map_err(|_| blocking("Obsidian note text is not valid UTF-8", &document.source_id))?;
      let parsed = match parse_note(source, &document.source_id) {
        Ok(parsed) => parsed,
        Err(diagnostic) => return Ok(Err(diagnostic)),
      };
      let (markdown, attachments, native_asset_embed, unsupported_asset_embed) =
        prepare_vault_embeds(&parsed.visible_markdown, &document.source_id, &assets_by_path)
          .map_err(|_| blocking("Obsidian image references cannot be normalized", &document.source_id))?;
      Ok(Ok(PreparedVaultNote {
        parsed,
        markdown,
        attachments,
        native_asset_embed,
        unsupported_asset_embed,
      }))
    })
    .collect::<Result<Vec<_>, WorkspaceImportDiagnostic>>()?;
  let inventory = MarkdownBatchReferenceInventory::new(
    "https://myoxus.invalid/workspace-import/",
    decoded
      .documents
      .iter()
      .zip(&notes)
      .map(|(document, note)| AuthorizedMarkdownBatchDocument {
        external_id: target_id(record.id, "document", &document.source_id).to_string(),
        title: note.as_ref().map_or_else(
          |_| document.title.clone(),
          |note| note.parsed.display_title(&document.title),
        ),
        path: document.source_id.clone(),
      }),
  )
  .and_then(|inventory| {
    inventory.with_vault_import_sources(decoded.documents.iter().zip(&notes).filter_map(|(document, note)| {
      note
        .as_ref()
        .ok()
        .map(|note| (document.source_id.as_str(), note.markdown.as_str()))
    }))
  })
  .map_err(|_| blocking("Markdown reference inventory is invalid", ""))?;

  let folder_paths = collect_folder_paths(decoded);
  let folder_ids = folder_paths
    .iter()
    .map(|path| (path.clone(), target_id(record.id, "folder", path)))
    .collect::<BTreeMap<_, _>>();
  let folders = folder_paths
    .iter()
    .map(|path| {
      let (parent, name) = path
        .rsplit_once('/')
        .map_or((None, path.as_str()), |(parent, name)| (Some(parent), name));
      VaultFolderPlan {
        source_path: path.clone(),
        target_folder_id: folder_ids[path],
        parent_folder_id: parent.and_then(|parent| folder_ids.get(parent).copied()),
        name: name.to_string(),
      }
    })
    .collect::<Vec<_>>();

  let mut classifications = Vec::new();
  let mut diagnostics = Vec::new();
  let mut documents = Vec::with_capacity(decoded.documents.len());
  for (document, note) in decoded.documents.iter().zip(notes) {
    let DecodedDocumentContent::MarkdownUtf8(bytes) = &document.content else {
      return Err(blocking("Obsidian note content is not Markdown", &document.source_id));
    };
    let source =
      std::str::from_utf8(bytes).map_err(|_| blocking("Obsidian note text is not valid UTF-8", &document.source_id))?;
    let PreparedVaultNote {
      mut parsed,
      markdown: prepared_markdown,
      attachments,
      native_asset_embed,
      unsupported_asset_embed,
    } = match note {
      Ok(note) => note,
      Err(diagnostic) => {
        diagnostics.push(diagnostic);
        classifications.push(classification(
          &document.source_id,
          "VAULT_YAML_BLOCKING",
          VaultPreservation::Blocking,
        ));
        documents.push(blocked_document_plan(record.id, document, source, &folder_ids));
        continue;
      }
    };
    if native_asset_embed {
      parsed.classifications.push(classification(
        &document.source_id,
        "VAULT_ASSET_EMBED_NATIVE",
        VaultPreservation::Native,
      ));
    }
    if unsupported_asset_embed {
      parsed.recovery_source_required = true;
      parsed.classifications.push(classification(
        &document.source_id,
        "VAULT_ASSET_EMBED_SOURCE_PRESERVED",
        VaultPreservation::SourcePreserved,
      ));
      parsed.diagnostics.push(
        WorkspaceImportDiagnostic::informational(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultSourcePreserved,
          "Unsupported or unresolved Obsidian attachment embed is retained in recovery source",
        )
        .with_source_path(&document.source_id),
      );
    }
    let lookup = inventory
      .for_vault_source(&document.source_id)
      .map_err(|_| blocking("Obsidian note path cannot be resolved", &document.source_id))?;
    let mut prepared =
      match prepare_markdown_batch_import(&parsed.display_title(&document.title), &prepared_markdown, &lookup) {
        Ok(prepared) => prepared,
        Err(error) => {
          let footnote_message = footnote_conversion_message(&error);
          diagnostics.push(
            WorkspaceImportDiagnostic::blocking(
              WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
              footnote_message
                .clone()
                .unwrap_or_else(|| "Obsidian note cannot be converted without changing its meaning".to_string()),
            )
            .with_source_path(&document.source_id),
          );
          classifications.push(classification(
            &document.source_id,
            if footnote_message.is_some() {
              "VAULT_FOOTNOTE_BLOCKING"
            } else {
              "VAULT_MARKDOWN_BLOCKING"
            },
            VaultPreservation::Blocking,
          ));
          documents.push(blocked_document_plan(record.id, document, source, &folder_ids));
          continue;
        }
      };
    prepared.yjs_binary = yjs::append_imported_attachments(&prepared.yjs_binary, &attachments)
      .map_err(|_| blocking("Obsidian attachment cannot be converted", &document.source_id))?;

    classifications.push(classification(
      &document.source_id,
      "VAULT_MARKDOWN_NATIVE",
      VaultPreservation::Native,
    ));
    let references = yjs::extract_document_references_from_yjs(&prepared.yjs_binary)
      .map_err(|_| blocking("Obsidian document references cannot be inspected", &document.source_id))?;
    if references.occurrences.iter().any(|reference| {
      reference.link_kind == yjs::DocumentReferenceLinkKind::InlineReference
        && reference.params_json["params"]["blockIds"].is_array()
    }) {
      classifications.push(classification(
        &document.source_id,
        "VAULT_REFERENCE_TARGET_NATIVE",
        VaultPreservation::Native,
      ));
    }
    for _ in references
      .occurrences
      .iter()
      .filter(|reference| reference.link_kind == yjs::DocumentReferenceLinkKind::EmbedSyncedDoc)
    {
      classifications.push(classification(
        &document.source_id,
        "VAULT_EMBED_NATIVE",
        VaultPreservation::Native,
      ));
    }
    classifications.extend(parsed.classifications.clone());
    if prepared.native_math_count > 0 {
      classifications.push(classification(
        &document.source_id,
        "VAULT_MATH_NATIVE",
        VaultPreservation::Native,
      ));
    }
    if prepared.native_footnote_count > 0 {
      classifications.push(classification(
        &document.source_id,
        "VAULT_FOOTNOTE_NATIVE",
        VaultPreservation::Native,
      ));
    }
    // An unused definition is complete native parent content, not a lost body
    // requiring another recovery copy of the source file.
    let has_codec_diagnostics = prepared
      .diagnostics
      .iter()
      .any(|diagnostic| diagnostic.code != yjs::MarkdownDiagnosticCode::UnreferencedFootnote);
    for diagnostic in &prepared.diagnostics {
      if diagnostic.code == yjs::MarkdownDiagnosticCode::UnreferencedFootnote {
        diagnostics.push(
          WorkspaceImportDiagnostic::informational(
            WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultContentNormalized,
            "Unreferenced footnote definition remains native parent content and exports once",
          )
          .with_source_path(&document.source_id),
        );
        classifications.push(classification(
          &document.source_id,
          "VAULT_FOOTNOTE_UNREFERENCED",
          VaultPreservation::Native,
        ));
        continue;
      }
      diagnostics.push(
        WorkspaceImportDiagnostic::informational(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultSourcePreserved,
          format!(
            "Markdown content requires recovery source preservation ({:?})",
            diagnostic.code
          ),
        )
        .with_source_path(&document.source_id),
      );
      classifications.push(classification(
        &document.source_id,
        match diagnostic.code {
          yjs::MarkdownDiagnosticCode::UnsupportedAnnotation => "VAULT_ANNOTATION_SOURCE_PRESERVED",
          yjs::MarkdownDiagnosticCode::UnsupportedCallout => "VAULT_CALLOUT_SOURCE_PRESERVED",
          yjs::MarkdownDiagnosticCode::UnsupportedMath => "VAULT_MATH_SOURCE_PRESERVED",
          _ => "VAULT_REFERENCE_SOURCE_PRESERVED",
        },
        VaultPreservation::SourcePreserved,
      ));
    }
    diagnostics.extend(parsed.diagnostics.clone());
    let folder_ids_for_document = parent_paths(&document.source_id)
      .into_iter()
      .filter_map(|path| folder_ids.get(&path).copied())
      .collect();
    let display_title = parsed.display_title(&document.title);
    let prepared_content_hash = prepared_source_hash(&display_title, &prepared_markdown, &attachments);
    documents.push(VaultDocumentPlan {
      source_path: document.source_id.clone(),
      target_document_id: target_id(record.id, "document", &document.source_id),
      display_title,
      organizer_folder_ids: folder_ids_for_document,
      aliases: parsed.aliases,
      properties: parsed.properties,
      tags: parsed.tags,
      prepared_content_hash,
      recovery_source_required: parsed.recovery_source_required || has_codec_diagnostics,
      recovery_source_asset_id: (parsed.recovery_source_required || has_codec_diagnostics)
        .then(|| target_id(record.id, "recovery-source", &document.source_id)),
      prepared_yjs: prepared.yjs_binary,
    });
  }

  let labels = documents
    .iter()
    .flat_map(|document| document.tags.iter().cloned())
    .collect::<BTreeSet<_>>()
    .into_iter()
    .map(|tag| DecodedWorkspaceTag {
      id: tag.clone(),
      name: tag,
      color_role: "grey".to_string(),
      description: None,
      archived: false,
      archived_at: None,
    })
    .collect();
  let assets = decoded
    .assets
    .iter()
    .map(|asset| {
      let recovery_source = !is_supported_asset(&asset.source_key);
      classifications.push(classification(
        &asset.source_key,
        if recovery_source {
          "VAULT_FILE_SOURCE_PRESERVED"
        } else {
          "VAULT_ASSET_NATIVE"
        },
        if recovery_source {
          VaultPreservation::SourcePreserved
        } else {
          VaultPreservation::Native
        },
      ));
      if recovery_source {
        diagnostics.push(
          WorkspaceImportDiagnostic::informational(
            WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultSourcePreserved,
            "Unsupported vault file will be retained as recovery source",
          )
          .with_source_path(&asset.source_key),
        );
      }
      VaultAssetPlan {
        source_path: asset.source_key.clone(),
        target_asset_id: target_id(record.id, "asset-content", &asset.content_hash),
        content_hash: asset.content_hash.clone(),
        recovery_source,
      }
    })
    .collect();
  classifications.sort_by(|left, right| (&left.source_path, &left.code).cmp(&(&right.source_path, &right.code)));
  diagnostics.sort_by(|left, right| {
    let left_path = left
      .context
      .as_ref()
      .and_then(|context| context.source_path.as_deref())
      .unwrap_or("");
    let right_path = right
      .context
      .as_ref()
      .and_then(|context| context.source_path.as_deref())
      .unwrap_or("");
    (left_path, left.code.as_str()).cmp(&(right_path, right.code.as_str()))
  });
  Ok(ObsidianVaultPlan {
    documents,
    assets,
    folders,
    labels,
    classifications,
    diagnostics,
  })
}

pub(super) fn plan_fingerprint(
  source_hash: &str,
  selected_format: &str,
  policy_fingerprint: &str,
  target_plan: &WorkspaceImportTargetPlan,
) -> String {
  let plan = serde_json::to_vec(target_plan).unwrap_or_default();
  let mut hasher = Sha256::new();
  hasher.update(source_hash.as_bytes());
  hasher.update([0]);
  hasher.update(selected_format.as_bytes());
  hasher.update([0]);
  hasher.update(policy_fingerprint.as_bytes());
  hasher.update([0]);
  hasher.update(plan);
  format!("{:x}", hasher.finalize())
}

#[derive(Debug)]
struct ParsedNote {
  visible_markdown: String,
  title: Option<String>,
  aliases: Vec<String>,
  tags: Vec<String>,
  properties: JsonValue,
  classifications: Vec<VaultClassification>,
  diagnostics: Vec<WorkspaceImportDiagnostic>,
  recovery_source_required: bool,
}

struct PreparedVaultNote {
  parsed: ParsedNote,
  markdown: String,
  attachments: Vec<yjs::ImportedAttachment>,
  native_asset_embed: bool,
  unsupported_asset_embed: bool,
}

impl ParsedNote {
  fn display_title(&self, filename_title: &str) -> String {
    self.title.clone().unwrap_or_else(|| filename_title.to_string())
  }
}

fn parse_note(source: &str, source_path: &str) -> Result<ParsedNote, WorkspaceImportDiagnostic> {
  let (yaml, body) = split_frontmatter(source).map_err(|message| blocking(message, source_path))?;
  let mut properties = JsonValue::Object(JsonMap::new());
  let mut title = None;
  let mut aliases = Vec::new();
  let mut tags = Vec::new();
  let mut classifications = Vec::new();
  let mut diagnostics = Vec::new();
  let mut recovery_source_required = false;
  if let Some(yaml) = yaml {
    // Frontmatter keeps YAML values until projection so document scalar types,
    // aliases and unknown properties retain their existing import semantics.
    let value = yaml_serde::from_str::<yaml_serde::Value>(yaml).map_err(|_| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultYamlInvalid,
        "Obsidian YAML frontmatter is malformed or ambiguous",
      )
      .with_source_path(source_path)
    })?;
    let mapping = value.as_mapping().ok_or_else(|| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultYamlInvalid,
        "Obsidian YAML frontmatter must be a property mapping",
      )
      .with_source_path(source_path)
    })?;
    properties =
      serde_json::to_value(&value).map_err(|_| blocking("Obsidian YAML values cannot be retained", source_path))?;
    title = scalar_string(mapping.get(yaml_serde::Value::String("title".into())));
    aliases = string_list(
      mapping.get(yaml_serde::Value::String("aliases".into())),
      "aliases",
      source_path,
    )?;
    tags = string_list(
      mapping.get(yaml_serde::Value::String("tags".into())),
      "tags",
      source_path,
    )?
    .into_iter()
    .map(|tag| tag.trim().trim_start_matches('#').to_string())
    .collect::<BTreeSet<_>>()
    .into_iter()
    .collect();
    if tags.iter().any(String::is_empty) {
      return Err(invalid_property("tags", source_path));
    }
    classifications.push(classification(
      source_path,
      "VAULT_PROPERTIES_NORMALIZED",
      VaultPreservation::Normalized,
    ));
    diagnostics.push(
      WorkspaceImportDiagnostic::informational(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultContentNormalized,
        "YAML properties are retained separately from document identity and lifecycle",
      )
      .with_source_path(source_path),
    );
  }
  let visible_markdown = body.to_string();
  let visible_syntax = outside_markdown_code(&visible_markdown);
  if !yjs::markdown::markdown_annotation_ranges(body).is_empty() {
    classifications.push(classification(
      source_path,
      "VAULT_ANNOTATION_NATIVE",
      VaultPreservation::Native,
    ));
  }
  // The codec owns code/comment boundaries and nested block semantics. Feeding
  // it a separately masked source can make Preview disagree with Apply.
  let (native_callouts, unsupported_callouts) = yjs::markdown::markdown_callout_support(body);
  if native_callouts > 0 {
    classifications.push(classification(
      source_path,
      "VAULT_CALLOUT_NATIVE",
      VaultPreservation::Native,
    ));
  }
  if unsupported_callouts > 0 {
    recovery_source_required = true;
    classifications.push(classification(
      source_path,
      "VAULT_CALLOUT_SOURCE_PRESERVED",
      VaultPreservation::SourcePreserved,
    ));
  }
  if visible_syntax.contains("==") {
    classifications.push(classification(
      source_path,
      "VAULT_HIGHLIGHT_NATIVE",
      VaultPreservation::Native,
    ));
  }
  if visible_markdown.contains("```mermaid") {
    classifications.push(classification(
      source_path,
      "VAULT_MERMAID_NATIVE",
      VaultPreservation::Native,
    ));
  }
  Ok(ParsedNote {
    visible_markdown,
    title,
    aliases,
    tags,
    properties,
    classifications,
    diagnostics,
    recovery_source_required,
  })
}

fn split_frontmatter(source: &str) -> Result<(Option<&str>, &str), &'static str> {
  let Some(rest) = source.strip_prefix("---\n").or_else(|| source.strip_prefix("---\r\n")) else {
    return Ok((None, source));
  };
  let mut offset = 0;
  for line in rest.split_inclusive('\n') {
    let delimiter = line.trim_end_matches(['\r', '\n']);
    if delimiter == "---" || delimiter == "..." {
      let yaml = &rest[..offset];
      let body = &rest[offset + line.len()..];
      return Ok((Some(yaml), body));
    }
    offset += line.len();
  }
  Err("Obsidian YAML frontmatter has no closing delimiter")
}

fn outside_markdown_code(source: &str) -> String {
  let mut output = String::with_capacity(source.len());
  let mut cursor = 0;
  for protected in markdown_literal_ranges(source) {
    output.push_str(&source[cursor..protected.start]);
    for newline in source[protected.clone()].bytes().filter(|byte| *byte == b'\n') {
      output.push(char::from(newline));
    }
    cursor = protected.end;
  }
  output.push_str(&source[cursor..]);
  output
}

/// Returns complete source ranges where Markdown syntax must stay literal.
/// Preview classification and Apply transformations share these ranges so
/// code-boundary behavior cannot drift between the two lifecycle stages.
fn markdown_literal_ranges(source: &str) -> Vec<std::ops::Range<usize>> {
  let mut ranges = yjs::markdown::markdown_annotation_ranges(source);
  let mut block_start = None;
  for (event, range) in Parser::new(source).into_offset_iter() {
    match event {
      Event::Start(Tag::CodeBlock(_)) => block_start = Some(range.start),
      Event::End(TagEnd::CodeBlock) => {
        if let Some(start) = block_start.take() {
          ranges.push(start..range.end);
        }
      }
      Event::Code(_) if block_start.is_none() => ranges.push(range),
      _ => {}
    }
  }
  if let Some(start) = block_start {
    ranges.push(start..source.len());
  }
  // Native annotations can enclose other parser events; use one sorted,
  // disjoint boundary set for every vault preparation owner.
  ranges.sort_by_key(|range| range.start);
  let mut merged: Vec<std::ops::Range<usize>> = Vec::new();
  for range in ranges {
    if let Some(previous) = merged.last_mut()
      && range.start <= previous.end
    {
      previous.end = previous.end.max(range.end);
    } else {
      merged.push(range);
    }
  }
  merged
}

/// Normalize supported Obsidian attachment embeds at the Markdown codec
/// boundary. Document embeds pass through to the shared codec and authorized
/// batch resolver; only attachment syntax is interpreted here.
fn prepare_vault_embeds(
  markdown: &str,
  source_path: &str,
  assets: &BTreeMap<String, u64>,
) -> Result<(String, Vec<yjs::ImportedAttachment>, bool, bool), crate::markdown::ConversionError> {
  let mut output = String::with_capacity(markdown.len());
  let mut attachments = Vec::new();
  let mut native = false;
  let mut unsupported = false;
  let mut cursor = 0;
  for protected in markdown_literal_ranges(markdown) {
    prepare_vault_embeds_in_plain_text(
      &markdown[cursor..protected.start],
      source_path,
      assets,
      &mut output,
      &mut attachments,
      &mut native,
      &mut unsupported,
    );
    output.push_str(&markdown[protected.clone()]);
    cursor = protected.end;
  }
  prepare_vault_embeds_in_plain_text(
    &markdown[cursor..],
    source_path,
    assets,
    &mut output,
    &mut attachments,
    &mut native,
    &mut unsupported,
  );
  let mut replacements = HashMap::new();
  for source in markdown_image_sources(&output) {
    if is_external_markdown_image(&source) {
      continue;
    }
    if let Some((asset, _)) = resolve_vault_asset(source_path, &source, assets) {
      replacements.insert(source, encode_vault_path(asset));
      native = true;
    } else {
      unsupported = true;
    }
  }
  let output = rewrite_markdown_image_sources(&output, &replacements)?;
  Ok((output, attachments, native, unsupported))
}

fn prepare_vault_embeds_in_plain_text(
  markdown: &str,
  source_path: &str,
  assets: &BTreeMap<String, u64>,
  output: &mut String,
  attachments: &mut Vec<yjs::ImportedAttachment>,
  native: &mut bool,
  unsupported: &mut bool,
) {
  for line in markdown.split_inclusive('\n') {
    let mut rest = line;
    while let Some(start) = rest.find("![[") {
      output.push_str(&rest[..start]);
      let after = &rest[start + 3..];
      let Some(end) = after.find("]]") else {
        *unsupported = true;
        output.push_str(&rest[start..]);
        rest = "";
        break;
      };
      let expression = &after[..end];
      let target = expression.split(['|', '#']).next().unwrap_or_default().trim();
      let has_options = expression.len() != target.len();
      // A period in a note title is not evidence of an attachment. Known
      // archive assets and admitted media types belong to this owner; every
      // other target is resolved against the authorized note inventory.
      let asset_target = resolve_vault_asset(source_path, target, assets);
      let is_asset = asset_target.is_some() || is_image_asset(target) || is_supported_asset(target);
      if is_asset && !has_options {
        if let Some((asset, size)) = resolve_vault_asset(source_path, target, assets) {
          let name = asset.rsplit('/').next().unwrap_or(asset);
          if is_image_asset(asset) {
            let encoded = encode_vault_path(asset);
            // The shared Markdown codec intentionally retains mixed inline
            // images as portable text. Vault import requires the native image
            // block, so isolate the embed as a block without moving it past
            // the surrounding source content.
            output.push_str(&format!("\n\n![{name}]({encoded})\n\n"));
            *native = true;
          } else if is_supported_asset(asset) {
            attachments.push(yjs::ImportedAttachment {
              source_id: asset.to_string(),
              name: name.to_string(),
              mime: mime_guess::from_path(asset).first_or_octet_stream().to_string(),
              size: i64::try_from(*size).unwrap_or(i64::MAX),
            });
            *native = true;
          } else {
            *unsupported = true;
          }
        } else {
          *unsupported = true;
        }
      } else if !is_asset {
        output.push_str(&rest[start..start + 3 + end + 2]);
      } else {
        *unsupported = true;
      }
      rest = &after[end + 2..];
    }
    output.push_str(rest);
  }
}

fn is_external_markdown_image(source: &str) -> bool {
  let lower = source.to_ascii_lowercase();
  source.starts_with("//")
    || lower.starts_with("http://")
    || lower.starts_with("https://")
    || lower.starts_with("data:")
    || lower.starts_with("blob:")
}

fn encode_vault_path(path: &str) -> String {
  path
    .split('/')
    .map(|part| urlencoding::encode(part).into_owned())
    .collect::<Vec<_>>()
    .join("/")
}

fn resolve_vault_asset<'a>(
  source_path: &str,
  target: &str,
  assets: &'a BTreeMap<String, u64>,
) -> Option<(&'a str, &'a u64)> {
  let target = urlencoding::decode(target).ok()?.replace('\\', "/");
  if target.contains('\0') {
    return None;
  }
  let root_relative = target.trim_start_matches('/');
  if target.starts_with('/') {
    return normalize_vault_path(root_relative)
      .and_then(|path| assets.get_key_value(&path))
      .map(|(path, size)| (path.as_str(), size));
  }
  let parent = source_path.rsplit_once('/').map_or("", |(parent, _)| parent);
  let relative = if parent.is_empty() {
    root_relative.to_string()
  } else {
    format!("{parent}/{root_relative}")
  };
  if let Some((asset, size)) = normalize_vault_path(&relative).and_then(|path| assets.get_key_value(&path)) {
    return Some((asset.as_str(), size));
  }
  if let Some((asset, size)) = normalize_vault_path(root_relative).and_then(|path| assets.get_key_value(&path)) {
    return Some((asset.as_str(), size));
  }
  if root_relative.contains('/') {
    return None;
  }
  let mut matches = assets
    .iter()
    .filter(|(asset, _)| asset.rsplit('/').next() == Some(root_relative));
  let found = matches.next()?;
  matches.next().is_none().then(|| (found.0.as_str(), found.1))
}

fn normalize_vault_path(path: &str) -> Option<String> {
  let mut components = Vec::new();
  for component in path.split('/') {
    match component {
      "" | "." => {}
      ".." => {
        components.pop()?;
      }
      component => components.push(component),
    }
  }
  (!components.is_empty()).then(|| components.join("/"))
}

fn scalar_string(value: Option<&yaml_serde::Value>) -> Option<String> {
  value.and_then(yaml_serde::Value::as_str).map(str::to_string)
}

fn string_list(
  value: Option<&yaml_serde::Value>,
  property: &str,
  source_path: &str,
) -> Result<Vec<String>, WorkspaceImportDiagnostic> {
  let Some(value) = value else { return Ok(Vec::new()) };
  let values = if let Some(value) = value.as_str() {
    vec![value.to_string()]
  } else if let Some(sequence) = value.as_sequence() {
    sequence
      .iter()
      .map(|value| value.as_str().map(str::to_string))
      .collect::<Option<Vec<_>>>()
      .ok_or_else(|| invalid_property(property, source_path))?
  } else {
    return Err(invalid_property(property, source_path));
  };
  if values.len() > 256 || values.iter().any(|value| value.len() > 1024) {
    return Err(invalid_property(property, source_path));
  }
  Ok(values)
}

fn invalid_property(property: &str, source_path: &str) -> WorkspaceImportDiagnostic {
  WorkspaceImportDiagnostic::blocking(
    WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultYamlInvalid,
    format!("Obsidian YAML {property} must contain bounded strings"),
  )
  .with_source_path(source_path)
}

fn collect_folder_paths(decoded: &DecodedWorkspace) -> BTreeSet<String> {
  let mut folders = BTreeSet::new();
  for path in decoded
    .directories
    .iter()
    .chain(decoded.documents.iter().map(|document| &document.source_id))
    .chain(decoded.assets.iter().map(|asset| &asset.source_key))
  {
    for parent in parent_paths(path) {
      folders.insert(parent);
    }
    if decoded.directories.contains(path) {
      folders.insert(path.trim_end_matches('/').to_string());
    }
  }
  folders
}

fn blocked_document_plan(
  import_id: Uuid,
  document: &myoxus_workspace_import::DecodedDocument,
  source: &str,
  folder_ids: &BTreeMap<String, Uuid>,
) -> VaultDocumentPlan {
  VaultDocumentPlan {
    source_path: document.source_id.clone(),
    target_document_id: target_id(import_id, "document", &document.source_id),
    display_title: document.title.clone(),
    organizer_folder_ids: parent_paths(&document.source_id)
      .into_iter()
      .filter_map(|path| folder_ids.get(&path).copied())
      .collect(),
    aliases: Vec::new(),
    properties: JsonValue::Object(JsonMap::new()),
    tags: Vec::new(),
    prepared_content_hash: format!("{:x}", Sha256::digest(source.as_bytes())),
    recovery_source_required: true,
    recovery_source_asset_id: Some(target_id(import_id, "recovery-source", &document.source_id)),
    prepared_yjs: Vec::new(),
  }
}

fn prepared_source_hash(title: &str, markdown: &str, attachments: &[yjs::ImportedAttachment]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(title.as_bytes());
  hasher.update([0]);
  hasher.update(markdown.as_bytes());
  for attachment in attachments {
    hasher.update([0]);
    hasher.update(attachment.source_id.as_bytes());
    hasher.update([0]);
    hasher.update(attachment.mime.as_bytes());
    hasher.update(attachment.size.to_le_bytes());
  }
  format!("{:x}", hasher.finalize())
}

fn parent_paths(path: &str) -> Vec<String> {
  let mut result = Vec::new();
  let mut current = String::new();
  let parts = path.trim_end_matches('/').split('/').collect::<Vec<_>>();
  for part in parts.iter().take(parts.len().saturating_sub(1)) {
    if !current.is_empty() {
      current.push('/');
    }
    current.push_str(part);
    result.push(current.clone());
  }
  result
}

fn is_supported_asset(path: &str) -> bool {
  matches!(
    path
      .rsplit('.')
      .next()
      .unwrap_or_default()
      .to_ascii_lowercase()
      .as_str(),
    "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "pdf" | "mp3" | "mp4" | "webm" | "wav" | "ogg"
  )
}

fn is_image_asset(path: &str) -> bool {
  matches!(
    path
      .rsplit('.')
      .next()
      .unwrap_or_default()
      .to_ascii_lowercase()
      .as_str(),
    "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
  )
}

fn classification(source_path: &str, code: &str, preservation: VaultPreservation) -> VaultClassification {
  VaultClassification {
    source_path: source_path.to_string(),
    code: code.to_string(),
    preservation,
  }
}

/// Expose only the codec's label-only admission failures. Other conversion
/// errors can include source payloads and keep the existing generic diagnostic.
fn footnote_conversion_message(error: &crate::markdown::ConversionError) -> Option<String> {
  let crate::markdown::ConversionError::Conversion(message) = error else {
    return None;
  };
  [
    "Missing footnote definition",
    "Conflicting footnote definition",
    "Nested footnote definition",
    "Nested footnote reference",
    "Invalid citation definition",
    "Invalid citation URL encoding",
    "Missing citation target",
  ]
  .iter()
  .find_map(|kind| {
    let label = message.strip_prefix(&format!("{kind}: "))?;
    let label = label
      .chars()
      .filter(|character| !character.is_control())
      .take(80)
      .collect::<String>();
    Some(format!("{kind}: {label}"))
  })
}

fn blocking(message: impl Into<String>, source_path: &str) -> WorkspaceImportDiagnostic {
  let diagnostic = WorkspaceImportDiagnostic::blocking(
    WorkspaceImportDiagnosticCode::MixWorkspaceImportVaultYamlInvalid,
    message,
  );
  if source_path.is_empty() {
    diagnostic
  } else {
    diagnostic.with_source_path(source_path)
  }
}

fn target_id(namespace: Uuid, kind: &str, source_id: &str) -> Uuid {
  Uuid::new_v5(&namespace, format!("{kind}:{source_id}").as_bytes())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn frontmatter_is_anchored_and_preserves_unknown_values() {
    let parsed = parse_note(
      "---\ntitle: Display\naliases: [One, Two]\ncustom:\n  nested: true\n---\nBody\n",
      "A.md",
    )
    .unwrap();
    assert_eq!(parsed.title.as_deref(), Some("Display"));
    assert_eq!(parsed.aliases, ["One", "Two"]);
    assert_eq!(parsed.properties["custom"]["nested"], true);
    assert_eq!(parsed.visible_markdown, "Body\n");
    assert!(
      parse_note("Before\n---\ntitle: Not frontmatter\n", "A.md")
        .unwrap()
        .title
        .is_none()
    );
  }

  #[test]
  fn annotations_are_native_and_literal_bodies_do_not_enter_vault_preparation() {
    let parsed = parse_note(
      "Visible %%secret%% text and `%%inline%%`\n~~~md\n%%tilde%%\n~~~\n````text\n%%long fence%%\n````\n",
      "A.md",
    )
    .unwrap();
    assert_eq!(
      parsed.visible_markdown,
      "Visible %%secret%% text and `%%inline%%`\n~~~md\n%%tilde%%\n~~~\n````text\n%%long fence%%\n````\n"
    );
    assert!(!parsed.recovery_source_required);
    assert!(
      parsed
        .classifications
        .iter()
        .any(|item| item.code == "VAULT_ANNOTATION_NATIVE")
    );
    let literal = "Before %%![[missing.png]] ![image](missing.png) > [!note] $math$ [[Missing]]%% after";
    let parsed = parse_note(literal, "A.md").unwrap();
    assert!(!parsed.recovery_source_required);
    let (prepared, attachments, native, unsupported) = prepare_vault_embeds(literal, "A.md", &BTreeMap::new()).unwrap();
    assert_eq!(prepared, literal);
    assert!(attachments.is_empty());
    assert!(!native && !unsupported);
  }

  #[test]
  fn code_literals_are_not_classified_or_rewritten_as_vault_embeds() {
    let markdown = "Inline `![[image.png]]`\n~~~markdown\n![[image.png]]\n~~~\n";
    let parsed = parse_note(markdown, "Projects/Source.md").unwrap();
    assert!(!parsed.recovery_source_required);

    let (prepared, attachments, native, unsupported) =
      prepare_vault_embeds(markdown, "Projects/Source.md", &BTreeMap::new()).unwrap();
    assert_eq!(prepared, markdown);
    assert!(attachments.is_empty());
    assert!(!native);
    assert!(!unsupported);
  }

  #[test]
  fn relative_markdown_images_resolve_from_the_note_path() {
    let assets = [("media/image one.png".to_string(), 42)].into_iter().collect();
    let (markdown, attachments, native, unsupported) = prepare_vault_embeds(
      "![relative](../media/image%20one.png \"Caption\")\n",
      "Projects/Source.md",
      &assets,
    )
    .unwrap();

    assert!(attachments.is_empty());
    assert!(native);
    assert!(!unsupported);
    assert_eq!(markdown, "![relative](media/image%20one.png \"Caption\")\n");
    let yjs = crate::markdown::markdown_to_yjs("Source", &markdown).expect("convert prepared vault Markdown");
    let image_references = yjs::extract_portable_asset_references(&yjs).expect("extract native image reference");
    assert_eq!(image_references.len(), 1);
    assert_eq!(image_references[0].source_key, "media/image%20one.png");
  }
}
