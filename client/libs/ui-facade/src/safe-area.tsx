// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type HTMLAttributes, forwardRef, type CSSProperties } from "react";
import { withUnit } from "./css-utils";
import { joinClassName } from "./helpers/class-name";

export interface SafeAreaProps extends HTMLAttributes<HTMLDivElement> {
  top?: boolean;
  bottom?: boolean;
  topOffset?: number | string;
  bottomOffset?: number | string;
}

export const SafeArea = forwardRef<HTMLDivElement, SafeAreaProps>(
  function SafeArea(
    {
      children,
      className,
      style,
      top,
      bottom,
      topOffset = 0,
      bottomOffset = 0,
      ...attrs
    },
    ref,
  ) {
    const standalone =
      environment.isPwa || BUILD_CONFIG.isAndroid || BUILD_CONFIG.isIOS;
    const offsetVars = {
      "--myoxus-ui-safe-area-top-offset": withUnit(topOffset, "px"),
      "--myoxus-ui-safe-area-bottom-offset": withUnit(bottomOffset, "px"),
    } as CSSProperties;

    return (
      <div
        ref={ref}
        className={joinClassName("myoxus-ui-safe-area", className)}
        data-standalone={standalone ? "" : undefined}
        data-bottom={bottom ? "" : undefined}
        data-top={top ? "" : undefined}
        style={{ ...style, ...offsetVars }}
        {...attrs}
      >
        {children}
      </div>
    );
  },
);
