import { getDatabaseWorkspaceAvailability } from "@myoxus/core/modules/database/availability";
import { FavoriteService } from "@myoxus/core/modules/favorite";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  DatabasePageActionsProvider,
  DatabasePageMenuItems,
  type DatabasePageRecord,
  useDatabasePage,
  useDatabasePageActions,
  WorkspacePageMoveDialog,
} from "@myoxus/core/modules/workspace-pages";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import {
  DatabaseSystemRole,
  WorkspaceContentResourceKindType,
} from "@myoxus/graphql";
import { DatabaseIcon } from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { StructureTreeLoading } from "@myoxus/ui-facade";
import { useMemo, useState } from "react";

import { WorkspaceContentOperationMenuItems } from "../../../workspace-content-operation/menu-items";
import { StructureTreeNode } from "../../tree";
import type { StructureTreeNodeIcon } from "../../tree/node";
import type { GenericStructureTreeNode } from "../types";

const StructureTreeDatabaseIcon: StructureTreeNodeIcon = ({ className }) => (
  <DatabaseIcon className={className} />
);

export function StructureTreeDatabaseNode(
  props: { databaseId: string } & GenericStructureTreeNode,
) {
  return (
    <DatabasePageActionsProvider>
      <StructureTreeDatabaseNodeContent {...props} />
    </DatabasePageActionsProvider>
  );
}

function StructureTreeDatabaseNodeContent({
  databaseId,
  operations: additionalOperations,
  parentPath,
  ...treeProps
}: { databaseId: string } & GenericStructureTreeNode) {
  const { workspaceService } = useServices({
    WorkspaceService,
  });
  const workspaceId = getDatabaseWorkspaceAvailability(
    workspaceService.workspace,
  ).serverWorkspaceId;
  const { record: database, reload } = useDatabasePage(workspaceId, databaseId);

  if (database === undefined) return <StructureTreeLoading />;
  if (
    database === null ||
    !workspaceId ||
    database.systemRole === DatabaseSystemRole.WorkspaceTasks
  )
    return null;

  return (
    <StructureTreeDatabaseNodeReady
      {...treeProps}
      additionalOperations={additionalOperations}
      database={database}
      onInventoryChanged={reload}
      parentPath={parentPath}
      workspaceId={workspaceId}
    />
  );
}

function StructureTreeDatabaseNodeReady({
  additionalOperations,
  canDrop,
  database,
  dropEffect,
  location,
  onDrop,
  onInventoryChanged,
  parentPath,
  reorderable,
  workspaceId,
}: Omit<GenericStructureTreeNode, "operations"> & {
  additionalOperations?: GenericStructureTreeNode["operations"];
  database: DatabasePageRecord;
  onInventoryChanged: () => void;
  workspaceId: string;
}) {
  const { favoriteService, globalContextService } = useServices({
    FavoriteService,
    GlobalContextService,
  });
  const favorite = useLiveData(
    favoriteService.favoriteList.isFavorite$("database", database.id),
  );
  const active =
    useLiveData(globalContextService.globalContext.databaseId.$) ===
    database.id;
  const actions = useDatabasePageActions({
    database,
    onInventoryChanged,
    workspaceId,
  });
  const [moveOpen, setMoveOpen] = useState(false);
  const dndData = useMemo(
    () =>
      ({
        draggable: {
          entity: { type: "database", id: database.id },
          from: location,
        },
        dropTarget: { at: "structure-tree:database" },
      }) satisfies MyoxusDNDData,
    [database.id, location],
  );
  const operations = useMemo(
    () => [
      {
        index: 0,
        view: (
          <>
            <DatabasePageMenuItems
              actions={actions}
              favorite={Boolean(favorite)}
              onMove={() => setMoveOpen(true)}
            />
            {!actions.protectedRoot ? (
              <WorkspaceContentOperationMenuItems
                selection={{
                  type: "resources",
                  resources: [
                    {
                      id: database.id,
                      kind: WorkspaceContentResourceKindType.Database,
                    },
                  ],
                }}
              />
            ) : null}
          </>
        ),
      },
      ...(additionalOperations ?? []),
    ],
    [actions, additionalOperations, database.id, favorite],
  );
  const path = useMemo(
    () => [...parentPath, `database-${database.id}`],
    [database.id, parentPath],
  );

  return (
    <>
      <StructureTreeNode
        active={active}
        canDrop={canDrop}
        collapsed
        collapsible={false}
        dndData={dndData}
        dropEffect={dropEffect}
        explorerIconConfig={{ where: "database", id: database.id }}
        icon={StructureTreeDatabaseIcon}
        name={database.title}
        onDrop={onDrop}
        operations={operations}
        reorderable={reorderable}
        setCollapsed={() => undefined}
        to={`/databases/${database.id}`}
        data-testid={`structure-tree-database-${database.id}`}
        data-structure-path={path.join("/")}
      />
      <WorkspacePageMoveDialog
        databaseId={database.id}
        open={moveOpen}
        onOpenChange={setMoveOpen}
      />
    </>
  );
}
