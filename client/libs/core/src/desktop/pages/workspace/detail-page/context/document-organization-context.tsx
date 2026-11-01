// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CollectionService } from "@myoxus/core/modules/collection";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { OrganizeService } from "@myoxus/core/modules/organize";
import { useI18n } from "@myoxus/i18n";
import { CollectionsIcon, FavoriteIcon, FolderIcon } from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import {
  Group,
  SettingsDefinitionItem,
  SettingsDefinitionList,
} from "@myoxus/ui-facade";
import { type ReactNode, useMemo } from "react";

function FactLabel({ children, icon }: { children: string; icon: ReactNode }) {
  return (
    <Group gap="xs" wrap="nowrap">
      {icon}
      {children}
    </Group>
  );
}

export function DocumentOrganizationContext({ docId }: { docId: string }) {
  const t = useI18n();
  const {
    collectionService,
    compatibleFavoriteItemsAdapter: favoriteAdapter,
    organizeService,
  } = useServices({
    CollectionService,
    CompatibleFavoriteItemsAdapter,
    OrganizeService,
  });
  const folderPath$ = useMemo(
    () => organizeService.folderTree.folderPathNamesForLinkedDoc$(docId),
    [docId, organizeService.folderTree],
  );
  const collections$ = useMemo(
    () => collectionService.collectionsForDoc$(docId),
    [collectionService, docId],
  );
  const favorite$ = useMemo(
    () => favoriteAdapter.isFavorite$(docId, "doc"),
    [docId, favoriteAdapter],
  );
  const folderPath = useLiveData(folderPath$);
  const collections = useLiveData(collections$);
  const favorite = useLiveData(favorite$);
  const notSet = t["com.myoxus.document-metadata.value.not-set"]();

  return (
    <SettingsDefinitionList data-testid="document-context-organization">
      <SettingsDefinitionItem
        label={
          <FactLabel icon={<FolderIcon />}>
            {t["com.myoxus.m.selector.where-folder"]()}
          </FactLabel>
        }
      >
        {folderPath.length ? folderPath.join(" / ") : notSet}
      </SettingsDefinitionItem>
      <SettingsDefinitionItem
        label={
          <FactLabel icon={<CollectionsIcon />}>
            {t["com.myoxus.m.selector.type-collection"]()}
          </FactLabel>
        }
      >
        {collections.length
          ? collections.map((collection) => collection.name).join(", ")
          : notSet}
      </SettingsDefinitionItem>
      <SettingsDefinitionItem
        label={<FactLabel icon={<FavoriteIcon />}>{t["Favorite"]()}</FactLabel>}
      >
        {favorite
          ? t["com.myoxus.document-context.yes"]()
          : t["com.myoxus.document-context.no"]()}
      </SettingsDefinitionItem>
    </SettingsDefinitionList>
  );
}
