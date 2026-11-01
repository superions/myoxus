import { baseTheme } from "@myoxus/theme";
import { css } from "@virgultum/shared/styles";

export const textStyle = css({
  display: "flex",
  alignItems: "center",
  height: "100%",
  width: "100%",
  padding: "0",
  border: "none",
  fontFamily: baseTheme.fontSansFamily,
  fontSize: "var(--myoxus-font-base)",
  lineHeight: "var(--myoxus-line-height)",
  color: "var(--myoxus-text-primary-color)",
  fontWeight: "400",
  backgroundColor: "transparent",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

export const textInputStyle = css({
  display: "flex",
  alignItems: "center",
  height: "100%",
  width: "100%",
  padding: "0",
  border: "none",
  fontFamily: baseTheme.fontSansFamily,
  fontSize: "var(--myoxus-font-base)",
  lineHeight: "var(--myoxus-line-height)",
  color: "var(--myoxus-text-primary-color)",
  fontWeight: "400",
  backgroundColor: "transparent",
  cursor: "text",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  ":focus": {
    outline: "none",
  },
});
