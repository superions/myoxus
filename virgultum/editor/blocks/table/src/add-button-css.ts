import { css } from "@virgultum/shared/styles";
import { cssVar } from "@virgultum/shared/theme";

export const addColumnButtonStyle = css({
  cursor: "col-resize",
  backgroundColor: cssVar("hoverColor"),
  fontSize: "16px",
  color: cssVar("iconSecondary"),
  display: "flex",
  width: "16px",
  justifyContent: "center",
  alignItems: "center",
  position: "absolute",
  top: "0",
  left: "calc(100% + 2px)",
  height: "100%",
  transition:
    "opacity 0.2s ease-in-out, background-color 0.2s ease-in-out, color 0.2s ease-in-out",
  borderRadius: "2px",
  opacity: 0,
  ":hover": {
    backgroundColor: cssVar("black30"),
    color: cssVar("iconColor"),
    opacity: 1,
  },
  "&.active": {
    backgroundColor: cssVar("black30"),
    color: cssVar("iconColor"),
    opacity: 1,
  },
});

export const addRowButtonStyle = css({
  cursor: "row-resize",
  backgroundColor: cssVar("hoverColor"),
  fontSize: "16px",
  color: cssVar("iconSecondary"),
  display: "flex",
  height: "16px",
  alignItems: "center",
  justifyContent: "center",
  position: "absolute",
  top: "calc(100% + 2px)",
  left: "0",
  width: "100%",
  transition:
    "opacity 0.2s ease-in-out, background-color 0.2s ease-in-out, color 0.2s ease-in-out",
  borderRadius: "2px",
  opacity: 0,
  ":hover": {
    backgroundColor: cssVar("black30"),
    color: cssVar("iconColor"),
    opacity: 1,
  },
  "&.active": {
    backgroundColor: cssVar("black30"),
    color: cssVar("iconColor"),
    opacity: 1,
  },
});

export const addRowColumnButtonStyle = css({
  cursor: "nwse-resize",
  backgroundColor: cssVar("hoverColor"),
  fontSize: "16px",
  color: cssVar("iconSecondary"),
  display: "flex",
  width: "16px",
  height: "16px",
  justifyContent: "center",
  alignItems: "center",
  position: "absolute",
  top: "calc(100% + 2px)",
  left: "calc(100% + 2px)",
  borderRadius: "2px",
  opacity: 0,
  transition:
    "opacity 0.2s ease-in-out, background-color 0.2s ease-in-out, color 0.2s ease-in-out",
  ":hover": {
    backgroundColor: cssVar("black30"),
    color: cssVar("iconColor"),
    opacity: 1,
  },
  "&.active": {
    backgroundColor: cssVar("black30"),
    color: cssVar("iconColor"),
    opacity: 1,
  },
});

export const cellCountTipsStyle = css({
  position: "absolute",
  backgroundColor: cssVar("tooltip"),
  borderRadius: "4px",
  padding: "4px",
  boxShadow: cssVar("buttonShadow"),
  color: cssVar("backgroundPrimaryColor"),
  whiteSpace: "nowrap",
});
