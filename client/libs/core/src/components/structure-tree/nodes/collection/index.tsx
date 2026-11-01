import {
  type Collection,
  CollectionService,
} from "@myoxus/core/modules/collection";
import { allDocsNavigationTo } from "@myoxus/core/modules/all-docs/navigation";
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

export const StructureTreeCollectionNode = ({
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
} & GenericStructureTreeNode) => {
  const t = useI18n();
  const { globalContextService, workspaceDialogService } = useServices({
    GlobalContextService,
    WorkspaceDialogService,
  });
  const structureTreeStateService = useService(StructureTreeStateService);
  const active =
    useLiveData(globalContextService.globalContext.collectionId.$) ===
    collectionId;
  const path = useMemo(
    () => [...(parentPath ?? []), `collection-${collectionId}`],
    [parentPath, collectionId],
  );
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));
  const setCollapsed = useCallback(
    (value: boolean) => {
      structureTreeStateService.setCollapsed(path, value);
    },
    [structureTreeStateService, path],
  );

  const collectionService = useService(CollectionService);
  const collection = useLiveData(collectionService.collection$(collectionId));
  const name = useLiveData(collection?.name$);

  const dndData = useMemo(() => {
    return {
      draggable: {
        entity: {
          type: "collection",
          id: collectionId,
        },
        from: location,
      },
      dropTarget: {
        at: "structure-tree:doc",
      },
    } satisfies MyoxusDNDData;
  }, [collectionId, location]);

  const handleRename = useCallback(
    (name: string) => {
      if (collection && collection.name$.value !== name) {
        collectionService.updateCollection(collectionId, {
          name,
        });

        track.$.navigationPanel.organize.renameOrganizeItem({
          type: "collection",
        });
        notify({ title: t["com.myoxus.toastMessage.rename"]() });
      }
    },
    [collection, collectionId, collectionService, t],
  );

  const handleAddDocToCollection = useCallback(
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
          handleAddDocToCollection(data.source.data.entity.id);
          track.$.navigationPanel.organize.createOrganizeItem({
            type: "link",
            target: "doc",
            control: "drag",
          });
          track.$.navigationPanel.collections.drop({
            type: data.source.data.entity.type,
          });
        }
      } else {
        onDrop?.(data);
      }
    },
    [collection, onDrop, handleAddDocToCollection],
  );

  const handleDropEffectOnCollection = useCallback<StructureTreeNodeDropEffect>(
    (data) => {
      if (collection && data.treeInstruction?.type === "make-child") {
        if (data.source.data.entity?.type === "doc") {
          return "link";
        }
      } else {
        return dropEffect?.(data);
      }
      return;
    },
    [collection, dropEffect],
  );

  const handleDropOnPlaceholder = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>) => {
      if (collection && data.source.data.entity?.type === "doc") {
        handleAddDocToCollection(data.source.data.entity.id);
        track.$.navigationPanel.organize.createOrganizeItem({
          type: "collection",
          control: "drag",
        });
      }
    },
    [collection, handleAddDocToCollection],
  );

  const handleOpenCollapsed = useCallback(() => {
    setCollapsed(false);
  }, [setCollapsed]);

  const handleEditCollection = useCallback(() => {
    if (!collection) {
      return;
    }
    workspaceDialogService.open("collection-editor", {
      collectionId: collection.id,
    });
  }, [collection, workspaceDialogService]);

  const collectionOperations = useStructureTreeCollectionNodeOperations(
    collectionId,
    handleOpenCollapsed,
    handleEditCollection,
  );

  const finalOperations = useMemo(() => {
    if (additionalOperations) {
      return [...additionalOperations, ...collectionOperations];
    }
    return collectionOperations;
  }, [collectionOperations, additionalOperations]);

  const handleCanDrop = useMemo<DropTargetOptions<MyoxusDNDData>["canDrop"]>(
    () => (args) => {
      const entityType = args.source.data.entity?.type;
      return args.treeInstruction?.type !== "make-child"
        ? ((typeof canDrop === "function" ? canDrop(args) : canDrop) ?? true)
        : entityType === "doc";
    },
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
      explorerIconConfig={{
        where: "collection",
        id: collectionId,
      }}
    >
      <StructureTreeCollectionNodeChildren
        collection={collection}
        path={path}
      />
    </StructureTreeNode>
  );
};

const StructureTreeCollectionNodeChildren = ({
  collection,
  path,
}: {
  collection: Collection;
  path: string[];
}) => {
  const t = useI18n();
  const { collectionService } = useServices({
    CollectionService,
  });

  const allowList = useLiveData(
    collection.allowList$.map((list) => new Set(list)),
  );

  const handleRemoveFromAllowList = useCallback(
    (id: string) => {
      track.$.navigationPanel.collections.removeOrganizeItem({ type: "doc" });
      collectionService.removeDocFromCollection(collection.id, id);
      notify({ title: t["com.myoxus.collection.removePage.success"]() });
    },
    [collection.id, collectionService, t],
  );

  const [filteredDocIds, setFilteredDocIds] = useState<string[]>([]);

  useEffect(() => {
    const subscription = collection.watch().subscribe((docIds) => {
      setFilteredDocIds(docIds);
    });

    return () => subscription.unsubscribe();
  }, [collection]);

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
};
