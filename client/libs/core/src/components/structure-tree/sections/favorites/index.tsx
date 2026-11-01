import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import {
  FavoriteService,
  type FavoriteSupportTypeUnion,
  isFavoriteSupportType,
} from "@myoxus/core/modules/favorite";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { inferOpenMode } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import { PlusIcon } from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  type DropTargetDropEvent,
  StructureTreeActionButton,
  useDropTarget,
} from "@myoxus/ui-facade";
import { type MouseEventHandler, useCallback, useMemo } from "react";

import { CollapsibleSection } from "../../layouts/collapsible-section";
import { StructureTreeCollectionNode } from "../../nodes/collection";
import { StructureTreeDatabaseNode } from "../../nodes/database";
import { StructureTreeDocNode } from "../../nodes/doc";
import { StructureTreeFolderNode } from "../../nodes/folder";
import { StructureTreeTagNode } from "../../nodes/tag";
import { DropEffect, StructureTreeRoot } from "../../tree";
import {
  favoriteChildrenCanDrop,
  favoriteChildrenDropEffect,
  favoriteRootCanDrop,
  favoriteRootDropEffect,
} from "./dnd";
import { RootEmpty } from "./empty";

export const StructureTreeFavorites = () => {
  const { favoriteService, workspaceService, structureTreeStateService } =
    useServices({
      FavoriteService,
      WorkspaceService,
      StructureTreeStateService,
    });

  const path = useMemo(() => ["favorites"], []);

  const favorites = useLiveData(favoriteService.favoriteList.sortedList$);

  const isLoading = useLiveData(favoriteService.favoriteList.isLoading$);

  const t = useI18n();

  const { createPage } = usePageHelper(
    workspaceService.workspace.docCollection,
  );

  const handleDrop = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>) => {
      if (
        data.source.data.entity?.type &&
        isFavoriteSupportType(data.source.data.entity.type)
      ) {
        favoriteService.favoriteList.add(
          data.source.data.entity.type,
          data.source.data.entity.id,
          favoriteService.favoriteList.indexAt("before"),
        );
        track.$.navigationPanel.organize.toggleFavorite({
          type: data.source.data.entity.type,
          on: true,
        });
        track.$.navigationPanel.favorites.drop({
          type: data.source.data.entity.type,
        });
        structureTreeStateService.setCollapsed(path, false);
      }
    },
    [structureTreeStateService, favoriteService.favoriteList, path],
  );

  const handleCreateNewFavoriteDoc: MouseEventHandler = useCallback(
    (e) => {
      const newDoc = createPage(undefined, { at: inferOpenMode(e) });
      favoriteService.favoriteList.add(
        "doc",
        newDoc.id,
        favoriteService.favoriteList.indexAt("before"),
      );
      structureTreeStateService.setCollapsed(path, false);
    },
    [createPage, structureTreeStateService, favoriteService.favoriteList, path],
  );

  const handleOnChildrenDrop = useCallback(
    (
      favorite: { id: string; type: FavoriteSupportTypeUnion },
      data: DropTargetDropEvent<MyoxusDNDData>,
    ) => {
      if (
        data.treeInstruction?.type === "reorder-above" ||
        data.treeInstruction?.type === "reorder-below"
      ) {
        if (
          data.source.data.from?.at === "structure-tree:favorite:list" &&
          data.source.data.entity?.type &&
          isFavoriteSupportType(data.source.data.entity.type)
        ) {
          // is reordering
          favoriteService.favoriteList.reorder(
            data.source.data.entity.type,
            data.source.data.entity.id,
            favoriteService.favoriteList.indexAt(
              data.treeInstruction?.type === "reorder-above"
                ? "before"
                : "after",
              favorite,
            ),
          );
          track.$.navigationPanel.organize.orderOrganizeItem({
            type: data.source.data.entity.type,
          });
        } else if (
          data.source.data.entity?.type &&
          isFavoriteSupportType(data.source.data.entity.type)
        ) {
          favoriteService.favoriteList.add(
            data.source.data.entity.type,
            data.source.data.entity.id,
            favoriteService.favoriteList.indexAt(
              data.treeInstruction?.type === "reorder-above"
                ? "before"
                : "after",
              favorite,
            ),
          );
          track.$.navigationPanel.organize.toggleFavorite({
            type: data.source.data.entity.type,
            on: true,
          });
          track.$.navigationPanel.favorites.drop({
            type: data.source.data.entity.type,
          });
        } else {
          return; // not supported
        }
      }
    },
    [favoriteService],
  );

  const { dropTargetRef, draggedOverDraggable, draggedOverPosition } =
    useDropTarget<MyoxusDNDData>(
      () => ({
        data: {
          at: "structure-tree:favorite:root",
        },
        onDrop: handleDrop,
        canDrop: favoriteRootCanDrop,
        allowExternal: true,
      }),
      [handleDrop],
    );

  return (
    <CollapsibleSection
      path={path}
      title={t["com.myoxus.rootAppSidebar.favorites"]()}
      headerRef={dropTargetRef}
      testId="structure-tree-favorites"
      headerTestId="structure-tree-favorite-category-divider"
      actions={
        <>
          <StructureTreeActionButton
            data-testid="structure-tree-bar-add-favorite-button"
            data-event-props="$.navigationPanel.favorites.createDoc"
            data-event-args-control="addFavorite"
            onClick={handleCreateNewFavoriteDoc}
            onAuxClick={handleCreateNewFavoriteDoc}
            tooltip={t[
              "com.myoxus.rootAppSidebar.explorer.fav-section-add-tooltip"
            ]()}
          >
            <PlusIcon />
          </StructureTreeActionButton>
          {draggedOverDraggable && (
            <DropEffect
              position={draggedOverPosition}
              dropEffect={favoriteRootDropEffect({
                source: draggedOverDraggable,
                treeInstruction: null,
              })}
            />
          )}
        </>
      }
    >
      <StructureTreeRoot
        placeholder={<RootEmpty onDrop={handleDrop} isLoading={isLoading} />}
      >
        {favorites.map((favorite) => (
          <StructureTreeFavoriteNode
            key={`${favorite.type}:${favorite.id}`}
            favorite={favorite}
            onDrop={handleOnChildrenDrop}
            parentPath={path}
          />
        ))}
      </StructureTreeRoot>
    </CollapsibleSection>
  );
};

