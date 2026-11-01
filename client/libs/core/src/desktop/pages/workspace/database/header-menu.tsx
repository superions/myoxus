// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UserPreferencesService } from "@myoxus/core/modules/server/services/user-preferences";
import { AssistancePreference } from "@myoxus/core/modules/server/views/assistance-preference";
import { DatabaseImportMenuSub } from "@myoxus/core/modules/database";
import { useI18n } from "@myoxus/i18n";
import {
  EditIcon,
  ExportIcon,
  ImportIcon,
  LinkIcon,
  TrashIcon,
} from "@myoxus/icons/react";
import {
  HeaderMenuButton,
  MenuItem,
  MenuPanel,
  MenuSeparator,
} from "@myoxus/ui-facade";
import { forwardRef, type ReactNode } from "react";

export interface DatabaseHeaderMenuButtonProps {
  contextualAssistance?: ReactNode;
  setupDocuments?: readonly {
    componentId: string;
    title: string;
    externalId: string;
  }[];
  onOpenSetupDocument?: (externalId: string) => void;
  assistance?: {
    service: UserPreferencesService;
    workspaceId: string;
    projectId: string;
  };
  contentImportOnly?: boolean;
  canImportContent?: boolean;
  canEditMetadata?: boolean;
  canManageLifecycle?: boolean;
  csvBusy: boolean;
  jsonBusy: boolean;
  notionBusy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
  onEditOverview: () => void;
  onCopyLink: () => void;
  onImportCsv: () => void;
  onImportJson: () => void;
  onImportNotion: () => void;
  onExportCsv: () => void;
  onExportJson: () => void;
  onTrash: () => void;
}

/**
 * Opened-Database object commands. View and Row commands remain with their
 * contextual controls; this menu deliberately has no generic action registry.
 */
export const DatabaseHeaderMenuButton = forwardRef<
  HTMLButtonElement,
  DatabaseHeaderMenuButtonProps
>(function DatabaseHeaderMenuButton(
  {
    contextualAssistance,
    setupDocuments = [],
    onOpenSetupDocument,
    assistance,
    contentImportOnly = false,
    canImportContent = true,
    canEditMetadata = true,
    canManageLifecycle = true,
    csvBusy,
    jsonBusy,
    notionBusy,
    open,
    onOpenChange,
    onRename,
    onEditOverview,
    onCopyLink,
    onImportCsv,
    onImportJson,
    onImportNotion,
    onExportCsv,
    onExportJson,
    onTrash,
  },
  ref,
) {
  const t = useI18n();

  return (
    <HeaderMenuButton
      ref={ref}
      ariaLabel={t["com.myoxus.common.open-menu"]()}
      data-testid="database-detail-header-menu-trigger"
      open={open}
      onOpenChange={onOpenChange}
      items={
        <MenuPanel>
          {contextualAssistance}
          {canEditMetadata ? (
            <>
              <MenuItem
                prefixIcon={<EditIcon />}
                onSelect={onRename}
                data-testid="database-rename-menu-item"
              >
                {t["Rename"]()}
              </MenuItem>
              <MenuItem
                prefixIcon={<EditIcon />}
                onSelect={onEditOverview}
                data-testid="database-edit-overview-menu-item"
              >
                {t["com.myoxus.database.overview.edit"]()}
              </MenuItem>
            </>
          ) : null}
          <MenuItem
            prefixIcon={<LinkIcon />}
            onSelect={onCopyLink}
            data-testid="database-copy-link-menu-item"
          >
            {t["com.myoxus.database.view.copy-link"]()}
          </MenuItem>
          {assistance ? <AssistancePreference {...assistance} menu /> : null}
          {onOpenSetupDocument
            ? setupDocuments.map((document) => (
                <MenuItem
                  key={document.componentId}
                  prefixIcon={<LinkIcon />}
                  onSelect={() => onOpenSetupDocument(document.externalId)}
                >
                  {t["com.myoxus.database.document_link.open"]()} ·{" "}
                  {document.title}
                </MenuItem>
              ))
            : null}
          <MenuSeparator />
          {canImportContent ? (
            contentImportOnly ? (
              <MenuItem
                prefixIcon={<ImportIcon />}
                disabled={jsonBusy}
                onSelect={onImportJson}
                data-testid="database-import-json-menu-item"
              >
                {t["com.myoxus.database.json-import.title"]()}
              </MenuItem>
            ) : (
              <DatabaseImportMenuSub
                csvBusy={csvBusy}
                jsonBusy={jsonBusy}
                notionBusy={notionBusy}
                onImportCsv={onImportCsv}
                onImportJson={onImportJson}
                onImportNotion={onImportNotion}
              />
            )
          ) : null}
          <MenuItem
            prefixIcon={<ExportIcon />}
            onSelect={onExportCsv}
            data-testid="database-export-csv-menu-item"
          >
            {t["com.myoxus.database.csv-export.title"]()}
          </MenuItem>
          <MenuItem
            prefixIcon={<ExportIcon />}
            onSelect={onExportJson}
            data-testid="database-export-json-menu-item"
          >
            {t["com.myoxus.database.json-export.title"]()}
          </MenuItem>
          {canManageLifecycle ? (
            <>
              <MenuSeparator />
              <MenuItem
                type="danger"
                prefixIcon={<TrashIcon />}
                onSelect={onTrash}
                data-testid="database-trash-menu-item"
              >
                {t["com.myoxus.moveToTrash.title"]()}
              </MenuItem>
            </>
          ) : null}
        </MenuPanel>
      }
    />
  );
});
