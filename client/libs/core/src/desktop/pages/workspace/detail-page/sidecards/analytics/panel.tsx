/**
 * EditorAnalyticsPanel — document analytics sidebar tab.
 *
 * Displays two sections:
 *
 * ### 1. Page-view chart
 * A Recharts `LineChart` with two series — total views and unique views — over
 * a configurable time window (7, 14, 30, 60, or 90 days). All configured
 * windows are available without plan gating.
 *
 * Data comes from `getDocPageAnalyticsQuery`.  The query is re-issued when
 * `workspaceId`, `docId`, `windowDays`, or the browser timezone
 * changes.  `keepPreviousData: true` prevents flash-of-empty-content during
 * window switches.
 *
 * The Y-axis domain is padded to 110 % of the max value (`Math.ceil(max * 1.1)`)
 * so line peaks never clip at the top of the chart.
 *
 * ### 2. Recent viewers list
 * A paginated list of workspace members who recently accessed the document,
 * fetched via `getDocLastAccessedMembersQuery`.  The first page shows
 * `INITIAL_MEMBERS_PAGE_SIZE` items; "Show all" loads up to
 * `MAX_MEMBERS_PAGE_SIZE`.  Page size is reset whenever `docId` changes so
 * switching documents does not carry over a stale expanded state.
 *
 * @param workspaceId - The workspace that owns the document.
 * @param docId       - The document whose analytics are displayed.
 */
import { useQuery } from "@myoxus/core/components/hooks/use-query";
import { WorkspacePermissionService } from "@myoxus/core/modules/permissions";
import {
  getDocLastAccessedMembersQuery,
  getDocPageAnalyticsQuery,
} from "@myoxus/graphql";
import { i18nTime, useI18n } from "@myoxus/i18n";
import { ArrowDownSmallIcon, CalendarPanelIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { cssVar } from "@myoxus/theme";
import {
  Avatar,
  Button,
  Center,
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ColorDot,
  DashboardChartAxis,
  DashboardChartFrame,
  Divider,
  EmptyState,
  Group,
  Loading,
  Menu,
  MenuItem,
  MetricCard,
  MyoxusText,
  SimpleGrid,
  Stack,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListMeta,
  SurfaceListText,
} from "@myoxus/ui-facade";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Area, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  type AnalyticsChartPoint,
  buildAnalyticsChartPoints,
  DEFAULT_ANALYTICS_WINDOW_DAYS,
  ensureMinimumChartPoints,
  getAvailableAnalyticsWindowOptions,
  INITIAL_MEMBERS_PAGE_SIZE,
  MAX_MEMBERS_PAGE_SIZE,
} from "./utils";

/** Chart line/fill colour for the total-views series. */
const totalViewsColor = cssVar("primaryColor");
/** Chart line/fill colour for the unique-views series. */
const uniqueViewsColor = cssVar("processingColor");

/** Formats an ISO date string as a localised day label for chart axes/tooltips. */
function formatChartDate(value: string) {
  return i18nTime(value, { absolute: { accuracy: "day" } });
}

function AnalyticsLegendRow({
  color,
  label,
}: {
  color: string;
  label: ReactNode;
}) {
  return (
    <Group data-myoxus-ui-role="analytics-legend-row" wrap="nowrap">
      <ColorDot color={color} />
      <MyoxusText
        component="span"
        tone="secondary"
        typographySlot="dense-label"
      >
        {label}
      </MyoxusText>
    </Group>
  );
}

function AnalyticsLoadingState() {
  return (
    <Center data-myoxus-ui-role="analytics-loading-state" py="xl">
      <Loading />
    </Center>
  );
}

function analyticsTooltipLabel(
  payload: Parameters<
    NonNullable<ComponentProps<typeof ChartTooltipContent>["labelFormatter"]>
  >[1],
) {
  const point = payload?.[0]?.payload as AnalyticsChartPoint | undefined;
  return point?.date ? formatChartDate(point.date) : "";
}

