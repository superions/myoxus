// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useCreateCollection } from "@myoxus/core/components/hooks/use-create-collection";
import { CollectionList } from "@myoxus/core/components/page-list";
import { allDocsNavigationTo } from "@myoxus/core/modules/all-docs/navigation";
import { ViewService } from "@myoxus/core/modules/workbench";
import {
  ViewIcon,
  ViewTitle,
} from "@myoxus/core/modules/workbench/view/view-meta";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { PageContentRail } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { CollectionService } from "../../../../modules/collection";
import { ViewBody, ViewHeader } from "../../../../modules/workbench";
import { EmptyCollectionList } from "../page-list-empty";
import { AllCollectionHeader } from "./header";

export function AllCollection() {
  const t = useI18n();
  const collectionService = useService(CollectionService);
  const collections = useLiveData(collectionService.collections$);
  const view = useService(ViewService).view;

  const handleCollectionCreated = useCallback(
    (collectionId: string) =>
      view.push(allDocsNavigationTo({ kind: "collection", collectionId })),
    [view],
  );
  const handleCreateCollection = useCreateCollection(handleCollectionCreated);

  return (
    <>
      <ViewTitle title={t["Collections"]()} />
      <ViewIcon icon="collection" />
      <ViewHeader>
        <AllCollectionHeader onCreateCollection={handleCreateCollection} />
      </ViewHeader>
      <ViewBody>
        <PageContentRail
          fill
          scroll
          spacious
          width="wide"
          data-myoxus-ui-role="all-collections-content-rail"
        >
          {collections.size > 0 ? (
            <CollectionList />
          ) : (
            <EmptyCollectionList heading={null} showAction={false} />
          )}
        </PageContentRail>
      </ViewBody>
    </>
  );
}

export function Component() {
  return <AllCollection />;
}
