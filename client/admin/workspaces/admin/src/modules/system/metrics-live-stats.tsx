// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live-stats widget for the Metrics admin section (P-Metrics-E).
 *
 * The data path is intentionally GraphQL-first: the admin UI reads
 * `admin { metricsStatus }` and triggers `admin { flushMetrics }` through the
 * shared admin GraphQL transport so auth invalidation, cache handling and
 * operation typing stay aligned with the rest of the admin frontend.
 *
 * INV-MET-08 — the `topSeries` entries carry only allow-listed labels; the
 * server-side hook call sites never emit PII (see `docs/dev/server/metrics.md`).
 */
import {
  type AdminMetricsStatusQuery,
  adminMetricsStatusQuery,
  flushMetricsMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  InlineLink,
  SettingsEmptyState,
  SettingsListItemMeta,
  SettingsNotice,
  SettingsPanelTitle,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
  StatCell,
  StatGrid,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
} from "@myoxus/ui-facade";
import { useEffect, useState } from "react";

import { useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";
import { formatAdminInteger, formatAdminTime } from "../../utils/locale-format";

type AdminMetricsStatus = NonNullable<
  NonNullable<AdminMetricsStatusQuery["admin"]>["metricsStatus"]
>;

const REFRESH_INTERVAL_MS = 10_000;

function formatLabels(labels: unknown) {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    return "—";
  }
  const record = labels as Record<string, unknown>;
  return Object.keys(record).length === 0 ? "—" : JSON.stringify(record);
}

