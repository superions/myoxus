// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Editable category toggle grid for the Metrics section (P-Metrics-E).
 *
 * `metrics.categories` is an Object-typed config field (auth/workspace/doc/
 * collab/ai → bool).  The generic `config form field` cannot render it, so this
 * component lists every key present in the map and writes each toggle through
 * `update("metrics/categories/<name>", …)`.  `useAppConfig` merges sub-paths
 * back into the full object before POSTing to the admin mutation.
 *
 * INV-MET-01 (fail-closed) is enforced on the server: disabling a category
 * here makes `MetricsRecorder::counter_inc` a no-op for that category on the
 * next tick.
 */
import { useI18n } from "@myoxus/i18n";
import {
  Group,
  SettingsEmptyState,
  SettingsHeadingGroup,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsPanelDescription,
  SettingsPanelTitle,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
} from "@myoxus/ui-facade";

import type { AppConfig } from "../settings/config";
import { getByPath } from "../settings/utils";

type Props = {
  patchedAppConfig: AppConfig;
  update: (path: string, value: unknown) => void;
};

const METRICS_CATEGORY_LABEL_KEYS = {
  ai: "admin.system.metrics.categories.name.ai",
  auth: "admin.system.metrics.categories.name.auth",
  collab: "admin.system.metrics.categories.name.collab",
  doc: "admin.system.metrics.categories.name.doc",
  mcp: "admin.system.metrics.categories.name.mcp",
  pdf_export: "admin.system.metrics.categories.name.pdf_export",
  workspace: "admin.system.metrics.categories.name.workspace",
} as const;

export function MetricsCategoriesGrid({ patchedAppConfig, update }: Props) {
  const i18n = useI18n();
  const categories =
    (getByPath(patchedAppConfig, "metrics.categories") as
      Record<string, boolean> | undefined) ?? {};

  const keys = Object.keys(categories).sort();

  if (keys.length === 0) {
    return (
      <SettingsEmptyState
        title={i18n.t("admin.system.metrics.categories.empty")}
      />
    );
  }

  return (
    <Stack>
      <SettingsHeadingGroup>
        <SettingsPanelTitle>
          {i18n.t("admin.system.metrics.categories.title")}
        </SettingsPanelTitle>
        <SettingsPanelDescription>
          {i18n.t("admin.system.metrics.categories.desc")}
        </SettingsPanelDescription>
      </SettingsHeadingGroup>

      <TableScrollContainer>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {i18n.t("admin.system.metrics.categories.col.name")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.system.metrics.categories.col.enabled")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => {
              const enabled = Boolean(categories[key]);
              const nameKey =
                METRICS_CATEGORY_LABEL_KEYS[
                  key as keyof typeof METRICS_CATEGORY_LABEL_KEYS
                ];
              const displayName = nameKey ? i18n.t(nameKey) : key;
              return (
                <TableRow key={key}>
                  <TableCell>
                    <Group wrap="nowrap">
                      <SettingsListItemTitle>
                        {displayName}
                      </SettingsListItemTitle>
                      {displayName === key ? null : (
                        <SettingsListItemMeta>{key}</SettingsListItemMeta>
                      )}
                    </Group>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={enabled}
                      variant="pill"
                      onCheckedChange={(next) =>
                        update(`metrics/categories/${key}`, next)
                      }
                      aria-label={i18n.t(
                        "admin.system.metrics.categories.aria.enabled",
                        { name: displayName },
                      )}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableScrollContainer>
    </Stack>
  );
}
