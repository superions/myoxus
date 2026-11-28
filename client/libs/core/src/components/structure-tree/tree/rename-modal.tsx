// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { AppSidebarService } from "@myoxus/core/modules/app-sidebar";
import { ExplorerIconService } from "@myoxus/core/modules/explorer-icon/services/explorer-icon";
import type { ExplorerType } from "@myoxus/core/modules/explorer-icon/store/explorer-icon";
import { useLiveData, useService } from "@myoxus/infra";
import {
  IconAndNameEditorMenu,
  type IconData,
  STRUCTURE_TREE_RENAME_MENU_CONTENT_OPTIONS,
  StructureTreeRenameAnchor,
  structureTreeRenameMenuWidth,
} from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useMemo } from "react";

export interface ExplorerIconConfig {
  where: ExplorerType;
  id: string;
}

/**
 * Isolated rename/icon popover so sidebar width subscriptions only re-render
 * while a node is actively being renamed.
 */
export const StructureTreeNodeRenameModal = ({
  setRenaming,
  handleRename,
  rawName,
  explorerIconConfig,
  className,
  fallbackIcon,
}: {
  setRenaming: (renaming: boolean) => void;
  handleRename: (newName: string) => void;
  rawName: string | undefined;
  className?: string;
  explorerIconConfig?: ExplorerIconConfig | null;
  fallbackIcon?: ReactNode;
}) => {
  const explorerIconService = useService(ExplorerIconService);
  const sidebarWidth = useLiveData(
    useService(AppSidebarService).sidebar.width$,
  );

  const explorerIcon = useLiveData(
    useMemo(
      () =>
        explorerIconConfig
          ? explorerIconService.icon$(
              explorerIconConfig.where,
              explorerIconConfig.id,
            )
          : null,
      [explorerIconConfig, explorerIconService],
    ),
  );

  const handleIconChange = useCallback(
    (icon?: IconData) => {
      if (!explorerIconConfig) return;
      explorerIconService.setIcon({
        where: explorerIconConfig.where,
        id: explorerIconConfig.id,
        icon,
      });
    },
    [explorerIconConfig, explorerIconService],
  );

  return (
    <IconAndNameEditorMenu
      open
      onOpenChange={setRenaming}
      onIconChange={handleIconChange}
      onNameChange={handleRename}
      name={rawName ?? ""}
      icon={explorerIcon?.icon}
      width={structureTreeRenameMenuWidth(sidebarWidth)}
      contentOptions={STRUCTURE_TREE_RENAME_MENU_CONTENT_OPTIONS}
      iconPlaceholder={fallbackIcon}
      inputTestId="rename-modal-input"
    >
      <StructureTreeRenameAnchor className={className} />
    </IconAndNameEditorMenu>
  );
};
