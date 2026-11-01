import { Guard } from "@myoxus/core/components/guard";
import { useDocumentOperations } from "@myoxus/core/components/hooks/myoxus/use-document-operations";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { IsFavoriteIcon } from "@myoxus/core/components/pure/icons";
import type { NodeOperation } from "@myoxus/core/components/structure-tree";
import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import { DocsService } from "@myoxus/core/modules/doc";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { preventDefault } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  DuplicateIcon,
  InformationIcon,
  LinkedPageIcon,
  OpenInNewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  MenuItem,
  MenuSeparator,
  MenuSub,
  notify,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import { DocFrameScope, DocInfoSheet } from "../../../doc-info";
import { DocRenameSubMenu } from "./dialog";

export const useStructureTreeDocNodeOperations = (
  docId: string,
  options: {
    openNodeCollapsed: () => void;
  },
) => {
  const t = useI18n();
  const {
    workbenchService,
    workspaceService,
    docsService,
    compatibleFavoriteItemsAdapter,
  } = useServices({
    DocsService,
    WorkbenchService,
    WorkspaceService,
    CompatibleFavoriteItemsAdapter,
  });

  const { openConfirmModal } = useConfirmModal();

  const docRecord = useLiveData(docsService.list.doc$(docId));

  const { createPage } = usePageHelper(
    workspaceService.workspace.docCollection,
  );

  const favorite = useLiveData(
    useMemo(() => {
      return compatibleFavoriteItemsAdapter.isFavorite$(docId, "doc");
    }, [docId, compatibleFavoriteItemsAdapter]),
  );

  const { duplicate } = useDocumentOperations();
  const handleDuplicate = useCallback(() => {
    duplicate(docId, true);
    track.$.navigationPanel.docs.createDoc();
  }, [docId, duplicate]);

  const handleMoveToTrash = useCallback(() => {
    if (!docRecord) {
      return;
    }
    openConfirmModal({
      title: t["com.myoxus.moveToTrash.title"](),
      description: t["com.myoxus.moveToTrash.confirmModal.description"]({
        title: docRecord.title$.value,
      }),
      confirmText: t["com.myoxus.moveToTrash.confirmModal.confirm"](),
      cancelText: t["com.myoxus.moveToTrash.confirmModal.cancel"](),
      confirmButtonOptions: {
        variant: "error",
      },
      onConfirm() {
        docRecord.moveToTrash();
        track.$.navigationPanel.docs.deleteDoc({
          control: "button",
        });
        notify({ title: t["com.myoxus.toastMessage.movedTrash"]() });
      },
    });
  }, [docRecord, openConfirmModal, t]);

  const handleOpenInNewTab = useCallback(() => {
    workbenchService.workbench.openDoc(docId, {
      at: "new-tab",
    });
    track.$.navigationPanel.organize.openInNewTab({
      type: "doc",
    });
  }, [docId, workbenchService]);

  const handleOpenInSplitView = useCallback(() => {
    workbenchService.workbench.openDoc(docId, {
      at: "beside",
    });
    track.$.navigationPanel.organize.openInSplitView({
      type: "doc",
    });
  }, [docId, workbenchService.workbench]);

  const handleAddLinkedPage = useAsyncCallback(async () => {
    const newDoc = createPage();
    // TODO: handle timeout & error
    await docsService.addLinkedDoc(docId, newDoc.id);
    track.$.navigationPanel.docs.createDoc({ control: "linkDoc" });
    track.$.navigationPanel.docs.linkDoc({ control: "createDoc" });
    options.openNodeCollapsed();
  }, [createPage, docId, docsService, options]);

  const handleToggleFavoriteDoc = useCallback(() => {
    compatibleFavoriteItemsAdapter.toggle(docId, "doc");
    track.$.navigationPanel.organize.toggleFavorite({
      type: "doc",
    });
  }, [docId, compatibleFavoriteItemsAdapter]);

  const handleRename = useAsyncCallback(
    async (newName: string) => {
      await docsService.changeDocTitle(docId, newName);
      track.$.navigationPanel.organize.renameOrganizeItem({ type: "doc" });
    },
    [docId, docsService],
  );

  return useMemo(
    () => ({
      favorite,
      handleAddLinkedPage,
      handleDuplicate,
      handleToggleFavoriteDoc,
      handleOpenInSplitView,
      handleOpenInNewTab,
      handleMoveToTrash,
      handleRename,
    }),
    [
      favorite,
      handleAddLinkedPage,
      handleDuplicate,
      handleMoveToTrash,
      handleOpenInNewTab,
      handleOpenInSplitView,
      handleRename,
      handleToggleFavoriteDoc,
    ],
  );
};

