// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
import { Modal, SettingsNotice, Stack } from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PollingStep, QueryErrorStep, TerminalStatusStep } from "./apply-step";
import {
  getWorkspaceImportDiagnosticText,
  workspaceImportRequiresConfirmation,
} from "./diagnostics";
import { PreviewStep } from "./preview-step";
import {
  type WorkspaceImportUploadRecovery,
  workspaceImportSessionStore,
} from "./session-store";
import {
  ImportProgressStatus,
  type LocalUploadPhase,
  LocalUploadProgressStep,
  StagedRecoveryStep,
  UploadStep,
  type WorkspaceImportSource,
} from "./upload-step";
import {
  isWorkspaceImportPollingStatus,
  prepareWorkspaceImport,
  uploadWorkspaceImportParts,
  WORKSPACE_IMPORT_PART_BYTES,
  workspaceImportProgress,
} from "./workspace-import";

// Keep historical archive extensions here so active-path contracts and user
// archive pickers accept existing backup formats.
const WORKSPACE_IMPORT_ACCEPT =
  ".affine,.affine.zip,.bs.zip,.zip,.db,.myoxus,application/zip,application/x-sqlite3";

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export const ImportWorkspaceDialog = ({
  close,
  returnFocusRef,
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["import-workspace"]>) => {
  const t = useI18n();
  const workspacesService = useService(WorkspacesService);

  const [open, setOpen] = useState(true);
  const [importId, setImportId] = useState<string | null>(
    () => workspaceImportSessionStore.get()?.importId ?? null,
  );
  const [localPhase, setLocalPhase] = useState<LocalUploadPhase>("idle");
  const [localProgress, setLocalProgress] = useState(0);
  const [localError, setLocalError] = useState(false);
  const [importSource, setImportSource] =
    useState<WorkspaceImportSource>("workspace-backup");
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
    { mutation: previewWorkspaceImportMutation },
    { suppressErrorNotification: true },
  );
  const applyImport = useMutation(
    { mutation: applyWorkspaceImportMutation },
    { suppressErrorNotification: true },
  );
  const cancelImport = useMutation(
    { mutation: cancelWorkspaceImportMutation },
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

  const requiresConfirmation = useMemo(
    () => workspaceImportRequiresConfirmation(preview),
    [preview],
  );

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

  useEffect(() => () => abortRef.current?.abort(), []);

  const updateStatus = useCallback(
    async (next: WorkspaceImportProjectionFragment) => {
      await mutateStatus({ workspaceImport: next }, { revalidate: false });
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
    async (recovery: WorkspaceImportUploadRecovery) => {
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
      workspaceImportSessionStore.clearUpload(recovery.importId);
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

        const recovery: WorkspaceImportUploadRecovery = {
          file,
          importId: upload.workspaceImportId,
          prepared,
          signedParts: upload.parts,
        };
        workspaceImportSessionStore.set({
          importId: upload.workspaceImportId,
          upload: recovery,
        });
        setImportId(upload.workspaceImportId);
        await uploadPrepared(recovery);
      } catch (error) {
        if (isAbortError(error)) return;
        console.error("Workspace import upload failed", error);
        setLocalPhase("idle");
        setLocalError(true);
      }
    },
    [createUpload, importSource, uploadPrepared],
  );

  const resumeUpload = useCallback(async () => {
    const recovery = workspaceImportSessionStore.get()?.upload;
    if (!recovery) return;
    try {
      await uploadPrepared(recovery);
    } catch (error) {
      if (isAbortError(error)) return;
      console.error("Workspace import upload resume failed", error);
      setLocalPhase("idle");
      setLocalError(true);
    }
  }, [uploadPrepared]);

  const startOver = useCallback(async () => {
    abortRef.current?.abort();
    if (importId && status && !TERMINAL_STATUSES.has(status)) {
      try {
        await cancelImport.trigger({ workspaceImportId: importId });
      } catch {
        // Keep the server job active if cancellation was rejected.
        setLocalError(true);
        return;
      }
    }
    workspaceImportSessionStore.clear();
    setImportId(null);
    setLocalError(false);
    setLocalPhase("idle");
    setLocalProgress(0);
    setAcceptedChanges(false);
  }, [cancelImport, importId, status]);

  const runOperation = useCallback(
    async (operation: () => Promise<unknown>) => {
      setLocalError(false);
      try {
        await operation();
      } catch {
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
    workspaceImportSessionStore.clear();
    close({ workspace });
  }, [close, record?.targetWorkspaceId, workspacesService]);

  const errorText = record?.errorCode
    ? getWorkspaceImportDiagnosticText(t, record.errorCode)
    : t["com.myoxus.workspace-import.error.generic"]();
  const serverProgress = workspaceImportProgress(
    record?.progressCurrent ?? 0,
    record?.progressTotal ?? 0,
  );

  const renderBody = () => {
    if (localPhase !== "idle") {
      return (
        <LocalUploadProgressStep
          phase={localPhase}
          progress={localProgress}
          onCancel={() => void startOver()}
        />
      );
    }

    if (!importId) {
      return (
        <UploadStep
          accept={WORKSPACE_IMPORT_ACCEPT}
          source={importSource}
          hasError={localError}
          onSourceChange={setImportSource}
          onSelectFile={(file) => void selectFile(file)}
        />
      );
    }

    if (queryError) {
      return (
        <QueryErrorStep
          errorText={errorText}
          onRetry={() => void runOperation(() => mutateStatus())}
          onStartOver={() => void startOver()}
        />
      );
    }

    if (status === "staged") {
      return (
        <StagedRecoveryStep
          canResumeUpload={Boolean(workspaceImportSessionStore.get()?.upload)}
          previewBusy={previewImport.isMutating}
          onStartOver={() => void startOver()}
          onResumeUpload={() => void resumeUpload()}
          onRetryPreview={() => void runOperation(() => queuePreview(importId))}
        />
      );
    }

    if (isWorkspaceImportPollingStatus(status)) {
      return (
        <PollingStep
          isApplying={record?.queuedOperation === "apply"}
          progress={serverProgress}
          cancelDisabled={
            cancelImport.isMutating || Boolean(record?.cancelRequested)
          }
          onCancel={() => void runOperation(cancel)}
        />
      );
    }

    if (status === "previewed" && preview) {
      return (
        <PreviewStep
          preview={preview}
          requiresConfirmation={requiresConfirmation}
          acceptedChanges={acceptedChanges}
          busy={operationBusy}
          onAcceptedChangesChange={setAcceptedChanges}
          onStartOver={() => void startOver()}
          onApply={() => void runOperation(apply)}
        />
      );
    }

    if (
      status === "succeeded" ||
      status === "cleanup_required" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "expired"
    ) {
      return (
        <TerminalStatusStep
          status={status}
          errorText={errorText}
          onOpenWorkspace={() => void runOperation(openImportedWorkspace)}
          onClose={() => setOpen(false)}
          onStartOver={() => void startOver()}
        />
      );
    }

    return (
      <ImportProgressStatus
        ariaLabel={t["com.myoxus.workspace-import.progress"]()}
        label={t["com.myoxus.workspace-import.previewing"]()}
        value={serverProgress}
      />
    );
  };

  return (
    <Modal
      open={open}
      title={t["com.myoxus.cmdk.import-workspace"]()}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !localBusy) setOpen(false);
      }}
      onEscape={(event) => {
        event.stopPropagation();
        if (!localBusy) setOpen(false);
      }}
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
        {renderBody()}
      </Stack>
    </Modal>
  );
};
