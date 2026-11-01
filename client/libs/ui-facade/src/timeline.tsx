// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Timeline as MantineTimeline } from "@mantine/core";

export function TimelineList({
  children,
  active = -1,
  style,
  "data-myoxus-ui-role": uiRole = "timeline-list",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    active?: number;
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <MantineTimeline
      {...props}
      active={active}
      align="left"
      bulletSize={
        "calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))"
      }
      color="myoxus"
      lineWidth={"calc(var(--mantine-scale) * 1px)"}
      radius={"var(--mantine-radius-xl)"}
      data-myoxus-ui-role={uiRole}
      style={style}
      styles={{
        item: {
          paddingBottom:
            "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        },
        itemBody: {
          minWidth: 0,
        },
      }}
    >
      {children}
    </MantineTimeline>
  );
}

export function TimelineListItem({
  children,
  bullet,
  title,
  "data-myoxus-ui-role": uiRole = "timeline-list-item",
  ...props
}: PropsWithChildren<
  Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
    bullet?: ReactNode;
    title?: ReactNode;
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <MantineTimeline.Item
      {...props}
      bullet={bullet}
      title={title}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </MantineTimeline.Item>
  );
}
