// SPDX-License-Identifier: AGPL-3.0-or-later
import { contrastRatio, type HexColor } from "@myoxus/theme";

function opaqueHex(value: string): HexColor | null {
  const hex = /^#[\da-f]{3}(?:[\da-f]{3})?$/i.exec(value);
  if (hex) return hex[0] as HexColor;
  const rgb =
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(
      value,
    );
  if (!rgb || (rgb[4] && Number(rgb[4]) !== 1)) return null;
  return `#${rgb
    .slice(1, 4)
    .map((v) => Number(v).toString(16).padStart(2, "0"))
    .join("")}` as HexColor;
}

function foregroundForFill(fill: string): string | undefined {
  // Mode-dependent fills continue to use the ordinary theme foreground.
  if (
    typeof document === "undefined" ||
    /var\(|light-dark\(|currentcolor/i.test(fill)
  )
    return undefined;
  const probe = document.createElement("span");
  probe.hidden = true;
  probe.style.color = fill;
  if (!probe.style.color) return undefined;
  document.body.append(probe);
  try {
    const background =
      opaqueHex(fill) ?? opaqueHex(getComputedStyle(probe).color);
    if (!background) return undefined;
    const style = getComputedStyle(document.documentElement);
    const candidates = [
      "--myoxus-document-text-on-light-fill",
      "--myoxus-document-text-on-dark-fill",
    ];
    const choices = candidates.flatMap((property) => {
      const color = opaqueHex(style.getPropertyValue(property).trim());
      return color
        ? [{ property, contrast: contrastRatio(background, color) }]
        : [];
    });
    // Persist a semantic reference. Changing a viewer's mode must not write
    // that participant's computed RGB into the shared projection or Source.
    return choices.sort((a, b) => b.contrast - a.contrast)[0]?.property;
  } finally {
    probe.remove();
  }
}

/** Source colors and font values are document data, not app chrome. */
export function projectMermaidSourceStyle(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const number = parseFloat(String(value["font-size"] ?? ""));
  const color =
    typeof value.color === "string"
      ? value.color
      : typeof value.fill === "string"
        ? foregroundForFill(value.fill)
        : undefined;
  return {
    ...(typeof value["font-family"] === "string"
      ? { fontFamily: value["font-family"] }
      : {}),
    ...(typeof value.fill === "string" ? { fillColor: value.fill } : {}),
    ...(typeof value.stroke === "string" ? { strokeColor: value.stroke } : {}),
    ...(color ? { color } : {}),
    ...(Number.isFinite(number) && number > 0 ? { fontSize: number } : {}),
    ...(typeof value["font-weight"] === "string"
      ? { fontWeight: value["font-weight"] }
      : {}),
    ...(typeof value["font-style"] === "string"
      ? { fontStyle: value["font-style"] }
      : {}),
    ...(typeof value["stroke-width"] === "string" &&
    Number.isFinite(parseFloat(value["stroke-width"]))
      ? { strokeWidth: parseFloat(value["stroke-width"]) }
      : {}),
  };
}
