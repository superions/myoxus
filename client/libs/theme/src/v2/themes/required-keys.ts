// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reflection helpers for the theme schema.
// Mikropaket P-AR-1-01.
//
// These constants are derived from the TypeScript interfaces in `types.ts`
// via complete sample objects. Adding/removing a field in `types.ts` will
// force a corresponding update here (compile error), keeping the runtime
// reflection in lock-step with the type definitions.

import type { ThemeColorTokens, ThemeTypographyTokens } from "./types";

const COLOR_KEY_SAMPLE: ThemeColorTokens = {
  paper: "",
  "paper-deep": "",
  ink: "",
  "ink-soft": "",
  "ink-mute": "",
  rule: "",
  "accent-primary": "",
  "accent-secondary": "",
  "status-success-paper": "",
  "status-success-deep": "",
  "status-pending-paper": "",
  "status-pending-deep": "",
  "status-error-paper": "",
  "status-error-deep": "",
  "status-preset-paper": "",
  "status-preset-deep": "",
  "status-info-paper": "",
  "status-info-deep": "",
};

export const REQUIRED_COLOR_KEYS = Object.keys(COLOR_KEY_SAMPLE) as Array<
  keyof ThemeColorTokens
>;

const TYPO_KEY_SAMPLE: ThemeTypographyTokens = {
  h1: {} as never,
  h2: {} as never,
  h3: {} as never,
  h4: {} as never,
  h5: {} as never,
  body: {} as never,
  bodySmall: {} as never,
  blockquote: {} as never,
  link: {} as never,
  mono: {} as never,
};

export const REQUIRED_TYPO_KEYS = Object.keys(TYPO_KEY_SAMPLE) as Array<
  keyof ThemeTypographyTokens
>;

export const REQUIRED_TYPO_FIELDS = [
  "family",
  "weight",
  "size",
  "lineHeight",
  "letterSpacing",
] as const;
