// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type FolderNode,
  OrganizeService,
} from "@myoxus/core/modules/organize";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { Unreachable } from "@myoxus/env/constant";
import { FolderIcon, FolderOpenIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import type { DropTargetDropEvent } from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

import { StructureTreeNode } from "../../tree";
import type { StructureTreeNodeIcon } from "../../tree/node";
import type { NodeOperation } from "../../tree/types";
import { StructureTreeCollectionNode } from "../collection";
import { StructureTreeDatabaseNode } from "../database";
import { StructureTreeDocNode } from "../doc";
import { StructureTreeTagNode } from "../tag";
import type { GenericStructureTreeNode } from "../types";
import { StructureTreeCrossWorkspaceLinkNode } from "./cross-workspace-link";
import { useFolderTreeDnd } from "./dnd";
import { LinkedFolderNode } from "./linked-folder";
import {
  useFolderChildOperations,
  useFolderNodeOperations,
} from "./operations";

// Keep the icon component identity stable so folder expand/drop updates do not remount rows.
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

export interface StructureTreeFolderNodeProps extends Omit<
  GenericStructureTreeNode,
  "operations" | "onDrop"
> {
  defaultRenaming?: boolean;
  nodeId: string;
  onDrop?: (data: DropTargetDropEvent<MyoxusDNDData>, node: FolderNode) => void;
  operations?:
    NodeOperation[] | ((type: string, node: FolderNode) => NodeOperation[]);
}

export function StructureTreeFolderNode({
  nodeId,
  onDrop,
  defaultRenaming,
  operations,
  location,
  dropEffect,
  canDrop,
  reorderable,
  parentPath,
}: StructureTreeFolderNodeProps) {
  const organizeService = useService(OrganizeService);
  const node = useLiveData(organizeService.folderTree.folderNode$(nodeId));
  const type = useLiveData(node?.type$);
  const data = useLiveData(node?.data$);
  const targetWorkspaceId = useLiveData(node?.targetWorkspaceId$);

  const handleDrop = useCallback(
    (event: DropTargetDropEvent<MyoxusDNDData>) => {
      if (node) {
        onDrop?.(event, node);
      }
    },
    [node, onDrop],
  );

  const resolvedOperations = useMemo(() => {
    if (!type || !node) {
      return undefined;
    }
    return typeof operations === "function"
      ? operations(type, node)
      : operations;
  }, [node, operations, type]);

  if (!node) {
    return null;
  }

  if (type === "folder_link" && data && targetWorkspaceId) {
    return (
      <LinkedFolderNode
        key={JSON.stringify([targetWorkspaceId, data])}
        treeNode={StructureTreeNode}
        workspaceId={targetWorkspaceId}
        folderId={data}
        operations={resolvedOperations}
      />
    );
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
        operations={resolvedOperations}
        parentPath={parentPath}
        reorderable={reorderable}
        targetWorkspaceId={targetWorkspaceId}
        type={type}
      />
    );
  }

  if (type === "folder") {
    return (
      <StructureTreeFolderRow
        node={node}
        onDrop={handleDrop}
        defaultRenaming={defaultRenaming}
        operations={resolvedOperations}
        dropEffect={dropEffect}
        reorderable={reorderable}
        canDrop={canDrop}
        parentPath={parentPath}
      />
    );
  }

  if (!data) {
    return null;
  }

  switch (type) {
    case "doc":
      return (
        <StructureTreeDocNode
          docId={data}
          allowLinkedDocuments={false}
          location={location}
          onDrop={handleDrop}
          reorderable={reorderable}
          canDrop={canDrop}
          dropEffect={dropEffect}
          operations={resolvedOperations}
          parentPath={parentPath}
        />
      );
    case "collection":
      return (
        <StructureTreeCollectionNode
          collectionId={data}
          location={location}
          onDrop={handleDrop}
          canDrop={canDrop}
          reorderable={reorderable}
          dropEffect={dropEffect}
          operations={resolvedOperations}
          parentPath={parentPath}
        />
      );
    case "database":
      return (
        <StructureTreeDatabaseNode
          databaseId={data}
          location={location}
          onDrop={handleDrop}
          canDrop={canDrop}
          reorderable={reorderable}
          dropEffect={dropEffect}
          operations={resolvedOperations}
          parentPath={parentPath}
        />
      );
    case "tag":
      return (
        <StructureTreeTagNode
          tagId={data}
          location={location}
          onDrop={handleDrop}
          canDrop={canDrop}
          reorderable
          dropEffect={dropEffect}
          operations={resolvedOperations}
          parentPath={parentPath}
        />
      );
    default:
      return null;
  }
}

function StructureTreeFolderRow({
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
} & GenericStructureTreeNode) {
  const structureTreeStateService = useService(StructureTreeStateService);
  const { workbench } = useService(WorkbenchService);
  const activeLocation = useLiveData(workbench.location$);
  const active =
    activeLocation.pathname === "/overview" &&
    new URLSearchParams(activeLocation.search).get("folder") === node.id;

  const name = useLiveData(node.name$);
  const children = useLiveData(node.sortedChildren$);
  const path = useMemo(
    () => [...(parentPath ?? []), `folder-${node.id}`],
    [parentPath, node.id],
  );
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));
  const [newFolderId, setNewFolderId] = useState<string | null>(null);

  const setCollapsed = useCallback(
    (nextCollapsed: boolean) => {
      if (nextCollapsed) {
        setNewFolderId(null);
      }
      structureTreeStateService.setCollapsed(path, nextCollapsed);
    },
    [path, structureTreeStateService],
  );

  const handleExpand = useCallback(() => {
    setCollapsed(false);
  }, [setCollapsed]);

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
    (nextName: string) => {
      node.rename(nextName);
    },
    [node],
  );

  const {
    handleDropOnFolder,
    handleDropEffect,
    handleDropOnChildren,
    handleDropEffectOnChildren,
    handleCanDrop,
    handleChildrenCanDrop,
  } = useFolderTreeDnd({
    node,
    canDrop,
    dropEffect,
    onDrop,
    onExpand: handleExpand,
  });

  const finalOperations = useFolderNodeOperations({
    node,
    name,
    children,
    additionalOperations,
    onExpand: handleExpand,
    onSubfolderCreated: setNewFolderId,
  });
  const childOperations = useFolderChildOperations();

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
      setCollapsed={setCollapsed}
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
          operations={childOperations}
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
}