const childLocation = {
  at: "structure-tree:favorite:list" as const,
};
const StructureTreeFavoriteNode = ({
  favorite,
  onDrop,
  parentPath,
}: {
  favorite: {
    id: string;
    type: FavoriteSupportTypeUnion;
  };
  parentPath: string[];
  onDrop: (
    favorite: {
      id: string;
      type: FavoriteSupportTypeUnion;
    },
    data: DropTargetDropEvent<MyoxusDNDData>,
  ) => void;
}) => {
  const handleOnChildrenDrop = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>) => {
      onDrop(favorite, data);
    },
    [favorite, onDrop],
  );
  return favorite.type === "doc" ? (
    <StructureTreeDocNode
      key={favorite.id}
      docId={favorite.id}
      location={childLocation}
      onDrop={handleOnChildrenDrop}
      dropEffect={favoriteChildrenDropEffect}
      canDrop={favoriteChildrenCanDrop}
      parentPath={parentPath}
    />
  ) : favorite.type === "database" ? (
    <StructureTreeDatabaseNode
      key={favorite.id}
      databaseId={favorite.id}
      location={childLocation}
      onDrop={handleOnChildrenDrop}
      dropEffect={favoriteChildrenDropEffect}
      canDrop={favoriteChildrenCanDrop}
      parentPath={parentPath}
    />
  ) : favorite.type === "tag" ? (
    <StructureTreeTagNode
      key={favorite.id}
      tagId={favorite.id}
      location={childLocation}
      onDrop={handleOnChildrenDrop}
      dropEffect={favoriteChildrenDropEffect}
      canDrop={favoriteChildrenCanDrop}
      parentPath={parentPath}
    />
  ) : favorite.type === "folder" ? (
    <StructureTreeFolderNode
      key={favorite.id}
      nodeId={favorite.id}
      location={childLocation}
      onDrop={handleOnChildrenDrop}
      dropEffect={favoriteChildrenDropEffect}
      canDrop={favoriteChildrenCanDrop}
      parentPath={parentPath}
    />
  ) : (
    <StructureTreeCollectionNode
      key={favorite.id}
      collectionId={favorite.id}
      location={childLocation}
      onDrop={handleOnChildrenDrop}
      dropEffect={favoriteChildrenDropEffect}
      canDrop={favoriteChildrenCanDrop}
      parentPath={parentPath}
    />
  );
};
