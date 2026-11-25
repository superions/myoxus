import { css } from "@virgultum/core/styles";

// Full table-edge hit areas support drag-to-grow/shrink and virtual count previews.
// Their coordinates remain with the table; native controls own visible chrome.
const edgeStyle = {
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  position: "absolute",
  opacity: 0,
  ":hover, :focus-within, &.active": { opacity: 1 },
} as const;

export const addColumnButtonStyle = css({
  ...edgeStyle,
  cursor: "col-resize",
  width: "16px",
  top: "0",
  left: "calc(100% + 2px)",
  height: "100%",
});

export const addRowButtonStyle = css({
  ...edgeStyle,
  cursor: "row-resize",
  height: "16px",
  top: "calc(100% + 2px)",
  left: "0",
  width: "100%",
});

export const addRowColumnButtonStyle = css({
  ...edgeStyle,
  cursor: "nwse-resize",
  width: "16px",
  height: "16px",
  top: "calc(100% + 2px)",
  left: "calc(100% + 2px)",
});
