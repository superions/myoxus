// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type ReactNode,
  type ComponentProps,
  type CSSProperties,
  type ReactElement,
} from "react";
import { Tooltip as MantineTooltip } from "@mantine/core";
import { reactNodeText } from "./accessibility";

export type TooltipSide = "top" | "right" | "bottom" | "left";
export type TooltipAlign = "start" | "center" | "end";

export function floatingPosition(
  side?: TooltipSide,
  align?: TooltipAlign,
): ComponentProps<typeof MantineTooltip>["position"] {
  if (!side) return undefined;
  return (
    align && align !== "center" ? `${side}-${align}` : side
  ) as ComponentProps<typeof MantineTooltip>["position"];
}

export function renderTooltipLabel(content: ReactNode, shortcut?: string[]) {
  if (!shortcut?.length) return content;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span>{content}</span>
      <span style={{ opacity: 0.72 }}>{shortcut.join(" + ")}</span>
    </span>
  );
}

export function accessibleTooltipLabel(tooltip: ReactNode): string | undefined {
  return reactNodeText(tooltip);
}

export function humanizeAccessibleToken(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value
    .replace(/^mx-/, "")
    .replace(/[-_:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function Tooltip({
  align,
  children,
  content,
  events,
  options,
  rootOptions,
  shortcut,
  side,
}: PropsWithChildren<{
  align?: TooltipAlign;
  content?: ReactNode;
  events?: ComponentProps<typeof MantineTooltip>["events"];
  options?: {
    alignOffset?: number;
    className?: string;
    sideOffset?: number;
    style?: CSSProperties;
  };
  rootOptions?: { delayDuration?: number };
  shortcut?: string[];
  side?: TooltipSide;
}>) {
  if (!content) return children;
  return (
    <MantineTooltip
      classNames={{ tooltip: options?.className }}
      label={renderTooltipLabel(content, shortcut)}
      events={events}
      offset={options?.sideOffset}
      openDelay={rootOptions?.delayDuration}
      position={floatingPosition(side, align)}
      styles={options?.style ? { tooltip: options.style } : undefined}
    >
      {children as ReactElement}
    </MantineTooltip>
  );
}
