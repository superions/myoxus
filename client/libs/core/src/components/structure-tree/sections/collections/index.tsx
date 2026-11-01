import { useCreateCollection } from "@myoxus/core/components/hooks/use-create-collection";
import { CollectionService } from "@myoxus/core/modules/collection";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { AddCollectionIcon } from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { StructureTreeActionButton } from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import { CollapsibleSection } from "../../layouts/collapsible-section";
import { StructureTreeCollectionNode } from "../../nodes/collection";
import { StructureTreeRoot } from "../../tree";
import { RootEmpty } from "./empty";

export const StructureTreeCollections = () => {
  const t = useI18n();
  const { collectionService, workbenchService, structureTreeStateService } =
    useServices({
      CollectionService,
      WorkbenchService,
      StructureTreeStateService,
    });
  const collections = useLiveData(collectionService.collections$);
  const path = useMemo(() => ["collections"], []);
  const handleCollectionCreated = useCallback(
    (id: string) => {
      workbenchService.workbench.openCollection(id);
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
      actions={
        <StructureTreeActionButton
          data-testid="structure-tree-bar-add-collection-button"
          onClick={handleCreateCollection}
          tooltip={t[
            "com.myoxus.rootAppSidebar.explorer.collection-section-add-tooltip"
          ]()}
        >
          <AddCollectionIcon />
        </StructureTreeActionButton>
      }
    >
      <StructureTreeRoot
        placeholder={<RootEmpty onClickCreate={handleCreateCollection} />}
      >
        {Array.from(collections.values()).map((collection) => (
          <StructureTreeCollectionNode
            key={collection.id}
            collectionId={collection.id}
            reorderable={false}
            location={{
              at: "structure-tree:collection:list",
            }}
            parentPath={path}
          />
        ))}
      </StructureTreeRoot>
    </CollapsibleSection>
  );
};
