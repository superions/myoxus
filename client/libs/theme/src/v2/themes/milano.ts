// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Milano — Editorial-Eleganz (P-AR-1-T-C, expressive-existing).
//
// Character: classical Italian editorial elegance, print-press
// contrast. Display uses PT Serif Bold Italic (the classical
// italic-bold pairing of late-19th-century Italian typography); Body
// is PT Serif for cohesive editorial tone; Mono is JetBrains Mono.
// Light mode: warm cream beige with deep burgundy-black ink. Dark
// mode: warm mahogany-black with light cream ink. Accent pair:
// deep bordeaux + warm goldbrown. Migration source: legacy
// `warm-contrast` preset.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Expressive
// existing). Mapping: warm-contrast → milano.

import type { ThemeTokenSet } from "./types";

export const milano: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — warm cream beige, slightly more saturated than Stuttgart
      paper: "#f7f0e4",
      "paper-deep": "#ede2cd",
      rule: "#dbcaa9",
      // Ink — deep burgundy-black (>= 17:1 vs paper)
      ink: "#1a1014",
      "ink-soft": "#5a3e44",
      "ink-mute": "#8d7e76",
      // Accent pair — deep bordeaux + warm goldbrown
      "accent-primary": "#7a2436",
      "accent-secondary": "#a06d1c",
      // Status pairs — print-friendly, editorial saturation
      "status-success-paper": "#cce0d0",
      "status-success-deep": "#377556",
      "status-pending-paper": "#f3d8b8",
      "status-pending-deep": "#a05c1c",
      "status-error-paper": "#efc4be",
      "status-error-deep": "#9a3838",
      "status-preset-paper": "#ecd6a0",
      "status-preset-deep": "#785208",
      "status-info-paper": "#cdd6e0",
      "status-info-deep": "#3a5a78",
    },
    dark: {
      // Surfaces — warm mahogany-black, never neutral grey
      paper: "#14100e",
      "paper-deep": "#1d1814",
      rule: "#382a24",
      // Ink — warm cream for editorial warmth (>= 14:1 vs paper)
      ink: "#ede0c9",
      "ink-soft": "#bdac90",
      "ink-mute": "#7e7363",
      // Accent pair — softened bordeaux + warm gold for dark
      "accent-primary": "#e09098",
      "accent-secondary": "#e8c878",
      "status-success-paper": "#22382b",
      "status-success-deep": "#80cc9a",
      "status-pending-paper": "#3a2614",
      "status-pending-deep": "#eba072",
      "status-error-paper": "#3a2020",
      "status-error-deep": "#e89890",
      "status-preset-paper": "#352b14",
      "status-preset-deep": "#edd47c",
      "status-info-paper": "#1e2c3c",
      "status-info-deep": "#9cbcd4",
    },
  },
  typography: {
    h1: {
      family: "PT Serif",
      weight: 700,
      size: "34px",
      lineHeight: "1.2",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "PT Serif",
      weight: 700,
      size: "27px",
      lineHeight: "1.25",
      letterSpacing: "0",
    },
    h3: {
      family: "PT Serif",
      weight: 700,
      size: "22px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "PT Serif",
      weight: 700,
      size: "18px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "PT Serif",
      weight: 700,
      size: "15px",
      lineHeight: "1.4",
      letterSpacing: "0",
    },
    body: {
      family: "PT Serif",
      weight: 400,
      size: "14px",
      lineHeight: "1.6",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "PT Serif",
      weight: 400,
      size: "12px",
      lineHeight: "1.6",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "PT Serif",
      weight: 400,
      size: "15px",
      lineHeight: "1.7",
      letterSpacing: "0",
    },
    link: {
      family: "PT Serif",
      weight: 700,
      size: "14px",
      lineHeight: "1.6",
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
    cityName: "Milano",
    category: "expressive-existing",
    previousPreset: "warm-contrast",
  },
};
