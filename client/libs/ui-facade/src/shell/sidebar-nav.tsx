// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type MyoxusNavigationLinkProps,
  NavigationLink,
  SIDEBAR_NAV_ICON_SIZE,
} from "./navigation";
import {
  type ReactNode,
  type ElementType,
  type ButtonHTMLAttributes,
  forwardRef,
  Children,
  useState,
  useCallback,
  type ForwardedRef,
  type PropsWithChildren,
  type MouseEventHandler,
  type HTMLAttributes,
} from "react";
import { renderSizedIconElement } from "../button";
import {
  Collapse as MantineCollapse,
  Box,
  Group,
  Stack,
  Divider as MantineDivider,
} from "@mantine/core";
import { ChevronRightIcon, ChevronDownIcon } from "@myoxus/icons/react";
import { joinClassName } from "../helpers/class-name";
import { STRUCTURE_TREE_CLASS_NAMES } from "../structure-tree-contract";
import { MyoxusText } from "../typography";

export type SidebarNavItemProps = Omit<
  MyoxusNavigationLinkProps,
  "children" | "label" | "leftSection" | "rightSection" | "variant"
> & {
  active?: boolean;
  actions?: ReactNode;
  actionsInteractive?: boolean;
  children?: ReactNode;
  nestedChildren?: ReactNode;
  component?: ElementType;
  disabled?: boolean;
  icon?: ReactNode;
  label?: ReactNode;
  leading?: ReactNode;
  type?: ButtonHTMLAttributes<HTMLButtonElement>["type"];
  "data-collapsible"?: boolean | string;
  "data-myoxus-ui-role"?: string;
};

export const SidebarNavItem = forwardRef<HTMLElement, SidebarNavItemProps>(
  function SidebarNavItem(
    {
      active,
      actions,
      actionsInteractive = false,
      children,
      childrenOffset,
      component,
      defaultOpened,
      className,
      disabled,
      icon,
      label,
      leading,
      nestedChildren,
      opened,
      onClick,
      onOpenedChange,
      style,
      "data-collapsible": dataCollapsible,
      "data-myoxus-ui-role": uiRole = "sidebar-row",
      ...props
    },
    ref,
  ) {
    const hasRouteTarget = props.to !== undefined || props.href !== undefined;
    const rootComponent = component ?? (hasRouteTarget ? undefined : "button");
    const hasNestedChildren = Children.count(nestedChildren) > 0;
    // Mantine NavLink treats `children` as an expandable-only subtree and calls
    // preventDefault() on row clicks. Keep routed parent rows as real links and
    // render their nested sidebar rows in a separate Mantine Collapse instead.
    const routeOwnsPrimaryClick = hasRouteTarget && hasNestedChildren;
    const [internalOpened, setInternalOpened] = useState(
      defaultOpened ?? false,
    );
    const nestedOpened = opened ?? internalOpened;
    const handleOpenedChange = useCallback(
      (nextOpened: boolean) => {
        setInternalOpened(nextOpened);
        onOpenedChange?.(nextOpened);
      },
      [onOpenedChange],
    );
    const nestedDisclosure =
      hasNestedChildren && !actions ? (
        <SidebarDisclosureIcon collapsed={!nestedOpened} />
      ) : null;
    const baseLink = (
      <NavigationLink
        {...(props as Omit<MyoxusNavigationLinkProps, "label">)}
        ref={ref as ForwardedRef<HTMLElement>}
        active={active}
        className={actionsInteractive ? undefined : className}
        component={rootComponent}
        data-collapsible={dataCollapsible}
        data-disabled={disabled ? "true" : undefined}
        data-myoxus-ui-role={uiRole}
        disabled={disabled}
        label={label ?? children}
        leftSection={renderSizedIconElement(leading ?? icon, {
          forceSize: true,
          size: SIDEBAR_NAV_ICON_SIZE,
        })}
        childrenOffset={childrenOffset}
        defaultOpened={defaultOpened}
        disableRightSectionRotation={hasNestedChildren}
        opened={routeOwnsPrimaryClick ? undefined : opened}
        onOpenedChange={routeOwnsPrimaryClick ? undefined : handleOpenedChange}
        onClick={disabled ? undefined : onClick}
        rightSection={
          actionsInteractive ? undefined : (actions ?? nestedDisclosure)
        }
        style={actionsInteractive ? undefined : style}
        type={
          rootComponent === "button" ? (props.type ?? "button") : props.type
        }
        variant="sidebar"
      >
        {routeOwnsPrimaryClick ? undefined : nestedChildren}
      </NavigationLink>
    );
    const routedNestedChildren = routeOwnsPrimaryClick ? (
      <MantineCollapse expanded={nestedOpened} keepMounted>
        <Box ps={childrenOffset ?? "lg"}>{nestedChildren}</Box>
      </MantineCollapse>
    ) : null;

    if (actionsInteractive && actions) {
      return (
        <>
          <Group
            className={className}
            data-myoxus-ui-role="sidebar-nav-item-composite"
            gap="xs"
            wrap="nowrap"
            style={style}
          >
            {baseLink}
            <Box
              component="span"
              data-myoxus-ui-role="navigation-link-right-section"
              onClick={(event) => event.stopPropagation()}
            >
              {actions}
            </Box>
          </Group>
          {routedNestedChildren}
        </>
      );
    }

    if (routedNestedChildren) {
      return (
        <>
          {baseLink}
          {routedNestedChildren}
        </>
      );
    }

    return baseLink;
  },
);

