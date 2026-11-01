// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Zürich — Sans-Foundation theme (P-AR-1-T-A).
//
// Character: high-contrast, precise, accessible. Both modes target WCAG
// AAA-class contrast (>= 7:1 for ink/paper) so the theme stays readable
// for low-vision users without losing personality. Accent pair: a strong
// Swiss-flag red plus deep navy blue.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Sans-leaning).
// Migration source: legacy `branding.theme.preset === "accessible"`.

import type { ThemeTokenSet } from "./types";

export const zuerich: ThemeTokenSet = {
  colors: {
    light: {
      // Pure-ish white-cream blend, ink is near-black-blue (>= 16:1)
      paper: "#ffffff",
      "paper-deep": "#f3f3f5",
      rule: "#cdcdd2",
      ink: "#0a0d18",
      "ink-soft": "#2a3040",
      "ink-mute": "#5a6070",
      "accent-primary": "#c8102e",
      "accent-secondary": "#1c2c52",
      "status-success-paper": "#bce0c8",
      "status-success-deep": "#1f6b3e",
      "status-pending-paper": "#fbd3a8",
      "status-pending-deep": "#9a4a14",
      "status-error-paper": "#f5b8b8",
      "status-error-deep": "#962c2c",
      "status-preset-paper": "#f0d480",
      "status-preset-deep": "#5d4400",
      "status-info-paper": "#bcd5e8",
      "status-info-deep": "#1a4f7a",
    },
    dark: {
      // Near-black paper, ink is high-key off-white (>= 16:1)
      paper: "#08090c",
      "paper-deep": "#11131a",
      rule: "#2a2c34",
      ink: "#f5f6f8",
      "ink-soft": "#c8cbd2",
      "ink-mute": "#8a8e98",
      "accent-primary": "#ff5a6b",
      "accent-secondary": "#7c9cd0",
      "status-success-paper": "#173424",
      "status-success-deep": "#82d49d",
      "status-pending-paper": "#3a2614",
      "status-pending-deep": "#f0a570",
      "status-error-paper": "#3a1c1c",
      "status-error-deep": "#f29898",
      "status-preset-paper": "#322816",
      "status-preset-deep": "#f2d68a",
      "status-info-paper": "#152840",
      "status-info-deep": "#9ec3e8",
    },
  },
  typography: {
    h1: {
      family: "Roboto",
      weight: 700,
      size: "30px",
      lineHeight: "1.2",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "Roboto",
      weight: 700,
      size: "24px",
      lineHeight: "1.25",
      letterSpacing: "0",
    },
    h3: {
      family: "Roboto",
      weight: 700,
      size: "20px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "Roboto",
      weight: 700,
      size: "17px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Roboto",
      weight: 700,
      size: "15px",
      lineHeight: "1.4",
      letterSpacing: "0",
    },
    body: {
      family: "Roboto",
      weight: 400,
      size: "14px",
      lineHeight: "1.55",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "Roboto",
      weight: 400,
      size: "12px",
      lineHeight: "1.55",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "Roboto",
      weight: 400,
      size: "14px",
      lineHeight: "1.65",
      letterSpacing: "0",
    },
    link: {
      family: "Roboto",
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
    cityName: "Zürich",
    category: "sans-leaning",
    previousPreset: "accessible",
  },
};
