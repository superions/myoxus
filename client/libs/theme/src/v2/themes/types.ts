// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Theme-Token-Schema for the 16 city-named themes.
// Mikropaket P-AR-1-01.
//
// This module defines the *structure* every theme must satisfy. Concrete
// values (Stuttgart, Hamburg, Hannover, …) are populated by the theme
// micro-packages P-AR-1-T-A..D.
//
// Schema source: todo/admin-redesign-concept.md § 6 (Datenmodell) and
// docs/dev/clients/adminfrontend/atelier-notebook-design-system.md § 2.2.

/**
 * Color tokens that every theme MUST provide for both light and dark mode.
 *
 * Tonal trinity rule (atelier-notebook-design-system.md § 2.2):
 * each status accent comes as a `*-paper` (flat surface) and `*-deep`
 * (text/punctuation) pair. Both are mandatory.
 */
export interface ThemeColorTokens {
  paper: string;
  "paper-deep": string;
  ink: string;
  "ink-soft": string;
  "ink-mute": string;
  rule: string;
  "accent-primary": string;
  "accent-secondary": string;
  "status-success-paper": string;
  "status-success-deep": string;
  "status-pending-paper": string;
  "status-pending-deep": string;
  "status-error-paper": string;
  "status-error-deep": string;
  "status-preset-paper": string;
  "status-preset-deep": string;
  "status-info-paper": string;
  "status-info-deep": string;
}

/**
 * Typography token — one entry per typographic role.
 * `size` and `lineHeight` are CSS unit strings (px / rem). `weight` may be
 * numeric (400, 600) or a CSS keyword (e.g. "normal", "bold").
 *
 * `fontStyle`, `decoration` and `hoverDecoration` are intentionally optional:
 * the base theme registry keeps a compact common shape, while admin-owned
 * runtime typography overrides can expose richer slot-specific controls for
 * blockquotes and links without forcing placeholder values into every theme.
 */
export interface TypographyToken {
  family: string;
  weight: number | string;
  size: string;
  lineHeight: string;
  letterSpacing: string;
  fontStyle?: string;
  decoration?: string;
  hoverDecoration?: string;
}

export interface ThemeTypographyTokens {
  h1: TypographyToken;
  h2: TypographyToken;
  h3: TypographyToken;
  h4: TypographyToken;
  h5: TypographyToken;
  body: TypographyToken;
  bodySmall: TypographyToken;
  blockquote: TypographyToken;
  link: TypographyToken;
  mono: TypographyToken;
}

/**
 * Theme metadata.
 *
 * `previousPreset` carries the migration mapping from the legacy
 * `branding.theme.preset` enum. New themes (Wien, Porto, Lyon, Sevilla)
 * have no predecessor and leave this field undefined.
 */
export interface ThemeMeta {
  cityName: string;
  category: "sans-leaning" | "expressive-existing" | "expressive-new";
  previousPreset?: string;
}

export interface ThemeTokenSet {
  colors: {
    light: ThemeColorTokens;
    dark: ThemeColorTokens;
  };
  typography: ThemeTypographyTokens;
  meta: ThemeMeta;
}

/**
 * The 16 city themes that make up the Atelier theme registry.
 *
 * Batches (P-AR-1-T-A..D):
 *  - A — Sans-Foundations:        stuttgart, hamburg, hannover, bremen
 *  - B — Sans-with-Character:     reykjavik, zuerich
 *  - C — Expressive Existing:     lisboa, berlin, helsinki, bordeaux
 *  - C2 — Expressive Existing 2:  habana, milano
 *  - D — Expressive New:          wien, porto, lyon, sevilla
 */
export type ThemeId =
  | "stuttgart"
  | "hamburg"
  | "hannover"
  | "bremen"
  | "reykjavik"
  | "zuerich"
  | "lisboa"
  | "berlin"
  | "helsinki"
  | "bordeaux"
  | "habana"
  | "milano"
  | "wien"
  | "porto"
  | "lyon"
  | "sevilla";
