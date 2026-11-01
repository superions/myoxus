import type { NodeOperation } from "@myoxus/core/components/structure-tree";
import {
  type Collection,
  CollectionService,
} from "@myoxus/core/modules/collection";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { ShareDocsListService } from "@myoxus/core/modules/share-doc";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { useI18n } from "@myoxus/i18n";
import { FilterMinusIcon, ViewLayersIcon } from "@myoxus/icons/react";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import track from "@myoxus/track";
import { MenuItem, notify } from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AddItemPlaceholder } from "../../layouts/add-item-placeholder";
import { StructureTreeNode } from "../../tree/node";
import { StructureTreeDocNode } from "../doc";
import {
  useStructureTreeCollectionNodeOperations,
  useStructureTreeCollectionNodeOperationsMenu,
} from "./operations";

const CollectionIcon = () => <ViewLayersIcon />;

export const StructureTreeCollectionNode = ({
  collectionId,
  operations: additionalOperations,
  parentPath,
}: {
  collectionId: string;
  operations?: NodeOperation[];
  parentPath: string[];
}) => {
  const t = useI18n();
  const { globalContextService, collectionService, workspaceDialogService } =
    useServices({
      GlobalContextService,
      CollectionService,
      WorkspaceDialogService,
    });
  const structureTreeStateService = useService(StructureTreeStateService);
  const active =
    useLiveData(globalContextService.globalContext.collectionId.$) ===
    collectionId;
  const path = useMemo(
    () => [...parentPath, `collection-${collectionId}`],
    [parentPath, collectionId],
  );
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));
  const setCollapsed = useCallback(
    (value: boolean) => {
      structureTreeStateService.setCollapsed(path, value);
    },
    [structureTreeStateService, path],
  );

  const collection = useLiveData(collectionService.collection$(collectionId));
  const name = useLiveData(collection?.name$);

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

  const collectionOperations = useStructureTreeCollectionNodeOperationsMenu(
    collectionId,
    handleOpenCollapsed,
    handleEditCollection,
  );
  const { handleAddDocToCollection } = useStructureTreeCollectionNodeOperations(
    collectionId,
    handleOpenCollapsed,
    handleEditCollection,
  );

  const finalOperations = useMemo(() => {
    if (additionalOperations) {
      return [...additionalOperations, ...collectionOperations];
    }
    return collectionOperations;
  }, [additionalOperations, collectionOperations]);

  if (!collection) {
    return null;
  }

  return (
    <StructureTreeNode
      icon={CollectionIcon}
      name={name || t["Untitled"]()}
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      to={`/collection/${collection.id}`}
      active={active}
      operations={finalOperations}
      data-testid={`structure-tree-collection-${collectionId}`}
    >
      <StructureTreeCollectionNodeChildren
        collection={collection}
        onAddDoc={handleAddDocToCollection}
        path={path}
      />
    </StructureTreeNode>
  );
};

const StructureTreeCollectionNodeChildren = ({
  collection,
  onAddDoc,
  path,
}: {
  collection: Collection;
  onAddDoc?: () => void;
  path: string[];
}) => {
  const t = useI18n();
  const { shareDocsListService, collectionService } = useServices({
    ShareDocsListService,
    CollectionService,
  });

  useEffect(() => {
    // TODO(@eyhn): loading & error UI
    shareDocsListService.shareDocs?.revalidate();
  }, [shareDocsListService]);

  const allowList = useLiveData(collection.allowList$);

  const handleRemoveFromAllowList = useCallback(
    (id: string) => {
      track.$.navigationPanel.collections.removeOrganizeItem({ type: "doc" });
      collectionService.removeDocFromCollection(collection.id, id);
      notify.success({
        message: t["com.myoxus.collection.removePage.success"](),
      });
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

  return (
    <>
      {filteredDocIds.map((docId) => (
        <StructureTreeDocNode
          key={docId}
          docId={docId}
          parentPath={path}
          operations={
            allowList
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
      ))}
      <AddItemPlaceholder label={t["New Page"]()} onClick={onAddDoc} />
    </>
  );
};
