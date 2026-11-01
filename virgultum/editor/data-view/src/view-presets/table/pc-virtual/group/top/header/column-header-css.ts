import { cssVar } from "@myoxus/theme";
import { css } from "@virgultum/shared/styles";

import { DEFAULT_COLUMN_TITLE_HEIGHT } from "../../../../consts";

export const columnHeaderContainer = css({
  display: "block",
  backgroundColor: "var(--myoxus-background-primary-color)",
  position: "relative",
  zIndex: 2,
});

export const columnHeader = css({
  position: "relative",
  display: "flex",
  flexDirection: "row",
  borderBottom: `1px solid ${cssVar("borderColor")}`,
  borderTop: `1px solid ${cssVar("borderColor")}`,
  boxSizing: "border-box",
  userSelect: "none",
  backgroundColor: "var(--myoxus-background-primary-color)",
});

export const column = css({
  cursor: "pointer",
});

export const cell = css({
  userSelect: "none",
});

export const headerAddColumnButton = css({
  height: `${DEFAULT_COLUMN_TITLE_HEIGHT}px`,
  backgroundColor: "var(--myoxus-background-primary-color)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "40px",
  cursor: "pointer",
  fontSize: "18px",
  color: cssVar("iconColor"),
});
