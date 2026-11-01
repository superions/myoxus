// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type CSSProperties,
  type HTMLAttributes,
  type ElementType,
  forwardRef,
  type Ref,
  type ButtonHTMLAttributes,
  type ReactNode,
  type MouseEventHandler,
} from "react";
import {
  Stack,
  Box,
  Card as MantineCard,
  ScrollArea,
  Group,
  UnstyledButton as MantineUnstyledButton,
} from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import {
  type MyoxusTextProps,
  MyoxusText,
  type MyoxusTypographySlot,
  type MyoxusTextTone,
} from "./typography";
import { type TagColorRole, resolveTagColorAccent } from "./color-swatch";

/**
 * List container for cards/rows that should be perceived as one surface group.
 * Use this instead of route-local list CSS when row chrome is not domain
 * specific.
 */
export function SurfaceList({
  children,
  label,
  className,
  style,
  gap = "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
  role = "group",
  "data-testid": dataTestId,
}: PropsWithChildren<{
  label?: string;
  className?: string;
  style?: CSSProperties;
  gap?: CSSProperties["gap"];
  /**
   * Generic surface collections default to `group` because their children may
   * be buttons, links or articles. Use `list` only when every direct child has
   * listitem semantics; ARIA lists cannot contain arbitrary interactive rows.
   */
  role?: "group" | "list";
  "data-testid"?: string;
}>) {
  return (
    <Stack
      role={role}
      aria-label={label}
      gap={gap}
      className={className}
      style={style}
      data-testid={dataTestId}
      data-myoxus-ui-role="surface-list"
    >
      {children}
    </Stack>
  );
}

/**
 * Shared route-list header chrome. Product routes provide title/actions only;
 * native Group owns page density; section and supplied heights remain explicit.
 */
export function SurfaceListHeader({
  children,
  component,
  density = "page",
  height,
  style,
  "data-myoxus-ui-role": uiRole = "surface-list-header",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    component?: ElementType;
    density?: "page" | "section";
    height?: CSSProperties["height"];
    "data-myoxus-ui-role"?: string;
  }
>) {
  const sectionDensity = density === "section";
  const Component = component ?? "div";
  return (
    <Group
      {...props}
      component={Component}
      align="center"
      justify="space-between"
      wrap="nowrap"
      gap={sectionDensity ? "xs" : undefined}
      h={
        height === undefined && sectionDensity
          ? "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))"
          : undefined
      }
      px={sectionDensity ? "xs" : undefined}
      data-density={density}
      data-myoxus-ui-role={uiRole}
      style={{
        ...(height === undefined ? {} : { height }),
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </Group>
  );
}

export function SurfaceListHeaderTitle({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "surface-list-header-title",
  ...props
}: MyoxusTextProps & { "data-myoxus-ui-role"?: string }) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "div"}
      fallbackSlot={props.fallbackSlot ?? "body-small"}
      tone={props.tone ?? "secondary"}
      typographySlot={props.typographySlot ?? "card-title"}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        display: "flex",
        flexShrink: 1,
        gap: "var(--mantine-spacing-sm)",
        minWidth: 0,
        userSelect: "none",
        ...style,
      }}
    >
      {children}
    </MyoxusText>
  );
}

export type SurfaceListHeaderSelectable = boolean | "toggle";

/**
 * Sticky header row for virtualized/flex page lists. The remaining inline
 * geometry is P-FE-FACADE-04/P-FE-FACADE-06 debt; surface-list.css no longer
 * owns row, header, hover or disclosure chrome.
 */
