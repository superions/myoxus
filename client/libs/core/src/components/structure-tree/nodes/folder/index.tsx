import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import {
  type FolderLinkType,
  type FolderNode,
  OrganizeService,
} from "@myoxus/core/modules/organize";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspacesService } from "@myoxus/core/modules/workspace";
import { WorkspaceContentOperationService } from "@myoxus/core/modules/workspace-content-operation";
import type { MyoxusDNDData, MyoxusDNDEntity } from "@myoxus/core/types/dnd";
import { Unreachable } from "@myoxus/env/constant";
import { WorkspaceContentResourceKindType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  CloudWorkspaceIcon,
  CollectionsIcon,
  DatabaseIcon,
  DeleteIcon,
  FolderIcon,
  FolderOpenIcon,
  PageIcon,
  PlusThickIcon,
  RemoveFolderIcon,
  TagIcon,
  TagsIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  AnimatedCollectionsIcon,
  type DropTargetDropEvent,
  type DropTargetOptions,
  MenuItem,
  MenuSeparator,
  MenuSub,
  notify,
} from "@myoxus/ui-facade";
import { difference } from "lodash-es";
import { useCallback, useMemo, useState } from "react";

import { WorkspaceContentOperationMenuItems } from "../../../workspace-content-operation/menu-items";
import {
  StructureTreeNode,
  type StructureTreeNodeDropEffect,
} from "../../tree";
import type { StructureTreeNodeIcon } from "../../tree/node";
import type { NodeOperation } from "../../tree/types";
import { StructureTreeCollectionNode } from "../collection";
import { StructureTreeDatabaseNode } from "../database";
import { StructureTreeDocNode } from "../doc";
import { StructureTreeTagNode } from "../tag";
import type { GenericStructureTreeNode } from "../types";
import { FavoriteFolderOperation } from "./operations";
import { useCreatePageInFolder } from "./use-create-page-in-folder";

type DraggableFolderLinkType = Extract<FolderLinkType, MyoxusDNDEntity["type"]>;

const isFolderLinkEntity = (
  type: string | undefined,
): type is DraggableFolderLinkType =>
  type === "collection" ||
  type === "database" ||
  type === "doc" ||
  type === "tag";

export const StructureTreeFolderNode = ({
  nodeId,
  onDrop,
  defaultRenaming,
  operations,
  location,
  dropEffect,
  canDrop,
  reorderable,
  parentPath,
}: {
  defaultRenaming?: boolean;
  nodeId: string;
  onDrop?: (data: DropTargetDropEvent<MyoxusDNDData>, node: FolderNode) => void;
  operations?:
    NodeOperation[] | ((type: string, node: FolderNode) => NodeOperation[]);
} & Omit<GenericStructureTreeNode, "operations">) => {
  const { organizeService } = useServices({
    OrganizeService,
  });
  const node = useLiveData(organizeService.folderTree.folderNode$(nodeId));
  const type = useLiveData(node?.type$);
  const data = useLiveData(node?.data$);
  const targetWorkspaceId = useLiveData(node?.targetWorkspaceId$);
  const handleDrop = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>) => {
      if (!node) {
        return;
      }
      onDrop?.(data, node);
    },
    [node, onDrop],
  );
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

  if (type && type !== "folder" && data && targetWorkspaceId) {
    return (
      <StructureTreeCrossWorkspaceLinkNode
        canDrop={canDrop}
        data={data}
        dropEffect={dropEffect}
        location={location}
        node={node}
        onDrop={handleDrop}
        operations={additionalOperations}
        parentPath={parentPath}
        reorderable={reorderable}
        targetWorkspaceId={targetWorkspaceId}
        type={type}
      />
    );
  } else if (type === "folder") {
    return (
      <StructureTreeFolderNodeFolder
        node={node}
        onDrop={handleDrop}
        defaultRenaming={defaultRenaming}
        operations={additionalOperations}
        dropEffect={dropEffect}
        reorderable={reorderable}
        canDrop={canDrop}
        parentPath={parentPath}
      />
    );
  } else if (type === "doc") {
    return (
      data && (
        <StructureTreeDocNode
          docId={data}
          allowLinkedDocuments={false}
          location={location}
          onDrop={handleDrop}
          reorderable={reorderable}
          canDrop={canDrop}
          dropEffect={dropEffect}
          operations={additionalOperations}
          parentPath={parentPath}
        />
      )
    );
  } else if (type === "collection") {
    return (
      data && (
        <StructureTreeCollectionNode
          collectionId={data}
          location={location}
          onDrop={handleDrop}
          canDrop={canDrop}
          reorderable={reorderable}
          dropEffect={dropEffect}
          operations={additionalOperations}
          parentPath={parentPath}
        />
      )
    );
  } else if (type === "database") {
    return (
      data && (
        <StructureTreeDatabaseNode
          databaseId={data}
          location={location}
          onDrop={handleDrop}
          canDrop={canDrop}
          reorderable={reorderable}
          dropEffect={dropEffect}
          operations={additionalOperations}
          parentPath={parentPath}
        />
      )
    );
  } else if (type === "tag") {
    return (
      data && (
        <StructureTreeTagNode
          tagId={data}
          location={location}
          onDrop={handleDrop}
          canDrop={canDrop}
          reorderable
          dropEffect={dropEffect}
          operations={additionalOperations}
          parentPath={parentPath}
        />
      )
    );
  }

  return;
};

