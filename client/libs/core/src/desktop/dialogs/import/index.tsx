// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import {
  type DialogComponentProps,
  GlobalDialogService,
  type WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { CoreDocEmbedProvider, DocsService } from "@myoxus/core/modules/doc";
import { ExplorerIconService } from "@myoxus/core/modules/explorer-icon/services/explorer-icon";
import { MermaidDiagramsService } from "@myoxus/core/modules/mermaid-diagrams";
import { runBpmnImport } from "@myoxus/core/modules/mermaid-diagrams/services/bpmn-import";
import { OrganizeService } from "@myoxus/core/modules/organize";
import { GuardService } from "@myoxus/core/modules/permissions";
import {
  DefaultServerService,
  GraphQLService,
  WorkspaceServerService,
} from "@myoxus/core/modules/server";
import {
  type WorkspaceMetadata,
  WorkspaceService,
} from "@myoxus/core/modules/workspace";
import { DebugLogger } from "@myoxus/debug";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { Modal, Stack } from "@myoxus/ui-facade";
import { openFilesWith } from "@virgultum/editor/shared/utils";
import { type RefObject, useCallback, useState } from "react";

import {
  DocxImportStatus,
  showDocxImportNotification,
  useOwnedDocxImport,
} from "./docx-result";
import {
  getImportFileOptions,
  type ImportResult,
  type ImportStatus,
  type ImportType,
  runFormatImport,
} from "./handlers";
import { snapshotLabelImportHooks } from "./import-labels";
import {
  BpmnImportStatusView,
  ErrorStatusView,
  ImportingStatusView,
  ImportMenuItems,
  ImportOptionsView,
  SuccessStatus,
} from "./status-views";

export type { ImportResult, ImportStatus, ImportType };
export { ImportMenuItems, SuccessStatus };

const logger = new DebugLogger("import");

type UseWorkspaceImportOptions = {
  returnFocusRef?: RefObject<HTMLElement | null>;
  onComplete?: (result: ImportResult) => void;
  onError?: (error: string | null) => void;
  onStatusChange?: (status: ImportStatus) => void;
  docxPresentation?: "dialog" | "notification";
};

export function useWorkspaceImport({
  returnFocusRef,
  onComplete,
  onError,
  onStatusChange,
  docxPresentation = "notification",
}: UseWorkspaceImportOptions = {}) {
  const workspace = useService(WorkspaceService).workspace;
  const docsService = useService(DocsService);
  const diagramRegistry = useService(MermaidDiagramsService);
  const guardService = useService(GuardService);
  const workspaceServerService = useService(WorkspaceServerService);
  const defaultServerService = useService(DefaultServerService);
  const organizeService = useService(OrganizeService);
  const explorerIconService = useService(ExplorerIconService);
  const globalDialogService = useService(GlobalDialogService);
  const { jumpToPage } = useNavigateHelper();

  const importWord = useOwnedDocxImport({
    onComplete,
    presentation: docxPresentation,
  });

  const navigateToCreatedWorkspace = useCallback(
    (payload: { metadata: WorkspaceMetadata; defaultDocId?: string }) => {
      const target = payload.defaultDocId ?? "home";
      if (document.startViewTransition) {
        document.startViewTransition(() => {
          jumpToPage(payload.metadata.id, target);
          return new Promise((resolve) => setTimeout(resolve, 150));
        });
      } else {
        jumpToPage(payload.metadata.id, target);
      }
    },
    [jumpToPage],
  );

  const handleImportWorkspace = useCallback(async () => {
    track.$.navigationPanel.workspaceList.createWorkspace({
      control: "import",
    });

    return new Promise<WorkspaceMetadata | undefined>((resolve, reject) => {
      globalDialogService.open(
        "import-workspace",
        { returnFocusRef },
        (payload) => {
          if (payload) {
            navigateToCreatedWorkspace({ metadata: payload.workspace });
            resolve(payload.workspace);
          } else {
            reject(new Error("No workspace imported"));
          }
        },
      );
    });
  }, [globalDialogService, navigateToCreatedWorkspace, returnFocusRef]);

  return useAsyncCallback(
    async (type: ImportType, droppedFiles?: File[]) => {
      if (type === "docx") {
        await importWord();
        return;
      }

      onError?.(null);
      const access = new CoreDocEmbedProvider(
        guardService,
        docsService,
        workspace,
      );

      try {
        const { acceptType, multiple } = getImportFileOptions(type);
        const files =
          droppedFiles && droppedFiles.length > 0
            ? multiple
              ? droppedFiles
              : [droppedFiles[0]]
            : acceptType === "Skip"
              ? []
              : await openFilesWith(acceptType, multiple);

        if (!files || (files.length === 0 && acceptType !== "Skip")) {
          onStatusChange?.("idle");
          return;
        }

        if (acceptType !== "Skip") {
          onStatusChange?.("importing");
          track.$.importModal.$.import({ type, status: "importing" });
        }

        const snapshotHooks =
          type === "snapshot" && workspace.flavour !== "local"
            ? await snapshotLabelImportHooks(
                workspace,
                docsService,
                (
                  workspaceServerService.server || defaultServerService.server
                ).scope.get(GraphQLService),
                files[0],
              )
            : undefined;

        const result = await runFormatImport(type, {
          docCollection: workspace.docCollection,
          files,
          handleImportWorkspace,
          organizeService,
          explorerIconService,
          snapshotHooks,
          referenceAccess: access,
          diagramRegistry,
        });

        onComplete?.(result);
        onStatusChange?.("success");
        track.$.importModal.$.import({
          type,
          status: "success",
          result: { docCount: result.docIds.length },
        });
        track.$.importModal.$.createDoc({ control: "import" });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          onStatusChange?.("idle");
          return;
        }
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        onError?.(message);
        onStatusChange?.("error");
        track.$.importModal.$.import({
          type,
          status: "failed",
          error: message || undefined,
        });
        logger.error("Failed to import", error);
      } finally {
        access.dispose();
      }
    },
    [
      defaultServerService,
      diagramRegistry,
      docsService,
      explorerIconService,
      guardService,
      handleImportWorkspace,
      importWord,
      onComplete,
      onError,
      onStatusChange,
      organizeService,
      workspace,
      workspaceServerService,
    ],
  );
}

