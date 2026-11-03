// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type ReactElement,
  type ReactNode,
  cloneElement,
  type HTMLAttributes,
  type CSSProperties,
  type MouseEventHandler,
  type ButtonHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PropsWithChildren,
  createContext,
  type Dispatch,
  type SetStateAction,
  useContext,
  useCallback,
  isValidElement,
  forwardRef,
  type Ref,
  useState,
  useMemo,
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  useImperativeHandle,
  type KeyboardEventHandler,
  useRef,
  useId,
} from "react";
import { reactNodeText } from "./helpers/accessibility";
import { accessibleTooltipLabel } from "./helpers/tooltip";
import {
  type MenuProps as MantineCoreMenuProps,
  UnstyledButton as MantineUnstyledButton,
  ScrollArea,
  Box,
  Stack,
  Group,
  Text,
  Menu as MantineMenu,
  FileButton as MantineFileButton,
  Divider as MantineDivider,
  Button as MantineButton,
} from "@mantine/core";
import { type MyoxusUiRoleProp } from "./helpers/ui-role";
import { cssVar } from "@myoxus/theme";
import { mergeStyles } from "./css-utils";
import { menuIconContent } from "./helpers/menu-icon";
import { MyoxusText } from "./typography";
import {
  DoneIcon,
  ArrowLeftSmallIcon,
  DisclosureTriangleIcon,
  ArrowRightSmallPlusIcon,
  ArrowDownSmallIcon,
} from "@myoxus/icons/react";
import { createHeaderMenuButton } from "./header-menu";
import {
  IconButton,
  Button,
  type MyoxusButtonProps,
  disabledButtonToneStyles,
  buttonToneStyles,
  buttonMantineCssVariables,
  secondaryButtonBorderColor,
  renderSizedIconElement,
} from "./button";
import { observeFacadeResize as observeResize } from "./helpers/observe-resize";
import { Modal, useIsInsideModal } from "./modal";
import { Scrollable } from "./scrollable";
import { useResponsiveSmQuery } from "./responsive";

function isNativeInteractiveTarget(element: ReactElement): boolean {
  if (typeof element.type !== "string") return false;
  return ["a", "button", "input", "select", "textarea"].includes(element.type);
}

function menuTargetWithImplicitRole(element: ReactElement): ReactElement {
  if (isNativeInteractiveTarget(element)) return element;
  const props = element.props as Record<string, unknown>;
  const text = reactNodeText(props.children as ReactNode);
  const tooltipLabel = accessibleTooltipLabel(props.tooltip as ReactNode);
  const onKeyDown = props.onKeyDown as
    KeyboardEventHandler<HTMLElement> | undefined;
  return cloneElement(element, {
    role: props.role ?? "button",
    tabIndex: props.tabIndex ?? 0,
    "data-myoxus-ui-role":
      props["data-myoxus-ui-role"] ?? "button:inline-menu-trigger",
    "aria-label": props["aria-label"] ?? tooltipLabel ?? (text || undefined),
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      onKeyDown?.(event);
      // Component targets may render native buttons. Let the browser activate
      // those, while non-native role=button targets need keyboard activation.
      if (
        event.defaultPrevented ||
        event.target !== event.currentTarget ||
        ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(
          event.currentTarget.tagName,
        ) ||
        event.currentTarget.getAttribute("aria-disabled") === "true"
      )
        return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.currentTarget.click();
      }
    },
  } as Record<string, unknown>);
}

export interface MenuRef {
  changeOpen: (open: boolean) => void;
}

type MenuSide = "top" | "right" | "bottom" | "left";

type MenuAlign = "start" | "center" | "end";

type MenuOffset =
  | number
  | {
      mainAxis?: number;
      crossAxis?: number;
    };

export interface MenuRootOptions {
  defaultOpen?: boolean;
  open?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  onOpenChange?: (open: boolean) => void;
  /**
   * Controls Mantine's focus trap. Omit this for the accessible native default;
   * pass `false` only when menu content intentionally hands focus to a sibling
   * surface such as an externally owned popover.
   */
  modal?: boolean;
  closeOnItemClick?: boolean;
  closeOnEscape?: boolean;
  loop?: boolean;
  middlewares?: MantineCoreMenuProps["middlewares"];
  [key: string]: unknown;
}

export interface MenuPortalOptions {
  container?: HTMLElement | null;
  forceMount?: boolean;
  [key: string]: unknown;
}

export interface MenuContentOptions extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  align?: MenuAlign;
  /**
   * Facade-owned dropdown panel width. Product menus should use this instead of
   * route-local width classes so viewport clamping and density tokens stay
   * shared across normal dropdowns and submenus.
   */
  panelWidth?: MenuPanelProps["panelWidth"];
  /**
   * Facade-owned panel padding for rich menu surfaces. Use this for panels
   * containing forms or dense rows instead of restoring route-local wrapper CSS.
   */
  panelPadding?: MenuPanelProps["panelPadding"];
  side?: MenuSide;
  sideOffset?: number;
  alignOffset?: number;
  [key: string]: unknown;
}

export interface MenuProps {
  children: ReactNode;
  items: ReactNode;
  title?: string;
  portalOptions?: MenuPortalOptions;
  rootOptions?: MenuRootOptions;
  contentOptions?: MenuContentOptions;
  contentWrapperStyle?: CSSProperties;
  noPortal?: boolean;
}

export interface SplitMenuButtonProps
  extends
    Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick">,
    MyoxusUiRoleProp {
  label: ReactNode;
  actionIcon?: ReactNode;
  menuItems: ReactNode;
  onClick: MouseEventHandler<HTMLButtonElement>;
  /**
   * Optional middle-click handler for the primary action segment. Keep this at
   * the facade boundary so product routes do not recreate split-button markup
   * just to support alternate open/create flows.
   */
  onActionAuxClick?: MouseEventHandler<HTMLButtonElement>;
  shortcut?: ReactNode;
  menuAriaLabel?: string;
  menuContentOptions?: MenuContentOptions;
  menuRootOptions?: MenuRootOptions;
  /**
   * Stable test hook for the primary action segment. Keep this separate from
   * `menuTestId` so product callers can target the real action button without
   * recreating split-button markup outside the Facade.
   */
  actionTestId?: string;
  menuTestId?: string;
  disabled?: boolean;
  /**
   * Split buttons are fluid by default for toolbar rows. Inline variants are a
   * facade-owned exception for compact action clusters such as the page header.
   */
  fluid?: boolean;
  spacing?: "none" | "section";
  variant?: "primary" | "secondary";
}

export interface MenuItemProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "prefix" | "type" | "onSelect"
> {
  ref?: Ref<HTMLButtonElement>;
  type?: "default" | "warning" | "danger";
  active?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
  prefixIcon?: ReactNode;
  suffixIcon?: ReactNode;
  prefixIconClassName?: string;
  suffixIconClassName?: string;
  checked?: boolean;
  selected?: boolean;
  block?: boolean;
  closeMenuOnClick?: boolean;
  /**
   * Mobile menu compatibility flag. Desktop/web renders a normal separator via
   * explicit `MenuSeparator`; the flag is retained so old typed callers do not
   * need a parallel compatibility path.
   */
  divide?: boolean;
  onSelect?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  [key: string]: unknown;
}

export type FileMenuItemProps = Omit<
  MenuItemProps,
  "children" | "disabled" | "multiple" | "onClick" | "onSelect"
> & {
  children: ReactNode;
  disabled?: boolean;
  accept?: string;
  multiple?: boolean;
  onFile?: (file: File) => void;
  onFiles?: (files: File[]) => void;
  inputUiRole?: string;
};

