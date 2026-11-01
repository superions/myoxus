import type {
  NodeOperation,
  StructureTreeNodeIcon,
} from "@myoxus/core/components/structure-tree";
import { WorkspaceContentOperationMenuItems } from "@myoxus/core/components/workspace-content-operation/menu-items";
import { useCreatePageInFolder } from "@myoxus/core/components/structure-tree/nodes/folder/use-create-page-in-folder";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import {
  type FolderNode,
  OrganizeService,
} from "@myoxus/core/modules/organize";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  FolderIcon,
  FolderOpenIcon,
  LayerIcon,
  PageIcon,
  PlusIcon,
  PlusThickIcon,
  RemoveFolderIcon,
  TagsIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  IconButton,
  MenuItem,
  MenuSeparator,
  MenuSub,
  notify,
} from "@myoxus/ui-facade";
import { difference } from "lodash-es";
import { useCallback, useMemo } from "react";

import { AddItemPlaceholder } from "../../layouts/add-item-placeholder";
import { StructureTreeNode } from "../../tree/node";
import { StructureTreeCollectionNode } from "../collection";
import { StructureTreeDatabaseNode } from "../database";
import { StructureTreeDocNode } from "../doc";
import { StructureTreeTagNode } from "../tag";
import { FolderCreateTip, FolderRenameSubMenu } from "./dialog";
import { FavoriteFolderOperation } from "./operations";

export const StructureTreeFolderNode = ({
  nodeId,
  operations,
  parentPath,
}: {
  nodeId: string;
  operations?:
    NodeOperation[] | ((type: string, node: FolderNode) => NodeOperation[]);
  parentPath: string[];
}) => {
  const { organizeService } = useServices({
    OrganizeService,
  });
  const node = useLiveData(organizeService.folderTree.folderNode$(nodeId));
  const type = useLiveData(node?.type$);
  const data = useLiveData(node?.data$);

  const additionalOperations = useMemo(() => {
    if (!type || !node) {
      return;
    }
    if (typeof operations === "function") {
      return operations(type, node);
    }
    return operations;
  }, [node, operations, type]);

  if (!node) {
    return;
  }

  if (type === "folder") {
    return (
      <StructureTreeFolderNodeFolder
        node={node}
        operations={additionalOperations}
        parentPath={parentPath}
      />
    );
  }
  if (!data) return null;
  if (type === "doc") {
    return (
      <StructureTreeDocNode
        docId={data}
        operations={additionalOperations}
        parentPath={parentPath}
      />
    );
  } else if (type === "collection") {
    return (
      <StructureTreeCollectionNode
        collectionId={data}
        operations={additionalOperations}
        parentPath={parentPath}
      />
    );
  } else if (type === "database") {
    return (
      <StructureTreeDatabaseNode
        databaseId={data}
        operations={additionalOperations}
        parentPath={parentPath}
      />
    );
  } else if (type === "tag") {
    return (
      <StructureTreeTagNode
        tagId={data}
        operations={additionalOperations}
        parentPath={parentPath}
      />
    );
  }

  return;
};

const StructureTreeFolderIcon: StructureTreeNodeIcon = ({
  collapsed,
  className,
  draggedOver,
  treeInstruction,
}) => {
  const Icon =
    !collapsed || (!!draggedOver && treeInstruction?.type === "make-child")
      ? FolderOpenIcon
      : FolderIcon;
  return <Icon className={className} />;
};