export const EditorAnalyticsPanel = ({
  workspaceId,
  docId,
}: {
  workspaceId: string;
  docId: string;
}) => {
  const t = useI18n();
  const intFormatter = useMemo(
    () => new Intl.NumberFormat(t.language),
    [t.language],
  );
  const permission = useService(WorkspacePermissionService).permission;
  const [windowDays, setWindowDays] = useState(DEFAULT_ANALYTICS_WINDOW_DAYS);
  const [membersPageSize, setMembersPageSize] = useState(
    INITIAL_MEMBERS_PAGE_SIZE,
  );
  const allowedWindowOptions = useMemo(
    () => getAvailableAnalyticsWindowOptions(),
    [],
  );
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  useEffect(() => {
    setMembersPageSize(INITIAL_MEMBERS_PAGE_SIZE);
  }, [docId]);

  useEffect(() => {
    permission.revalidate();
  }, [permission, workspaceId]);

  const {
    data: analyticsData,
    isLoading: analyticsLoading,
    error: analyticsError,
  } = useQuery(
    {
      query: getDocPageAnalyticsQuery,
      variables: {
        workspaceId,
        docId,
        input: {
          windowDays: windowDays,
          timezone,
        },
      },
    },
    {
      suspense: false,
      keepPreviousData: true,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  const {
    data: membersData,
    isLoading: membersLoading,
    error: membersError,
  } = useQuery(
    {
      query: getDocLastAccessedMembersQuery,
      variables: {
        workspaceId,
        docId,
        pagination: {
          first: membersPageSize,
          offset: 0,
        },
        includeTotal: true,
      },
    },
    {
      suspense: false,
      keepPreviousData: true,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  const analytics = analyticsData?.workspace?.doc?.analytics;
  const summary = analytics?.summary;
  const chartPoints = useMemo(
    () =>
      ensureMinimumChartPoints(
        buildAnalyticsChartPoints(analytics?.series ?? []),
      ),
    [analytics?.series],
  );
  const chartConfig: ChartConfig = {
    totalViews: {
      label: t["com.myoxus.doc.analytics.chart.total-views"](),
      color: totalViewsColor,
    },
    uniqueViews: {
      label: t["com.myoxus.doc.analytics.chart.unique-views"](),
      color: uniqueViewsColor,
    },
  };

  const membersConnection = membersData?.workspace?.doc?.lastAccessedMembers;
  const memberEdges = useMemo(
    () => membersConnection?.edges ?? [],
    [membersConnection?.edges],
  );
  const totalMembers = membersConnection?.totalCount ?? memberEdges.length;
  const hasMoreMembers =
    Boolean(membersConnection?.pageInfo.hasNextPage) &&
    membersPageSize < MAX_MEMBERS_PAGE_SIZE;
  return (
    <Stack data-myoxus-ui-role="analytics-panel" pt="sm">
      <Stack component="section" data-myoxus-ui-role="analytics-section">
        <Group
          component="header"
          data-myoxus-ui-role="analytics-section-header"
          justify="space-between"
          wrap="nowrap"
        >
          <Stack data-myoxus-ui-role="analytics-section-title" gap={0}>
            <MyoxusText
              component="span"
              tone="primary"
              typographySlot="label-compact"
              truncate
            >
              {t["com.myoxus.doc.analytics.title"]()}
            </MyoxusText>
            <MyoxusText
              component="span"
              tone="secondary"
              typographySlot="label-compact"
            >
              {summary
                ? t.t("com.myoxus.doc.analytics.summary.total", {
                    count: intFormatter.format(summary.totalViews),
                  })
                : ""}
            </MyoxusText>
          </Stack>
          <Menu
            contentOptions={{ align: "end" }}
            items={
              <>
                {allowedWindowOptions.map((option) => (
                  <MenuItem
                    key={option}
                    selected={windowDays === option}
                    onSelect={() => {
                      setWindowDays(option);
                    }}
                  >
                    {t.t("com.myoxus.doc.analytics.window.last-days", {
                      days: option,
                    })}
                  </MenuItem>
                ))}
              </>
            }
          >
            <Button
              variant="secondary"
              size="default"
              prefix={<CalendarPanelIcon />}
              suffix={<ArrowDownSmallIcon />}
            >
              {t.t("com.myoxus.doc.analytics.window.last-days", {
                days: windowDays,
              })}
            </Button>
          </Menu>
        </Group>

        <SimpleGrid cols={3} data-myoxus-ui-role="analytics-metric-grid">
          <MetricCard
            label={t["com.myoxus.doc.analytics.metric.total"]()}
            value={intFormatter.format(summary?.totalViews ?? 0)}
          />
          <MetricCard
            label={t["com.myoxus.doc.analytics.metric.unique"]()}
            value={intFormatter.format(summary?.uniqueViews ?? 0)}
          />
          <MetricCard
            label={t["com.myoxus.doc.analytics.metric.guest"]()}
            value={intFormatter.format(summary?.guestViews ?? 0)}
          />
        </SimpleGrid>

        {analyticsLoading && !analytics ? (
          <AnalyticsLoadingState />
        ) : analyticsError && !analytics ? (
          <EmptyState
            title={t["com.myoxus.doc.analytics.error.load-analytics"]()}
          />
        ) : chartPoints.length ? (
          <>
            <DashboardChartFrame
              aria-label={t["com.myoxus.doc.analytics.title"]()}
              data-myoxus-ui-role="analytics-chart-frame"
              role="img"
            >
              <ChartContainer config={chartConfig}>
                {/* Recharts owns SVG/data geometry here; surrounding chart chrome stays facade-owned. */}
                <LineChart
                  data={chartPoints}
                  margin={{ top: 10, right: 6, bottom: 6, left: 6 }}
                >
                  <CartesianGrid
                    vertical={false}
                    stroke={cssVar("borderColor")}
                    strokeDasharray="3 3"
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
                      (max: number) => {
                        if (max <= 0) {
                          return 1;
                        }
                        return Math.ceil(max * 1.1);
                      },
                    ]}
                  />
                  <ChartTooltip
                    cursor={{
                      stroke: cssVar("borderColor"),
                      strokeDasharray: "4 4",
                    }}
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) =>
                          analyticsTooltipLabel(payload)
                        }
                        valueFormatter={(value) => intFormatter.format(value)}
                      />
                    }
                  />
                  <Area
                    dataKey="totalViews"
                    type="monotone"
                    stroke="var(--color-totalViews)"
                    fill="var(--color-totalViews)"
                    fillOpacity={0.15}
                    isAnimationActive={false}
                  />
                  <Area
                    dataKey="uniqueViews"
                    type="monotone"
                    stroke="var(--color-uniqueViews)"
                    fill="var(--color-uniqueViews)"
                    fillOpacity={0.1}
                    isAnimationActive={false}
                  />
                  <Line
                    dataKey="totalViews"
                    type="monotone"
                    stroke="var(--color-totalViews)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                  />
                  <Line
                    dataKey="uniqueViews"
                    type="monotone"
                    stroke="var(--color-uniqueViews)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ChartContainer>
            </DashboardChartFrame>
            <DashboardChartAxis
              data-myoxus-ui-role="analytics-axis-labels"
              start={formatChartDate(chartPoints[0].date)}
              end={formatChartDate(chartPoints[chartPoints.length - 1].date)}
            />
            <Group data-myoxus-ui-role="analytics-chart-legend">
              <AnalyticsLegendRow
                color={totalViewsColor}
                label={t["com.myoxus.doc.analytics.chart.total-views"]()}
              />
              <AnalyticsLegendRow
                color={uniqueViewsColor}
                label={t["com.myoxus.doc.analytics.chart.unique-views"]()}
              />
            </Group>
          </>
        ) : (
          <EmptyState
            title={t["com.myoxus.doc.analytics.empty.no-page-views"]()}
          />
        )}
      </Stack>

      <Divider />

      <Stack component="section" data-myoxus-ui-role="analytics-section">
        <Group
          component="header"
          data-myoxus-ui-role="analytics-section-header"
          justify="space-between"
          wrap="nowrap"
        >
          <Stack data-myoxus-ui-role="analytics-section-title" gap={0}>
            <MyoxusText
              component="span"
              tone="primary"
              typographySlot="label-compact"
              truncate
            >
              {t["com.myoxus.doc.analytics.viewers.title"]()}
            </MyoxusText>
            <MyoxusText
              component="span"
              tone="secondary"
              typographySlot="label-compact"
            >
              ({intFormatter.format(totalMembers)})
            </MyoxusText>
          </Stack>
        </Group>

        {membersLoading && !membersConnection ? (
          <AnalyticsLoadingState />
        ) : membersError && !membersConnection ? (
          <EmptyState
            title={t["com.myoxus.doc.analytics.error.load-viewers"]()}
          />
        ) : memberEdges.length ? (
          <>
            <SurfaceList>
              {memberEdges.map(({ cursor, node: member }) => (
                <SurfaceListItem key={cursor} density="compact" layout="row">
                  <Avatar
                    size="xs"
                    url={member.user.avatarUrl || ""}
                    name={member.user.name}
                  />
                  <SurfaceListItemMain
                    compact
                    data-myoxus-ui-role="analytics-viewer-user"
                    grow
                  >
                    <SurfaceListText kind="title" component="span">
                      {member.user.name}
                    </SurfaceListText>
                  </SurfaceListItemMain>
                  <SurfaceListMeta>
                    <MyoxusText
                      component="span"
                      tone="secondary"
                      typographySlot="label-compact"
                    >
                      {i18nTime(member.lastAccessedAt, { relative: true })}
                    </MyoxusText>
                  </SurfaceListMeta>
                </SurfaceListItem>
              ))}
            </SurfaceList>
            {hasMoreMembers ? (
              <Button
                variant="plain"
                onClick={() => setMembersPageSize(MAX_MEMBERS_PAGE_SIZE)}
              >
                {t["com.myoxus.doc.analytics.viewers.show-all"]()}
              </Button>
            ) : null}
          </>
        ) : (
          <EmptyState
            title={t["com.myoxus.doc.analytics.empty.no-viewers"]()}
          />
        )}
      </Stack>
    </Stack>
  );
};
