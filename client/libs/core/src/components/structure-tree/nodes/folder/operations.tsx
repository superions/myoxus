// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { IsFavoriteIcon } from "@myoxus/core/components/pure/icons";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import type { FolderNode } from "@myoxus/core/modules/organize";
import { useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  FolderIcon,
  PageIcon,
  PlusThickIcon,
  RemoveFolderIcon,
  TagsIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  AnimatedCollectionsIcon,
  MenuItem,
  MenuSeparator,
  MenuSub,
  notify,
} from "@myoxus/ui-facade";
import { difference } from "lodash-es";
import { useCallback, useMemo } from "react";

import { WorkspaceContentOperationMenuItems } from "../../../workspace-content-operation/menu-items";
import type { NodeOperation } from "../../tree/types";
import { useCreatePageInFolder } from "./use-create-page-in-folder";

const REMOVABLE_CHILD_TYPES = new Set([
  "doc",
  "database",
  "collection",
  "tag",
  "folder_link",
  "workspace",
]);

export function FavoriteFolderOperation({ id }: { id: string }) {
  const t = useI18n();
  const favorites = useService(CompatibleFavoriteItemsAdapter);
  const favorite = useLiveData(
    useMemo(() => favorites.isFavorite$(id, "folder"), [favorites, id]),
  );

  return (
    <MenuItem
      prefixIcon={<IsFavoriteIcon favorite={favorite} />}
      onClick={() => favorites.toggle(id, "folder")}
    >
      {favorite
        ? t["com.myoxus.rootAppSidebar.organize.folder-rm-favorite"]()
        : t["com.myoxus.rootAppSidebar.organize.folder-add-favorite"]()}
    </MenuItem>
  );
}

