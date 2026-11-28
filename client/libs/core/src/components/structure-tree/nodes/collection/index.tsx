// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { allDocsNavigationTo } from "@myoxus/core/modules/all-docs/navigation";
import {
  type Collection,
  CollectionService,
} from "@myoxus/core/modules/collection";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { FilterMinusIcon } from "@myoxus/icons/react";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  AnimatedCollectionsIcon,
  type DropTargetDropEvent,
  type DropTargetOptions,
  MenuItem,
  notify,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  StructureTreeNode,
  type StructureTreeNodeDropEffect,
} from "../../tree";
import type { StructureTreeNodeIcon } from "../../tree/node";
import { StructureTreeDocNode } from "../doc";
import type { GenericStructureTreeNode } from "../types";
import { Empty } from "./empty";
import { useStructureTreeCollectionNodeOperations } from "./operations";

const CollectionIcon: StructureTreeNodeIcon = ({
  className,
  draggedOver,
  treeInstruction,
}) => (
  <AnimatedCollectionsIcon
    className={className}
    closed={!!draggedOver && treeInstruction?.type === "make-child"}
  />
);

export function StructureTreeCollectionNode({
  collectionId,
  onDrop,
  location,
  reorderable,
  operations: additionalOperations,
  canDrop,
  dropEffect,
  parentPath,
}: {
  collectionId: string;
} & GenericStructureTreeNode) {
  const t = useI18n();
  const { globalContextService, workspaceDialogService } = useServices({
    GlobalContextService,
    WorkspaceDialogService,
  });
  const structureTreeStateService = useService(StructureTreeStateService);
  const collectionService = useService(CollectionService);

  const active =
    useLiveData(globalContextService.globalContext.collectionId.$) ===
    collectionId;
  const path = useMemo(
    () => [...(parentPath ?? []), `collection-${collectionId}`],
    [collectionId, parentPath],
  );
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));
  const setCollapsed = useCallback(
    (value: boolean) => {
      structureTreeStateService.setCollapsed(path, value);
    },
    [path, structureTreeStateService],
  );

  const collection = useLiveData(collectionService.collection$(collectionId));
  const name = useLiveData(collection?.name$);

  const dndData = useMemo<MyoxusDNDData>(
    () => ({
      draggable: {
        entity: { type: "collection", id: collectionId },
        from: location,
      },
      dropTarget: { at: "structure-tree:doc" },
    }),
    [collectionId, location],
  );

  const handleRename = useCallback(
    (nextName: string) => {
      if (collection && collection.name$.value !== nextName) {
        collectionService.updateCollection(collectionId, { name: nextName });
        track.$.navigationPanel.organize.renameOrganizeItem({
          type: "collection",
        });
        notify({ title: t["com.myoxus.toastMessage.rename"]() });
      }
    },
    [collection, collectionId, collectionService, t],
  );

  const addDocToCollection = useCallback(
    (docId: string) => {
      if (!collection) {
        return;
      }
      if (collection.allowList$.value.includes(docId)) {
        notify({ title: t["com.myoxus.collection.addPage.alreadyExists"]() });
      } else {
        collectionService.addDocToCollection(collection.id, docId);
      }
    },
    [collection, collectionService, t],
  );

  const handleDropOnCollection = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>) => {
      if (collection && data.treeInstruction?.type === "make-child") {
        if (data.source.data.entity?.type === "doc") {
          addDocToCollection(data.source.data.entity.id);
          track.$.navigationPanel.organize.createOrganizeItem({
            type: "link",
            target: "doc",
            control: "drag",
          });
          track.$.navigationPanel.collections.drop({
            type: data.source.data.entity.type,
          });
        }
        return;
      }
      onDrop?.(data);
    },
    [addDocToCollection, collection, onDrop],
  );

  const handleDropEffectOnCollection = useCallback<StructureTreeNodeDropEffect>(
    (data) => {
      if (collection && data.treeInstruction?.type === "make-child") {
        return data.source.data.entity?.type === "doc" ? "link" : undefined;
      }
      return dropEffect?.(data);
    },
    [collection, dropEffect],
  );

  const handleDropOnPlaceholder = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>) => {
      if (collection && data.source.data.entity?.type === "doc") {
        addDocToCollection(data.source.data.entity.id);
        track.$.navigationPanel.organize.createOrganizeItem({
          type: "collection",
          control: "drag",
        });
      }
    },
    [addDocToCollection, collection],
  );

  const handleOpenCollapsed = useCallback(() => {
    setCollapsed(false);
  }, [setCollapsed]);

  const handleEditCollection = useCallback(() => {
    if (collection) {
      workspaceDialogService.open("collection-editor", {
        collectionId: collection.id,
      });
    }
  }, [collection, workspaceDialogService]);

  const collectionOperations = useStructureTreeCollectionNodeOperations(
    collectionId,
    handleOpenCollapsed,
    handleEditCollection,
  );
  const finalOperations = useMemo(
    () =>
      additionalOperations
        ? [...additionalOperations, ...collectionOperations]
        : collectionOperations,
    [additionalOperations, collectionOperations],
  );

  const handleCanDrop = useMemo<DropTargetOptions<MyoxusDNDData>["canDrop"]>(
    () => (args) =>
      args.treeInstruction?.type !== "make-child"
        ? ((typeof canDrop === "function" ? canDrop(args) : canDrop) ?? true)
        : args.source.data.entity?.type === "doc",
    [canDrop],
  );

  if (!collection) {
    return null;
  }

  return (
    <StructureTreeNode
      icon={CollectionIcon}
      name={name || t["Untitled"]()}
      dndData={dndData}
      onDrop={handleDropOnCollection}
      renameable
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      to={allDocsNavigationTo({
        kind: "collection",
        collectionId: collection.id,
      })}
      active={active}
      canDrop={handleCanDrop}
      reorderable={reorderable}
      onRename={handleRename}
      childrenPlaceholder={<Empty onDrop={handleDropOnPlaceholder} />}
      operations={finalOperations}
      dropEffect={handleDropEffectOnCollection}
      data-testid={`structure-tree-collection-${collectionId}`}
      explorerIconConfig={{ where: "collection", id: collectionId }}
    >
      <StructureTreeCollectionNodeChildren
        collection={collection}
        path={path}
      />
    </StructureTreeNode>
  );
}