export const useStructureTreeDocNodeOperationsMenu = (
  docId: string,
  options: {
    openInfoModal: () => void;
    openNodeCollapsed: () => void;
  },
): NodeOperation[] => {
  const t = useI18n();
  const {
    favorite,
    handleAddLinkedPage,
    handleDuplicate,
    handleToggleFavoriteDoc,
    handleOpenInNewTab,
    handleMoveToTrash,
    handleRename,
  } = useStructureTreeDocNodeOperations(docId, options);

  const docService = useService(DocsService);
  const docRecord = useLiveData(docService.list.doc$(docId));
  const title = useLiveData(docRecord?.title$);

  return useMemo(
    () => [
      {
        index: 10,
        view: (
          <Guard docId={docId} permission="Doc_Update">
            {(canEdit) => (
              <DocRenameSubMenu
                onConfirm={handleRename}
                initialName={title}
                disabled={!canEdit}
              />
            )}
          </Guard>
        ),
      },
      {
        index: 11,
        view: <MenuSeparator />,
      },
      {
        index: 50,
        view: (
          <MenuSub
            triggerOptions={{
              prefixIcon: <InformationIcon />,
              onClick: preventDefault,
            }}
            title={title ?? t["unnamed"]()}
            items={
              <DocFrameScope docId={docId}>
                <DocInfoSheet docId={docId} />
              </DocFrameScope>
            }
          >
            <span>{t["com.myoxus.page-properties.page-info.view"]()}</span>
          </MenuSub>
        ),
      },
      {
        index: 97,
        view: (
          <Guard docId={docId} permission="Doc_Update">
            {(canEdit) => (
              <MenuItem
                prefixIcon={<LinkedPageIcon />}
                onClick={handleAddLinkedPage}
                disabled={!canEdit}
              >
                {t["com.myoxus.page-operation.add-linked-page"]()}
              </MenuItem>
            )}
          </Guard>
        ),
      },
      {
        index: 98,
        view: (
          <MenuItem prefixIcon={<DuplicateIcon />} onClick={handleDuplicate}>
            {t["com.myoxus.header.option.duplicate"]()}
          </MenuItem>
        ),
      },
      {
        index: 99,
        view: (
          <MenuItem prefixIcon={<OpenInNewIcon />} onClick={handleOpenInNewTab}>
            {t["com.myoxus.workbench.tab.page-menu-open"]()}
          </MenuItem>
        ),
      },
      {
        index: 199,
        view: (
          <MenuItem
            prefixIcon={<IsFavoriteIcon favorite={favorite} />}
            onClick={handleToggleFavoriteDoc}
          >
            {favorite
              ? t["com.myoxus.favoritePageOperation.remove"]()
              : t["com.myoxus.favoritePageOperation.add"]()}
          </MenuItem>
        ),
      },
      {
        index: 9999,
        view: <MenuSeparator key="menu-separator" />,
      },
      {
        index: 10000,
        view: (
          <Guard docId={docId} permission="Doc_Trash">
            {(canMoveToTrash) => (
              <MenuItem
                type={"danger"}
                prefixIcon={<DeleteIcon />}
                onClick={handleMoveToTrash}
                disabled={!canMoveToTrash}
              >
                {t["com.myoxus.moveToTrash.title"]()}
              </MenuItem>
            )}
          </Guard>
        ),
      },
    ],
    [
      docId,
      favorite,
      handleAddLinkedPage,
      handleDuplicate,
      handleMoveToTrash,
      handleOpenInNewTab,
      handleRename,
      handleToggleFavoriteDoc,
      t,
      title,
    ],
  );
};
