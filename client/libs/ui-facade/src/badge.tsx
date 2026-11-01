// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  forwardRef,
  type ReactNode,
  type CSSProperties,
  type PropsWithChildren,
  type HTMLAttributes,
  type ComponentProps,
} from "react";
import { type RoleBoxProps } from "./helpers/ui-role";
import { type TagColorRole, tagColorRoleBackground } from "./color-swatch";
import { cssVar } from "@myoxus/theme";
import {
  Badge as MantineBadge,
  Box,
  Indicator as MantineIndicator,
  Group,
  ActionIcon,
  Text,
} from "@mantine/core";
import { CloseIcon } from "@myoxus/icons/react";

type BadgeTone = "neutral" | "success" | "warning" | "error" | "info";

export const Badge = forwardRef<
  HTMLDivElement | HTMLButtonElement,
  RoleBoxProps & {
    /** Native button semantics preserve badge appearance for interactive triggers. */
    component?: "div" | "button";
    type?: "button";
    title?: string;
    tone?: BadgeTone;
    tagColorRole?: TagColorRole;
    surface?: "default" | "floating";
    prefix?: ReactNode;
    truncate?: boolean;
  }
>(function Badge(
  {
    children,
    component = "div",
    prefix,
    tone = "neutral",
    tagColorRole,
    surface = "default",
    truncate = false,
    className,
    style,
    "data-testid": dataTestId,
    "data-myoxus-ui-role": dataMyoxusUiRole,
    "aria-label": ariaLabel,
    ...dataAttributes
  },
  ref,
) {
  // Badge tones are semantic status roles, not Mantine palette names. Domain
  // code must never choose colors such as "green" or "yellow" directly.
  const isFloating = surface === "floating";
  const backgroundByTone = {
    neutral: cssVar("backgroundSecondaryColor"),
    success: cssVar("backgroundSuccessColor"),
    warning: cssVar("backgroundWarningColor"),
    error: cssVar("backgroundErrorColor"),
    info: cssVar("backgroundProcessingColor"),
  } as const;
  // Status hue is carried by the badge paper. Foreground text stays on
  // the global primary text role because several preset papers are intentionally
  // soft and their matching "deep" status hues are below the WCAG contrast gate.
  const badgeTextColor = cssVar("textPrimaryColor");
  return (
    <MantineBadge
      {...dataAttributes}
      component={component}
      ref={ref as never}
      className={className}
      variant="light"
      leftSection={prefix}
      style={{
        backgroundColor: isFloating
          ? `color-mix(in srgb, ${cssVar("backgroundSecondaryColor")} 72%, transparent)`
          : tagColorRole
            ? tagColorRoleBackground(tagColorRole)
            : backgroundByTone[tone],
        boxShadow: isFloating
          ? `var(--myoxus-ui-card-shadow, var(--mantine-shadow-lg))`
          : undefined,
        color: badgeTextColor,
        maxWidth: truncate ? "100%" : "none",
        overflow: truncate ? "hidden" : "visible",
        textTransform: "none",
        ...style,
      }}
      styles={{
        label: {
          maxWidth: truncate ? "100%" : undefined,
          minWidth: truncate ? 0 : undefined,
          overflow: truncate ? "hidden" : "visible",
          textOverflow: truncate ? "ellipsis" : "clip",
          whiteSpace: "nowrap",
          width: truncate ? "100%" : undefined,
        },
      }}
      data-testid={dataTestId}
      aria-label={ariaLabel}
      data-myoxus-ui-role={
        dataMyoxusUiRole ??
        (tagColorRole ? `badge:${tagColorRole}` : `badge:${tone}`)
      }
    >
      {children}
    </MantineBadge>
  );
});

