// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps } from "./helpers/ui-role";
import { Card as MantineCard, Box, Group } from "@mantine/core";
import {
  type ReactNode,
  createContext,
  useContext,
  type ComponentProps,
  forwardRef,
  useId,
  useMemo,
  type PropsWithChildren,
  type HTMLAttributes,
  type CSSProperties,
} from "react";
import {
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  type TooltipContentProps as RechartsTooltipContentProps,
} from "recharts";
import { cssVar } from "@myoxus/theme";
import { Skeleton } from "./feedback";

export function ChartSurface({ children, className, style }: RoleBoxProps) {
  return (
    <MantineCard
      className={className}
      style={style}
      data-myoxus-ui-role="chart-surface"
    >
      {children}
    </MantineCard>
  );
}

const CHART_THEMES = { light: "", dark: ".dark" } as const;

export type ChartConfig = Record<
  string,
  {
    label?: ReactNode;
    color?: string;
    theme?: Partial<Record<keyof typeof CHART_THEMES, string>>;
  }
>;

type ChartContextValue = {
  config: ChartConfig;
};

const ChartContext = createContext<ChartContextValue | null>(null);

function useChartContext() {
  const value = useContext(ChartContext);
  if (!value) {
    throw new Error("useChartContext must be used within <ChartContainer />");
  }
  return value;
}

function ChartStyle({
  chartId,
  config,
}: {
  chartId: string;
  config: ChartConfig;
}) {
  const colorEntries = Object.entries(config).filter(
    ([, item]) => item.color || item.theme,
  );

  if (colorEntries.length === 0) return null;

  // Recharts expects series colors as CSS variables on the chart root. Scope
  // them by data-chart id so multiple charts cannot leak colors globally.
  const css = Object.entries(CHART_THEMES)
    .map(([themeKey, prefix]) => {
      const declarations = colorEntries
        .map(([key, item]) => {
          const color =
            item.theme?.[themeKey as keyof typeof CHART_THEMES] ?? item.color;
          return color ? `  --color-${key}: ${color};` : "";
        })
        .filter(Boolean)
        .join("\n");

      return declarations
        ? `${prefix} [data-chart="${chartId}"] {\n${declarations}\n}`
        : "";
    })
    .filter(Boolean)
    .join("\n");

  return css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null;
}

type ChartContainerProps = ComponentProps<"div"> & {
  config: ChartConfig;
  children: ComponentProps<typeof ResponsiveContainer>["children"];
};

