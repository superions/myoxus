// SPDX-License-Identifier: AGPL-3.0-or-later

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::{
  DecodedAsset, DecodedDocument, DecodedDocumentContent, DecodedOmittedObjectCounts, DecodedWorkspace,
  WorkspaceImportDiagnostic, WorkspaceImportDiagnosticCode, WorkspaceImportFormat, WorkspaceImportLimits,
};

fn excluded_path(name: &str) -> bool {
  let mut segments = name.trim_end_matches('/').split('/');
  segments.any(|segment| {
    segment == ".obsidian"
      || segment == ".trash"
      || segment == ".Trash"
      || segment == ".Trashes"
      || segment == "__MACOSX"
      || segment == ".DS_Store"
      || segment.starts_with("._")
  })
}

fn title_from_path(path: &str) -> String {
  path
    .rsplit('/')
    .next()
    .unwrap_or(path)
    .strip_suffix(".md")
    .unwrap_or(path)
    .to_string()
}

pub(crate) fn decode_vault(
  path: &Path,
  limits: WorkspaceImportLimits,
) -> Result<DecodedWorkspace, WorkspaceImportDiagnostic> {
  let file = File::open(path).map_err(|_| invalid("Obsidian ZIP source cannot be opened"))?;
  let mut archive = zip::ZipArchive::new(file).map_err(|_| invalid("Obsidian source is not a valid ZIP archive"))?;
  let index =
    crate::archive::inspect_zip_archive(&mut archive, limits.archive()).map_err(|error| error.diagnostic())?;

  let mut documents = Vec::new();
  let mut assets = Vec::new();
  let mut directories = Vec::new();
  let mut excluded_entries = 0;
  for entry in &index.entries {
    if entry.ignored || excluded_path(&entry.name) {
      excluded_entries += 1;
      continue;
    }
    if entry.directory {
      directories.push(entry.name.clone());
      continue;
    }
    let mut source = archive
      .by_name(&entry.archive_name)
      .map_err(|_| invalid("Obsidian ZIP entry cannot be opened"))?;
    if entry.name.to_ascii_lowercase().ends_with(".md") {
      let mut bytes = Vec::with_capacity(entry.size_bytes as usize);
      source
        .read_to_end(&mut bytes)
        .map_err(|_| invalid("Obsidian note cannot be read"))?;
      std::str::from_utf8(&bytes).map_err(|_| {
        WorkspaceImportDiagnostic::blocking(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
          "Obsidian note text is not valid UTF-8",
        )
      })?;
      documents.push(DecodedDocument {
        source_id: entry.name.clone(),
        title: title_from_path(&entry.name),
        mode: "page".to_string(),
        parent_source_id: None,
        order: entry.name.clone(),
        created_at_ms: None,
        is_trashed: false,
        tags: Vec::new(),
        content: DecodedDocumentContent::MarkdownUtf8(bytes),
      });
    } else {
      let mut hasher = Sha256::new();
      std::io::copy(&mut source, &mut hasher).map_err(|_| invalid("Obsidian attachment cannot be read"))?;
      assets.push(DecodedAsset {
        source_key: entry.name.clone(),
        size_bytes: entry.size_bytes,
        content_hash: format!("{:x}", hasher.finalize()),
      });
    }
  }
  if documents.is_empty() {
    return Err(WorkspaceImportDiagnostic::blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported,
      "Obsidian ZIP must contain at least one Markdown note",
    ));
  }
  Ok(DecodedWorkspace {
    format: WorkspaceImportFormat::ObsidianZip,
    title: "Obsidian vault".to_string(),
    workspace_tags: Vec::new(),
    documents,
    assets,
    directories,
    omitted_counts: DecodedOmittedObjectCounts {
      excluded_entries,
      ..DecodedOmittedObjectCounts::default()
    },
    diagnostics: Vec::new(),
  })
}

pub(crate) fn copy_asset_to<W: Write>(
  path: &Path,
  source_key: &str,
  writer: &mut W,
  limits: WorkspaceImportLimits,
) -> Result<u64, WorkspaceImportDiagnostic> {
  let file = File::open(path).map_err(|_| invalid("Obsidian ZIP source cannot be opened"))?;
  let mut archive = zip::ZipArchive::new(file).map_err(|_| invalid("Obsidian source is not a valid ZIP archive"))?;
  let index =
    crate::archive::inspect_zip_archive(&mut archive, limits.archive()).map_err(|error| error.diagnostic())?;
  let entry = index
    .entries
    .iter()
    .find(|entry| entry.name == source_key && !entry.directory && !entry.ignored && !excluded_path(&entry.name))
    .ok_or_else(|| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportAssetMissing,
        "Obsidian attachment is missing from the validated archive",
      )
    })?;
  let mut source = archive
    .by_name(&entry.archive_name)
    .map_err(|_| invalid("Obsidian attachment cannot be opened"))?;
  std::io::copy(&mut source, writer).map_err(|_| invalid("Obsidian attachment cannot be read"))
}

fn invalid(message: &'static str) -> WorkspaceImportDiagnostic {
  WorkspaceImportDiagnostic::blocking(WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid, message)
}
