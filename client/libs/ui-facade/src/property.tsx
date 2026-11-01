// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  createContext,
  forwardRef,
  type PropsWithChildren,
  type ReactNode,
  type HTMLAttributes,
  type Ref,
  useState,
  useCallback,
  useMemo,
  useContext,
  useLayoutEffect,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Stack,
  Group,
  Box,
  UnstyledButton as MantineUnstyledButton,
} from "@mantine/core";
import { Button } from "./button";
import { DisclosureTriangleIcon } from "@myoxus/icons/react";
import { DropIndicator } from "./dnd";
import { MyoxusText } from "./typography";
import { Menu } from "./menu";

type PropertyEdge = "top" | "bottom" | "left" | "right";

const PropertyTableContext = createContext<{
  mountProperty: (payload: { isHide: boolean }) => () => void;
  showAllHide: boolean;
} | null>(null);

const PropertyRootContext = createContext<{
  mountValue: (payload: { isEmpty: boolean }) => () => void;
} | null>(null);

export const PropertyVisibilityContent = forwardRef(
  function PropertyVisibilityContent(
    {
      children,
      collapsible = true,
      collapsed,
      defaultCollapsed,
      onCollapseChange,
      collapseButtonText,
      ...props
    }: PropsWithChildren<{
      collapsible?: boolean;
      defaultCollapsed?: boolean;
      collapsed?: boolean;
      onCollapseChange?: (collapsed: boolean) => void;
      collapseButtonText?: (option: {
        total: number;
        hide: number;
        isCollapsed: boolean;
      }) => ReactNode;
    }> &
      HTMLAttributes<HTMLDivElement>,
    ref: Ref<HTMLDivElement>,
  ) {
    const [propertyCount, setPropertyCount] = useState({ total: 0, hide: 0 });
    const [showAllHide, setShowAllHide] = useState(!defaultCollapsed);
    const finalToggleAvailable = collapsible ? propertyCount.hide !== 0 : false;
    const controlled = collapsed !== undefined;
    const finalShowAllHide = finalToggleAvailable
      ? !controlled
        ? showAllHide
        : !collapsed
      : true;

    const mountProperty = useCallback((payload: { isHide: boolean }) => {
      setPropertyCount((prev) => ({
        total: prev.total + 1,
        hide: prev.hide + (payload.isHide ? 1 : 0),
      }));
      return () => {
        setPropertyCount((prev) => ({
          total: prev.total - 1,
          hide: prev.hide - (payload.isHide ? 1 : 0),
        }));
      };
    }, []);

    const contextValue = useMemo(
      () => ({ mountProperty, showAllHide: finalShowAllHide }),
      [mountProperty, finalShowAllHide],
    );

    const handleShowAllHide = useCallback(() => {
      setShowAllHide(!finalShowAllHide);
      onCollapseChange?.(finalShowAllHide);
    }, [finalShowAllHide, onCollapseChange]);

    return (
      <Stack
        ref={ref}
        gap="xs"
        data-property-visibility-toggle={finalToggleAvailable}
        data-property-collapsed={!finalShowAllHide}
        {...props}
      >
        <PropertyTableContext.Provider value={contextValue}>
          {children}
          {finalToggleAvailable ? (
            <Button
              variant="plain"
              prefix={
                <DisclosureTriangleIcon data-collapsed={!finalShowAllHide} />
              }
              onClick={handleShowAllHide}
              data-testid="property-visibility-button"
            >
              {collapseButtonText
                ? collapseButtonText({
                    total: propertyCount.total,
                    hide: propertyCount.hide,
                    isCollapsed: !finalShowAllHide,
                  })
                : !finalShowAllHide
                  ? "Show All"
                  : "Hide"}
            </Button>
          ) : null}
        </PropertyTableContext.Provider>
      </Stack>
    );
  },
);

