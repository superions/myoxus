// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type FolderNode,
  OrganizeService,
} from "@myoxus/core/modules/organize";
import { useI18n } from "@myoxus/i18n";
import { FolderIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { ConfirmModal, NavigationLink, Stack } from "@myoxus/ui-facade";
import { useCallback, useEffect, useState } from "react";

import {
  collectDatabaseFolderLinks,
  linkDatabasePageToFolder,
} from "./organizer";

function FolderChoice({
  node,
  onSelect,
  selectedId,
}: {
  node: FolderNode;
  onSelect: (folderId: string) => void;
  selectedId: string | null;
}) {
  const name = useLiveData(node.name$);
  const children = useLiveData(node.sortedChildren$).filter(
    (child) => child.type$.value === "folder",
  );
  if (!node.id) return null;

  return (
    <NavigationLink
      active={selectedId === node.id}
      component="button"
      defaultOpened
      label={name}
      leftSection={<FolderIcon />}
      onClick={() => onSelect(node.id as string)}
      type="button"
      data-testid={`workspace-page-folder-option-${node.id}`}
    >
      {children.map((child) => (
        <FolderChoice
          key={child.id}
          node={child}
          onSelect={onSelect}
          selectedId={selectedId}
        />
      ))}
    </NavigationLink>
  );
}

export function WorkspacePageMoveDialog({
  databaseId,
  onOpenChange,
  open,
}: {
  databaseId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const t = useI18n();
  const organizeService = useService(OrganizeService);
  const root = organizeService.folderTree.rootFolder;
  const rootFolders = useLiveData(root.sortedChildren$).filter(
    (node) => node.type$.value === "folder",
  );
  const existingLink = collectDatabaseFolderLinks(root, databaseId)[0];
  const [selectedId, setSelectedId] = useState<string | null>(
    existingLink?.info$.value?.parentId ?? null,
  );

  useEffect(() => {
    if (!open) return;
    const current = collectDatabaseFolderLinks(root, databaseId)[0];
    setSelectedId(current?.info$.value?.parentId ?? null);
  }, [databaseId, open, root]);

  const handleConfirm = useCallback(() => {
    linkDatabasePageToFolder(root, databaseId, selectedId);
  }, [databaseId, root, selectedId]);

  return (
    <ConfirmModal
      open={open}
      onOpenChange={onOpenChange}
      title={t["com.myoxus.workspace-pages.move.title"]()}
      cancelText={t["Cancel"]()}
      confirmText={t["com.myoxus.workspace-pages.move.confirm"]()}
      onConfirm={handleConfirm}
      contentOptions={{
        "data-testid": `workspace-page-move-dialog-${databaseId}`,
      }}
    >
      <Stack>
        <NavigationLink
          active={selectedId === null}
          component="button"
          label={t["com.myoxus.workspace-pages.move.no-folder"]()}
          onClick={() => setSelectedId(null)}
          type="button"
        />
        {rootFolders.map((folder) => (
          <FolderChoice
            key={folder.id}
            node={folder}
            onSelect={setSelectedId}
            selectedId={selectedId}
          />
        ))}
      </Stack>
    </ConfirmModal>
  );
}
