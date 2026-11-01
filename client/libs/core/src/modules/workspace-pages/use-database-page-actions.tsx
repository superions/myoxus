// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useMutateQueryResource,
  useMutation,
} from "@myoxus/core/components/hooks/use-mutation";
import {
  DatabaseConflictProvider,
  useDatabaseConflictController,
} from "@myoxus/core/modules/database/presence/conflict-controller";
import { FavoriteService } from "@myoxus/core/modules/favorite";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { copyTextToClipboard } from "@myoxus/core/utils/clipboard";
import {
  DatabaseSystemRole,
  databasesQuery,
  trashDatabaseMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useServices } from "@myoxus/infra";
import { notify, useConfirmModal } from "@myoxus/ui-facade";
import { type ReactNode, useCallback } from "react";

import type { DatabasePageRecord } from "./database-page-loader";
import { DatabasePagesService } from "./database-pages-service";

export function DatabasePageActionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  return <DatabaseConflictProvider>{children}</DatabaseConflictProvider>;
}

export type DatabasePageActions = {
  protectedRoot?: boolean;
  copyLink: () => Promise<void>;
  open: (at?: "active" | "beside" | "new-tab") => void;
  remove: () => void;
  toggleFavorite: () => void;
};

export function useDatabasePageActions({
  database,
  onInventoryChanged,
  workspaceId,
}: {
  database: DatabasePageRecord;
  onInventoryChanged?: () => void;
  workspaceId: string;
}) {
  const t = useI18n();
  const { databasePagesService, favoriteService, workbenchService } =
    useServices({
      DatabasePagesService,
      FavoriteService,
      WorkbenchService,
    });
  const conflicts = useDatabaseConflictController();
  const trashDatabase = useMutation({ mutation: trashDatabaseMutation });
  const revalidate = useMutateQueryResource();
  const { openConfirmModal } = useConfirmModal();
  const route = `/databases/${database.id}`;

  const open = useCallback(
    (at: "active" | "beside" | "new-tab" = "active") => {
      workbenchService.workbench.open(route, { at });
    },
    [route, workbenchService.workbench],
  );
  const protectedRoot =
    database.systemRole === DatabaseSystemRole.WorkspaceTasks;
  const toggleFavorite = useCallback(() => {
    if (protectedRoot) return;
    favoriteService.favoriteList.toggle("database", database.id);
  }, [database.id, favoriteService.favoriteList, protectedRoot]);
  const copyLink = useCallback(async () => {
    const basename = workbenchService.workbench.basename$.value;
    const copied = await copyTextToClipboard(
      new URL(`${basename}${route}`, location.origin).toString(),
    );
    notify[copied ? "success" : "error"]({
      title: copied
        ? t["Copied link to clipboard"]()
        : t["com.myoxus.database.view.copy-link-failed"](),
    });
  }, [route, t, workbenchService.workbench.basename$]);
  const remove = useCallback(() => {
    if (protectedRoot) return;
    openConfirmModal({
      title: t["com.myoxus.moveToTrash.title"](),
      description: t["com.myoxus.moveToTrash.confirmModal.description"]({
        title: database.title,
      }),
      cancelText: t["Cancel"](),
      confirmText: t["com.myoxus.moveToTrash.title"](),
      confirmButtonOptions: { variant: "error" },
      onConfirm: () =>
        conflicts.execute({
          attemptedAction: t["com.myoxus.moveToTrash.title"](),
          localValue: database.title,
          reloadLatest: async () => {
            await revalidate(
              databasesQuery,
              (variables) => variables.workspaceId === workspaceId,
            );
            databasePagesService.invalidate();
            onInventoryChanged?.();
          },
          mutate: (force) =>
            trashDatabase.trigger({
              input: {
                databaseId: database.id,
                expectedEditRevision: database.editRevision,
                force,
              },
            }),
          afterSuccess: async () => {
            await revalidate(
              databasesQuery,
              (variables) => variables.workspaceId === workspaceId,
            );
            databasePagesService.invalidate();
            onInventoryChanged?.();
          },
        }),
    });
  }, [
    conflicts,
    database,
    databasePagesService,
    trashDatabase,
    onInventoryChanged,
    openConfirmModal,
    protectedRoot,
    revalidate,
    t,
    workspaceId,
  ]);

  return {
    protectedRoot,
    copyLink,
    open,
    remove,
    toggleFavorite,
  } satisfies DatabasePageActions;
}
