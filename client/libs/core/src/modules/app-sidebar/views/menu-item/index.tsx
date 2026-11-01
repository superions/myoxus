import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { SidebarNavItem, SidebarSectionHeader } from "@myoxus/ui-facade";
import React, { type SVGAttributes } from "react";
import type { To } from "react-router";

export interface MenuItemProps extends React.HTMLAttributes<HTMLElement> {
  icon?: React.ReactElement<SVGAttributes<SVGElement>>;
  active?: boolean;
  actionsInteractive?: boolean;
  component?: React.ElementType;
  disabled?: boolean;
  href?: string;
  // true, false, undefined. undefined means no collapse
  collapsed?: boolean;
  // if onCollapsedChange is given, but collapsed is undefined, then we will render the collapse button as disabled
  onCollapsedChange?: (collapsed: boolean) => void;
  childrenOffset?: number | string;
  defaultOpened?: boolean;
  nestedChildren?: React.ReactNode;
  opened?: boolean;
  onOpenedChange?: (opened: boolean) => void;
  postfix?: React.ReactElement;
  tone?: "default" | "danger";
  to?: To;
  type?: React.ButtonHTMLAttributes<HTMLButtonElement>["type"];
  [key: `data-${string}`]: unknown;
}

export interface MenuLinkItemProps extends MenuItemProps {
  to: To;
  linkComponent?: React.ElementType;
}

/**
 * This component is not a generic component.
 * It is used for the app sidebar.
 */
export const MenuItem = React.forwardRef<HTMLElement, MenuItemProps>(
  (
    {
      onClick,
      icon,
      active,
      actionsInteractive,
      children,
      disabled,
      collapsed,
      onCollapsedChange,
      postfix,
      ...props
    },
    ref,
  ) => {
    const collapsible = onCollapsedChange !== undefined;
    const {
      className,
      "data-myoxus-ui-role": explicitUiRole,
      ...domProps
    } = props;
    const uiRole =
      typeof explicitUiRole === "string"
        ? explicitUiRole
        : collapsible
          ? "sidebar-section-row"
          : "sidebar-row";
    if (collapsible) {
      return (
        <SidebarSectionHeader
          ref={ref}
          {...domProps}
          active={active}
          actions={postfix}
          actionsInteractive={actionsInteractive}
          className={className}
          collapsed={collapsed}
          data-collapsible="true"
          data-myoxus-ui-role={uiRole}
          disabled={disabled}
          label={children}
          leading={icon}
          onCollapsedChange={onCollapsedChange}
          onClick={onClick}
        />
      );
    }

    return (
      <SidebarNavItem
        ref={ref}
        {...domProps}
        onClick={onClick}
        className={className}
        active={active}
        disabled={disabled}
        data-collapsible={collapsible}
        data-myoxus-ui-role={uiRole}
        icon={icon}
        actions={postfix}
        actionsInteractive={actionsInteractive}
      >
        {children}
      </SidebarNavItem>
    );
  },
);
MenuItem.displayName = "MenuItem";

export const MenuLinkItem = React.forwardRef<HTMLElement, MenuLinkItemProps>(
  ({ to, linkComponent: LinkComponent = WorkbenchLink, ...props }, ref) => {
    return (
      <MenuItem
        ref={ref}
        {...props}
        component={LinkComponent}
        to={to}
      ></MenuItem>
    );
  },
);
MenuLinkItem.displayName = "MenuLinkItem";
