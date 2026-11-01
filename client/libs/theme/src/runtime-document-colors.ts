// SPDX-License-Identifier: AGPL-3.0-or-later

import { findBlockContent } from "./runtime-hover-css";

/** Fixed document fills need foregrounds independent of the viewer's mode.
 * Both values come from the live server projection, never a client palette.
 */
export function appendDocumentForegroundVariables(css: string): string {
  const foreground = (mode: "light" | "dark") =>
    /--myoxus-sem-text-primary\s*:\s*([^;]+);/
      .exec(findBlockContent(css, `[data-theme='${mode}']`))?.[1]
      ?.trim();
  const light = foreground("light"),
    dark = foreground("dark");
  if (!light || !dark) return css;
  return `${css}\n:root {\n  --myoxus-document-text-on-light-fill: ${light};\n  --myoxus-document-text-on-dark-fill: ${dark};\n}\n`;
}
