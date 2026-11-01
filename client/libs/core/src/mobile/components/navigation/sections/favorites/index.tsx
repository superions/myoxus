import { StructureTreeRoot } from "@myoxus/core/components/structure-tree";
import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import {
  FavoriteService,
  type FavoriteSupportTypeUnion,
} from "@myoxus/core/modules/favorite";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useServices } from "@myoxus/infra";
import { useCallback, useMemo } from "react";

import { AddItemPlaceholder } from "../../layouts/add-item-placeholder";
import { CollapsibleSection } from "../../layouts/collapsible-section";
import { StructureTreeCollectionNode } from "../../nodes/collection";
import { StructureTreeDatabaseNode } from "../../nodes/database";
import { StructureTreeDocNode } from "../../nodes/doc";
import { StructureTreeFolderNode } from "../../nodes/folder";
import { StructureTreeTagNode } from "../../nodes/tag";

export const StructureTreeFavorites = () => {
  const { favoriteService, workspaceService, structureTreeStateService } =
    useServices({
      FavoriteService,
      WorkspaceService,
      StructureTreeStateService,
    });

  const t = useI18n();
  const path = useMemo(() => ["favorites"], []);
  const favorites = useLiveData(favoriteService.favoriteList.sortedList$);
  const isLoading = useLiveData(favoriteService.favoriteList.isLoading$);
  const { createPage } = usePageHelper(
    workspaceService.workspace.docCollection,
  );

  const handleCreateNewFavoriteDoc = useCallback(() => {
    const newDoc = createPage();
    favoriteService.favoriteList.add(
      "doc",
      newDoc.id,
      favoriteService.favoriteList.indexAt("before"),
    );
    structureTreeStateService.setCollapsed(path, false);
  }, [
    createPage,
    favoriteService.favoriteList,
    structureTreeStateService,
    path,
  ]);

  return (
    <CollapsibleSection
      path={path}
      title={t["com.myoxus.rootAppSidebar.favorites"]()}
      testId="structure-tree-favorites"
      headerTestId="structure-tree-favorite-category-divider"
    >
      <StructureTreeRoot placeholder={isLoading ? "Loading" : null}>
        {favorites.map((favorite) => (
          <FavoriteNode
            key={`${favorite.type}:${favorite.id}`}
            favorite={favorite}
            parentPath={path}
          />
        ))}
        <AddItemPlaceholder
          data-testid="structure-tree-bar-add-favorite-button"
          data-event-props="$.navigationPanel.favorites.createDoc"
          data-event-args-control="addFavorite"
          onClick={handleCreateNewFavoriteDoc}
          label={t["New Page"]()}
        />
      </StructureTreeRoot>
    </CollapsibleSection>
  );
};

export const FavoriteNode = ({
  favorite,
  parentPath,
}: {
  favorite: {
    id: string;
    type: FavoriteSupportTypeUnion;
  };
  parentPath: string[];
}) => {
  return favorite.type === "doc" ? (
    <StructureTreeDocNode docId={favorite.id} parentPath={parentPath} />
  ) : favorite.type === "database" ? (
    <StructureTreeDatabaseNode
      databaseId={favorite.id}
      parentPath={parentPath}
    />
  ) : favorite.type === "tag" ? (
    <StructureTreeTagNode tagId={favorite.id} parentPath={parentPath} />
  ) : favorite.type === "folder" ? (
    <StructureTreeFolderNode nodeId={favorite.id} parentPath={parentPath} />
  ) : (
    <StructureTreeCollectionNode
      collectionId={favorite.id}
      parentPath={parentPath}
    />
  );
};