export function SurfaceListTableHeader({
  children,
  selectable,
  selectionActive = false,
  style,
  "data-myoxus-ui-role": uiRole = "surface-list-table-header",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    selectable?: SurfaceListHeaderSelectable;
    selectionActive?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <Box
      {...props}
      data-selectable={selectable === false ? undefined : selectable}
      data-selection-active={selectionActive ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        background: cssVar("backgroundPrimaryColor"),
        display: "flex",
        left: 0,
        overflow: "hidden",
        padding: `calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs)) calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs)) calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs)) var(--mantine-spacing-lg)`,
        position: "sticky",
        top: 0,
        transform: `translateY(calc(calc(var(--mantine-scale) * 1px) / -2))`,
        transition: "box-shadow 120ms ease-in-out",
        zIndex: 1,
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function SurfaceListHeaderTitleCell({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "surface-list-header-title-cell",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Box
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        display: "flex",
        gap: "var(--mantine-spacing-sm)",
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function SurfaceListHeaderSelectionSlot({
  active = false,
  children,
  selectable,
  style,
  "data-myoxus-ui-role": uiRole = "surface-list-header-selection-slot",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    active?: boolean;
    selectable?: SurfaceListHeaderSelectable;
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <Box
      {...props}
      data-active={active ? "true" : undefined}
      data-selectable-mode={selectable === "toggle" ? "toggle" : undefined}
      data-myoxus-ui-role={uiRole}
      w={
        selectable === "toggle"
          ? "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))"
          : active
            ? "var(--mantine-spacing-xl)"
            : 0
      }
      style={{
        alignItems: "center",
        color: cssVar("iconColor"),
        display: "flex",
        fontSize: "var(--mantine-spacing-lg)",
        justifyContent: "flex-start",
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

type SurfaceListHeaderCellFlex =
  1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/**
 * Flex-based column header cell shared by document, collection and tag lists.
 * The flex math mirrors the row column contract so headers and virtualized rows
 * keep the same column proportions without product-local CSS modules.
 */
export function SurfaceListHeaderCell({
  alignment,
  children,
  flex,
  hidden,
  hideInCompact,
  sorting = false,
  sortable = false,
  style,
  visibilityHidden = false,
  "data-myoxus-ui-role": uiRole = "surface-list-header-cell",
  ...props
}: PropsWithChildren<
  Omit<HTMLAttributes<HTMLDivElement>, "hidden"> & {
    alignment?: "start" | "center" | "end";
    flex?: SurfaceListHeaderCellFlex;
    hidden?: boolean;
    hideInCompact?: boolean;
    sorting?: boolean;
    sortable?: boolean;
    visibilityHidden?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <Box
      {...props}
      data-hidden={hidden ? "true" : undefined}
      data-hide-in-compact={hideInCompact ? "true" : undefined}
      data-sorting={sorting ? "true" : undefined}
      data-sortable={sortable ? "true" : undefined}
      data-visibility-hidden={visibilityHidden ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      role={props.role}
      style={{
        alignItems: "center",
        color: cssVar("textSecondaryColor"),
        columnGap: "var(--mantine-spacing-xs)",
        display: "flex",
        flexBasis: flex ? `${(flex / 12) * 100}%` : "auto",
        flexGrow: flex,
        flexShrink: 0,
        fontFamily:
          "var(--mantine-font-family-body-small, var(--mantine-font-family))",
        fontSize:
          "var(--mantine-font-size-body-small, var(--mantine-font-size-md))",
        fontWeight:
          "var(--mantine-font-weight-body-small, var(--mantine-font-weight-regular))",
        justifyContent: alignment,
        lineHeight:
          "var(--mantine-line-height-body-small, var(--mantine-line-height-md))",
        overflow: "visible",
        paddingInline: "var(--mantine-spacing-sm)",
        position: "relative",
        userSelect: "none",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

/**
 * Flex-based body cell for virtualized/list-like rows that cannot use a real
 * table DOM. Pair this with `SurfaceListHeaderCell` so column proportions stay
 * centralized in the Facade instead of route-local list CSS.
 */
type SurfaceListCellProps = PropsWithChildren<
  Omit<HTMLAttributes<HTMLDivElement>, "hidden"> & {
    alignment?: "start" | "center" | "end";
    flex?: SurfaceListHeaderCellFlex;
    hidden?: boolean;
    hideInCompact?: boolean;
    tone?: "primary" | "secondary" | "tertiary";
    truncate?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>;

export const SurfaceListCell = forwardRef<HTMLDivElement, SurfaceListCellProps>(
  function SurfaceListCell(
    {
      alignment,
      children,
      flex,
      hidden,
      hideInCompact,
      truncate = false,
      style,
      tone = "primary",
      "data-myoxus-ui-role": uiRole = "surface-list-cell",
      ...props
    },
    ref,
  ) {
    const color =
      tone === "tertiary"
        ? cssVar("placeholderColor")
        : tone === "secondary"
          ? cssVar("textSecondaryColor")
          : cssVar("textPrimaryColor");
    return (
      <Box
        {...props}
        ref={ref}
        data-hidden={hidden ? "true" : undefined}
        data-hide-in-compact={hideInCompact ? "true" : undefined}
        data-myoxus-ui-role={uiRole}
        data-surface-list-cell="true"
        role={props.role}
        style={{
          alignItems: "center",
          color,
          display: "flex",
          flexBasis: flex ? `${(flex / 12) * 100}%` : "auto",
          flexGrow: flex,
          flexShrink: 1,
          justifyContent: alignment,
          minWidth: 0,
          overflow: truncate ? "hidden" : undefined,
          paddingInline: "var(--mantine-spacing-sm)",
          textOverflow: truncate ? "ellipsis" : undefined,
          whiteSpace: truncate ? "nowrap" : undefined,
          ...style,
        }}
      >
        {children}
      </Box>
    );
  },
);

export function SurfaceListHeaderSortIcon({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "surface-list-header-sort-icon",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Box
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        color: cssVar("iconColor"),
        display: "inline-flex",
        fontSize:
          "calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export type SurfaceListItemDensity = "card" | "compact" | "default";

export type SurfaceListItemAppearance = "card" | "row";

export type SurfaceListItemLayout = "block" | "column" | "row";

export type SurfaceListItemTone = "default" | "danger" | "success";

const SURFACE_LIST_ITEM_PADDING_BY_DENSITY: Record<
  SurfaceListItemDensity,
  CSSProperties["padding"]
> = {
  card: "var(--mantine-spacing-lg)",
  compact: "var(--mantine-spacing-xs)",
  default: "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
};

export type SurfaceListItemProps = PropsWithChildren<
  HTMLAttributes<HTMLElement> & {
    /**
     * Optional theme-owned tag accents for work items. The Facade normalizes
     * and mixes them deterministically so product code never emits raw color
     * or card-border styles.
     */
    accentTagColorRoles?: readonly TagColorRole[];
    component?: "article" | "div" | "label" | "li" | "section";
    "data-myoxus-ui-role"?: string;
    alignItems?: CSSProperties["alignItems"];
    appearance?: SurfaceListItemAppearance;
    density?: SurfaceListItemDensity;
    fullHeight?: boolean;
    fullWidth?: boolean;
    gap?: CSSProperties["gap"];
    justifyContent?: CSSProperties["justifyContent"];
    layout?: SurfaceListItemLayout;
    interactive?: boolean;
    muted?: boolean;
    selected?: boolean;
    tone?: SurfaceListItemTone;
  }
>;

/**
 * Surface row for non-button list items. Rows that commit an action should use
 * SelectableCardRow so focus and pressed semantics stay explicit.
 */
export const SurfaceListItem = forwardRef<HTMLElement, SurfaceListItemProps>(
  function SurfaceListItem(
    {
      accentTagColorRoles = [],
      children,
      alignItems,
      appearance = "row",
      className,
      component = "article",
      density = "default",
      fullHeight = false,
      fullWidth = false,
      gap,
      interactive = false,
      justifyContent,
      layout = "block",
      muted = false,
      selected = false,
      role,
      style,
      tone = "default",
      "data-myoxus-ui-role": uiRole = "surface-list-item",
      ...props
    },
    ref,
  ) {
    const toneBackground =
      tone === "danger"
        ? cssVar("backgroundErrorColor")
        : tone === "success"
          ? cssVar("backgroundSuccessColor")
          : undefined;
    const toneBorder =
      tone === "danger"
        ? cssVar("errorColor")
        : tone === "success"
          ? cssVar("successColor")
          : undefined;
    const background = selected
      ? `color-mix(in srgb, ${cssVar(
          "backgroundSecondaryColor",
        )} 94%, ${cssVar("primaryColor")} 6%)`
      : toneBackground
        ? toneBackground
        : muted
          ? cssVar("backgroundSecondaryColor")
          : undefined;
    const foreground =
      tone === "danger"
        ? cssVar("errorColor")
        : tone === "success"
          ? cssVar("successColor")
          : muted
            ? cssVar("textSecondaryColor")
            : undefined;
    const accentColor = resolveTagColorAccent(accentTagColorRoles);
    const borderColor =
      appearance === "card" && selected ? cssVar("primaryColor") : toneBorder;

    // Mantine types each polymorphic Card root as one concrete element. The
    // Facade intentionally exposes a small semantic root union, so we keep that
    // polymorphic typing detail contained at the boundary.
    const cardComponent = component as "article";

    return (
      <MantineCard
        {...props}
        component={cardComponent}
        ref={ref as Ref<HTMLElement>}
        withBorder={appearance === "card"}
        radius={appearance === "row" ? "sm" : undefined}
        shadow={appearance === "card" ? "sm" : undefined}
        p={SURFACE_LIST_ITEM_PADDING_BY_DENSITY[density]}
        role={role}
        className={className}
        data-interactive={interactive ? "true" : undefined}
        data-selected={selected ? "true" : undefined}
        data-surface-appearance={appearance}
        data-surface-tone={tone}
        data-myoxus-ui-role={uiRole}
        style={
          {
            alignItems,
            ...(background ? { background } : {}),
            ...(borderColor ? { borderColor } : {}),
            ...(accentColor
              ? {
                  borderInlineStartColor: accentColor,
                  borderInlineStartWidth: "calc(var(--mantine-scale) * 2px)",
                }
              : {}),
            ...(foreground ? { color: foreground } : {}),
            cursor: interactive ? "pointer" : undefined,
            display: layout === "block" ? undefined : "flex",
            // Stack-backed lists may be height-constrained by a scrolling
            // rail. A semantic row must overflow that rail instead of
            // compressing and clipping its own title or metadata.
            flexShrink: 0,
            flexDirection:
              layout === "row"
                ? "row"
                : layout === "column"
                  ? "column"
                  : undefined,
            gap:
              gap ??
              (layout === "block"
                ? undefined
                : density === "compact"
                  ? "var(--mantine-spacing-xs)"
                  : "var(--mantine-spacing-sm)"),
            height: fullHeight ? "100%" : undefined,
            justifyContent,
            overflow: appearance === "card" ? "hidden" : undefined,
            width: fullWidth ? "100%" : undefined,
            ...style,
          } as CSSProperties
        }
      >
        {children}
      </MantineCard>
    );
  },
);

const HORIZONTAL_PANEL_RAIL_ITEM_WIDTH = "calc(var(--mantine-spacing-2xl) * 8)";

/**
 * Horizontally scrollable panel collection for boards and comparable dense
 * work surfaces. Items retain a theme-derived readable width instead of
 * shrinking to fit every panel into a compact viewport.
 */
export function HorizontalPanelRail({
  children,
  "data-myoxus-ui-role": uiRole = "horizontal-panel-rail",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <ScrollArea
      {...props}
      data-myoxus-ui-role={uiRole}
      offsetScrollbars={false}
      scrollbars="x"
      type="auto"
      w="100%"
    >
      <Group align="stretch" gap="md" wrap="nowrap" w="max-content">
        {children}
      </Group>
    </ScrollArea>
  );
}

export function HorizontalPanelRailItem({
  children,
  "data-myoxus-ui-role": uiRole = "horizontal-panel-rail-item",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Box
      {...props}
      data-myoxus-ui-role={uiRole}
      flex="0 0 auto"
      w={HORIZONTAL_PANEL_RAIL_ITEM_WIDTH}
    >
      {children}
    </Box>
  );
}

export function HorizontalPanelRailAction({
  children,
  "data-myoxus-ui-role": uiRole = "horizontal-panel-rail-action",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Box {...props} data-myoxus-ui-role={uiRole} flex="0 0 auto">
      {children}
    </Box>
  );
}

type SurfaceListItemFrameProps = PropsWithChildren<
  HTMLAttributes<HTMLElement> & {
    component?: ElementType;
    href?: string;
    rel?: string;
    target?: string;
    to?: unknown;
    "data-myoxus-ui-role"?: string;
  }
>;

export const SurfaceListItemFrame = forwardRef<
  HTMLElement,
  SurfaceListItemFrameProps
>(function SurfaceListItemFrame(
  {
    children,
    component,
    style,
    "data-myoxus-ui-role": uiRole = "surface-list-item-frame",
    ...props
  },
  ref,
) {
  const Component = component ?? "div";
  const isPolymorphicFrame = Component !== "div";
  return (
    <Box
      {...props}
      component={Component as "div"}
      ref={ref as Ref<HTMLDivElement>}
      c={isPolymorphicFrame ? "inherit" : undefined}
      data-myoxus-ui-role={uiRole}
      display={isPolymorphicFrame ? "block" : undefined}
      h={isPolymorphicFrame ? "100%" : undefined}
      pos="relative"
      w="100%"
      style={{
        textDecoration: isPolymorphicFrame ? "none" : undefined,
        ...style,
      }}
    >
      {children}
    </Box>
  );
});

export function SurfaceListDragHandle({
  children,
  placement = "outside-left-center",
  style,
  "data-myoxus-ui-role": uiRole = "surface-list-drag-handle",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    placement?: "outside-left-center" | "outside-left-top";
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <Box
      {...props}
      data-placement={placement}
      data-myoxus-ui-role={uiRole}
      left={`calc(var(--mantine-spacing-xs) * -1)`}
      pos="absolute"
      top={placement === "outside-left-center" ? "50%" : 0}
      style={{
        pointerEvents: "none",
        transform:
          placement === "outside-left-center"
            ? "translateY(-50%) translateX(-100%)"
            : "translateX(-100%)",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function SurfaceListSelectionSlot({
  active,
  children,
  style,
  "data-myoxus-ui-role": uiRole = "surface-list-selection-slot",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    active?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>) {
  if (!active) {
    return null;
  }

  return (
    <Box
      {...props}
      data-active={active ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      style={style}
    >
      {children}
    </Box>
  );
}

export function SurfaceListItemIcon({
  children,
  size = "lg",
  style,
  tone = "primary",
  "data-myoxus-ui-role": uiRole = "surface-list-item-icon",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    size?: "lg" | "md" | "sm";
    tone?: "danger" | "primary" | "secondary" | "success" | "tertiary";
    "data-myoxus-ui-role"?: string;
  }
>) {
  const iconSize =
    size === "lg"
      ? "var(--mantine-spacing-xl)"
      : size === "md"
        ? "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"
        : "var(--mantine-spacing-lg)";
  return (
    <Box
      {...props}
      data-size={size}
      data-tone={tone}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        color:
          tone === "danger"
            ? cssVar("errorColor")
            : tone === "success"
              ? cssVar("successColor")
              : tone === "secondary"
                ? cssVar("iconSecondary")
                : tone === "tertiary"
                  ? cssVar("placeholderColor")
                  : cssVar("iconColor"),
        display: "flex",
        flexShrink: 0,
        fontSize: iconSize,
        height: iconSize,
        justifyContent: "center",
        lineHeight: 0,
        width: iconSize,
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function SurfaceListItemMain({
  blockSize,
  children,
  compact = false,
  grow = false,
  style,
  "data-myoxus-ui-role": uiRole = "surface-list-item-main",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    blockSize?: CSSProperties["blockSize"];
    compact?: boolean;
    grow?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <Box
      {...props}
      data-compact={compact ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: grow ? "1 1 auto" : undefined,
        flexShrink: 10,
        blockSize,
        height: blockSize ? undefined : "100%",
        justifyContent: "center",
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function SurfaceListSpacer({
  style,
  "data-myoxus-ui-role": uiRole = "surface-list-spacer",
  ...props
}: HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }) {
  return (
    <Box
      {...props}
      aria-hidden
      data-myoxus-ui-role={uiRole}
      style={{
        flex: 1,
        width: 0,
        ...style,
      }}
    />
  );
}

type SurfaceListTextKind = "card-title" | "description" | "preview" | "title";

const surfaceListTextTypography: Record<
  SurfaceListTextKind,
  {
    fallbackSlot?: MyoxusTypographySlot;
    slot: MyoxusTypographySlot;
    tone: MyoxusTextTone;
  }
> = {
  "card-title": {
    fallbackSlot: "body-small",
    slot: "card-title",
    tone: "primary",
  },
  description: {
    fallbackSlot: "body-small",
    slot: "body-small",
    tone: "secondary",
  },
  preview: {
    fallbackSlot: "body-small",
    slot: "body-small",
    tone: "primary",
  },
  title: {
    fallbackSlot: "body-small",
    slot: "nav",
    tone: "primary",
  },
};

export function SurfaceListText({
  children,
  kind = "title",
  style,
  "data-myoxus-ui-role": uiRole = `surface-list-text:${kind}`,
  ...props
}: MyoxusTextProps & {
  kind?: SurfaceListTextKind;
}) {
  const typography = surfaceListTextTypography[kind];
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "div"}
      fallbackSlot={props.fallbackSlot ?? typography.fallbackSlot}
      tone={props.tone ?? typography.tone}
      truncate={props.truncate ?? true}
      typographySlot={props.typographySlot ?? typography.slot}
      data-myoxus-ui-role={uiRole}
      style={{
        minHeight:
          kind === "preview"
            ? "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"
            : undefined,
        minWidth: 0,
        width: kind === "card-title" ? 0 : "100%",
        flexGrow: kind === "card-title" || kind === "preview" ? 1 : undefined,
        flexShrink: kind === "card-title" || kind === "preview" ? 1 : undefined,
        ...style,
      }}
    >
      {children}
    </MyoxusText>
  );
}

export function SurfaceListCardHeader({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "surface-list-card-header",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Group
      {...props}
      align="center"
      justify="space-between"
      gap={"var(--mantine-spacing-sm)"}
      wrap="nowrap"
      data-myoxus-ui-role={uiRole}
      style={style}
    >
      {children}
    </Group>
  );
}

type SurfaceListMetaLayout = "card" | "inline" | "row-cluster" | "row-group";

export function SurfaceListMeta({
  children,
  layout = "inline",
  style,
  "data-myoxus-ui-role": uiRole = `surface-list-meta:${layout}`,
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    layout?: SurfaceListMetaLayout;
    "data-myoxus-ui-role"?: string;
  }
>) {
  const layoutStyle: Record<SurfaceListMetaLayout, CSSProperties> = {
    card: {
      display: "flex",
      flexWrap: "wrap",
      gap: "var(--mantine-spacing-sm)",
    },
    inline: {
      display: "flex",
      flexShrink: 0,
      minWidth: 0,
    },
    "row-cluster": {
      display: "flex",
      flexShrink: 1.5,
      gap: "var(--mantine-spacing-sm)",
      justifyContent: "flex-end",
      minWidth: 0,
    },
    "row-group": {
      display: "flex",
      flexGrow: 1,
      flexShrink: 5,
      gap: "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
      justifyContent: "flex-end",
      minWidth: 0,
    },
  };
  return (
    <Box
      {...props}
      data-layout={layout}
      data-myoxus-ui-role={uiRole}
      style={{
        ...layoutStyle[layout],
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

type SurfaceListActionSharedProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /**
   * Shared media preview geometry for compact clickable thumbnails and file
   * tiles. Product code supplies content and events only; the Facade owns the
   * token-backed size, clipping and overlay positioning that make previews
   * readable without rebuilding route-local CSS.
   */
  mediaPreview?: "image" | "file";
  selected?: boolean;
  surface?: boolean;
  "data-myoxus-ui-role"?: string;
};

export type SurfaceListActionProps =
  | (SurfaceListActionSharedProps & {
      component?: undefined;
      overlayAction?: never;
    })
  | (SurfaceListActionSharedProps & {
      component: "div";
      /**
       * Secondary action slot for composite preview tiles. Use it with
       * `component="div"` so interactive overlay controls never become nested
       * buttons.
       */
      overlayAction?: ReactNode;
    });

/**
 * Primary action surface for complex list rows. The default keeps button
 * semantics; pass `component="div"` with `role="button"` for composite tiles
 * that contain their own secondary buttons, because nested button markup is
 * invalid.
 */
export function SurfaceListAction({
  children,
  className,
  component,
  mediaPreview,
  overlayAction,
  selected = false,
  surface = false,
  style,
  "data-myoxus-ui-role": uiRole = "button:surface-list-action",
  ...props
}: SurfaceListActionProps) {
  const { disabled, ...domProps } = props;
  const actionStyle: CSSProperties = {
    alignItems: "center",
    background: surface ? cssVar("backgroundSecondaryColor") : undefined,
    border: surface
      ? `calc(var(--mantine-scale) * 1px) solid ${cssVar("borderColor")}`
      : undefined,
    borderRadius: "var(--mantine-radius-md)",
    color: cssVar("textPrimaryColor"),
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    flex: mediaPreview ? "0 0 auto" : "1 1 auto",
    gap: "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
    height: mediaPreview ? "62px" : undefined,
    minWidth: 0,
    overflow: mediaPreview ? "hidden" : undefined,
    padding: mediaPreview ? 0 : undefined,
    position: mediaPreview || overlayAction ? "relative" : undefined,
    textAlign: "start",
    width:
      mediaPreview === "image"
        ? "62px"
        : mediaPreview === "file"
          ? "194px"
          : undefined,
    ...style,
  };
  const content = (
    <>
      {children}
      {overlayAction ? (
        <Box
          data-myoxus-ui-role="surface-list-action-overlay-action"
          style={{
            position: "absolute",
            right: "-6px",
            top: "-6px",
          }}
        >
          {overlayAction}
        </Box>
      ) : null}
    </>
  );

  if (component === "div") {
    return (
      <Box
        {...(domProps as HTMLAttributes<HTMLDivElement>)}
        aria-disabled={disabled ? "true" : undefined}
        className={className}
        component="div"
        data-selected={selected ? "true" : undefined}
        data-myoxus-ui-role={uiRole}
        style={actionStyle}
      >
        {content}
      </Box>
    );
  }

  return (
    <MantineUnstyledButton
      {...domProps}
      className={className}
      disabled={disabled}
      data-selected={selected ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      style={actionStyle}
    >
      {content}
    </MantineUnstyledButton>
  );
}

export function SuggestionList({
  children,
  "data-testid": dataTestId,
}: PropsWithChildren<{
  "data-testid"?: string;
}>) {
  // Suggestions are a normal themed surface. They intentionally do not own
  // absolute positioning; callers can render them inline or inside Popover/Menu
  // without rebuilding background, border, typography or scroll styling.
  return (
    <Box
      component="ul"
      data-testid={dataTestId}
      style={{
        display: "grid",
        gap: "var(--mantine-spacing-2xs)",
        maxHeight: "16rem",
        background: cssVar("backgroundPrimaryColor"),
        borderColor: cssVar("borderColor"),
        borderStyle: "solid",
        borderWidth: "calc(var(--mantine-scale) * 1px)",
        borderRadius: "var(--mantine-radius-md)",
        color: cssVar("textPrimaryColor"),
        margin: 0,
        marginBlockStart: "var(--mantine-spacing-2xs)",
        overflow: "auto",
        padding: "var(--mantine-spacing-2xs)",
        listStyle: "none",
      }}
      data-myoxus-ui-role="suggestion-list"
    >
      {children}
    </Box>
  );
}

export function SuggestionListItemButton({
  children,
  onMouseDown,
  "data-testid": dataTestId,
}: PropsWithChildren<{
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
  "data-testid"?: string;
}>) {
  return (
    <Box component="li" data-myoxus-ui-role="suggestion-list-item">
      <MantineUnstyledButton
        type="button"
        data-testid={dataTestId}
        onMouseDown={onMouseDown}
        style={{
          width: "100%",
          borderRadius: "var(--mantine-radius-sm)",
          color: cssVar("textPrimaryColor"),
          paddingBlock: "var(--mantine-spacing-xs)",
          paddingInline:
            "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
          textAlign: "left",
        }}
        data-myoxus-ui-role="suggestion-list-button"
      >
        {children}
      </MantineUnstyledButton>
    </Box>
  );
}
