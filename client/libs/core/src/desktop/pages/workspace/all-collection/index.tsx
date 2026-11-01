/**
 * All-collections page — lists all saved collections in the workspace.
 *
 * Displays a native Mantine table through the shared Facade. When no
 * collections exist, an `<EmptyCollectionList>` placeholder is shown below the
 * shared header.
 *
 * The "Create collection" action opens a prompt modal asking for a name, then
 * calls `CollectionService.createCollection` and navigates directly to the new
 * collection target inside the canonical All Docs explorer.
 *
 * Creation stays in the workbench header in every list state. This avoids the
 * previous duplicate page heading and competing in-list create action.
 */

import { useCreateCollection } from "@myoxus/core/components/hooks/use-create-collection";
import { CollectionList } from "@myoxus/core/components/page-list";
import { allDocsNavigationTo } from "@myoxus/core/modules/all-docs/navigation";
import {
  ViewIcon,
  ViewTitle,
} from "@myoxus/core/modules/workbench/view/view-meta";
import { ViewService } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { PageContentRail } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { CollectionService } from "../../../../modules/collection";
import { ViewBody, ViewHeader } from "../../../../modules/workbench";
import { EmptyCollectionList } from "../page-list-empty";
import { AllCollectionHeader } from "./header";

/**
 * All-collections workbench view component.
 *
 * Shows the full list of workspace collections. Supports creating collections
 * via the single shared header action.
 */
export const AllCollection = () => {
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
};

export const Component = () => {
  return <AllCollection />;
};
