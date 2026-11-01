// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useMutateQueryResource,
  useMutation,
} from "@myoxus/core/components/hooks/use-mutation";
import { FavoriteService } from "@myoxus/core/modules/favorite";
import { OrganizeService } from "@myoxus/core/modules/organize";
import {
  cleanupDatabasePageProjections,
  DatabasePagesService,
  type DatabasePageRecord,
  type DatabasePagesLoadState,
} from "@myoxus/core/modules/workspace-pages";
import {
  databasesQuery,
  deleteDatabasePermanentlyMutation,
  restoreDatabaseMutation,
  trashedDatabasesQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  ArchiveRestoreIcon,
  DatabaseIcon,
  DeletePermanentlyIcon,
} from "@myoxus/icons/react";
import { useServices } from "@myoxus/infra";
import {
  Button,
  Group,
  IconButton,
  Loading,
  Notice,
  notify,
  SurfaceList,
  SurfaceListHeader,
  SurfaceListHeaderTitle,
  SurfaceListItem,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListSpacer,
  SurfaceListText,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback } from "react";

export function TrashDatabaseList({
  canManage,
  loadState,
  retry,
  workspaceId,
}: {
  canManage: boolean;
  loadState: DatabasePagesLoadState;
  retry: () => void;
  workspaceId: string;
}) {
  const t = useI18n();
  const { databasePagesService, favoriteService, organizeService } =
    useServices({
      DatabasePagesService,
      FavoriteService,
      OrganizeService,
    });
  const restoreDatabase = useMutation({ mutation: restoreDatabaseMutation });
  const purgeDatabase = useMutation({
    mutation: deleteDatabasePermanentlyMutation,
  });
  const revalidate = useMutateQueryResource();
  const { openConfirmModal } = useConfirmModal();

  const refreshInventories = useCallback(async () => {
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
  }, [databasePagesService, revalidate, workspaceId]);

  const restore = useCallback(
    async (database: DatabasePageRecord) => {
      await restoreDatabase.trigger({
        input: {
          databaseId: database.id,
          expectedEditRevision: database.editRevision,
          force: false,
        },
      });
      await refreshInventories();
      notify({
        title: t["com.myoxus.toastMessage.restored"]({
          title: database.title,
        }),
      });
    },
    [refreshInventories, restoreDatabase, t],
  );

  const confirmPurge = useCallback(
    (database: DatabasePageRecord) => {
      openConfirmModal({
        title: `${t["com.myoxus.trashOperation.deletePermanently"]()}?`,
        description: t["com.myoxus.trashOperation.deleteDescription"](),
        cancelText: t["Cancel"](),
        confirmText: t["com.myoxus.trashOperation.delete"](),
        confirmButtonOptions: { variant: "error" },
        onConfirm: async () => {
          await purgeDatabase.trigger({
            input: {
              databaseId: database.id,
              expectedEditRevision: database.editRevision,
              force: false,
            },
          });
          cleanupDatabasePageProjections(
            database.id,
            favoriteService,
            organizeService,
          );
          await refreshInventories();
          notify({ title: t["com.myoxus.toastMessage.permanentlyDeleted"]() });
        },
      });
    },
    [
      favoriteService,
      openConfirmModal,
      organizeService,
      purgeDatabase,
      refreshInventories,
      t,
    ],
  );

  if (loadState.status === "loading" && loadState.records.length === 0) {
    return (
      <Notice title={t["Loading"]()}>
        <Group>
          <Loading />
          {t["com.myoxus.database.embed.loading"]()}
        </Group>
      </Notice>
    );
  }
  if (loadState.status === "error" && loadState.records.length === 0) {
    return (
      <Notice
        title={t["com.myoxus.database.selector.error-title"]()}
        tone="error"
      >
        <Group justify="space-between" wrap="wrap">
          {t["com.myoxus.database.selector.error-description"]()}
          <Button variant="secondary" onClick={retry}>
            {t["Retry"]()}
          </Button>
        </Group>
      </Notice>
    );
  }
  if (loadState.records.length === 0) return null;

  return (
    <SurfaceList label={t["com.myoxus.workspace-pages.kind.databases"]()}>
      <SurfaceListHeader density="section">
        <SurfaceListHeaderTitle typographySlot="label-compact">
          {t["com.myoxus.workspace-pages.kind.databases"]()}
        </SurfaceListHeaderTitle>
      </SurfaceListHeader>
      {loadState.records.map((database) => (
        <SurfaceListItem
          key={database.key}
          alignItems="center"
          density="compact"
          layout="row"
        >
          <SurfaceListItemIcon size="md">
            <DatabaseIcon />
          </SurfaceListItemIcon>
          <SurfaceListItemMain grow>
            <SurfaceListText kind="title">{database.title}</SurfaceListText>
          </SurfaceListItemMain>
          <SurfaceListSpacer />
          {canManage ? (
            <Group wrap="nowrap">
              <IconButton
                aria-label={t["com.myoxus.trashOperation.restoreIt"]()}
                icon={<ArchiveRestoreIcon />}
                onClick={() => void restore(database)}
                tooltip={t["com.myoxus.trashOperation.restoreIt"]()}
              />
              <IconButton
                aria-label={t["com.myoxus.trashOperation.deletePermanently"]()}
                icon={<DeletePermanentlyIcon />}
                onClick={() => confirmPurge(database)}
                tooltip={t["com.myoxus.trashOperation.deletePermanently"]()}
                variant="danger"
              />
            </Group>
          ) : null}
        </SurfaceListItem>
      ))}
    </SurfaceList>
  );
}
