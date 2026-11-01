// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stuttgart — Default theme for the Atelier system (P-AR-1-T-A).
//
// Character: neutral, professional, highest polish stage. Cream-paper
// surfaces in light mode, anthracite-with-cream-hint in dark mode. Accent
// pair is a low-contrast burgundy / deep blue duo that pairs with the
// Inter SemiBold display family.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Sans-leaning).
// Migration source: legacy `branding.theme.preset === "default"`.

import type { ThemeTokenSet } from "./types";

export const stuttgart: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — warm cream (4.5:1+ ink contrast verified)
      paper: "#faf7f2",
      "paper-deep": "#f2ede4",
      rule: "#e5dfd3",
      // Ink — deep slate-navy (16.5:1 vs paper)
      ink: "#1f2330",
      "ink-soft": "#4b5363",
      "ink-mute": "#8a8f9d",
      // Accent pair — burgundy + deep navy (low-contrast yet rich)
      "accent-primary": "#7d2841",
      "accent-secondary": "#1f3a52",
      // Status pairs (paper for surfaces, deep for ink/icon)
      "status-success-paper": "#c7e5d2",
      "status-success-deep": "#2f8b5e",
      "status-pending-paper": "#fbddc4",
      "status-pending-deep": "#c25e2a",
      "status-error-paper": "#f4c7c7",
      "status-error-deep": "#b14848",
      "status-preset-paper": "#f8dd8e",
      "status-preset-deep": "#8c6300",
      "status-info-paper": "#c9def1",
      "status-info-deep": "#2d6b98",
    },
    dark: {
      // Surfaces — anthracite with a cream hint to keep Stuttgart's warmth
      paper: "#1a1b1f",
      "paper-deep": "#232428",
      rule: "#3a3a40",
      // Ink — light beige (high readability vs anthracite)
      ink: "#ece6da",
      "ink-soft": "#bdb6a8",
      "ink-mute": "#7c7873",
      // Accent pair — softened burgundy + dusty navy for dark surfaces
      "accent-primary": "#d27d8f",
      "accent-secondary": "#7fa6c8",
      "status-success-paper": "#234634",
      "status-success-deep": "#7ed3a3",
      "status-pending-paper": "#4a311e",
      "status-pending-deep": "#f0a878",
      "status-error-paper": "#4a2828",
      "status-error-deep": "#e89898",
      "status-preset-paper": "#3d3318",
      "status-preset-deep": "#f0d488",
      "status-info-paper": "#1f3447",
      "status-info-deep": "#94c0e3",
    },
  },
  typography: {
    h1: {
      family: "Inter",
      weight: 600,
      size: "30px",
      lineHeight: "1.2",
      letterSpacing: "-0.01em",
    },
    h2: {
      family: "Inter",
      weight: 600,
      size: "24px",
      lineHeight: "1.25",
      letterSpacing: "-0.005em",
    },
    h3: {
      family: "Inter",
      weight: 600,
      size: "20px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "Inter",
      weight: 600,
      size: "17px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Inter",
      weight: 600,
      size: "15px",
      lineHeight: "1.4",
      letterSpacing: "0",
    },
    body: {
      family: "Inter",
      weight: 400,
      size: "14px",
      lineHeight: "1.5",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "Inter",
      weight: 400,
      size: "12px",
      lineHeight: "1.5",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "Inter",
      weight: 400,
      size: "14px",
      lineHeight: "1.6",
      letterSpacing: "0",
    },
    link: {
      family: "Inter",
      weight: 500,
      size: "14px",
      lineHeight: "1.5",
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
    cityName: "Stuttgart",
    category: "sans-leaning",
    previousPreset: "default",
  },
};
