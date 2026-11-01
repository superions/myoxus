// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type ReactNode,
  type CSSProperties,
  type ComponentProps,
  forwardRef,
  type Ref,
  type MouseEventHandler,
  type ButtonHTMLAttributes,
  cloneElement,
  isValidElement,
  type ReactElement,
} from "react";
import {
  ActionIconGroup as MantineActionIconGroup,
  ActionIcon,
  Tooltip as MantineTooltip,
  Button as MantineButton,
} from "@mantine/core";
import { type MyoxusUiRoleProp } from "./helpers/ui-role";
import { cssVar, cssTypographyVar } from "@myoxus/theme";
import {
  accessibleTooltipLabel,
  humanizeAccessibleToken,
  renderTooltipLabel,
  floatingPosition,
} from "./helpers/tooltip";
import { reactNodeText } from "./helpers/accessibility";
import { joinClassName } from "./helpers/class-name";

const primaryButtonTextColor = () =>
  "var(--myoxus-sem-button-primary-fg, var(--myoxus-branding-button-primary-fg, var(--myoxus-pure-white)))";

const primaryButtonBackgroundColor = () =>
  "var(--myoxus-sem-button-primary-bg, var(--myoxus-primary-color))";

const secondaryButtonBackgroundColor = () => "var(--mantine-color-default)";

const secondaryButtonTextColor = () => "var(--mantine-color-default-color)";

export const secondaryButtonBorderColor = () =>
  "var(--mantine-color-default-border)";

const secondaryButtonHoverBackgroundColor = () =>
  "var(--mantine-color-default-hover)";

const plainButtonTextColor = () =>
  "var(--myoxus-sem-button-plain-fg, var(--myoxus-link-color, var(--myoxus-text-primary-color)))";

const errorButtonBackgroundColor = () =>
  "var(--myoxus-sem-button-error-bg, var(--myoxus-error-color))";

const successButtonBackgroundColor = () =>
  "var(--myoxus-sem-button-success-bg, var(--myoxus-success-color, var(--myoxus-accent-secondary)))";

const disabledButtonBackgroundColor = () =>
  "var(--myoxus-sem-button-disabled-bg, var(--myoxus-background-secondary-color))";

const disabledButtonTextColor = () =>
  "var(--myoxus-sem-button-disabled-fg, var(--myoxus-text-secondary-color))";

export type ButtonToneStyles = Pick<
  CSSProperties,
  "background" | "borderColor" | "color"
> & {
  borderWidth?: string;
  hoverBackground?: string;
  hoverColor?: string;
};

/**
 * Resolve semantic button tones through the server-owned Myoxus variables.
 * This helper is shared with compound button compositions in the Facade.
 */
export function buttonToneStyles(
  semanticVariant:
    "primary" | "secondary" | "plain" | "error" | "success" | "custom",
): ButtonToneStyles {
  switch (semanticVariant) {
    case "primary":
      return {
        background: primaryButtonBackgroundColor(),
        borderColor: primaryButtonBackgroundColor(),
        color: primaryButtonTextColor(),
        hoverBackground:
          "var(--myoxus-btn-primary-hover-bg, var(--myoxus-sem-button-primary-bg, var(--myoxus-primary-color)))",
        hoverColor:
          "var(--myoxus-btn-primary-hover-fg, var(--myoxus-sem-button-primary-fg, var(--myoxus-pure-white)))",
      };
    case "error":
      return {
        background: errorButtonBackgroundColor(),
        borderColor: errorButtonBackgroundColor(),
        color: primaryButtonTextColor(),
        hoverBackground:
          "var(--myoxus-btn-destructive-hover-bg, var(--myoxus-error-color))",
        hoverColor:
          "var(--myoxus-btn-destructive-hover-fg, var(--myoxus-pure-white))",
      };
    case "success":
      return {
        background: successButtonBackgroundColor(),
        borderColor: successButtonBackgroundColor(),
        color: primaryButtonTextColor(),
      };
    case "plain":
      return {
        background: "transparent",
        borderColor: "transparent",
        color: plainButtonTextColor(),
      };
    case "secondary":
      return {
        background: secondaryButtonBackgroundColor(),
        borderColor: secondaryButtonBorderColor(),
        color: secondaryButtonTextColor(),
        hoverBackground: secondaryButtonHoverBackgroundColor(),
      };
    case "custom":
      return {};
  }
}

