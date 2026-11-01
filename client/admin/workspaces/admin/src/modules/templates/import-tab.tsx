/**
 * Templates — Import tab.
 *
 * Provides a file upload area for ZIP template bundles with drag & drop
 * support, file input fallback, and a validation result display area.
 * Wired to the importTemplate GraphQL mutation.
 */
import { useI18n } from "@myoxus/i18n";
import { AlertTriangleIcon } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  Group,
  MonoText,
  notify,
  SimpleGrid,
  SettingsEmptyState,
  SettingsNotice,
  SettingsStatusText,
  Stack,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Title,
  UploadTarget,
} from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useState } from "react";

import { importTemplateBundle, useTemplateRegistryRevalidate } from "./api";
import {
  buildTemplateImportStatusModel,
  parseTemplateImportError,
  type TemplateImportErrorState,
  type TemplateImportResult,
  type TemplateImportStatusModel,
} from "./status-models";
import {
  MetaField,
  MetaGrid,
  TemplateTabFrame,
} from "./template-role-primitives";

function ImportResultSection({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack>
      <Title order={3}>{title}</Title>
      {children}
    </Stack>
  );
}

function visibleImportFormat(i18n: ReturnType<typeof useI18n>, value: string) {
  if (value === "upstream_snapshot_zip") {
    return i18n.t("admin.templates.import.bundle.upstream-label");
  }
  if (value === "myoxus_bundle") {
    return i18n.t("admin.templates.import.bundle.preferred-label");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ImportTab() {
  const i18n = useI18n();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [importResult, setImportResult] = useState<TemplateImportResult | null>(
    null,
  );
  const [importStatus, setImportStatus] =
    useState<TemplateImportStatusModel | null>(null);
  const [importError, setImportError] =
    useState<TemplateImportErrorState | null>(null);

  const { revalidateCatalog } = useTemplateRegistryRevalidate();

  const handleFileSelect = useCallback(
    (file: File) => {
      if (isUploading) return;
      setSelectedFile(null);
      setImportResult(null);
      setImportStatus(null);
      setImportError(null);
      if (!file.name.toLowerCase().endsWith(".zip")) {
        setImportError({
          message: i18n.t("admin.templates.import.error.zip-only"),
          details: [],
        });
        return;
      }
      setSelectedFile(file);
    },
    [i18n, isUploading],
  );

  const handleUploadClick = useCallback(async () => {
    if (!selectedFile || isUploading) return;

    setIsUploading(true);
    setImportResult(null);
    setImportStatus(null);
    setImportError(null);

    try {
      const result = await importTemplateBundle(selectedFile);

      const importData = result?.admin?.importTemplate as
        TemplateImportResult | undefined;
      if (importData) {
        setImportResult(importData);
        setImportStatus(buildTemplateImportStatusModel(importData));
        if (importData.error) {
          setImportError({ message: importData.error, details: [] });
          notify.error({
            title: i18n.t("admin.templates.import.package.partial"),
          });
        } else {
          notify.success({
            title: importData.package
              ? i18n.t("admin.templates.import.package.success", {
                  count: importData.documents?.length ?? 0,
                })
              : i18n.t("admin.templates.import.toast.success", {
                  title: importData.entry!.title,
                  version: importData.revision!.version,
                }),
          });
        }
        // Revalidate catalog query so CatalogTab picks up the new entry
        revalidateCatalog().catch(() => {});
      } else {
        setImportError({
          message: i18n.t("admin.templates.import.unexpected-response"),
          details: [],
        });
      }
    } catch (err: any) {
      const parsedError = parseTemplateImportError(err);
      setImportError(parsedError);
      // 409 means the slug belongs to a builtin template (S-06: slug is reserved)
      const isBuiltinConflict =
        err?.extensions?.code === "CONFLICT" ||
        String(err?.message ?? "").includes("409") ||
        String(err?.message ?? "")
          .toLowerCase()
          .includes("builtin");
      if (isBuiltinConflict) {
        notify.error({
          title: i18n.t("admin.templates.import.toast.builtin-slug-conflict"),
        });
      } else {
        notify.error({
          title: i18n.t("admin.templates.import.toast.failed", {
            message: parsedError.message,
          }),
        });
      }
    } finally {
      setIsUploading(false);
    }
  }, [selectedFile, isUploading, revalidateCatalog, i18n]);

  return (
    <TemplateTabFrame
      title={i18n.t("admin.templates.import.title")}
      description={i18n.t("admin.templates.import.description")}
    >
      <Stack>
        <UploadTarget
          title={i18n.t("admin.templates.import.dropzone.hint")}
          description={i18n.t("admin.templates.import.dropzone.browse")}
          pickLabel={i18n.t("admin.templates.import.dropzone.choose-file")}
          accept=".zip,application/zip"
          disabled={isUploading}
          data-testid="templates-import-dropzone"
          onFile={handleFileSelect}
        />

        {/* Selected file info */}
        {selectedFile && (
          <MetaGrid>
            <MetaField
              label={i18n.t("admin.templates.import.file-label")}
              value={selectedFile.name}
              mono
            />
            <MetaField
              label={i18n.t("admin.templates.import.size-label")}
              value={`${(selectedFile.size / 1024).toFixed(1)} KB`}
              mono
            />
          </MetaGrid>
        )}

        <SimpleGrid cols={2}>
          <Stack>
            <Group>
              <Badge tone="info">myoxus_bundle</Badge>
              {i18n.t("admin.templates.import.bundle.preferred-label")}
            </Group>
            <SettingsStatusText>
              {i18n.t("admin.templates.import.bundle.preferred-hint")}
            </SettingsStatusText>
          </Stack>
          <Stack>
            <Group>
              <Badge tone="neutral">
                {i18n.t("admin.templates.import.bundle.snapshot-code")}
              </Badge>
              {i18n.t("admin.templates.import.bundle.upstream-label")}
            </Group>
            <SettingsStatusText>
              {i18n.t("admin.templates.import.bundle.upstream-hint")}
            </SettingsStatusText>
          </Stack>
        </SimpleGrid>

        <SettingsStatusText>
          {i18n.t("admin.templates.import.bundle.compatibility-note")}
        </SettingsStatusText>

        {/* Upload button */}
        <Group justify="flex-start">
          <Button
            type="button"
            disabled={!selectedFile || isUploading}
            onClick={handleUploadClick}
          >
            {isUploading
              ? i18n.t("admin.templates.import.uploading")
              : i18n.t("admin.templates.import.upload")}
          </Button>
        </Group>

        {/* Error display */}
        {importError && (
          <SettingsNotice
            tone="error"
            title={i18n.t("admin.templates.import.error-title")}
          >
            <Stack>
              <SettingsStatusText>{importError.message}</SettingsStatusText>
              {importError.details.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {i18n.t("admin.templates.detail.field.description")}
                      </TableHead>
                      <TableHead>
                        {i18n.t("admin.templates.import.field.code")}
                      </TableHead>
                      <TableHead>
                        {i18n.t("admin.templates.import.field.path")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importError.details.map((detail, index) => (
                      <TableRow
                        key={`${detail.errorCode ?? "detail"}-${detail.path ?? "root"}-${index}`}
                      >
                        <TableCell>{detail.message}</TableCell>
                        <TableCell>
                          <MonoText>{detail.errorCode ?? "—"}</MonoText>
                        </TableCell>
                        <TableCell>
                          <MonoText>{detail.path ?? "—"}</MonoText>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : null}
            </Stack>
          </SettingsNotice>
        )}

        {/* Success / validation result area */}
        {importResult && (
          <SettingsNotice
            tone={importResult.error ? "warning" : "success"}
            title={
              importResult.error
                ? i18n.t("admin.templates.import.package.partial")
                : i18n.t("admin.templates.import.success-title")
            }
          >
            <Stack>
              <SimpleGrid cols={2}>
                <div>
                  <strong>
                    {importResult.package
                      ? i18n.t("admin.templates.import.package.label")
                      : i18n.t("admin.templates.import.field.template")}
                  </strong>{" "}
                  {importResult.package
                    ? importResult.package.package_id
                    : `${importResult.entry!.title} (${importResult.entry!.slug})`}
                </div>
                <div>
                  <strong>
                    {i18n.t("admin.templates.import.field.version")}
                  </strong>{" "}
                  {importResult.package?.version ??
                    importResult.revision!.version}
                </div>
                <div>
                  <strong>
                    {i18n.t("admin.templates.import.field.state")}
                  </strong>{" "}
                  <Badge tone={importResult.error ? "warning" : "info"}>
                    {importResult.package
                      ? importResult.error
                        ? i18n.t("admin.templates.import.package.partial")
                        : i18n.t("admin.templates.import.package.success", {
                            count: importResult.documents?.length ?? 0,
                          })
                      : importResult.revision!.state}
                  </Badge>
                </div>
                {importStatus?.detectedFormat && (
                  <div>
                    <strong>
                      {i18n.t("admin.templates.import.field.detected-format")}
                    </strong>{" "}
                    <span>
                      {visibleImportFormat(i18n, importStatus.detectedFormat)}
                    </span>
                  </div>
                )}
                {importStatus?.normalized !== null && (
                  <div>
                    <strong>
                      {i18n.t("admin.templates.import.field.normalized")}
                    </strong>{" "}
                    {importStatus?.normalized
                      ? i18n.t("admin.templates.import.field.normalized-yes")
                      : i18n.t("admin.templates.import.field.normalized-no")}
                  </div>
                )}
                {importStatus?.ignoredEntriesCount != null && (
                  <div>
                    <strong>
                      {i18n.t("admin.templates.import.field.ignored-entries")}
                    </strong>{" "}
                    {importStatus.ignoredEntriesCount}
                  </div>
                )}
                {importStatus?.errorCatalogVersion && (
                  <div>
                    <strong>
                      {i18n.t("admin.templates.import.field.error-catalog")}
                    </strong>{" "}
                    <MonoText>{importStatus.errorCatalogVersion}</MonoText>
                  </div>
                )}
              </SimpleGrid>
              {importResult.package && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {i18n.t("admin.templates.import.field.template")}
                      </TableHead>
                      <TableHead>
                        {i18n.t("admin.templates.import.field.version")}
                      </TableHead>
                      <TableHead>
                        {i18n.t("admin.templates.import.field.state")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importResult.documents?.map((child) => (
                      <TableRow key={child.revision.id}>
                        <TableCell>{child.entry.title}</TableCell>
                        <TableCell>{child.revision.version}</TableCell>
                        <TableCell>
                          <Badge tone="info">{child.revision.state}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {importStatus?.normalizationWarnings.length ? (
                <ImportResultSection
                  title={i18n.t("admin.templates.import.section.norm-warnings")}
                >
                  <Stack component="ul">
                    {importStatus.normalizationWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </Stack>
                </ImportResultSection>
              ) : null}

              {importStatus?.compatibilityNotes.length ? (
                <ImportResultSection
                  title={i18n.t("admin.templates.import.section.compat-notes")}
                >
                  <Stack component="ul">
                    {importStatus.compatibilityNotes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </Stack>
                </ImportResultSection>
              ) : null}

              {importResult.warnings.length > 0 && (
                <ImportResultSection
                  title={
                    <Group align="center" wrap="wrap">
                      <AlertTriangleIcon aria-hidden="true" />
                      {i18n.t("admin.templates.import.warnings", {
                        count: importResult.warnings.length,
                        plural: importResult.warnings.length !== 1 ? "s" : "",
                      })}
                    </Group>
                  }
                >
                  <Stack component="ul">
                    {importResult.warnings.map((w, i) => (
                      <li key={i}>
                        <MonoText>{w.code}</MonoText>: {w.message}
                        {w.field
                          ? ` (${i18n.t("admin.templates.import.field.field")} ${w.field})`
                          : ""}
                      </li>
                    ))}
                  </Stack>
                </ImportResultSection>
              )}
            </Stack>
          </SettingsNotice>
        )}

        {/* Empty placeholder when no result */}
        {!importResult && !importError && (
          <SettingsEmptyState
            title={i18n.t("admin.templates.import.placeholder")}
            description={i18n.t("admin.state.empty")}
          />
        )}
      </Stack>
    </TemplateTabFrame>
  );
}
