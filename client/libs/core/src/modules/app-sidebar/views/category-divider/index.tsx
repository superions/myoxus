import { SidebarSectionHeader } from "@myoxus/ui-facade";
import { type ForwardedRef, forwardRef, type PropsWithChildren } from "react";

export type CategoryDividerProps = PropsWithChildren<
  {
    label: string;
    className?: string;
    collapsed?: boolean;
    setCollapsed?: (collapsed: boolean) => void;
  } & {
    [key: `data-${string}`]: unknown;
  }
>;

export const CategoryDivider = forwardRef(
  (
    {
      label,
      children,
      className,
      collapsed,
      setCollapsed,
      ...otherProps
    }: CategoryDividerProps,
    ref: ForwardedRef<HTMLElement>,
  ) => {
    const collapsible = collapsed !== undefined;
    const { "data-myoxus-ui-role": explicitUiRole, ...domProps } = otherProps;
    const uiRole =
      typeof explicitUiRole === "string"
        ? explicitUiRole
        : collapsible
          ? "button:sidebar-section-header"
          : "sidebar-section-header";
    return (
      <SidebarSectionHeader
        className={className}
        ref={ref}
        collapsed={collapsed}
        label={label}
        onCollapsedChange={setCollapsed}
        {...domProps}
        data-collapsible={collapsible ? "true" : undefined}
        data-myoxus-ui-role={uiRole}
        actions={children}
      />
    );
  },
);

CategoryDivider.displayName = "CategoryDivider";
