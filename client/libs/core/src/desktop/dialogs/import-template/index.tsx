import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { useWorkspaceName } from "@myoxus/core/components/hooks/use-workspace-info";
import { WorkspaceSelector } from "@myoxus/core/components/workspace-selector";
import {
  type DialogComponentProps,
  type GLOBAL_DIALOG_SCHEMA,
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

const Dialog = ({
  templateName,
  templateMode,
  snapshotUrl,
  onClose,
}: {
  templateName: string;
  templateMode: DocMode;
  snapshotUrl: string;
  onClose?: () => void;
}) => {
  const t = useI18n();
  const session = useService(AuthService).session;
  const notLogin = useLiveData(session.status$) === "unauthenticated";
  const isSessionRevalidating = useLiveData(session.isRevalidating$);

  const [importing, setImporting] = useState(false);
  const [importingError, setImportingError] = useState<any>(null);
  const workspacesService = useService(WorkspacesService);
  const templateDownloaderService = useService(TemplateDownloaderService);
  const importTemplateService = useService(ImportTemplateService);
  const templateDownloader = templateDownloaderService.downloader;
  const isDownloading = useLiveData(templateDownloader.isDownloading$);
  const downloadError = useLiveData(templateDownloader.error$);
  const workspaces = useLiveData(workspacesService.list.workspaces$);
  const [rawSelectedWorkspace, setSelectedWorkspace] =
    useState<WorkspaceMetadata | null>(null);
  const selectedWorkspace =
    rawSelectedWorkspace ??
    workspaces.find((w) => w.flavour !== "local") ??
    workspaces.at(0);
  const selectedWorkspaceName = useWorkspaceName(selectedWorkspace);
  const { openPage, jumpToSignIn } = useNavigateHelper();

  const noWorkspace = workspaces.length === 0;

  useEffect(() => {
    workspacesService.list.revalidate();
  }, [workspacesService]);

  useEffect(() => {
    session.revalidate();
  }, [session]);

  useEffect(() => {
    if (!isSessionRevalidating && notLogin) {
      jumpToSignIn(
        "/template/import?" +
          "&name=" +
          templateName +
          "&mode=" +
          templateMode +
          "&snapshotUrl=" +
          snapshotUrl,
      );
      onClose?.();
    }
  }, [
    isSessionRevalidating,
    jumpToSignIn,
    notLogin,
    onClose,
    snapshotUrl,
    templateName,
    templateMode,
  ]);

  useEffect(() => {
    templateDownloader.download({ snapshotUrl });
  }, [snapshotUrl, templateDownloader]);

  const handleSelectedWorkspace = useCallback(
    (workspaceMetadata: WorkspaceMetadata) => {
      return setSelectedWorkspace(workspaceMetadata);
    },
    [],
  );

  const handleCreatedWorkspace = useCallback(
    (payload: { metadata: WorkspaceMetadata; defaultDocId?: string }) => {
      return setSelectedWorkspace(payload.metadata);
    },
    [],
  );

  const handleImportToSelectedWorkspace = useAsyncCallback(async () => {
    if (templateDownloader.data$.value && selectedWorkspace) {
      setImporting(true);
      try {
        const docId = await importTemplateService.importToWorkspace(
          selectedWorkspace,
          templateDownloader.data$.value,
          templateMode,
        );
        openPage(selectedWorkspace.id, docId);
        onClose?.();
      } catch (err) {
        setImportingError(err);
      } finally {
        setImporting(false);
      }
    }
  }, [
    importTemplateService,
    onClose,
    openPage,
    selectedWorkspace,
    templateDownloader.data$.value,
    templateMode,
  ]);

  const handleImportToNewWorkspace = useAsyncCallback(async () => {
    if (!templateDownloader.data$.value) {
      return;
    }
    setImporting(true);
    try {
      const { workspaceId, docId } =
        await importTemplateService.importToNewWorkspace(
          // TODO: support selfhosted
          "myoxus-cloud",
          "Workspace",
          templateDownloader.data$.value,
        );
      openPage(workspaceId, docId);
      onClose?.();
    } catch (err) {
      setImportingError(err);
    } finally {
      setImporting(false);
    }
  }, [
    importTemplateService,
    onClose,
    openPage,
    templateDownloader.data$.value,
  ]);

  const disabled = isDownloading || importing || notLogin;

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
              onSelectWorkspace={handleSelectedWorkspace}
              onCreatedWorkspace={handleCreatedWorkspace}
              showArrowDownIcon
              disable={disabled}
              menuContentOptions={{
                side: "top",
              }}
            />
          </>
        )}
      </Stack>
      {importingError && (
        <SettingsNotice tone="error">
          {t["com.myoxus.import-template.dialog.errorImport"]()}
        </SettingsNotice>
      )}
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
          {selectedWorkspaceName &&
            t["com.myoxus.import-template.dialog.createDocToWorkspace"]({
              workspace: selectedWorkspaceName,
            })}
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
};

export const ImportTemplateDialog = ({
  close,
  snapshotUrl,
  templateName,
  templateMode,
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["import-template"]>) => {
  return (
    <Modal
      open
      modal={true}
      persistent
      withoutCloseButton
      onOpenChange={() => close()}
    >
      <Dialog
        templateName={templateName}
        templateMode={templateMode}
        snapshotUrl={snapshotUrl}
        onClose={() => close()}
      />
    </Modal>
  );
};