export function MetricsLiveStats() {
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
    { query: adminMetricsStatusQuery },
    { refreshInterval: REFRESH_INTERVAL_MS, suspense: false },
  );
  const flushMutation = useMutation({ mutation: flushMetricsMutation });
  const data = queryData?.admin?.metricsStatus ?? null;

  const triggerFlush = async () => {
    setFlushing(true);
    try {
      const response = await flushMutation.trigger();
      const json = response.admin?.flushMetrics;
      if (!json) throw new Error("GraphQL response missing flushMetrics");
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
        {i18n.t("admin.system.metrics.live.load-failed", {
          error: error instanceof Error ? error.message : String(error),
        })}
      </SettingsNotice>
    );
  }

  if (!data) {
    return (
      <SettingsEmptyState title={i18n.t("admin.system.metrics.live.loading")} />
    );
  }

  const metrics = data as AdminMetricsStatus;
  const counterRows: Array<[string, string, number]> = [
    [
      "offered",
      i18n.t("admin.system.metrics.live.counter.offered"),
      metrics.counters.offeredTotal,
    ],
    [
      "accepted",
      i18n.t("admin.system.metrics.live.counter.accepted"),
      metrics.counters.acceptedTotal,
    ],
    [
      "rejected_disabled",
      i18n.t("admin.system.metrics.live.counter.rejected-disabled"),
      metrics.counters.rejectedDisabledTotal,
    ],
    [
      "cardinality_drops",
      i18n.t("admin.system.metrics.live.counter.cardinality-drops"),
      metrics.counters.cardinalityDropsTotal,
    ],
    [
      "snapshots",
      i18n.t("admin.system.metrics.live.counter.snapshots"),
      metrics.counters.snapshotsTotal,
    ],
  ];

  const lastFlushText = metrics.lastFlushAt
    ? formatAdminTime(i18n.language, metrics.lastFlushAt)
    : "—";
  const lastFlushHint = metrics.lastFlushAt
    ? i18n.t("admin.system.metrics.live.last-flush-count", {
        count: formatAdminInteger(i18n.language, metrics.lastFlushCount),
      })
    : i18n.t("admin.system.metrics.live.last-flush-never");

  return (
    <Stack data-myoxus-ui-role="system-runtime-panel">
      <SettingsToolbar justify="space-between">
        <SettingsPanelTitle>
          {i18n.t("admin.system.metrics.live.title")}
        </SettingsPanelTitle>
        <SettingsToolbar justify="flex-start">
          {lastFetchedAt && (
            <SettingsListItemMeta>
              {i18n.t("admin.system.metrics.live.last-refresh", {
                time: formatAdminTime(i18n.language, lastFetchedAt),
              })}
            </SettingsListItemMeta>
          )}
          <InlineLink
            href="/metrics/prometheus"
            target="_blank"
            rel="noreferrer"
          >
            {i18n.t("admin.system.metrics.live.prometheus-link")}
          </InlineLink>
          <Button
            type="button"
            onClick={() => void triggerFlush()}
            disabled={flushing || !metrics.enabled}
          >
            {flushing
              ? i18n.t("admin.system.metrics.live.flush-running")
              : i18n.t("admin.system.metrics.live.flush-now")}
          </Button>
        </SettingsToolbar>
      </SettingsToolbar>

      {flushResult && (
        <SettingsNotice tone={flushResult.kind === "ok" ? "success" : "error"}>
          {flushResult.kind === "ok"
            ? i18n.t("admin.system.metrics.live.flush-ok", {
                buffered: formatAdminInteger(
                  i18n.language,
                  flushResult.buffered,
                ),
                inserted: formatAdminInteger(
                  i18n.language,
                  flushResult.inserted,
                ),
              })
            : i18n.t("admin.system.metrics.live.flush-failed", {
                error: flushResult.message,
              })}
        </SettingsNotice>
      )}

      <StatGrid>
        <StatCell
          label={i18n.t("admin.system.metrics.live.active-series")}
          value={formatAdminInteger(i18n.language, metrics.activeSeries)}
        />
        <StatCell
          label={i18n.t("admin.system.metrics.live.persisted-24h")}
          value={
            metrics.persisted24h === null
              ? "—"
              : formatAdminInteger(i18n.language, metrics.persisted24h)
          }
          hint={
            metrics.persisted24h === null
              ? i18n.t("admin.system.metrics.live.persisted-24h-degraded")
              : undefined
          }
        />
        <StatCell
          label={i18n.t("admin.system.metrics.live.master-switch")}
          value={
            metrics.enabled
              ? i18n.t("admin.system.metrics.live.on")
              : i18n.t("admin.system.metrics.live.off")
          }
        />
        <StatCell
          label={i18n.t("admin.system.metrics.live.last-flush")}
          value={lastFlushText}
          hint={lastFlushHint}
        />
        <StatCell
          label={i18n.t("admin.system.metrics.live.daily-rollups-7d")}
          value={
            metrics.dailyRollups7d === null
              ? "—"
              : formatAdminInteger(i18n.language, metrics.dailyRollups7d)
          }
          hint={
            metrics.dailyRollups7d === null
              ? i18n.t("admin.system.metrics.live.daily-rollups-degraded")
              : undefined
          }
        />
        <StatCell
          label={i18n.t("admin.system.metrics.live.cardinality-drops")}
          value={formatAdminInteger(
            i18n.language,
            metrics.counters.cardinalityDropsTotal,
          )}
        />
      </StatGrid>

      <Stack>
        <SettingsPanelTitle>
          {i18n.t("admin.system.metrics.live.counters")}
        </SettingsPanelTitle>
        <StatGrid>
          {counterRows.map(([key, label, value]) => (
            <StatCell
              key={key}
              density="compact"
              label={<SettingsStatusText>{label}</SettingsStatusText>}
              value={formatAdminInteger(i18n.language, value)}
            />
          ))}
        </StatGrid>
      </Stack>

      {metrics.topSeries.length > 0 && (
        <Stack>
          <SettingsPanelTitle>
            {i18n.t("admin.system.metrics.live.top-series")}
          </SettingsPanelTitle>
          <TableScrollContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {i18n.t("admin.system.metrics.live.top-col.category")}
                  </TableHead>
                  <TableHead>
                    {i18n.t("admin.system.metrics.live.top-col.name")}
                  </TableHead>
                  <TableHead>
                    {i18n.t("admin.system.metrics.live.top-col.labels")}
                  </TableHead>
                  <TableHead ta="right">
                    {i18n.t("admin.system.metrics.live.top-col.value")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {metrics.topSeries.map((series, idx) => (
                  <TableRow key={`${series.category}:${series.name}:${idx}`}>
                    <TableCell mono>{series.category}</TableCell>
                    <TableCell mono>{series.name}</TableCell>
                    <TableCell muted>{formatLabels(series.labels)}</TableCell>
                    <TableCell ta="right">
                      {formatAdminInteger(i18n.language, series.value)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScrollContainer>
        </Stack>
      )}
    </Stack>
  );
}
