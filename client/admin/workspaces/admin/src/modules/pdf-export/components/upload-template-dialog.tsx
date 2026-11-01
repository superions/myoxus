/**
 * @file PDF export module — Upload dialog.
 *
 * Lets an admin upload a fresh PDF template bundle. The user picks a
 * directory tree (or a flat selection) of files; the dialog parses the
 * bundle's `manifest.json` client-side, validates that every declared
 * asset is present, and then ships the rest of the upload to the server
 * via the `uploadPdfTemplate` mutation.
 *
 * Server-side validation (`pdf_template_admin.rs::upload_pdf_template`)
 * still runs the canonical checks (manifest schema, locale validation,
 * Typst compile probe). The client-side checks here exist purely to
 * give immediate feedback before the upload round-trip.
 */
import { useI18n } from "@myoxus/i18n";
import { UploadIcon } from "@myoxus/icons/react";
import {
  Button,
  Checkbox,
  DialogFooterActions,
  Divider,
  Modal,
  MonoText,
  notify,
  SettingsNotice,
  Stack,
  UploadTarget,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

import {
  useReplacePdfTemplateBundleMutation,
  useUploadPdfTemplateMutation,
} from "../api";

// ---------------------------------------------------------------------------
// Manifest parsing helpers
// ---------------------------------------------------------------------------

interface ManifestShape {
  id: string;
  name: string;
  version: string;
  schemaVersion: string;
  assets: string[];
  entry: string;
  provenance: {
    licenseSpdx: string;
    copyrightNotice: string;
    sourceUrl: string;
    sourceRevision: string;
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseManifest(raw: unknown): ManifestShape | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "manifest.json must be a JSON object";
  }
  const obj = raw as Record<string, unknown>;
  const id = asString(obj["id"]);
  const name = asString(obj["name"]);
  const version = asString(obj["version"]);
  const schemaVersion = asString(obj["schema_version"]);
  const entry = asString(obj["entry"]);
  const rawProvenance = obj["provenance"];
  const rawAssets = obj["assets"];
  if (!id) return "manifest.id is required";
  if (!name) return "manifest.name is required";
  if (!version) return "manifest.version is required";
  if (!schemaVersion) return "manifest.schema_version is required";
  if (!entry) return "manifest.entry is required";
  if (
    !rawProvenance ||
    typeof rawProvenance !== "object" ||
    Array.isArray(rawProvenance)
  ) {
    return "manifest.provenance is required";
  }
  const provenanceObject = rawProvenance as Record<string, unknown>;
  const licenseSpdx = asString(provenanceObject["license_spdx"]);
  const copyrightNotice = asString(provenanceObject["copyright_notice"]);
  const sourceUrl = asString(provenanceObject["source_url"]);
  const sourceRevision = asString(provenanceObject["source_revision"]);
  if (!licenseSpdx) return "manifest.provenance.license_spdx is required";
  if (!copyrightNotice) {
    return "manifest.provenance.copyright_notice is required";
  }
  if (!sourceUrl) return "manifest.provenance.source_url is required";
  if (!sourceRevision) {
    return "manifest.provenance.source_revision is required";
  }
  if (!Array.isArray(rawAssets) || rawAssets.length === 0) {
    return "manifest.assets must be a non-empty array";
  }
  const assets: string[] = [];
  for (const a of rawAssets) {
    if (typeof a !== "string") return "manifest.assets entries must be strings";
    assets.push(a);
  }
  if (!assets.includes(entry)) {
    return `manifest.entry "${entry}" is not present in assets`;
  }
  return {
    id,
    name,
    version,
    schemaVersion,
    assets,
    entry,
    provenance: {
      licenseSpdx,
      copyrightNotice,
      sourceUrl,
      sourceRevision,
    },
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UploadTemplateDialog({
  onClose,
  onUploaded,
  replaceTemplate,
}: {
  onClose: () => void;
  onUploaded: () => void;
  replaceTemplate?: { id: string; slug: string; version: string };
}) {
  const i18n = useI18n();
  const [files, setFiles] = useState<File[]>([]);
  const [manifest, setManifest] = useState<ManifestShape | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const upload = useUploadPdfTemplateMutation();
  const replace = useReplacePdfTemplateBundleMutation();

  /**
   * Resolve the relative path of a `File` inside the picked bundle.
   * Browsers expose `webkitRelativePath` for directory-upload file picks.
   * For flat picks we fall back to the file name.
   */
  const relPath = useCallback((file: File): string => {
    const wkRel = (
      (file as unknown as { webkitRelativePath?: string }).webkitRelativePath ??
      ""
    )
      .toString()
      .trim();
    if (wkRel === "") return file.name;
    // Strip the top-level bundle directory if the user picked a folder; the
    // server expects manifest-relative paths (`preamble.typ`, not
    // `bundle/preamble.typ`).
    const slash = wkRel.indexOf("/");
    return slash >= 0 ? wkRel.slice(slash + 1) : wkRel;
  }, []);

  const handleFiles = useCallback(
    async (selected: File[]) => {
      setParseError(null);
      setManifest(null);
      setRightsConfirmed(false);
      setFiles(selected);
      if (selected.length === 0) return;
      // Find manifest.json
      const manifestFile = selected.find((f) => relPath(f) === "manifest.json");
      if (!manifestFile) {
        setParseError(i18n.t("admin.pdf-export.upload.error.no-manifest"));
        return;
      }
      try {
        const text = await manifestFile.text();
        const parsed = JSON.parse(text);
        const result = parseManifest(parsed);
        if (typeof result === "string") {
          setParseError(result);
          return;
        }
        if (replaceTemplate && result.id !== replaceTemplate.slug) {
          setParseError(
            `manifest.id "${result.id}" must match existing slug "${replaceTemplate.slug}"`,
          );
          return;
        }
        // Verify every declared asset is in the upload set.
        const uploaded = new Set(
          selected.map(relPath).filter((p) => p !== "manifest.json"),
        );
        const missing = result.assets.filter((a) => !uploaded.has(a));
        if (missing.length > 0) {
          setParseError(
            i18n
              .t("admin.pdf-export.upload.error.missing-assets")
              .replace("{{paths}}", missing.join(", ")),
          );
          return;
        }
        setManifest(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setParseError(`manifest.json parse error: ${msg}`);
      }
    },
    [i18n, relPath, replaceTemplate],
  );

  const handleUpload = useCallback(async () => {
    if (!manifest) {
      notify.error({
        title: i18n.t("admin.pdf-export.upload.error.invalid-bundle"),
      });
      return;
    }
    setUploading(true);
    try {
      // Build aligned filePaths/files arrays — manifest.json is sent as
      // the manifest argument; everything else goes into files[].
      const manifestFile = files.find((f) => relPath(f) === "manifest.json");
      const assetFiles = files.filter((f) => relPath(f) !== "manifest.json");
      const filePaths = assetFiles.map(relPath);
      if (!manifestFile) {
        throw new Error("manifest.json missing in upload set");
      }
      const manifestText = await manifestFile.text();
      const manifestJson = JSON.parse(manifestText);
      const variables = {
        manifest: manifestJson,
        filePaths,
        files: assetFiles,
        rightsConfirmed,
      };
      if (replaceTemplate) {
        await replace.trigger({ id: replaceTemplate.id, ...variables });
      } else {
        await upload.trigger(variables);
      }
      onUploaded();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error({
        title: `${i18n.t("admin.pdf-export.upload.failed")}: ${msg}`,
      });
    } finally {
      setUploading(false);
    }
  }, [
    manifest,
    files,
    upload,
    replace,
    replaceTemplate,
    rightsConfirmed,
    onUploaded,
    i18n,
    relPath,
  ]);

  const totalBytes = useMemo(
    () => files.reduce((sum, f) => sum + f.size, 0),
    [files],
  );

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={
        replaceTemplate
          ? i18n.t("admin.pdf-export.upload.replace-title")
          : i18n.t("admin.pdf-export.upload.title")
      }
      description={
        replaceTemplate
          ? i18n.t("admin.pdf-export.upload.replace-description")
          : i18n.t("admin.pdf-export.upload.description")
      }
    >
      <Stack>
        <UploadTarget
          title={i18n.t("admin.pdf-export.upload.choose-files")}
          description={i18n.t("admin.pdf-export.upload.hint")}
          pickLabel={i18n.t("admin.pdf-export.upload.choose-files")}
          multiple
          directory
          disabled={uploading}
          data-testid="pdf-template-upload-target"
          data-myoxus-ui-role="button:upload-target"
          onFiles={(nextFiles) => void handleFiles(nextFiles)}
        />

        {parseError ? (
          <SettingsNotice tone="error">{parseError}</SettingsNotice>
        ) : null}

        {manifest ? (
          <SettingsNotice tone="neutral" title={manifest.name}>
            <>
              <MonoText>{manifest.id}</MonoText>
              {" · "}v{manifest.version}
              {" · "}
              {manifest.provenance.licenseSpdx}
              {" · "}
              {files.length} {i18n.t("admin.pdf-export.upload.files-suffix")}
              {" · "}
              {(totalBytes / 1024).toFixed(1)} KB
            </>
          </SettingsNotice>
        ) : null}

        {manifest ? (
          <Checkbox
            checked={rightsConfirmed}
            onChange={(_, checked) => setRightsConfirmed(checked)}
            label={i18n.t("admin.pdf-export.upload.rights-confirmation")}
          />
        ) : null}

        <Divider />
        <DialogFooterActions>
          <Button variant="secondary" onClick={onClose} disabled={uploading}>
            {i18n.t("admin.common.cancel")}
          </Button>
          <Button
            onClick={handleUpload}
            variant="primary"
            disabled={!manifest || !rightsConfirmed || uploading}
            prefix={<UploadIcon aria-hidden />}
          >
            {uploading
              ? i18n.t("admin.pdf-export.upload.uploading")
              : replaceTemplate
                ? i18n.t("admin.pdf-export.upload.replace-button")
                : i18n.t("admin.pdf-export.upload.button")}
          </Button>
        </DialogFooterActions>
      </Stack>
    </Modal>
  );
}
