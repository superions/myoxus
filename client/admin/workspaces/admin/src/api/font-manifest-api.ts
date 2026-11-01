// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { adminFetch } from "../fetch-utils";

export interface FontManifestEntry {
  name: string;
  file: string;
  category: string;
  decorative: boolean;
  weights: number[];
  coverage: string[];
  url: string;
  versionHash: string;
}

export interface FontManifestOptions {
  invalidateOnAuthFailure?: boolean;
}

export async function fetchFontManifest(
  options: FontManifestOptions = {},
): Promise<FontManifestEntry[]> {
  const response = await adminFetch("/api/fonts", {
    admin: {
      channel: "technical-http",
      operationName: "fontManifest",
      invalidateOnAuthFailure: options.invalidateOnAuthFailure,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return (await response.json()) as FontManifestEntry[];
}

export function ensureFontFaceStyle({
  id,
  family,
  url,
}: {
  id: string;
  family: string;
  url: string;
}) {
  if (typeof document === "undefined") return;
  if (document.getElementById(id)) return;

  const style = document.createElement("style");
  style.id = id;
  const format = url.split("?", 1)[0]?.toLowerCase().endsWith(".otf")
    ? "opentype"
    : "truetype";
  style.textContent = `
    @font-face {
      font-family: ${JSON.stringify(family)};
      src: url(${JSON.stringify(url)}) format("${format}");
      font-display: swap;
    }
  `;
  document.head.append(style);
}
