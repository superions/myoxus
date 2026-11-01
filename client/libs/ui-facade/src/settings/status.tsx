// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared status copy, progress and loading states for Settings surfaces.
 */
import { Alert, Group, Stack, Text } from "@mantine/core";
import { cssTypographyVar, cssVar } from "@myoxus/theme";
import type { CSSProperties, PropsWithChildren, ReactNode } from "react";

import { Progress, Skeleton } from "../feedback";
import {
  type RoleBoxProps,
  textOverflowRole,
  type TextOverflowRoleProps,
} from "../helpers/ui-role";
import { MyoxusText, type MyoxusTextTone } from "../typography";

export function SettingsStatusText({
  children,
  tone = "muted",
  mono = false,
  truncate,
  lineClamp,
  className,
  style,
  "data-testid": dataTestId,
  ...props
}: RoleBoxProps & {
  tone?: "muted" | "active" | "error" | "warning";
  title?: string;
  mono?: boolean;
} & TextOverflowRoleProps) {
  const color =
    tone === "error"
      ? cssVar("errorColor")
      : tone === "warning"
        ? cssVar("warningColor")
        : tone === "active"
          ? cssVar("textEmphasisColor")
          : cssVar("textSecondaryColor");
  return (
    <Group
      className={className}
      data-testid={dataTestId}
      {...props}
      gap={"var(--mantine-spacing-xs)"}
      wrap="nowrap"
      style={{
        color,
        fontFamily: mono
          ? cssTypographyVar(
              "monospace",
              "family",
              cssTypographyVar("body-small", "family", cssVar("fontFamily")),
            )
          : undefined,
        minWidth: 0,
        ...textOverflowRole({ truncate, lineClamp }),
        ...style,
      }}
      data-myoxus-ui-role={
        mono ? `settings-status-${tone}:mono` : `settings-status-${tone}`
      }
    >
      {children}
    </Group>
  );
}

export function SettingsEmptyState({
  title,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <Alert title={title} data-myoxus-ui-role="settings-empty-state">
      {description ? (
        <MyoxusText tone="secondary">{description}</MyoxusText>
      ) : null}
    </Alert>
  );
}

export function SettingsNotice({
  title,
  children,
  tone = "info",
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole,
  ...props
}: PropsWithChildren<{
  title?: ReactNode;
  tone?: "error" | "neutral" | "info" | "success" | "warning";
}> &
  Omit<RoleBoxProps, "title">) {
  const toneTokens = {
    error: {
      accent: cssVar("errorColor"),
      background: cssVar("backgroundErrorColor"),
    },
    neutral: {
      accent: cssVar("textSecondaryColor"),
      background: cssVar("backgroundSecondaryColor"),
    },
    info: {
      accent: cssVar("processingColor"),
      background: cssVar("backgroundProcessingColor"),
    },
    success: {
      accent: cssVar("successColor"),
      background: cssVar("backgroundSuccessColor"),
    },
    warning: {
      accent: cssVar("warningColor"),
      background: cssVar("backgroundWarningColor"),
    },
  } as const;
  const toneStyle = toneTokens[tone];

  return (
    <Alert
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole ?? `settings-notice:${tone}`}
      {...props}
      style={{
        background: toneStyle.background,
        borderColor: cssVar("borderColor"),
        borderInlineStart: `var(--mantine-spacing-2xs) solid ${toneStyle.accent}`,
        color: cssVar("textPrimaryColor"),
        ...props.style,
      }}
    >
      {title ? (
        <Text component="div" c="inherit">
          {title}
        </Text>
      ) : null}
      {children ? (
        <Text component="div" c="dimmed" mt={title ? "xs" : undefined}>
          {children}
        </Text>
      ) : null}
    </Alert>
  );
}

/** Product-neutral notice name for non-settings product surfaces. */
export const Notice = SettingsNotice;

type SettingsListItemTitleProps = RoleBoxProps & {
  title?: string;
  /**
   * Authoring/font-catalog preview hook. Use only for marked preview data;
   * normal settings titles inherit the global Myoxus typography slot.
   */
  previewFontFamily?: CSSProperties["fontFamily"];
} & TextOverflowRoleProps;

export function SettingsListItemTitle({
  children,
  previewFontFamily,
  truncate,
  lineClamp,
  className,
  style,
  "data-testid": dataTestId,
  ...dataAttributes
}: SettingsListItemTitleProps) {
  return (
    <MyoxusText
      component="span"
      className={className}
      data-testid={dataTestId}
      {...dataAttributes}
      display="block"
      lineClamp={lineClamp}
      minWidth={0}
      tone="primary"
      truncate={truncate}
      style={
        previewFontFamily || style
          ? {
              fontFamily: previewFontFamily,
              ...style,
            }
          : undefined
      }
      data-myoxus-ui-role="settings-list-item-title"
    >
      {children}
    </MyoxusText>
  );
}

export function SettingsListItemMeta({
  children,
  tone = "muted",
  truncate,
  lineClamp,
  breakAnywhere,
  className,
  style,
  "data-testid": dataTestId,
  title,
}: RoleBoxProps &
  TextOverflowRoleProps & {
    tone?: "muted" | "active" | "error";
    breakAnywhere?: boolean;
    title?: string;
  }) {
  const textTone: MyoxusTextTone =
    tone === "error" ? "danger" : tone === "active" ? "emphasis" : "secondary";
  return (
    <MyoxusText
      component="span"
      className={className}
      data-testid={dataTestId}
      title={title}
      display="block"
      lineClamp={lineClamp}
      minWidth={0}
      tone={textTone}
      truncate={truncate}
      style={
        breakAnywhere || style
          ? {
              overflowWrap: breakAnywhere ? "anywhere" : undefined,
              ...style,
            }
          : undefined
      }
      data-myoxus-ui-role={`settings-list-item-meta-${tone}`}
    >
      {children}
    </MyoxusText>
  );
}

export function SettingsProgress({ value }: { value: number }) {
  return <Progress value={value} testId="settings-progress" />;
}

export function SettingsSkeleton() {
  return (
    <Stack
      gap={"var(--mantine-spacing-md)"}
      data-myoxus-ui-role="settings-skeleton"
    >
      <Skeleton height={28} variant="rectangular" />
      <Skeleton height={96} variant="rectangular" />
      <Skeleton height={96} variant="rectangular" />
    </Stack>
  );
}

export function WorkspaceDetailSkeleton() {
  return <SettingsSkeleton />;
}

export function WorkspaceListSkeleton() {
  return (
    <Stack
      gap={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
      data-myoxus-ui-role="settings-skeleton"
    >
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} height={30} variant="rectangular" />
      ))}
    </Stack>
  );
}

export function WorkspaceListItemSkeleton() {
  return <Skeleton height={30} variant="rectangular" />;
}
