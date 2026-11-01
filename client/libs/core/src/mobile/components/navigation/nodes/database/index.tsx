// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NodeOperation } from "@myoxus/core/components/structure-tree";
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
import { DatabaseIcon } from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { StructureTreeLoading } from "@myoxus/ui-facade";
import { useMemo, useState } from "react";

import { StructureTreeNode } from "../../tree/node";

export function StructureTreeDatabaseNode(props: {
  databaseId: string;
  operations?: NodeOperation[];
  parentPath: string[];
}) {
  return (
    <DatabasePageActionsProvider>
      <StructureTreeDatabaseNodeContent {...props} />
    </DatabasePageActionsProvider>
  );
}

function StructureTreeDatabaseNodeContent({
  databaseId,
  operations: additionalOperations,
}: {
  databaseId: string;
  operations?: NodeOperation[];
  parentPath: string[];
}) {
  const { workspaceService } = useServices({
    WorkspaceService,
  });
  const workspaceId = getDatabaseWorkspaceAvailability(
    workspaceService.workspace,
  ).serverWorkspaceId;
  const { record: database, reload } = useDatabasePage(workspaceId, databaseId);
  if (database === undefined) return <StructureTreeLoading />;
  if (database === null || !workspaceId) return null;

  return (
    <StructureTreeDatabaseNodeReady
      database={database}
      onInventoryChanged={reload}
      operations={additionalOperations}
      workspaceId={workspaceId}
    />
  );
}

function StructureTreeDatabaseNodeReady({
  database,
  onInventoryChanged,
  operations: additionalOperations,
  workspaceId,
}: {
  database: DatabasePageRecord;
  onInventoryChanged: () => void;
  operations?: NodeOperation[];
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
  const [moveOpen, setMoveOpen] = useState(false);
  const actions = useDatabasePageActions({
    database,
    onInventoryChanged,
    workspaceId,
  });
  const operations = useMemo(
    () => [
      {
        index: 0,
        view: (
          <DatabasePageMenuItems
            actions={actions}
            favorite={Boolean(favorite)}
            onMove={() => setMoveOpen(true)}
          />
        ),
      },
      ...(additionalOperations ?? []),
    ],
    [actions, additionalOperations, favorite],
  );

  return (
    <>
      <StructureTreeNode
        active={active}
        collapsed
        collapsible={false}
        icon={DatabaseIcon}
        name={database.title}
        operations={operations}
        setCollapsed={() => undefined}
        to={`/databases/${database.id}`}
        data-testid={`structure-tree-database-${database.id}`}
      />
      <WorkspacePageMoveDialog
        databaseId={database.id}
        open={moveOpen}
        onOpenChange={setMoveOpen}
      />
    </>
  );
}