export function useFolderNodeOperations({
  node,
  name,
  children,
  additionalOperations,
  onExpand,
  onSubfolderCreated,
}: {
  node: FolderNode;
  name: string;
  children: FolderNode[];
  additionalOperations?: NodeOperation[];
  onExpand: () => void;
  onSubfolderCreated: (folderId: string) => void;
}): NodeOperation[] {
  const t = useI18n();
  const workspaceDialogService = useService(WorkspaceDialogService);
  const createPageInFolder = useCreatePageInFolder();

  const handleDelete = useCallback(() => {
    node.delete();
    track.$.navigationPanel.organize.deleteOrganizeItem({ type: "folder" });
    notify.success({
      title: t["com.myoxus.rootAppSidebar.organize.delete.notify-title"]({
        name,
      }),
      message: t["com.myoxus.rootAppSidebar.organize.delete.notify-message"](),
    });
  }, [name, node, t]);

  const handleNewDoc = useCallback(() => {
    createPageInFolder(node);
    track.$.navigationPanel.folders.createDoc();
    track.$.navigationPanel.organize.createOrganizeItem({
      type: "link",
      target: "doc",
    });
    onExpand();
  }, [createPageInFolder, node, onExpand]);

  const handleCreateSubfolder = useCallback(() => {
    const createdId = node.createFolder(
      t["com.myoxus.rootAppSidebar.organize.new-folders"](),
      node.indexAt("before"),
    );
    track.$.navigationPanel.organize.createOrganizeItem({ type: "folder" });
    onExpand();
    onSubfolderCreated(createdId);
  }, [node, onExpand, onSubfolderCreated, t]);

  const handleAddToFolder = useCallback(
    (type: "doc" | "collection" | "tag") => {
      const initialIds = children
        .filter((child) => child.type$.value === type)
        .map((child) => child.data$.value)
        .filter(Boolean) as string[];
      const selector =
        type === "doc"
          ? "doc-selector"
          : type === "collection"
            ? "collection-selector"
            : "tag-selector";
      workspaceDialogService.open(
        selector,
        { init: initialIds },
        (selectedIds) => {
          if (selectedIds === undefined) {
            return;
          }
          const added = difference(selectedIds, initialIds);
          const removedIds = difference(initialIds, selectedIds);
          const removedNodes = children.filter(
            (child) =>
              !!child.data$.value && removedIds.includes(child.data$.value),
          );
          for (const id of added) {
            node.createLink(type, id, node.indexAt("after"));
          }
          for (const removed of removedNodes) {
            removed.delete();
          }
          if (added.length + removedNodes.length > 0) {
            onExpand();
          }
        },
      );
      track.$.navigationPanel.organize.createOrganizeItem({
        type: "link",
        target: type,
      });
    },
    [children, node, onExpand, workspaceDialogService],
  );

  const folderOperations = useMemo<NodeOperation[]>(
    () => [
      {
        // Index 0 belongs to StructureTreeNode's built-in rename operation;
        // keep every menu identity distinct so Mantine preserves focus state.
        index: 10,
        view: (
          <MenuItem prefixIcon={<PageIcon />} onClick={handleNewDoc}>
            {t["com.myoxus.rootAppSidebar.explorer.organize-add-tooltip"]()}
          </MenuItem>
        ),
      },
      {
        index: 100,
        view: (
          <MenuItem prefixIcon={<FolderIcon />} onClick={handleCreateSubfolder}>
            {t["com.myoxus.rootAppSidebar.organize.folder.create-subfolder"]()}
          </MenuItem>
        ),
      },
      {
        index: 101,
        view: (
          <MenuItem
            prefixIcon={<PageIcon />}
            onClick={() => handleAddToFolder("doc")}
          >
            {t["com.myoxus.rootAppSidebar.organize.folder.add-docs"]()}
          </MenuItem>
        ),
      },
      {
        index: 102,
        view: (
          <MenuSub
            triggerOptions={{ prefixIcon: <PlusThickIcon /> }}
            items={
              <>
                <MenuItem
                  onClick={() => handleAddToFolder("tag")}
                  prefixIcon={<TagsIcon />}
                >
                  {t["com.myoxus.rootAppSidebar.organize.folder.add-tags"]()}
                </MenuItem>
                <MenuItem
                  onClick={() => handleAddToFolder("collection")}
                  prefixIcon={<AnimatedCollectionsIcon closed={false} />}
                >
                  {t[
                    "com.myoxus.rootAppSidebar.organize.folder.add-collections"
                  ]()}
                </MenuItem>
              </>
            }
          >
            {t["com.myoxus.rootAppSidebar.organize.folder.add-others"]()}
          </MenuSub>
        ),
      },
      {
        index: 200,
        view: node.id ? <FavoriteFolderOperation id={node.id} /> : null,
      },
      {
        index: 500,
        view: node.id ? (
          <WorkspaceContentOperationMenuItems
            selection={{
              type: "folder",
              folderId: node.id,
              label: name,
            }}
          />
        ) : null,
      },
      {
        index: 9999,
        view: <MenuSeparator key="menu-separator" />,
      },
      {
        index: 10000,
        view: (
          <MenuItem
            type="danger"
            prefixIcon={<DeleteIcon />}
            onClick={handleDelete}
          >
            {t["com.myoxus.rootAppSidebar.organize.delete"]()}
          </MenuItem>
        ),
      },
    ],
    [
      handleAddToFolder,
      handleCreateSubfolder,
      handleDelete,
      handleNewDoc,
      name,
      node.id,
      t,
    ],
  );

  return useMemo(
    () =>
      additionalOperations
        ? [...additionalOperations, ...folderOperations]
        : folderOperations,
    [additionalOperations, folderOperations],
  );
}

export function useFolderChildOperations() {
  const t = useI18n();

  return useCallback(
    (type: string, childNode: FolderNode): NodeOperation[] => {
      if (!REMOVABLE_CHILD_TYPES.has(type)) {
        return [];
      }
      return [
        {
          index: 999,
          view: (
            <MenuItem
              type="danger"
              prefixIcon={<RemoveFolderIcon />}
              data-event-props="$.navigationPanel.organize.deleteOrganizeItem"
              data-event-args-type={childNode.type$.value}
              onClick={() => childNode.delete()}
            >
              {t["com.myoxus.rootAppSidebar.organize.delete-from-folder"]()}
            </MenuItem>
          ),
        },
      ];
    },
    [t],
  );
}