export function CountBadge({
  label,
  count,
  tone = "neutral",
  className,
  style,
  "data-testid": dataTestId,
}: {
  label: ReactNode;
  count: number | string;
  tone?: BadgeTone;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
}) {
  const plainLabel = typeof label === "string" ? label : undefined;
  const accessibleLabel = plainLabel ? `${plainLabel}: ${count}` : undefined;

  return (
    <Badge
      tone={tone}
      className={className}
      style={style}
      data-testid={dataTestId}
      aria-label={accessibleLabel}
    >
      <Box
        component="span"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--mantine-spacing-xs)",
          minWidth: 0,
        }}
        data-myoxus-ui-role="count-badge-content"
      >
        <Box component="span" data-myoxus-ui-role="count-badge-label">
          {label}{" "}
        </Box>
        <Box
          component="strong"
          style={{ fontVariantNumeric: "tabular-nums" }}
          data-myoxus-ui-role="count-badge-value"
        >
          {count}
        </Box>
      </Box>
    </Badge>
  );
}

export type CountIndicatorProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    count?: number;
    max?: number;
    showZero?: boolean;
    disabled?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>;

export const CountIndicator = forwardRef<HTMLDivElement, CountIndicatorProps>(
  function CountIndicator(
    {
      children,
      count = 0,
      max = 99,
      showZero = false,
      disabled,
      style,
      "data-myoxus-ui-role": uiRole = "count-indicator",
      ...props
    },
    ref,
  ) {
    const hidden = disabled || (!showZero && count <= 0);

    return (
      <MantineIndicator
        {...props}
        ref={ref}
        inline
        disabled={hidden}
        label={count}
        maxValue={max}
        position="top-end"
        size={"var(--mantine-spacing-lg)"}
        color={cssVar("primaryColor")}
        radius={"var(--mantine-radius-xl)"}
        styles={{
          indicator: {
            color: cssVar("pureWhite"),
            fontVariantNumeric: "tabular-nums",
            minWidth: "var(--mantine-spacing-lg)",
            paddingInline: "var(--mantine-spacing-2xs)",
          },
        }}
        style={style}
        data-myoxus-ui-role={uiRole}
      >
        {children}
      </MantineIndicator>
    );
  },
);

type BadgeListMaxHeight = "compact" | "default" | CSSProperties["maxHeight"];

function badgeListMaxHeight(maxHeight: BadgeListMaxHeight | undefined) {
  if (!maxHeight) return undefined;
  if (maxHeight === "compact") {
    return `calc(calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs)) * 2 + var(--mantine-spacing-xs))`;
  }
  if (maxHeight === "default")
    return "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 13)";
  return maxHeight;
}

