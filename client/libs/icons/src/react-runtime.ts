// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ComponentType, CSSProperties, SVGProps } from "react";
import { createElement } from "react";

export type MyoxusIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
};

type SourceIcon = ComponentType<SVGProps<SVGSVGElement>>;
type IconStyle = CSSProperties & {
  "--myoxus-icon-stroke-width"?: number | string;
};

function isCssVariableLength(value: number | string | undefined) {
  return typeof value === "string" && value.includes("var(");
}

/**
 * Adapt canonical SVG glyphs without changing their geometry. Explicit width
 * and height take precedence over size. CSS-variable dimensions are projected
 * into style; explicit caller stroke variables override strokeWidth. Absolute
 * stroke behavior remains unchanged.
 */
export function createMyoxusIcon(Icon: SourceIcon, displayName: string) {
  const MyoxusIcon = ({
    absoluteStrokeWidth: _absoluteStrokeWidth,
    height,
    size,
    strokeWidth,
    style,
    width,
    ...props
  }: MyoxusIconProps) => {
    const resolvedWidth = width ?? size;
    const resolvedHeight = height ?? size;
    const nextStyle: IconStyle =
      strokeWidth === undefined
        ? { ...style }
        : {
            "--myoxus-icon-stroke-width": strokeWidth,
            ...style,
          };
    const nextProps: SVGProps<SVGSVGElement> = {
      ...props,
      style: nextStyle,
    };

    if (resolvedWidth !== undefined) {
      if (isCssVariableLength(resolvedWidth)) {
        nextProps.width = "1em";
        nextStyle.width = resolvedWidth;
      } else {
        nextProps.width = resolvedWidth;
      }
    }
    if (resolvedHeight !== undefined) {
      if (isCssVariableLength(resolvedHeight)) {
        nextProps.height = "1em";
        nextStyle.height = resolvedHeight;
      } else {
        nextProps.height = resolvedHeight;
      }
    }

    return createElement(Icon, nextProps);
  };

  MyoxusIcon.displayName = displayName;
  return MyoxusIcon;
}
