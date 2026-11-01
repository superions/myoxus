// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use crate::{
  DecodedWorkspace, PortableArchiveKind, WorkspaceImportDiagnostic, WorkspaceImportDiagnosticCode,
  WorkspaceImportFormat, WorkspaceImportLimits, detect_portable_archive_kind,
};

const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
const ZIP_MAGIC: &[u8; 4] = b"PK\x03\x04";

pub fn detect_workspace_format(path: &Path) -> Result<WorkspaceImportFormat, WorkspaceImportDiagnostic> {
  detect_workspace_format_with_limits(path, WorkspaceImportLimits::default())
}

fn detect_workspace_format_with_limits(
  path: &Path,
  limits: WorkspaceImportLimits,
) -> Result<WorkspaceImportFormat, WorkspaceImportDiagnostic> {
  let mut file = File::open(path).map_err(|_| {
    WorkspaceImportDiagnostic::blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported,
      "workspace import source cannot be opened",
    )
  })?;
  let mut header = [0_u8; 16];
  let read = file.read(&mut header).map_err(|_| {
    WorkspaceImportDiagnostic::blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported,
      "workspace import source cannot be inspected",
    )
  })?;
  if read >= SQLITE_MAGIC.len() && &header == SQLITE_MAGIC {
    return crate::sqlite::detect_sqlite_layout(path);
  }
  if read >= ZIP_MAGIC.len() && &header[..ZIP_MAGIC.len()] == ZIP_MAGIC {
    let file = File::open(path).map_err(|_| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid,
        "workspace import archive cannot be opened",
      )
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid,
        "workspace import source is not a valid ZIP archive",
      )
    })?;
    let index =
      crate::archive::inspect_zip_archive(&mut archive, limits.archive()).map_err(|error| error.diagnostic())?;
    return match detect_portable_archive_kind(&index.entry_names()) {
      PortableArchiveKind::Snapshot => Ok(WorkspaceImportFormat::SnapshotZip),
      PortableArchiveKind::SnapshotIncomplete => Err(WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSnapshotInvalid,
        "workspace snapshot archive is missing document snapshots",
      )),
      PortableArchiveKind::RawWorkspace | PortableArchiveKind::Unknown => Err(WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported,
        "ZIP archive is not a supported workspace snapshot",
      )),
    };
  }
  Err(WorkspaceImportDiagnostic::blocking(
    WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported,
    "workspace import format is not supported",
  ))
}

/// Stateless decoder for one protected staged file. Format classification is
/// content-based; filename extensions are never consulted.
#[derive(Debug, Clone)]
pub struct WorkspaceDecoder {
  limits: WorkspaceImportLimits,
}

impl WorkspaceDecoder {
  pub const fn new(limits: WorkspaceImportLimits) -> Self {
    Self { limits }
  }

