import { TemplateCheckDialog } from "../../modules/template-doc/view/template-check-dialog";
import { useHistoryNavigation } from "@myoxus/core/modules/doc-versioning/history-navigation";
import {
  DocumentLinksDialog,
  DocumentLinksMenuItem,
} from "@myoxus/core/components/document-links";
import { useGuard } from "@myoxus/core/components/guard";
import { useDocumentOperations } from "@myoxus/core/components/hooks/myoxus/use-document-operations";
import { useEnableServer } from "@myoxus/core/components/hooks/myoxus/use-enable-server";
import { useSystemOnline } from "@myoxus/core/components/hooks/use-system-online";
import { useExportPage } from "@myoxus/core/components/hooks/myoxus/use-export-page";
import { Export, Import, MoveToTrash } from "@myoxus/core/components/page-list";
import { WorkbenchToolsMenuSub } from "@myoxus/core/components/workbench-tools-menu";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { EditorService } from "@myoxus/core/modules/editor";
import { MermaidDiagramsService } from "@myoxus/core/modules/mermaid-diagrams";
import { OpenInAppService } from "@myoxus/core/modules/open-in-app/services";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { ShareMenuContent } from "@myoxus/core/modules/share-menu";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import {
  DuplicateIcon,
  EditIcon,
  HistoryIcon,
  InformationIcon,
  LocalWorkspaceIcon,
  OpenInNewIcon,
  ShareIcon,
  SplitViewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  HeaderMenuButton,
  MenuItem,
  MenuSeparator,
  Modal,
  notify,
  useConfirmModal,
} from "@myoxus/ui-facade";
import type { Store } from "@virgultum/editor/store";
import { type RefObject, useCallback, useRef, useState } from "react";

type PageMenuProps = {
  rename?: () => void;
  page: Store;
  isJournal?: boolean;
};

export const DocumentHeaderMenuButton = ({
  rename,
  page,
  isJournal,
}: PageMenuProps) => {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  const editorService = useService(EditorService);
  const migrateWorkspaceToServer = useEnableServer();
  const isInTrash = useLiveData(
    editorService.editor.doc.meta$.map((meta) => meta.trash),
  );

  const historyNavigation = useHistoryNavigation();
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [checkOpen, setCheckOpen] = useState(false);
  const canRead = useGuard("Doc_Read", page.id);
  const isTemplate = useLiveData(editorService.editor.doc.record.isTemplate$);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [documentLinksDialogOpen, setDocumentLinksDialogOpen] = useState(false);

  const handleMenuOpenChange = useCallback((open: boolean) => {
    setMenuOpen(open);
    if (open) {
      track.$.header.docOptions.open();
    }
  }, []);

  const openHistory = useCallback(() => {
    track.$.header.history.open();
    setMenuOpen(false);
    historyNavigation.open(undefined, menuTriggerRef.current);
  }, [historyNavigation]);

  const openShareDialog = useCallback(() => {
    track.$.sharePanel.$.open();
    setMenuOpen(false);
    setShareDialogOpen(true);
  }, []);

  const openDocumentLinksDialog = useCallback(() => {
    setMenuOpen(false);
    setDocumentLinksDialogOpen(true);
  }, []);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
  }, []);

  if (isInTrash) {
    return null;
  }

  return (
    <>
      <HeaderMenuButton
        ref={menuTriggerRef}
        ariaLabel={t["com.myoxus.common.open-menu"]()}
        data-testid="header-dropDownButton"
        items={
          <>
            {isTemplate ? (
              <MenuItem
                disabled={!canRead}
                onSelect={() => {
                  setMenuOpen(false);
                  setCheckOpen(true);
                }}
                data-testid="template-check-action"
              >
                {t["com.myoxus.template-check.action"]()}
              </MenuItem>
            ) : null}
            <PageHeaderMenuItem
              page={page}
              rename={rename}
              isJournal={isJournal}
              openHistory={openHistory}
              openShareDialog={openShareDialog}
              openDocumentLinksDialog={openDocumentLinksDialog}
              menuOpen={menuOpen}
              showHistory={workspace.flavour !== "local"}
              closeMenu={closeMenu}
              returnFocusRef={menuTriggerRef}
            />
          </>
        }
        open={menuOpen}
        onOpenChange={handleMenuOpenChange}
      />
      <TemplateCheckDialog
        sourceDocId={page.id}
        open={checkOpen}
        onOpenChange={setCheckOpen}
        returnFocusRef={menuTriggerRef}
      />
      <Modal
        contentOptions={{
          "data-testid": "document-share-dialog",
        }}
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        title={t["com.myoxus.share-menu.shareButton"]()}
        width="lg"
      >
        <ShareMenuContent
          workspaceMetadata={workspace.meta}
          currentPage={page}
          onEnableServer={() =>
            migrateWorkspaceToServer(workspace, {
              openPageId: page.id,
            })
          }
        />
      </Modal>
      <DocumentLinksDialog
        open={documentLinksDialogOpen}
        onOpenChange={setDocumentLinksDialogOpen}
        returnFocusRef={menuTriggerRef}
      />
    </>
  );
};

