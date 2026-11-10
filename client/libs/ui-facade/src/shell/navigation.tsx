// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type HTMLAttributes,
  type ElementType,
  type MouseEventHandler,
  type CSSProperties,
  type ReactNode,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  forwardRef,
  type Ref,
  type ForwardedRef,
} from "react";
import { type MyoxusUiRoleProp } from "../helpers/ui-role";
import {
  Box,
  ActionIcon,
  Tooltip as MantineTooltip,
  UnstyledButton as MantineUnstyledButton,
  NavLink as MantineNavLink,
} from "@mantine/core";
import { cssVar, cssTypographyVar } from "@myoxus/theme";
import { renderSizedIconElement } from "../button";
import { useResponsiveSmQuery } from "../responsive";

type BreadcrumbBarProps = PropsWithChildren<
  HTMLAttributes<HTMLElement> &
    MyoxusUiRoleProp & {
      label?: string;
    }
>;

type BreadcrumbItemProps = PropsWithChildren<
  MyoxusUiRoleProp & {
    active?: boolean;
    className?: string;
    component?: ElementType;
    href?: string;
    onClick?: MouseEventHandler<HTMLElement>;
    style?: CSSProperties;
    title?: string;
    to?: string;
    [key: `aria-${string}`]: unknown;
    [key: `data-${string}`]: unknown;
  }
>;

type BreadcrumbSeparatorProps = PropsWithChildren<
  HTMLAttributes<HTMLSpanElement> & MyoxusUiRoleProp
>;

