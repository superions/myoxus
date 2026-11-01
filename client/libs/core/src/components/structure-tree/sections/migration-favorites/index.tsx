import { DocsService } from "@myoxus/core/modules/doc";
import { MigrationFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { Trans, useI18n } from "@myoxus/i18n";
import { BroomIcon, HelpIcon } from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  StructureTreeActionButton,
  StructureTreeInlineEmphasis,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import { CollapsibleSection } from "../../layouts/collapsible-section";
import { StructureTreeCollectionNode } from "../../nodes/collection";
import { StructureTreeDocNode } from "../../nodes/doc";
import { StructureTreeRoot } from "../../tree";

export const StructureTreeMigrationFavorites = () => {
  const t = useI18n();

  const { migrationFavoriteItemsAdapter, docsService } = useServices({
    MigrationFavoriteItemsAdapter,
    DocsService,
  });

  const docs = useLiveData(docsService.list.docs$);
  const trashDocs = useLiveData(docsService.list.trashDocs$);
  const migrated = useLiveData(migrationFavoriteItemsAdapter.migrated$);
  const { openConfirmModal } = useConfirmModal();
  const path = useMemo(() => ["migration-favorites"], []);

  const favorites = useLiveData(
    migrationFavoriteItemsAdapter.favorites$.map((favs) => {
      return favs.filter((fav) => {
        if (fav.type === "doc") {
          return (
            docs.some((doc) => doc.id === fav.id) &&
            !trashDocs.some((doc) => doc.id === fav.id)
          );
        }
        return true;
      });
    }),
  );

  const handleClickClear = useCallback(() => {
    openConfirmModal({
      title: t["com.myoxus.rootAppSidebar.migration-data.clean-all"](),
      description: (
        <Trans
          i18nKey="com.myoxus.rootAppSidebar.migration-data.clean-all.description"
          components={{
            b: <StructureTreeInlineEmphasis />,
          }}
        />
      ),
      confirmText:
        t["com.myoxus.rootAppSidebar.migration-data.clean-all.confirm"](),
      confirmButtonOptions: {
        variant: "primary",
      },
      cancelText:
        t["com.myoxus.rootAppSidebar.migration-data.clean-all.cancel"](),
      onConfirm() {
        migrationFavoriteItemsAdapter.markFavoritesMigrated();
      },
    });
  }, [migrationFavoriteItemsAdapter, openConfirmModal, t]);

  const handleClickHelp = useCallback(() => {
    openConfirmModal({
      title: t["com.myoxus.rootAppSidebar.migration-data.help"](),
      description: (
        <Trans
          i18nKey="com.myoxus.rootAppSidebar.migration-data.help.description"
          components={{
            b: <StructureTreeInlineEmphasis />,
          }}
        />
      ),
      confirmText: t["com.myoxus.rootAppSidebar.migration-data.help.confirm"](),
      confirmButtonOptions: {
        variant: "primary",
      },
      cancelText:
        t["com.myoxus.rootAppSidebar.migration-data.help.clean-all"](),
      cancelButtonOptions: {
        prefix: <BroomIcon />,
        onClick: () => {
          requestAnimationFrame(() => {
            handleClickClear();
          });
        },
      },
    });
    track.$.navigationPanel.migrationData.openMigrationDataHelp();
  }, [handleClickClear, openConfirmModal, t]);

  if (favorites.length === 0 || migrated) {
    return null;
  }

  return (
    <CollapsibleSection
      path={path}
      migration
      title={t["com.myoxus.rootAppSidebar.migration-data"]()}
      actions={
        <>
          <StructureTreeActionButton
            data-testid="structure-tree-bar-favorite-migration-clear-button"
            onClick={handleClickClear}
          >
            <BroomIcon />
          </StructureTreeActionButton>
          <StructureTreeActionButton
            data-testid="structure-tree-bar-favorite-migration-help-button"
            onClick={handleClickHelp}
          >
            <HelpIcon />
          </StructureTreeActionButton>
        </>
      }
    >
      <StructureTreeRoot>
        {favorites.map((favorite, i) => (
          <StructureTreeMigrationFavoriteNode
            key={favorite.id + ":" + i}
            favorite={favorite}
            parentPath={path}
          />
        ))}
      </StructureTreeRoot>
    </CollapsibleSection>
  );
};

const childLocation = {
  at: "structure-tree:migration-data:list" as const,
};
const StructureTreeMigrationFavoriteNode = ({
  favorite,
  parentPath,
}: {
  favorite: {
    id: string;
    type: "collection" | "doc";
  };
  parentPath: string[];
}) => {
  return favorite.type === "doc" ? (
    <StructureTreeDocNode
      key={favorite.id}
      docId={favorite.id}
      location={childLocation}
      reorderable={false}
      canDrop={false}
      parentPath={parentPath}
    />
  ) : (
    <StructureTreeCollectionNode
      key={favorite.id}
      collectionId={favorite.id}
      location={childLocation}
      reorderable={false}
      canDrop={false}
      parentPath={parentPath}
    />
  );
};