  /// Decode a bounded snapshot ZIP already loaded by a trusted blob owner.
  /// This shares file-import normalization and never materializes product data.
  pub fn decode_snapshot_bytes(&self, bytes: &[u8]) -> Result<DecodedWorkspace, WorkspaceImportDiagnostic> {
    if bytes.len() as u64 > self.limits.max_upload_bytes {
      return Err(WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportUploadLimit,
        "workspace snapshot exceeds the configured upload limit",
      ));
    }
    let archive = crate::validate_snapshot_archive(bytes, self.limits.archive()).map_err(|error| error.diagnostic())?;
    let decoded = crate::snapshot::decode_archive(archive, self.limits)?;
    validate_document_index(&decoded)?;
    Ok(decoded)
  }

  pub fn decode_path(&self, path: impl AsRef<Path>) -> Result<DecodedWorkspace, WorkspaceImportDiagnostic> {
    self.decode_path_as(path, None)
  }

  /// Decode with an explicit source kind when content alone cannot distinguish
  /// two ZIP-based formats. Existing automatic detection remains unchanged.
  pub fn decode_path_as(
    &self,
    path: impl AsRef<Path>,
    selected_format: Option<WorkspaceImportFormat>,
  ) -> Result<DecodedWorkspace, WorkspaceImportDiagnostic> {
    let path = path.as_ref();
    let metadata = path.metadata().map_err(|_| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported,
        "workspace import source cannot be inspected",
      )
    })?;
    if metadata.len() > self.limits.max_upload_bytes {
      return Err(WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportUploadLimit,
        "workspace import source exceeds the configured upload limit",
      ));
    }
    let format = match selected_format {
      Some(WorkspaceImportFormat::ObsidianZip) => {
        let mut header = [0_u8; 4];
        File::open(path)
          .and_then(|mut file| file.read_exact(&mut header))
          .map_err(|_| {
            WorkspaceImportDiagnostic::blocking(
              WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid,
              "Obsidian source cannot be inspected as a ZIP archive",
            )
          })?;
        if &header != ZIP_MAGIC {
          return Err(WorkspaceImportDiagnostic::blocking(
            WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported,
            "selected Obsidian source is not a ZIP archive",
          ));
        }
        WorkspaceImportFormat::ObsidianZip
      }
      Some(_) => {
        return Err(WorkspaceImportDiagnostic::blocking(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported,
          "explicit source selection is not supported for this workspace format",
        ));
      }
      None => detect_workspace_format_with_limits(path, self.limits)?,
    };
    let decoded = match format {
      WorkspaceImportFormat::SqliteV1 | WorkspaceImportFormat::SqliteDocStorage => {
        if metadata.len() > self.limits.max_sqlite_bytes {
          return Err(WorkspaceImportDiagnostic::blocking(
            WorkspaceImportDiagnosticCode::MixWorkspaceImportUploadLimit,
            "workspace SQLite source exceeds the configured byte limit",
          ));
        }
        crate::sqlite::decode_sqlite(path, self.limits)
      }
      WorkspaceImportFormat::SnapshotZip => crate::snapshot::decode_snapshot(path, self.limits),
      WorkspaceImportFormat::ObsidianZip => crate::obsidian::decode_vault(path, self.limits),
    }?;
    validate_document_index(&decoded)?;
    Ok(decoded)
  }

  /// Stream one previously validated asset from the immutable source into an
  /// application-owned sink. The complete asset is never retained by the
  /// decoder or worker in one allocation.
  pub fn copy_asset_to<W: Write>(
    &self,
    path: impl AsRef<Path>,
    source_key: &str,
    writer: &mut W,
  ) -> Result<u64, WorkspaceImportDiagnostic> {
    let path = path.as_ref();
    match detect_workspace_format_with_limits(path, self.limits)? {
      WorkspaceImportFormat::SqliteV1 | WorkspaceImportFormat::SqliteDocStorage => {
        crate::sqlite::copy_asset_to(path, source_key, writer)
      }
      WorkspaceImportFormat::SnapshotZip => crate::snapshot::copy_asset_to(path, source_key, writer, self.limits),
      WorkspaceImportFormat::ObsidianZip => unreachable!("automatic detection never selects Obsidian ZIP"),
    }
  }

  pub fn copy_asset_to_as<W: Write>(
    &self,
    path: impl AsRef<Path>,
    source_key: &str,
    selected_format: Option<WorkspaceImportFormat>,
    writer: &mut W,
  ) -> Result<u64, WorkspaceImportDiagnostic> {
    if selected_format == Some(WorkspaceImportFormat::ObsidianZip) {
      return crate::obsidian::copy_asset_to(path.as_ref(), source_key, writer, self.limits);
    }
    self.copy_asset_to(path, source_key, writer)
  }
}

fn validate_document_index(decoded: &DecodedWorkspace) -> Result<(), WorkspaceImportDiagnostic> {
  let ids = decoded
    .documents
    .iter()
    .map(|document| document.source_id.as_str())
    .collect::<HashSet<_>>();
  if ids.len() != decoded.documents.len() {
    return Err(WorkspaceImportDiagnostic::blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
      "workspace import contains duplicate document identities",
    ));
  }
  let parents = decoded
    .documents
    .iter()
    .map(|document| (document.source_id.as_str(), document.parent_source_id.as_deref()))
    .collect::<HashMap<_, _>>();
  for document in &decoded.documents {
    if !matches!(document.mode.as_str(), "page" | "edgeless") {
      return Err(WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace import document uses an unsupported mode",
      ));
    }
    if let Some(parent_id) = document.parent_source_id.as_deref()
      && !ids.contains(parent_id)
    {
      return Err(WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace import document hierarchy references a missing parent",
      ));
    }
    let mut seen = HashSet::new();
    let mut current = Some(document.source_id.as_str());
    while let Some(source_id) = current {
      if !seen.insert(source_id) {
        return Err(WorkspaceImportDiagnostic::blocking(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
          "workspace import document hierarchy contains a cycle",
        ));
      }
      current = parents.get(source_id).copied().flatten();
    }
  }
  Ok(())
}
