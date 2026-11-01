// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type CSSProperties,
  type PropsWithChildren,
  type HTMLAttributes,
} from "react";
import {
  Loader,
  Box,
  LoadingOverlay as MantineLoadingOverlay,
  Progress as MantineProgress,
  Skeleton as MantineSkeleton,
  Slider as MantineSlider,
  Stack,
  Text,
} from "@mantine/core";
import { cssVar } from "@myoxus/theme";

/**
 * Product-neutral progress, error and loading-feedback primitives.
 */

export interface ProgressProps {
  value: number;
  /**
   * Semantic visual status for product-owned meters. Use `color` only when the
   * measured domain already provides an explicit theme-backed meter color.
   */
  tone?: "default" | "error" | "warning";
  color?: string;
  className?: string;
  style?: CSSProperties;
  testId?: string;
  showValueLabel?: boolean;
  ariaLabel?: string;
}

export function Progress({
  value,
  tone = "default",
  color,
  className,
  style,
  testId,
  showValueLabel = true,
  ariaLabel = "Progress",
}: ProgressProps) {
  const clampedValue = Math.max(0, Math.min(100, value));
  const semanticColor =
    tone === "error"
      ? "myoxusError"
      : tone === "warning"
        ? "myoxusWarning"
        : "myoxus";

  return (
    <Stack
      gap={"var(--mantine-spacing-xs)"}
      className={className}
      style={style}
      data-testid={testId}
      data-myoxus-ui-role="progress"
    >
      <MantineProgress
        aria-label={ariaLabel}
        color={color ?? semanticColor}
        value={clampedValue}
        radius="xl"
        size="sm"
      />
      {showValueLabel ? (
        <Text c="dimmed" ta="right">
          {clampedValue}%
        </Text>
      ) : null}
    </Stack>
  );
}

export interface ProgressSliderProps {
  value: number;
  onChange?: (value: number) => void;
  onChangeEnd?: (value: number) => void;
  readonly?: boolean;
  ariaLabel?: string;
  testId?: string;
}

export function ProgressSlider({
  value,
  onChange,
  onChangeEnd,
  readonly = false,
  ariaLabel = "Progress",
  testId,
}: ProgressSliderProps) {
  const clampedValue = Math.max(0, Math.min(100, value));
  if (readonly) {
    return (
      <Text
        c="dimmed"
        data-testid={testId}
        data-myoxus-ui-role="progress-slider-readonly"
      >
        {clampedValue}%
      </Text>
    );
  }
  return (
    <Stack gap="xs" data-testid={testId} data-myoxus-ui-role="progress-slider">
      <MantineSlider
        value={clampedValue}
        min={0}
        max={100}
        step={1}
        label={(nextValue) => `${nextValue}%`}
        thumbLabel={ariaLabel}
        thumbValueText={(nextValue) => `${nextValue}%`}
        onChange={onChange}
        onChangeEnd={onChangeEnd}
      />
      <Text c="dimmed" ta="right">
        {clampedValue}%
      </Text>
    </Stack>
  );
}

export function ErrorMessage({
  children,
  inline,
  style,
  className,
  "data-testid": dataTestId,
  role,
}: PropsWithChildren<{
  inline?: boolean;
  style?: CSSProperties;
  className?: string;
  "data-testid"?: string;
  role?: HTMLAttributes<HTMLElement>["role"];
}>) {
  return (
    <Box
      component={inline ? "span" : "div"}
      className={className}
      data-testid={dataTestId}
      role={role}
      style={{
        color: cssVar("errorColor"),
        ...style,
      }}
      data-myoxus-ui-role="settings-error-text"
    >
      {children}
    </Box>
  );
}

type SkeletonProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  variant?: "text" | "circular" | "rectangular" | "rounded";
  width?: number | string;
  height?: number | string;
  w?: number | string;
  h?: number | string;
  flex?: CSSProperties["flex"];
  style?: CSSProperties;
  className?: string;
  animation?: string;
  "data-myoxus-ui-role"?: string;
};

export function Skeleton({
  variant,
  width,
  height,
  w,
  h,
  flex,
  style,
  className,
  "data-myoxus-ui-role": uiRole = "settings-skeleton-line",
  ...domProps
}: SkeletonProps) {
  return (
    <MantineSkeleton
      {...domProps}
      className={className}
      width={width ?? w}
      height={height ?? h}
      circle={variant === "circular"}
      radius={
        variant === "rectangular" || variant === "rounded" ? "md" : undefined
      }
      style={{ flex, ...style }}
      data-myoxus-ui-role={uiRole}
    />
  );
}

export type MyoxusNotificationTheme =
  "info" | "success" | "warning" | "error" | "normal" | string;

/**
 * Map a Myoxus semantic `theme` to a Mantine theme color name.
 *
 * Mantine 9 has no native `actions` slot on `NotificationData`, so any
 * caller-provided actions are rendered as inline buttons inside the
 * notification message body. Each button calls its `onClick` handler and
 * then hides the notification unless `action.autoClose === false` (used by
 * navigation actions that must keep the toast visible after the click).
 *
 * P-NOTIF-05 stop-condition decision (recorded 2026-06-21): the previous
 * `MyoxusNotification` accepted up to N actions, but the active caller
 * surface (3 sites) only ever passes a single action. Routing them through
 * the `message` body preserves current behavior without inventing a second
 * portal or a local CSS layer.
 */
export function myoxusThemeToMantineColor(
  theme: MyoxusNotificationTheme | undefined,
): "myoxusError" | "myoxusSuccess" | "myoxusWarning" | "myoxusInfo" {
  switch (theme) {
    case "error":
      return "myoxusError";
    case "success":
      return "myoxusSuccess";
    case "warning":
      return "myoxusWarning";
    case "info":
    case "normal":
    case undefined:
    default:
      return "myoxusInfo";
  }
}

export function MyoxusLoader({
  size = "var(--mantine-spacing-lg)",
  className,
  style,
}: {
  size?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Loader
      size={size}
      className={className}
      style={style}
      data-myoxus-ui-role="settings-loader"
    />
  );
}

export const Loading = MyoxusLoader;

export function GlobalLoadingOverlay({
  children,
  className,
  visible = true,
  "data-myoxus-ui-role": uiRole = "global-loading-overlay",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    visible?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <Box
      {...props}
      className={className}
      data-visible={visible ? "true" : "false"}
      data-myoxus-ui-role={uiRole}
      hidden={!visible}
      inset={0}
      pos="fixed"
    >
      <MantineLoadingOverlay
        loaderProps={{
          children,
          color: cssVar("warningColor"),
        }}
        overlayProps={{
          backgroundOpacity: 1,
          color: cssVar("backgroundOverlayPanelColor"),
        }}
        visible={visible}
        zIndex={cssVar("zIndexModal")}
      />
    </Box>
  );
}
