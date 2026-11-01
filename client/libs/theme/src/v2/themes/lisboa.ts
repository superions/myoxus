// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lisboa — Tropisch-Warm (P-AR-1-T-D, expressive-existing).
//
// Character: tropical-warm, sand and ocean. Display uses Pattaya
// (a Thai/Latin display script with a relaxed, sun-kissed swing);
// Body is Open Sans for clean tropical readability; Mono is JetBrains
// Mono. Light mode: sand-cream paper with deep ocean-blue near-black
// ink. Dark mode: ink-marine surface with light sand ink. Accent
// pair: deep ocean blue + coral-orange (sunset echo). Migration
// source: legacy `sunset` preset.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Expressive
// existing). Mapping: sunset → lisboa.

import type { ThemeTokenSet } from "./types";

export const lisboa: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — sand-cream, warm beach paper
      paper: "#faefe0",
      "paper-deep": "#f1e2c9",
      rule: "#e1ccaa",
      // Ink — deep ocean-blue near-black (>= 14:1 vs paper)
      ink: "#0e1a26",
      "ink-soft": "#3c5267",
      "ink-mute": "#7c8a96",
      // Accent pair — deep ocean blue + coral-orange (sunset echo)
      "accent-primary": "#1f4e6e",
      "accent-secondary": "#d56438",
      // Status pairs — paper-friendly tropical
      "status-success-paper": "#cee0c8",
      "status-success-deep": "#3a7050",
      "status-pending-paper": "#f5d4af",
      "status-pending-deep": "#a4581a",
      "status-error-paper": "#efc3bc",
      "status-error-deep": "#9c3838",
      "status-preset-paper": "#ecd49a",
      "status-preset-deep": "#785408",
      "status-info-paper": "#c8d8e6",
      "status-info-deep": "#2c5476",
    },
    dark: {
      // Surfaces — ink-marine, deep nautical blue-black
      paper: "#0a1320",
      "paper-deep": "#101c2c",
      rule: "#243446",
      // Ink — light sand for tropical contrast (>= 14:1 vs paper)
      ink: "#ebdfc6",
      "ink-soft": "#b6a98c",
      "ink-mute": "#7a705e",
      // Accent pair — softened ocean + coral on dark
      "accent-primary": "#7ab6d8",
      "accent-secondary": "#ec9670",
      "status-success-paper": "#1c3528",
      "status-success-deep": "#84cc9a",
      "status-pending-paper": "#352510",
      "status-pending-deep": "#eba072",
      "status-error-paper": "#3a2020",
      "status-error-deep": "#e89890",
      "status-preset-paper": "#352b14",
      "status-preset-deep": "#edd47c",
      "status-info-paper": "#1a2a3c",
      "status-info-deep": "#9cc4dc",
    },
  },
  typography: {
    h1: {
      family: "Pattaya",
      weight: 400,
      size: "34px",
      lineHeight: "1.2",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "Pattaya",
      weight: 400,
      size: "27px",
      lineHeight: "1.25",
      letterSpacing: "0",
    },
    h3: {
      family: "Pattaya",
      weight: 400,
      size: "22px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "Pattaya",
      weight: 400,
      size: "18px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Pattaya",
      weight: 400,
      size: "15px",
      lineHeight: "1.4",
      letterSpacing: "0",
    },
    body: {
      family: "Open Sans",
      weight: 400,
      size: "14px",
      lineHeight: "1.55",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "Open Sans",
      weight: 400,
      size: "12px",
      lineHeight: "1.55",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "Open Sans",
      weight: 400,
      size: "15px",
      lineHeight: "1.65",
      letterSpacing: "0",
    },
    link: {
      family: "Open Sans",
      weight: 600,
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
    cityName: "Lisboa",
    category: "expressive-existing",
    previousPreset: "sunset",
  },
};
