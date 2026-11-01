// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type ReactNode,
  type CSSProperties,
  forwardRef,
  type PropsWithChildren,
  type HTMLAttributes,
} from "react";
import { type RoleBoxProps } from "./helpers/ui-role";
import { cssVar, cssTypographyVar } from "@myoxus/theme";
import {
  Text,
  Box,
  Card as MantineCard,
  Stack,
  Group,
  SimpleGrid,
} from "@mantine/core";

export type MetricStackRow = {
  label: ReactNode;
  value: ReactNode;
  toneColor?: CSSProperties["color"];
  className?: string;
  valueClassName?: string;
  "data-admin-tone"?: string;
};

export function MetricStack({
  rows,
  className,
  style,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole,
}: RoleBoxProps & { rows: MetricStackRow[] }) {
  return (
    <dl
      className={className}
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole ?? "metric-stack"}
      style={{
        display: "grid",
        gridTemplateColumns: "var(--myoxus-ui-metric-stack-columns, auto auto)",
        columnGap: "var(--mantine-spacing-md)",
        rowGap: "var(--mantine-spacing-2xs)",
        paddingInlineStart: `var(--myoxus-ui-metric-stack-padding-inline-start, var(--mantine-spacing-md))`,
        borderInlineStart: `var(--myoxus-ui-metric-stack-border-inline-start, 1px solid ${cssVar(
          "borderColor",
        )})`,
        textAlign:
          "var(--myoxus-ui-metric-stack-text-align, end)" as CSSProperties["textAlign"],
        ...style,
      }}
    >
      {rows.map((row, index) => (
        <div
          className={row.className}
          // Labels can repeat across cards; index is stable for this static stack.
          key={index}
          style={{ display: "contents" }}
        >
          <Text c="myoxus-text-secondary" component="dt">
            {row.label}
          </Text>
          <Text
            c={row.toneColor ?? "myoxus-text-primary"}
            component="dd"
            className={row.valueClassName}
            data-admin-tone={row["data-admin-tone"]}
            style={{
              fontVariantNumeric: "tabular-nums",
              margin: 0,
            }}
          >
            {row.value}
          </Text>
        </div>
      ))}
    </dl>
  );
}

