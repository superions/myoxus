// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { ImportIcon } from "@myoxus/icons/react";
import { MenuItem, MenuPanel, MenuSub } from "@myoxus/ui-facade";

export interface DatabaseImportMenuSubProps {
  csvBusy: boolean;
  jsonBusy: boolean;
  notionBusy: boolean;
  onImportCsv: () => void;
  onImportJson: () => void;
  onImportNotion: () => void;
}

/**
 * Shared entry surface for the one server-backed create-import controller.
 * It intentionally exposes no target Database because every supported import
 * creates a new Database and must never mutate the currently opened one.
 */
export function DatabaseImportMenuSub({
  csvBusy,
  jsonBusy,
  notionBusy,
  onImportCsv,
  onImportJson,
  onImportNotion,
}: DatabaseImportMenuSubProps) {
  const t = useI18n();

  return (
    <MenuSub
      items={
        <MenuPanel>
          <MenuItem
            prefixIcon={<ImportIcon />}
            disabled={csvBusy}
            onSelect={onImportCsv}
            data-testid="database-import-csv-menu-item"
          >
            {t["com.myoxus.database.csv-import.title"]()}
          </MenuItem>
          <MenuItem
            prefixIcon={<ImportIcon />}
            disabled={jsonBusy}
            onSelect={onImportJson}
            data-testid="database-import-json-menu-item"
          >
            {t["com.myoxus.database.json-import.title"]()}
          </MenuItem>
          <MenuItem
            prefixIcon={<ImportIcon />}
            disabled={notionBusy}
            onSelect={onImportNotion}
            data-testid="database-import-notion-menu-item"
          >
            {t["com.myoxus.database.notion-import.title"]()}
          </MenuItem>
        </MenuPanel>
      }
      triggerOptions={{
        prefixIcon: <ImportIcon />,
        "data-testid": "database-import-as-new-menu-item",
      }}
      narrowBehavior="inline"
    >
      {t["com.myoxus.database.import-as-new"]()}
    </MenuSub>
  );
}
