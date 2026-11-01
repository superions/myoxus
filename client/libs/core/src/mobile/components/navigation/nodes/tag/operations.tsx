import { IsFavoriteIcon } from "@myoxus/core/components/pure/icons";
import type { NodeOperation } from "@myoxus/core/components/structure-tree";
import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocsService } from "@myoxus/core/modules/doc";
import { FavoriteService } from "@myoxus/core/modules/favorite";
import { GlobalCacheService } from "@myoxus/core/modules/storage";
import { TagService } from "@myoxus/core/modules/tag";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import {
  ArchiveIcon,
  FolderIcon,
  PlusIcon,
  SplitViewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  IconButton,
  MenuItem,
  MenuSeparator,
  notify,
  type TagColorRole,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import { TagRenameSubMenu } from "./dialog";

export const useStructureTreeTagNodeOperations = (
  tagId: string,
  {
    openNodeCollapsed,
  }: {
    openNodeCollapsed: () => void;
  },
) => {
  const t = useI18n();
  const {
    workbenchService,
    workspaceService,
    tagService,
    favoriteService,
    workspaceDialogService,
    globalCacheService,
  } = useServices({
    WorkbenchService,
    WorkspaceService,
    TagService,
    DocsService,
    FavoriteService,
    WorkspaceDialogService,
    GlobalCacheService,
  });
  const { openConfirmModal } = useConfirmModal();

  const favorite = useLiveData(
    favoriteService.favoriteList.favorite$("tag", tagId),
  );
  const tagRecord = useLiveData(tagService.tagList.tagByTagId$(tagId));

  const { createPage } = usePageHelper(
    workspaceService.workspace.docCollection,
  );

  const handleNewDoc = useCallback(async () => {
    if (tagRecord) {
      const newDoc = createPage();
      try {
        await tagRecord.tag(newDoc.id);
        track.$.navigationPanel.tags.createDoc();
        openNodeCollapsed();
      } catch {
        notify.error({ title: t["com.myoxus.common.operation-failed"]() });
      }
    }
  }, [createPage, openNodeCollapsed, t, tagRecord]);

  const handleMoveToTrash = useCallback(async () => {
    try {
      await tagService.tagList.archiveTag(tagId);
      track.$.navigationPanel.organize.deleteOrganizeItem({ type: "tag" });
      notify({ title: t["com.myoxus.tags.status.archived"]() });
    } catch {
      notify.error({ title: t["com.myoxus.common.operation-failed"]() });
    }
  }, [t, tagId, tagService.tagList]);

  const handleOpenInSplitView = useCallback(() => {
    workbenchService.workbench.openTag(tagId, {
      at: "beside",
    });
    track.$.navigationPanel.organize.openInSplitView({ type: "tag" });
  }, [tagId, workbenchService]);

  const handleToggleFavoriteTag = useCallback(() => {
    favoriteService.favoriteList.toggle("tag", tagId);
    track.$.navigationPanel.organize.toggleFavorite({
      type: "tag",
    });
  }, [favoriteService, tagId]);

  const handleOpenInNewTab = useCallback(() => {
    workbenchService.workbench.openTag(tagId, {
      at: "new-tab",
    });
    track.$.navigationPanel.organize.openInNewTab({ type: "tag" });
  }, [tagId, workbenchService]);

  const handleRename = useCallback(
    async (newName: string) => {
      if (tagRecord && tagRecord.value$.value !== newName) {
        try {
          await tagRecord.rename(newName);
          track.$.navigationPanel.organize.renameOrganizeItem({
            type: "tag",
          });
        } catch {
          notify.error({ title: t["com.myoxus.common.operation-failed"]() });
        }
      }
    },
    [t, tagRecord],
  );
  const handleChangeColor = useCallback(
    async (color: TagColorRole) => {
      if (tagRecord && tagRecord.color$.value !== color) {
        try {
          await tagRecord.changeColor(color);
        } catch {
          notify.error({ title: t["com.myoxus.common.operation-failed"]() });
        }
      }
    },
    [t, tagRecord],
  );
  const handleChangeNameOrColor = useCallback(
    async (name?: string, color?: TagColorRole) => {
      if (name !== undefined) {
        await handleRename(name);
      }
      if (color !== undefined) {
        await handleChangeColor(color);
      }
    },
    [handleChangeColor, handleRename],
  );
  const handleOpenDocSelector = useCallback(() => {
    const initialIds = tagRecord?.pageIds$.value;
    workspaceDialogService.open(
      "doc-selector",
      {
        init: initialIds ?? [],
        onBeforeConfirm(ids, cb) {
          const hasRemoved = initialIds?.some((id) => !ids?.includes(id));
          if (
            hasRemoved &&
            globalCacheService.globalCache.get(
              "mobile:tags:will-be-removed-warning-read",
            ) !== true
          ) {
            openConfirmModal({
              title: t["com.myoxus.m.selector.remove-warning.title"](),
              description: t["com.myoxus.m.selector.remove-warning.message"]({
                type: t["com.myoxus.m.selector.type-doc"](),
                where: t["com.myoxus.m.selector.where-tag"](),
              }),
              cancelText: t["com.myoxus.m.selector.remove-warning.cancel"](),
              confirmText: t["com.myoxus.m.selector.remove-warning.confirm"](),
              reverseFooter: true,
              onConfirm: () => {
                globalCacheService.globalCache.set(
                  "mobile:tags:will-be-removed-warning-read",
                  true,
                );
                cb();
              },
            });
          } else {
            cb();
          }
        },
      },
      async (selectedIds) => {
        if (selectedIds === undefined) {
          return;
        }
        const newIds = selectedIds.filter((id) => !initialIds?.includes(id));
        const removedIds = initialIds?.filter(
          (id) => !selectedIds.includes(id),
        );
        try {
          await Promise.all([
            ...newIds.map((id) => tagRecord?.tag(id)),
            ...(removedIds ?? []).map((id) => tagRecord?.untag(id)),
          ]);
        } catch {
          notify.error({ title: t["com.myoxus.common.operation-failed"]() });
        }
      },
    );
  }, [
    tagRecord,
    workspaceDialogService,
    globalCacheService.globalCache,
    openConfirmModal,
    t,
  ]);

  return useMemo(
    () => ({
      favorite,
      handleNewDoc,
      handleMoveToTrash,
      handleOpenInSplitView,
      handleToggleFavoriteTag,
      handleOpenInNewTab,
      handleRename,
      handleChangeColor,
      handleChangeNameOrColor,
      handleOpenDocSelector,
    }),
    [
      favorite,
      handleChangeColor,
      handleChangeNameOrColor,
      handleMoveToTrash,
      handleNewDoc,
      handleOpenInNewTab,
      handleOpenInSplitView,
      handleRename,
      handleToggleFavoriteTag,
      handleOpenDocSelector,
    ],
  );
};
export const useStructureTreeTagNodeOperationsMenu = (
  tagId: string,
  option: {
    openNodeCollapsed: () => void;
  },
): NodeOperation[] => {
  const t = useI18n();
  const {
    favorite,
    handleNewDoc,
    handleMoveToTrash,
    handleOpenInSplitView,
    handleToggleFavoriteTag,
    handleChangeNameOrColor,
    handleOpenDocSelector,
  } = useStructureTreeTagNodeOperations(tagId, option);

  return useMemo(
    () => [
      {
        index: 0,
        inline: true,
        view: (
          <IconButton size="16" onClick={handleNewDoc}>
            <PlusIcon />
          </IconButton>
        ),
      },
      {
        index: 10,
        view: (
          <TagRenameSubMenu
            onConfirm={handleChangeNameOrColor}
            tagId={tagId}
            menuProps={{ triggerOptions: { "data-testid": "rename-tag" } }}
          />
        ),
      },
      {
        index: 11,
        view: <MenuSeparator />,
      },
      {
        index: 12,
        view: (
          <MenuItem prefixIcon={<FolderIcon />} onClick={handleOpenDocSelector}>
            {t["com.myoxus.m.explorer.tag.manage-docs"]()}
          </MenuItem>
        ),
      },
      ...(BUILD_CONFIG.isElectron
        ? [
            {
              index: 100,
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
        index: 199,
        view: (
          <MenuItem
            prefixIcon={<IsFavoriteIcon favorite={!!favorite} />}
            onClick={handleToggleFavoriteTag}
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
          <MenuItem prefixIcon={<ArchiveIcon />} onClick={handleMoveToTrash}>
            {t["com.myoxus.tags.archive.action"]()}
          </MenuItem>
        ),
      },
    ],
    [
      favorite,
      handleChangeNameOrColor,
      handleMoveToTrash,
      handleNewDoc,
      handleOpenDocSelector,
      handleOpenInSplitView,
      handleToggleFavoriteTag,
      t,
      tagId,
    ],
  );
};
