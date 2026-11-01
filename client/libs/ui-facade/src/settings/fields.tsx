// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Shared settings fields, rows and action layout.
 *
 * These roles are grouped by form semantics instead of living in the package
 * barrel. They depend only on Mantine, theme projection and focused Facade
 * foundations.
 */
import {
  Box,
  Card as MantineCard,
  Divider as MantineDivider,
  Flex as MantineFlex,
  Group,
  Stack,
  Text,
  UnstyledButton as MantineUnstyledButton,
} from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import {
  Children,
  type CSSProperties,
  Fragment,
  type HTMLAttributes,
  isValidElement,
  type PropsWithChildren,
  type ReactNode,
} from "react";

import { withImplicitControlName } from "../helpers/accessibility";
import type { RoleBoxProps } from "../helpers/ui-role";
import { MyoxusText } from "../typography";
import { SettingsSection, type SettingsSectionProps } from "./page";
import { settingsControlMaxWidth } from "./tokens";

export const SettingWrapper = SettingsSection;

export function SettingsDangerZone({
  children,
  ...props
}: SettingsSectionProps) {
  return (
    <SettingsSection {...props} danger>
      {children}
    </SettingsSection>
  );
}

export type SettingsRowProps = PropsWithChildren<{
  name: ReactNode;
  desc?: ReactNode;
  testId?: string;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
  disabled?: boolean;
  /**
   * Use only for a whole-row action with a decorative accessory. Controls such
   * as switches, selects and buttons remain direct row children.
   */
  onClick?: () => void;
  spreadCol?: boolean;
  className?: string;
  style?: CSSProperties;
}>;

/**
 * Standard label/control row. It injects accessible names into compatible
 * anonymous controls, so callers should pass Facade controls instead of
 * hand-wiring labels route by route.
 */
export function SettingsRow({
  name,
  desc,
  testId,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole,
  disabled,
  onClick,
  spreadCol = true,
  className,
  style,
  children,
}: SettingsRowProps) {
  const namedChildren = onClick
    ? children
    : withImplicitControlName(children, name);
  const rowRole = uiRole ?? "settings-row";
  const content = (
    <Group
      data-testid={onClick ? undefined : (testId ?? dataTestId)}
      align="center"
      className={onClick ? undefined : className}
      data-myoxus-ui-role={onClick ? "settings-row-content" : rowRole}
      gap={"var(--mantine-spacing-md)"}
      justify="space-between"
      opacity={disabled ? 0.55 : undefined}
      style={onClick ? undefined : style}
      wrap="wrap"
      aria-disabled={disabled || undefined}
    >
      <Stack
        flex="1 1 0"
        gap={"var(--mantine-spacing-2xs)"}
        miw={0}
        data-myoxus-ui-role="settings-row-copy"
      >
        <MyoxusText
          component="div"
          tone="primary"
          data-myoxus-ui-role="settings-row-label"
        >
          {name}
        </MyoxusText>
        {desc ? (
          <MyoxusText
            component="div"
            tone="secondary"
            typographySlot="body-small"
            data-myoxus-ui-role="settings-row-description"
          >
            {desc}
          </MyoxusText>
        ) : null}
      </Stack>
      {namedChildren && spreadCol ? (
        <Group
          flex="0 1 auto"
          justify="flex-end"
          maw={settingsControlMaxWidth}
          miw={0}
          ms="auto"
          data-myoxus-ui-role="settings-row-control"
          wrap="nowrap"
        >
          {namedChildren}
        </Group>
      ) : (
        namedChildren
      )}
    </Group>
  );

  if (!onClick) return content;

  return (
    <MantineUnstyledButton
      aria-disabled={disabled || undefined}
      className={className}
      data-testid={testId ?? dataTestId}
      data-myoxus-ui-role={rowRole}
      disabled={disabled}
      display="block"
      onClick={onClick}
      style={style}
      type="button"
      w="100%"
    >
      {content}
    </MantineUnstyledButton>
  );
}

export const SettingRow = SettingsRow;

export type SettingsFieldProps = PropsWithChildren<{
  label: ReactNode;
  labelFor?: string;
  description?: ReactNode;
  inline?: boolean;
  disabled?: boolean;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
}>;

/**
 * Stacked/inline field primitive for settings and admin config forms. Use this
 * when the field copy itself is the label and route code should not recreate
 * local typography, spacing or separator rules.
 */
export function SettingsField({
  label,
  labelFor,
  description,
  inline = false,
  disabled,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole,
  children,
}: SettingsFieldProps) {
  return (
    <MantineFlex
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole ?? "settings-field"}
      data-layout={inline ? "inline" : "stacked"}
      aria-disabled={disabled || undefined}
      align={inline ? { base: "stretch", sm: "center" } : "stretch"}
      direction={inline ? { base: "column", sm: "row" } : "column"}
      gap="sm"
      justify={inline ? "space-between" : "flex-start"}
    >
      <Stack gap="xs" data-myoxus-ui-role="settings-field-copy">
        <MyoxusText
          component={labelFor ? "label" : "div"}
          htmlFor={labelFor}
          tone={disabled ? "secondary" : "primary"}
          typographySlot="body"
          data-myoxus-ui-role="settings-field-label"
        >
          {label}
        </MyoxusText>
        {description ? (
          <MyoxusText
            component="div"
            tone="secondary"
            typographySlot="body-small"
            data-myoxus-ui-role="settings-field-description"
          >
            {description}
          </MyoxusText>
        ) : null}
      </Stack>
      <MantineFlex
        align={inline ? { base: "stretch", sm: "flex-end" } : "stretch"}
        data-myoxus-ui-role="settings-field-control"
        direction="column"
        miw={0}
      >
        {children}
      </MantineFlex>
    </MantineFlex>
  );
}

