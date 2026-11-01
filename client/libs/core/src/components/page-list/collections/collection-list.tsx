// SPDX-License-Identifier: AGPL-3.0-or-later

import { CollectionOperations } from "@myoxus/core/components/page-list/view";
import { allDocsNavigationTo } from "@myoxus/core/modules/all-docs/navigation";
import {
  type Collection,
  CollectionService,
} from "@myoxus/core/modules/collection";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { MoreVerticalIcon, ViewLayersIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Group,
  IconButton,
  SurfaceListItemFrame,
  SurfaceListItemIcon,
  SurfaceListText,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
} from "@myoxus/ui-facade";
import { memo } from "react";

const CollectionRow = memo(function CollectionRow({
  collection,
}: {
  collection: Collection;
}) {
  const t = useI18n();
  const name = useLiveData(collection.name$);
  const rules = useLiveData(collection.rules$);
  const selectedDocs = useLiveData(collection.allowList$);
  const numberFormatter = new Intl.NumberFormat(t.language);

  return (
    <TableRow
      data-collection-id={collection.id}
      data-myoxus-ui-role="all-collections-row"
    >
      <TableCell>
        <SurfaceListItemFrame
          component={WorkbenchLink}
          data-myoxus-ui-role="all-collections-row-link"
          data-testid="collection-list-item"
          to={allDocsNavigationTo({
            kind: "collection",
            collectionId: collection.id,
          })}
        >
          <Group wrap="nowrap">
            <SurfaceListItemIcon size="md">
              <ViewLayersIcon />
            </SurfaceListItemIcon>
            <SurfaceListText kind="title" truncate={false}>
              {name?.trim() || t["Untitled"]()}
            </SurfaceListText>
          </Group>
        </SurfaceListItemFrame>
      </TableCell>
      <TableCell>
        {numberFormatter.format(rules?.filters.length ?? 0)}
      </TableCell>
      <TableCell>{numberFormatter.format(selectedDocs?.length ?? 0)}</TableCell>
      <TableCell>
        <CollectionOperations collection={collection}>
          <IconButton
            aria-label={t["com.myoxus.common.open-menu"]()}
            data-testid="collection-item-operation-button"
            icon={<MoreVerticalIcon />}
          />
        </CollectionOperations>
      </TableCell>
    </TableRow>
  );
});

export const CollectionList = () => {
  const t = useI18n();
  const collections = useLiveData(useService(CollectionService).collections$);

  return (
    <TableScrollContainer containInlineSize>
      <Table highlightOnHover data-myoxus-ui-role="all-collections-table">
        <TableHeader>
          <TableRow>
            <TableHead>{t["com.myoxus.editCollectionName.name"]()}</TableHead>
            <TableHead>{t["com.myoxus.editCollection.rules"]()}</TableHead>
            <TableHead>
              {t["com.myoxus.editCollection.rules.include.title"]()}
            </TableHead>
            <TableHead aria-label={t["com.myoxus.actions"]()} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from(collections.values()).map((collection) => (
            <CollectionRow key={collection.id} collection={collection} />
          ))}
        </TableBody>
      </Table>
    </TableScrollContainer>
  );
};
