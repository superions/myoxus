// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hamburg — Sans-Foundation theme (P-AR-1-T-A).
//
// Character: warm-maritim, soft. Light mode is a warm cream with a faint
// yellow tint, ink is a deep maritime navy. Dark mode is a deep marine
// near-black with sand-coloured ink-soft. Accent pair: deep-sea green
// plus turquoise (the "harbour pair").
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Sans-leaning).
// Migration source: legacy `branding.theme.preset === "warm-soft"`.

import type { ThemeTokenSet } from "./types";

export const hamburg: ThemeTokenSet = {
  colors: {
    light: {
      paper: "#fbf6e8",
      "paper-deep": "#f3ecd6",
      rule: "#e3d8b5",
      ink: "#15293a",
      "ink-soft": "#3c5872",
      "ink-mute": "#7a8aa0",
      "accent-primary": "#0d6b5e",
      "accent-secondary": "#2a8a92",
      "status-success-paper": "#c8e3c8",
      "status-success-deep": "#2d7a4a",
      "status-pending-paper": "#fadfb5",
      "status-pending-deep": "#a85f1f",
      "status-error-paper": "#f3c8c0",
      "status-error-deep": "#a44535",
      "status-preset-paper": "#f5d784",
      "status-preset-deep": "#7c5800",
      "status-info-paper": "#c4dde7",
      "status-info-deep": "#2c6f86",
    },
    dark: {
      paper: "#0e1a26",
      "paper-deep": "#15243a",
      rule: "#2a3b56",
      ink: "#e8dec1",
      "ink-soft": "#b8a987",
      "ink-mute": "#7a715c",
      "accent-primary": "#5cc4b0",
      "accent-secondary": "#7fcfd6",
      "status-success-paper": "#1d3e2a",
      "status-success-deep": "#7fce99",
      "status-pending-paper": "#3f2a16",
      "status-pending-deep": "#eba068",
      "status-error-paper": "#3e2222",
      "status-error-deep": "#e89890",
      "status-preset-paper": "#332b14",
      "status-preset-deep": "#edd47c",
      "status-info-paper": "#1a3142",
      "status-info-deep": "#8cc0d3",
    },
  },
  typography: {
    h1: {
      family: "Lato",
      weight: 700,
      size: "30px",
      lineHeight: "1.2",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "Lato",
      weight: 700,
      size: "24px",
      lineHeight: "1.25",
      letterSpacing: "0",
    },
    h3: {
      family: "Lato",
      weight: 700,
      size: "20px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "Lato",
      weight: 700,
      size: "17px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Lato",
      weight: 700,
      size: "15px",
      lineHeight: "1.4",
      letterSpacing: "0",
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
      size: "14px",
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
    cityName: "Hamburg",
    category: "sans-leaning",
    previousPreset: "warm-soft",
  },
};
