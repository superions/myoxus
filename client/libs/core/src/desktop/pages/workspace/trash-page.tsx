// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  createDocExplorerContext,
  DocExplorerContext,
} from "@myoxus/core/components/explorer/context";
import { DocsExplorer } from "@myoxus/core/components/explorer/docs-view/docs-list";
import { useDocumentOperations } from "@myoxus/core/components/hooks/myoxus/use-document-operations";
import {
  useMutateQueryResource,
  useMutation,
} from "@myoxus/core/components/hooks/use-mutation";
import { CollectionRulesService } from "@myoxus/core/modules/collection-rules";
import { getDatabaseWorkspaceAvailability } from "@myoxus/core/modules/database/availability";
import { DocsService } from "@myoxus/core/modules/doc";
import { FavoriteService } from "@myoxus/core/modules/favorite";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { OrganizeService } from "@myoxus/core/modules/organize";
import { WorkspacePermissionService } from "@myoxus/core/modules/permissions";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  cleanupDatabasePageProjections,
  DatabasePagesService,
  useTrashedDatabasePages,
} from "@myoxus/core/modules/workspace-pages";
import {
  databasesQuery,
  deleteDatabasePermanentlyMutation,
  trashedDatabasesQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { DeleteIcon, DeletePermanentlyIcon } from "@myoxus/icons/react";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import {
  Badge,
  Button,
  EmptyState,
  EmptyStateTitle,
  notify,
  PageContentRail,
  PageScrollViewport,
  Stack,
  SurfaceListHeader,
  SurfaceListHeaderTitle,
  useConfirmModal,
  WorkbenchHeaderContextPath,
  WorkbenchHeaderFrame,
  WorkbenchHeaderTitleCluster,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  useIsActiveView,
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from "../../../modules/workbench";
import { TrashDatabaseList } from "./trash-database-list";

export function TrashHeader({
  canEmptyTrash,
  itemCount,
  onEmptyTrash,
}: {
  canEmptyTrash: boolean;
  itemCount: number;
  onEmptyTrash: () => void;
}) {
  const t = useI18n();
  const countLabel = t["com.myoxus.trashOperation.itemCount"]({
    count: itemCount.toString(),
  });

  return (
    <WorkbenchHeaderFrame
      data-myoxus-ui-role="trash-header-frame"
      title={
        <WorkbenchHeaderTitleCluster data-myoxus-ui-role="trash-title-cluster">
          <WorkbenchHeaderContextPath
            current={t["com.myoxus.workspaceSubPath.trash"]()}
            parents={[t["All content"]()]}
            data-myoxus-ui-role="trash-header-title"
          />
          <Badge
            surface="floating"
            tone="neutral"
            data-myoxus-ui-role="trash-count-badge"
            aria-label={countLabel}
          >
            {countLabel}
          </Badge>
        </WorkbenchHeaderTitleCluster>
      }
      right={
        canEmptyTrash ? (
          <Button
            data-testid="empty-trash-button"
            data-myoxus-ui-role="trash-empty-button"
            prefix={<DeletePermanentlyIcon />}
            variant="destructive"
            onClick={onEmptyTrash}
          >
            {t["com.myoxus.trashOperation.emptyTrash"]()}
          </Button>
        ) : null
      }
    />
  );
}

export function EmptyTrashState() {
  const t = useI18n();

  return (
    <PageContentRail
      centerContent
      fill
      width="data"
      data-myoxus-ui-role="trash-empty-state-rail"
    >
      <EmptyState
        title={
          <EmptyStateTitle icon={<DeleteIcon />}>
            {t["com.myoxus.workspaceSubPath.trash"]()}
          </EmptyStateTitle>
        }
        description={t["com.myoxus.workspaceSubPath.trash.empty-description"]()}
        data-testid="trash-empty-state"
        data-myoxus-ui-role="trash-empty-state"
      />
    </PageContentRail>
  );
}

export function TrashPage() {
  const t = useI18n();
  const collectionRulesService = useService(CollectionRulesService);
  const docsService = useService(DocsService);
  const globalContextService = useService(GlobalContextService);
  const permissionService = useService(WorkspacePermissionService);
  const workspace = useService(WorkspaceService).workspace;
  const workspaceId =
    getDatabaseWorkspaceAvailability(workspace).serverWorkspaceId;
  const databaseTrash = useTrashedDatabasePages(workspaceId);
  const { databasePagesService, favoriteService, organizeService } =
    useServices({
      DatabasePagesService,
      FavoriteService,
      OrganizeService,
    });
  const purgeDatabase = useMutation({
    mutation: deleteDatabasePermanentlyMutation,
  });
  const revalidate = useMutateQueryResource();
  const { restoreFromTrash, permanentlyDeletePages, emptyTrash } =
    useDocumentOperations();
  const isActiveView = useIsActiveView();
  const { openConfirmModal, closeConfirmModal } = useConfirmModal();

  const [explorerContextValue] = useState(() =>
    createDocExplorerContext({
      displayProperties: [
        "system:createdAt",
        "system:updatedAt",
        "system:tags",
      ],
      showMoreOperation: false,
      showDragHandle: true,
      showDocPreview: false,
      quickFavorite: false,
      quickDeletePermanently: true,
      quickRestore: true,
      quickSelect: true,
      groupBy: undefined,
      orderBy: undefined,
    }),
  );

  const isAdmin = useLiveData(permissionService.permission.isAdmin$);
  const isOwner = useLiveData(permissionService.permission.isOwner$);
  const trashRecords = useLiveData(docsService.list.trashDocs$);
  const trashedDocIds = useMemo(
    () => Array.from(new Set(trashRecords.map((record) => record.id))),
    [trashRecords],
  );
  const trashItemCount = trashedDocIds.length + databaseTrash.records.length;
  const isEmpty =
    trashedDocIds.length === 0 &&
    databaseTrash.records.length === 0 &&
    (databaseTrash.status === "ready" || databaseTrash.status === "refreshing");
  const canManageTrash = Boolean(isAdmin || isOwner);

  useEffect(() => {
    permissionService.permission.revalidate();
  }, [permissionService.permission]);

  const handleMultiRestore = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        restoreFromTrash(id);
      }
      notify({
        title: t["com.myoxus.toastMessage.restored"]({
          title: ids.length > 1 ? "docs" : "doc",
        }),
      });
    },
    [restoreFromTrash, t],
  );

  const onConfirmPermanentlyDelete = useCallback(
    (
      ids: string[],
      callbacks?: {
        onFinished?: () => void;
        onAbort?: () => void;
      },
    ) => {
      const uniqueIds = Array.from(new Set(ids));
      if (uniqueIds.length === 0) {
        return;
      }
      openConfirmModal({
        title: `${t["com.myoxus.trashOperation.deletePermanently"]()}?`,
        description: t["com.myoxus.trashOperation.deleteDescription"](),
        cancelText: t["Cancel"](),
        confirmText: t["com.myoxus.trashOperation.delete"](),
        confirmButtonOptions: { variant: "error" },
        onConfirm: async () => {
          await permanentlyDeletePages(uniqueIds);
          notify({ title: t["com.myoxus.toastMessage.permanentlyDeleted"]() });
          callbacks?.onFinished?.();
          closeConfirmModal();
        },
        onCancel: () => {
          callbacks?.onAbort?.();
        },
      });
    },
    [closeConfirmModal, openConfirmModal, permanentlyDeletePages, t],
  );

  const onConfirmEmptyTrash = useCallback(() => {
    if (trashItemCount === 0) {
      return;
    }
    openConfirmModal({
      title: t["com.myoxus.trashOperation.emptyTrash.title"](),
      description: t["com.myoxus.trashOperation.emptyTrash.description"]({
        count: trashItemCount.toString(),
      }),
      cancelText: t["Cancel"](),
      confirmText: t["com.myoxus.trashOperation.emptyTrash.confirm"](),
      confirmButtonOptions: { variant: "error" },
      onConfirm: async () => {
        // Operate on the rendered trash IDs so a stale root-meta replay cannot
        // silently skip items that the user explicitly confirmed for removal.
        const tasks = [
          ...(trashedDocIds.length > 0
            ? [{ database: null, run: () => emptyTrash(trashedDocIds) }]
            : []),
          ...databaseTrash.records.map((database) => ({
            database,
            run: () =>
              purgeDatabase.trigger({
                input: {
                  databaseId: database.id,
                  expectedEditRevision: database.editRevision,
                  force: false,
                },
              }),
          })),
        ];
        const results = await Promise.allSettled(
          tasks.map((task) => task.run()),
        );
        let deletedCount = 0;
        results.forEach((result, index) => {
          if (result.status !== "fulfilled") {
            return;
          }
          const task = tasks[index];
          if (!task) {
            return;
          }
          if (task.database) {
            cleanupDatabasePageProjections(
              task.database.id,
              favoriteService,
              organizeService,
            );
            deletedCount += 1;
          } else if (typeof result.value === "number") {
            deletedCount += result.value;
          }
        });
        if (workspaceId) {
          await Promise.all([
            revalidate(
              databasesQuery,
              (variables) => variables.workspaceId === workspaceId,
            ),
            revalidate(
              trashedDatabasesQuery,
              (variables) => variables.workspaceId === workspaceId,
            ),
          ]);
          databasePagesService.invalidate();
        }
        notify({
          title: t["com.myoxus.toastMessage.trashEmptied"]({
            count: deletedCount.toString(),
          }),
        });
        if (results.every((result) => result.status === "fulfilled")) {
          closeConfirmModal();
        } else {
          notify.error({
            title: t["com.myoxus.database.selector.error-title"](),
          });
        }
      },
    });
  }, [
    closeConfirmModal,
    databasePagesService,
    databaseTrash.records,
    emptyTrash,
    favoriteService,
    openConfirmModal,
    organizeService,
    purgeDatabase,
    revalidate,
    t,
    trashItemCount,
    trashedDocIds,
    workspaceId,
  ]);

  useEffect(() => {
    const subscription = collectionRulesService
      .watch({
        filters: [
          { type: "system", key: "trash", method: "is", value: "true" },
        ],
        orderBy: { type: "system", key: "updatedAt", desc: true },
      })
      .subscribe((result) => {
        explorerContextValue.groups$.next(result.groups);
      });
    return () => subscription.unsubscribe();
  }, [collectionRulesService, explorerContextValue.groups$]);

  useEffect(() => {
    if (!isActiveView) {
      return;
    }
    globalContextService.globalContext.isTrash.set(true);
    return () => {
      globalContextService.globalContext.isTrash.set(false);
    };
  }, [globalContextService.globalContext.isTrash, isActiveView]);

  return (
    <DocExplorerContext.Provider value={explorerContextValue}>
      <ViewTitle title={t["Trash"]()} />
      <ViewIcon icon="trash" />
      <ViewHeader>
        <TrashHeader
          canEmptyTrash={!isEmpty && canManageTrash}
          itemCount={trashItemCount}
          onEmptyTrash={onConfirmEmptyTrash}
        />
      </ViewHeader>
      <ViewBody>
        {isEmpty ? (
          <EmptyTrashState />
        ) : (
          <PageScrollViewport data-myoxus-ui-role="trash-page-scroll">
            <PageContentRail
              scroll
              width="data"
              data-testid="trash-page-body"
              data-myoxus-ui-role="trash-page-body"
            >
              <Stack>
                {trashedDocIds.length > 0 ? (
                  <Stack>
                    <SurfaceListHeader density="section">
                      <SurfaceListHeaderTitle typographySlot="label-compact">
                        {t["com.myoxus.workspace-pages.kind.documents"]()}
                      </SurfaceListHeaderTitle>
                    </SurfaceListHeader>
                    <DocsExplorer
                      disableMultiDelete={!canManageTrash}
                      excludeTrashedDocs={false}
                      listScrollOwner="parent"
                      onRestore={
                        canManageTrash ? handleMultiRestore : undefined
                      }
                      onDelete={
                        canManageTrash ? onConfirmPermanentlyDelete : undefined
                      }
                    />
                  </Stack>
                ) : null}
                {workspaceId ? (
                  <TrashDatabaseList
                    canManage={canManageTrash}
                    loadState={databaseTrash}
                    retry={databaseTrash.retry}
                    workspaceId={workspaceId}
                  />
                ) : null}
              </Stack>
            </PageContentRail>
          </PageScrollViewport>
        )}
      </ViewBody>
    </DocExplorerContext.Provider>
  );
}

export function Component() {
  return <TrashPage />;
}
