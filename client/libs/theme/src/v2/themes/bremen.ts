// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bremen — Sans-Calm theme (P-AR-1-T-B).
//
// Character: neutral with a gentle warm undertone. Light mode is a
// soft cream-beige paper, ink is a slate-grey with the slightest warm
// shift. Dark mode is a deep wood-black with a warm cream ink-soft.
// Accent pair: dampened honey-yellow plus moss-green — the
// "northern-warm" duo.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Sans-leaning).
// Migration source: legacy `branding.theme.preset === "reduced-yellow"`.

import type { ThemeTokenSet } from "./types";

export const bremen: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — light beige-cream with subtle warm cast
      paper: "#fbf7ee",
      "paper-deep": "#f3eddc",
      rule: "#e2d8bc",
      // Ink — slate with a hint of warmth (>= 13:1 vs paper)
      ink: "#26303d",
      "ink-soft": "#525c6a",
      "ink-mute": "#8a8678",
      // Accent pair — dampened honey + moss-green
      "accent-primary": "#a87c1f",
      "accent-secondary": "#5c7048",
      // Status pairs — warmed slightly to match the cream paper
      "status-success-paper": "#cce0c8",
      "status-success-deep": "#3a7244",
      "status-pending-paper": "#f5dab2",
      "status-pending-deep": "#9c5a18",
      "status-error-paper": "#f1c8c0",
      "status-error-deep": "#a04535",
      "status-preset-paper": "#f0d784",
      "status-preset-deep": "#7c5800",
      "status-info-paper": "#cad8e0",
      "status-info-deep": "#3a607c",
    },
    dark: {
      // Surfaces — warm wood-black, deep with a warm cast
      paper: "#181614",
      "paper-deep": "#22201d",
      rule: "#3a362f",
      // Ink — warm cream for high readability (>= 13:1 vs paper)
      ink: "#e8e2d4",
      "ink-soft": "#b8b0a0",
      "ink-mute": "#7a7568",
      // Accent pair — softened honey + moss for dark surfaces
      "accent-primary": "#e6bf6c",
      "accent-secondary": "#a8c08c",
      "status-success-paper": "#22382a",
      "status-success-deep": "#84cc9c",
      "status-pending-paper": "#3a2816",
      "status-pending-deep": "#e8a06a",
      "status-error-paper": "#3a2222",
      "status-error-deep": "#e8988a",
      "status-preset-paper": "#332a12",
      "status-preset-deep": "#eecf80",
      "status-info-paper": "#1e2c3a",
      "status-info-deep": "#9bbed4",
    },
  },
  typography: {
    h1: {
      family: "Open Sans",
      weight: 600,
      size: "30px",
      lineHeight: "1.2",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "Open Sans",
      weight: 600,
      size: "24px",
      lineHeight: "1.25",
      letterSpacing: "0",
    },
    h3: {
      family: "Open Sans",
      weight: 600,
      size: "20px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "Open Sans",
      weight: 600,
      size: "17px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Open Sans",
      weight: 600,
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
      size: "14px",
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
    cityName: "Bremen",
    category: "sans-leaning",
    previousPreset: "reduced-yellow",
  },
};