export interface MenuSubProps {
  children: ReactNode;
  items: ReactNode;
  title?: ReactNode;
  /**
   * Render submenu contents as normal menu rows below a disabled section label
   * on narrow viewports. This keeps touch/narrow dropdowns usable without
   * leaking Mantine breakpoint hooks into product code.
   */
  narrowBehavior?: "submenu" | "inline";
  triggerOptions?: Partial<MenuItemProps> & {
    [key: `data-${string}`]: unknown;
  };
  subOptions?: {
    /** Controlled open state used by the facade-owned mobile menu stack. */
    open?: boolean;
    openDelay?: number;
    closeDelay?: number;
    /**
     * Floating UI collision handling for rich submenus. Defaults to the same
     * flip/shift policy as top-level Facade menus so nested panels stay inside
     * narrow viewports without product-level offsets.
     */
    middlewares?: MantineCoreMenuProps["middlewares"];
    /** Receives Mantine Floating UI's resolved side after flip/shift. */
    onPositionChange?: MantineCoreMenuProps["onPositionChange"];
    /** Keep the resolved side current while the viewport changes. */
    preventPositionChangeWhenVisible?: boolean;
    onOpenChange?: (open: boolean) => void;
  };
  subContentOptions?: MenuContentOptions;
}

export type ContextMenuProps = PropsWithChildren<{
  items: ReactNode;
  contentProps?: MenuContentOptions;
  asChild?: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  dir?: "ltr" | "rtl";
}>;

export type MenuPanelProps = HTMLAttributes<HTMLDivElement> &
  MyoxusUiRoleProp & {
    panelWidth?: "default" | "comfortable" | "wide" | "display" | "large";
    panelPadding?: "default" | "comfortable";
  };

export type MenuSectionProps = HTMLAttributes<HTMLDivElement> &
  MyoxusUiRoleProp;

export type MenuSummaryRowProps = HTMLAttributes<HTMLSpanElement> &
  MyoxusUiRoleProp & {
    label: ReactNode;
    value?: ReactNode;
  };

export type MenuSectionLabelProps = HTMLAttributes<HTMLDivElement> &
  MyoxusUiRoleProp;

export type MenuDetailRowProps = HTMLAttributes<HTMLDivElement> &
  MyoxusUiRoleProp & {
    density?: "default" | "spacious";
    justify?: "start" | "between";
    panelWidth?: MenuPanelProps["panelWidth"];
    right?: ReactNode;
  };

export type MenuInlineTextProps = HTMLAttributes<HTMLSpanElement> &
  MyoxusUiRoleProp & {
    prefixIcon?: ReactNode;
    tone?: "primary" | "secondary" | "disabled";
    truncate?: boolean;
  };

export type MenuOptionGroupProps = HTMLAttributes<HTMLDivElement> &
  MyoxusUiRoleProp;

export type MenuOptionButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
> &
  MyoxusUiRoleProp & {
    active?: boolean;
    type?: ButtonHTMLAttributes<HTMLButtonElement>["type"];
  };

export type MenuScrollableSectionProps = HTMLAttributes<HTMLDivElement> &
  MyoxusUiRoleProp & {
    maxHeight?: "compact" | "default" | CSSProperties["maxHeight"];
  };

type MenuRuntimeContext = {
  kind: "dropdown" | "context" | "standalone";
  close?: () => void;
  preferredSubmenuSide?: Extract<MenuSide, "left" | "right">;
};

const MenuRuntimeContext = createContext<MenuRuntimeContext>({
  kind: "standalone",
});

type MobileSubMenuContent = {
  id: string;
  title?: ReactNode;
  items: ReactNode;
  options?: MenuSubProps["subOptions"];
  contentOptions?: MenuSubProps["subContentOptions"];
};

type MobileMenuContextValue = {
  subMenus: MobileSubMenuContent[];
  setSubMenus: Dispatch<SetStateAction<MobileSubMenuContent[]>>;
  setOpen?: (open: boolean) => void;
};

const MobileMenuContext = createContext<MobileMenuContextValue>({
  subMenus: [],
  setSubMenus: () => {},
});

function useMobileSubMenuHelper(contextValue?: MobileMenuContextValue) {
  const context = useContext(MobileMenuContext);
  const { subMenus, setSubMenus } = contextValue ?? context;

  const addSubMenu = useCallback(
    (subMenu: MobileSubMenuContent) => {
      if (subMenus.some((item) => item.id === subMenu.id)) return;
      subMenu.options?.onOpenChange?.(true);
      setSubMenus((prev) => [...prev, subMenu]);
    },
    [setSubMenus, subMenus],
  );

  const removeSubMenu = useCallback(
    (id: string) => {
      setSubMenus((prev) => {
        const removed = prev.find((item) => item.id === id);
        removed?.options?.onOpenChange?.(false);
        return prev.filter((item) => item.id !== id);
      });
    },
    [setSubMenus],
  );

  const removeAllSubMenus = useCallback(() => {
    setSubMenus((prev) => {
      for (const subMenu of prev) subMenu.options?.onOpenChange?.(false);
      return [];
    });
  }, [setSubMenus]);

  return { addSubMenu, removeSubMenu, removeAllSubMenus };
}

function attachClickToTrigger(
  children: ReactNode,
  onClick: MouseEventHandler<HTMLElement>,
) {
  if (isValidElement(children)) {
    const child = children as ReactElement<{
      onClick?: MouseEventHandler<HTMLElement>;
    }>;
    return cloneElement(child, {
      onClick: (event: ReactMouseEvent<HTMLElement>) => {
        child.props.onClick?.(event);
        if (!event.defaultPrevented) onClick(event);
      },
    });
  }

  return (
    <MantineUnstyledButton
      type="button"
      onClick={onClick}
      data-myoxus-ui-role="button:inline-menu-trigger"
    >
      {children}
    </MantineUnstyledButton>
  );
}

function menuPosition(side?: MenuSide, align?: MenuAlign) {
  const resolvedSide = side ?? "bottom";
  if (!align || align === "center") return resolvedSide;
  return `${resolvedSide}-${align}` as const;
}

function submenuSideForParentPosition(
  position: NonNullable<MantineCoreMenuProps["position"]>,
): Extract<MenuSide, "left" | "right"> {
  // Closed submenus do not have their own Floating result yet. Use the
  // parent Menu's requested/resolved position until Mantine resolves the
  // submenu itself, keeping sibling disclosures consistent without viewport
  // measurement or product-owned side hints.
  if (position.startsWith("left")) return "left";
  if (position.startsWith("right")) return "right";
  return position.endsWith("-end") ? "left" : "right";
}

function menuOffset(sideOffset?: number, alignOffset?: number): MenuOffset {
  if (alignOffset === undefined) return sideOffset ?? 4;
  return {
    mainAxis: sideOffset ?? 4,
    crossAxis: alignOffset,
  };
}

const menuFloatingMiddlewares: NonNullable<
  MantineCoreMenuProps["middlewares"]
> = {
  flip: true,
  shift: {
    crossAxis: true,
  },
};

function filterDomOptions<T extends Record<string, unknown>>(source: T) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => {
      return (
        key === "id" ||
        key === "lang" ||
        key === "title" ||
        key === "role" ||
        key.startsWith("data-") ||
        key.startsWith("aria-")
      );
    }),
  );
}

const menuIconSize =
  "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))";

const menuDisclosureIconSize = "var(--mantine-spacing-md)";

const menuContextContentStyle: CSSProperties = {
  maxWidth: `min(calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 8), calc(100vw - var(--mantine-spacing-lg)))`,
};

const standaloneMenuItemLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textAlign: "left",
};

const standaloneMenuItemSectionStyle: CSSProperties = {
  display: "inline-flex",
  flex: "0 0 auto",
  alignItems: "center",
  gap: "var(--mantine-spacing-xs)",
};

const menuIconBaseStyle: CSSProperties = {
  width: menuIconSize,
  height: menuIconSize,
  display: "inline-flex",
  flex: "0 0 auto",
  alignItems: "center",
  justifyContent: "center",
  fontSize: menuIconSize,
};

const standaloneMenuSeparatorStyle: CSSProperties = {
  margin: `var(--mantine-spacing-2xs) 0`,
  borderColor: cssVar("borderColor"),
};

const splitMenuButtonHeight =
  "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))";

const splitMenuButtonRadius = "var(--mantine-radius-sm)";

const splitMenuButtonRootStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  position: "relative",
};

const splitMenuButtonInlineStyle: CSSProperties = {
  width: "max-content",
  flex: "0 0 auto",
};

const splitMenuButtonSectionSpacingStyle: CSSProperties = {
  marginTop: "var(--mantine-spacing-md)",
};

const splitMenuButtonActionRootStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  height: splitMenuButtonHeight,
  minHeight: splitMenuButtonHeight,
  borderTopRightRadius: 0,
  borderBottomRightRadius: 0,
  borderRightWidth: 0,
  paddingInline: "var(--mantine-spacing-md)",
};

const splitMenuButtonTriggerRootStyle: CSSProperties = {
  flex: "0 0 auto",
  width: "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))",
  minWidth: "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))",
  height: splitMenuButtonHeight,
  minHeight: splitMenuButtonHeight,
  borderTopLeftRadius: 0,
  borderBottomLeftRadius: 0,
  paddingInline: "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
};

const splitMenuButtonLabelStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--mantine-spacing-xs)",
  justifyContent: "center",
};

const splitMenuButtonTextStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const splitMenuButtonActionIconStyle: CSSProperties = {
  display: "inline-flex",
  flexShrink: 0,
};

const splitMenuButtonShortcutStyle: CSSProperties = {
  position: "absolute",
  right: "var(--mantine-spacing-xs)",
  opacity: 0.55,
};

const splitMenuButtonIconStyle: CSSProperties = {
  width: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
  height: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
  color: "currentColor",
};

const mobileMenuModalStyle: CSSProperties = {
  overflow: "hidden",
  padding: 0,
};

const mobileMenuSliderBaseStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  transition: "height 0.22s ease, transform 0.22s ease",
  willChange: "height, transform",
};

const mobileMenuPanelStyle: CSSProperties = {
  width: "100%",
  minWidth: "100%",
  boxSizing: "border-box",
  padding: "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
  color: cssVar("textPrimaryColor"),
  background: cssVar("backgroundOverlayPanelColor"),
};

const mobileMenuTitleStyle: CSSProperties = {
  padding: `var(--mantine-spacing-xs) calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))`,
};

const mobileMenuBackStyle: CSSProperties = {
  width: "100%",
  justifyContent: "flex-start",
  marginBottom: "var(--mantine-spacing-xs)",
};

const mobileMenuScrollStyle: CSSProperties = {
  maxHeight: `min(70vh, calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 13))`,
};

// Dropdown menus are styled by myoxusMantineTheme. This fallback is only used
// where a menu item is rendered outside Mantine Menu context, currently mobile
// and standalone submenu content.
const standaloneMenuContentStyle: CSSProperties = {
  minWidth:
    "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 4 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))\n  )",
  maxHeight: `min(calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 13), calc(100dvh - var(--mantine-spacing-md)))`,
  border: `calc(var(--mantine-scale) * 1px) solid ${cssVar("borderColor")}`,
  borderRadius: "var(--mantine-radius-lg)",
  padding: "var(--mantine-spacing-sm)",
  color: cssVar("textPrimaryColor"),
  background: cssVar("backgroundOverlayPanelColor"),
  boxShadow: "var(--mantine-shadow-md)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--mantine-spacing-xs)",
  overflowY: "auto",
  overscrollBehavior: "contain",
};

const menuSubContentFallbackStyle: CSSProperties = {
  ...standaloneMenuContentStyle,
  position: "absolute",
  top: 0,
  left: `calc(100% + var(--mantine-spacing-xs))`,
  minWidth: `max(calc(
    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 4 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))
  ), 100%)`,
};

const menuPanelBaseStyle: CSSProperties = {
  minWidth:
    "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 4 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))\n  )",
  maxWidth: "100%",
  boxSizing: "border-box",
};

const menuPanelWidthByKind: Record<
  NonNullable<MenuPanelProps["panelWidth"]>,
  CSSProperties
> = {
  default: {
    minWidth:
      "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 4 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))\n  )",
  },
  comfortable: {
    minWidth:
      "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 5 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))\n  )",
  },
  wide: {
    minWidth:
      "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 6 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))\n  )",
  },
  display: {
    minWidth:
      "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 7)",
    width:
      "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 7)",
  },
  large: {
    minWidth:
      "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 7)",
    width: `clamp(calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 7), 54vw, calc(
    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 10 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))
  ))`,
    maxWidth: `calc(100vw - var(--mantine-spacing-lg))`,
  },
};

const menuPanelPaddingByKind: Record<
  NonNullable<MenuPanelProps["panelPadding"]>,
  CSSProperties
> = {
  default: {},
  comfortable: {
    padding: "var(--mantine-spacing-md)",
  },
};

const menuSummaryRowStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--mantine-spacing-sm)",
  fontWeight:
    "var(--mantine-font-weight-nav, var(--mantine-font-weight-regular))",
};

const menuSummaryLabelStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const menuSummaryValueStyle: CSSProperties = {
  ...menuSummaryLabelStyle,
  flex: "0 1 auto",
  color: cssVar("textSecondaryColor"),
  fontWeight:
    "var(--mantine-font-weight-body-small, var(--mantine-font-weight-regular))",
  textAlign: "end",
};

const menuDetailRowBaseStyle: CSSProperties = {
  width: "100%",
  minWidth:
    "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 4 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))\n  )",
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--mantine-spacing-sm)",
  color: cssVar("textSecondaryColor"),
  boxSizing: "border-box",
};

const menuDetailRowDensityStyle: Record<
  NonNullable<MenuDetailRowProps["density"]>,
  CSSProperties
> = {
  default: {
    padding: `var(--mantine-spacing-xs) var(--mantine-spacing-xs)`,
  },
  spacious: {
    padding: `var(--mantine-spacing-xs) calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))`,
  },
};

const menuDetailRightStyle: CSSProperties = {
  marginLeft: "auto",
  minWidth: 0,
  display: "inline-flex",
  alignItems: "center",
};

const menuOptionButtonBaseStyle: CSSProperties = {
  minHeight: "var(--mantine-spacing-xl)",
  border: 0,
  borderRadius: "var(--mantine-radius-sm)",
  padding: `var(--mantine-spacing-xs) var(--mantine-spacing-sm)`,
  cursor: "pointer",
  userSelect: "none",
};

const menuOptionButtonInactiveStyle: CSSProperties = {
  color: cssVar("textSecondaryColor"),
  background: "transparent",
};

const menuOptionButtonActiveStyle: CSSProperties = {
  color: cssVar("textPrimaryColor"),
  background: cssVar("hoverColor"),
};

const menuScrollableSectionContentStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
};

function menuScrollableSectionMaxHeight(
  maxHeight: MenuScrollableSectionProps["maxHeight"],
) {
  if (maxHeight === "default")
    return "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 13)";
  if (!maxHeight || maxHeight === "compact") {
    return "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 5\n  )";
  }
  return maxHeight;
}

export function MenuPanel({
  panelPadding = "default",
  panelWidth = "default",
  style,
  children,
  ...props
}: MenuPanelProps) {
  return (
    <Stack
      gap="xs"
      {...props}
      data-myoxus-ui-role={props["data-myoxus-ui-role"] ?? "menu-panel"}
      style={mergeStyles(
        menuPanelBaseStyle,
        menuPanelWidthByKind[panelWidth],
        menuPanelPaddingByKind[panelPadding],
        style,
      )}
    >
      {children}
    </Stack>
  );
}

export function MenuSection({ style, children, ...props }: MenuSectionProps) {
  return (
    <Stack
      gap="xs"
      {...props}
      data-myoxus-ui-role={props["data-myoxus-ui-role"] ?? "menu-section"}
      style={style}
    >
      {children}
    </Stack>
  );
}

export const MenuScrollableSection = forwardRef<
  HTMLDivElement,
  MenuScrollableSectionProps
>(function MenuScrollableSection(
  { maxHeight = "compact", style, children, ...props },
  ref,
) {
  // Bounded option lists belong to the facade so product menus do not grow
  // route-local scroll wrappers and scrollbar CSS.
  return (
    <ScrollArea.Autosize
      {...props}
      type="auto"
      mah={menuScrollableSectionMaxHeight(maxHeight)}
      data-myoxus-ui-role={
        props["data-myoxus-ui-role"] ?? "menu-scrollable-section"
      }
      style={style}
    >
      <Box
        ref={ref}
        data-myoxus-ui-role="menu-scrollable-section-content"
        style={menuScrollableSectionContentStyle}
      >
        {children}
      </Box>
    </ScrollArea.Autosize>
  );
});

