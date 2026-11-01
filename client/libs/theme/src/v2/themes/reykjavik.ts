// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reykjavík — Sans-Foundation theme (P-AR-1-T-A).
//
// Character: arctic, clear-cool, ice-blue. Light mode is a cool off-white
// with a faint blue tint, ink is dark slate. Dark mode is a deep
// polar-night blue-black. Accent pair: ice-blue plus a near-white ice
// highlight.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Sans-leaning).
// Migration source: legacy `branding.theme.preset === "arctic"`.

import type { ThemeTokenSet } from "./types";

export const reykjavik: ThemeTokenSet = {
  colors: {
    light: {
      paper: "#f4f7fa",
      "paper-deep": "#e6ecf2",
      rule: "#d3dde6",
      ink: "#1a2733",
      "ink-soft": "#445566",
      "ink-mute": "#8090a0",
      "accent-primary": "#2c7fb8",
      "accent-secondary": "#9fc4dc",
      "status-success-paper": "#c5e5d6",
      "status-success-deep": "#2a805a",
      "status-pending-paper": "#f7dcc7",
      "status-pending-deep": "#b35c2a",
      "status-error-paper": "#f1c8cc",
      "status-error-deep": "#a04550",
      "status-preset-paper": "#ecdca5",
      "status-preset-deep": "#7a5d10",
      "status-info-paper": "#c5dceb",
      "status-info-deep": "#1f5d8a",
    },
    dark: {
      paper: "#0d1620",
      "paper-deep": "#152030",
      rule: "#28384a",
      ink: "#e6eef5",
      "ink-soft": "#a8b8c8",
      "ink-mute": "#6c7c8c",
      "accent-primary": "#7fbede",
      "accent-secondary": "#d0e2ee",
      "status-success-paper": "#1c3a2c",
      "status-success-deep": "#88d0a8",
      "status-pending-paper": "#3b291a",
      "status-pending-deep": "#eaa07c",
      "status-error-paper": "#3c2228",
      "status-error-deep": "#e8a0a8",
      "status-preset-paper": "#322b18",
      "status-preset-deep": "#ecd58a",
      "status-info-paper": "#1a2c40",
      "status-info-deep": "#94c5e8",
    },
  },
  typography: {
    h1: {
      family: "Inter",
      weight: 700,
      size: "30px",
      lineHeight: "1.2",
      letterSpacing: "-0.015em",
    },
    h2: {
      family: "Inter",
      weight: 700,
      size: "24px",
      lineHeight: "1.25",
      letterSpacing: "-0.01em",
    },
    h3: {
      family: "Inter",
      weight: 700,
      size: "20px",
      lineHeight: "1.3",
      letterSpacing: "-0.005em",
    },
    h4: {
      family: "Inter",
      weight: 700,
      size: "17px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Inter",
      weight: 700,
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
      weight: 600,
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
    cityName: "Reykjavík",
    category: "sans-leaning",
    previousPreset: "arctic",
  },
};