export function disabledButtonToneStyles(): ButtonToneStyles {
  return {
    background: disabledButtonBackgroundColor(),
    borderColor: disabledButtonBackgroundColor(),
    color: disabledButtonTextColor(),
  };
}

export function buttonMantineCssVariables(
  toneStyles: ButtonToneStyles,
): CSSProperties & Record<`--${string}`, string | undefined> {
  const color = toneStyles.color?.toString();
  const background = toneStyles.background?.toString();
  const borderColor = toneStyles.borderColor?.toString();
  const hoverBackground = toneStyles.hoverBackground?.toString() ?? background;
  const hoverColor = toneStyles.hoverColor?.toString() ?? color;
  const borderWidth =
    toneStyles.borderWidth ?? "calc(var(--mantine-scale) * 1px)";

  return {
    "--button-bg": background,
    "--button-hover": hoverBackground,
    "--button-color": color,
    "--button-hover-color": hoverColor,
    "--button-bd": borderColor
      ? `${borderWidth} solid ${borderColor}`
      : undefined,
  };
}

export type MyoxusButtonSection = ReactElement<{
  className?: string;
  height?: number | string;
  size?: number | string;
  style?: CSSProperties;
  width?: number | string;
}>;

/**
 * Normalize shared icon geometry at the Facade boundary. The helper remains
 * internal to Facade modules and is not re-exported as product API.
 */
export function renderSizedIconElement(
  icon: ReactNode,
  {
    className,
    forceSize = false,
    size = "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
    style,
  }: {
    className?: string;
    forceSize?: boolean;
    size?: number | string;
    style?: CSSProperties;
  } = {},
) {
  if (!isValidElement(icon)) return icon;
  const cssVariableSize =
    typeof size === "string" && size.includes("var(") ? size : undefined;
  const attributeSize = cssVariableSize ? "1em" : size;
  const props = icon.props as {
    className?: string;
    height?: number | string;
    size?: number | string;
    style?: CSSProperties;
    width?: number | string;
  };
  return cloneElement(icon as MyoxusButtonSection, {
    className: joinClassName(props.className, className),
    height: forceSize
      ? attributeSize
      : (props.height ?? props.size ?? attributeSize),
    size: forceSize ? attributeSize : (props.size ?? attributeSize),
    style: {
      ...props.style,
      ...(cssVariableSize
        ? { height: cssVariableSize, width: cssVariableSize }
        : undefined),
      ...style,
    },
    width: forceSize
      ? attributeSize
      : (props.width ?? props.size ?? attributeSize),
  });
}

export type MyoxusButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "prefix"
> & {
  "data-myoxus-ui-role"?: string;
  [key: `data-${string}`]: unknown;
  prefix?: MyoxusButtonSection;
  suffix?: MyoxusButtonSection;
  prefixStyle?: CSSProperties;
  suffixStyle?: CSSProperties;
  prefixClassName?: string;
  suffixClassName?: string;
  block?: boolean;
  loading?: boolean;
  justifyContent?: CSSProperties["justifyContent"];
  textTransform?: CSSProperties["textTransform"];
  variant?:
    | "primary"
    | "secondary"
    | "plain"
    | "error"
    | "success"
    | "custom"
    | "default"
    | "outline"
    | "destructive"
    | "ghost"
    | "link";
  size?: "default" | "large" | "extraLarge" | "custom" | number | string;
  tooltip?: ReactNode;
  tooltipShortcut?: string[];
  tooltipOptions?: {
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
    [key: string]: unknown;
  };
};

/**
 * Shared action button. Historical variant aliases are normalized at the
 * boundary into the Myoxus semantic tone set before Mantine renders.
 */
