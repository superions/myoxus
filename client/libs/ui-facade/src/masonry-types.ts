// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ComponentType, HTMLAttributes } from "react";

export type MasonryItem = HTMLAttributes<HTMLDivElement> & {
  id: string;
  Component?: ComponentType<{ groupId: string; itemId: string }>;
} & ({ height: number } | { ratio: number } | { measured: true });

export interface MasonryGroup extends HTMLAttributes<HTMLDivElement> {
  id: string;
  height: number;
  items: MasonryItem[];
  Component?: ComponentType<{
    groupId: string;
    collapsed?: boolean;
    itemCount: number;
  }>;
}

export interface MasonryItemXYWH {
  type: "item" | "group";
  x: number;
  y: number;
  w: number;
  h: number;
}

export type MasonryPX = number | ((totalWidth: number) => number);
