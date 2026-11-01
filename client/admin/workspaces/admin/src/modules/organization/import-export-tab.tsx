import { useI18n } from "@myoxus/i18n";
import { Download, RefreshCw, Send, ShieldCheck } from "@myoxus/icons/react";
import {
  Button,
  Group,
  IconButton,
  Loading,
  notify,
  SettingsDetailHeader,
  SettingsNotice,
  SettingsSkeleton,
  SettingsToolbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  UploadTarget,
} from "@myoxus/ui-facade";
import { useRef, useState } from "react";

import { formatAdminInteger } from "../../utils/locale-format";
import {
  useOrganizationExportQuery,
  useOrganizationImportApplyMutation,
  useOrganizationImportDryRunMutation,
} from "./api";

interface ImportError {
  source: string;
  row: number | null;
  field: string | null;
  message: string;
}

interface ImportReport {
  operation: "dryRun" | "apply";
  snapshot: string;
  errors: ImportError[];
}

export function ImportExportTab() {
  const i18n = useI18n();
  const exportQuery = useOrganizationExportQuery();
  const { exportPayload, mutate: refetchExport } = exportQuery;
  const dryRun = useOrganizationImportDryRunMutation();
  const apply = useOrganizationImportApplyMutation();
  const [snapshot, setSnapshot] = useState("");
  const [manualEntry, setManualEntry] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [pending, setPending] = useState(false);
  const busyRef = useRef(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [exportRefreshError, setExportRefreshError] = useState<string | null>(
    null,
  );
  const [exportPending, setExportPending] = useState(false);
  const exportBusyRef = useRef(false);
  const exportError = exportQuery.error?.message ?? exportRefreshError;
  const exportBusy = exportPending || exportQuery.isValidating;
  const exportReady = Boolean(
    exportPayload && !exportError && !exportQuery.isLoading && !exportBusy,
  );
  const busy = pending || dryRun.isMutating || apply.isMutating;
  const checked =
    report?.operation === "dryRun" &&
    report.errors.length === 0 &&
    report.snapshot === snapshot;

  function changeSnapshot(value: string) {
    setSnapshot(value);
    // A clean preflight applies only to the exact input that was checked.
    setReport(null);
    setRequestError(null);
  }

  function download(name: string, content: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function refreshExport() {
    if (exportBusyRef.current) return;
    exportBusyRef.current = true;
    setExportPending(true);
    setExportRefreshError(null);
    try {
      await refetchExport();
    } catch (error) {
      setExportRefreshError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      exportBusyRef.current = false;
      setExportPending(false);
    }
  }

  async function onFile(file: File) {
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(true);
    setRequestError(null);
    try {
      changeSnapshot(await file.text());
      setManualEntry(true);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  }

  async function runImport(operation: ImportReport["operation"]) {
    if (
      busyRef.current ||
      !snapshot.trim() ||
      (operation === "apply" &&
        (!checked || exportBusy || exportBusyRef.current))
    )
      return;
    busyRef.current = true;
    setPending(true);
    setRequestError(null);
    setReport(null);
    const input = { json: snapshot, files: null };
    try {
      const result =
        operation === "dryRun"
          ? (await dryRun.trigger({ input }))?.admin?.organizationImportDryRun
          : (await apply.trigger({ input }))?.admin?.organizationImportApply;
      if (!result?.errors)
        throw new Error(i18n.t("admin.organization.import.response-missing"));
      setReport({ operation, snapshot, errors: result.errors });
      if (operation === "apply" && result.errors.length === 0) {
        notify.success({ title: i18n.t("admin.organization.import.applied") });
        // Readback failure belongs to Export, not to the already applied write.
        await refreshExport();
      }
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  }

  return (
    <Stack>
      <Stack component="section">
        <SettingsDetailHeader
          headingLevel={2}
          title={i18n.t("admin.organization.export.title")}
          description={i18n.t("admin.organization.export.description")}
          actions={
            <>
              <IconButton
                icon={<RefreshCw aria-hidden />}
                aria-label={i18n.t("admin.organization.export.refresh")}
                disabled={exportBusy || busy}
                data-testid="organization-export-refresh"
                onClick={() => void refreshExport()}
              />
              <Button
                disabled={!exportReady}
                prefix={<Download aria-hidden />}
                data-testid="organization-export-download-json"
                onClick={() => {
                  if (exportReady && exportPayload)
                    download(
                      `organization-snapshot-v${exportPayload.schemaVersion}.json`,
                      exportPayload.json,
                      "application/json",
                    );
                }}
              >
                {i18n.t("admin.organization.export.download-json")}
              </Button>
            </>
          }
        />
        {exportError ? (
          <SettingsNotice
            tone="error"
            title={i18n.t("com.myoxus.settings.common.load-error")}
          >
            {exportError}
            <Group>
              <Button
                disabled={exportBusy || busy}
                onClick={() => void refreshExport()}
              >
                {i18n.t("admin.error.retry")}
              </Button>
            </Group>
          </SettingsNotice>
        ) : exportQuery.isLoading ? (
          <SettingsSkeleton />
        ) : exportPayload?.files?.length ? (
          <Table aria-label={i18n.t("admin.organization.export.title")}>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {i18n.t("admin.organization.export.col.file")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.organization.export.col.size")}
                </TableHead>
                <TableHead>{i18n.t("admin.common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exportPayload.files.map((file) => (
                <TableRow key={file.name}>
                  <TableCell>{file.name}</TableCell>
                  <TableCell>
                    {formatAdminInteger(
                      i18n.language,
                      new Blob([file.content]).size,
                    )}{" "}
                    {i18n.t("admin.common.bytes")}
                  </TableCell>
                  <TableCell>
                    <IconButton
                      disabled={!exportReady}
                      icon={<Download aria-hidden />}
                      aria-label={
                        i18n.t("admin.organization.export.download") +
                        " " +
                        file.name
                      }
                      onClick={() =>
                        download(file.name, file.content, "text/csv")
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </Stack>
      <Stack component="section">
        <SettingsDetailHeader
          headingLevel={2}
          title={i18n.t("admin.organization.import.title")}
          description={i18n.t("admin.organization.import.description")}
        />
        {!manualEntry ? (
          <Stack>
            <UploadTarget
              title={i18n.t("admin.organization.import.dropzone.title")}
              description={i18n.t("admin.organization.import.dropzone.hint")}
              pickLabel={i18n.t("admin.organization.import.dropzone.pick")}
              accept=".json,application/json"
              disabled={busy}
              data-testid="organization-import-dropzone"
              onFile={(file) => void onFile(file)}
            />
            <SettingsToolbar>
              <Button
                variant="plain"
                disabled={busy}
                data-testid="organization-import-paste"
                onClick={() => setManualEntry(true)}
              >
                {i18n.t("admin.organization.import.dropzone.paste")}
              </Button>
            </SettingsToolbar>
          </Stack>
        ) : (
          <Stack>
            <Textarea
              label={i18n.t("com.myoxus.import.snapshot")}
              rows={10}
              value={snapshot}
              disabled={busy}
              onChange={changeSnapshot}
              placeholder={i18n.t("admin.organization.import.placeholder")}
              data-testid="organization-import-textarea"
              mono
            />
            <SettingsToolbar>
              <Button
                variant="plain"
                disabled={busy}
                prefix={<RefreshCw aria-hidden />}
                onClick={() => {
                  changeSnapshot("");
                  setManualEntry(false);
                }}
              >
                {i18n.t("admin.actions.reset")}
              </Button>
              <Button
                variant="plain"
                disabled={!snapshot.trim() || busy}
                prefix={<ShieldCheck aria-hidden />}
                onClick={() => void runImport("dryRun")}
                data-testid="organization-import-dry-run"
              >
                {i18n.t("admin.organization.import.dry-run")}
              </Button>
              <Button
                variant="primary"
                disabled={!checked || busy || exportBusy}
                prefix={<Send aria-hidden />}
                onClick={() => void runImport("apply")}
                data-testid="organization-import-apply"
              >
                {i18n.t("admin.organization.import.apply")}
              </Button>
            </SettingsToolbar>
          </Stack>
        )}
        {pending ? <Loading /> : null}
        {requestError ? (
          <SettingsNotice
            tone="error"
            title={i18n.t("admin.organization.import.request-failed")}
          >
            {requestError}
          </SettingsNotice>
        ) : null}
        {report ? (
          <Stack data-testid="organization-import-report">
            <SettingsNotice
              tone={report.errors.length ? "error" : "success"}
              title={
                report.errors.length
                  ? i18n.t("admin.organization.import.error-count", {
                      count: report.errors.length,
                    })
                  : report.operation === "apply"
                    ? i18n.t("admin.organization.import.applied")
                    : i18n.t("admin.organization.import.dry-run-clean-summary")
              }
            />
            {report.errors.length ? (
              <Table aria-label={i18n.t("admin.organization.import.title")}>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {i18n.t("admin.organization.import.col.source")}
                    </TableHead>
                    <TableHead>
                      {i18n.t("admin.organization.import.col.row")}
                    </TableHead>
                    <TableHead>
                      {i18n.t("admin.organization.import.col.field")}
                    </TableHead>
                    <TableHead>
                      {i18n.t("admin.organization.import.col.message")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.errors.map((error, index) => (
                    <TableRow key={index}>
                      <TableCell>{error.source}</TableCell>
                      <TableCell>
                        {error.row == null
                          ? null
                          : formatAdminInteger(i18n.language, error.row)}
                      </TableCell>
                      <TableCell>{error.field}</TableCell>
                      <TableCell>{error.message}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </Stack>
  );
}
