// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Shared settings page hierarchy and section surfaces.
 *
 * Product routes own data and actions; this module owns the semantic page,
 * heading and section composition without depending on the Facade barrel.
 */
import { Card as MantineCard, Group, Stack, Text } from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import type { CSSProperties, PropsWithChildren, ReactNode } from "react";

import {
  type RoleBoxProps,
  textOverflowRole,
  type TextOverflowRoleProps,
} from "../helpers/ui-role";
import {
  MyoxusText,
  MyoxusTitle,
  type SettingsHeadingLevel,
} from "../typography";

export function SettingsPanelTitle({
  children,
  danger,
  style,
  "data-testid": dataTestId,
}: PropsWithChildren<{
  danger?: boolean;
  style?: CSSProperties;
  "data-testid"?: string;
}>) {
  return (
    <MyoxusTitle
      order={3}
      data-testid={dataTestId}
      tone={danger ? "danger" : "primary"}
      typographySlot="card-title"
      style={style}
      data-myoxus-ui-role="settings-panel-title"
    >
      {children}
    </MyoxusTitle>
  );
}

/**
 * Semantic heading for settings/admin section headers. It preserves real h1-h5
 * document structure while routing the visual role through the global Myoxus
 * typography projection instead of route-local heading classes.
 */
export function SettingsSectionHeading({
  children,
  level = 2,
  truncate,
  lineClamp,
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps & { level?: SettingsHeadingLevel } & TextOverflowRoleProps) {
  return (
    <MyoxusTitle
      order={level}
      className={className}
      data-testid={dataTestId}
      typographySlot={
        level === 1 ? "section-title" : level === 2 ? "section" : "card-title"
      }
      style={{
        minWidth: 0,
        ...textOverflowRole({ truncate, lineClamp }),
        ...style,
      }}
      data-myoxus-ui-role={`settings-section-heading-level-${level}`}
    >
      {children}
    </MyoxusTitle>
  );
}

/**
 * Shared section-description copy role. It intentionally stays separate from
 * headings so consumers do not need local body-copy classes for helper text.
 */
export function SettingsSectionDescription({
  children,
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps) {
  return (
    <MyoxusText
      component="p"
      className={className}
      data-testid={dataTestId}
      tone="secondary"
      typographySlot="body"
      fallbackSlot="body-small"
      style={style}
      data-myoxus-ui-role="settings-section-description"
    >
      {children}
    </MyoxusText>
  );
}

/**
 * Compact heading/description block for settings subsections. Consumers keep
 * semantic heading levels, while spacing stays in the shared Facade instead of
 * route-local wrapper divs.
 */
export function SettingsHeadingGroup({
  children,
  "data-testid": dataTestId,
}: PropsWithChildren<{ "data-testid"?: string }>) {
  return (
    <Stack
      gap="xs"
      data-testid={dataTestId}
      data-myoxus-ui-role="settings-heading-group"
    >
      {children}
    </Stack>
  );
}

export function SettingsPanelDescription({
  children,
  style,
  "data-testid": dataTestId,
}: PropsWithChildren<{
  style?: CSSProperties;
  "data-testid"?: string;
}>) {
  return (
    <MyoxusText
      component="p"
      data-testid={dataTestId}
      tone="secondary"
      typographySlot="body"
      fallbackSlot="body-small"
      style={style}
      data-myoxus-ui-role="settings-panel-description"
    >
      {children}
    </MyoxusText>
  );
}

export type SettingsPageProps = PropsWithChildren<{
  title: ReactNode;
  subtitle?: ReactNode;
  testId?: string;
  beta?: boolean;
  "data-testid"?: string;
}>;

/**
 * Canonical settings-page shell used by Web/Electron settings and Admin panels.
 * Route code owns content and data; page rhythm and heading hierarchy stay here
 * so settings surfaces do not grow independent layout systems.
 */
export function SettingsPage({
  title,
  subtitle,
  testId,
  beta,
  children,
  "data-testid": dataTestId,
}: SettingsPageProps) {
  return (
    <Stack
      gap={"var(--mantine-spacing-lg)"}
      data-testid={testId ?? dataTestId}
      data-myoxus-ui-role="settings-page"
    >
      <SettingHeader title={title} subtitle={subtitle} beta={beta} />
      <Stack
        gap={"var(--mantine-spacing-md)"}
        data-myoxus-ui-role="settings-page-container"
      >
        {children}
      </Stack>
    </Stack>
  );
}

export function SettingHeader({
  title,
  subtitle,
  beta,
  ...props
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  beta?: boolean;
  "data-testid"?: string;
}) {
  return (
    <Stack
      gap={"var(--mantine-spacing-xs)"}
      data-myoxus-ui-role="settings-header"
      {...props}
    >
      <MyoxusTitle
        order={1}
        typographySlot="card-title"
        data-myoxus-ui-role="settings-page-title"
      >
        {title}
        {beta ? (
          <Text
            component="span"
            ml={"var(--mantine-spacing-sm)"}
            px={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
            style={{
              borderRadius: "var(--mantine-radius-sm)",
              background: cssVar("tagBlue"),
              color: cssVar("textPrimaryColor"),
            }}
            data-myoxus-ui-role="settings-beta-badge"
          >
            Beta
          </Text>
        ) : null}
      </MyoxusTitle>
      {subtitle ? (
        <MyoxusText
          italic
          tone="secondary"
          typographySlot="body"
          fallbackSlot="body-small"
          data-myoxus-ui-role="settings-description"
        >
          {subtitle}
        </MyoxusText>
      ) : null}
    </Stack>
  );
}

export type SettingsSectionProps = PropsWithChildren<{
  title?: ReactNode;
  description?: ReactNode;
  /**
   * Header-side commands for settings detail panels. Keep this slot in the
   * facade so routes do not rebuild section headers with local CSS.
   */
  actions?: ReactNode;
  id?: string;
  testId?: string;
  "data-testid"?: string;
  danger?: boolean;
  disabled?: boolean;
  component?: "article" | "div" | "section";
  className?: string;
  style?: CSSProperties;
  [key: `data-${string}`]: unknown;
}>;

/**
 * Card-like settings section. Consumers may pass semantic content, but should
 * not restyle title/body typography locally; this primitive maps it to the
 * global theme typography budget.
 */
export function SettingsSection({
  title,
  description,
  actions,
  id,
  testId,
  "data-testid": dataTestId,
  danger,
  disabled,
  component,
  className,
  style,
  children,
  ...dataProps
}: SettingsSectionProps) {
  return (
    <MantineCard
      {...dataProps}
      component={component}
      id={id}
      data-testid={testId ?? dataTestId}
      data-myoxus-ui-role={danger ? "settings-danger-zone" : "settings-panel"}
      className={className}
      inert={disabled || undefined}
      opacity={disabled ? 0.55 : undefined}
      p={"var(--mantine-spacing-lg)"}
      style={{
        // Card clips by default; in-dialog menus/selects must extend past a settings section.
        overflow: "visible",
        ...(danger ? { borderColor: cssVar("errorColor") } : {}),
        ...style,
      }}
      aria-disabled={disabled || undefined}
    >
      <Stack gap={"var(--mantine-spacing-sm)"}>
        {title || description || actions ? (
          <Group
            align="flex-start"
            gap={"var(--mantine-spacing-sm)"}
            justify="space-between"
            wrap="wrap"
            data-myoxus-ui-role="settings-section-header"
          >
            {title || description ? (
              <Stack
                flex="1 1 auto"
                gap={"var(--mantine-spacing-2xs)"}
                miw={0}
                data-myoxus-ui-role="settings-section-heading"
              >
                {title ? (
                  <SettingsPanelTitle danger={danger}>
                    {title}
                  </SettingsPanelTitle>
                ) : null}
                {description ? (
                  <SettingsPanelDescription>
                    {description}
                  </SettingsPanelDescription>
                ) : null}
              </Stack>
            ) : null}
            {actions ? (
              <Group
                gap={"var(--mantine-spacing-xs)"}
                justify="flex-end"
                wrap="wrap"
                data-myoxus-ui-role="settings-section-actions"
              >
                {actions}
              </Group>
            ) : null}
          </Group>
        ) : null}
        <Stack
          gap={"calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"}
          data-myoxus-ui-role="settings-section-content"
        >
          {children}
        </Stack>
      </Stack>
    </MantineCard>
  );
}