export const MyoxusButton = forwardRef(function MyoxusButton(
  {
    "data-myoxus-ui-role": uiRole,
    prefix,
    suffix,
    prefixStyle,
    suffixStyle,
    prefixClassName,
    suffixClassName,
    block,
    justifyContent,
    loading,
    variant = "secondary",
    size = "default",
    tooltip,
    tooltipShortcut,
    tooltipOptions,
    textTransform,
    ...buttonProps
  }: MyoxusButtonProps,
  ref: Ref<HTMLButtonElement>,
) {
  const { style: buttonStyle, ...buttonRestProps } = buttonProps;
  const roleBySize: Record<
    "default" | "large" | "extraLarge" | "custom",
    string
  > = {
    default: "button:compact",
    large: "button:standard",
    extraLarge: "button:prominent",
    custom: "button:custom",
  };
  const semanticSize =
    size === "large" || size === "extraLarge" || size === "custom"
      ? size
      : "default";
  const semanticVariant =
    variant === "default"
      ? "primary"
      : variant === "outline"
        ? "secondary"
        : variant === "destructive"
          ? "error"
          : variant === "ghost" || variant === "link"
            ? "plain"
            : variant;
  const mantineVariant =
    semanticVariant === "plain"
      ? "subtle"
      : semanticVariant === "primary" ||
          semanticVariant === "error" ||
          semanticVariant === "success"
        ? "filled"
        : "default";
  const toneStyles = buttonToneStyles(semanticVariant);
  const effectiveToneStyles = buttonRestProps.disabled
    ? disabledButtonToneStyles()
    : toneStyles;
  const controlHeight =
    semanticSize === "extraLarge"
      ? "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))"
      : semanticSize === "large"
        ? "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))"
        : "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))";
  const visibleButtonText = reactNodeText(buttonProps.children as ReactNode);
  const inferredAriaLabel =
    buttonProps["aria-label"] ??
    (visibleButtonText
      ? undefined
      : (accessibleTooltipLabel(tooltip) ??
        humanizeAccessibleToken(buttonProps.title) ??
        humanizeAccessibleToken(buttonProps["data-testid"])));
  const button = (
    <MantineButton
      {...buttonRestProps}
      aria-label={inferredAriaLabel}
      ref={ref}
      loading={loading}
      fullWidth={block}
      leftSection={renderSizedIconElement(prefix, {
        className: prefixClassName,
        style: prefixStyle,
      })}
      rightSection={renderSizedIconElement(suffix, {
        className: suffixClassName,
        style: suffixStyle,
      })}
      variant={mantineVariant}
      data-myoxus-ui-role={uiRole ?? roleBySize[semanticSize]}
      style={{
        ...(buttonStyle as CSSProperties | undefined),
        ...buttonMantineCssVariables(effectiveToneStyles),
      }}
      styles={{
        root: {
          height: controlHeight,
          minHeight: controlHeight,
          ...effectiveToneStyles,
          cursor: buttonRestProps.disabled ? "not-allowed" : undefined,
          borderRadius:
            semanticSize === "default" ? "var(--mantine-radius-sm)" : undefined,
          gap:
            semanticSize === "default"
              ? "var(--mantine-spacing-xs)"
              : undefined,
          flexShrink: block ? undefined : 0,
          justifyContent,
          paddingInline:
            semanticSize === "extraLarge"
              ? "var(--mantine-spacing-lg)"
              : "var(--mantine-spacing-md)",
          textTransform,
          minWidth: block ? undefined : "max-content",
        },
      }}
    />
  );
  if (!tooltip) return button;
  return (
    <MantineTooltip
      label={renderTooltipLabel(tooltip, tooltipShortcut)}
      position={floatingPosition(tooltipOptions?.side, tooltipOptions?.align)}
    >
      {button}
    </MantineTooltip>
  );
});

export const Button = MyoxusButton;
export type ButtonProps = MyoxusButtonProps;

export type MyoxusIconButtonProps = Omit<
  MyoxusButtonProps,
  "children" | "size" | "variant"
> & {
  children?: ReactNode;
  icon?: ReactNode;
  iconStyle?: CSSProperties;
  size?: MyoxusButtonProps["size"] | "small";
  variant?: MyoxusButtonProps["variant"] | "danger" | "solid";
  iconClassName?: string;
  tooltipShortcut?: string[];
  tooltipOptions?: {
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
    [key: string]: unknown;
  };
  withoutHover?: boolean;
};

export type IconButtonGroupProps = ComponentProps<
  typeof MantineActionIconGroup
> &
  MyoxusUiRoleProp;

/**
 * Native Mantine grouping for related icon-only actions. Consumers keep action
 * semantics and ordering while Mantine owns the connected control chrome.
 */
export function IconButtonGroup({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "icon-button-group",
  ...props
}: IconButtonGroupProps) {
  return (
    <MantineActionIconGroup
      {...props}
      data-myoxus-ui-role={uiRole}
      style={style}
    >
      {children}
    </MantineActionIconGroup>
  );
}