const CROSS_WORKSPACE_RESOURCE_KINDS = {
  collection: WorkspaceContentResourceKindType.Collection,
  database: WorkspaceContentResourceKindType.Database,
  doc: WorkspaceContentResourceKindType.Document,
  tag: WorkspaceContentResourceKindType.Tag,
} as const;

function isCrossWorkspaceResourceKind(
  type: string,
): type is keyof typeof CROSS_WORKSPACE_RESOURCE_KINDS {
  return type in CROSS_WORKSPACE_RESOURCE_KINDS;
}

function StructureTreeCrossWorkspaceLinkNode({
  canDrop,
  data,
  dropEffect,
  location,
  node,
  onDrop,
  operations,
  reorderable,
  targetWorkspaceId,
  type,
}: {
  data: string;
  node: FolderNode;
  targetWorkspaceId: string;
  type: (string & {}) | FolderLinkType;
} & GenericStructureTreeNode) {
  const t = useI18n();
  const navigate = useNavigateHelper();
  const { workspaceContentOperationService, workspacesService } = useServices({
    WorkspaceContentOperationService,
    WorkspacesService,
  });
  const workspaces = useLiveData(workspacesService.list.workspaces$);
  const [denied, setDenied] = useState(false);
  const targetWorkspace = workspaces.find(
    (workspace) => workspace.id === targetWorkspaceId,
  );
  const kind =
    type === "workspace"
      ? t["com.myoxus.settings.workspace"]()
      : isCrossWorkspaceResourceKind(type)
        ? t[workspaceContentKindTranslationKey(type)]()
        : t["com.myoxus.workspace-content-operation.kind.unknown"]();
  const name =
    !denied && targetWorkspace?.name
      ? `${kind} · ${targetWorkspace.name}`
      : kind;
  const Icon = useCallback(
    ({ className }: { className?: string }) => {
      switch (type) {
        case "collection":
          return <CollectionsIcon className={className} />;
        case "database":
          return <DatabaseIcon className={className} />;
        case "tag":
          return <TagIcon className={className} />;
        case "workspace":
          return <CloudWorkspaceIcon className={className} />;
        default:
          return <PageIcon className={className} />;
      }
    },
    [type],
  );
  const dndData = useMemo<MyoxusDNDData | undefined>(() => {
    if (type === "workspace" || !isFolderLinkEntity(type) || !location) {
      return undefined;
    }
    return {
      draggable: {
        entity: { type, id: data },
        from: location,
      },
      dropTarget: { at: `structure-tree:${type}` },
    };
  }, [data, location, type]);
  const open = useCallback(async () => {
    try {
      if (type === "workspace") {
        const workspaceId =
          await workspaceContentOperationService.resolveWorkspaceHome(
            targetWorkspaceId,
          );
        if (workspaceId) {
          navigate.jumpToWorkspaceOverview(workspaceId);
          return;
        }
      } else if (isCrossWorkspaceResourceKind(type)) {
        const resource = await workspaceContentOperationService.resolveRedirect(
          {
            workspaceId: targetWorkspaceId,
            resource: {
              id: data,
              kind: CROSS_WORKSPACE_RESOURCE_KINDS[type],
            },
          },
        );
        if (resource) {
          navigate.jumpToWorkspaceResource(resource);
          return;
        }
      }
    } catch {
      // Permission, deletion and deployment mismatches intentionally converge
      // on the same metadata-free UI result.
    }
    setDenied(true);
    notify.error({
      title: t["com.myoxus.workspace-content-operation.error.target-denied"](),
    });
  }, [
    data,
    navigate,
    t,
    targetWorkspaceId,
    type,
    workspaceContentOperationService,
  ]);

  return (
    <StructureTreeNode
      canDrop={canDrop}
      collapsed
      collapsible={false}
      data-testid={`structure-tree-cross-workspace-${node.id}`}
      dndData={dndData}
      dropEffect={dropEffect}
      icon={Icon}
      name={name}
      onClick={() => void open()}
      onDrop={onDrop}
      operations={operations}
      reorderable={reorderable}
      setCollapsed={() => undefined}
    />
  );
}

