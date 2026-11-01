// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lyon — Modern-Serif Contemporary (P-AR-1-T-B, expressive-new).
//
// Character: contemporary modern-serif. Display uses Source Serif 4
// Bold for a clean, current-era serif voice; Body is Inter for
// neutral, crisp reading. Light mode is a near-white off-paper with
// the slightest warmth, ink is petrol-black. Dark mode is a deep
// petrol-dark. Accent pair: petrol-teal + carmine-red — the
// "modern-print" duo.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Expressive
// new). No legacy migration source — newly introduced theme.

import type { ThemeTokenSet } from "./types";

export const lyon: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — near-white off-paper with minimal warmth
      paper: "#f7f6f4",
      "paper-deep": "#ebe9e4",
      rule: "#d5d2cb",
      // Ink — petrol-black (>= 17:1 vs paper)
      ink: "#0e1c22",
      "ink-soft": "#3a4c54",
      "ink-mute": "#7c8488",
      // Accent pair — deep petrol + carmine red
      "accent-primary": "#1b5870",
      "accent-secondary": "#a8323a",
      // Status pairs — modern, slightly cooler than Wien
      "status-success-paper": "#cae0d0",
      "status-success-deep": "#347558",
      "status-pending-paper": "#f1d8b8",
      "status-pending-deep": "#9c5a1c",
      "status-error-paper": "#eec6c0",
      "status-error-deep": "#9a3a3a",
      "status-preset-paper": "#ead6a0",
      "status-preset-deep": "#735000",
      "status-info-paper": "#c4dae6",
      "status-info-deep": "#1f5d80",
    },
    dark: {
      // Surfaces — deep petrol-dark, cool and modern
      paper: "#0a141a",
      "paper-deep": "#121e26",
      rule: "#26343c",
      // Ink — high-key off-white for contemporary clarity (>= 17:1)
      ink: "#e8eef0",
      "ink-soft": "#aeb8bc",
      "ink-mute": "#727a7e",
      // Accent pair — softened petrol + dusted carmine for dark
      "accent-primary": "#7fbcd0",
      "accent-secondary": "#e8929c",
      "status-success-paper": "#1c3a2a",
      "status-success-deep": "#84cc9c",
      "status-pending-paper": "#3a2818",
      "status-pending-deep": "#eba070",
      "status-error-paper": "#3a2222",
      "status-error-deep": "#e89890",
      "status-preset-paper": "#332a14",
      "status-preset-deep": "#edd47c",
      "status-info-paper": "#162e3c",
      "status-info-deep": "#9bc4d8",
    },
  },
  typography: {
    h1: {
      family: "Source Serif 4",
      weight: 700,
      size: "32px",
      lineHeight: "1.2",
      letterSpacing: "-0.01em",
    },
    h2: {
      family: "Source Serif 4",
      weight: 700,
      size: "26px",
      lineHeight: "1.25",
      letterSpacing: "-0.005em",
    },
    h3: {
      family: "Source Serif 4",
      weight: 700,
      size: "21px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "Source Serif 4",
      weight: 700,
      size: "17px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Source Serif 4",
      weight: 700,
      size: "15px",
      lineHeight: "1.4",
      letterSpacing: "0",
    },
    body: {
      family: "Inter",
      weight: 400,
      size: "14px",
      lineHeight: "1.55",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "Inter",
      weight: 400,
      size: "12px",
      lineHeight: "1.55",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "Source Serif 4",
      weight: 400,
      size: "15px",
      lineHeight: "1.65",
      letterSpacing: "0",
    },
    link: {
      family: "Inter",
      weight: 500,
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
    cityName: "Lyon",
    category: "expressive-new",
  },
};
