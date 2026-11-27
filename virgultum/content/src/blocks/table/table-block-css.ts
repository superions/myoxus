import { css } from "@virgultum/core/styles";

export const tableContainer = css({
  display: "block",
  // Leave room for column/row options handles outside the top/left borders
  // and for the add-column / add-row controls outside the right/bottom borders.
  // Offset the left gutter with negative margin so the table's left border
  // aligns flush with surrounding prose paragraphs and headings.
  padding: "32px 36px 36px 32px",
  marginInlineStart: "-32px",
  width: "calc(100% + 32px)",
  overflowX: "auto",
  overflowY: "hidden",
  "::-webkit-scrollbar": {
    height: "8px",
  },
  "::-webkit-scrollbar-thumb:horizontal": {
    borderRadius: "4px",
    backgroundColor: "transparent",
  },
  "::-webkit-scrollbar-track:horizontal": {
    backgroundColor: "transparent",
    height: "8px",
  },
  "&:hover::-webkit-scrollbar-thumb:horizontal": {
    borderRadius: "4px",
    backgroundColor: "var(--myoxus-black-30)",
  },
  "&:hover::-webkit-scrollbar-track:horizontal": {
    backgroundColor: "var(--myoxus-hover-color)",
    height: "8px",
  },
});

export const tableWrapper = css({
  overflow: "visible",
  borderCollapse: "separate",
  borderSpacing: "0",
  borderTop: "1px solid var(--myoxus-border-color)",
  borderLeft: "1px solid var(--myoxus-border-color)",
  borderRadius: "var(--mantine-radius-md)",
  position: "relative",
  width: "max-content",
});

export const table = css({});

export const rowStyle = css({});
