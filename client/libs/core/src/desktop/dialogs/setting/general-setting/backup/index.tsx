// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { BackupService } from "@myoxus/core/modules/backup/services";
import { toArrayBuffer } from "@myoxus/core/utils/array-buffer";
import { i18nTime, useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  LocalWorkspaceIcon,
  MoreVerticalIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { formatByteSize } from "@virgultum/core/primitives/utils";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Avatar,
  Group,
  IconButton,
  Loading,
  Menu,
  MenuItem,
  notify,
  Pagination,
  SettingHeader,
  SettingsControlEmpty,
  SettingsListItemMeta,
  SettingsListItemTitle,
  Stack,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListMeta,
  useConfirmModal,
} from "../../primitives";

const BACKUPS_PER_PAGE = 6;

interface BackupWorkspaceEntry {
  id: string;
  name: string;
  fileSize: number;
  updatedAt: Date;
  avatar: Uint8Array | null;
  dbPath: string;
}

const WorkspaceBackupAvatar = ({
  blob,
  name,
}: {
  blob: Uint8Array | null;
  name: string;
}) => {
  const image = useMemo(
    () => (blob ? new Blob([toArrayBuffer(blob)]) : undefined),
    [blob],
  );
  return <Avatar colorfulFallback image={image} kind="workspace" name={name} />;
};