export function MenuSummaryRow({
  label,
  value,
  style,
  ...props
}: MenuSummaryRowProps) {
  return (
    <span
      {...props}
      data-myoxus-ui-role={props["data-myoxus-ui-role"] ?? "menu-summary-row"}
      style={mergeStyles(menuSummaryRowStyle, style)}
    >
      <span style={menuSummaryLabelStyle}>{label}</span>
      {value ? <span style={menuSummaryValueStyle}>{value}</span> : null}
    </span>
  );
}

export function MenuSectionLabel({
  style,
  children,
  ...props
}: MenuSectionLabelProps) {
  const runtime = useContext(MenuRuntimeContext);
  // Native dropdown labels need their Menu context; standalone property panels
  // retain the same text role without creating a second overlay runtime.
  return runtime.kind === "standalone" ? (
    <MyoxusText
      {...props}
      component="div"
      tone="secondary"
      typographySlot="label-compact"
      px="md"
      py="xs"
      style={style}
      data-myoxus-ui-role={props["data-myoxus-ui-role"] ?? "menu-section-label"}
    >
      {children}
    </MyoxusText>
  ) : (
    <MantineMenu.Label
      {...props}
      style={style}
      data-myoxus-ui-role={props["data-myoxus-ui-role"] ?? "menu-section-label"}
    >
      {children}
    </MantineMenu.Label>
  );
}

/**
 * Facade-owned label/value row for dense menu panels.
 *
 * Workspace property menus use this instead of route-local CSS so row
 * typography, spacing and panel width stay aligned with Mantine menu theming.
 */
export function MenuDetailRow({
  density = "default",
  justify = "between",
  panelWidth = "default",
  right,
  style,
  children,
  ...props
}: MenuDetailRowProps) {
  return (
    <div
      {...props}
      data-myoxus-ui-role={props["data-myoxus-ui-role"] ?? "menu-detail-row"}
      style={mergeStyles(
        menuDetailRowBaseStyle,
        menuPanelWidthByKind[panelWidth],
        menuDetailRowDensityStyle[density],
        {
          justifyContent:
            justify === "between" ? "space-between" : "flex-start",
        },
        style,
      )}
    >
      {children}
      {right ? <span style={menuDetailRightStyle}>{right}</span> : null}
    </div>
  );
}

/**
 * Compact inline menu text with optional normalized icon prefix.
 *
 * It is intentionally small: product menus should pass domain labels and icons,
 * while the facade owns truncation, typography and color tone mapping.
 */
export function MenuInlineText({
  prefixIcon,
  tone = "primary",
  truncate = true,
  style,
  children,
  ...props
}: MenuInlineTextProps) {
  return (
    <Group
      {...props}
      component="span"
      gap="xs"
      wrap="nowrap"
      miw={0}
      style={style}
      data-myoxus-ui-role={props["data-myoxus-ui-role"] ?? "menu-inline-text"}
    >
      {prefixIcon ? (
        <span style={menuIconBaseStyle}>{menuIconContent(prefixIcon)}</span>
      ) : null}
      <Text
        component="span"
        inherit
        c={
          tone === "disabled"
            ? cssVar("textDisableColor")
            : `myoxus-text-${tone}`
        }
        truncate={truncate ? "end" : undefined}
        miw={0}
      >
        {children}
      </Text>
    </Group>
  );
}