const iconButtonRoleSize = (
  size: MyoxusButtonProps["size"],
  style: MyoxusIconButtonProps["style"],
) => {
  const numericStyleSize =
    typeof style?.height === "number"
      ? style.height
      : typeof style?.width === "number"
        ? style.width
        : undefined;
  const effectiveSize = numericStyleSize ?? size;
  if (typeof effectiveSize === "number") {
    return Math.round(effectiveSize);
  }
  if (
    typeof effectiveSize === "string" &&
    /^\d+(?:\.\d+)?$/.test(effectiveSize)
  ) {
    return Math.round(Number(effectiveSize));
  }
  return "custom";
};

export const IconButton = forwardRef(function IconButton(
  {
    children,
    icon,
    size = "default",
    disabled,
    onClick,
    "data-myoxus-ui-role": uiRole,
    prefix: _prefix,
    suffix: _suffix,
    block: _block,
    loading: _loading,
    variant = "plain",
    iconClassName,
    iconStyle,
    tooltip,
    tooltipShortcut,
    tooltipOptions,
    withoutHover,
    style,
    ...props
  }: MyoxusIconButtonProps,
  ref: Ref<HTMLButtonElement>,
) {
  // The role includes effective icon size so visual QA can catch accidental
  // scale drift across sidebars, menus and toolbars.
  const pxSize =
    size === "extraLarge"
      ? 40
      : size === "large"
        ? 34
        : size === "custom"
          ? 30
          : size === "default"
            ? 28
            : size === "small"
              ? 24
              : size;
  const iconSemanticVariant =
    variant === "danger" || variant === "error"
      ? "error"
      : variant === "solid" || variant === "primary"
        ? "primary"
        : variant === "success"
          ? "success"
          : "plain";
  const isFilledIconButton =
    iconSemanticVariant === "primary" ||
    iconSemanticVariant === "error" ||
    iconSemanticVariant === "success";
  // Native disabled appearance must win over the enabled semantic tone.
  const iconToneStyles = disabled
    ? undefined
    : isFilledIconButton
      ? buttonToneStyles(iconSemanticVariant)
      : { color: cssVar("iconColor") };
  const defaultUiRole = `button:icon-only:${iconButtonRoleSize(pxSize, style)}`;
  const iconSize =
    size === "extraLarge"
      ? "var(--mantine-spacing-xl)"
      : size === "small"
        ? "var(--mantine-spacing-lg)"
        : size === "default" || size === "large" || size === "custom"
          ? "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"
          : undefined;
  const inferredAriaLabel =
    props["aria-label"] ??
    accessibleTooltipLabel(tooltip) ??
    humanizeAccessibleToken(props.title) ??
    humanizeAccessibleToken(props["data-testid"]) ??
    humanizeAccessibleToken(props["data-event-args-control"]);
  const button = (
    <ActionIcon
      ref={ref}
      aria-label={inferredAriaLabel}
      variant={
        withoutHover && !isFilledIconButton
          ? "transparent"
          : variant === "solid" || variant === "primary"
            ? "filled"
            : variant === "secondary" || variant === "default"
              ? "default"
              : "subtle"
      }
      disabled={disabled}
      onClick={onClick as MouseEventHandler<HTMLButtonElement>}
      size={pxSize}
      data-myoxus-ui-role={uiRole ?? defaultUiRole}
      style={{
        ...(style as CSSProperties | undefined),
        ...iconToneStyles,
        fontWeight: cssTypographyVar("body-small", "weight", "400"),
        lineHeight: "1",
      }}
      {...props}
    >
      <span className={iconClassName} style={iconStyle}>
        {iconSize
          ? renderSizedIconElement(children ?? icon, { size: iconSize })
          : (children ?? icon)}
      </span>
    </ActionIcon>
  );
  if (!tooltip) return button;
  return (
    <MantineTooltip
      label={renderTooltipLabel(tooltip, tooltipShortcut)}
      opened={
        typeof tooltipOptions?.opened === "boolean"
          ? tooltipOptions.opened
          : undefined
      }
      position={floatingPosition(tooltipOptions?.side, tooltipOptions?.align)}
    >
      {button}
    </MantineTooltip>
  );
});

export type IconButtonProps = MyoxusIconButtonProps;
