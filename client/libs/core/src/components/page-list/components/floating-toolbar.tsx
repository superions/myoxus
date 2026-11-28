// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  Button,
  type ButtonProps,
  IconButton,
  type IconButtonProps,
  MyoxusText,
  ToolbarSurface,
} from "@myoxus/ui-facade";
import {
  type CSSProperties,
  isValidElement,
  type MouseEventHandler,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
  type SVGAttributes,
} from "react";

export interface FloatingToolbarProps {
  className?: string;
  style?: CSSProperties;
  open?: boolean;
  placement?: "inline" | "bottom-overlay";
}

export interface FloatingToolbarButtonProps extends Omit<
  ButtonProps,
  "children" | "onClick" | "prefix" | "suffix" | "type" | "variant"
> {
  icon: IconButtonProps["icon"];
  onClick: MouseEventHandler<HTMLButtonElement>;
  type?: "danger" | "default";
  label?: ReactNode;
  tooltip?: ReactNode;
}

const asSvgElement = (
  icon: ReactNode,
): ReactElement<SVGAttributes<SVGElement>> | undefined =>
  isValidElement<SVGAttributes<SVGElement>>(icon) ? icon : undefined;

export function FloatingToolbar({
  children,
  style,
  className,
  open,
  placement = "inline",
}: PropsWithChildren<FloatingToolbarProps>) {
  if (!open) return null;

  return (
    <ToolbarSurface
      className={className}
      style={style}
      placement={placement}
      role="toolbar"
      data-testid="floating-toolbar"
      data-myoxus-ui-role="page-list-selection-toolbar"
    >
      {children}
    </ToolbarSurface>
  );
}

export function FloatingToolbarItem({ children }: PropsWithChildren) {
  return (
    <MyoxusText component="span" tone="secondary" typographySlot="body-small">
      {children}
    </MyoxusText>
  );
}

export function FloatingToolbarButton({
  icon,
  type,
  onClick,
  className,
  style,
  label,
  ...props
}: FloatingToolbarButtonProps) {
  if (label) {
    return (
      <Button
        type="button"
        onClick={onClick}
        className={className}
        style={style}
        variant={type === "danger" ? "error" : "plain"}
        prefix={asSvgElement(icon)}
        {...props}
      >
        {label}
      </Button>
    );
  }

  return (
    <IconButton
      type="button"
      onClick={onClick}
      className={className}
      style={style}
      variant={type === "danger" ? "danger" : "plain"}
      icon={icon}
      {...props}
    />
  );
}

export function FloatingToolbarSeparator() {
  return null;
}

FloatingToolbar.Item = FloatingToolbarItem;
FloatingToolbar.Separator = FloatingToolbarSeparator;
FloatingToolbar.Button = FloatingToolbarButton;
