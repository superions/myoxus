import {
  Button,
  type ButtonProps,
  IconButton,
  type IconButtonProps,
  MyoxusText,
  ToolbarSurface,
} from "@myoxus/ui-facade";
import type {
  CSSProperties,
  MouseEventHandler,
  PropsWithChildren,
  ReactElement,
  ReactNode,
  SVGAttributes,
} from "react";
import { isValidElement } from "react";

interface FloatingToolbarProps {
  className?: string;
  style?: CSSProperties;
  open?: boolean;
  placement?: "inline" | "bottom-overlay";
}

interface FloatingToolbarButtonProps extends Omit<
  ButtonProps,
  "children" | "onClick" | "prefix" | "suffix" | "type" | "variant"
> {
  icon: IconButtonProps["icon"];
  onClick: MouseEventHandler<HTMLButtonElement>;
  type?: "danger" | "default";
  label?: ReactNode;
  tooltip?: ReactNode;
}

interface FloatingToolbarItemProps {}

function svgToolbarIcon(
  icon: ReactNode,
): ReactElement<SVGAttributes<SVGElement>> | undefined {
  return isValidElement<SVGAttributes<SVGElement>>(icon) ? icon : undefined;
}

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

// Count and selection copy stay plain text; controls are separate toolbar items.
export function FloatingToolbarItem({
  children,
}: PropsWithChildren<FloatingToolbarItemProps>) {
  return (
    <MyoxusText component="span" tone="secondary" typographySlot="body-small">
      {children}
    </MyoxusText>
  );
}

// a typical button that has icon and label
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
        prefix={svgToolbarIcon(icon)}
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
