// SPDX-License-Identifier: AGPL-3.0-or-later

const ARCHITECTURE_BUILTIN_ICON_GLYPHS: Readonly<Record<string, string>> = {
  blank: "",
  cloud: "☁",
  database: "⛁",
  disk: "◉",
  internet: "◎",
  server: "▤",
  unknown: "?",
};

const ARCHITECTURE_ICONIFY_PREFIX = "mermaid-architecture:";

function architectureBuiltinIconName(icon: string) {
  return icon.startsWith(ARCHITECTURE_ICONIFY_PREFIX)
    ? icon.slice(ARCHITECTURE_ICONIFY_PREFIX.length)
    : icon;
}

export function architectureIconIsResolved(
  icon: string,
  kind: "icon" | "none" | "text" = "icon",
) {
  if (!icon || kind === "none") return false;
  return (
    kind === "text" ||
    Object.hasOwn(
      ARCHITECTURE_BUILTIN_ICON_GLYPHS,
      architectureBuiltinIconName(icon),
    )
  );
}

/**
 * Produces the visual icon row consumed by the theme-measured GFX label.
 * Text icons remain exact document text. Mermaid's built-in Architecture
 * icons receive a compact symbolic projection. An icon that is not available
 * to this renderer is shown as an explicit unresolved marker; its raw name
 * stays in the anchored Properties field instead of masquerading as a valid
 * `◇ name` rendering inside the diagram.
 */
export function architectureIconDisplay(
  icon: string,
  kind: "icon" | "none" | "text" = "icon",
) {
  if (!icon || kind === "none") return "";
  if (kind === "text") return icon;
  return (
    ARCHITECTURE_BUILTIN_ICON_GLYPHS[architectureBuiltinIconName(icon)] ?? "?"
  );
}
