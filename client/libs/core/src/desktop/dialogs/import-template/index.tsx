// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { useWorkspaceName } from "@myoxus/core/components/hooks/use-workspace-info";
import { WorkspaceSelector } from "@myoxus/core/components/workspace-selector";
import type {
  DialogComponentProps,
  GLOBAL_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import {
  ImportTemplateService,
  TemplateDownloaderService,
} from "@myoxus/core/modules/import-template";
import { AuthService } from "@myoxus/core/modules/server";
import {
  type WorkspaceMetadata,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { AllDocsIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Modal,
  MyoxusText,
  MyoxusTitle,
  SettingsNotice,
  Stack,
  SurfaceListItemIcon,
} from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import { useCallback, useEffect, useState } from "react";

function ImportTemplateDialogContent({
  templateName,
  templateMode,
  snapshotUrl,
  onClose,
}: {
  templateName: string;
  templateMode: DocMode;
  snapshotUrl: string;
  onClose?: () => void;
}) {
  const t = useI18n();
  const session = useService(AuthService).session;
  const workspacesService = useService(WorkspacesService);
  const templateDownloader = useService(TemplateDownloaderService).downloader;
  const importTemplateService = useService(ImportTemplateService);
  const { openPage, jumpToSignIn } = useNavigateHelper();

  const isUnauthenticated = useLiveData(session.status$) === "unauthenticated";
  const isSessionRevalidating = useLiveData(session.isRevalidating$);
  const isDownloading = useLiveData(templateDownloader.isDownloading$);
  const downloadError = useLiveData(templateDownloader.error$);
  const workspaces = useLiveData(workspacesService.list.workspaces$);

  const [importing, setImporting] = useState(false);
  const [importingError, setImportingError] = useState<unknown>(null);
  const [pickedWorkspace, setPickedWorkspace] =
    useState<WorkspaceMetadata | null>(null);

  const selectedWorkspace =
    pickedWorkspace ??
    workspaces.find((workspace) => workspace.flavour !== "local") ??
    workspaces.at(0);
  const selectedWorkspaceName = useWorkspaceName(selectedWorkspace);
  const noWorkspace = workspaces.length === 0;

  useEffect(() => {
    workspacesService.list.revalidate();
  }, [workspacesService]);

  useEffect(() => {
    session.revalidate();
  }, [session]);

  useEffect(() => {
    if (!isSessionRevalidating && isUnauthenticated) {
      jumpToSignIn(
        `/template/import?&name=${templateName}&mode=${templateMode}&snapshotUrl=${snapshotUrl}`,
      );
      onClose?.();
    }
  }, [
    isSessionRevalidating,
    isUnauthenticated,
    jumpToSignIn,
    onClose,
    snapshotUrl,
    templateMode,
    templateName,
  ]);

  useEffect(() => {
    templateDownloader.download({ snapshotUrl });
  }, [snapshotUrl, templateDownloader]);

  const handleCreatedWorkspace = useCallback(
    (payload: { metadata: WorkspaceMetadata; defaultDocId?: string }) => {
      setPickedWorkspace(payload.metadata);
    },
    [],
  );

  const handleImportToSelectedWorkspace = useAsyncCallback(async () => {
    const data = templateDownloader.data$.value;
    if (!data || !selectedWorkspace) return;
    setImporting(true);
    try {
      const docId = await importTemplateService.importToWorkspace(
        selectedWorkspace,
        data,
        templateMode,
      );
      openPage(selectedWorkspace.id, docId);
      onClose?.();
    } catch (error) {
      setImportingError(error);
    } finally {
      setImporting(false);
    }
  }, [
    importTemplateService,
    onClose,
    openPage,
    selectedWorkspace,
    templateDownloader,
    templateMode,
  ]);

  const handleImportToNewWorkspace = useAsyncCallback(async () => {
    const data = templateDownloader.data$.value;
    if (!data) return;
    setImporting(true);
    try {
      const { workspaceId, docId } =
        await importTemplateService.importToNewWorkspace(
          "myoxus-cloud",
          "Workspace",
          data,
        );
      openPage(workspaceId, docId);
      onClose?.();
    } catch (error) {
      setImportingError(error);
    } finally {
      setImporting(false);
    }
  }, [importTemplateService, onClose, openPage, templateDownloader]);

  const disabled = isDownloading || importing || isUnauthenticated;

  return (
    <Stack p="lg" data-myoxus-ui-role="import-template-dialog-content">
      <Stack align="center" data-myoxus-ui-role="import-template-dialog-header">
        <SurfaceListItemIcon size="lg">
          <AllDocsIcon />
        </SurfaceListItemIcon>
        <MyoxusTitle
          order={2}
          textAlign="center"
          typographySlot="section-title"
        >
          {t["com.myoxus.import-template.dialog.createDocWithTemplate"]({
            templateName,
          })}
        </MyoxusTitle>
        {noWorkspace ? (
          <MyoxusText component="p" textAlign="center" tone="secondary">
            A new workspace will be created.
          </MyoxusText>
        ) : (
          <>
            <MyoxusText component="p" textAlign="center" tone="secondary">
              Choose a workspace.
            </MyoxusText>
            <WorkspaceSelector
              workspaceMetadata={selectedWorkspace}
              onSelectWorkspace={setPickedWorkspace}
              onCreatedWorkspace={handleCreatedWorkspace}
              showArrowDownIcon
              disable={disabled}
              menuContentOptions={{ side: "top" }}
            />
          </>
        )}
      </Stack>

      {importingError ? (
        <SettingsNotice tone="error">
          {t["com.myoxus.import-template.dialog.errorImport"]()}
        </SettingsNotice>
      ) : null}

      {downloadError ? (
        <SettingsNotice tone="error">
          {t["com.myoxus.import-template.dialog.errorLoad"]()}
        </SettingsNotice>
      ) : selectedWorkspace ? (
        <Button
          block
          variant={disabled ? "secondary" : "primary"}
          loading={disabled}
          disabled={disabled}
          onClick={handleImportToSelectedWorkspace}
          data-testid="import-template-to-workspace-btn"
        >
          {selectedWorkspaceName
            ? t["com.myoxus.import-template.dialog.createDocToWorkspace"]({
                workspace: selectedWorkspaceName,
              })
            : null}
        </Button>
      ) : (
        <Button
          block
          variant="primary"
          loading={disabled}
          disabled={disabled}
          onClick={handleImportToNewWorkspace}
        >
          {t["com.myoxus.import-template.dialog.createDocToNewWorkspace"]()}
        </Button>
      )}
    </Stack>
  );
}

export const ImportTemplateDialog = ({
  close,
  snapshotUrl,
  templateName,
  templateMode,
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["import-template"]>) => {
  return (
    <Modal
      open
      modal
      persistent
      withoutCloseButton
      onOpenChange={() => close()}
    >
      <ImportTemplateDialogContent
        templateName={templateName}
        templateMode={templateMode}
        snapshotUrl={snapshotUrl}
        onClose={() => close()}
      />
    </Modal>
  );
};