// fixme: refactor this file
const PageHeaderMenuItem = ({
  rename,
  page,
  isJournal,
  openHistory,
  openShareDialog,
  openDocumentLinksDialog,
  menuOpen,
  showHistory,
  closeMenu,
  returnFocusRef,
}: PageMenuProps & {
  openHistory: () => void;
  openShareDialog: () => void;
  openDocumentLinksDialog: () => void;
  menuOpen: boolean;
  showHistory: boolean;
  closeMenu: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) => {
  const pageId = page?.id;
  const t = useI18n();

  const workspace = useService(WorkspaceService).workspace;
  const guardService = useService(GuardService);
  const editorService = useService(EditorService);
  const currentMode = useLiveData(editorService.editor.mode$);
  const owningServer = useLiveData(useService(WorkspaceServerService).server$);
  const online = useSystemOnline();
  const canReadSource = useGuard("Doc_Read", page.id);
  const docxUnavailableReason =
    workspace.flavour === "local" || !owningServer || !online
      ? t["com.myoxus.export.word.unavailable"]()
      : canReadSource === false
        ? t["com.myoxus.no-permission"]()
        : undefined;
  const workbench = useService(WorkbenchService).workbench;
  const mermaidDiagramsService = useService(MermaidDiagramsService);
  const isMermaidDiagram = useLiveData(
    mermaidDiagramsService.isDiagramDoc$(page.id),
  );

  const openInAppService = useServiceOptional(OpenInAppService);

  const { duplicate, moveToTrash } = useDocumentOperations();

  const workspaceDialogService = useService(WorkspaceDialogService);
  const openInfoModal = useCallback(() => {
    closeMenu();
    track.$.header.pageInfo.open();
    workspaceDialogService.open("doc-info", { docId: pageId, returnFocusRef });
  }, [closeMenu, workspaceDialogService, pageId, returnFocusRef]);

  const handleOpenInNewTab = useCallback(() => {
    workbench.openDoc(pageId, {
      at: "new-tab",
    });
  }, [pageId, workbench]);

  const handleOpenInSplitView = useCallback(() => {
    workbench.openDoc(pageId, {
      at: "tail",
    });
  }, [pageId, workbench]);

  const { openConfirmModal } = useConfirmModal();

  const handleOpenTrashModal = useCallback(() => {
    track.$.header.docOptions.deleteDoc();
    openConfirmModal({
      title: t["com.myoxus.moveToTrash.confirmModal.title"](),
      description: t["com.myoxus.moveToTrash.confirmModal.description"]({
        title: editorService.editor.doc.title$.value || t["Untitled"](),
      }),
      cancelText: t["com.myoxus.confirmModal.button.cancel"](),
      confirmText: t.Delete(),
      confirmButtonOptions: {
        variant: "error",
      },
      onConfirm: async () => {
        const canTrash = await guardService.can("Doc_Trash", pageId);
        if (!canTrash) {
          notify({ title: t["com.myoxus.no-permission"]() });
          return;
        }
        await moveToTrash(pageId);
      },
    });
  }, [
    editorService.editor.doc,
    guardService,
    moveToTrash,
    openConfirmModal,
    pageId,
    t,
  ]);

  const handleRename = useCallback(() => {
    rename?.();
    track.$.header.docOptions.renameDoc();
  }, [rename]);

  const exportHandler = useExportPage(returnFocusRef);

  const handleDuplicate = useCallback(() => {
    duplicate(pageId);
    track.$.header.docOptions.createDoc({
      control: "duplicate",
    });
  }, [duplicate, pageId]);

  const handleOpenDocs = useCallback(
    (result: {
      docIds: string[];
      entryId?: string;
      isWorkspaceFile?: boolean;
    }) => {
      const { docIds, entryId, isWorkspaceFile } = result;
      // If the imported file is a workspace file, open the entry page.
      if (isWorkspaceFile && entryId) {
        workbench.openDoc(entryId);
      } else if (!docIds.length) {
        return;
      }
      // Open all the docs when there are multiple docs imported.
      if (docIds.length > 1) {
        workbench.openAll();
      } else {
        // Otherwise, open the only doc.
        workbench.openDoc(docIds[0]);
      }
    },
    [workbench],
  );

  const onOpenInDesktop = useCallback(() => {
    openInAppService?.showOpenInAppPage();
  }, [openInAppService]);

  const canEdit = useGuard("Doc_Update", pageId);
  const canMoveToTrash = useGuard("Doc_Trash", pageId);

  return (
    <>
      <MenuItem
        prefixIcon={<ShareIcon />}
        data-testid="editor-option-menu-share"
        onSelect={openShareDialog}
      >
        {t["com.myoxus.share-menu.shareButton"]()}
      </MenuItem>
      <MenuSeparator />
      {!isJournal && rename ? (
        <>
          <MenuItem
            prefixIcon={<EditIcon />}
            data-testid="editor-option-menu-rename"
            onSelect={handleRename}
            disabled={!canEdit}
          >
            {t["Rename"]()}
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuItem
        prefixIcon={<OpenInNewIcon />}
        data-testid="editor-option-menu-open-in-new-tab"
        onSelect={handleOpenInNewTab}
      >
        {t["com.myoxus.workbench.tab.page-menu-open"]()}
      </MenuItem>
      {BUILD_CONFIG.isElectron && (
        <MenuItem
          prefixIcon={<SplitViewIcon />}
          data-testid="editor-option-menu-open-in-split-new"
          onSelect={handleOpenInSplitView}
        >
          {t["com.myoxus.workbench.split-view.page-menu-open"]()}
        </MenuItem>
      )}

      <MenuSeparator />
      <MenuItem
        prefixIcon={<InformationIcon />}
        data-testid="editor-option-menu-info"
        onSelect={openInfoModal}
      >
        {t["com.myoxus.page-properties.page-info.view"]()}
      </MenuItem>
      <DocumentLinksMenuItem
        visible={menuOpen}
        onSelect={openDocumentLinksDialog}
      />
      <WorkbenchToolsMenuSub />
      {showHistory ? (
        <MenuItem
          prefixIcon={<HistoryIcon />}
          data-testid="editor-option-menu-history"
          onSelect={openHistory}
        >
          {t["com.myoxus.history.version-history"]()}
        </MenuItem>
      ) : null}
      <MenuSeparator />
      {!isJournal && (
        <MenuItem
          prefixIcon={<DuplicateIcon />}
          data-testid="editor-option-menu-duplicate"
          onSelect={handleDuplicate}
        >
          {t["com.myoxus.header.option.duplicate"]()}
        </MenuItem>
      )}
      <Import onComplete={handleOpenDocs} returnFocusRef={returnFocusRef} />
      <Export
        exportHandler={exportHandler}
        pageMode={currentMode}
        isMermaidDiagram={isMermaidDiagram}
        docxUnavailableReason={docxUnavailableReason}
      />
      <MenuSeparator />
      <MoveToTrash
        data-testid="editor-option-menu-delete"
        onSelect={handleOpenTrashModal}
        disabled={!canMoveToTrash}
      />
      {BUILD_CONFIG.isWeb && workspace.flavour !== "local" ? (
        <MenuItem
          prefixIcon={<LocalWorkspaceIcon />}
          data-testid="editor-option-menu-link"
          onSelect={onOpenInDesktop}
        >
          {t["com.myoxus.header.option.open-in-desktop"]()}
        </MenuItem>
      ) : null}
    </>
  );
};
