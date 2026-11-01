// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";

export const MERMAID_GFX_DETAIL_HEADER_HEIGHT = 44;
export const MERMAID_GFX_DETAIL_COMPARTMENT_GAP = 10;
export const MERMAID_GFX_DETAIL_INSET = 12;
export const MERMAID_GFX_DETAIL_ROW_HEIGHT = 30;
export const MERMAID_GFX_DETAIL_VERTICAL_PADDING = 16;

export function projectNeutralMermaidGfxDetailElementStyle() {
  const theme = resolveMermaidGfxProjectionTheme();
  return {
    color: theme.textColor,
    fillColor: theme.surfaceColor,
    fontSize: theme.typography.fontSize,
    fontWeight: theme.typography.fontWeight,
    strokeColor: theme.borderColor,
    strokeWidth: 2,
  };
}