export function MenuFontPreviewItem({
  fontName,
  previewFontFamily,
  selected,
  onSelect,
}: {
  fontName: string;
  previewFontFamily: CSSProperties["fontFamily"];
  selected?: boolean;
  onSelect: () => void;
}) {
  // Font menus are data-heavy but visually standard. Keep the two-line preview
  // structure in the facade so product settings only provide font metadata.
  return (
    <MenuItem selected={selected} onSelect={onSelect}>
      <Stack gap={0} style={{ minWidth: 0 }}>
        <MyoxusText
          component="span"
          typographySlot="body-small"
          style={{
            fontFamily: previewFontFamily,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          data-myoxus-ui-role="menu-font-preview-title"
        >
          {fontName}
        </MyoxusText>
        <MyoxusText
          component="span"
          typographySlot="label-compact"
          fallbackSlot="body-small"
          tone="secondary"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          data-myoxus-ui-role="menu-font-preview-meta"
        >
          {fontName}
        </MyoxusText>
      </Stack>
    </MenuItem>
  );
}

export function MenuOptionGroup({
  style,
  children,
  ...props
}: MenuOptionGroupProps) {
  return (
    <Group
      px="md"
      py="xs"
      gap="sm"
      {...props}
      data-myoxus-ui-role={props["data-myoxus-ui-role"] ?? "menu-option-group"}
      style={style}
    >
      {children}
    </Group>
  );
}

export function MenuOptionButton({
  active = false,
  style,
  children,
  type = "button",
  ...props
}: MenuOptionButtonProps) {
  const menuContext = useContext(MenuRuntimeContext);
  return (
    <MantineUnstyledButton
      {...props}
      component="button"
      type={type}
      aria-pressed={props["aria-pressed"] ?? active}
      data-active={active ? "true" : "false"}
      data-mantine-stop-propagation={
        menuContext.kind === "dropdown" ? "true" : undefined
      }
      data-myoxus-ui-role={props["data-myoxus-ui-role"] ?? "menu-option-button"}
      style={mergeStyles(
        menuOptionButtonBaseStyle,
        active ? menuOptionButtonActiveStyle : menuOptionButtonInactiveStyle,
        style,
      )}
    >
      {children}
    </MantineUnstyledButton>
  );
}

function menuItemToneColor({
  type,
  disabled,
  checked,
  selected,
}: Pick<MenuItemProps, "type" | "disabled" | "checked" | "selected">) {
  if (disabled) {
    return undefined;
  }
  if (type === "danger") {
    return "var(--mantine-color-myoxus-text-danger-text)";
  }
  if (type === "warning") {
    return "var(--mantine-color-myoxus-text-warning-text)";
  }
  if (checked || selected) {
    return cssVar("primaryColor");
  }
  return undefined;
}

function menuItemStateStyle({
  type = "default",
  active,
  disabled,
  checked,
  selected,
  style,
}: Pick<
  MenuItemProps,
  "type" | "active" | "disabled" | "checked" | "selected" | "style"
>): CSSProperties | undefined {
  const color = menuItemToneColor({ type, disabled, checked, selected });
  return mergeStyles(
    active ? { background: cssVar("hoverColor") } : undefined,
    color ? { color } : undefined,
    style,
  );
}

function standaloneMenuItemStyle({
  type = "default",
  active,
  disabled,
  checked,
  selected,
  block,
  style,
}: Pick<
  MenuItemProps,
  "type" | "active" | "disabled" | "checked" | "selected" | "block" | "style"
>): CSSProperties {
  const color = disabled
    ? cssVar("textSecondaryColor")
    : (menuItemToneColor({ type, disabled, checked, selected }) ??
      cssVar("textPrimaryColor"));

  return {
    width: "100%",
    maxWidth: block ? "100%" : undefined,
    minHeight:
      "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--mantine-spacing-sm)",
    padding: "var(--mantine-spacing-xs)",
    border: 0,
    borderRadius: "var(--mantine-radius-sm)",
    outline: "none",
    boxSizing: "border-box",
    color,
    background: active ? cssVar("hoverColor") : "transparent",
    cursor: disabled ? "default" : "pointer",
    pointerEvents: disabled ? "none" : undefined,
    textAlign: "start",
    ...style,
  };
}

function menuItemSections({
  prefix,
  prefixIcon,
  prefixIconClassName,
  suffix,
  suffixIcon,
  suffixIconClassName,
  checked,
  selected,
  standalone = false,
}: Pick<
  MenuItemProps,
  | "prefix"
  | "prefixIcon"
  | "prefixIconClassName"
  | "suffix"
  | "suffixIcon"
  | "suffixIconClassName"
  | "checked"
  | "selected"
> & {
  standalone?: boolean;
}) {
  const sectionStyle = standalone ? standaloneMenuItemSectionStyle : undefined;
  const leftSection =
    prefix || prefixIcon ? (
      <span data-position="left" style={sectionStyle}>
        {prefix}
        {prefixIcon ? (
          <span className={prefixIconClassName} style={menuIconBaseStyle}>
            {menuIconContent(prefixIcon)}
          </span>
        ) : null}
      </span>
    ) : undefined;

  const rightSection =
    suffixIcon || suffix || checked || selected ? (
      <span data-position="right" style={sectionStyle}>
        {suffixIcon ? (
          <span className={suffixIconClassName} style={menuIconBaseStyle}>
            {menuIconContent(suffixIcon)}
          </span>
        ) : null}
        {suffix}
        {checked || selected ? (
          <span style={menuIconBaseStyle}>{menuIconContent(<DoneIcon />)}</span>
        ) : null}
      </span>
    ) : undefined;

  return { leftSection, rightSection };
}

export const Menu = forwardRef(function Menu(
  {
    children,
    items,
    title: menuTitle,
    rootOptions = {},
    contentOptions = {},
    contentWrapperStyle,
    noPortal,
  }: MenuProps,
  ref: Ref<MenuRef>,
) {
  const insideModal = useIsInsideModal();
  const {
    defaultOpen,
    open,
    onOpen,
    onOpenChange,
    onClose,
    modal,
    closeOnItemClick = true,
    closeOnEscape = true,
    loop = true,
    middlewares = menuFloatingMiddlewares,
  } = rootOptions;
  const {
    className,
    style,
    side,
    align,
    sideOffset,
    alignOffset,
    panelPadding,
    panelWidth,
    onKeyDown: contentOnKeyDown,
    ...contentDomOptions
  } = contentOptions;
  const [innerOpen, setInnerOpen] = useState(Boolean(defaultOpen));
  const finalOpen = open ?? innerOpen;
  const preferredPosition = menuPosition(side, align);
  const [resolvedPosition, setResolvedPosition] = useState(preferredPosition);
  const menuRuntimeContextValue = useMemo<MenuRuntimeContext>(
    () => ({
      kind: "dropdown",
      preferredSubmenuSide: submenuSideForParentPosition(resolvedPosition),
    }),
    [resolvedPosition],
  );

  useEffect(() => {
    setResolvedPosition(preferredPosition);
  }, [preferredPosition]);

  const setMenuOpen = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) setResolvedPosition(preferredPosition);
      setInnerOpen(nextOpen);
      onOpenChange?.(nextOpen);
      if (nextOpen) onOpen?.();
      else onClose?.();
    },
    [onClose, onOpen, onOpenChange, preferredPosition],
  );

  const closeOnOwnedEscape = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, overlayOpen: boolean) => {
      if (!overlayOpen || !closeOnEscape || event.key !== "Escape") return;
      // An open overlay owns its dismissal key. Letting the same Escape reach
      // an editor or page keymap underneath would collapse two interaction
      // levels at once.
      event.stopPropagation();
      setMenuOpen(false);
    },
    [closeOnEscape, setMenuOpen],
  );

  useImperativeHandle(
    ref,
    () => ({
      changeOpen: setMenuOpen,
    }),
    [setMenuOpen],
  );

  const implicitTarget = isValidElement(children) ? (
    menuTargetWithImplicitRole(children)
  ) : (
    <MantineUnstyledButton
      type="button"
      data-myoxus-ui-role="button:inline-menu-trigger"
    >
      {children}
    </MantineUnstyledButton>
  );
  const targetOnKeyDown = (
    implicitTarget.props as {
      onKeyDown?: KeyboardEventHandler<HTMLElement>;
    }
  ).onKeyDown;
  const target = cloneElement(implicitTarget, {
    // Modal handles Escape on window capture, before our React menu handler.
    // Its native target marker lets this open menu own the dismissal first.
    "data-mantine-stop-propagation": finalOpen ? "true" : undefined,
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      targetOnKeyDown?.(event);
      if (!event.defaultPrevented) {
        closeOnOwnedEscape(
          event,
          event.currentTarget.getAttribute("aria-expanded") === "true",
        );
      }
    },
  } as Record<string, unknown>);

  return (
    <MenuRuntimeContext.Provider value={menuRuntimeContextValue}>
      <MantineMenu
        opened={finalOpen}
        onChange={setMenuOpen}
        closeOnItemClick={closeOnItemClick}
        closeOnEscape={false}
        loop={loop}
        trapFocus={modal ?? true}
        // Keep dialog menus in their owner's native stacking context. A body
        // portal at the popover role can sit beneath Mantine's modal stack.
        withinPortal={!noPortal && !insideModal}
        position={preferredPosition}
        onPositionChange={setResolvedPosition}
        offset={menuOffset(sideOffset, alignOffset)}
        middlewares={middlewares}
        shadow="md"
        zIndex={insideModal ? undefined : cssVar("zIndexPopover")}
      >
        <MantineMenu.Target>{target}</MantineMenu.Target>
        <MantineMenu.Dropdown
          className={className}
          style={mergeStyles(
            contentWrapperStyle,
            panelWidth ? menuPanelWidthByKind[panelWidth] : undefined,
            panelPadding ? menuPanelPaddingByKind[panelPadding] : undefined,
            style,
          )}
          data-myoxus-ui-role="menu-content"
          {...filterDomOptions(contentDomOptions)}
          data-myoxus-ui-open={finalOpen ? "true" : "false"}
          onKeyDown={(event) => {
            contentOnKeyDown?.(event);
            if (!event.defaultPrevented) closeOnOwnedEscape(event, true);
          }}
        >
          {menuTitle ? (
            <MantineMenu.Label data-myoxus-ui-role="menu-title">
              {menuTitle}
            </MantineMenu.Label>
          ) : null}
          {items}
        </MantineMenu.Dropdown>
      </MantineMenu>
    </MenuRuntimeContext.Provider>
  );
});

export const HeaderMenuButton = createHeaderMenuButton({ IconButton, Menu });

export function FileMenuItem({
  accept,
  multiple = false,
  disabled,
  onFile,
  onFiles,
  inputUiRole = "file-menu-item-input",
  children,
  ...menuItemProps
}: FileMenuItemProps) {
  const resetFilePickerRef = useRef<() => void>(null);
  const handleFilePick = useCallback(
    (payload: File | File[] | null) => {
      const files = Array.isArray(payload) ? payload : payload ? [payload] : [];
      const firstFile = files[0];
      if (firstFile) {
        onFiles?.(files);
        onFile?.(firstFile);
      }
      resetFilePickerRef.current?.();
    },
    [onFile, onFiles],
  );

  return (
    <MantineFileButton
      accept={accept}
      multiple={multiple}
      disabled={disabled}
      resetRef={resetFilePickerRef}
      onChange={handleFilePick}
      inputProps={
        {
          "aria-hidden": "true",
          "data-myoxus-ui-role": inputUiRole,
          tabIndex: -1,
        } as React.ComponentProps<"input"> & {
          "data-myoxus-ui-role": string;
        }
      }
    >
      {({ onClick }) => (
        <MenuItem
          {...menuItemProps}
          disabled={disabled}
          onSelect={() => {
            if (!disabled) onClick();
          }}
        >
          {children}
        </MenuItem>
      )}
    </MantineFileButton>
  );
}