function workspaceContentKindTranslationKey(
  type: keyof typeof CROSS_WORKSPACE_RESOURCE_KINDS,
) {
  switch (type) {
    case "collection":
      return "com.myoxus.workspace-content-operation.kind.collection" as const;
    case "database":
      return "com.myoxus.workspace-content-operation.kind.database" as const;
    case "doc":
      return "com.myoxus.workspace-content-operation.kind.document" as const;
    case "tag":
      return "com.myoxus.workspace-content-operation.kind.tag" as const;
  }
}

// Keep the icon component stable so folder state changes do not remount the row.
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
  onDrop,
  defaultRenaming,
  location,
  operations: additionalOperations,
  canDrop,
  dropEffect,
  reorderable,
  parentPath,
}: {
  defaultRenaming?: boolean;
  node: FolderNode;
} & GenericStructureTreeNode) => {
  const t = useI18n();
  const { workspaceDialogService } = useServices({
    CompatibleFavoriteItemsAdapter,
    WorkspaceDialogService,
  });
  const structureTreeStateService = useService(StructureTreeStateService);
  const { workbench } = useService(WorkbenchService);
  const activeLocation = useLiveData(workbench.location$);
  const active =
    activeLocation.pathname === "/overview" &&
    new URLSearchParams(activeLocation.search).get("folder") === node.id;
  const name = useLiveData(node.name$);
  const path = useMemo(
    () => [...(parentPath ?? []), `folder-${node.id}`],
    [parentPath, node.id],
  );
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));
  const setCollapsed = useCallback(
    (value: boolean) => {
      structureTreeStateService.setCollapsed(path, value);
    },
    [structureTreeStateService, path],
  );
  const [newFolderId, setNewFolderId] = useState<string | null>(null);

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

  const dndData = useMemo(() => {
    if (!node.id) {
      throw new Unreachable();
    }
    return {
      draggable: {
        entity: {
          type: "folder",
          id: node.id,
        },
        from: location,
      },
      dropTarget: {
        at: "structure-tree:organize:folder",
      },
    } satisfies MyoxusDNDData;
  }, [location, node.id]);

  const handleRename = useCallback(
    (newName: string) => {
      node.rename(newName);
    },
    [node],
  );

  const handleDropOnFolder = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>) => {
      if (data.source.data.entity?.type) {
        track.$.navigationPanel.folders.drop({
          type: data.source.data.entity.type,
        });
      }
      if (data.treeInstruction?.type === "make-child") {
        if (data.source.data.entity?.type === "folder") {
          if (
            node.id === data.source.data.entity.id ||
            node.beChildOf(data.source.data.entity.id)
          ) {
            return;
          }
          node.moveHere(data.source.data.entity.id, node.indexAt("before"));
          track.$.navigationPanel.organize.moveOrganizeItem({ type: "folder" });
        } else if (isFolderLinkEntity(data.source.data.entity?.type)) {
          if (
            data.source.data.from?.at === "structure-tree:organize:folder-node"
          ) {
            node.moveHere(data.source.data.from.nodeId, node.indexAt("before"));
            track.$.navigationPanel.organize.moveOrganizeItem({
              type: "link",
              target: data.source.data.entity?.type,
            });
          } else {
            node.createLink(
              data.source.data.entity?.type,
              data.source.data.entity.id,
              node.indexAt("before"),
            );
            track.$.navigationPanel.organize.createOrganizeItem({
              type: "link",
              target: data.source.data.entity?.type,
            });
          }
        }
        setCollapsed(false);
      } else {
        onDrop?.(data);
      }
    },
    [node, onDrop, setCollapsed],
  );

  const handleDropEffect = useCallback<StructureTreeNodeDropEffect>(
    (data) => {
      if (data.treeInstruction?.type === "make-child") {
        if (data.source.data.entity?.type === "folder") {
          if (
            node.id === data.source.data.entity.id ||
            node.beChildOf(data.source.data.entity.id)
          ) {
            return;
          }
          return "move";
        } else if (
          data.source.data.from?.at === "structure-tree:organize:folder-node"
        ) {
          return "move";
        } else if (isFolderLinkEntity(data.source.data.entity?.type)) {
          return "link";
        }
      } else {
        return dropEffect?.(data);
      }
      return;
    },
    [dropEffect, node],
  );

  const handleDropOnChildren = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>, dropAtNode?: FolderNode) => {
      if (!dropAtNode || !dropAtNode.id) {
        return;
      }
      if (data.source.data.entity?.type) {
        track.$.navigationPanel.folders.drop({
          type: data.source.data.entity.type,
        });
      }
      if (
        data.treeInstruction?.type === "reorder-above" ||
        data.treeInstruction?.type === "reorder-below"
      ) {
        const at =
          data.treeInstruction?.type === "reorder-below" ? "after" : "before";
        if (data.source.data.entity?.type === "folder") {
          if (
            node.id === data.source.data.entity.id ||
            node.beChildOf(data.source.data.entity.id)
          ) {
            return;
          }
          node.moveHere(
            data.source.data.entity.id,
            node.indexAt(at, dropAtNode.id),
          );
          track.$.navigationPanel.organize.moveOrganizeItem({ type: "folder" });
        } else if (isFolderLinkEntity(data.source.data.entity?.type)) {
          if (
            data.source.data.from?.at === "structure-tree:organize:folder-node"
          ) {
            node.moveHere(
              data.source.data.from.nodeId,
              node.indexAt(at, dropAtNode.id),
            );
            track.$.navigationPanel.organize.moveOrganizeItem({
              type: "link",
              target: data.source.data.entity?.type,
            });
          } else {
            node.createLink(
              data.source.data.entity?.type,
              data.source.data.entity.id,
              node.indexAt(at, dropAtNode.id),
            );

            track.$.navigationPanel.organize.createOrganizeItem({
              type: "link",
              target: data.source.data.entity?.type,
            });
          }
        }
      } else if (data.treeInstruction?.type === "reparent") {
        const currentLevel = data.treeInstruction.currentLevel;
        const desiredLevel = data.treeInstruction.desiredLevel;
        if (currentLevel === desiredLevel + 1) {
          onDrop?.({
            ...data,
            treeInstruction: {
              type: "reorder-below",
              currentLevel,
              indentPerLevel: data.treeInstruction.indentPerLevel,
            },
          });
          return;
        } else {
          onDrop?.({
            ...data,
            treeInstruction: {
              ...data.treeInstruction,
              currentLevel: currentLevel - 1,
            },
          });
        }
      }
    },
    [node, onDrop],
  );

  const handleDropEffectOnChildren = useCallback<StructureTreeNodeDropEffect>(
    (data) => {
      if (
        data.treeInstruction?.type === "reorder-above" ||
        data.treeInstruction?.type === "reorder-below"
      ) {
        if (data.source.data.entity?.type === "folder") {
          if (
            node.id === data.source.data.entity.id ||
            node.beChildOf(data.source.data.entity.id)
          ) {
            return;
          }
          return "move";
        } else if (
          data.source.data.from?.at === "structure-tree:organize:folder-node"
        ) {
          return "move";
        } else if (isFolderLinkEntity(data.source.data.entity?.type)) {
          return "link";
        }
      } else if (data.treeInstruction?.type === "reparent") {
        const currentLevel = data.treeInstruction.currentLevel;
        const desiredLevel = data.treeInstruction.desiredLevel;
        if (currentLevel === desiredLevel + 1) {
          dropEffect?.({
            ...data,
            treeInstruction: {
              type: "reorder-below",
              currentLevel,
              indentPerLevel: data.treeInstruction.indentPerLevel,
            },
          });
          return;
        } else {
          dropEffect?.({
            ...data,
            treeInstruction: {
              ...data.treeInstruction,
              currentLevel: currentLevel - 1,
            },
          });
        }
      }
      return;
    },
    [dropEffect, node],
  );

  const handleCanDrop = useMemo<DropTargetOptions<MyoxusDNDData>["canDrop"]>(
    () => (args) => {
      const entityType = args.source.data.entity?.type;
      if (args.treeInstruction && args.treeInstruction?.type !== "make-child") {
        return (
          (typeof canDrop === "function" ? canDrop(args) : canDrop) ?? true
        );
      }

      if (args.source.data.entity?.type === "folder") {
        if (
          node.id === args.source.data.entity.id ||
          node.beChildOf(args.source.data.entity.id)
        ) {
          return false;
        }
        return true;
      } else if (
        args.source.data.from?.at === "structure-tree:organize:folder-node"
      ) {
        return true;
      } else if (isFolderLinkEntity(entityType)) {
        return true;
      }
      return false;
    },
    [canDrop, node],
  );

  const handleChildrenCanDrop = useMemo<
    DropTargetOptions<MyoxusDNDData>["canDrop"]
  >(
    () => (args) => {
      const entityType = args.source.data.entity?.type;

      if (args.source.data.entity?.type === "folder") {
        if (
          node.id === args.source.data.entity.id ||
          node.beChildOf(args.source.data.entity.id)
        ) {
          return false;
        }
        return true;
      } else if (
        args.source.data.from?.at === "structure-tree:organize:folder-node"
      ) {
        return true;
      } else if (isFolderLinkEntity(entityType)) {
        return true;
      }
      return false;
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

  const handleCreateSubfolder = useCallback(() => {
    const newFolderId = node.createFolder(
      t["com.myoxus.rootAppSidebar.organize.new-folders"](),
      node.indexAt("before"),
    );
    track.$.navigationPanel.organize.createOrganizeItem({ type: "folder" });
    setCollapsed(false);
    setNewFolderId(newFolderId);
  }, [node, setCollapsed, t]);

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

  const folderOperations = useMemo(() => {
    return [
      {
        // Index 0 belongs to StructureTreeNode's built-in rename operation.
        // Keep every menu identity unique so Mantine can preserve focus and
        // item state while the capability-driven XWS entries appear.
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
            triggerOptions={{
              prefixIcon: <PlusThickIcon />,
            }}
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
    handleAddToFolder,
    handleCreateSubfolder,
    handleDelete,
    handleNewDoc,
    node,
    name,
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
        type === "tag" ||
        type === "workspace"
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
        setNewFolderId(null); // reset new folder id to clear the renaming state
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
      to={`/overview?${new URLSearchParams({ folder: node.id! })}`}
      active={active}
      dndData={dndData}
      onDrop={handleDropOnFolder}
      defaultRenaming={defaultRenaming}
      renameable
      extractEmojiAsIcon
      reorderable={reorderable}
      collapsed={children.length === 0 || collapsed}
      collapsible={children.length > 0}
      setCollapsed={handleCollapsedChange}
      onRename={handleRename}
      operations={finalOperations}
      canDrop={handleCanDrop}
      dropEffect={handleDropEffect}
      data-testid={`structure-tree-folder-${node.id}`}
      explorerIconConfig={node.id ? { where: "folder", id: node.id } : null}
    >
      {children.map((child) => (
        <StructureTreeFolderNode
          key={child.id}
          nodeId={child.id as string}
          defaultRenaming={child.id === newFolderId}
          onDrop={handleDropOnChildren}
          operations={childrenOperations}
          dropEffect={handleDropEffectOnChildren}
          canDrop={handleChildrenCanDrop}
          location={{
            at: "structure-tree:organize:folder-node",
            nodeId: child.id as string,
          }}
          parentPath={path}
        />
      ))}
    </StructureTreeNode>
  );
};