function StructureTreeCollectionNodeChildren({
  collection,
  path,
}: {
  collection: Collection;
  path: string[];
}) {
  const t = useI18n();
  const collectionService = useService(CollectionService);
  const allowList = useLiveData(
    collection.allowList$.map((list) => new Set(list)),
  );
  const [filteredDocIds, setFilteredDocIds] = useState<string[]>([]);

  useEffect(() => {
    const subscription = collection.watch().subscribe(setFilteredDocIds);
    return () => subscription.unsubscribe();
  }, [collection]);

  const handleRemoveFromAllowList = useCallback(
    (docId: string) => {
      track.$.navigationPanel.collections.removeOrganizeItem({ type: "doc" });
      collectionService.removeDocFromCollection(collection.id, docId);
      notify({ title: t["com.myoxus.collection.removePage.success"]() });
    },
    [collection.id, collectionService, t],
  );

  return filteredDocIds.map((docId) => (
    <StructureTreeDocNode
      key={docId}
      docId={docId}
      reorderable={false}
      location={{
        at: "structure-tree:collection:filtered-docs",
        collectionId: collection.id,
      }}
      parentPath={path}
      operations={
        allowList.has(docId)
          ? [
              {
                index: 99,
                view: (
                  <MenuItem
                    prefixIcon={<FilterMinusIcon />}
                    onClick={() => handleRemoveFromAllowList(docId)}
                  >
                    {t["Remove special filter"]()}
                  </MenuItem>
                ),
              },
            ]
          : []
      }
    />
  ));
}