export function BadgeList({
  children,
  "data-myoxus-ui-role": uiRole = "badge-list",
  gap = "var(--mantine-spacing-2xs)",
  grow = false,
  justify,
  maxHeight,
  scrollable = false,
  style,
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLUListElement> & {
    gap?: CSSProperties["gap"];
    grow?: boolean;
    justify?: ComponentProps<typeof Group>["justify"];
    maxHeight?: BadgeListMaxHeight;
    scrollable?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>) {
  const resolvedMaxHeight = badgeListMaxHeight(maxHeight);
  const groupProps = props as ComponentProps<typeof Group>;
  return (
    <Group
      component="ul"
      {...groupProps}
      align="center"
      gap={gap}
      justify={justify}
      wrap="wrap"
      data-scrollable={scrollable ? "true" : undefined}
      style={{
        flex: grow ? "1 1 auto" : undefined,
        maxHeight: resolvedMaxHeight,
        minWidth: grow || scrollable ? 0 : undefined,
        overflowY: scrollable ? "auto" : undefined,
        padding: 0,
        margin: 0,
        listStyle: "none",
        ...style,
      }}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Group>
  );
}

export function BadgeListItem({
  children,
  grow = false,
  "data-myoxus-ui-role": uiRole = "badge-list-item",
  style,
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLLIElement> & {
    "data-myoxus-ui-role"?: string;
    grow?: boolean;
  }
>) {
  return (
    <Box
      component="li"
      {...props}
      style={{
        display: "flex",
        flex: grow ? "1 1 auto" : undefined,
        maxWidth: "100%",
        minWidth: 0,
        ...style,
      }}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
}

export function RemovableBadge({
  children,
  tone = "neutral",
  tagColorRole,
  prefix,
  selected = false,
  style,
  removeLabel,
  onRemove,
  "data-testid": dataTestId,
  ...dataAttributes
}: RoleBoxProps & {
  tone?: BadgeTone;
  tagColorRole?: TagColorRole;
  prefix?: ReactNode;
  selected?: boolean;
  style?: CSSProperties;
  removeLabel?: string;
  onRemove?: () => void;
  "data-testid"?: string;
}) {
  // Removable chips appear in several admin/web forms. The visual badge and
  // close affordance live together here so routes do not hand-build tiny button
  // geometry or icon sizing.
  return (
    <Badge
      {...dataAttributes}
      tone={tone}
      tagColorRole={tagColorRole}
      truncate
      data-testid={dataTestId}
      data-selected={selected ? "true" : undefined}
      style={{
        borderColor: selected ? cssVar("primaryColor") : undefined,
        maxWidth: "100%",
        ...style,
      }}
    >
      <Box
        component="span"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--mantine-spacing-2xs)",
          maxWidth: "100%",
          minWidth: 0,
        }}
        data-myoxus-ui-role="removable-badge-content"
      >
        {prefix ? (
          <Box
            component="span"
            style={{ display: "inline-flex", flex: "0 0 auto" }}
            data-myoxus-ui-role="removable-badge-prefix"
          >
            {prefix}
          </Box>
        ) : null}
        <Box
          component="span"
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          data-myoxus-ui-role="removable-badge-label"
        >
          {children}
        </Box>
        {onRemove ? (
          <ActionIcon
            type="button"
            aria-label={removeLabel ?? "Remove"}
            variant="transparent"
            size={
              "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"
            }
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            style={{
              color: "currentColor",
              minWidth:
                "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
            }}
            data-myoxus-ui-role="removable-badge-remove"
          >
            <CloseIcon aria-hidden />
          </ActionIcon>
        ) : null}
      </Box>
    </Badge>
  );
}

export function StatusDot({
  tone = "neutral",
  label,
  className,
  style,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole,
  "data-admin-tone": adminTone,
  "aria-label": ariaLabel,
}: {
  tone?: "neutral" | "success" | "warning" | "error" | "info";
  label?: ReactNode;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
  "data-admin-tone"?: string;
  "aria-label"?: string;
}) {
  // The CSS-variable override is intentionally narrow: consumers may project a
  // validated tone, but fallback remains in the global semantic status tokens.
  const fallbackColor =
    tone === "success"
      ? cssVar("successColor")
      : tone === "warning"
        ? cssVar("warningColor")
        : tone === "error"
          ? cssVar("errorColor")
          : tone === "info"
            ? cssVar("processingColor")
            : cssVar("textSecondaryColor");
  const color = `var(--myoxus-ui-status-dot-color, ${fallbackColor})`;
  return (
    <Group
      className={className}
      gap={"var(--mantine-spacing-xs)"}
      wrap="nowrap"
      style={style}
      data-testid={dataTestId}
      data-admin-tone={adminTone}
      aria-label={ariaLabel}
      data-myoxus-ui-role={uiRole ?? `status-dot:${tone}`}
    >
      <Box
        component="span"
        style={{
          width: "var(--mantine-spacing-xs)",
          height: "var(--mantine-spacing-xs)",
          borderRadius: "var(--mantine-radius-xl)",
          background: `var(--myoxus-ui-status-dot-dot-color, ${color})`,
          flex: "0 0 auto",
        }}
      />
      {label ? (
        <Text
          style={{
            color: `var(--myoxus-ui-status-dot-label-color, ${color})`,
          }}
        >
          {label}
        </Text>
      ) : null}
    </Group>
  );
}