function SidebarDisclosureIcon({ collapsed }: { collapsed: boolean }) {
  return renderSizedIconElement(
    collapsed ? (
      <ChevronRightIcon
        aria-hidden="true"
        data-collapsed="true"
        data-myoxus-ui-role="sidebar-section-disclosure"
      />
    ) : (
      <ChevronDownIcon
        aria-hidden="true"
        data-myoxus-ui-role="sidebar-section-disclosure"
      />
    ),
    {
      forceSize: true,
      size: "var(--mantine-spacing-lg)",
    },
  );
}

export type SidebarSectionHeaderProps = Omit<
  SidebarNavItemProps,
  "actions" | "children" | "icon"
> &
  PropsWithChildren<{
    actions?: ReactNode;
    collapsed?: boolean;
    collapseLabel?: string;
    disclosurePlacement?: "end" | "start";
    disclosureVisible?: boolean;
    dropTarget?: boolean;
    expandLabel?: string;
    label: ReactNode;
    meta?: ReactNode;
    onCollapsedChange?: (collapsed: boolean) => void;
  }>;

export const SidebarSectionHeader = forwardRef<
  HTMLElement,
  SidebarSectionHeaderProps
>(function SidebarSectionHeader(
  {
    actions,
    collapsed,
    collapseLabel,
    className,
    disclosurePlacement = "end",
    disclosureVisible = true,
    dropTarget = false,
    expandLabel,
    label,
    meta,
    onClick,
    onCollapsedChange,
    ...props
  },
  ref,
) {
  const collapsible = collapsed !== undefined;
  const handleClick: MouseEventHandler<HTMLElement> = (event) => {
    onClick?.(event);
    if (!event.defaultPrevented && collapsible) {
      onCollapsedChange?.(!collapsed);
    }
  };

  const disclosureIcon =
    collapsible && disclosureVisible ? (
      <SidebarDisclosureIcon collapsed={Boolean(collapsed)} />
    ) : null;

  return (
    <SidebarNavItem
      {...props}
      ref={ref}
      actions={actions}
      actionsInteractive={Boolean(actions)}
      aria-expanded={collapsible ? !collapsed : undefined}
      aria-label={
        collapsible && (collapseLabel || expandLabel)
          ? collapsed
            ? expandLabel
            : collapseLabel
          : undefined
      }
      className={joinClassName(
        dropTarget ? STRUCTURE_TREE_CLASS_NAMES.dropTarget : undefined,
        className,
      )}
      data-collapsed={collapsed ? "true" : undefined}
      data-myoxus-ui-role={
        props["data-myoxus-ui-role"] ??
        (collapsible
          ? "button:sidebar-section-header"
          : "sidebar-section-header")
      }
      component={collapsible ? "button" : props.component}
      label={
        <>
          {disclosurePlacement === "start" ? disclosureIcon : null}
          <MyoxusText
            component="span"
            minWidth={0}
            truncate
            typographySlot="nav"
            data-myoxus-ui-role="sidebar-section-title"
          >
            {label}
          </MyoxusText>
          {meta ? (
            <Box component="span" data-myoxus-ui-role="sidebar-section-meta">
              {meta}
            </Box>
          ) : null}
          {disclosurePlacement === "end" ? disclosureIcon : null}
        </>
      }
      onClick={collapsible ? handleClick : onClick}
    />
  );
});

export type SidebarSectionContentProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    gap?: "compact" | "default" | "none";
    inset?: "none" | "panel";
    "data-myoxus-ui-role"?: string;
  }
>;

