import { IS_FIREFOX } from "@virgultum/global/env";
import type { FontFamily } from "@virgultum/model";

export function wrapFontFamily(fontFamily: FontFamily | string): string {
  return JSON.stringify(getFontFamilyName(fontFamily));
}

export const getFontFaces = IS_FIREFOX
  ? () => {
      const keys = document.fonts.keys();
      const fonts = [];
      let done = false;
      while (!done) {
        const item = keys.next();
        done = !!item.done;
        if (item.value) {
          fonts.push(item.value);
        }
      }
      return fonts;
    }
  : () => [...document.fonts.keys()];

const unquote = (family: string) => family.replace(/^(['"])(.*)\1$/, "$2");
const legacyPrefix = "virgultum:surface:";
const familyKey = (family: string) =>
  unquote(family).replace(legacyPrefix, "").replace(/\s/g, "").toLowerCase();

function projectedFontFaces(): Pick<FontFace, "family" | "weight" | "style">[] {
  const sheet = document.querySelector<HTMLStyleElement>(
    '[data-myoxus-branding="true"]',
  )?.sheet;
  return Array.from(sheet?.cssRules ?? [])
    .filter(
      (rule): rule is CSSFontFaceRule => rule.type === CSSRule.FONT_FACE_RULE,
    )
    .map((rule) => ({
      family: unquote(rule.style.getPropertyValue("font-family")),
      weight: rule.style.getPropertyValue("font-weight") || "normal",
      style: rule.style.getPropertyValue("font-style") || "normal",
    }));
}

/** Choices come from the server-owned font-face projection, never a client catalogue. */
export function getFontFamilies(): string[] {
  return [...new Set(projectedFontFaces().map((face) => face.family))].sort(
    (a, b) => a.localeCompare(b),
  );
}

/** Preserve deployed document IDs while rendering their canonical server family. */
export function getFontFamilyName(family: string): string {
  if (!family.startsWith(legacyPrefix)) return unquote(family);
  return family.slice(legacyPrefix.length).replace(/([a-z])([A-Z])/g, "$1 $2");
}

export const isSameFontFamily =
  (family: FontFamily | string) => (face: Pick<FontFace, "family">) =>
    familyKey(face.family) === familyKey(family);

/** CSS variable-font ranges are capabilities, not literal weight names. */
export function supportsFontFace(
  family: string,
  weight: string,
  style: string,
) {
  return projectedFontFaces()
    .filter(isSameFontFamily(family))
    .some((face) => {
      const bounds =
        face.weight === "normal"
          ? [400]
          : face.weight === "bold"
            ? [700]
            : face.weight.split(/\s+/).map(Number);
      return (
        face.style === style &&
        Number(weight) >= bounds[0] &&
        Number(weight) <= (bounds[1] ?? bounds[0])
      );
    });
}

export function getFontStyles(
  family: string,
): Pick<FontFace, "weight" | "style">[] {
  const faces = projectedFontFaces()
    .filter(isSameFontFamily(family))
    .flatMap((face) => {
      const bounds =
        face.weight === "normal"
          ? [400]
          : face.weight === "bold"
            ? [700]
            : face.weight.split(/\s+/).map(Number);
      if (bounds.length === 1)
        return [{ weight: String(bounds[0]), style: face.style }];
      const styles = [];
      for (
        let weight = Math.ceil(bounds[0] / 100) * 100;
        weight <= bounds[1];
        weight += 100
      )
        styles.push({ weight: String(weight), style: face.style });
      return styles;
    });
  // Unicode subsets describe one authored style, not separate menu choices.
  return [
    ...new Map(
      faces.map((face) => [face.weight + ":" + face.style, face]),
    ).values(),
  ];
}

export function getFontFacesByFontFamily(
  fontFamily: FontFamily | string,
): FontFace[] {
  return (
    getFontFaces()
      .filter(isSameFontFamily(fontFamily))
      // remove duplicate font faces
      .filter(
        (item, index, arr) =>
          arr.findIndex(
            (fontFace) =>
              fontFace.family === item.family &&
              fontFace.weight === item.weight &&
              fontFace.style === item.style,
          ) === index,
      )
  );
}
