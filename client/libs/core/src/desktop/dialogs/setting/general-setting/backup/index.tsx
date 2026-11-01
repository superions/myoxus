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
import { formatByteSize } from "@virgultum/global/utils";
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

const Empty = () => {
  const t = useI18n();
  return (
    <SettingsControlEmpty>
      {t["com.myoxus.settings.workspace.backup.empty"]()}
    </SettingsControlEmpty>
  );
};

const BlobAvatar = ({
  blob,
  name,
}: {
  blob: Uint8Array | null;
  name: string;
}) => {
  const image = useMemo(() => {
    if (!blob) return undefined;
    return new Blob([toArrayBuffer(blob)]);
  }, [blob]);

  return <Avatar colorfulFallback image={image} kind="workspace" name={name} />;
};

type BackupWorkspaceItem = {
  id: string;
  name: string;
  fileSize: number;
  updatedAt: Date;
  avatar: Uint8Array | null;
  dbPath: string;
};

const BackupWorkspaceItem = ({ item }: { item: BackupWorkspaceItem }) => {
  const [menuOpen, setMenuOpen] = useState(false);

  const { openConfirmModal } = useConfirmModal();
  const backupService = useService(BackupService);
  const t = useI18n();
  const [importing, setImporting] = useState(false);

  const { jumpToPage } = useNavigateHelper();

  const handleImport = useAsyncCallback(async () => {
    setImporting(true);
    track.$.settingsPanel.archivedWorkspaces.recoverArchivedWorkspace();
    const result = await backupService.recoverBackupWorkspace(item.dbPath);
    const workspaceId = result.workspaceId;
    if (!workspaceId) {
      if (result.error) {
        notify.error({ title: t[result.error]() });
      }
      setImporting(false);
      return;
    }
    notify.success({
      title: t["com.myoxus.settings.workspace.backup.import.success"](),
      actions: [
        {
          key: "open",
          label:
            t["com.myoxus.settings.workspace.backup.import.success.action"](),
          onClick: () => {
            jumpToPage(workspaceId, "home");
          },
          autoClose: false,
        },
      ],
    });
    setMenuOpen(false);
    setImporting(false);
  }, [backupService, item.dbPath, jumpToPage, t]);

  const handleDelete = useCallback(
    (backupWorkspaceId: string) => {
      openConfirmModal({
        title: t["com.myoxus.workspaceDelete.title"](),
        children: t["com.myoxus.settings.workspace.backup.delete.warning"](),
        onConfirm: async () => {
          track.$.settingsPanel.archivedWorkspaces.deleteArchivedWorkspace();
          await backupService.deleteBackupWorkspace(backupWorkspaceId);
          notify.success({
            title: t["com.myoxus.settings.workspace.backup.delete.success"](),
          });
        },
        confirmText: t["Confirm"](),
        cancelText: t["Cancel"](),
        confirmButtonOptions: {
          variant: "error",
        },
      });
    },
    [backupService, openConfirmModal, t],
  );

  const updatedAtLabel = t["com.myoxus.settings.workspace.backup.delete-at"]({
    date: i18nTime(item.updatedAt, {
      absolute: {
        accuracy: "day",
      },
    }),
    time: i18nTime(item.updatedAt, {
      absolute: {
        accuracy: "minute",
        noDate: true,
        noYear: true,
      },
    }),
  });

  return (
    <SurfaceListItem
      component="div"
      data-testid="backup-workspace-item"
      key={item.id}
      alignItems="center"
      density="compact"
      interactive
      justifyContent="space-between"
      layout="row"
      onClick={() => setMenuOpen((v) => !v)}
      data-myoxus-ui-role="settings-backup-workspace-row"
    >
      <BlobAvatar blob={item.avatar} name={item.name} />
      <SurfaceListItemMain compact>
        <SettingsListItemTitle title={item.name} truncate>
          {item.name}
        </SettingsListItemTitle>
        <SettingsListItemMeta>
          {formatByteSize(item.fileSize)}
        </SettingsListItemMeta>
      </SurfaceListItemMain>
      <SurfaceListMeta layout="row-cluster">
        <SettingsListItemMeta title={updatedAtLabel} truncate>
          {updatedAtLabel}
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
                onClick={handleImport}
              >
                {t["com.myoxus.settings.workspace.backup.import"]()}
              </MenuItem>
              <MenuItem
                prefixIcon={<DeleteIcon />}
                onClick={() => handleDelete(item.id)}
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

const PAGE_SIZE = 6;

export const BackupSettingPanel = () => {
  const t = useI18n();
  const backupService = useService(BackupService);

  useEffect(() => {
    backupService.revalidate();
  }, [backupService]);

  const isLoading = useLiveData(backupService.isLoading$);
  const backupWorkspaces = useLiveData(backupService.pageBackupWorkspaces$);

  const [pageNum, setPageNum] = useState(0);

  const innerElement = useMemo(() => {
    if (isLoading) {
      return (
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
      );
    }
    if (!backupWorkspaces) {
      return null;
    }
    return (
      <>
        <SurfaceList
          label={t["com.myoxus.settings.workspace.backup"]()}
          data-testid="backup-workspace-list"
        >
          {backupWorkspaces.items
            .slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE)
            .map((item) => (
              <BackupWorkspaceItem key={item.id} item={item} />
            ))}
        </SurfaceList>
        {backupWorkspaces.items.length > PAGE_SIZE && (
          <Group
            justify="flex-end"
            data-myoxus-ui-role="settings-backup-pagination"
          >
            <Pagination
              totalCount={backupWorkspaces?.items.length ?? 0}
              countPerPage={PAGE_SIZE}
              pageNum={pageNum}
              onPageChange={(_, pageNum) => {
                setPageNum(pageNum);
              }}
            />
          </Group>
        )}
      </>
    );
  }, [isLoading, backupWorkspaces, pageNum, t]);

  const isEmpty =
    (backupWorkspaces?.items.length === 0 || !backupWorkspaces) && !isLoading;

  return (
    <>
      <SettingHeader
        title={t["com.myoxus.settings.workspace.backup"]()}
        subtitle={t["com.myoxus.settings.workspace.backup.subtitle"]()}
        data-testid="backup-title"
      />
      {isEmpty ? (
        <Empty />
      ) : (
        <Stack data-myoxus-ui-role="settings-backup-list-panel">
          {innerElement}
        </Stack>
      )}
    </>
  );
};