export const ChartContainer = forwardRef<HTMLDivElement, ChartContainerProps>(
  ({ id, className, children, config, style, ...props }, ref) => {
    const uniqueId = useId();
    const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`;
    const chartContextValue = useMemo(() => ({ config }), [config]);

    return (
      <ChartContext.Provider value={chartContextValue}>
        <div
          ref={ref}
          data-chart={chartId}
          className={["myoxus-chart-container", className]
            .filter(Boolean)
            .join(" ")}
          data-myoxus-ui-role="chart"
          style={{
            display: "flex",
            width: "100%",
            height: "100%",
            minHeight: 0,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            borderRadius: "var(--mantine-radius-lg)",
            ...style,
          }}
          {...props}
        >
          <ChartStyle chartId={chartId} config={config} />
          <ResponsiveContainer>{children}</ResponsiveContainer>
        </div>
      </ChartContext.Provider>
    );
  },
);

ChartContainer.displayName = "ChartContainer";

export function DashboardChartFrame({
  children,
  className,
  style,
  "data-myoxus-ui-role": uiRole = "dashboard-chart-frame",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <Box
      {...props}
      className={className}
      style={{
        width: "100%",
        height:
          "calc(\n    calc(var(--mantine-spacing-2xl) * 2) + calc(var(--mantine-spacing-2xl) * 2) +\n      calc(var(--mantine-spacing-2xl) * 2) - var(--mantine-spacing-lg)\n  )",
        minHeight:
          "calc(\n    calc(var(--mantine-spacing-2xl) * 2) + calc(var(--mantine-spacing-2xl) * 2) +\n      calc(var(--mantine-spacing-2xl) * 2) - var(--mantine-spacing-lg)\n  )",
        overflow: "hidden",
        borderRadius: "var(--mantine-radius-lg)",
        ...style,
      }}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
}

export function DashboardChartAxis({
  start,
  end,
  className,
  style,
  "data-myoxus-ui-role": uiRole = "dashboard-chart-axis",
}: {
  start: ReactNode;
  end: ReactNode;
  className?: string;
  style?: CSSProperties;
  "data-myoxus-ui-role"?: string;
}) {
  return (
    <Group
      className={className}
      justify="space-between"
      wrap="nowrap"
      style={{
        color: cssVar("placeholderColor"),
        fontVariantNumeric: "tabular-nums",
        ...style,
      }}
      data-myoxus-ui-role={uiRole}
    >
      <span>{start}</span>
      <span>{end}</span>
    </Group>
  );
}

function dashboardToneColor(
  tone: "neutral" | "success" | "warning" | "error" | "info",
) {
  if (tone === "success") return cssVar("successColor");
  if (tone === "warning") return cssVar("warningColor");
  if (tone === "error") return cssVar("errorColor");
  if (tone === "info") return cssVar("processingColor");
  return cssVar("textSecondaryColor");
}

export function DashboardSignalBar({
  value,
  max,
  tone = "neutral",
  "aria-label": ariaLabel,
}: {
  value: number;
  max: number;
  tone?: "neutral" | "success" | "warning" | "error" | "info";
  "aria-label"?: string;
}) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const safeMax = Number.isFinite(max) ? Math.max(0, max) : 0;
  const pct =
    safeMax > 0 ? Math.min(100, Math.max(0, (safeValue / safeMax) * 100)) : 0;
  const fillWidth =
    pct <= 0
      ? "0%"
      : pct >= 100
        ? "100%"
        : `max(${pct}%, var(--mantine-spacing-xs))`;

  return (
    <Box
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={safeMax > 0 ? Math.min(safeMax, safeValue) : 0}
      style={{
        width: "100%",
        height: "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
        overflow: "hidden",
        borderRadius: "var(--mantine-radius-xl)",
        background: cssVar("backgroundSecondaryColor"),
      }}
      data-myoxus-ui-role="dashboard-signal-track"
    >
      <Box
        aria-hidden="true"
        style={{
          width: fillWidth,
          height: "100%",
          borderRadius: "var(--mantine-radius-xl)",
          background: dashboardToneColor(tone),
          transition: `width 120ms`,
        }}
        data-myoxus-ui-role={`dashboard-signal-fill:${tone}`}
      />
    </Box>
  );
}

export function DashboardSignalLabels({
  label,
  value,
}: {
  label: ReactNode;
  value: ReactNode;
}) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      style={{
        color: cssVar("placeholderColor"),
      }}
      data-myoxus-ui-role="dashboard-signal-labels"
    >
      <span>{label}</span>
      <span>{value}</span>
    </Group>
  );
}

export function DashboardSkeletonHero() {
  return (
    <Skeleton
      variant="rounded"
      width="100%"
      height={
        "calc(\n    calc(var(--mantine-spacing-2xl) * 2) + calc(var(--mantine-spacing-2xl) * 2) -\n      var(--mantine-spacing-lg)\n  )"
      }
      data-myoxus-ui-role="dashboard-skeleton-hero"
    />
  );
}

export function DashboardSkeletonCard() {
  return (
    <Skeleton
      variant="rounded"
      width="100%"
      height={
        "calc(\n    calc(var(--mantine-spacing-2xl) * 2) + calc(var(--mantine-spacing-2xl) * 2) +\n      calc(var(--mantine-spacing-2xl) * 2) + calc(var(--mantine-spacing-2xl) * 2) +\n      calc(var(--mantine-spacing-2xl) * 2)\n  )"
      }
      data-myoxus-ui-role="dashboard-skeleton-card"
    />
  );
}

export const ChartTooltip = RechartsTooltip;

type ChartTooltipContentProps = {
  active?: boolean;
  payload?: RechartsTooltipContentProps<number, string>["payload"];
  label?: string | number;
  labelFormatter?: (
    label: string | number,
    payload: RechartsTooltipContentProps<number, string>["payload"],
  ) => ReactNode;
  valueFormatter?: (value: number, key: string) => ReactNode;
};

export const ChartTooltipContent = forwardRef<
  HTMLDivElement,
  ChartTooltipContentProps
>(({ active, payload, label, labelFormatter, valueFormatter }, ref) => {
  const { config } = useChartContext();

  if (!active || !payload?.length) return null;

  const title = labelFormatter ? labelFormatter(label ?? "", payload) : label;

  return (
    <div
      ref={ref}
      data-myoxus-ui-role="chart-tooltip"
      style={{
        minWidth: 0,
        border: `1px solid ${cssVar("borderColor")}`,
        borderRadius: "var(--mantine-radius-md)",
        background: cssVar("backgroundPrimaryColor"),
        boxShadow: "var(--mantine-shadow-sm)",
        color: cssVar("textPrimaryColor"),
        padding: "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
      }}
    >
      {title ? (
        <div
          data-myoxus-ui-role="chart-tooltip-title"
          style={{
            color: cssVar("textSecondaryColor"),
            marginBlockEnd: "var(--mantine-spacing-xs)",
          }}
        >
          {title}
        </div>
      ) : null}
      <div
        data-myoxus-ui-role="chart-tooltip-items"
        style={{
          display: "grid",
          gap: "var(--mantine-spacing-2xs)",
        }}
      >
        {payload.map((item, index) => {
          const dataKey = String(item.dataKey ?? item.name ?? index);
          const itemConfig = config[dataKey];
          const labelText = itemConfig?.label ?? item.name ?? dataKey;
          const numericValue =
            typeof item.value === "number"
              ? item.value
              : Number(item.value ?? 0);
          const valueText = valueFormatter
            ? valueFormatter(numericValue, dataKey)
            : numericValue;
          const color = item.color ?? `var(--color-${dataKey})`;

          return (
            <div
              key={`${dataKey}-${index}`}
              data-myoxus-ui-role="chart-tooltip-row"
              style={{
                display: "grid",
                gridTemplateColumns: "auto minmax(0, 1fr) auto",
                gap: "var(--mantine-spacing-xs)",
                alignItems: "center",
                color: cssVar("textPrimaryColor"),
              }}
            >
              <span
                data-myoxus-ui-role="chart-tooltip-dot"
                style={{
                  width: "var(--mantine-spacing-xs)",
                  height: "var(--mantine-spacing-xs)",
                  borderRadius: "var(--mantine-radius-xl)",
                  backgroundColor: color,
                }}
                aria-hidden="true"
              />
              <span
                data-myoxus-ui-role="chart-tooltip-label"
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  color: cssVar("textSecondaryColor"),
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {labelText}
              </span>
              <span
                data-myoxus-ui-role="chart-tooltip-value"
                style={{
                  color: cssVar("textPrimaryColor"),
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {valueText}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

ChartTooltipContent.displayName = "ChartTooltipContent";