export function SidebarSectionContent({
  children,
  gap = "compact",
  inset = "panel",
  style,
  "data-myoxus-ui-role": uiRole = "sidebar-section-content",
  ...props
}: SidebarSectionContentProps) {
  // Shared sidebar bodies keep route slices from re-creating panel rhythm after
  // their headers move to Mantine NavLink.
  const gapValue = gap === "none" ? 0 : gap === "compact" ? "xs" : "md";

  return (
    <Stack
      {...props}
      gap={gapValue}
      pb={inset === "panel" ? "xs" : undefined}
      px={inset === "panel" ? "md" : undefined}
      style={style}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Stack>
  );
}

export function SidebarNavRoot({
  children,
  collapsed = false,
}: PropsWithChildren<{ collapsed?: boolean }>) {
  return (
    <Stack
      flex="1 1 auto"
      gap={"var(--mantine-spacing-xs)"}
      h="100%"
      justify="space-between"
      maw="100%"
      mih={0}
      miw={0}
      pb={"var(--mantine-spacing-sm)"}
      w="100%"
      style={{
        overflow: collapsed ? "visible" : undefined,
      }}
      data-myoxus-ui-role="sidebar-nav-root"
      data-collapsed={collapsed || undefined}
    >
      {children}
    </Stack>
  );
}

export function SidebarNavList({
  children,
  collapsed = false,
}: PropsWithChildren<{ collapsed?: boolean }>) {
  return (
    <Stack
      component="nav"
      flex="1 1 auto"
      gap={"var(--mantine-spacing-xs)"}
      align={collapsed ? "center" : "stretch"}
      maw="100%"
      mih={0}
      miw={0}
      w="100%"
      style={{
        overflowX: collapsed ? "visible" : "hidden",
        overflowY: collapsed ? "visible" : "auto",
        paddingInline: collapsed
          ? 0
          : "calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))",
      }}
      data-myoxus-ui-role="sidebar-nav-list"
      data-collapsed={collapsed || undefined}
    >
      {children}
    </Stack>
  );
}

export function SidebarNavSection({
  children,
  collapsed = false,
  style,
  "data-myoxus-ui-role": uiRole = "sidebar-nav-section",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    collapsed?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <Stack
      {...props}
      gap={0}
      align={collapsed ? "center" : "stretch"}
      style={{ width: "100%", ...style }}
      data-myoxus-ui-role={uiRole}
      data-collapsed={collapsed || undefined}
    >
      {children}
    </Stack>
  );
}

export function SidebarNavSectionDivider({
  collapsed = false,
  ...props
}: {
  collapsed?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <MantineDivider
      {...props}
      aria-hidden
      orientation="horizontal"
      style={{
        width: collapsed ? "2rem" : "100%",
      }}
      data-myoxus-ui-role="sidebar-nav-section-divider"
    />
  );
}

export function SidebarNavSectionLabel({ children }: PropsWithChildren) {
  return (
    <MyoxusText
      component="div"
      tone="secondary"
      typographySlot="body-small"
      data-myoxus-ui-role="sidebar-nav-section-label"
    >
      {children}
    </MyoxusText>
  );
}

export function SidebarNavSectionHeading({
  action,
  children,
}: PropsWithChildren<{ action?: ReactNode }>) {
  return (
    <Group
      align="center"
      justify="space-between"
      wrap="nowrap"
      data-myoxus-ui-role="sidebar-nav-section-heading"
    >
      <MyoxusText component="span" tone="secondary" typographySlot="body-small">
        {children}
      </MyoxusText>
      {action}
    </Group>
  );
}

function SidebarNavFixedRegion({
  children,
  collapsed = false,
  role,
}: PropsWithChildren<{ collapsed?: boolean; role: string }>) {
  return (
    <Stack
      flex="0 0 auto"
      gap={
        collapsed ? "var(--mantine-spacing-2xs)" : "var(--mantine-spacing-xs)"
      }
      align={collapsed ? "center" : "stretch"}
      style={{
        overflow: "hidden",
        paddingInline: collapsed
          ? 0
          : "calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))",
      }}
      data-myoxus-ui-role={role}
      data-collapsed={collapsed || undefined}
    >
      {children}
    </Stack>
  );
}

/** Keeps essential workspace navigation outside the independently scrolling list. */
export function SidebarNavPinned({
  children,
  collapsed = false,
}: PropsWithChildren<{ collapsed?: boolean }>) {
  return (
    <SidebarNavFixedRegion collapsed={collapsed} role="sidebar-nav-pinned">
      {children}
    </SidebarNavFixedRegion>
  );
}

export function SidebarNavFooter({
  children,
  collapsed = false,
}: PropsWithChildren<{ collapsed?: boolean }>) {
  return (
    <SidebarNavFixedRegion collapsed={collapsed} role="sidebar-nav-footer">
      {children}
    </SidebarNavFixedRegion>
  );
}
