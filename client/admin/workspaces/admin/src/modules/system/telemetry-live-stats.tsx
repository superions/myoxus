// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live-stats widget for the Telemetry admin section (P-Telemetry-E).
 *
 * Runtime state is loaded through the generated `admin { telemetryStatus }`
 * GraphQL operation. This keeps auth invalidation and cache behavior identical
 * to other admin business data and avoids a permanent REST polling exception.
 *
 * The server response returns no per-user or per-IP data (INV-TEL-04 — see
 * `server/crates/api/src/admin_runtime_status.rs`).
 */
import {
  type AdminTelemetryStatusQuery,
  adminTelemetryStatusQuery,
  flushTelemetryMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  SettingsEmptyState,
  SettingsListItemMeta,
  SettingsNotice,
  SettingsPanelTitle,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
  StatCell,
  StatGrid,
} from "@myoxus/ui-facade";
import { useEffect, useState } from "react";

import { useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";
import {
  formatAdminInteger,
  formatAdminPercent,
  formatAdminTime,
} from "../../utils/locale-format";

type AdminTelemetryStatus = NonNullable<
  NonNullable<AdminTelemetryStatusQuery["admin"]>["telemetryStatus"]
>;

const REFRESH_INTERVAL_MS = 10_000;

export function TelemetryLiveStats() {
  const i18n = useI18n();
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [flushing, setFlushing] = useState(false);
  const [flushResult, setFlushResult] = useState<
    | { kind: "ok"; buffered: number; inserted: number; at: number }
    | { kind: "err"; message: string; at: number }
    | null
  >(null);
  const {
    data: queryData,
    error,
    mutate,
  } = useQuery(
    { query: adminTelemetryStatusQuery },
    { refreshInterval: REFRESH_INTERVAL_MS, suspense: false },
  );
  const flushMutation = useMutation({ mutation: flushTelemetryMutation });
  const data = queryData?.admin?.telemetryStatus ?? null;

  const triggerFlush = async () => {
    setFlushing(true);
    try {
      const response = await flushMutation.trigger();
      const json = response.admin?.flushTelemetry;
      if (!json) throw new Error("GraphQL response missing flushTelemetry");
      setFlushResult({
        kind: "ok",
        buffered: json.buffered,
        inserted: json.inserted,
        at: Date.now(),
      });
      await mutate();
    } catch (err) {
      setFlushResult({
        kind: "err",
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
    } finally {
      setFlushing(false);
    }
  };

  useEffect(() => {
    if (data) setLastFetchedAt(Date.now());
  }, [data]);

  if (error && !data) {
    return (
      <SettingsNotice tone="error">
        {i18n.t("admin.system.telemetry.live.load-failed", {
          error: error instanceof Error ? error.message : String(error),
        })}
      </SettingsNotice>
    );
  }

  if (!data) {
    return (
      <SettingsEmptyState
        title={i18n.t("admin.system.telemetry.live.loading")}
      />
    );
  }

  const telemetry = data as AdminTelemetryStatus;
  const counterRows: Array<[string, number]> = [
    ["offered", telemetry.counters.offeredTotal],
    ["accepted", telemetry.counters.acceptedTotal],
    ["rejected_disabled", telemetry.counters.rejectedDisabledTotal],
    ["rejected_category", telemetry.counters.rejectedCategoryTotal],
    ["rejected_sampled", telemetry.counters.rejectedSampledTotal],
    ["rejected_duplicate", telemetry.counters.rejectedDuplicateTotal],
    ["rejected_invalid", telemetry.counters.rejectedInvalidTotal],
    ["buffer_overflow", telemetry.counters.bufferOverflowTotal],
    ["flushed", telemetry.counters.flushedTotal],
  ];

  const dedupePct = formatAdminPercent(i18n.language, telemetry.dedupeHitRate);
  const lastFlushText = telemetry.lastFlushAt
    ? formatAdminTime(i18n.language, telemetry.lastFlushAt)
    : "—";
  const lastFlushHint = telemetry.lastFlushAt
    ? i18n.t("admin.system.telemetry.live.last-flush-count", {
        count: formatAdminInteger(i18n.language, telemetry.lastFlushCount),
      })
    : i18n.t("admin.system.telemetry.live.last-flush-never");

  return (
    <Stack data-myoxus-ui-role="system-runtime-panel">
      <SettingsToolbar justify="space-between">
        <SettingsPanelTitle>
          {i18n.t("admin.system.telemetry.live.title")}
        </SettingsPanelTitle>
        <SettingsToolbar justify="flex-start">
          {lastFetchedAt && (
            <SettingsListItemMeta>
              {i18n.t("admin.system.telemetry.live.last-refresh", {
                time: formatAdminTime(i18n.language, lastFetchedAt),
              })}
            </SettingsListItemMeta>
          )}
          <Button
            type="button"
            onClick={() => void triggerFlush()}
            disabled={flushing || !telemetry.enabled}
          >
            {flushing
              ? i18n.t("admin.system.telemetry.live.flush-running")
              : i18n.t("admin.system.telemetry.live.flush-now")}
          </Button>
        </SettingsToolbar>
      </SettingsToolbar>

      {flushResult && (
        <SettingsNotice tone={flushResult.kind === "ok" ? "success" : "error"}>
          {flushResult.kind === "ok"
            ? i18n.t("admin.system.telemetry.live.flush-ok", {
                buffered: formatAdminInteger(
                  i18n.language,
                  flushResult.buffered,
                ),
                inserted: formatAdminInteger(
                  i18n.language,
                  flushResult.inserted,
                ),
              })
            : i18n.t("admin.system.telemetry.live.flush-failed", {
                error: flushResult.message,
              })}
        </SettingsNotice>
      )}

      <StatGrid>
        <StatCell
          label={i18n.t("admin.system.telemetry.live.hot-buffer")}
          value={formatAdminInteger(i18n.language, telemetry.hotBufferLen)}
        />
        <StatCell
          label={i18n.t("admin.system.telemetry.live.persisted-24h")}
          value={
            telemetry.persisted24h === null
              ? "—"
              : formatAdminInteger(i18n.language, telemetry.persisted24h)
          }
          hint={
            telemetry.persisted24h === null
              ? i18n.t("admin.system.telemetry.live.persisted-24h-degraded")
              : undefined
          }
        />
        <StatCell
          label={i18n.t("admin.system.telemetry.live.master-switch")}
          value={
            telemetry.enabled
              ? i18n.t("admin.system.telemetry.live.on")
              : i18n.t("admin.system.telemetry.live.off")
          }
        />
        <StatCell
          label={i18n.t("admin.system.telemetry.live.last-flush")}
          value={lastFlushText}
          hint={lastFlushHint}
        />
        <StatCell
          label={i18n.t("admin.system.telemetry.live.daily-rollups-7d")}
          value={
            telemetry.dailyRollups7d === null
              ? "—"
              : formatAdminInteger(i18n.language, telemetry.dailyRollups7d)
          }
          hint={
            telemetry.dailyRollups7d === null
              ? i18n.t("admin.system.telemetry.live.daily-rollups-degraded")
              : undefined
          }
        />
        <StatCell
          label={i18n.t("admin.system.telemetry.live.dedupe-hit-rate")}
          value={dedupePct}
        />
      </StatGrid>

      <Stack>
        <SettingsPanelTitle>
          {i18n.t("admin.system.telemetry.live.counters")}
        </SettingsPanelTitle>
        <StatGrid>
          {counterRows.map(([key, value]) => (
            <StatCell
              key={key}
              density="compact"
              label={<SettingsStatusText>{key}</SettingsStatusText>}
              value={formatAdminInteger(i18n.language, value)}
            />
          ))}
        </StatGrid>
      </Stack>
    </Stack>
  );
}