export function BreadcrumbBar({
  children,
  label = "Breadcrumb",
  style,
  "data-myoxus-ui-role": uiRole = "breadcrumb-bar",
  ...props
}: BreadcrumbBarProps) {
  return (
    <Box
      {...props}
      aria-label={props["aria-label"] ?? label}
      component="nav"
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        color: cssVar("textSecondaryColor"),
        display: "flex",
        gap: "var(--mantine-spacing-xs)",
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function BreadcrumbItem({
  active = false,
  children,
  className,
  component,
  style,
  "data-myoxus-ui-role": uiRole = "breadcrumb-item",
  ...props
}: BreadcrumbItemProps) {
  const Component = component ?? "span";
  return (
    <Component
      {...props}
      className={className}
      data-active={active ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        color: active ? cssVar("textPrimaryColor") : "inherit",
        cursor: active ? "default" : "pointer",
        display: "inline-flex",
        gap: "var(--mantine-spacing-2xs)",
        minWidth: 0,
        textDecoration: "none",
        ...style,
      }}
    >
      {children}
    </Component>
  );
}

export function BreadcrumbSeparator({
  children = "/",
  style,
  "aria-hidden": ariaHidden = true,
  "data-myoxus-ui-role": uiRole = "breadcrumb-separator",
  ...props
}: BreadcrumbSeparatorProps) {
  return (
    <Box
      {...props}
      aria-hidden={ariaHidden}
      component="span"
      data-myoxus-ui-role={uiRole}
      style={{
        color: cssVar("textSecondaryColor"),
        flex: "0 0 auto",
        marginInline: "var(--mantine-spacing-xs)",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function InlineLink({
  href,
  children,
  download,
  prefix,
  target,
  rel,
  onClick,
  "data-testid": dataTestId,
}: PropsWithChildren<{
  href: string;
  download?: string | boolean;
  prefix?: ReactNode;
  target?: string;
  rel?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  "data-testid"?: string;
}>) {
  return (
    <Box
      component="a"
      href={href}
      download={download}
      target={target}
      rel={rel}
      onClick={onClick}
      data-testid={dataTestId}
      data-myoxus-ui-role="settings-inline-link"
      style={{
        alignItems: "center",
        color: cssVar("linkColor"),
        display: "inline-flex",
        gap: "var(--mantine-spacing-xs)",
        textDecoration: cssTypographyVar("link", "decoration", "none"),
      }}
    >
      {prefix}
      {children}
    </Box>
  );
}

export type IconLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "children" | "className" | "style"
> & {
  "aria-label": string;
  icon: ReactNode;
  tooltip?: ReactNode;
};

/**
 * Native anchor semantics with Mantine ActionIcon chrome. Use this for compact
 * open/download actions; product code must not emulate an icon link with a
 * button click handler or route-local sizing.
 */
export function IconLink({
  "aria-label": ariaLabel,
  icon,
  tooltip,
  ...props
}: IconLinkProps) {
  const link = (
    <ActionIcon
      {...props}
      component="a"
      aria-label={ariaLabel}
      variant="subtle"
      size={
        "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))"
      }
      data-myoxus-ui-role="link:icon-only"
    >
      {renderSizedIconElement(icon, {
        size: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      })}
    </ActionIcon>
  );
  if (!tooltip) return link;
  return <MantineTooltip label={tooltip}>{link}</MantineTooltip>;
}

export function InlineActionButton({
  children,
  className,
  style,
  type = "button",
  appearance = "link",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Inline controls embedded in authored text must inherit its presentation. */
  appearance?: "link" | "text";
}) {
  return (
    <MantineUnstyledButton
      {...props}
      component="button"
      type={type}
      className={className}
      data-myoxus-ui-role="settings-inline-action"
      style={{
        color: appearance === "text" ? "inherit" : cssVar("linkColor"),
        cursor: "pointer",
        display: "inline",
        fontSize: "inherit",
        padding: 0,
        textDecoration:
          appearance === "text"
            ? "inherit"
            : cssTypographyVar("link", "decoration", "none"),
        ...style,
      }}
    >
      {children}
    </MantineUnstyledButton>
  );
}

export type InlineDocumentReferenceLinkProps = PropsWithChildren<
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "style"> & {
    component?: ElementType;
    deleted?: boolean;
    to?: unknown;
    "data-myoxus-ui-role"?: string;
  }
>;

export const InlineDocumentReferenceLink = forwardRef<
  HTMLElement,
  InlineDocumentReferenceLinkProps
>(function InlineDocumentReferenceLink(
  {
    children,
    component,
    deleted = false,
    "data-myoxus-ui-role": uiRole = "inline-document-reference-link",
    ...props
  },
  ref,
) {
  const Component = component ?? "a";

  return (
    <Box
      {...props}
      ref={ref as Ref<HTMLAnchorElement>}
      component={Component as "a"}
      data-deleted={deleted ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      style={{
        color: deleted ? cssVar("textSecondaryColor") : "inherit",
        hyphens: "auto",
        overflowWrap: "anywhere",
        textDecoration: deleted
          ? "line-through"
          : cssTypographyVar("link", "decoration", "none"),
        wordBreak: "break-word",
      }}
    >
      {children}
    </Box>
  );
});

export function InlineDocumentReferenceContent({
  children,
  deleted = false,
  "data-myoxus-ui-role": uiRole = "inline-document-reference-content",
}: PropsWithChildren<{
  deleted?: boolean;
  "data-myoxus-ui-role"?: string;
}>) {
  return (
    <Box
      component="span"
      data-deleted={deleted ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      style={{
        color: deleted ? cssVar("textSecondaryColor") : "inherit",
        textDecoration: deleted ? "line-through" : undefined,
      }}
    >
      {children}
    </Box>
  );
}

export function InlineDocumentReferenceIcon({
  children,
  "data-myoxus-ui-role": uiRole = "inline-document-reference-icon",
}: PropsWithChildren<{
  "data-myoxus-ui-role"?: string;
}>) {
  return (
    <Box
      component="span"
      data-myoxus-ui-role={uiRole}
      style={{
        color: cssVar("iconColor"),
        display: "inline-flex",
        lineHeight: "1",
        marginInlineEnd: "var(--mantine-spacing-2xs)",
        verticalAlign: "text-bottom",
      }}
    >
      {children}
    </Box>
  );
}

export function InlineDocumentReferenceTitle({
  children,
  "data-myoxus-ui-role": uiRole = "inline-document-reference-title",
}: PropsWithChildren<{
  "data-myoxus-ui-role"?: string;
}>) {
  // The class name is consumed by the editor reference node contract; visual
  // chrome stays in the facade role above, not in product-local CSS.
  return (
    <Box
      component="span"
      className="myoxus-reference-title"
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
}

export type MyoxusNavigationLinkProps = Omit<
  HTMLAttributes<HTMLElement>,
  "children" | "onChange" | "style"
> & {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  leftSection?: ReactNode;
  rightSection?: ReactNode;
  childrenOffset?: number | string;
  defaultOpened?: boolean;
  disableRightSectionRotation?: boolean;
  opened?: boolean;
  onOpenedChange?: (opened: boolean) => void;
  collapsed?: boolean | "narrow";
  active?: boolean;
  disabled?: boolean;
  tone?: "default" | "danger";
  /**
   * Semantic navigation role. Row layout, hover and active state remain native
   * Mantine NavLink behavior; do not add Facade CSS classes for those states.
   */
  variant?: "default" | "sidebar";
  component?: ElementType;
  to?: unknown;
  href?: string;
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
  rel?: AnchorHTMLAttributes<HTMLAnchorElement>["rel"];
  style?: CSSProperties;
  type?: ButtonHTMLAttributes<HTMLButtonElement>["type"];
  "data-myoxus-ui-role"?: string;
};

const SIDEBAR_NAV_BLOCK_PADDING =
  "calc(var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))";

export const SIDEBAR_NAV_ICON_SIZE =
  "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-2xs))";

export const SIDEBAR_TREE_ICON_SIZE = "var(--mantine-spacing-lg)";

export const SIDEBAR_SECTION_MIN_HEIGHT =
  "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-sm))";

export const NavigationLink = forwardRef<
  HTMLElement,
  MyoxusNavigationLinkProps
>(function NavigationLink(
  {
    label,
    description,
    children,
    leftSection,
    rightSection,
    childrenOffset,
    defaultOpened,
    disableRightSectionRotation,
    collapsed = false,
    active,
    disabled,
    opened,
    tone = "default",
    variant = "default",
    className,
    onClick,
    onOpenedChange,
    "data-myoxus-ui-role": uiRole = "navigation-link",
    ...props
  }: MyoxusNavigationLinkProps,
  ref,
) {
  const narrowViewport = useResponsiveSmQuery();
  const resolvedCollapsed = collapsed === "narrow" ? narrowViewport : collapsed;

  return (
    <MantineNavLink
      {...(props as Record<string, unknown>)}
      ref={ref as ForwardedRef<HTMLAnchorElement>}
      active={active}
      disabled={disabled}
      className={className}
      childrenOffset={childrenOffset}
      defaultOpened={defaultOpened}
      disableRightSectionRotation={disableRightSectionRotation}
      color={tone === "danger" ? "myoxusError" : "myoxus"}
      label={resolvedCollapsed ? undefined : label}
      description={resolvedCollapsed ? undefined : description}
      leftSection={leftSection}
      rightSection={rightSection}
      aria-label={resolvedCollapsed ? String(label) : props["aria-label"]}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : props.tabIndex}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick?.(event);
      }}
      data-myoxus-ui-role={uiRole}
      data-myoxus-ui-tone={tone === "default" ? undefined : tone}
      data-myoxus-ui-variant={variant}
      data-myoxus-ui-collapsed={resolvedCollapsed ? "true" : undefined}
      maw={variant === "sidebar" ? "100%" : undefined}
      miw={variant === "sidebar" ? 0 : undefined}
      opened={opened}
      onChange={onOpenedChange}
      py={
        variant === "sidebar"
          ? { base: "sm", sm: SIDEBAR_NAV_BLOCK_PADDING }
          : undefined
      }
      w={variant === "sidebar" ? "100%" : undefined}
    >
      {resolvedCollapsed ? null : children}
    </MantineNavLink>
  );
});
