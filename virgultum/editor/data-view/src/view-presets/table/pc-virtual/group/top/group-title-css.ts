import { css } from "@virgultum/shared/styles";
import { cssVar } from "@virgultum/shared/theme";

export const groupHeaderCount = css({
  flexShrink: 0,
  width: "20px",
  height: "20px",
  borderRadius: "4px",
  backgroundColor: "var(--myoxus-background-secondary-color)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: cssVar("textSecondaryColor"),
  fontSize: "var(--data-view-cell-text-size)",
});

export const groupHeaderOps = css({
  display: "flex",
  alignItems: "center",
  opacity: 0,
  "&:has(.active)": {
    opacity: 1,
  },
});

export const show = css({
  opacity: 1,
});

export const groupHeaderOp = css({
  display: "flex",
  alignItems: "center",
  cursor: "pointer",
  padding: "4px",
  borderRadius: "4px",
  transition: "all 150ms cubic-bezier(0.42, 0, 1, 1)",
  color: cssVar("iconColor"),
  "&:hover, &.active": {
    backgroundColor: cssVar("hoverColor"),
  },
});

export const groupHeaderIcon = css({
  display: "flex",
  alignItems: "center",
  marginRight: "-4px",
  color: cssVar("iconColor"),
  fontSize: "16px",
});

export const groupHeaderTitle = css({
  color: cssVar("textPrimaryColor"),
  fontSize: "var(--data-view-cell-text-size)",
  marginLeft: "4px",
});

export const groupTitleRow = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  overflow: "hidden",
  height: "22px",
});