const StructureTreeFolderNodeFolder = ({
  node,
  operations: additionalOperations,
  parentPath,
}: {
  node: FolderNode;
  operations?: NodeOperation[];
  parentPath: string[];
}) => {
  const t = useI18n();
  const { workspaceDialogService } = useServices({
    CompatibleFavoriteItemsAdapter,
    WorkspaceDialogService,
  });
  const name = useLiveData(node.name$);
  const structureTreeStateService = useService(StructureTreeStateService);
  const path = useMemo(
    () => [...parentPath, `folder-${node.id}`],
    [parentPath, node.id],
  );
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));
  const setCollapsed = useCallback(
    (value: boolean) => {
      structureTreeStateService.setCollapsed(path, value);
    },
    [structureTreeStateService, path],
  );

  const createPageInFolder = useCreatePageInFolder();
  const handleDelete = useCallback(() => {
    node.delete();
    track.$.navigationPanel.organize.deleteOrganizeItem({
      type: "folder",
    });
    notify.success({
      title: t["com.myoxus.rootAppSidebar.organize.delete.notify-title"]({
        name,
      }),
      message: t["com.myoxus.rootAppSidebar.organize.delete.notify-message"](),
    });
  }, [name, node, t]);

  const children = useLiveData(node.sortedChildren$);

  const handleRename = useCallback(
    (newName: string) => {
      node.rename(newName);
    },
    [node],
  );

  const handleNewDoc = useCallback(() => {
    createPageInFolder(node);
    track.$.navigationPanel.folders.createDoc();
    track.$.navigationPanel.organize.createOrganizeItem({
      type: "link",
      target: "doc",
    });
    setCollapsed(false);
  }, [createPageInFolder, node, setCollapsed]);

  const handleCreateSubfolder = useCallback(
    (name: string) => {
      node.createFolder(name, node.indexAt("before"));
      track.$.navigationPanel.organize.createOrganizeItem({ type: "folder" });
      setCollapsed(false);
    },
    [node, setCollapsed],
  );

  const handleAddToFolder = useCallback(
    (type: "doc" | "collection" | "tag") => {
      const initialIds = children
        .filter((node) => node.type$.value === type)
        .map((node) => node.data$.value)
        .filter(Boolean) as string[];
      const selector =
        type === "doc"
          ? "doc-selector"
          : type === "collection"
            ? "collection-selector"
            : "tag-selector";
      workspaceDialogService.open(
        selector,
        {
          init: initialIds,
        },
        (selectedIds) => {
          if (selectedIds === undefined) {
            return;
          }
          const newItemIds = difference(selectedIds, initialIds);
          const removedItemIds = difference(initialIds, selectedIds);
          const removedItems = children.filter(
            (node) =>
              !!node.data$.value && removedItemIds.includes(node.data$.value),
          );

          newItemIds.forEach((id) => {
            node.createLink(type, id, node.indexAt("after"));
          });
          removedItems.forEach((node) => node.delete());
          const updated = newItemIds.length + removedItems.length;
          updated && setCollapsed(false);
        },
      );
      track.$.navigationPanel.organize.createOrganizeItem({
        type: "link",
        target: type,
      });
    },
    [children, node, setCollapsed, workspaceDialogService],
  );

  const createSubTipRenderer = useCallback(
    ({ input }: { input: string }) => {
      return <FolderCreateTip input={input} parentName={name} />;
    },
    [name],
  );

  const folderOperations = useMemo(() => {
    return [
      {
        index: 0,
        inline: true,
        view: (
          <IconButton
            size="16"
            onClick={handleNewDoc}
            tooltip={t[
              "com.myoxus.rootAppSidebar.explorer.organize-add-tooltip"
            ]()}
          >
            <PlusIcon />
          </IconButton>
        ),
      },
      {
        index: 98,
        view: (
          <FolderRenameSubMenu
            initialName={name}
            onConfirm={handleRename}
            menuProps={{
              triggerOptions: { "data-testid": "rename-folder" },
            }}
          />
        ),
      },
      {
        index: 99,
        view: <MenuSeparator />,
      },
      {
        index: 100,
        view: (
          <FolderRenameSubMenu
            text={t[
              "com.myoxus.rootAppSidebar.organize.folder.create-subfolder"
            ]()}
            title={t[
              "com.myoxus.rootAppSidebar.organize.folder.create-subfolder"
            ]()}
            onConfirm={handleCreateSubfolder}
            descRenderer={createSubTipRenderer}
            icon={<FolderIcon />}
            menuProps={{
              triggerOptions: { "data-testid": "create-subfolder" },
            }}
          />
        ),
      },
      {
        index: 102,
        view: (
          <MenuSub
            triggerOptions={{
              prefixIcon: <PlusThickIcon />,
            }}
            items={
              <>
                <MenuItem
                  prefixIcon={<PageIcon />}
                  onClick={() => handleAddToFolder("doc")}
                >
                  {t["com.myoxus.rootAppSidebar.organize.folder.add-docs"]()}
                </MenuItem>
                <MenuItem
                  onClick={() => handleAddToFolder("tag")}
                  prefixIcon={<TagsIcon />}
                >
                  {t["com.myoxus.rootAppSidebar.organize.folder.add-tags"]()}
                </MenuItem>
                <MenuItem
                  onClick={() => handleAddToFolder("collection")}
                  prefixIcon={<LayerIcon />}
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
            type={"danger"}
            prefixIcon={<DeleteIcon />}
            onClick={handleDelete}
          >
            {t["com.myoxus.rootAppSidebar.organize.delete"]()}
          </MenuItem>
        ),
      },
    ];
  }, [
    createSubTipRenderer,
    handleAddToFolder,
    handleCreateSubfolder,
    handleDelete,
    handleNewDoc,
    handleRename,
    name,
    node.id,
    t,
  ]);

  const finalOperations = useMemo(() => {
    if (additionalOperations) {
      return [...additionalOperations, ...folderOperations];
    }
    return folderOperations;
  }, [additionalOperations, folderOperations]);

  const childrenOperations = useCallback(
    (type: string, node: FolderNode) => {
      if (
        type === "doc" ||
        type === "database" ||
        type === "collection" ||
        type === "tag"
      ) {
        return [
          {
            index: 999,
            view: (
              <MenuItem
                type={"danger"}
                prefixIcon={<RemoveFolderIcon />}
                data-event-props="$.navigationPanel.organize.deleteOrganizeItem"
                data-event-args-type={node.type$.value}
                onClick={() => node.delete()}
              >
                {t["com.myoxus.rootAppSidebar.organize.delete-from-folder"]()}
              </MenuItem>
            ),
          },
        ] satisfies NodeOperation[];
      }
      return [];
    },
    [t],
  );

  const handleCollapsedChange = useCallback(
    (collapsed: boolean) => {
      if (collapsed) {
        setCollapsed(true);
      } else {
        setCollapsed(false);
      }
    },
    [setCollapsed],
  );

  return (
    <StructureTreeNode
      icon={StructureTreeFolderIcon}
      name={name}
      extractEmojiAsIcon
      collapsed={collapsed}
      setCollapsed={handleCollapsedChange}
      operations={finalOperations}
      data-testid={`structure-tree-folder-${node.id}`}
      aria-label={name}
      data-role="structure-tree-folder"
    >
      {children.map((child) => (
        <StructureTreeFolderNode
          key={child.id}
          nodeId={child.id as string}
          operations={childrenOperations}
          parentPath={path}
        />
      ))}
      <AddItemPlaceholder
        label={t["com.myoxus.rootAppSidebar.organize.folder.new-doc"]()}
        onClick={handleNewDoc}
        data-testid="new-folder-in-folder-button"
      />
    </StructureTreeNode>
  );
};
