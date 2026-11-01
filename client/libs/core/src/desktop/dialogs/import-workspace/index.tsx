// SPDX-License-Identifier: MIT

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { useQuery } from "@myoxus/core/components/hooks/use-query";
import {
  type DialogComponentProps,
  type GLOBAL_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import {
  type WorkspaceMetadata,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import {
  applyWorkspaceImportMutation,
  cancelWorkspaceImportMutation,
  completeWorkspaceImportUploadMutation,
  createWorkspaceImportUploadMutation,
  previewWorkspaceImportMutation,
  type WorkspaceImportProjectionFragment,
  WorkspaceImportSourceFormatInput,
  workspaceImportQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Checkbox,
  DialogFooterActions,
  Group,
  Modal,
  MyoxusText,
  MyoxusTitle,
  Progress,
  RadioGroup,
  SettingsNotice,
  SimpleGrid,
  Stack,
  StatCell,
  UploadTarget,
} from "@myoxus/ui-facade";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  isWorkspaceImportPollingStatus,
  type PreparedWorkspaceImport,
  prepareWorkspaceImport,
  type SignedWorkspaceImportPart,
  uploadWorkspaceImportParts,
  WORKSPACE_IMPORT_PART_BYTES,
  workspaceImportDiagnosticSourcePath,
  workspaceImportProgress,
} from "./workspace-import";

const WORKSPACE_IMPORT_ACCEPT =
  ".affine,.affine.zip,.bs.zip,.zip,.db,.myoxus,application/zip,application/x-sqlite3";

type UploadRecovery = {
  file: File;
  importId: string;
  prepared: PreparedWorkspaceImport;
  signedParts: SignedWorkspaceImportPart[];
};

type ActiveWorkspaceImport = {
  importId: string;
  upload?: UploadRecovery;
};

// Deliberately session-memory only: Browser Web must not persist workspace
// state locally. The server record remains authoritative after upload.
let activeWorkspaceImport: ActiveWorkspaceImport | null = null;

type LocalPhase = "idle" | "preparing" | "uploading";
type ImportSource = "workspace-backup" | "obsidian-vault";

function ImportProgressStatus({
  ariaLabel,
  label,
  value,
}: {
  ariaLabel: string;
  label: ReactNode;
  value: number;
}) {
  return (
    <Group
      align="center"
      miw={0}
      wrap="nowrap"
      data-myoxus-ui-role="workspace-import-progress-status"
    >
      <Progress
        ariaLabel={ariaLabel}
        showValueLabel={false}
        style={{ flex: "1 1 auto" }}
        value={value}
      />
      <MyoxusText
        component="span"
        tone="secondary"
        truncate
        typographySlot="body-small"
      >
        {label}
      </MyoxusText>
    </Group>
  );
}

function recordForQuery(record: WorkspaceImportProjectionFragment) {
  return { workspaceImport: record };
}

export const ImportWorkspaceDialog = ({
  close,
  returnFocusRef,
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["import-workspace"]>) => {
  const t = useI18n();
  const [open, setOpen] = useState(true);
  const workspacesService = useService(WorkspacesService);
  const [importId, setImportId] = useState(
    () => activeWorkspaceImport?.importId ?? null,
  );
  const [localPhase, setLocalPhase] = useState<LocalPhase>("idle");
  const [localProgress, setLocalProgress] = useState(0);
  const [localError, setLocalError] = useState(false);
  const [importSource, setImportSource] =
    useState<ImportSource>("workspace-backup");
  const [acceptedChanges, setAcceptedChanges] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const revalidatedWorkspaceRef = useRef<string | null>(null);

  const createUpload = useMutation({
    mutation: createWorkspaceImportUploadMutation,
  });
  const completeUpload = useMutation({
    mutation: completeWorkspaceImportUploadMutation,
  });
  const previewImport = useMutation(
    {
      mutation: previewWorkspaceImportMutation,
    },
    { suppressErrorNotification: true },
  );
  const applyImport = useMutation(
    { mutation: applyWorkspaceImportMutation },
    { suppressErrorNotification: true },
  );
  const cancelImport = useMutation(
    {
      mutation: cancelWorkspaceImportMutation,
    },
    { suppressErrorNotification: true },
  );

  const {
    data,
    error: queryError,
    mutate: mutateStatus,
  } = useQuery(
    importId
      ? {
          query: workspaceImportQuery,
          variables: { workspaceImportId: importId },
        }
      : undefined,
    {
      suspense: false,
      suppressErrorNotification: true,
      refreshInterval: (latest) =>
        isWorkspaceImportPollingStatus(latest?.workspaceImport.status)
          ? 750
          : 0,
    },
  );
  const record = data?.workspaceImport ?? null;
  const status = record?.status ?? null;
  const preview = record?.preview ?? null;
  const localBusy = localPhase !== "idle";
  const operationBusy =
    applyImport.isMutating ||
    cancelImport.isMutating ||
    previewImport.isMutating;
  const requiresChangeConfirmation = useMemo(() => {
    if (!preview) return false;
    const classifications = (
      preview.targetPlan.vault as
        | { classifications?: Array<{ preservation?: string }> }
        | null
        | undefined
    )?.classifications;
    return (
      preview.diagnostics.some((diagnostic) =>
        [
          "MIX_WORKSPACE_IMPORT_LABEL_COLOR_NORMALIZED",
          "MIX_WORKSPACE_IMPORT_DATABASE_VALUES_OMITTED",
          "MIX_WORKSPACE_IMPORT_VAULT_CONTENT_NORMALIZED",
          "MIX_WORKSPACE_IMPORT_VAULT_SOURCE_PRESERVED",
        ].includes(diagnostic.code),
      ) ||
      classifications?.some((classification) =>
        ["normalized", "source_preserved"].includes(
          classification.preservation ?? "",
        ),
      ) === true
    );
  }, [preview]);

  useEffect(() => {
    setAcceptedChanges(false);
  }, [preview?.planFingerprint]);

  useEffect(() => {
    const workspaceId = record?.targetWorkspaceId;
    if (status !== "succeeded" || !workspaceId) return;
    if (revalidatedWorkspaceRef.current === workspaceId) return;
    revalidatedWorkspaceRef.current = workspaceId;
    void workspacesService.list.waitForRevalidation();
  }, [record?.targetWorkspaceId, status, workspacesService]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const updateStatus = useCallback(
    async (next: WorkspaceImportProjectionFragment) => {
      await mutateStatus(recordForQuery(next), { revalidate: false });
    },
    [mutateStatus],
  );

  const queuePreview = useCallback(
    async (workspaceImportId: string) => {
      const response = await previewImport.trigger({ workspaceImportId });
      await updateStatus(response.previewWorkspaceImport);
    },
    [previewImport, updateStatus],
  );

  const uploadPrepared = useCallback(
    async (recovery: UploadRecovery) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setLocalError(false);
      setLocalPhase("uploading");
      setLocalProgress(0);
      await uploadWorkspaceImportParts(recovery.file, recovery.signedParts, {
        signal: controller.signal,
        onProgress: (current, total) =>
          setLocalProgress(workspaceImportProgress(current, total)),
      });
      const response = await completeUpload.trigger({
        workspaceImportId: recovery.importId,
        sourceSizeBytes: recovery.prepared.sourceSizeBytes,
        sourceHash: recovery.prepared.sourceHash,
      });
      await updateStatus(response.completeWorkspaceImportUpload);
      activeWorkspaceImport = { importId: recovery.importId };
      setLocalPhase("idle");
      await queuePreview(recovery.importId);
    },
    [completeUpload, queuePreview, updateStatus],
  );

  const selectFile = useCallback(
    async (file: File) => {
      try {
        const controller = new AbortController();
        abortRef.current?.abort();
        abortRef.current = controller;
        setLocalError(false);
        setLocalPhase("preparing");
        setLocalProgress(0);
        const prepared = await prepareWorkspaceImport(file, {
          signal: controller.signal,
          onProgress: (current, total) =>
            setLocalProgress(workspaceImportProgress(current, total)),
        });
        const response = await createUpload.trigger({
          sourceSizeBytes: prepared.sourceSizeBytes,
          sourceHash: prepared.sourceHash,
          parts: prepared.parts,
          sourceFormat:
            importSource === "obsidian-vault"
              ? WorkspaceImportSourceFormatInput.ObsidianZip
              : null,
        });
        const upload = response.createWorkspaceImportUpload;
        if (upload.partSizeBytes !== WORKSPACE_IMPORT_PART_BYTES) {
          throw new Error("Workspace import upload contract mismatch");
        }
        const recovery: UploadRecovery = {
          file,
          importId: upload.workspaceImportId,
          prepared,
          signedParts: upload.parts,
        };
        activeWorkspaceImport = {
          importId: upload.workspaceImportId,
          upload: recovery,
        };
        setImportId(upload.workspaceImportId);
        await uploadPrepared(recovery);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        console.error("Workspace import upload failed", error);
        setLocalPhase("idle");
        setLocalError(true);
      }
    },
    [createUpload, importSource, uploadPrepared],
  );

  const resumeUpload = useCallback(async () => {
    const recovery = activeWorkspaceImport?.upload;
    if (!recovery) return;
    try {
      await uploadPrepared(recovery);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("Workspace import upload resume failed", error);
      setLocalPhase("idle");
      setLocalError(true);
    }
  }, [uploadPrepared]);

  const startOver = useCallback(async () => {
    abortRef.current?.abort();
    if (
      importId &&
      status &&
      !["succeeded", "failed", "cancelled", "expired"].includes(status)
    ) {
      try {
        await cancelImport.trigger({ workspaceImportId: importId });
      } catch {
        // Keep the active server job reachable if cancellation was not accepted.
        setLocalError(true);
        return;
      }
    }
    activeWorkspaceImport = null;
    setImportId(null);
    setLocalError(false);
    setLocalPhase("idle");
    setLocalProgress(0);
    setAcceptedChanges(false);
  }, [cancelImport, importId, status]);

  const handleOperation = useCallback(
    async (operation: () => Promise<unknown>) => {
      setLocalError(false);
      try {
        await operation();
      } catch {
        // Rejected policy confirmations are ordinary local feedback, not an
        // unhandled event-handler promise. The server job remains authoritative.
        setLocalError(true);
        setAcceptedChanges(false);
      }
    },
    [],
  );

  const apply = useCallback(async () => {
    if (!importId || !preview?.applyAllowed) return;
    const response = await applyImport.trigger({
      workspaceImportId: importId,
    });
    await updateStatus(response.applyWorkspaceImport);
  }, [applyImport, importId, preview?.applyAllowed, updateStatus]);

  const cancel = useCallback(async () => {
    if (!importId) return;
    const response = await cancelImport.trigger({
      workspaceImportId: importId,
    });
    await updateStatus(response.cancelWorkspaceImport);
  }, [cancelImport, importId, updateStatus]);

  const openImportedWorkspace = useCallback(async () => {
    const workspaceId = record?.targetWorkspaceId;
    if (!workspaceId) return;
    await workspacesService.list.waitForRevalidation();
    const workspace =
      workspacesService.list.workspaces$.value.find(
        (candidate) => candidate.id === workspaceId,
      ) ??
      ({
        id: workspaceId,
        flavour: "myoxus-cloud",
      } satisfies WorkspaceMetadata);
    activeWorkspaceImport = null;
    close({ workspace });
  }, [close, record?.targetWorkspaceId, workspacesService]);

  const diagnosticText = useCallback(
    (code: string) => {
      switch (code) {
        case "MIX_WORKSPACE_IMPORT_LABEL_COLOR_NORMALIZED":
          return t[
            "com.myoxus.workspace-import.diagnostic.label-color-normalized"
          ]();
        case "MIX_WORKSPACE_IMPORT_FORMAT_UNSUPPORTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.format-unsupported"
          ]();
        case "MIX_WORKSPACE_IMPORT_UPLOAD_LIMIT":
          return t["com.myoxus.workspace-import.diagnostic.upload-limit"]();
        case "MIX_WORKSPACE_IMPORT_ARCHIVE_INVALID":
          return t["com.myoxus.workspace-import.diagnostic.archive-invalid"]();
        case "MIX_WORKSPACE_IMPORT_ARCHIVE_LIMIT":
          return t["com.myoxus.workspace-import.diagnostic.archive-limit"]();
        case "MIX_WORKSPACE_IMPORT_SQLITE_INVALID":
          return t["com.myoxus.workspace-import.diagnostic.sqlite-invalid"]();
        case "MIX_WORKSPACE_IMPORT_SQLITE_SCHEMA_UNSUPPORTED":
          return t["com.myoxus.workspace-import.diagnostic.sqlite-schema"]();
        case "MIX_WORKSPACE_IMPORT_SNAPSHOT_INVALID":
          return t["com.myoxus.workspace-import.diagnostic.snapshot-invalid"]();
        case "MIX_WORKSPACE_IMPORT_ASSET_MISSING":
          return t["com.myoxus.workspace-import.diagnostic.asset-missing"]();
        case "MIX_WORKSPACE_IMPORT_DOCUMENT_INVALID":
          return t["com.myoxus.workspace-import.diagnostic.document-invalid"]();
        case "MIX_WORKSPACE_IMPORT_DATABASE_INVALID":
          return t["com.myoxus.workspace-import.diagnostic.database-invalid"]();
        case "MIX_WORKSPACE_IMPORT_DATABASE_UNSUPPORTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.database-unsupported"
          ]();
        case "MIX_WORKSPACE_IMPORT_DATABASE_VALUES_OMITTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.database-values-omitted"
          ]();
        case "MIX_WORKSPACE_IMPORT_VAULT_ROOT":
          return t["com.myoxus.workspace-import.diagnostic.vault-root"]();
        case "MIX_WORKSPACE_IMPORT_VAULT_ENTRIES_EXCLUDED":
          return t[
            "com.myoxus.workspace-import.diagnostic.vault-entries-excluded"
          ]();
        case "MIX_WORKSPACE_IMPORT_VAULT_YAML_INVALID":
          return t[
            "com.myoxus.workspace-import.diagnostic.vault-yaml-invalid"
          ]();
        case "MIX_WORKSPACE_IMPORT_VAULT_CONTENT_NORMALIZED":
          return t[
            "com.myoxus.workspace-import.diagnostic.vault-content-normalized"
          ]();
        case "MIX_WORKSPACE_IMPORT_VAULT_SOURCE_PRESERVED":
          return t[
            "com.myoxus.workspace-import.diagnostic.vault-source-preserved"
          ]();
        case "MIX_WORKSPACE_IMPORT_APPLY_BLOCKED":
          return t["com.myoxus.workspace-import.diagnostic.apply-blocked"]();
        case "MIX_WORKSPACE_IMPORT_PERMISSION_DENIED":
          return t[
            "com.myoxus.workspace-import.diagnostic.permission-denied"
          ]();
        case "MIX_WORKSPACE_IMPORT_CANCELLED":
          return t["com.myoxus.workspace-import.diagnostic.cancelled"]();
        case "MIX_WORKSPACE_IMPORT_CLEANUP_REQUIRED":
          return t["com.myoxus.workspace-import.diagnostic.cleanup-required"]();
        case "MIX_WORKSPACE_IMPORT_EXPIRED":
          return t["com.myoxus.workspace-import.diagnostic.expired"]();
        case "MIX_WORKSPACE_IMPORT_MEMBERSHIPS_OMITTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.memberships-omitted"
          ]();
        case "MIX_WORKSPACE_IMPORT_SESSIONS_OMITTED":
          return t["com.myoxus.workspace-import.diagnostic.sessions-omitted"]();
        case "MIX_WORKSPACE_IMPORT_SHARING_PUBLICATIONS_OMITTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.sharing-publications-omitted"
          ]();
        case "MIX_WORKSPACE_IMPORT_COMMENTS_OMITTED":
          return t["com.myoxus.workspace-import.diagnostic.comments-omitted"]();
        case "MIX_WORKSPACE_IMPORT_ACTIVITY_HISTORY_OMITTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.activity-history-omitted"
          ]();
        case "MIX_WORKSPACE_IMPORT_EXTERNAL_INTEGRATIONS_CREDENTIALS_OMITTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.integrations-credentials-omitted"
          ]();
        default:
          return t["com.myoxus.workspace-import.diagnostic.unknown"]();
      }
    },
    [t],
  );

  const formatText = useCallback(
    (format: string) => {
      switch (format) {
        case "sqlite_v1":
          return t["com.myoxus.workspace-import.format.sqlite-v1"]();
        case "sqlite_doc_storage":
          return t["com.myoxus.workspace-import.format.sqlite-doc-storage"]();
        case "snapshot_zip":
          return t["com.myoxus.workspace-import.format.snapshot-zip"]();
        case "obsidian_zip":
          return t["com.myoxus.workspace-import.format.obsidian-zip"]();
        default:
          return t["com.myoxus.workspace-import.format.unknown"]();
      }
    },
    [t],
  );

  const diagnosticTitle = useCallback(
    (code: string) => {
      switch (code) {
        case "MIX_WORKSPACE_IMPORT_LABEL_COLOR_NORMALIZED":
          return t["Tags"]();
        case "MIX_WORKSPACE_IMPORT_MEMBERSHIPS_OMITTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.memberships-omitted-title"
          ]();
        case "MIX_WORKSPACE_IMPORT_SESSIONS_OMITTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.sessions-omitted-title"
          ]();
        case "MIX_WORKSPACE_IMPORT_SHARING_PUBLICATIONS_OMITTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.sharing-publications-omitted-title"
          ]();
        case "MIX_WORKSPACE_IMPORT_COMMENTS_OMITTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.comments-omitted-title"
          ]();
        case "MIX_WORKSPACE_IMPORT_ACTIVITY_HISTORY_OMITTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.activity-history-omitted-title"
          ]();
        case "MIX_WORKSPACE_IMPORT_EXTERNAL_INTEGRATIONS_CREDENTIALS_OMITTED":
          return t[
            "com.myoxus.workspace-import.diagnostic.integrations-credentials-omitted-title"
          ]();
        default:
          return diagnosticText(code);
      }
    },
    [diagnosticText, t],
  );

  const errorText = record?.errorCode
    ? diagnosticText(record.errorCode)
    : t["com.myoxus.workspace-import.error.generic"]();
  const serverProgress = workspaceImportProgress(
    record?.progressCurrent ?? 0,
    record?.progressTotal ?? 0,
  );

  const content = useMemo(() => {
    if (localPhase !== "idle") {
      return (
        <>
          <MyoxusTitle order={3} typographySlot="section-title">
            {localPhase === "preparing"
              ? t["com.myoxus.workspace-import.preparing"]()
              : t["com.myoxus.workspace-import.uploading"]()}
          </MyoxusTitle>
          <ImportProgressStatus
            ariaLabel={t["com.myoxus.workspace-import.progress"]()}
            label={`${localProgress}%`}
            value={localProgress}
          />
          <DialogFooterActions>
            <Button variant="secondary" onClick={() => void startOver()}>
              {t["Cancel"]()}
            </Button>
          </DialogFooterActions>
        </>
      );
    }

    if (!importId) {
      return (
        <>
          <MyoxusText component="p" tone="secondary">
            {t["com.myoxus.workspace-import.description"]()}
          </MyoxusText>
          <RadioGroup
            block
            value={importSource}
            data-myoxus-ui-role="workspace-import-source-selector"
            items={[
              {
                value: "workspace-backup",
                label:
                  t["com.myoxus.workspace-import.source.workspace-backup"](),
                testId: "workspace-import-source-workspace-backup",
              },
              {
                value: "obsidian-vault",
                label: t["com.myoxus.workspace-import.source.obsidian-vault"](),
                testId: "workspace-import-source-obsidian-vault",
              },
            ]}
            onChange={(value: ImportSource) => setImportSource(value)}
          />
          {localError ? (
            <SettingsNotice tone="error">
              {t["com.myoxus.workspace-import.error.generic"]()}
            </SettingsNotice>
          ) : null}
          <UploadTarget
            accept={WORKSPACE_IMPORT_ACCEPT}
            data-testid="workspace-import-upload"
            title={
              importSource === "obsidian-vault"
                ? t["com.myoxus.workspace-import.upload-vault-title"]()
                : t["com.myoxus.workspace-import.upload-title"]()
            }
            description={
              importSource === "obsidian-vault"
                ? t["com.myoxus.workspace-import.upload-vault-description"]()
                : t["com.myoxus.workspace-import.upload-description"]()
            }
            pickLabel={t["com.myoxus.workspace-import.choose-file"]()}
            onFile={(file) => void selectFile(file)}
          />
        </>
      );
    }

    if (queryError) {
      return (
        <>
          <SettingsNotice tone="error">{errorText}</SettingsNotice>
          <DialogFooterActions>
            <Button
              variant="secondary"
              onClick={() => void handleOperation(() => mutateStatus())}
            >
              {t["Retry"]()}
            </Button>
            <Button variant="primary" onClick={() => void startOver()}>
              {t["com.myoxus.workspace-import.start-over"]()}
            </Button>
          </DialogFooterActions>
        </>
      );
    }

    if (status === "staged" && activeWorkspaceImport?.upload) {
      return (
        <>
          <SettingsNotice
            title={t["com.myoxus.workspace-import.resume-title"]()}
          >
            {t["com.myoxus.workspace-import.resume-description"]()}
          </SettingsNotice>
          <DialogFooterActions>
            <Button variant="secondary" onClick={() => void startOver()}>
              {t["com.myoxus.workspace-import.start-over"]()}
            </Button>
            <Button variant="primary" onClick={() => void resumeUpload()}>
              {t["com.myoxus.workspace-import.resume"]()}
            </Button>
          </DialogFooterActions>
        </>
      );
    }

    if (status === "staged") {
      return (
        <>
          <SettingsNotice
            title={t["com.myoxus.workspace-import.preview-retry-title"]()}
          >
            {t["com.myoxus.workspace-import.preview-retry-description"]()}
          </SettingsNotice>
          <DialogFooterActions>
            <Button variant="secondary" onClick={() => void startOver()}>
              {t["com.myoxus.workspace-import.start-over"]()}
            </Button>
            <Button
              disabled={previewImport.isMutating}
              variant="primary"
              onClick={() => void handleOperation(() => queuePreview(importId))}
            >
              {t["Retry"]()}
            </Button>
          </DialogFooterActions>
        </>
      );
    }

    if (isWorkspaceImportPollingStatus(status)) {
      return (
        <>
          <MyoxusTitle order={3} typographySlot="section-title">
            {record?.queuedOperation === "apply"
              ? t["com.myoxus.workspace-import.applying"]()
              : t["com.myoxus.workspace-import.previewing"]()}
          </MyoxusTitle>
          <ImportProgressStatus
            ariaLabel={t["com.myoxus.workspace-import.progress"]()}
            label={`${serverProgress}%`}
            value={serverProgress}
          />
          <DialogFooterActions>
            <Button
              data-testid="workspace-import-cancel"
              disabled={cancelImport.isMutating || record?.cancelRequested}
              variant="secondary"
              onClick={() => void handleOperation(cancel)}
            >
              {t["Cancel"]()}
            </Button>
          </DialogFooterActions>
        </>
      );
    }

    if (status === "previewed" && preview) {
      return (
        <>
          <Group justify="space-between" align="flex-start">
            <MyoxusTitle order={3} typographySlot="section-title">
              {preview.proposedWorkspaceTitle}
            </MyoxusTitle>
            <Badge>{formatText(preview.detectedFormat)}</Badge>
          </Group>
          <SimpleGrid cols={{ base: 2, sm: 3 }}>
            <StatCell
              density="compact"
              label={t["Documents"]()}
              value={preview.counts.documents}
            />
            <StatCell
              density="compact"
              label={t["com.myoxus.database.index.title"]()}
              value={preview.counts.databases}
            />
            <StatCell
              density="compact"
              label={t["com.myoxus.workspace-import.count.fields"]()}
              value={preview.counts.fields}
            />
            <StatCell
              density="compact"
              label={t["com.myoxus.workspace-import.count.rows"]()}
              value={preview.counts.rows}
            />
            <StatCell
              density="compact"
              label={t["com.myoxus.workspace-import.count.assets"]()}
              value={preview.counts.assets}
            />
            <StatCell
              density="compact"
              label={t["com.myoxus.workspace-import.count.views"]()}
              value={preview.counts.views}
            />
          </SimpleGrid>
          {preview.diagnostics.length ? (
            <Stack data-myoxus-ui-role="workspace-import-diagnostics">
              {["blocking", "informational"].map((severity) => {
                const diagnostics = preview.diagnostics.filter(
                  (diagnostic) => diagnostic.severity === severity,
                );
                if (!diagnostics.length) return null;
                return (
                  <Stack key={severity}>
                    <MyoxusTitle order={4} typographySlot="section-title">
                      {severity === "blocking"
                        ? t[
                            "com.myoxus.workspace-import.diagnostics.blocking"
                          ]()
                        : t[
                            "com.myoxus.workspace-import.diagnostics.changes"
                          ]()}
                    </MyoxusTitle>
                    <Accordion
                      multiple
                      defaultValue={diagnostics.flatMap((_, index) =>
                        severity === "blocking" ? [String(index)] : [],
                      )}
                    >
                      {diagnostics.map((diagnostic, index) => (
                        <AccordionItem
                          key={`${diagnostic.code}-${index}`}
                          value={String(index)}
                        >
                          <AccordionControl>
                            {diagnosticTitle(diagnostic.code)}
                          </AccordionControl>
                          <AccordionPanel>
                            <SettingsNotice
                              tone={severity === "blocking" ? "error" : "info"}
                              title={workspaceImportDiagnosticSourcePath(
                                diagnostic.context,
                              )}
                            >
                              {diagnosticText(diagnostic.code)}
                            </SettingsNotice>
                          </AccordionPanel>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </Stack>
                );
              })}
            </Stack>
          ) : null}
          {requiresChangeConfirmation ? (
            <Checkbox
              checked={acceptedChanges}
              data-testid="workspace-import-confirm-changes"
              label={t["com.myoxus.workspace-import.confirm-changes"]()}
              onChange={(_, checked) => setAcceptedChanges(checked)}
            />
          ) : null}
          {!preview.applyAllowed ? (
            <SettingsNotice tone="error">
              {t["com.myoxus.workspace-import.preview-blocked"]()}
            </SettingsNotice>
          ) : null}
          <DialogFooterActions>
            <Button
              data-testid="workspace-import-start-over"
              variant="secondary"
              onClick={() => void startOver()}
            >
              {t["com.myoxus.workspace-import.start-over"]()}
            </Button>
            <Button
              data-testid="workspace-import-apply"
              disabled={
                !preview.applyAllowed ||
                operationBusy ||
                (requiresChangeConfirmation && !acceptedChanges)
              }
              variant="primary"
              onClick={() => void handleOperation(apply)}
            >
              {t["com.myoxus.workspace-import.apply"]()}
            </Button>
          </DialogFooterActions>
        </>
      );
    }

    if (status === "succeeded") {
      return (
        <>
          <SettingsNotice
            title={t["com.myoxus.workspace-import.success-title"]()}
            tone="success"
          >
            {t["com.myoxus.workspace-import.success-description"]()}
          </SettingsNotice>
          <DialogFooterActions>
            <Button
              data-testid="workspace-import-open"
              variant="primary"
              onClick={() => void handleOperation(openImportedWorkspace)}
            >
              {t["com.myoxus.workspace-import.open"]()}
            </Button>
          </DialogFooterActions>
        </>
      );
    }

    if (status === "cleanup_required") {
      return (
        <>
          <SettingsNotice
            title={t["com.myoxus.workspace-import.cleanup-title"]()}
            tone="error"
          >
            {t["com.myoxus.workspace-import.cleanup-description"]()}
          </SettingsNotice>
          <DialogFooterActions>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t["com.myoxus.workspace-import.close"]()}
            </Button>
          </DialogFooterActions>
        </>
      );
    }

    if (["failed", "cancelled", "expired"].includes(status ?? "")) {
      return (
        <>
          {status === "cancelled" ? (
            <MyoxusText component="p" tone="secondary">
              {t["com.myoxus.workspace-import.cancelled"]()}
            </MyoxusText>
          ) : (
            <SettingsNotice tone="error">{errorText}</SettingsNotice>
          )}
          <DialogFooterActions>
            <Button variant="primary" onClick={() => void startOver()}>
              {t["com.myoxus.workspace-import.start-over"]()}
            </Button>
          </DialogFooterActions>
        </>
      );
    }

    return (
      <ImportProgressStatus
        ariaLabel={t["com.myoxus.workspace-import.progress"]()}
        label={t["com.myoxus.workspace-import.previewing"]()}
        value={serverProgress}
      />
    );
  }, [
    apply,
    acceptedChanges,
    cancel,
    cancelImport.isMutating,
    close,
    diagnosticText,
    diagnosticTitle,
    errorText,
    formatText,
    handleOperation,
    importId,
    importSource,
    localError,
    localPhase,
    localProgress,
    mutateStatus,
    openImportedWorkspace,
    operationBusy,
    preview,
    previewImport.isMutating,
    queuePreview,
    queryError,
    record?.cancelRequested,
    record?.queuedOperation,
    requiresChangeConfirmation,
    resumeUpload,
    selectFile,
    serverProgress,
    startOver,
    status,
    t,
  ]);

  return (
    <Modal
      open={open}
      title={t["com.myoxus.cmdk.import-workspace"]()}
      onOpenChange={(open) => {
        if (!open && !localBusy) setOpen(false);
      }}
      onEscape={(event) => {
        event.stopPropagation();
        if (!localBusy) setOpen(false);
      }}
      // Preserve the server scope and durable opener through the close transition.
      onExitTransitionEnd={() => close()}
      returnFocusRef={returnFocusRef}
      contentOptions={{
        ["data-testid" as string]: "workspace-import-dialog",
        "aria-label": t["com.myoxus.cmdk.import-workspace"](),
      }}
      persistent={localBusy}
      scrollable
      withoutCloseButton={localBusy}
    >
      <Stack p="lg">
        {importId && localError && !queryError ? (
          <SettingsNotice tone="error">
            {t["com.myoxus.workspace-import.error.generic"]()}
          </SettingsNotice>
        ) : null}
        {content}
      </Stack>
    </Modal>
  );
};