/**
 * Visual group for full settings fields. `SettingsControlList` remains for
 * dense checkbox/radio option rows; complete config fields use this grouped
 * surface so route modules do not create naked table-like forms.
 */
export function SettingsFieldGroup({
  children,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole = "settings-field-group",
}: PropsWithChildren<{
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
}>) {
  const items = Children.toArray(children);

  return (
    <MantineCard
      p={0}
      withBorder
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole}
    >
      <Stack gap={0}>
        {items.map((child, index) => (
          <Fragment key={isValidElement(child) ? (child.key ?? index) : index}>
            {index > 0 ? <MantineDivider /> : null}
            <Box p="md">{child}</Box>
          </Fragment>
        ))}
      </Stack>
    </MantineCard>
  );
}

/**
 * Compact row of controls inside a settings field. This owns the standard
 * control width budget; route code should compose controls, not hard-code
 * min/max widths per settings page.
 */
export function SettingsControlGroup({ children }: PropsWithChildren) {
  return (
    <Group
      justify="flex-end"
      wrap="nowrap"
      style={{
        width: "auto",
        minWidth: 0,
        maxWidth: settingsControlMaxWidth,
      }}
      data-myoxus-ui-role="settings-control-group"
    >
      {children}
    </Group>
  );
}

export function SettingsInlineControl({
  children,
  wrap = false,
  className,
  style,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole,
  "aria-label": ariaLabel,
}: RoleBoxProps & { wrap?: boolean }) {
  // Inline controls are a shared form-composition role. It is intentionally
  // narrow: callers choose controls and data, while spacing/wrapping stays in
  // the Facade to avoid route-local `inline-control` class families.
  return (
    <Group
      className={className}
      data-testid={dataTestId}
      aria-label={ariaLabel}
      gap={"var(--mantine-spacing-xs)"}
      wrap={wrap ? "wrap" : "nowrap"}
      style={{
        alignItems: "center",
        minWidth: 0,
        width: "100%",
        ...style,
      }}
      data-myoxus-ui-role={uiRole ?? "settings-inline-control"}
    >
      {children}
    </Group>
  );
}

export function SettingsControlList({
  children,
  className,
  style,
  "data-testid": dataTestId,
  "aria-label": ariaLabel,
  ...props
}: RoleBoxProps & { role?: string }) {
  // Keep grouped checkbox/radio rows visually one list without requiring each
  // settings route to recreate borders, gaps or nested card padding.
  return (
    <Stack
      {...props}
      gap={0}
      className={className}
      style={style}
      data-testid={dataTestId}
      aria-label={ariaLabel}
      data-myoxus-ui-role="settings-control-list"
    >
      {children}
    </Stack>
  );
}

export function SettingsControlEmpty({
  children,
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps) {
  return (
    <Text
      className={className}
      data-testid={dataTestId}
      style={{
        color: cssVar("textSecondaryColor"),
        padding: `var(--mantine-spacing-xs) calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))`,
        ...style,
      }}
      data-myoxus-ui-role="settings-control-empty"
    >
      {children}
    </Text>
  );
}

/**
 * Label/control item for dense checkbox/radio lists. Use this for repeated
 * options; use SettingsField/SettingsRow for full configuration fields with
 * descriptions.
 */
export function SettingsControlRow({
  label,
  title,
  control,
  controlPosition = "left",
  disabled = false,
  className,
  style,
}: {
  label: ReactNode;
  title?: string;
  control: ReactNode;
  controlPosition?: "left" | "right";
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const controlNode = (
    <Box
      style={{ flex: "0 0 auto" }}
      data-myoxus-ui-role="settings-control-row-control"
    >
      {control}
    </Box>
  );
  const labelNode = (
    <Text
      title={title}
      style={{
        color: cssVar("textPrimaryColor"),
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      data-myoxus-ui-role="settings-control-row-label"
    >
      {label}
    </Text>
  );

  return (
    <Box
      component="label"
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent:
          controlPosition === "right" ? "space-between" : "flex-start",
        gap: "var(--mantine-spacing-xs)",
        padding: `var(--mantine-spacing-xs) calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))`,
        borderRadius: "var(--mantine-radius-sm)",
        color: cssVar("textPrimaryColor"),
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : undefined,
        ...style,
      }}
      data-myoxus-ui-role="settings-control-row"
      data-control-position={controlPosition}
      data-disabled={disabled ? "" : undefined}
    >
      {controlPosition === "left" ? (
        <>
          {controlNode}
          {labelNode}
        </>
      ) : (
        <>
          {labelNode}
          {controlNode}
        </>
      )}
    </Box>
  );
}

export function SettingsToolbar({
  children,
  align = "center",
  justify = "flex-end",
  fullSpan = false,
  layout = "inline",
  style,
  "data-myoxus-ui-role": uiRole = "settings-toolbar",
  ...props
}: PropsWithChildren<{
  align?: string;
  justify?: string;
  fullSpan?: boolean;
  layout?: "inline" | "split";
  style?: CSSProperties;
  "data-myoxus-ui-role"?: string;
}> &
  HTMLAttributes<HTMLDivElement>) {
  // Toolbar alignment lives here so action rows keep one density and wrapping
  // model across settings, Admin tables and operational panels.
  // Split mode covers header/metric rows without forcing route modules to
  // carry one-off grid CSS for the common "copy left, facts right" pattern.
  return (
    <Group
      {...props}
      align={align}
      justify={justify}
      gap={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
      wrap="wrap"
      style={{
        display: layout === "split" ? "grid" : undefined,
        gridColumn: fullSpan ? "1 / -1" : undefined,
        gridTemplateColumns:
          layout === "split" ? "minmax(0, 1fr) auto" : undefined,
        ...style,
      }}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Group>
  );
}
