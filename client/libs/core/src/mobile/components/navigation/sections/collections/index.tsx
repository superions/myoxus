import { useCreateCollection } from "@myoxus/core/components/hooks/use-create-collection";
import { StructureTreeRoot } from "@myoxus/core/components/structure-tree";
import { CollectionService } from "@myoxus/core/modules/collection";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { AddCollectionIcon } from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { useCallback, useMemo } from "react";

import { AddItemPlaceholder } from "../../layouts/add-item-placeholder";
import { CollapsibleSection } from "../../layouts/collapsible-section";
import { StructureTreeCollectionNode } from "../../nodes/collection";

export const StructureTreeCollections = () => {
  const t = useI18n();
  const { collectionService, workbenchService, structureTreeStateService } =
    useServices({
      CollectionService,
      WorkbenchService,
      StructureTreeStateService,
    });
  const path = useMemo(() => ["collections"], []);
  const collectionMetas = useLiveData(collectionService.collectionMetas$);

  const handleCollectionCreated = useCallback(
    (id: string) => {
      workbenchService.workbench.open(`/collection/${encodeURIComponent(id)}`);
      structureTreeStateService.setCollapsed(path, false);
    },
    [path, structureTreeStateService, workbenchService.workbench],
  );
  const handleCreateCollection = useCreateCollection(handleCollectionCreated);

  return (
    <CollapsibleSection
      path={path}
      testId="structure-tree-collections"
      title={t["com.myoxus.rootAppSidebar.collections"]()}
    >
      <StructureTreeRoot>
        {collectionMetas.map((collection) => (
          <StructureTreeCollectionNode
            key={collection.id}
            collectionId={collection.id}
            parentPath={path}
          />
        ))}
        <AddItemPlaceholder
          icon={<AddCollectionIcon />}
          data-testid="structure-tree-bar-add-collection-button"
          label={t["com.myoxus.rootAppSidebar.collection.new"]()}
          onClick={() => handleCreateCollection()}
        />
      </StructureTreeRoot>
    </CollapsibleSection>
  );
};