/**
 * Workspace content import modal for BPMN, Mermaid, Markdown, HTML, DOCX,
 * document snapshots, and workspace backups.
 */
export const ImportDialog = ({
  close,
  bpmnImport,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["import"]>) => {
  const t = useI18n();
  const diagramRegistry = useService(MermaidDiagramsService);
  const docsService = useService(DocsService);
  const wordAttempt = useLiveData(docsService.docxImport$);
  const { jumpToPage } = useNavigateHelper();

  const [status, setStatus] = useState<ImportStatus>(
    bpmnImport ? "success" : "idle",
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(
    bpmnImport ? { docIds: bpmnImport.docIds, bpmn: bpmnImport } : null,
  );
  const [wordActive, setWordActive] = useState(
    wordAttempt?.status === "selecting" || wordAttempt?.status === "importing",
  );

  const handleImport = useWorkspaceImport({
    docxPresentation: "dialog",
    onComplete: setImportResult,
    onError: setImportError,
    onStatusChange: (nextStatus) => {
      if (nextStatus === "importing") setImportResult(null);
      setStatus(nextStatus);
    },
  });

  const handleComplete = useCallback(() => {
    close(importResult || undefined);
  }, [close, importResult]);

  const handleRetry = useCallback(() => {
    setWordActive(false);
    setImportResult(null);
    setStatus("idle");
  }, []);

  const handleRetryBpmn = useCallback(async () => {
    if (!importResult?.bpmn) return;
    setStatus("importing");
    try {
      const bpmn = await runBpmnImport(diagramRegistry, importResult.bpmn);
      setImportResult({ docIds: bpmn.docIds, bpmn });
    } finally {
      setStatus("success");
    }
  }, [diagramRegistry, importResult?.bpmn]);

  const renderContent = () => {
    if (wordActive && wordAttempt) {
      return (
        <DocxImportStatus
          attempt={wordAttempt}
          onOpen={() => {
            if (wordAttempt.status !== "complete") return;
            close({ docIds: [wordAttempt.id] });
            jumpToPage(wordAttempt.workspaceId, wordAttempt.id);
          }}
          onInspect={() => {
            close();
            jumpToPage(wordAttempt.workspaceId, "all");
            showDocxImportNotification(docsService, jumpToPage);
          }}
          onSelect={() => {
            void handleImport("docx");
          }}
        />
      );
    }

    switch (status) {
      case "idle":
        return (
          <ImportOptionsView
            onImport={(type, droppedFiles) => {
              setWordActive(type === "docx");
              return handleImport(type, droppedFiles);
            }}
          />
        );
      case "importing":
        return <ImportingStatusView />;
      case "success":
        return importResult?.bpmn ? (
          <BpmnImportStatusView
            result={importResult.bpmn}
            registry={diagramRegistry}
            onComplete={handleComplete}
            onRetry={handleRetryBpmn}
          />
        ) : (
          <SuccessStatus onComplete={handleComplete} result={importResult} />
        );
      case "error":
        return <ErrorStatusView error={importError} onRetry={handleRetry} />;
    }
  };

  const lockClose = !wordActive && status === "importing";

  return (
    <Modal
      open
      onOpenChange={(nextOpen: boolean) => {
        if (nextOpen) return;
        if (wordActive && docsService.docxImport$.value) {
          showDocxImportNotification(docsService, jumpToPage);
          close();
          return;
        }
        close(importResult || undefined);
      }}
      contentOptions={{
        ["data-testid" as string]: "import-modal",
        "aria-label": t["Import"](),
      }}
      withoutCloseButton={lockClose}
      persistent={lockClose}
    >
      <Stack
        p="lg"
        data-myoxus-ui-role="import-dialog-content"
        data-testid="import-dialog"
      >
        {renderContent()}
      </Stack>
    </Modal>
  );
};
