// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Editable category toggle + sampling-rate grid for the Telemetry section
 * (P-Telemetry-E).
 *
 * The server exposes `telemetry.categories` and `telemetry.samplingRates` as
 * Object-typed config fields (see `server/crates/api/src/graphql/config.rs`),
 * which the generic `config form field` cannot render.  This component renders them
 * explicitly by listing the union of keys present in either map and using
 * `update("telemetry/categories/<name>", …)` — the `useAppConfig` hook merges
 * sub-paths back into the full object before persisting.
 *
 * Adding a new category server-side (`telemetry.categories.<new_name>` default)
 * makes it appear here automatically — no code change required.
 *
 * INV-TEL-02 (fail-closed) is enforced on the server; disabling a category
 * here takes effect after Save + scheduled flush interval.
 */
import { useI18n } from "@myoxus/i18n";
import {
  Group,
  Input,
  SettingsEmptyState,
  SettingsHeadingGroup,
  SettingsPanelDescription,
  SettingsPanelTitle,
  SettingsStatusText,
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

export function TelemetryCategoriesGrid({ patchedAppConfig, update }: Props) {
  const i18n = useI18n();
  const categories =
    (getByPath(patchedAppConfig, "telemetry.categories") as
      Record<string, boolean> | undefined) ?? {};
  const samplingRates =
    (getByPath(patchedAppConfig, "telemetry.samplingRates") as
      Record<string, number> | undefined) ?? {};

  const keys = Array.from(
    new Set([...Object.keys(categories), ...Object.keys(samplingRates)]),
  ).sort();

  if (keys.length === 0) {
    return (
      <SettingsEmptyState
        title={i18n.t("admin.system.telemetry.categories.empty")}
      />
    );
  }

  return (
    <Stack>
      <SettingsHeadingGroup>
        <SettingsPanelTitle>
          {i18n.t("admin.system.telemetry.categories.title")}
        </SettingsPanelTitle>
        <SettingsPanelDescription>
          {i18n.t("admin.system.telemetry.categories.desc")}
        </SettingsPanelDescription>
      </SettingsHeadingGroup>

      <TableScrollContainer>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {i18n.t("admin.system.telemetry.categories.col.name")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.system.telemetry.categories.col.enabled")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.system.telemetry.categories.col.sampling")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => {
              const enabled = Boolean(categories[key]);
              const rate =
                typeof samplingRates[key] === "number" ? samplingRates[key] : 1;
              return (
                <TableRow key={key}>
                  <TableCell>
                    <SettingsStatusText mono>{key}</SettingsStatusText>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={enabled}
                      variant="pill"
                      onCheckedChange={(next) =>
                        update(`telemetry/categories/${key}`, next)
                      }
                      aria-label={i18n.t(
                        "admin.system.telemetry.categories.aria.enabled",
                        { name: key },
                      )}
                    />
                  </TableCell>
                  <TableCell>
                    <Group wrap="nowrap">
                      <Input
                        type="number"
                        step={0.05}
                        min={0}
                        max={1}
                        value={String(rate)}
                        onChange={(raw) => {
                          if (raw === "") {
                            update(`telemetry/samplingRates/${key}`, 0);
                            return;
                          }
                          const parsed = Number.parseFloat(raw);
                          if (!Number.isFinite(parsed)) return;
                          const clamped = Math.min(1, Math.max(0, parsed));
                          update(`telemetry/samplingRates/${key}`, clamped);
                        }}
                        aria-label={i18n.t(
                          "admin.system.telemetry.categories.aria.sampling",
                          { name: key },
                        )}
                      />
                      <SettingsStatusText>
                        {(rate * 100).toFixed(0)}%
                      </SettingsStatusText>
                    </Group>
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
