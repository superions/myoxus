import { IsFavoriteIcon } from "@myoxus/core/components/pure/icons";
import { useWorkspaceTagCommands } from "@myoxus/core/components/tags";
import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import { DocsService } from "@myoxus/core/modules/doc";
import { FavoriteService } from "@myoxus/core/modules/favorite";
import { TagService } from "@myoxus/core/modules/tag";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { WorkspaceContentResourceKindType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  ArchiveIcon,
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
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import { WorkspaceContentOperationMenuItems } from "../../../workspace-content-operation/menu-items";
import type { NodeOperation } from "../../tree/types";

export const useStructureTreeTagNodeOperations = (
  tagId: string,
  {
    openNodeCollapsed,
  }: {
    openNodeCollapsed: () => void;
  },
): NodeOperation[] => {
  const t = useI18n();
  const commands = useWorkspaceTagCommands();
  const { workbenchService, workspaceService, tagService, favoriteService } =
    useServices({
      WorkbenchService,
      WorkspaceService,
      TagService,
      DocsService,
      FavoriteService,
    });

  const favorite = useLiveData(
    favoriteService.favoriteList.favorite$("tag", tagId),
  );
  const tagRecord = useLiveData(tagService.tagList.tagByTagId$(tagId));
  const tagArchived = useLiveData(tagRecord?.archived$);
  const catalogState = useLiveData(tagService.tagList.catalogState$);
  const writable = catalogState.status === "ready" && !tagArchived;

  const { createPage } = usePageHelper(
    workspaceService.workspace.docCollection,
  );

  const handleNewDoc = useCallback(async () => {
    if (tagRecord && writable) {
      const newDoc = createPage();
      try {
        await tagRecord.tag(newDoc.id);
        track.$.navigationPanel.tags.createDoc();
        openNodeCollapsed();
      } catch (error) {
        commands.reportError(error);
      }
    }
  }, [commands, createPage, openNodeCollapsed, tagRecord, writable]);

  const handleArchive = useCallback(async () => {
    if (!writable) {
      return;
    }
    if (await commands.archiveTags([tagId])) {
      track.$.navigationPanel.organize.deleteOrganizeItem({ type: "tag" });
    }
  }, [commands, tagId, writable]);

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

  return useMemo(
    () => [
      ...(writable
        ? [
            {
              index: 0,
              inline: true,
              view: (
                <StructureTreeActionButton
                  onClick={handleNewDoc}
                  data-testid="tag-add-doc-button"
                  tooltip={t[
                    "com.myoxus.rootAppSidebar.explorer.tag-add-tooltip"
                  ]()}
                >
                  <PlusIcon />
                </StructureTreeActionButton>
              ),
            },
          ]
        : []),
      {
        index: 50,
        view: (
          <MenuItem prefixIcon={<OpenInNewIcon />} onClick={handleOpenInNewTab}>
            {t["com.myoxus.workbench.tab.page-menu-open"]()}
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
        index: 500,
        view: (
          <WorkspaceContentOperationMenuItems
            selection={{
              type: "resources",
              resources: [
                {
                  id: tagId,
                  kind: WorkspaceContentResourceKindType.Tag,
                },
              ],
            }}
          />
        ),
      },
      ...(writable
        ? [
            {
              index: 9999,
              view: <MenuSeparator key="menu-separator" />,
            },
            {
              index: 10000,
              view: (
                <MenuItem
                  prefixIcon={<ArchiveIcon />}
                  onClick={handleArchive}
                  data-testid="tag-archive-button"
                >
                  {t["com.myoxus.tags.archive.action"]()}
                </MenuItem>
              ),
            },
          ]
        : []),
    ],
    [
      favorite,
      handleArchive,
      handleNewDoc,
      handleOpenInNewTab,
      handleOpenInSplitView,
      handleToggleFavoriteTag,
      t,
      writable,
    ],
  );
};
