// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  cloneElement,
  type ComponentType,
  type CSSProperties,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type SVGProps,
  useEffect,
  useSyncExternalStore,
} from "react";

import { type IconData, IconType } from "./icon-data";
import {
  getIconCatalogSnapshot,
  getServerIconCatalogSnapshot,
  loadIconCatalog,
  subscribeIconCatalog,
} from "./icon-catalog";

type IconVisualProps = {
  className?: string;
  color?: string;
  height?: number | string;
  size?: number | string;
  style?: CSSProperties;
  width?: number | string;
};

type IconElementProps = Omit<IconVisualProps, "color">;

function joinClassName(...parts: Array<string | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function mergeColorStyle(
  color: string | undefined,
  style: CSSProperties | undefined,
): CSSProperties | undefined {
  if (!color) return style;
  return { ...style, color };
}

function renderFallbackIcon(
  fallback: ReactNode,
  { className, height, size, style, width }: IconVisualProps,
) {
  if (!isValidElement(fallback)) return fallback ?? null;
  if (
    !className &&
    height === undefined &&
    size === undefined &&
    !style &&
    width === undefined
  ) {
    return fallback;
  }

  const props = fallback.props as IconElementProps;
  const mergedClassName = joinClassName(props.className, className);
  const mergedStyle = style ? { ...props.style, ...style } : props.style;

  return cloneElement(fallback as ReactElement<IconElementProps>, {
    className: mergedClassName || undefined,
    height: height ?? props.height ?? props.size ?? size,
    size: props.size ?? size,
    style: mergedStyle,
    width: width ?? props.width ?? props.size ?? size,
  });
}

function MyoxusIconRenderer({
  className,
  color,
  height,
  fallback,
  name,
  size,
  style,
  width,
}: IconVisualProps & { name: string; fallback?: ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribeIconCatalog,
    getIconCatalogSnapshot,
    getServerIconCatalogSnapshot,
  );
  useEffect(() => {
    if (snapshot.status === "idle") loadIconCatalog();
  }, [snapshot.status]);
  if (snapshot.status !== "ready") {
    const visual = {
      className,
      height,
      size,
      style: mergeColorStyle(color, style),
      width,
    };
    if (fallback !== undefined) return renderFallbackIcon(fallback, visual);
    const resolvedWidth = width ?? size ?? "1em";
    const resolvedHeight = height ?? size ?? "1em";
    const variableWidth =
      typeof resolvedWidth === "string" && resolvedWidth.includes("var(");
    const variableHeight =
      typeof resolvedHeight === "string" && resolvedHeight.includes("var(");
    // Retain the glyph's slot while delivery is pending or failed. Variable
    // dimensions follow the canonical adapter's SVG/style projection.
    return (
      <svg
        aria-hidden="true"
        className={className}
        width={variableWidth ? "1em" : resolvedWidth}
        height={variableHeight ? "1em" : resolvedHeight}
        style={{
          ...visual.style,
          ...(variableWidth ? { width: resolvedWidth } : {}),
          ...(variableHeight ? { height: resolvedHeight } : {}),
        }}
      />
    );
  }
  const Icon = snapshot.catalog[
    `${name}Icon` as keyof typeof snapshot.catalog
  ] as
    | ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>
    | undefined;

  if (!Icon) {
    return null;
  }

  return (
    <Icon
      className={className}
      height={height ?? size}
      size={size}
      style={mergeColorStyle(color, style)}
      width={width ?? size}
    />
  );
}

export function IconRenderer({
  className,
  data,
  fallback,
  height,
  size,
  style,
  width,
}: {
  data?: IconData;
  fallback?: ReactNode;
} & IconVisualProps) {
  if (!data) {
    return renderFallbackIcon(fallback, {
      className,
      height,
      size,
      style,
      width,
    });
  }

  if (data.type === IconType.Emoji && data.unicode) {
    if (className || height || size || style || width) {
      const emojiStyle =
        size === undefined
          ? style
          : { ...style, fontSize: size, lineHeight: 1 };
      return (
        <span className={className} style={emojiStyle}>
          {data.unicode}
        </span>
      );
    }
    return data.unicode;
  }

  if (data.type === IconType.MyoxusIcon && data.name) {
    return (
      <MyoxusIconRenderer
        fallback={fallback}
        className={className}
        color={data.color}
        height={height}
        name={data.name}
        size={size}
        style={style}
        width={width}
      />
    );
  }

  return renderFallbackIcon(fallback, {
    className,
    height,
    size,
    style,
    width,
  });
}
