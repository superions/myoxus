import { css } from "@virgultum/core/styles";
import { cssVar } from "@virgultum/core/theme";

export const cellContainerStyle = css({
  position: "relative",
  alignItems: "center",
  borderTop: "0",
  borderLeft: "0",
  borderRight: "1px solid",
  borderBottom: "1px solid",
  borderColor: cssVar("borderColor"),
  isolation: "auto",
  textAlign: "start",
  verticalAlign: "top",
});

// Cell-border anchors sit outside the table perimeter so handles never slice
// across cell borders or overlap cell content; padding bridges the hover gap.
export const columnOptionsCellStyle = css({
  position: "absolute",
  bottom: "100%",
  paddingBottom: "4px",
  zIndex: 2,
  opacity: 0,
  ":hover, :focus-within": { opacity: 1 },
  left: "0",
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
});

export const rowOptionsCellStyle = css({
  position: "absolute",
  top: "0",
  right: "100%",
  paddingRight: "4px",
  zIndex: 2,
  opacity: 0,
  ":hover, :focus-within": { opacity: 1 },
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
});

export const indicatorStyle = css({
  position: "absolute",
  backgroundColor: cssVar("primaryColor"),
  zIndex: 2,
  transition: "opacity 0.2s ease-in-out",
  pointerEvents: "none",
});

export const columnIndicatorStyle = css([
  indicatorStyle,
  {
    top: "-1px",
    height: "calc(100% + 2px)",
    width: "5px",
  },
]);

export const columnRightIndicatorStyle = css([
  columnIndicatorStyle,
  {
    cursor: "ew-resize",
    right: "-3px",
    pointerEvents: "auto",
  },
]);

export const columnLeftIndicatorStyle = css([
  columnIndicatorStyle,
  {
    left: "-2px",
  },
]);

export const rowIndicatorStyle = css([
  indicatorStyle,
  {
    left: "-1px",
    width: "calc(100% + 2px)",
    height: "5px",
  },
]);

export const rowBottomIndicatorStyle = css([
  rowIndicatorStyle,
  {
    bottom: "-3px",
  },
]);

export const rowTopIndicatorStyle = css([
  rowIndicatorStyle,
  {
    top: "-2px",
  },
]);