export function MenuItem({
  children,
  type = "default",
  active,
  className,
  style,
  prefix,
  prefixIcon,
  prefixIconClassName,
  suffix,
  suffixIcon,
  suffixIconClassName,
  checked,
  selected,
  block,
  disabled,
  closeMenuOnClick,
  onClick,
  onSelect,
  "data-myoxus-ui-role": uiRole = "menu-item",
  ...buttonOptions
}: MenuItemProps) {
  const menuContext = useContext(MenuRuntimeContext);
  const standalone = menuContext.kind !== "dropdown";
  const { leftSection, rightSection } = menuItemSections({
    prefix,
    prefixIcon,
    prefixIconClassName,
    suffix,
    suffixIcon,
    suffixIconClassName,
    checked,
    selected,
    standalone,
  });
  const itemStyle = standalone
    ? standaloneMenuItemStyle({
        type,
        active,
        disabled,
        checked,
        selected,
        block,
        style,
      })
    : menuItemStateStyle({ type, active, disabled, checked, selected, style });
  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    onClick?.(event);
    if (!event.defaultPrevented) onSelect?.(event);
    if (
      !event.defaultPrevented &&
      closeMenuOnClick !== false &&
      menuContext.kind !== "dropdown"
    ) {
      menuContext.close?.();
    }
  };
  // Mantine overlays clone their target with a ref and focus/hover handlers.
  // Keep those on the actual button instead of silently breaking composition.
  const domOptions = {
    ...filterDomOptions(buttonOptions),
    ref: buttonOptions.ref,
    onFocus: buttonOptions.onFocus,
    onBlur: buttonOptions.onBlur,
    onMouseEnter: buttonOptions.onMouseEnter,
    onMouseLeave: buttonOptions.onMouseLeave,
    onMouseMove: buttonOptions.onMouseMove,
    onPointerEnter: buttonOptions.onPointerEnter,
    onPointerLeave: buttonOptions.onPointerLeave,
    onPointerDown: buttonOptions.onPointerDown,
    onPointerMove: buttonOptions.onPointerMove,
  };

  if (menuContext.kind === "dropdown") {
    return (
      <MantineMenu.Item
        {...domOptions}
        data-mantine-stop-propagation="true"
        className={className}
        style={itemStyle}
        disabled={disabled}
        leftSection={leftSection}
        rightSection={rightSection}
        closeMenuOnClick={closeMenuOnClick}
        onClick={handleClick}
        data-active={active || undefined}
        data-checked={checked || undefined}
        data-selected={selected || undefined}
        data-myoxus-ui-role={uiRole}
      >
        {children}
      </MantineMenu.Item>
    );
  }

  return (
    <MantineUnstyledButton
      {...domOptions}
      component="button"
      type="button"
      className={className}
      style={itemStyle}
      disabled={disabled}
      role="menuitem"
      aria-checked={checked || selected || undefined}
      onClick={handleClick}
      data-active={active || undefined}
      data-checked={checked || undefined}
      data-selected={selected || undefined}
      data-myoxus-ui-role={uiRole}
    >
      {leftSection}
      <span style={standaloneMenuItemLabelStyle}>{children}</span>
      {rightSection}
    </MantineUnstyledButton>
  );
}

export function MenuSeparator({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  const menuContext = useContext(MenuRuntimeContext);
  if (menuContext.kind === "dropdown") {
    return (
      <MantineMenu.Divider
        className={className}
        style={style}
        role="separator"
        data-myoxus-ui-role="menu-separator"
      />
    );
  }
  return (
    <MantineDivider
      className={className}
      style={mergeStyles(standaloneMenuSeparatorStyle, style)}
      role="separator"
      data-myoxus-ui-role="menu-separator"
    />
  );
}

export const MobileMenu = forwardRef(function MobileMenu(
  {
    children,
    items,
    title,
    rootOptions = {},
    contentOptions = {},
    contentWrapperStyle,
  }: MenuProps,
  ref: Ref<MenuRef>,
) {
  const { defaultOpen, open, onOpen, onOpenChange, onClose } = rootOptions;
  const {
    className,
    style,
    onPointerDownOutside,
    onInteractOutside,
    ...contentDomOptions
  } = contentOptions;
  const handlePointerDownOutside =
    typeof onPointerDownOutside === "function" ? onPointerDownOutside : null;
  const handleInteractOutside =
    typeof onInteractOutside === "function" ? onInteractOutside : null;
  const parentMenu = useContext(MobileMenuContext);
  const [subMenus, setSubMenus] = useState<MobileSubMenuContent[]>([]);
  const [innerOpen, setInnerOpen] = useState(Boolean(defaultOpen));
  const finalOpen = open ?? innerOpen;
  const activeIndex = subMenus.length;
  const [sliderElement, setSliderElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [sliderHeight, setSliderHeight] = useState<number | undefined>();
  const { removeSubMenu, removeAllSubMenus } = useMobileSubMenuHelper({
    subMenus,
    setSubMenus,
  });

  const setMenuOpen = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        handlePointerDownOutside?.({} as never);
        handleInteractOutside?.({} as never);
        removeAllSubMenus();
      }
      setInnerOpen(nextOpen);
      onOpenChange?.(nextOpen);
      if (nextOpen) onOpen?.();
      else onClose?.();
    },
    [
      onClose,
      handleInteractOutside,
      onOpen,
      onOpenChange,
      handlePointerDownOutside,
      removeAllSubMenus,
    ],
  );

  useImperativeHandle(
    ref,
    () => ({
      changeOpen: setMenuOpen,
    }),
    [setMenuOpen],
  );

  useEffect(() => {
    if (!sliderElement || !finalOpen) return;
    const active = sliderElement.querySelector(
      `[data-myoxus-ui-role="mobile-menu-panel"][data-index="${activeIndex}"]`,
    );
    if (!active) return;
    return observeResize(active, (entry) => {
      setSliderHeight(entry.borderBoxSize[0]?.blockSize ?? active.clientHeight);
    });
  }, [activeIndex, finalOpen, sliderElement]);

  const mobileMenuContextValue = useMemo(
    () => ({ subMenus, setSubMenus, setOpen: setMenuOpen }),
    [setMenuOpen, subMenus],
  );

  const menuRuntimeContextValue = useMemo(
    () => ({ kind: "standalone" as const, close: () => setMenuOpen(false) }),
    [setMenuOpen],
  );

  const openFromTrigger = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      setMenuOpen(!finalOpen);
    },
    [finalOpen, setMenuOpen],
  );

  if (parentMenu.setOpen) {
    return (
      <MobileMenuSub title={title} items={items} subOptions={rootOptions}>
        {children}
      </MobileMenuSub>
    );
  }

  return (
    <>
      {attachClickToTrigger(children, openFromTrigger)}
      <MobileMenuContext.Provider value={mobileMenuContextValue}>
        <MenuRuntimeContext.Provider value={menuRuntimeContextValue}>
          <Modal
            open={finalOpen}
            onOpenChange={setMenuOpen}
            width="100%"
            animation="slideBottom"
            withoutCloseButton
            disableAutoFocus
            contentOptions={{
              ...filterDomOptions(contentDomOptions),
              className,
              style: {
                ...mobileMenuModalStyle,
                ...contentWrapperStyle,
                ...style,
              },
            }}
          >
            <div
              ref={setSliderElement}
              style={{
                ...mobileMenuSliderBaseStyle,
                height: sliderHeight,
                transform: `translateX(-${100 * activeIndex}%)`,
              }}
              data-myoxus-ui-role="mobile-menu-slider"
            >
              <div
                data-index={0}
                data-myoxus-ui-role="mobile-menu-panel"
                style={mobileMenuPanelStyle}
                role="menu"
              >
                {title ? (
                  <MyoxusText
                    component="div"
                    typographySlot="label-compact"
                    fallbackSlot="body-small"
                    tone="secondary"
                    style={mobileMenuTitleStyle}
                    data-myoxus-ui-role="mobile-menu-title"
                  >
                    {title}
                  </MyoxusText>
                ) : null}
                {items}
              </div>
              {subMenus.map((subMenu, index) => (
                <div
                  key={subMenu.id}
                  data-index={index + 1}
                  data-myoxus-ui-role="mobile-menu-panel"
                  style={mobileMenuPanelStyle}
                  role="menu"
                >
                  <Button
                    variant="plain"
                    prefix={<ArrowLeftSmallIcon />}
                    style={mobileMenuBackStyle}
                    onClick={() => removeSubMenu(subMenu.id)}
                    data-testid="mobile-menu-back-button"
                  >
                    {subMenu.title ?? "Back"}
                  </Button>
                  <Scrollable.Root>
                    <Scrollable.Viewport style={mobileMenuScrollStyle}>
                      {subMenu.items}
                    </Scrollable.Viewport>
                    <Scrollable.Scrollbar />
                  </Scrollable.Root>
                </div>
              ))}
            </div>
          </Modal>
        </MenuRuntimeContext.Provider>
      </MobileMenuContext.Provider>
    </>
  );
});

export function MobileMenuItem(props: MenuItemProps) {
  return <MenuItem {...props} />;
}