export const PropertyRoot = forwardRef(function PropertyRoot(
  {
    children,
    dropIndicatorEdge,
    hideEmpty,
    hide,
    layout = "field",
    ...props
  }: PropsWithChildren<{
    dropIndicatorEdge?: PropertyEdge | null;
    hideEmpty?: boolean;
    hide?: boolean;
    /**
     * `field` keeps property editors readable by stacking values on narrow
     * viewports. `compact-row` is for manager/list rows whose trailing actions
     * must remain in one scan line while still using the property DnD affordance.
     */
    layout?: "field" | "compact-row";
  }> &
    HTMLAttributes<HTMLDivElement>,
  ref: Ref<HTMLDivElement>,
) {
  const [isEmpty, setIsEmpty] = useState(false);
  const context = useContext(PropertyTableContext);

  const preferHide = hide || (hideEmpty && isEmpty);
  const shouldHide = preferHide && !context?.showAllHide;

  useLayoutEffect(() => {
    if (context) {
      return context.mountProperty({ isHide: Boolean(preferHide) });
    }
    return;
  }, [context, preferHide]);

  const contextValue = useMemo(
    () => ({
      mountValue: (payload: { isEmpty: boolean }) => {
        setIsEmpty(payload.isEmpty);
        return () => setIsEmpty(false);
      },
    }),
    [],
  );

  return (
    <PropertyRootContext.Provider value={contextValue}>
      <Group
        {...props}
        ref={ref}
        align={layout === "compact-row" ? "center" : "flex-start"}
        data-layout={layout}
        gap="xs"
        hidden={shouldHide}
        wrap={layout === "compact-row" ? "nowrap" : "wrap"}
      >
        {children}
        <DropIndicator edge={dropIndicatorEdge} />
      </Group>
    </PropertyRootContext.Provider>
  );
});

export function PropertyName({
  icon,
  name,
  menuItems,
  defaultOpenMenu,
  ...props
}: {
  icon?: ReactNode;
  name?: ReactNode;
  menuItems?: ReactNode;
  defaultOpenMenu?: boolean;
} & Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  const [menuOpen, setMenuOpen] = useState(defaultOpenMenu);
  const hasMenu = Boolean(menuItems);
  const { onClick, ...restProps } = props;

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      onClick?.(event as ReactMouseEvent<HTMLDivElement>);
      if (hasMenu) setMenuOpen(true);
    },
    [hasMenu, onClick],
  );

  const handleMenuClose = useCallback((open: boolean) => {
    if (!open) setMenuOpen(false);
  }, []);

  const label = (
    <Group gap="xs" wrap="nowrap">
      {icon ? <Box>{icon}</Box> : null}
      <MyoxusText
        component="span"
        tone="secondary"
        truncate
        typographySlot="nav"
      >
        {name}
      </MyoxusText>
    </Group>
  );

  const content = hasMenu ? (
    <MantineUnstyledButton
      data-has-menu={hasMenu}
      onClick={handleClick}
      {...(restProps as Omit<HTMLAttributes<HTMLButtonElement>, "children">)}
    >
      {label}
    </MantineUnstyledButton>
  ) : (
    <Box data-has-menu={hasMenu} onClick={onClick} {...restProps}>
      {label}
    </Box>
  );

  if (menuOpen && menuItems) {
    return (
      <Menu
        items={menuItems}
        rootOptions={{
          open: true,
          modal: true,
          onOpenChange: handleMenuClose,
        }}
      >
        {content}
      </Menu>
    );
  }
  return content;
}

export const PropertyValue = forwardRef(function PropertyValue(
  {
    children,
    readonly,
    isEmpty,
    hoverable = true,
    ...props
  }: PropsWithChildren<{
    readonly?: boolean;
    isEmpty?: boolean;
    hoverable?: boolean;
  }> &
    HTMLAttributes<HTMLDivElement>,
  ref: Ref<HTMLDivElement>,
) {
  const context = useContext(PropertyRootContext);

  useLayoutEffect(() => {
    if (context) {
      return context.mountValue({ isEmpty: Boolean(isEmpty) });
    }
    return;
  }, [context, isEmpty]);

  return (
    <Box
      {...props}
      ref={ref}
      data-readonly={readonly ? "true" : "false"}
      data-empty={isEmpty ? "true" : "false"}
      data-hoverable={
        hoverable && !BUILD_CONFIG.isMobileEdition ? "true" : "false"
      }
      data-property-value
      flex={1}
      miw={0}
    >
      {children}
    </Box>
  );
});