export function MetricValue({
  children,
  density = "default",
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps & { density?: "default" | "compact" }) {
  return (
    <Text
      c="myoxus-text-primary"
      component="span"
      className={className}
      data-testid={dataTestId}
      data-myoxus-ui-role={
        density === "compact" ? "metric-value:compact" : "metric-value"
      }
      size={density === "compact" ? "body" : "body-large"}
      style={{
        fontVariantNumeric: "tabular-nums",
        ...style,
      }}
    >
      {children}
    </Text>
  );
}

export function MonoText({
  children,
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps) {
  return (
    <Text
      c="myoxus-text-primary"
      component="span"
      className={className}
      data-testid={dataTestId}
      data-myoxus-ui-role="mono-text"
      style={{
        fontFamily: cssTypographyVar(
          "monospace",
          "family",
          cssTypographyVar("body-small", "family", cssVar("fontFamily")),
        ),
        overflowWrap: "anywhere",
        ...style,
      }}
    >
      {children}
    </Text>
  );
}

export const TerminalPanel = forwardRef<
  HTMLDivElement,
  PropsWithChildren<
    HTMLAttributes<HTMLDivElement> & {
      flex?: CSSProperties["flex"];
      maxHeight?: CSSProperties["maxHeight"];
      minHeight?: CSSProperties["minHeight"];
      minWidth?: CSSProperties["minWidth"];
      "data-myoxus-ui-role"?: string;
    }
  >
>(function TerminalPanel(
  {
    children,
    flex,
    maxHeight,
    minHeight,
    minWidth,
    style,
    "data-myoxus-ui-role": uiRole,
    ...props
  },
  ref,
) {
  // Operational log output needs technical monospace and scroll behavior, but
  // surface, border and typography still come from shared theme tokens.
  return (
    <Box
      {...props}
      ref={ref}
      style={{
        background: cssVar("backgroundSecondaryColor"),
        border: `calc(var(--mantine-scale) * 1px) solid ${cssVar("borderColor")}`,
        borderRadius: "var(--mantine-radius-lg)",
        color: cssVar("textPrimaryColor"),
        flex,
        fontFamily: cssTypographyVar(
          "monospace",
          "family",
          cssTypographyVar("body-small", "family", cssVar("fontFamily")),
        ),
        maxHeight: maxHeight ?? "24rem",
        minHeight: minHeight ?? "16rem",
        minWidth,
        overflow: "auto",
        padding: "var(--mantine-spacing-sm)",
        whiteSpace: "pre-wrap",
        ...style,
      }}
      data-myoxus-ui-role={uiRole ?? "terminal-panel"}
    >
      {children}
    </Box>
  );
});

export function TerminalMutedText({ children }: PropsWithChildren) {
  return (
    <Text
      c="myoxus-text-secondary"
      component="span"
      style={{
        fontFamily: cssTypographyVar(
          "monospace",
          "family",
          cssTypographyVar("body-small", "family", cssVar("fontFamily")),
        ),
      }}
      data-myoxus-ui-role="terminal-muted-text"
    >
      {children}
    </Text>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  status,
  flex,
  className,
  minWidth,
  style,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole = "metric-card",
}: RoleBoxProps & {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  status?: ReactNode;
  flex?: CSSProperties["flex"];
  minWidth?: CSSProperties["minWidth"];
}) {
  return (
    <MantineCard
      withBorder
      className={className}
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole}
      p={"var(--mantine-spacing-sm)"}
      style={{
        background: cssVar("backgroundPrimaryColor"),
        borderColor: cssVar("borderColor"),
        color: cssVar("textPrimaryColor"),
        boxShadow: "none",
        flex,
        minWidth,
        ...style,
      }}
    >
      <Stack gap={"var(--mantine-spacing-xs)"}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Text
            c="myoxus-text-secondary"
            component="span"
            data-myoxus-ui-role="metric-label"
          >
            {label}
          </Text>
          {status}
        </Group>
        <MetricValue>{value}</MetricValue>
        {hint ? (
          <Text
            c="myoxus-text-secondary"
            component="span"
            data-myoxus-ui-role="metric-hint"
          >
            {hint}
          </Text>
        ) : null}
      </Stack>
    </MantineCard>
  );
}

export function StatGrid({
  children,
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps) {
  return (
    <SimpleGrid
      className={className}
      data-testid={dataTestId}
      data-myoxus-ui-role="stat-grid"
      cols={{ base: 1, sm: 3 }}
      spacing={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
      style={{
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 12rem), 1fr))`,
        ...style,
      }}
    >
      {children}
    </SimpleGrid>
  );
}

export function StatCell({
  label,
  value,
  hint,
  density = "default",
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps & {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  density?: "default" | "compact";
}) {
  return (
    <MantineCard
      withBorder
      className={className}
      data-testid={dataTestId}
      data-myoxus-ui-role="stat-cell"
      p={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
      style={{
        background: cssVar("backgroundPrimaryColor"),
        borderColor: cssVar("borderColor"),
        color: cssVar("textPrimaryColor"),
        boxShadow: "none",
        ...style,
      }}
    >
      <Stack gap={"var(--mantine-spacing-2xs)"}>
        <Text
          c="myoxus-text-secondary"
          component="span"
          data-myoxus-ui-role="stat-label"
        >
          {label}
        </Text>
        <MetricValue density={density}>{value}</MetricValue>
        {hint ? (
          <Text
            c="myoxus-text-secondary"
            component="span"
            data-myoxus-ui-role="stat-hint"
          >
            {hint}
          </Text>
        ) : null}
      </Stack>
    </MantineCard>
  );
}