const BackupWorkspaceRow = ({ item }: { item: BackupWorkspaceEntry }) => {
  const t = useI18n();
  const backupService = useService(BackupService);
  const { openConfirmModal } = useConfirmModal();
  const { jumpToPage } = useNavigateHelper();
  const [menuOpen, setMenuOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleRecover = useAsyncCallback(async () => {
    setImporting(true);
    try {
      track.$.settingsPanel.archivedWorkspaces.recoverArchivedWorkspace();
      const result = await backupService.recoverBackupWorkspace(item.dbPath);
      if (!result.workspaceId) {
        if (result.error) {
          notify.error({ title: t[result.error]() });
        }
        return;
      }

      const recoveredId = result.workspaceId;
      notify.success({
        title: t["com.myoxus.settings.workspace.backup.import.success"](),
        actions: [
          {
            key: "open",
            label:
              t["com.myoxus.settings.workspace.backup.import.success.action"](),
            onClick: () => jumpToPage(recoveredId, "home"),
            autoClose: false,
          },
        ],
      });
      setMenuOpen(false);
    } finally {
      setImporting(false);
    }
  }, [backupService, item.dbPath, jumpToPage, t]);

  const handleDelete = useCallback(() => {
    openConfirmModal({
      title: t["com.myoxus.workspaceDelete.title"](),
      children: t["com.myoxus.settings.workspace.backup.delete.warning"](),
      confirmText: t["Confirm"](),
      cancelText: t["Cancel"](),
      confirmButtonOptions: { variant: "error" },
      onConfirm: async () => {
        track.$.settingsPanel.archivedWorkspaces.deleteArchivedWorkspace();
        await backupService.deleteBackupWorkspace(item.id);
        notify.success({
          title: t["com.myoxus.settings.workspace.backup.delete.success"](),
        });
      },
    });
  }, [backupService, item.id, openConfirmModal, t]);

  const deletedAtLabel = t["com.myoxus.settings.workspace.backup.delete-at"]({
    date: i18nTime(item.updatedAt, { absolute: { accuracy: "day" } }),
    time: i18nTime(item.updatedAt, {
      absolute: { accuracy: "minute", noDate: true, noYear: true },
    }),
  });

  return (
    <SurfaceListItem
      component="div"
      data-testid="backup-workspace-item"
      alignItems="center"
      density="compact"
      interactive
      justifyContent="space-between"
      layout="row"
      onClick={() => setMenuOpen((prev) => !prev)}
      data-myoxus-ui-role="settings-backup-workspace-row"
    >
      <WorkspaceBackupAvatar blob={item.avatar} name={item.name} />
      <SurfaceListItemMain compact>
        <SettingsListItemTitle title={item.name} truncate>
          {item.name}
        </SettingsListItemTitle>
        <SettingsListItemMeta>
          {formatByteSize(item.fileSize)}
        </SettingsListItemMeta>
      </SurfaceListItemMain>
      <SurfaceListMeta layout="row-cluster">
        <SettingsListItemMeta title={deletedAtLabel} truncate>
          {deletedAtLabel}
        </SettingsListItemMeta>
        <Menu
          rootOptions={{
            open: menuOpen && !importing,
            onOpenChange: setMenuOpen,
            modal: true,
          }}
          items={
            <>
              <MenuItem
                prefixIcon={<LocalWorkspaceIcon />}
                onClick={handleRecover}
              >
                {t["com.myoxus.settings.workspace.backup.import"]()}
              </MenuItem>
              <MenuItem
                prefixIcon={<DeleteIcon />}
                onClick={handleDelete}
                type="danger"
              >
                {t["Delete"]()}
              </MenuItem>
            </>
          }
          contentOptions={{ align: "end" }}
        >
          <IconButton disabled={importing}>
            {importing ? <Loading /> : <MoreVerticalIcon />}
          </IconButton>
        </Menu>
      </SurfaceListMeta>
    </SurfaceListItem>
  );
};

export const BackupSettingPanel = () => {
  const t = useI18n();
  const backupService = useService(BackupService);
  const [pageNum, setPageNum] = useState(0);

  useEffect(() => {
    backupService.revalidate();
  }, [backupService]);

  const isLoading = useLiveData(backupService.isLoading$);
  const backups = useLiveData(backupService.pageBackupWorkspaces$);
  const items = backups?.items ?? [];
  const isEmpty = !isLoading && items.length === 0;

  const visibleItems = useMemo(
    () =>
      items.slice(pageNum * BACKUPS_PER_PAGE, (pageNum + 1) * BACKUPS_PER_PAGE),
    [items, pageNum],
  );

  return (
    <>
      <SettingHeader
        title={t["com.myoxus.settings.workspace.backup"]()}
        subtitle={t["com.myoxus.settings.workspace.backup.subtitle"]()}
        data-testid="backup-title"
      />
      {isEmpty ? (
        <SettingsControlEmpty>
          {t["com.myoxus.settings.workspace.backup.empty"]()}
        </SettingsControlEmpty>
      ) : (
        <Stack data-myoxus-ui-role="settings-backup-list-panel">
          {isLoading ? (
            <SurfaceList label={t["com.myoxus.settings.workspace.backup"]()}>
              <SurfaceListItem
                component="div"
                alignItems="center"
                density="compact"
                layout="row"
                muted
                data-myoxus-ui-role="settings-backup-loading-row"
              >
                <SurfaceListItemMain compact>
                  <SettingsListItemMeta>
                    <Loading />
                  </SettingsListItemMeta>
                </SurfaceListItemMain>
              </SurfaceListItem>
            </SurfaceList>
          ) : backups ? (
            <>
              <SurfaceList
                label={t["com.myoxus.settings.workspace.backup"]()}
                data-testid="backup-workspace-list"
              >
                {visibleItems.map((item) => (
                  <BackupWorkspaceRow key={item.id} item={item} />
                ))}
              </SurfaceList>
              {items.length > BACKUPS_PER_PAGE ? (
                <Group
                  justify="flex-end"
                  data-myoxus-ui-role="settings-backup-pagination"
                >
                  <Pagination
                    totalCount={items.length}
                    countPerPage={BACKUPS_PER_PAGE}
                    pageNum={pageNum}
                    onPageChange={(_, nextPage) => setPageNum(nextPage)}
                  />
                </Group>
              ) : null}
            </>
          ) : null}
        </Stack>
      )}
    </>
  );
};
