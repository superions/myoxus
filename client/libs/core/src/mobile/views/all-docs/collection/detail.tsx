import {
  createDocExplorerContext,
  DocExplorerContext,
} from "@myoxus/core/components/explorer/context";
import { DocsExplorer } from "@myoxus/core/components/explorer/docs-view/docs-list";
import {
  EmptyCollectionDetail,
  EmptyDocs,
} from "@myoxus/core/components/myoxus/empty";
import { PageHeader } from "@myoxus/core/mobile/components";
import { Page } from "@myoxus/core/mobile/components/page";
import type { Collection } from "@myoxus/core/modules/collection";
import { ViewLayersIcon } from "@myoxus/icons/react";
import { useLiveData } from "@myoxus/infra";
import {
  Box,
  Group,
  SurfaceListItemIcon,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { useEffect, useState } from "react";

export const DetailHeader = ({ collection }: { collection: Collection }) => {
  const name = useLiveData(collection.name$);
  return (
    <PageHeader back>
      <Group gap={0} miw={0} wrap="nowrap">
        <SurfaceListItemIcon size="md">
          <ViewLayersIcon />
        </SurfaceListItemIcon>
        <SurfaceListText kind="title">{name}</SurfaceListText>
      </Group>
    </PageHeader>
  );
};

const CollectionDocs = ({ collection }: { collection: Collection }) => {
  const [explorerContextValue] = useState(() =>
    createDocExplorerContext({
      quickFavorite: true,
      displayProperties: ["createdAt", "updatedAt", "tags"],
      view: "masonry",
      showDragHandle: false,
      groupBy: undefined,
      orderBy: undefined,
    }),
  );
  const groups = useLiveData(explorerContextValue.groups$);
  const isEmpty =
    groups.length === 0 ||
    (groups.length && groups.every((group) => !group.items.length));

  useEffect(() => {
    const subscription = collection.watch().subscribe({
      next: (result) => {
        explorerContextValue.groups$.next([
          {
            key: "collection",
            items: result,
          },
        ]);
      },
      error: console.error,
    });
    return () => subscription.unsubscribe();
  }, [collection, explorerContextValue.groups$]);

  if (isEmpty) {
    return (
      <>
        <EmptyDocs absoluteCenter />
        <Box flex="1 1 auto" h={0} />
      </>
    );
  }

  return (
    <DocExplorerContext.Provider value={explorerContextValue}>
      <DocsExplorer masonryItemWidthMin={150} />
    </DocExplorerContext.Provider>
  );
};

export const CollectionDetail = ({
  collection,
}: {
  collection: Collection;
}) => {
  const info = useLiveData(collection.info$);
  if (info.allowList.length === 0 && info.rules.filters.length === 0) {
    return (
      <Page header={<DetailHeader collection={collection} />}>
        <Box flex="1 1 auto">
          <EmptyCollectionDetail collection={collection} absoluteCenter />
        </Box>
      </Page>
    );
  }

  return (
    <Page header={<DetailHeader collection={collection} />}>
      <CollectionDocs collection={collection} />
    </Page>
  );
};
