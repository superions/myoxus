import { IsFavoriteIcon } from "@myoxus/core/components/pure/icons";
import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import { CollectionService } from "@myoxus/core/modules/collection";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  FilterIcon,
  OpenInNewIcon,
  PlusIcon,
  SplitViewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  MenuItem,
  MenuSeparator,
  StructureTreeActionButton,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import type { NodeOperation } from "../../tree/types";

export const useStructureTreeCollectionNodeOperations = (
  collectionId: string,
  onOpenCollapsed: () => void,
  onOpenEdit: () => void,
): NodeOperation[] => {
  const t = useI18n();
  const {
    workbenchService,
    workspaceService,
    collectionService,
    compatibleFavoriteItemsAdapter,
  } = useServices({
    WorkbenchService,
    WorkspaceService,
    CollectionService,
    CompatibleFavoriteItemsAdapter,
  });

  const { createPage } = usePageHelper(
    workspaceService.workspace.docCollection,
  );

  const favorite = useLiveData(
    useMemo(
      () =>
        compatibleFavoriteItemsAdapter.isFavorite$(collectionId, "collection"),
      [collectionId, compatibleFavoriteItemsAdapter],
    ),
  );
  const { openConfirmModal } = useConfirmModal();

  const createAndAddDocument = useCallback(() => {
    const newDoc = createPage();
    collectionService.addDocToCollection(collectionId, newDoc.id);
    track.$.navigationPanel.collections.createDoc();
    track.$.navigationPanel.collections.addDocToCollection({
      control: "button",
    });
    onOpenCollapsed();
  }, [collectionId, collectionService, createPage, onOpenCollapsed]);

  const handleToggleFavoriteCollection = useCallback(() => {
    compatibleFavoriteItemsAdapter.toggle(collectionId, "collection");
    track.$.navigationPanel.organize.toggleFavorite({
      type: "collection",
    });
  }, [compatibleFavoriteItemsAdapter, collectionId]);

  const handleAddDocToCollection = useCallback(() => {
    openConfirmModal({
      title: t["com.myoxus.collection.add-doc.confirm.title"](),
      description: t["com.myoxus.collection.add-doc.confirm.description"](),
      cancelText: t["Cancel"](),
      confirmText: t["Confirm"](),
      confirmButtonOptions: {
        variant: "primary",
      },
      onConfirm: createAndAddDocument,
    });
  }, [createAndAddDocument, openConfirmModal, t]);

  const handleOpenInSplitView = useCallback(() => {
    workbenchService.workbench.openCollection(collectionId, { at: "beside" });
    track.$.navigationPanel.organize.openInSplitView({
      type: "collection",
    });
  }, [collectionId, workbenchService.workbench]);

  const handleOpenInNewTab = useCallback(() => {
    workbenchService.workbench.openCollection(collectionId, { at: "new-tab" });
    track.$.navigationPanel.organize.openInNewTab({ type: "collection" });
  }, [collectionId, workbenchService.workbench]);

  const handleDeleteCollection = useCallback(() => {
    collectionService.deleteCollection(collectionId);
    track.$.navigationPanel.organize.deleteOrganizeItem({
      type: "collection",
    });
  }, [collectionId, collectionService]);

  const handleShowEdit = useCallback(() => {
    onOpenEdit();
    track.$.navigationPanel.collections.editCollection();
  }, [onOpenEdit]);

  return useMemo(
    () => [
      {
        index: 0,
        inline: true,
        view: (
          <StructureTreeActionButton
            data-testid="collection-add-doc-button"
            onClick={handleAddDocToCollection}
            tooltip={t[
              "com.myoxus.rootAppSidebar.explorer.collection-add-tooltip"
            ]()}
          >
            <PlusIcon />
          </StructureTreeActionButton>
        ),
      },
      {
        index: 103,
        view: (
          <MenuItem prefixIcon={<FilterIcon />} onClick={handleShowEdit}>
            {t["com.myoxus.collection.menu.edit"]()}
          </MenuItem>
        ),
      },
      {
        index: 102,
        view: (
          <MenuItem
            prefixIcon={<PlusIcon />}
            onClick={handleAddDocToCollection}
          >
            {t["New Page"]()}
          </MenuItem>
        ),
      },
      {
        index: 101,
        view: (
          <MenuItem
            prefixIcon={<IsFavoriteIcon favorite={favorite} />}
            onClick={handleToggleFavoriteCollection}
          >
            {favorite
              ? t["com.myoxus.favoritePageOperation.remove"]()
              : t["com.myoxus.favoritePageOperation.add"]()}
          </MenuItem>
        ),
      },
      {
        index: 100,
        view: (
          <MenuItem prefixIcon={<OpenInNewIcon />} onClick={handleOpenInNewTab}>
            {t["com.myoxus.workbench.tab.page-menu-open"]()}
          </MenuItem>
        ),
      },
      ...(BUILD_CONFIG.isElectron
        ? [
            {
              index: 99,
              view: (
                <MenuItem
                  prefixIcon={<SplitViewIcon />}
                  onClick={handleOpenInSplitView}
                >
                  {t["com.myoxus.workbench.split-view.page-menu-open"]()}
                </MenuItem>
              ),
            },
          ]
        : []),
      {
        index: 9999,
        view: <MenuSeparator key="menu-separator" />,
      },
      {
        index: 10000,
        view: (
          <MenuItem
            type={"danger"}
            prefixIcon={<DeleteIcon />}
            data-testid="collection-delete-button"
            onClick={handleDeleteCollection}
          >
            {t["Delete"]()}
          </MenuItem>
        ),
      },
    ],
    [
      favorite,
      handleAddDocToCollection,
      handleDeleteCollection,
      handleOpenInNewTab,
      handleOpenInSplitView,
      handleShowEdit,
      handleToggleFavoriteCollection,
      t,
    ],
  );
};
