// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Admin dashboard page — operator console.
 *
 * The data contract is intentionally one GraphQL surface (`adminDashboard`):
 * runtime counters, queues, security, cache and product activity are composed
 * server-side so the Admin UI does not parse Prometheus text or fan out across
 * unrelated API roots.
 */
import { useQuery } from "@myoxus/admin/use-query";
import { adminDashboardQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { ROUTES } from "@myoxus/routes";
import {
  Button,
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  DashboardChartAxis,
  DashboardChartFrame,
  DashboardSignalBar,
  DashboardSignalLabels,
  DashboardSkeletonCard,
  DashboardSkeletonHero,
  FormSelect,
  Group,
  InlineLink,
  MetricValue,
  NavigationLink,
  SimpleGrid,
  SettingsEmptyState,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsNotice,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
  Text,
} from "@myoxus/ui-facade";
import { type ReactNode, Suspense, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";

import { useMutateQueryResource } from "../../use-mutation";
import { AdminPageFrame, AdminPageScroll } from "../admin-shell";
import { OperationalReadinessNotice } from "../operational-readiness-notice";
import { formatBytes } from "../workspaces/utils";
import {
  dashboardOverviewSchema,
  dashboardSharedLinksSchema,
  type DashboardModel,
  type DashboardSharedLinksModel,
} from "./dashboard-data";

const DASHBOARD_REFRESH_MS = 10_000;
type Tone = "neutral" | "success" | "warning" | "error" | "info";

const DASHBOARD_STATUS_LABEL_KEYS = {
  neutral: "admin.dashboard.status.neutral",
  success: "admin.dashboard.status.success",
  warning: "admin.dashboard.status.warning",
  error: "admin.dashboard.status.error",
  info: "admin.dashboard.status.info",
} as const;

function DashboardStatusDot({ tone, label }: { tone: Tone; label: ReactNode }) {
  return <StatusDot tone={tone} label={label} />;
}

const adminDashboardOverviewQuery: typeof adminDashboardQuery = {
  ...adminDashboardQuery,
  query: `query adminDashboard($input: AdminDashboardInput) {
  admin {
    adminDashboard(input: $input) {
      syncActiveUsers
      syncActiveUsersTimeline { minute activeUsers }
      syncWindow { from to timezone bucket requestedSize effectiveSize }
      copilotConversations
      workspaceStorageBytes
      blobStorageBytes
      workspaceStorageHistory { date value }
      blobStorageHistory { date value }
      storageWindow { from to timezone bucket requestedSize effectiveSize }
      topSharedLinksWindow { from to timezone bucket requestedSize effectiveSize }
      runtime {
        processUptimeSeconds
        requestsTotal
        requestsErrorTotal
        requestErrorRate
        requestThroughputRps
        requestLatencyAvgMs
        requestLatencyMaxMs
      }
      queueSummary {
        pendingReadyTotal
        failedTotal
        queues { queue pendingReady failed deadLetter queueLagSeconds }
      }
      metricsPipeline {
        enabled
        prometheusEnabled
        persistenceEnabled
        activeSeries
        persisted24H
        dailyRollups7D
        lastFlushAt
        lastFlushCount
        flushIntervalSeconds
        offeredTotal
        acceptedTotal
        rejectedDisabledTotal
        cardinalityDropsTotal
      }
      telemetryPipeline {
        enabled
        hotBufferLen
        persisted24H
        dailyRollups7D
        lastFlushAt
        lastFlushCount
        offeredTotal
        acceptedTotal
        rejectedTotal
        bufferOverflowTotal
        dedupeHitRate
      }
      captcha {
        enabled
        hmacKeyConfigured
        verifiedTotal
        rejectedTotal
        honeypotTotal
      }
      dbPool { active idle max userCount workspaceCount }
      cacheMetrics {
        name
        hitsTotal
        missesTotal
        hitRate
        invalidationsLocalTotal
        invalidationsRemoteTotal
        entryCount
      }
      generatedAt
    }
  }
}`,
};

const adminDashboardTopSharedLinksQuery: typeof adminDashboardQuery = {
  ...adminDashboardQuery,
  query: `query adminDashboard($input: AdminDashboardInput) {
  admin {
    adminDashboard(input: $input) {
      topSharedLinks {
        workspaceId
        docId
        title
        shareUrl
        publishedAt
        views
        uniqueViews
        guestViews
        lastAccessedAt
      }
      topSharedLinksWindow { from to timezone bucket requestedSize effectiveSize }
    }
  }
}`,
};

function createDashboardFormatters(language: string) {
  return {
    int: new Intl.NumberFormat(language),
    compact: new Intl.NumberFormat(language, {
      notation: "compact",
      maximumFractionDigits: 1,
    }),
    percent: new Intl.NumberFormat(language, {
      style: "percent",
      maximumFractionDigits: 1,
    }),
    decimal: new Intl.NumberFormat(language, {
      maximumFractionDigits: 2,
    }),
    utcDateTime: new Intl.DateTimeFormat(language, {
      timeZone: "UTC",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }),
    utcDate: new Intl.DateTimeFormat(language, {
      timeZone: "UTC",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }),
  };
}

type DashboardFormatters = ReturnType<typeof createDashboardFormatters>;

const STORAGE_DAY_OPTIONS = [7, 14, 30, 60, 90] as const;
const SYNC_HOUR_OPTIONS = [1, 6, 12, 24, 48, 72] as const;
const SHARED_DAY_OPTIONS = [7, 14, 28, 60, 90] as const;

type TrendPoint = {
  x: number;
  label: string;
  primary?: number;
  secondary?: number;
};

type MetricItem = {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
};

function formatDateTime(formatters: DashboardFormatters, value: string) {
  return formatters.utcDateTime.format(new Date(value));
}

function formatDate(formatters: DashboardFormatters, value: string) {
  return formatters.utcDate.format(new Date(value));
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.max(0, seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatMetricNumber(
  formatters: DashboardFormatters,
  value: number | null | undefined,
) {
  if (value === null || value === undefined) return "—";
  return formatters.int.format(value);
}

function formatMs(formatters: DashboardFormatters, value: number) {
  return `${formatters.decimal.format(value)} ms`;
}

function downsample<T>(items: T[], maxPoints: number) {
  if (items.length <= maxPoints) return items;
  const step = Math.ceil(items.length / maxPoints);
  return items.filter(
    (_, index) => index % step === 0 || index === items.length - 1,
  );
}

function toIndexedTrendPoints<T extends Omit<TrendPoint, "x">>(points: T[]) {
  return points.map((point, index) => ({ ...point, x: index }));
}

function chooseRuntimeTone(runtime: DashboardModel["runtime"]): Tone {
  if (runtime.requestErrorRate >= 0.05 || runtime.requestLatencyMaxMs >= 5000) {
    return "error";
  }
  if (runtime.requestErrorRate >= 0.01 || runtime.requestLatencyAvgMs >= 1000) {
    return "warning";
  }
  return "success";
}

function chooseQueueTone(queue: DashboardModel["queueSummary"]): Tone {
  if (queue.failedTotal > 0) return "error";
  if (queue.pendingReadyTotal > 0) return "warning";
  return "success";
}

function chooseMetricsTone(pipeline: DashboardModel["metricsPipeline"]): Tone {
  if (!pipeline.enabled) return "neutral";
  if (pipeline.cardinalityDropsTotal > 0) return "error";
  if (!pipeline.lastFlushAt) return "warning";
  const ageSeconds = Math.max(
    0,
    (Date.now() - new Date(pipeline.lastFlushAt).getTime()) / 1000,
  );
  return ageSeconds > pipeline.flushIntervalSeconds * 3 ? "warning" : "success";
}

function chooseTelemetryTone(
  pipeline: DashboardModel["telemetryPipeline"],
): Tone {
  if (!pipeline.enabled) return "neutral";
  if (
    pipeline.bufferOverflowTotal > 0 ||
    pipeline.rejectedTotal > pipeline.acceptedTotal
  ) {
    return "error";
  }
  if (pipeline.rejectedTotal > 0 || pipeline.hotBufferLen > 0) return "warning";
  return "success";
}

function chooseSecurityTone(captcha: DashboardModel["captcha"]): Tone {
  if (!captcha.enabled) return "neutral";
  if (!captcha.hmacKeyConfigured || captcha.honeypotTotal > 0) return "error";
  if (captcha.rejectedTotal > 0) return "warning";
  return "success";
}

function TrendChart({
  ariaLabel,
  points,
  primaryLabel,
  primaryFormatter,
  secondaryLabel,
  secondaryFormatter,
  start,
  end,
}: {
  ariaLabel: string;
  points: TrendPoint[];
  primaryLabel: string;
  primaryFormatter: (value: number) => string;
  secondaryLabel?: string;
  secondaryFormatter?: (value: number) => string;
  start: string;
  end: string;
}) {
  const i18n = useI18n();
  const formatters = useMemo(
    () => createDashboardFormatters(i18n.language),
    [i18n.language],
  );
  if (points.length === 0) {
    return (
      <Stack>
        <SettingsEmptyState title={i18n.t("admin.dashboard.no-data")} />
        <DashboardChartAxis start={start} end={end} />
      </Stack>
    );
  }

  const chartPoints = points;
  const hasSecondary =
    Boolean(secondaryLabel) &&
    chartPoints.some((point) => typeof point.secondary === "number");
  const config: ChartConfig = {
    primary: { label: primaryLabel, color: "var(--myoxus-text-primary-color)" },
    ...(hasSecondary
      ? {
          secondary: {
            label: secondaryLabel,
            color: "var(--myoxus-processing-color)",
          },
        }
      : {}),
  };

  return (
    <Stack>
      <DashboardChartFrame aria-label={ariaLabel} role="img">
        <ChartContainer config={config}>
          <ComposedChart
            data={chartPoints}
            margin={{ top: 8, right: 0, bottom: 0, left: 0 }}
          >
            <CartesianGrid
              vertical={false}
              stroke="var(--myoxus-border-color)"
              strokeDasharray="3 4"
            />
            <XAxis
              dataKey="x"
              type="number"
              hide
              allowDecimals={false}
              domain={["dataMin", "dataMax"]}
            />
            <YAxis
              hide
              domain={[
                0,
                (max: number) => (max <= 0 ? 1 : Math.ceil(max * 1.1)),
              ]}
            />
            <ChartTooltip
              cursor={{
                stroke: "var(--myoxus-border-color)",
                strokeDasharray: "4 4",
                strokeWidth: 1,
              }}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    payload?.[0]?.payload?.label ?? ""
                  }
                  valueFormatter={(value, key) =>
                    key === "secondary"
                      ? secondaryFormatter
                        ? secondaryFormatter(value)
                        : formatters.int.format(value)
                      : primaryFormatter(value)
                  }
                />
              }
            />
            <Area
              dataKey="primary"
              type="monotone"
              fill="var(--color-primary)"
              fillOpacity={0.12}
              stroke="none"
              isAnimationActive={false}
            />
            <Line
              dataKey="primary"
              type="monotone"
              stroke="var(--color-primary)"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={points.length === 1 ? { r: 3 } : false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            {hasSecondary ? (
              <Line
                dataKey="secondary"
                type="monotone"
                stroke="var(--color-secondary)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={points.length === 1 ? { r: 3 } : false}
                activeDot={{ r: 3 }}
                strokeDasharray="6 4"
                isAnimationActive={false}
              />
            ) : null}
          </ComposedChart>
        </ChartContainer>
      </DashboardChartFrame>
      <DashboardChartAxis start={start} end={end} />
    </Stack>
  );
}

function SignalBarChart({
  ariaLabel,
  items,
}: {
  ariaLabel: string;
  items: {
    label: string;
    value: number;
    max: number;
    tone: Tone;
    valueLabel: string;
  }[];
}) {
  return (
    <Stack role="img" aria-label={ariaLabel}>
      {items.map((item) => (
        <Stack key={item.label}>
          <DashboardSignalLabels label={item.label} value={item.valueLabel} />
          <DashboardSignalBar
            aria-label={`${item.label}: ${item.valueLabel}`}
            value={item.value}
            max={item.max}
            tone={item.tone}
          />
        </Stack>
      ))}
    </Stack>
  );
}

function DashboardPageSkeleton() {
  const i18n = useI18n();
  return (
    <AdminPageFrame
      title={i18n.t("admin.dashboard.title")}
      routeAnchor="admin-route-dashboard"
    >
      <AdminPageScroll>
        <Stack>
          <DashboardSkeletonHero />
          <SimpleGrid cols={{ base: 1, lg: 2 }}>
            <DashboardSkeletonCard />
            <DashboardSkeletonCard />
            <DashboardSkeletonCard />
            <DashboardSkeletonCard />
          </SimpleGrid>
        </Stack>
      </AdminPageScroll>
    </AdminPageFrame>
  );
}

function TopSharedLinksSection({
  sharedLinkWindowDays,
}: {
  sharedLinkWindowDays: number;
}) {
  const variables = useMemo(
    () => ({ input: { sharedLinkWindowDays, timezone: "UTC" } }),
    [sharedLinkWindowDays],
  );
  const { data, error, isLoading, isValidating, mutate } = useQuery(
    { query: adminDashboardTopSharedLinksQuery, variables },
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      revalidateIfStale: true,
      revalidateOnReconnect: true,
      refreshInterval: DASHBOARD_REFRESH_MS,
    },
  );
  const i18n = useI18n();
  const formatters = useMemo(
    () => createDashboardFormatters(i18n.language),
    [i18n.language],
  );
  const result = useMemo(
    () => dashboardSharedLinksSchema.safeParse(data?.admin?.adminDashboard),
    [data],
  );
  const [lastResponse, setLastResponse] = useState<DashboardSharedLinksModel>();
  const [retryFailed, setRetryFailed] = useState(false);
  if (result.success && lastResponse !== result.data) {
    setLastResponse(result.data);
    setRetryFailed(false);
  }
  const dashboard = result.success ? result.data : lastResponse;
  const failed = Boolean(error || retryFailed);
  const incomplete = !result.success && data !== undefined;
  const retry = async () => {
    setRetryFailed(false);
    try {
      await mutate();
    } catch {
      setRetryFailed(true);
    }
  };
  if (!dashboard) {
    return !failed && !incomplete && (isLoading || isValidating) ? (
      <DashboardSkeletonCard />
    ) : (
      <SettingsNotice
        tone="error"
        role="alert"
        title={i18n.t("admin.dashboard.top-shared-links")}
      >
        {i18n.t(
          incomplete
            ? "admin.dashboard.data-incomplete"
            : "admin.dashboard.data-unavailable",
        )}
        <Group>
          <Button
            type="button"
            onClick={() => void retry()}
            disabled={isValidating}
          >
            {i18n.t("admin.error.retry")}
          </Button>
        </Group>
      </SettingsNotice>
    );
  }
  const topSharedLinks = dashboard.topSharedLinks;
  const topSharedLinksWindow = dashboard.topSharedLinksWindow;

  return (
    <Stack component="section">
      <Group justify="space-between" align="flex-start">
        <SettingsHeadingGroup>
          <SettingsSectionHeading>
            {i18n.t("admin.dashboard.top-shared-links")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.dashboard.top-links-description", {
              count: topSharedLinks.length,
              days: topSharedLinksWindow.effectiveSize,
            })}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <DashboardStatusDot
          tone="warning"
          label={i18n.t("admin.dashboard.cluster.product")}
        />
      </Group>
      {failed || incomplete || isValidating ? (
        <SettingsNotice
          tone={failed || incomplete ? "warning" : "neutral"}
          role="status"
        >
          {i18n.t(
            incomplete
              ? "admin.dashboard.data-incomplete"
              : failed
                ? "admin.dashboard.data-stale"
                : "admin.dashboard.refreshing",
          )}
          {failed || incomplete ? (
            <Group>
              <Button
                type="button"
                onClick={() => void retry()}
                disabled={isValidating}
              >
                {i18n.t("admin.error.retry")}
              </Button>
            </Group>
          ) : null}
        </SettingsNotice>
      ) : null}
      {topSharedLinksWindow.effectiveSize !== sharedLinkWindowDays ? (
        <SettingsStatusText>
          {i18n.t("admin.dashboard.server-day-window", {
            size: topSharedLinksWindow.effectiveSize,
            requested: sharedLinkWindowDays,
          })}
        </SettingsStatusText>
      ) : null}
      {topSharedLinks.length === 0 ? (
        <Stack>
          <SettingsEmptyState
            title={i18n.t("admin.dashboard.no-shared-links")}
            description={i18n.t("admin.dashboard.no-shared-links-hint")}
          />
          <NavigationLink
            component={Link}
            to={ROUTES.admin.workspaces}
            label={i18n.t("admin.dashboard.go-to-workspaces")}
          />
        </Stack>
      ) : (
        <TableScrollContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {i18n.t("admin.dashboard.table.document")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.dashboard.table.workspace")}
                </TableHead>
                <TableHead ta="right">
                  {i18n.t("admin.dashboard.table.views")}
                </TableHead>
                <TableHead ta="right">
                  {i18n.t("admin.dashboard.table.unique")}
                </TableHead>
                <TableHead ta="right">
                  {i18n.t("admin.dashboard.table.guest")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.dashboard.table.last-accessed")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {topSharedLinks.map((link) => (
                <TableRow key={`${link.workspaceId}-${link.docId}`}>
                  <TableCell>
                    <InlineLink
                      href={link.shareUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {link.title || link.docId}
                    </InlineLink>
                  </TableCell>
                  <TableCell mono muted>
                    {link.workspaceId}
                  </TableCell>
                  <TableCell ta="right" tabular>
                    {formatters.compact.format(link.views)}
                  </TableCell>
                  <TableCell ta="right" tabular>
                    {formatters.compact.format(link.uniqueViews)}
                  </TableCell>
                  <TableCell ta="right" tabular>
                    {formatters.compact.format(link.guestViews)}
                  </TableCell>
                  <TableCell>
                    {link.lastAccessedAt
                      ? formatDateTime(formatters, link.lastAccessedAt)
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScrollContainer>
      )}
      <DashboardChartAxis
        start={formatDate(formatters, topSharedLinksWindow.from)}
        end={formatDate(formatters, topSharedLinksWindow.to)}
      />
    </Stack>
  );
}

function DashboardPageContent() {
  const i18n = useI18n();
  const formatters = useMemo(
    () => createDashboardFormatters(i18n.language),
    [i18n.language],
  );
  const [storageHistoryDays, setStorageHistoryDays] = useState<number>(30);
  const [syncHistoryHours, setSyncHistoryHours] = useState<number>(48);
  const [sharedLinkWindowDays, setSharedLinkWindowDays] = useState<number>(28);
  const shouldShowTopSharedLinks = !environment.isSelfHosted;
  const revalidateQueryResource = useMutateQueryResource();

  const variables = useMemo(
    () => ({
      input: {
        storageHistoryDays,
        syncHistoryHours,
        sharedLinkWindowDays,
        timezone: "UTC",
      },
    }),
    [sharedLinkWindowDays, storageHistoryDays, syncHistoryHours],
  );

  const { data, error, isLoading, isValidating } = useQuery(
    { query: adminDashboardOverviewQuery, variables },
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      revalidateIfStale: true,
      revalidateOnReconnect: true,
      refreshInterval: DASHBOARD_REFRESH_MS,
    },
  );

  const result = useMemo(
    () => dashboardOverviewSchema.safeParse(data?.admin?.adminDashboard),
    [data],
  );
  const [lastResponse, setLastResponse] = useState<DashboardModel>();
  const [refreshFailed, setRefreshFailed] = useState(false);
  // A failed or incomplete poll keeps the last complete server projection,
  // including its original windows and timestamp. Never merge in zero defaults.
  if (result.success && lastResponse !== result.data) {
    setLastResponse(result.data);
    setRefreshFailed(false);
  }
  const dashboard = result.success ? result.data : lastResponse;
  const failed = Boolean(error || refreshFailed);
  const incomplete = !result.success && data !== undefined;
  const refresh = async () => {
    setRefreshFailed(false);
    try {
      await revalidateQueryResource(
        adminDashboardOverviewQuery,
        (cachedVariables) =>
          JSON.stringify(cachedVariables) === JSON.stringify(variables) ||
          (shouldShowTopSharedLinks &&
            JSON.stringify(cachedVariables) ===
              JSON.stringify({
                input: { sharedLinkWindowDays, timezone: "UTC" },
              })),
      );
    } catch {
      setRefreshFailed(true);
    }
  };
  if (!dashboard) {
    if (!failed && !incomplete && (isLoading || isValidating))
      return <DashboardPageSkeleton />;
    return (
      <AdminPageFrame
        title={i18n.t("admin.dashboard.title")}
        routeAnchor="admin-route-dashboard"
      >
        <AdminPageScroll>
          <Stack>
            <OperationalReadinessNotice />
            <SettingsNotice
              tone="error"
              role="alert"
              data-testid="dashboard-data-error"
            >
              {i18n.t(
                incomplete
                  ? "admin.dashboard.data-incomplete"
                  : "admin.dashboard.data-unavailable",
              )}
              <Group>
                <Button
                  type="button"
                  onClick={() => void refresh()}
                  disabled={isValidating}
                >
                  {i18n.t("admin.error.retry")}
                </Button>
              </Group>
            </SettingsNotice>
          </Stack>
        </AdminPageScroll>
      </AdminPageFrame>
    );
  }
  return (
    <DashboardOverview
      dashboard={dashboard}
      formatters={formatters}
      isValidating={isValidating}
      refresh={refresh}
      storageHistoryDays={storageHistoryDays}
      setStorageHistoryDays={setStorageHistoryDays}
      syncHistoryHours={syncHistoryHours}
      setSyncHistoryHours={setSyncHistoryHours}
      sharedLinkWindowDays={sharedLinkWindowDays}
      setSharedLinkWindowDays={setSharedLinkWindowDays}
      shouldShowTopSharedLinks={shouldShowTopSharedLinks}
      dataNotice={
        failed || incomplete || isValidating ? (
          <SettingsNotice
            tone={failed || incomplete ? "warning" : "neutral"}
            role="status"
            data-testid="dashboard-data-status"
          >
            {i18n.t(
              incomplete
                ? "admin.dashboard.data-incomplete"
                : failed
                  ? "admin.dashboard.data-stale"
                  : "admin.dashboard.refreshing",
            )}
            {failed || incomplete ? (
              <Group>
                <Button
                  type="button"
                  onClick={() => void refresh()}
                  disabled={isValidating}
                >
                  {i18n.t("admin.error.retry")}
                </Button>
              </Group>
            ) : null}
          </SettingsNotice>
        ) : null
      }
    />
  );
}

function DashboardOverview({
  dashboard,
  formatters,
  isValidating,
  refresh,
  storageHistoryDays,
  setStorageHistoryDays,
  syncHistoryHours,
  setSyncHistoryHours,
  sharedLinkWindowDays,
  setSharedLinkWindowDays,
  shouldShowTopSharedLinks,
  dataNotice,
}: {
  dashboard: DashboardModel;
  formatters: DashboardFormatters;
  isValidating: boolean;
  refresh: () => Promise<void>;
  storageHistoryDays: number;
  setStorageHistoryDays: (value: number) => void;
  syncHistoryHours: number;
  setSyncHistoryHours: (value: number) => void;
  sharedLinkWindowDays: number;
  setSharedLinkWindowDays: (value: number) => void;
  shouldShowTopSharedLinks: boolean;
  dataNotice: ReactNode;
}) {
  const i18n = useI18n();
  // TimeWindow sizes use their bucket unit: the sync resolver returns minutes.
  const syncWindowHours = dashboard.syncWindow.effectiveSize / 60;
  const runtimeTone = chooseRuntimeTone(dashboard.runtime);
  const queueTone = chooseQueueTone(dashboard.queueSummary);
  const metricsTone = chooseMetricsTone(dashboard.metricsPipeline);
  const telemetryTone = chooseTelemetryTone(dashboard.telemetryPipeline);
  const securityTone = chooseSecurityTone(dashboard.captcha);
  const totalStorageBytes =
    dashboard.workspaceStorageBytes + dashboard.blobStorageBytes;
  const cacheLookups = dashboard.cacheMetrics.reduce(
    (sum, cache) => sum + cache.hitsTotal + cache.missesTotal,
    0,
  );
  const cacheHitRate =
    cacheLookups === 0
      ? 0
      : dashboard.cacheMetrics.reduce(
          (sum, cache) => sum + cache.hitsTotal,
          0,
        ) / cacheLookups;
  const dbPoolRatio =
    dashboard.dbPool && dashboard.dbPool.max > 0
      ? dashboard.dbPool.active / dashboard.dbPool.max
      : 0;
  const capacityTone: Tone =
    dbPoolRatio > 0.85 ? "error" : dbPoolRatio > 0.65 ? "warning" : "success";

  const syncPoints = useMemo(
    () =>
      toIndexedTrendPoints(
        downsample(
          dashboard.syncActiveUsersTimeline.map((point) => ({
            label: formatDateTime(formatters, point.minute),
            primary: point.activeUsers,
          })),
          96,
        ),
      ),
    [dashboard.syncActiveUsersTimeline, formatters],
  );
  const storagePoints = useMemo(() => {
    const workspace = new Map(
      dashboard.workspaceStorageHistory.map((point) => [
        Date.parse(point.date),
        point.value,
      ]),
    );
    const blobs = new Map(
      dashboard.blobStorageHistory.map((point) => [
        Date.parse(point.date),
        point.value,
      ]),
    );
    // Series can have different dates. Match their timestamps and keep gaps;
    // array positions and zero substitution would invent storage measurements.
    const dates = [...new Set([...workspace.keys(), ...blobs.keys()])].sort(
      (a, b) => a - b,
    );
    return toIndexedTrendPoints(
      downsample(
        dates.map((date) => ({
          label: formatDate(formatters, new Date(date).toISOString()),
          primary: workspace.get(date),
          secondary: blobs.get(date),
        })),
        60,
      ),
    );
  }, [
    dashboard.blobStorageHistory,
    dashboard.workspaceStorageHistory,
    formatters,
  ]);
  const runtimeThroughputScale = Math.max(
    1,
    dashboard.runtime.requestThroughputRps,
  );
  const runtimeLatencyScale = Math.max(
    1000,
    dashboard.runtime.requestLatencyAvgMs,
    dashboard.runtime.requestLatencyMaxMs,
  );
  const dbPoolMax = Math.max(1, dashboard.dbPool?.max ?? 0);

  const clusters: {
    title: string;
    description: string;
    to: string;
    items: MetricItem[];
  }[] = [
    {
      title: i18n.t("admin.dashboard.cluster.health"),
      description: i18n.t("admin.dashboard.cluster.health-description"),
      to: ROUTES.admin.performance,
      items: [
        {
          label: i18n.t("admin.dashboard.metric.uptime"),
          value: formatDuration(dashboard.runtime.processUptimeSeconds),
          hint: i18n.t("admin.dashboard.metric.uptime-hint"),
          tone: runtimeTone,
        },
        {
          label: i18n.t("admin.dashboard.metric.error-rate"),
          value: formatters.percent.format(dashboard.runtime.requestErrorRate),
          hint: `${formatMetricNumber(formatters, dashboard.runtime.requestsErrorTotal)} / ${formatMetricNumber(formatters, dashboard.runtime.requestsTotal)}`,
          tone: runtimeTone,
        },
        {
          label: i18n.t("admin.dashboard.metric.rps"),
          value: formatters.decimal.format(
            dashboard.runtime.requestThroughputRps,
          ),
          hint: i18n.t("admin.dashboard.metric.rps-hint"),
        },
        {
          label: i18n.t("admin.dashboard.metric.latency"),
          value: formatMs(formatters, dashboard.runtime.requestLatencyAvgMs),
          hint: i18n.t("admin.dashboard.metric.latency-hint", {
            max: formatMs(formatters, dashboard.runtime.requestLatencyMaxMs),
          }),
        },
      ],
    },
    {
      title: i18n.t("admin.dashboard.cluster.pipeline"),
      description: i18n.t("admin.dashboard.cluster.pipeline-description"),
      to: ROUTES.admin.queue,
      items: [
        {
          label: i18n.t("admin.dashboard.metric.queue-backlog"),
          value: formatMetricNumber(
            formatters,
            dashboard.queueSummary.pendingReadyTotal,
          ),
          hint: i18n.t("admin.dashboard.metric.queue-backlog-hint", {
            count: dashboard.queueSummary.queues.length,
          }),
          tone: queueTone,
        },
        {
          label: i18n.t("admin.dashboard.metric.queue-failed"),
          value: formatMetricNumber(
            formatters,
            dashboard.queueSummary.failedTotal,
          ),
          hint: i18n.t("admin.dashboard.metric.queue-failed-hint"),
          tone: queueTone,
        },
        {
          label: i18n.t("admin.dashboard.metric.metrics-active-series"),
          value: formatMetricNumber(
            formatters,
            dashboard.metricsPipeline.activeSeries,
          ),
          hint: i18n.t("admin.dashboard.metric.metrics-active-series-hint"),
          tone: metricsTone,
        },
        {
          label: i18n.t("admin.dashboard.metric.metrics-last-flush"),
          value: dashboard.metricsPipeline.lastFlushAt
            ? formatDateTime(formatters, dashboard.metricsPipeline.lastFlushAt)
            : "—",
          hint: i18n.t("admin.dashboard.metric.metrics-last-flush-hint", {
            count: dashboard.metricsPipeline.lastFlushCount,
          }),
          tone: metricsTone,
        },
      ],
    },
    {
      title: i18n.t("admin.dashboard.cluster.activity"),
      description: i18n.t("admin.dashboard.cluster.activity-description"),
      to: ROUTES.admin.workspaces,
      items: [
        {
          label: i18n.t("admin.dashboard.sync-active-users"),
          value: formatMetricNumber(formatters, dashboard.syncActiveUsers),
          hint: i18n.t("admin.dashboard.active-window", {
            size: syncWindowHours,
          }),
          tone: "info",
        },
        {
          label: i18n.t("admin.dashboard.metric.telemetry-doc-ops"),
          value: formatMetricNumber(
            formatters,
            dashboard.telemetryPipeline.acceptedTotal,
          ),
          hint: i18n.t("admin.dashboard.metric.telemetry-doc-ops-hint"),
          tone: telemetryTone,
        },
        {
          label: i18n.t("admin.dashboard.metric.telemetry-buffer"),
          value: formatMetricNumber(
            formatters,
            dashboard.telemetryPipeline.hotBufferLen,
          ),
          hint: i18n.t("admin.dashboard.metric.telemetry-buffer-hint"),
          tone: telemetryTone,
        },
        {
          label: i18n.t("admin.dashboard.metric.metrics-accepted"),
          value: formatMetricNumber(
            formatters,
            dashboard.metricsPipeline.acceptedTotal,
          ),
          hint: i18n.t("admin.dashboard.metric.metrics-accepted-hint"),
          tone: metricsTone,
        },
      ],
    },
    {
      title: i18n.t("admin.dashboard.cluster.product"),
      description: i18n.t("admin.dashboard.cluster.product-description"),
      to: ROUTES.admin.ai,
      items: [
        {
          label: i18n.t("admin.dashboard.copilot-conversations"),
          value: formatMetricNumber(formatters, dashboard.copilotConversations),
          hint: i18n.t("admin.dashboard.metric.copilot-hint"),
        },
        {
          label: i18n.t("admin.dashboard.metric.business-samples"),
          value: formatMetricNumber(
            formatters,
            dashboard.metricsPipeline.persisted24H,
          ),
          hint: i18n.t("admin.dashboard.metric.business-samples-hint"),
          tone: metricsTone,
        },
        {
          label: i18n.t("admin.dashboard.metric.product-rollups"),
          value: formatMetricNumber(
            formatters,
            dashboard.metricsPipeline.dailyRollups7D,
          ),
          hint: i18n.t("admin.dashboard.metric.product-rollups-hint"),
        },
        {
          label: i18n.t("admin.dashboard.metric.shared-links-window"),
          value: shouldShowTopSharedLinks
            ? `${dashboard.topSharedLinksWindow.effectiveSize}d`
            : "—",
          hint: i18n.t("admin.dashboard.metric.shared-links-window-hint"),
          tone: "warning",
        },
      ],
    },
    {
      title: i18n.t("admin.dashboard.cluster.security"),
      description: i18n.t("admin.dashboard.cluster.security-description"),
      to: `${ROUTES.admin.security}?tab=captcha`,
      items: [
        {
          label: i18n.t("admin.dashboard.metric.captcha-verified"),
          value: formatMetricNumber(
            formatters,
            dashboard.captcha.verifiedTotal,
          ),
          hint: i18n.t("admin.dashboard.metric.captcha-verified-hint"),
          tone: securityTone,
        },
        {
          label: i18n.t("admin.dashboard.metric.captcha-rejected"),
          value: formatMetricNumber(
            formatters,
            dashboard.captcha.rejectedTotal,
          ),
          hint: i18n.t("admin.dashboard.metric.captcha-rejected-hint"),
          tone: dashboard.captcha.rejectedTotal > 0 ? "warning" : "success",
        },
        {
          label: i18n.t("admin.dashboard.metric.honeypot"),
          value: formatMetricNumber(
            formatters,
            dashboard.captcha.honeypotTotal,
          ),
          hint: i18n.t("admin.dashboard.metric.honeypot-hint"),
          tone: dashboard.captcha.honeypotTotal > 0 ? "error" : "success",
        },
        {
          label: i18n.t("admin.dashboard.metric.hmac"),
          value: dashboard.captcha.hmacKeyConfigured
            ? i18n.t("admin.dashboard.yes")
            : i18n.t("admin.dashboard.no"),
          hint: i18n.t("admin.dashboard.metric.hmac-hint"),
          tone: dashboard.captcha.hmacKeyConfigured ? "success" : "error",
        },
      ],
    },
    {
      title: i18n.t("admin.dashboard.cluster.capacity"),
      description: i18n.t("admin.dashboard.cluster.capacity-description"),
      to: ROUTES.admin.storage,
      items: [
        {
          label: i18n.t("admin.dashboard.managed-storage"),
          value: formatBytes(totalStorageBytes),
          hint: `${i18n.t("admin.dashboard.workspace-storage")} ${formatBytes(dashboard.workspaceStorageBytes)} · ${i18n.t("admin.dashboard.blob-storage")} ${formatBytes(dashboard.blobStorageBytes)}`,
          tone: "success",
        },
        {
          label: i18n.t("admin.dashboard.metric.db-pool"),
          value: dashboard.dbPool
            ? `${dashboard.dbPool.active}/${dashboard.dbPool.max}`
            : "—",
          hint: i18n.t("admin.dashboard.metric.db-pool-hint"),
          tone: dbPoolRatio > 0.85 ? "error" : "info",
        },
        {
          label: i18n.t("admin.dashboard.metric.users"),
          value: formatMetricNumber(formatters, dashboard.dbPool?.userCount),
          hint: i18n.t("admin.dashboard.metric.users-hint"),
        },
        {
          label: i18n.t("admin.dashboard.metric.workspaces"),
          value: formatMetricNumber(
            formatters,
            dashboard.dbPool?.workspaceCount,
          ),
          hint: i18n.t("admin.dashboard.metric.workspaces-hint"),
        },
      ],
    },
    {
      title: i18n.t("admin.dashboard.cluster.telemetry"),
      description: i18n.t("admin.dashboard.cluster.telemetry-description"),
      to: `${ROUTES.admin.system}?tab=telemetry`,
      items: [
        {
          label: i18n.t("admin.dashboard.metric.telemetry-accepted"),
          value: formatMetricNumber(
            formatters,
            dashboard.telemetryPipeline.acceptedTotal,
          ),
          hint: i18n.t("admin.dashboard.metric.telemetry-accepted-hint"),
          tone: telemetryTone,
        },
        {
          label: i18n.t("admin.dashboard.metric.telemetry-rejected"),
          value: formatMetricNumber(
            formatters,
            dashboard.telemetryPipeline.rejectedTotal,
          ),
          hint: i18n.t("admin.dashboard.metric.telemetry-rejected-hint"),
          tone:
            dashboard.telemetryPipeline.rejectedTotal > 0
              ? "warning"
              : "success",
        },
        {
          label: i18n.t("admin.dashboard.metric.cache-hit-rate"),
          value: formatters.percent.format(cacheHitRate),
          hint: i18n.t("admin.dashboard.metric.cache-hit-rate-hint", {
            count: cacheLookups,
          }),
          tone: cacheHitRate > 0.8 ? "success" : "info",
        },
        {
          label: i18n.t("admin.dashboard.metric.telemetry-dedupe"),
          value: formatters.percent.format(
            dashboard.telemetryPipeline.dedupeHitRate,
          ),
          hint: i18n.t("admin.dashboard.metric.telemetry-dedupe-hint"),
        },
      ],
    },
  ];
  return (
    <AdminPageFrame
      title={i18n.t("admin.dashboard.title")}
      routeAnchor="admin-route-dashboard"
      actions={
        <SettingsToolbar>
          <SettingsStatusText>
            {i18n.t("admin.dashboard.updated-at", {
              time: formatDateTime(formatters, dashboard.generatedAt),
            })}
          </SettingsStatusText>
          <Button
            type="button"
            variant="plain"
            loading={isValidating}
            onClick={() => void refresh()}
            disabled={isValidating}
          >
            {i18n.t("admin.dashboard.refresh")}
          </Button>
        </SettingsToolbar>
      }
    >
      <AdminPageScroll>
        <Stack>
          <OperationalReadinessNotice />
          {dataNotice}

          <SimpleGrid cols={{ base: 1, lg: 4 }}>
            {[
              {
                label: i18n.t("admin.dashboard.metric.uptime"),
                value: formatDuration(dashboard.runtime.processUptimeSeconds),
                tone: runtimeTone,
              },
              {
                label: i18n.t("admin.dashboard.metric.error-rate"),
                value: formatters.percent.format(
                  dashboard.runtime.requestErrorRate,
                ),
                tone: runtimeTone,
              },
              {
                label: i18n.t("admin.dashboard.metric.queue-backlog"),
                value: formatMetricNumber(
                  formatters,
                  dashboard.queueSummary.pendingReadyTotal,
                ),
                tone: queueTone,
              },
              {
                label: i18n.t("admin.dashboard.metric.queue-failed"),
                value: formatMetricNumber(
                  formatters,
                  dashboard.queueSummary.failedTotal,
                ),
                tone: queueTone,
              },
            ].map((metric) => (
              <Stack key={metric.label}>
                <SettingsStatusText>{metric.label}</SettingsStatusText>
                <Group>
                  <MetricValue>{metric.value}</MetricValue>
                  <DashboardStatusDot
                    tone={metric.tone}
                    label={i18n.t(DASHBOARD_STATUS_LABEL_KEYS[metric.tone])}
                  />
                </Group>
              </Stack>
            ))}
          </SimpleGrid>

          <Stack component="section">
            <SettingsHeadingGroup>
              <SettingsSectionHeading>
                {i18n.t("admin.dashboard.window-controls")}
              </SettingsSectionHeading>
              <SettingsSectionDescription>
                {i18n.t("admin.dashboard.window-controls-description")}
              </SettingsSectionDescription>
            </SettingsHeadingGroup>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <FormSelect
                id="storage-history-window"
                label={i18n.t("admin.dashboard.storage-history")}
                value={String(storageHistoryDays)}
                allowDeselect={false}
                onChange={(next) => {
                  if (next !== null) setStorageHistoryDays(Number(next));
                }}
                data={STORAGE_DAY_OPTIONS.map((option) => ({
                  value: String(option),
                  label: `${option} ${i18n.t("admin.dashboard.days")}`,
                }))}
              />
              <FormSelect
                id="sync-history-window"
                label={i18n.t("admin.dashboard.sync-history")}
                value={String(syncHistoryHours)}
                allowDeselect={false}
                onChange={(next) => {
                  if (next !== null) setSyncHistoryHours(Number(next));
                }}
                data={SYNC_HOUR_OPTIONS.map((option) => ({
                  value: String(option),
                  label: `${option} ${i18n.t("admin.dashboard.hours")}`,
                }))}
              />
              <FormSelect
                id="shared-link-window"
                label={i18n.t("admin.dashboard.shared-link-window")}
                value={String(sharedLinkWindowDays)}
                allowDeselect={false}
                onChange={(next) => {
                  if (next !== null) setSharedLinkWindowDays(Number(next));
                }}
                data={SHARED_DAY_OPTIONS.map((option) => ({
                  value: String(option),
                  label: `${option} ${i18n.t("admin.dashboard.days")}`,
                }))}
              />
            </SimpleGrid>
          </Stack>

          <SimpleGrid cols={{ base: 1, lg: 2 }}>
            <Stack component="section">
              <Group justify="space-between" align="flex-start">
                <SettingsHeadingGroup>
                  <SettingsSectionHeading>
                    {i18n.t("admin.dashboard.sync-active-users-trend")}
                  </SettingsSectionHeading>
                  <SettingsSectionDescription>
                    {i18n.t("admin.dashboard.minute-bucket", {
                      size: syncWindowHours,
                    })}
                  </SettingsSectionDescription>
                </SettingsHeadingGroup>
                <MetricValue>
                  {formatMetricNumber(formatters, dashboard.syncActiveUsers)}
                </MetricValue>
              </Group>
              <TrendChart
                ariaLabel={i18n.t("admin.dashboard.sync-active-users-trend")}
                points={syncPoints}
                start={formatDateTime(formatters, dashboard.syncWindow.from)}
                end={formatDateTime(formatters, dashboard.syncWindow.to)}
                primaryLabel={i18n.t("admin.dashboard.sync-active-users")}
                primaryFormatter={(value) => formatters.int.format(value)}
              />
            </Stack>
            <Stack component="section">
              <Group justify="space-between" align="flex-start">
                <SettingsHeadingGroup>
                  <SettingsSectionHeading>
                    {i18n.t("admin.dashboard.storage-trend")}
                  </SettingsSectionHeading>
                  <SettingsSectionDescription>
                    {i18n.t("admin.dashboard.day-bucket", {
                      size: dashboard.storageWindow.effectiveSize,
                    })}
                  </SettingsSectionDescription>
                </SettingsHeadingGroup>
                <MetricValue>{formatBytes(totalStorageBytes)}</MetricValue>
              </Group>
              <TrendChart
                ariaLabel={i18n.t("admin.dashboard.storage-trend")}
                points={storagePoints}
                start={formatDate(formatters, dashboard.storageWindow.from)}
                end={formatDate(formatters, dashboard.storageWindow.to)}
                primaryLabel={i18n.t("admin.dashboard.workspace-storage")}
                primaryFormatter={(value) => formatBytes(value)}
                secondaryLabel={i18n.t("admin.dashboard.blob-storage")}
                secondaryFormatter={(value) => formatBytes(value)}
              />
            </Stack>
            <Stack component="section">
              <Group justify="space-between" align="flex-start">
                <SettingsHeadingGroup>
                  <SettingsSectionHeading>
                    {i18n.t("admin.dashboard.metric.rps")}
                  </SettingsSectionHeading>
                  <SettingsSectionDescription>
                    {i18n.t("admin.dashboard.metric.latency-hint", {
                      max: formatMs(
                        formatters,
                        dashboard.runtime.requestLatencyMaxMs,
                      ),
                    })}
                  </SettingsSectionDescription>
                </SettingsHeadingGroup>
                <MetricValue>
                  {formatters.decimal.format(
                    dashboard.runtime.requestThroughputRps,
                  )}
                </MetricValue>
              </Group>
              <SignalBarChart
                ariaLabel={`${i18n.t("admin.dashboard.metric.rps")} / ${i18n.t("admin.dashboard.metric.latency")}`}
                items={[
                  {
                    label: i18n.t("admin.dashboard.metric.rps"),
                    value: dashboard.runtime.requestThroughputRps,
                    max: runtimeThroughputScale,
                    tone: runtimeTone,
                    valueLabel: formatters.decimal.format(
                      dashboard.runtime.requestThroughputRps,
                    ),
                  },
                  {
                    label: i18n.t("admin.dashboard.metric.latency"),
                    value: dashboard.runtime.requestLatencyAvgMs,
                    max: runtimeLatencyScale,
                    tone: runtimeTone,
                    valueLabel: formatMs(
                      formatters,
                      dashboard.runtime.requestLatencyAvgMs,
                    ),
                  },
                  {
                    label: i18n.t("admin.dashboard.metric.runtime-max"),
                    value: dashboard.runtime.requestLatencyMaxMs,
                    max: runtimeLatencyScale,
                    tone:
                      dashboard.runtime.requestLatencyMaxMs >= 5000
                        ? "error"
                        : "info",
                    valueLabel: formatMs(
                      formatters,
                      dashboard.runtime.requestLatencyMaxMs,
                    ),
                  },
                ]}
              />
            </Stack>
            <Stack component="section">
              <Group justify="space-between" align="flex-start">
                <SettingsHeadingGroup>
                  <SettingsSectionHeading>
                    {i18n.t("admin.dashboard.metric.db-pool")}
                  </SettingsSectionHeading>
                  <SettingsSectionDescription>
                    {i18n.t("admin.dashboard.metric.db-pool-hint")}
                  </SettingsSectionDescription>
                </SettingsHeadingGroup>
                <MetricValue>
                  {dashboard.dbPool
                    ? `${dashboard.dbPool.active}/${dashboard.dbPool.max}`
                    : "—"}
                </MetricValue>
              </Group>
              {dashboard.dbPool ? (
                <SignalBarChart
                  ariaLabel={i18n.t("admin.dashboard.metric.db-pool")}
                  items={[
                    {
                      label: i18n.t("admin.dashboard.metric.db-active"),
                      value: dashboard.dbPool.active,
                      max: dbPoolMax,
                      tone: capacityTone,
                      valueLabel: formatMetricNumber(
                        formatters,
                        dashboard.dbPool?.active,
                      ),
                    },
                    {
                      label: i18n.t("admin.dashboard.metric.db-idle"),
                      value: dashboard.dbPool.idle,
                      max: dbPoolMax,
                      tone: "info",
                      valueLabel: formatMetricNumber(
                        formatters,
                        dashboard.dbPool?.idle,
                      ),
                    },
                    {
                      label: i18n.t("admin.dashboard.metric.db-max"),
                      value: dashboard.dbPool.max,
                      max: dbPoolMax,
                      tone: "neutral",
                      valueLabel: formatMetricNumber(
                        formatters,
                        dashboard.dbPool?.max,
                      ),
                    },
                  ]}
                />
              ) : (
                <SettingsEmptyState title={i18n.t("admin.dashboard.no-data")} />
              )}
            </Stack>
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, lg: 2 }}>
            {clusters.map((cluster) => (
              <Stack key={cluster.title} component="section">
                <SettingsHeadingGroup>
                  <SettingsSectionHeading>
                    {cluster.title}
                  </SettingsSectionHeading>
                  <SettingsSectionDescription>
                    {cluster.description}
                  </SettingsSectionDescription>
                </SettingsHeadingGroup>
                <Table>
                  <TableBody>
                    {cluster.items.map((item) => (
                      <TableRow key={item.label}>
                        <TableCell>
                          <Stack>
                            <Text>{item.label}</Text>
                            {item.hint ? (
                              <SettingsStatusText>
                                {item.hint}
                              </SettingsStatusText>
                            ) : null}
                          </Stack>
                        </TableCell>
                        <TableCell ta="right">
                          <Group justify="flex-end">
                            <MetricValue>{item.value}</MetricValue>
                            {item.tone ? (
                              <DashboardStatusDot
                                tone={item.tone}
                                label={i18n.t(
                                  DASHBOARD_STATUS_LABEL_KEYS[item.tone],
                                )}
                              />
                            ) : null}
                          </Group>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <NavigationLink
                  component={Link}
                  to={cluster.to}
                  label={i18n.t("admin.common.details")}
                  aria-label={`${i18n.t("admin.common.details")}: ${cluster.title}`}
                />
              </Stack>
            ))}
          </SimpleGrid>

          {shouldShowTopSharedLinks ? (
            <Suspense fallback={<DashboardSkeletonCard />}>
              <TopSharedLinksSection
                sharedLinkWindowDays={sharedLinkWindowDays}
              />
            </Suspense>
          ) : null}
        </Stack>
      </AdminPageScroll>
    </AdminPageFrame>
  );
}

export function DashboardPage() {
  return (
    <Suspense fallback={<DashboardPageSkeleton />}>
      <DashboardPageContent />
    </Suspense>
  );
}

export { DashboardPage as Component };
