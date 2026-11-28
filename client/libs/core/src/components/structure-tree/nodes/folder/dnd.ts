// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { FolderLinkType, FolderNode } from "@myoxus/core/modules/organize";
import type { MyoxusDNDData, MyoxusDNDEntity } from "@myoxus/core/types/dnd";
import { track } from "@myoxus/track";
import type { DropTargetDropEvent, DropTargetOptions } from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import type { StructureTreeNodeDropEffect } from "../../tree";

export type DraggableFolderLinkType = Extract<
  FolderLinkType,
  MyoxusDNDEntity["type"]
>;

export function isFolderLinkEntity(
  type: string | undefined,
): type is DraggableFolderLinkType {
  return (
    type === "collection" ||
    type === "database" ||
    type === "doc" ||
    type === "tag"
  );
}

function isSelfOrAncestor(node: FolderNode, folderId: string): boolean {
  return node.id === folderId || node.beChildOf(folderId);
}

function resolveEntityDropEffect(
  node: FolderNode,
  data:
    | DropTargetDropEvent<MyoxusDNDData>
    | Parameters<StructureTreeNodeDropEffect>[0],
): "move" | "link" | undefined {
  const entity = data.source.data.entity;
  if (entity?.type === "folder") {
    return isSelfOrAncestor(node, entity.id) ? undefined : "move";
  }
  if (data.source.data.from?.at === "structure-tree:organize:folder-node") {
    return "move";
  }
  if (isFolderLinkEntity(entity?.type)) {
    return "link";
  }
  return undefined;
}

function canAcceptEntityInFolder(
  node: FolderNode,
  args: { source: { data: MyoxusDNDData["draggable"] } },
): boolean {
  const entity = args.source.data.entity;
  if (entity?.type === "folder") {
    return !isSelfOrAncestor(node, entity.id);
  }
  if (args.source.data.from?.at === "structure-tree:organize:folder-node") {
    return true;
  }
  return isFolderLinkEntity(entity?.type);
}

function placeDroppedEntity(
  node: FolderNode,
  data: DropTargetDropEvent<MyoxusDNDData>,
  position: "before" | "after",
  anchorNodeId?: string,
) {
  const entity = data.source.data.entity;
  const targetIndex = node.indexAt(position, anchorNodeId);
  if (entity?.type === "folder") {
    if (isSelfOrAncestor(node, entity.id)) {
      return;
    }
    node.moveHere(entity.id, targetIndex);
    track.$.navigationPanel.organize.moveOrganizeItem({ type: "folder" });
    return;
  }
  if (!isFolderLinkEntity(entity?.type)) {
    return;
  }
  if (data.source.data.from?.at === "structure-tree:organize:folder-node") {
    node.moveHere(data.source.data.from.nodeId, targetIndex);
    track.$.navigationPanel.organize.moveOrganizeItem({
      type: "link",
      target: entity.type,
    });
    return;
  }
  node.createLink(entity.type, entity.id, targetIndex);
  track.$.navigationPanel.organize.createOrganizeItem({
    type: "link",
    target: entity.type,
  });
}

export function useFolderTreeDnd({
  node,
  canDrop,
  dropEffect,
  onDrop,
  onExpand,
}: {
  node: FolderNode;
  canDrop?: DropTargetOptions<MyoxusDNDData>["canDrop"];
  dropEffect?: StructureTreeNodeDropEffect;
  onDrop?: (data: DropTargetDropEvent<MyoxusDNDData>) => void;
  onExpand: () => void;
}) {
  const handleDropOnFolder = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>) => {
      const entityType = data.source.data.entity?.type;
      if (entityType) {
        track.$.navigationPanel.folders.drop({ type: entityType });
      }
      if (data.treeInstruction?.type === "make-child") {
        placeDroppedEntity(node, data, "before");
        onExpand();
        return;
      }
      onDrop?.(data);
    },
    [node, onDrop, onExpand],
  );

  const handleDropEffect = useCallback<StructureTreeNodeDropEffect>(
    (data) => {
      if (data.treeInstruction?.type === "make-child") {
        return resolveEntityDropEffect(node, data);
      }
      return dropEffect?.(data);
    },
    [dropEffect, node],
  );

  const handleDropOnChildren = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>, dropAtNode?: FolderNode) => {
      if (!dropAtNode?.id) {
        return;
      }
      const entityType = data.source.data.entity?.type;
      if (entityType) {
        track.$.navigationPanel.folders.drop({ type: entityType });
      }
      const instruction = data.treeInstruction;
      if (
        instruction?.type === "reorder-above" ||
        instruction?.type === "reorder-below"
      ) {
        placeDroppedEntity(
          node,
          data,
          instruction.type === "reorder-below" ? "after" : "before",
          dropAtNode.id,
        );
        return;
      }
      if (instruction?.type === "reparent") {
        if (instruction.currentLevel === instruction.desiredLevel + 1) {
          onDrop?.({
            ...data,
            treeInstruction: {
              type: "reorder-below",
              currentLevel: instruction.currentLevel,
              indentPerLevel: instruction.indentPerLevel,
            },
          });
        } else {
          onDrop?.({
            ...data,
            treeInstruction: {
              ...instruction,
              currentLevel: instruction.currentLevel - 1,
            },
          });
        }
      }
    },
    [node, onDrop],
  );

  const handleDropEffectOnChildren = useCallback<StructureTreeNodeDropEffect>(
    (data) => {
      const instruction = data.treeInstruction;
      if (
        instruction?.type === "reorder-above" ||
        instruction?.type === "reorder-below"
      ) {
        return resolveEntityDropEffect(node, data);
      }
      if (instruction?.type === "reparent") {
        if (instruction.currentLevel === instruction.desiredLevel + 1) {
          return dropEffect?.({
            ...data,
            treeInstruction: {
              type: "reorder-below",
              currentLevel: instruction.currentLevel,
              indentPerLevel: instruction.indentPerLevel,
            },
          });
        }
        return dropEffect?.({
          ...data,
          treeInstruction: {
            ...instruction,
            currentLevel: instruction.currentLevel - 1,
          },
        });
      }
      return undefined;
    },
    [dropEffect, node],
  );

  const handleCanDrop = useMemo<DropTargetOptions<MyoxusDNDData>["canDrop"]>(
    () => (args) => {
      if (args.treeInstruction && args.treeInstruction.type !== "make-child") {
        return (
          (typeof canDrop === "function" ? canDrop(args) : canDrop) ?? true
        );
      }
      return canAcceptEntityInFolder(node, args);
    },
    [canDrop, node],
  );

  const handleChildrenCanDrop = useMemo<
    DropTargetOptions<MyoxusDNDData>["canDrop"]
  >(() => (args) => canAcceptEntityInFolder(node, args), [node]);

  return {
    handleDropOnFolder,
    handleDropEffect,
    handleDropOnChildren,
    handleDropEffectOnChildren,
    handleCanDrop,
    handleChildrenCanDrop,
  };
}
