import { baseTheme } from "@myoxus/theme";
import { cssVar } from "@myoxus/theme";
import { css } from "@virgultum/shared/styles";

export const tagSelectContainerStyle = css({
  position: "absolute",
  zIndex: 2,
  color: cssVar("textPrimaryColor"),
  border: `0.5px solid ${cssVar("black10")}`,
  borderRadius: "8px",
  backgroundColor: cssVar("backgroundOverlayPanelColor"),
  boxShadow: "var(--myoxus-shadow-1)",
  fontFamily: "var(--myoxus-font-family)",
  maxWidth: "400px",
  padding: "8px",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  "@media print": {
    display: "none",
  },
});

export const tagSelectInputContainerStyle = css({
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "6px",
  padding: "4px",
});

export const tagSelectInputStyle = css({
  flex: "1 1 0",
  border: "none",
  fontFamily: baseTheme.fontSansFamily,
  color: cssVar("textPrimaryColor"),
  backgroundColor: "transparent",
  lineHeight: "22px",
  fontSize: "14px",
  outline: "none",
  "::placeholder": {
    color: "var(--myoxus-placeholder-color)",
  },
});

export const selectOptionsTipsStyle = css({
  padding: "4px",
  color: cssVar("textSecondaryColor"),
  fontSize: "14px",
  fontWeight: 500,
  lineHeight: "22px",
  userSelect: "none",
});

export const selectOptionsContainerStyle = css({
  maxHeight: "400px",
  overflowY: "auto",
  userSelect: "none",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
});

export const selectOptionStyle = css({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "4px 4px 4px 0",
  borderRadius: "4px",
  cursor: "pointer",
});

export const selectedStyle = css({
  background: cssVar("hoverColor"),
});

export const tagContainerStyle = css({
  display: "flex",
  alignItems: "center",
  padding: "0 8px",
  gap: "4px",
  borderRadius: "4px",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
  overflow: "hidden",
  border: `1px solid ${cssVar("borderColor")}`,
  userSelect: "none",
});

export const tagTextStyle = css({
  fontSize: "14px",
  lineHeight: "22px",
  overflow: "hidden",
  textOverflow: "ellipsis",
});

export const tagDeleteIconStyle = css({
  display: "flex",
  alignItems: "center",
  color: cssVar("textSecondaryColor"),
});

export const selectOptionContentStyle = css({
  display: "flex",
  alignItems: "center",
  overflow: "hidden",
});

export const selectOptionIconStyle = css({
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  fontSize: "20px",
  borderRadius: "4px",
  cursor: "pointer",
  visibility: "hidden",
  color: cssVar("iconColor"),
  marginLeft: "4px",
  ":hover": {
    background: cssVar("hoverColor"),
  },
  [`.${selectedStyle} &`]: {
    visibility: "visible",
  },
});

export const selectOptionDragHandlerStyle = css({
  width: "4px",
  height: "12px",
  borderRadius: "1px",
  backgroundColor: cssVar("black10"),
  marginRight: "4px",
  cursor: "-webkit-grab",
  flexShrink: 0,
});

export const selectOptionNewIconStyle = css({
  fontSize: "14px",
  lineHeight: "22px",
  color: cssVar("textPrimaryColor"),
  marginRight: "8px",
  marginLeft: "4px",
});
