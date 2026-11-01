// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CSSProperties } from "react";

export type CardPadding = "default" | "lg" | "md" | "none" | "sm" | "xl";

export const CARD_PADDING_BY_SIZE: Record<
  CardPadding,
  CSSProperties["padding"]
> = {
  default: "var(--mantine-spacing-md)",
  lg: "var(--mantine-spacing-lg)",
  md: "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
  none: 0,
  sm: "var(--mantine-spacing-sm)",
  xl: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
};
