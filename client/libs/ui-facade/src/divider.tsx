// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Divider as MantineDivider } from "@mantine/core";
import type { CSSProperties, HTMLAttributes } from "react";

type DividerSpaceName = "none" | "xs" | "sm" | "md" | "lg" | "xl";
type DividerSpace = DividerSpaceName | number | (string & {});

const dividerSpaceBySize: Record<DividerSpaceName, CSSProperties["margin"]> = {
  none: 0,
  xs: "var(--mantine-spacing-2xs)",
  sm: "var(--mantine-spacing-xs)",
  md: "var(--mantine-spacing-sm)",
  lg: "var(--mantine-spacing-md)",
  xl: "var(--mantine-spacing-lg)",
};

function resolveDividerSpace(space: DividerSpace): CSSProperties["margin"] {
  if (typeof space === "number") {
    // Legacy callers still pass raw spacing numbers. New product code should
    // use named/token spaces so divider rhythm remains theme-owned.
    return `${space}px`;
  }
  return space in dividerSpaceBySize
    ? dividerSpaceBySize[space as DividerSpaceName]
    : space;
}

export function Divider({
  orientation = "horizontal",
  space = "sm",
  className,
  style,
  ...props
}: {
  orientation?: "horizontal" | "vertical" | string;
  size?: "thinner" | "default";
  space?: DividerSpace;
  dividerColor?: string;
  className?: string;
  style?: CSSProperties;
} & HTMLAttributes<HTMLDivElement>) {
  const resolvedSpace = resolveDividerSpace(space);
  return (
    <MantineDivider
      {...props}
      orientation={orientation === "vertical" ? "vertical" : "horizontal"}
      className={className}
      style={{
        margin: orientation === "horizontal" ? `${resolvedSpace} 0` : 0,
        ...style,
      }}
      data-myoxus-ui-role="settings-divider"
    />
  );
}
