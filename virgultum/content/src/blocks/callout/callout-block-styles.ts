import { cssVar } from "@myoxus/theme";
import { editorBackgroundColors } from "@virgultum/core/services";
import { normalizeCalloutAppearance } from "@virgultum/core/models";
import type {
  CalloutBlockModel,
  ParagraphBlockModel,
} from "@virgultum/core/models";
import { css } from "@virgultum/core/styles";

export const calloutHostStyles = css({
  display: "block",
  margin: "8px 0",
});

export const calloutBlockContainerStyles = css({
  display: "flex",
  alignItems: "flex-start",
  boxSizing: "border-box",
  padding: "5px 10px",
  borderRadius: "8px",
});

export const calloutEmojiContainerStyles = css({
  userSelect: "none",
  fontSize: "1.2em",
  width: "24px",
  height: "24px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // marginTop is dynamically set by JavaScript based on first child's height
  marginBottom: "10px",
  flexShrink: 0,
  position: "relative",
});

export const calloutEmojiStyles = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  ":hover": {
    cursor: "pointer",
    opacity: 0.7,
  },
});

export const calloutChildrenStyles = css({
  flex: 1,
  minWidth: 0,
  paddingInlineStart: "10px",
});

// Untitled callouts align the glyph with their first paragraph's reading baseline.
export function calloutIconOffset(model: CalloutBlockModel) {
  if (model.props.type) return "0";
  const first = model.children[0];
  const heading =
    first?.flavour === "myoxus:paragraph"
      ? (first as ParagraphBlockModel).props.type$.value
      : undefined;
  return (
    (
      {
        h1: "23px",
        h2: "20px",
        h3: "16px",
        h4: "15px",
        h5: "14px",
        h6: "13px",
      } as Record<string, string>
    )[heading ?? ""] ?? "10px"
  );
}

export function calloutSurface(model: CalloutBlockModel) {
  const appearance =
    normalizeCalloutAppearance(model.props.appearance$.value) ?? "soft";
  const stored = model.props.backgroundColorName$.value;
  const name = !stored || stored === "default" ? "grey" : stored;
  const palette = editorBackgroundColors.find((color) => color.name === name);
  const emphasis =
    palette?.emphasis ?? cssVar(`--myoxus-text-highlight-foreground-${name}`);
  return {
    appearance,
    style: {
      backgroundColor:
        appearance === "soft"
          ? (palette?.background ??
            (name === "grey"
              ? cssVar("tagGray")
              : cssVar(`--myoxus-text-highlight-${name}`)))
          : cssVar(
              appearance === "accent"
                ? "backgroundSecondaryColor"
                : "backgroundPrimaryColor",
            ),
      color: appearance === "soft" ? (palette?.ink ?? "") : "",
      border: appearance === "outline" ? `1px solid ${emphasis}` : "",
      borderInlineStart: appearance === "accent" ? `3px solid ${emphasis}` : "",
    },
  };
}