export function useMobileMenuController() {
  const context = useContext(MobileMenuContext);
  const close = useCallback(() => {
    context.setOpen?.(false);
  }, [context]);

  return { close };
}

export function MenuSub({
  children,
  items,
  narrowBehavior = "submenu",
  triggerOptions = {},
  subOptions = {},
  subContentOptions = {},
}: MenuSubProps) {
  const menuContext = useContext(MenuRuntimeContext);
  const narrowViewport = useResponsiveSmQuery(false);
  const inlineOnNarrow = narrowBehavior === "inline" && narrowViewport;
  const {
    className,
    style,
    prefix,
    prefixIcon,
    prefixIconClassName,
    suffix,
    suffixIcon,
    suffixIconClassName,
    checked,
    selected,
    block,
    disabled,
    type = "default",
    closeMenuOnClick: _closeMenuOnClick,
    ...triggerDomOptions
  } = triggerOptions;
  const {
    className: subContentClassName,
    style: subContentStyle,
    side,
    align,
    sideOffset,
    alignOffset,
    panelPadding,
    panelWidth,
    ...subContentDomOptions
  } = subContentOptions;
  const {
    open,
    openDelay,
    closeDelay,
    middlewares = menuFloatingMiddlewares,
    onPositionChange,
    preventPositionChangeWhenVisible = false,
    onOpenChange,
  } = subOptions;
  const preferredPosition = menuPosition(
    side ?? menuContext.preferredSubmenuSide ?? "right",
    align ?? "start",
  );
  const [resolvedPosition, setResolvedPosition] = useState(preferredPosition);
  const [standaloneOpen, setStandaloneOpen] = useState(false);
  const standalone = menuContext.kind !== "dropdown";
  const { leftSection: itemLeftSection, rightSection: itemRightSection } =
    menuItemSections({
      prefix,
      prefixIcon,
      prefixIconClassName,
      suffix,
      suffixIcon,
      suffixIconClassName,
      checked,
      selected,
      standalone,
    });
  const opensToLeft = resolvedPosition.startsWith("left");
  const disclosureIcon = suffixIcon ? null : (
    <span style={menuIconBaseStyle}>
      <DisclosureTriangleIcon
        aria-hidden="true"
        style={{
          width: menuDisclosureIconSize,
          height: menuDisclosureIconSize,
          transform: opensToLeft ? "rotate(180deg)" : undefined,
        }}
        data-menu-sub-side={opensToLeft ? "left" : "right"}
        data-myoxus-ui-role="menu-sub-disclosure-icon"
      />
    </span>
  );
  const leftSection = opensToLeft ? (
    <>
      {disclosureIcon}
      {itemLeftSection}
    </>
  ) : (
    itemLeftSection
  );
  const rightSection = opensToLeft ? (
    (itemRightSection ?? (
      // Mantine adds a right chevron when rightSection is falsy. An explicit
      // empty section keeps the Facade-owned disclosure solely on the resolved
      // left opening side.
      <span
        aria-hidden="true"
        data-myoxus-ui-role="menu-sub-native-disclosure-suppression"
      />
    ))
  ) : (
    <>
      {itemRightSection}
      {disclosureIcon}
    </>
  );
  const handlePositionChange = useCallback<
    NonNullable<MantineCoreMenuProps["onPositionChange"]>
  >(
    (position) => {
      setResolvedPosition(position);
      onPositionChange?.(position);
    },
    [onPositionChange],
  );
  useEffect(() => {
    setResolvedPosition(preferredPosition);
  }, [preferredPosition]);
  const itemStyle = standalone
    ? standaloneMenuItemStyle({
        type,
        disabled,
        checked,
        selected,
        block,
        style,
      })
    : menuItemStateStyle({ type, disabled, checked, selected, style });

  if (menuContext.kind === "dropdown" && inlineOnNarrow) {
    return (
      <>
        <MenuItem
          {...triggerDomOptions}
          className={className}
          style={style}
          disabled
          type={type}
          prefix={prefix}
          prefixIcon={prefixIcon}
          prefixIconClassName={prefixIconClassName}
          suffix={suffix}
          suffixIcon={suffixIcon}
          suffixIconClassName={suffixIconClassName}
          checked={checked}
          selected={selected}
          block={block}
          data-myoxus-menu-sub-inline-label="true"
        >
          {children}
        </MenuItem>
        {items}
      </>
    );
  }

  if (menuContext.kind === "dropdown") {
    return (
      <MantineMenu.Sub
        opened={open}
        position={preferredPosition}
        offset={menuOffset(sideOffset, alignOffset)}
        middlewares={middlewares}
        openDelay={openDelay}
        closeDelay={closeDelay}
        onChange={onOpenChange}
        onPositionChange={handlePositionChange}
        preventPositionChangeWhenVisible={preventPositionChangeWhenVisible}
        zIndex={cssVar("zIndexPopover")}
      >
        <MantineMenu.Sub.Target>
          <MantineMenu.Sub.Item
            {...filterDomOptions(triggerDomOptions)}
            className={className}
            style={itemStyle}
            disabled={disabled}
            leftSection={leftSection}
            rightSection={rightSection}
            data-myoxus-ui-role="menu-sub-trigger"
          >
            {children}
          </MantineMenu.Sub.Item>
        </MantineMenu.Sub.Target>
        <MantineMenu.Sub.Dropdown
          {...filterDomOptions(subContentDomOptions)}
          className={subContentClassName}
          style={mergeStyles(
            panelWidth ? menuPanelWidthByKind[panelWidth] : undefined,
            panelPadding ? menuPanelPaddingByKind[panelPadding] : undefined,
            subContentStyle,
          )}
          onMouseDown={subContentDomOptions.onMouseDown}
          onTouchStart={subContentDomOptions.onTouchStart}
          onKeyDown={subContentDomOptions.onKeyDown}
          data-myoxus-ui-role="menu-sub-content"
        >
          {items}
        </MantineMenu.Sub.Dropdown>
      </MantineMenu.Sub>
    );
  }

  return (
    <div
      style={{ position: "relative" }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setStandaloneOpen(false);
        }
      }}
    >
      <MantineUnstyledButton
        {...filterDomOptions(triggerDomOptions)}
        component="button"
        type="button"
        className={className}
        style={itemStyle}
        disabled={disabled}
        role="menuitem"
        aria-expanded={standaloneOpen}
        onClick={(event) => {
          triggerDomOptions.onClick?.(event);
          if (!event.defaultPrevented) triggerDomOptions.onSelect?.(event);
          if (!event.defaultPrevented) {
            setStandaloneOpen((open) => !open);
          }
        }}
        data-myoxus-ui-role="menu-sub-trigger"
      >
        {leftSection}
        <span style={standaloneMenuItemLabelStyle}>{children}</span>
        {rightSection}
      </MantineUnstyledButton>
      {standaloneOpen ? (
        <MenuRuntimeContext.Provider value={menuContext}>
          <div
            {...filterDomOptions(subContentDomOptions)}
            className={subContentClassName}
            style={mergeStyles(
              menuSubContentFallbackStyle,
              panelWidth ? menuPanelWidthByKind[panelWidth] : undefined,
              panelPadding ? menuPanelPaddingByKind[panelPadding] : undefined,
              subContentStyle,
            )}
            role="menu"
            data-myoxus-ui-role="menu-sub-content"
          >
            {items}
          </div>
        </MenuRuntimeContext.Provider>
      ) : null}
    </div>
  );
}

export function MobileMenuSub({
  title,
  children,
  items,
  triggerOptions = {},
  subOptions = {},
  subContentOptions = {},
}: MenuSubProps) {
  const id = useId();
  const { suffixIcon, onClick, onSelect, ...otherTriggerOptions } =
    triggerOptions;
  const { addSubMenu } = useMobileSubMenuHelper();
  const subMenuContent = useMemo(
    () => ({
      id,
      title,
      items,
      options: subOptions,
      contentOptions: subContentOptions,
    }),
    [id, items, subContentOptions, subOptions, title],
  );
  const handleClick: MouseEventHandler<HTMLButtonElement> = useCallback(
    (event) => {
      onClick?.(event);
      if (!event.defaultPrevented) onSelect?.(event);
      if (!event.defaultPrevented) addSubMenu(subMenuContent);
    },
    [addSubMenu, onClick, onSelect, subMenuContent],
  );

  useEffect(() => {
    if (subOptions.open) addSubMenu(subMenuContent);
  }, [addSubMenu, subMenuContent, subOptions.open]);

  return (
    <MenuItem
      {...otherTriggerOptions}
      suffixIcon={
        suffixIcon === undefined ? <ArrowRightSmallPlusIcon /> : suffixIcon
      }
      closeMenuOnClick={false}
      onClick={handleClick}
    >
      {children}
    </MenuItem>
  );
}

