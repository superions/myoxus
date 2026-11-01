// SPDX-License-Identifier: AGPL-3.0-or-later
import { readGitGraphGlobalOptions } from "../../engine/gitgraph/config.js";
import { resolveMermaidGitGraphSource } from "../../engine/gitgraph/parser.js";
import {
  resolveMermaidGfxTheme,
  mermaidGfxThemeProperties,
} from "../../mermaid-gfx-theme.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";

/** Native defaults use the same live projection as GFX. Authored configuration
 * still overrides these defaults through Mermaid's existing preprocessing. */
export function gitGraphNativeRenderDefaults(source: string) {
  const theme = resolveMermaidGfxTheme();
  const authored = readGitGraphGlobalOptions(
    resolveMermaidGitGraphSource(source).document,
  );
  // Canvas names are namespaced identifiers, not CSS family names (for example
  // SourceSans3 versus "Source Sans 3"). Resolve the same server role as CSS.
  const probe = document.createElement("span");
  probe.style.fontFamily = `var(${mermaidGfxThemeProperties.fontFamily})`;
  probe.hidden = true;
  document.documentElement.append(probe);
  const fontFamily = getComputedStyle(probe).fontFamily;
  probe.remove();
  if (authored.theme !== undefined) return { fontFamily };
  const style = getComputedStyle(document.documentElement);
  const colors = [
    theme.primaryColor,
    theme.successColor,
    theme.processingColor,
    theme.warningColor,
  ];
  const palette = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => {
      const color = colors[i % colors.length]!;
      const foreground = projectMermaidSourceStyle({ fill: color }).color;
      const label = foreground && style.getPropertyValue(foreground).trim();
      if (!label)
        throw new Error(
          "GitGraph requires projected document contrast colors.",
        );
      return [
        [`git${i}`, color],
        [`gitInv${i}`, theme.surfaceColor],
        [`gitBranchLabel${i}`, label],
      ];
    }).flat(),
  );
  return {
    theme: "base" as const,
    fontFamily,
    themeVariables: {
      ...palette,
      fontFamily:
        typeof authored.fontFamily === "string"
          ? authored.fontFamily
          : fontFamily,
      fontSize: `${theme.typography.fontSize}px`,
      primaryColor: theme.surfaceColor,
      primaryTextColor: theme.textColor,
      textColor: theme.textColor,
      lineColor: theme.borderColor,
      commitLineColor: theme.borderColor,
      commitLabelColor: theme.textColor,
      commitLabelBackground: theme.secondarySurfaceColor,
      tagLabelColor: theme.textColor,
      tagLabelBackground: theme.surfaceColor,
      tagLabelBorder: theme.borderColor,
    },
  };
}
