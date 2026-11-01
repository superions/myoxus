// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Berlin — Urban-Reportage (P-AR-1-T-C, expressive-existing).
//
// Character: urban reportage, condensed shouting display. Display uses
// Bebas Neue (condensed, all-caps news-headline voice); Body is Lato
// for sober, grounded reading; Mono is JetBrains Mono. The identity
// lives in **dark mode** — that is the canonical Berlin look. Light
// mode is provided for accessibility but is intentionally cool and
// industrial, never warm. Migration source: legacy `midnight` preset.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Expressive
// existing). Mapping: midnight → berlin.

import type { ThemeTokenSet } from "./types";

export const berlin: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — cool industrial off-white, never warm
      paper: "#f3f3f1",
      "paper-deep": "#e6e6e3",
      rule: "#cfcfca",
      // Ink — near-black with the slightest blue cast (>= 18:1 vs paper)
      ink: "#131316",
      "ink-soft": "#4a4a4f",
      "ink-mute": "#7d7d82",
      // Accent pair — asphalt yellow (signage, caution-strip) + concrete grey
      "accent-primary": "#c4a217",
      "accent-secondary": "#6e7378",
      // Status pairs — flat, news-print friendly
      "status-success-paper": "#cee0d2",
      "status-success-deep": "#327055",
      "status-pending-paper": "#f1d6b0",
      "status-pending-deep": "#9c5a18",
      "status-error-paper": "#eec5be",
      "status-error-deep": "#993838",
      "status-preset-paper": "#ecd49a",
      "status-preset-deep": "#705100",
      "status-info-paper": "#cdd6df",
      "status-info-deep": "#3a5a78",
    },
    dark: {
      // Surfaces — deep black-grey, the canonical Berlin look
      paper: "#0d0d0e",
      "paper-deep": "#16161a",
      rule: "#2c2c30",
      // Ink — off-white, hard contrast (>= 17:1 vs paper)
      ink: "#ececef",
      "ink-soft": "#b0b0b3",
      "ink-mute": "#74747a",
      // Accent pair — high-key yellow + cool concrete for dark surfaces
      "accent-primary": "#f1cc46",
      "accent-secondary": "#9ea4ab",
      "status-success-paper": "#1c3528",
      "status-success-deep": "#7fcc99",
      "status-pending-paper": "#352510",
      "status-pending-deep": "#eaa070",
      "status-error-paper": "#3a1f1f",
      "status-error-deep": "#e89890",
      "status-preset-paper": "#322a14",
      "status-preset-deep": "#edd47c",
      "status-info-paper": "#1c2a3a",
      "status-info-deep": "#9cbcd4",
    },
  },
  typography: {
    h1: {
      family: "Bebas Neue",
      weight: 700,
      size: "38px",
      lineHeight: "1.1",
      letterSpacing: "0.01em",
    },
    h2: {
      family: "Bebas Neue",
      weight: 700,
      size: "30px",
      lineHeight: "1.15",
      letterSpacing: "0.01em",
    },
    h3: {
      family: "Bebas Neue",
      weight: 700,
      size: "24px",
      lineHeight: "1.2",
      letterSpacing: "0.01em",
    },
    h4: {
      family: "Bebas Neue",
      weight: 700,
      size: "19px",
      lineHeight: "1.25",
      letterSpacing: "0.015em",
    },
    h5: {
      family: "Bebas Neue",
      weight: 700,
      size: "16px",
      lineHeight: "1.3",
      letterSpacing: "0.02em",
    },
    body: {
      family: "Lato",
      weight: 400,
      size: "14px",
      lineHeight: "1.55",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "Lato",
      weight: 400,
      size: "12px",
      lineHeight: "1.55",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "Lato",
      weight: 400,
      size: "15px",
      lineHeight: "1.65",
      letterSpacing: "0",
    },
    link: {
      family: "Lato",
      weight: 700,
      size: "14px",
      lineHeight: "1.55",
      letterSpacing: "0",
    },
    mono: {
      family: "JetBrains Mono",
      weight: 400,
      size: "13px",
      lineHeight: "1.55",
      letterSpacing: "0",
    },
  },
  meta: {
    cityName: "Berlin",
    category: "expressive-existing",
    previousPreset: "midnight",
  },
};