export type MenuTriggerProps = MyoxusButtonProps & {
  previewFontFamily?: CSSProperties["fontFamily"];
};

export const MenuTrigger = forwardRef(function MenuTrigger(
  {
    children,
    className,
    previewFontFamily,
    suffix,
    style,
    ...props
  }: MenuTriggerProps,
  ref: Ref<HTMLButtonElement>,
) {
  return (
    <Button
      {...props}
      ref={ref}
      className={className}
      suffix={suffix ?? <ArrowDownSmallIcon />}
      style={{
        fontFamily: previewFontFamily,
        ...style,
      }}
      data-myoxus-ui-role={
        props["data-myoxus-ui-role"] ?? "menu-trigger-button"
      }
    >
      {children}
    </Button>
  );
});

export const SplitMenuButton = forwardRef(function SplitMenuButton(
  {
    actionIcon,
    className,
    disabled,
    label,
    menuAriaLabel,
    menuContentOptions,
    menuRootOptions,
    menuItems,
    actionTestId,
    menuTestId,
    onActionAuxClick,
    onClick,
    onPointerDown,
    fluid = true,
    shortcut,
    spacing = "none",
    style,
    variant = "primary",
    ...props
  }: SplitMenuButtonProps,
  ref: Ref<HTMLDivElement>,
) {
  const toneStyles = disabled
    ? disabledButtonToneStyles()
    : buttonToneStyles(variant);
  const mantineVariant = variant === "primary" ? "filled" : "default";
  const buttonVariables = buttonMantineCssVariables(toneStyles);
  const menuLabel =
    menuAriaLabel ??
    `${reactNodeText(label) ?? "Action"} menu`.replace(/\s+/g, " ").trim();
  const borderLeftColor =
    variant === "primary"
      ? cssVar("black10")
      : (toneStyles.borderColor ?? secondaryButtonBorderColor());

  return (
    <div
      {...props}
      ref={ref}
      className={className}
      data-myoxus-ui-role={props["data-myoxus-ui-role"] ?? "split-menu-button"}
      // Nested split-menu triggers must not bubble into an enclosing Mantine menu.
      onClick={(event) => {
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        event.stopPropagation();
      }}
      style={mergeStyles(
        splitMenuButtonRootStyle,
        fluid ? undefined : splitMenuButtonInlineStyle,
        spacing === "section" ? splitMenuButtonSectionSpacingStyle : undefined,
        style,
      )}
    >
      <MantineButton
        disabled={disabled}
        data-testid={actionTestId}
        onAuxClick={onActionAuxClick}
        onClick={onClick}
        variant={mantineVariant}
        data-myoxus-ui-role="split-menu-button-action"
        style={buttonVariables}
        styles={{
          label: splitMenuButtonLabelStyle,
          root: {
            ...toneStyles,
            borderColor: toneStyles.borderColor,
            borderRadius: splitMenuButtonRadius,
            ...splitMenuButtonActionRootStyle,
            fontFamily:
              "var(--mantine-font-family-body-small, var(--mantine-font-family))",
            fontSize:
              "var(--mantine-font-size-body-small, var(--mantine-font-size-md))",
            fontWeight:
              "var(--mantine-font-weight-body-small, var(--mantine-font-weight-regular))",
            lineHeight:
              "var(--mantine-line-height-body-small, var(--mantine-line-height-md))",
          },
        }}
      >
        <span style={splitMenuButtonLabelStyle}>
          {actionIcon ? (
            <span style={splitMenuButtonActionIconStyle}>
              {renderSizedIconElement(actionIcon)}
            </span>
          ) : null}
          <span style={splitMenuButtonTextStyle}>{label}</span>
          {shortcut ? (
            <span style={splitMenuButtonShortcutStyle}>{shortcut}</span>
          ) : null}
        </span>
      </MantineButton>
      <Menu
        rootOptions={menuRootOptions}
        contentOptions={{
          align: "end",
          ...menuContentOptions,
        }}
        items={menuItems}
      >
        <MantineButton
          aria-label={menuLabel}
          data-testid={menuTestId}
          disabled={disabled}
          variant={mantineVariant}
          data-myoxus-ui-role="split-menu-button-trigger"
          style={buttonVariables}
          styles={{
            label: {
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            },
            root: {
              ...toneStyles,
              borderColor: toneStyles.borderColor,
              borderLeft: `1px solid ${borderLeftColor}`,
              borderRadius: splitMenuButtonRadius,
              ...splitMenuButtonTriggerRootStyle,
            },
          }}
        >
          <ArrowDownSmallIcon
            aria-hidden="true"
            style={splitMenuButtonIconStyle}
          />
        </MantineButton>
      </Menu>
    </div>
  );
});

export function ContextMenu({
  children,
  items,
  contentProps = {},
  asChild,
  disabled,
  onOpenChange,
}: ContextMenuProps) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const {
    className,
    style,
    side,
    align,
    sideOffset,
    alignOffset,
    ...contentDomOptions
  } = contentProps;
  const close = useCallback(() => {
    setPosition(null);
    onOpenChange?.(false);
  }, [onOpenChange]);
  const preferredPosition = menuPosition(side ?? "bottom", align ?? "start");
  const [resolvedPosition, setResolvedPosition] = useState(preferredPosition);
  const menuRuntimeContextValue = useMemo<MenuRuntimeContext>(
    () => ({
      kind: "dropdown",
      close,
      preferredSubmenuSide: submenuSideForParentPosition(resolvedPosition),
    }),
    [close, resolvedPosition],
  );

  useEffect(() => {
    setResolvedPosition(preferredPosition);
  }, [preferredPosition]);

  useEffect(() => {
    if (!position) return;

    const handlePointerDown = () => close();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, position]);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      setResolvedPosition(preferredPosition);
      setPosition({ x: event.clientX, y: event.clientY });
      onOpenChange?.(true);
    },
    [disabled, onOpenChange, preferredPosition],
  );

  const child = isValidElement<HTMLAttributes<HTMLElement>>(children)
    ? cloneElement(children, {
        onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
          children.props.onContextMenu?.(event);
          if (!event.defaultPrevented) handleContextMenu(event);
        },
      })
    : children;

  const trigger = asChild ? (
    child
  ) : (
    <span onContextMenu={handleContextMenu}>{children}</span>
  );

  return (
    <>
      {trigger}
      {position ? (
        <MenuRuntimeContext.Provider value={menuRuntimeContextValue}>
          <MantineMenu
            opened
            onChange={(open) => {
              if (!open) close();
            }}
            closeOnItemClick
            closeOnEscape
            loop
            withinPortal
            position={preferredPosition}
            onPositionChange={setResolvedPosition}
            offset={menuOffset(sideOffset ?? 0, alignOffset)}
            shadow="md"
            zIndex={cssVar("zIndexPopover")}
          >
            <MantineMenu.Target>
              <span
                aria-hidden="true"
                style={{
                  position: "fixed",
                  left: position.x,
                  top: position.y,
                  width: 1,
                  height: 1,
                  pointerEvents: "none",
                }}
              />
            </MantineMenu.Target>
            <MantineMenu.Dropdown
              {...filterDomOptions(contentDomOptions)}
              className={className}
              style={mergeStyles(menuContextContentStyle, style)}
              data-myoxus-ui-role="context-menu-content"
              onPointerDown={(event) => event.stopPropagation()}
            >
              {items}
            </MantineMenu.Dropdown>
          </MantineMenu>
        </MenuRuntimeContext.Provider>
      ) : null}
    </>
  );
}
