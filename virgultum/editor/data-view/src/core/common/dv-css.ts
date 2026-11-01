import { cssVar } from "@myoxus/theme";
import { css } from "@virgultum/shared/styles";

export const dataViewVars = {
  cellTextSize: "--myoxus-data-view-cell-text-size",
  cellTextLineHeight: "--myoxus-data-view-cell-text-line-height",
};

export const dataViewRoot = css({
  fontFamily: "var(--myoxus-font-family)",
  [dataViewVars.cellTextSize]:
    "var(--mantine-font-size-nav, var(--mantine-font-size-md))",
  [dataViewVars.cellTextLineHeight]:
    "var(--mantine-line-height-nav, var(--mantine-line-height-md))",
});

export const withDataViewCssVariable = css({
  fontFamily: "var(--myoxus-font-family)",
  [dataViewVars.cellTextSize]:
    "var(--mantine-font-size-nav, var(--mantine-font-size-md))",
  [dataViewVars.cellTextLineHeight]:
    "var(--mantine-line-height-nav, var(--mantine-line-height-md))",
});

export const p2 = css({
  padding: "2px",
});
export const p4 = css({
  padding: "4px",
});
export const p8 = css({
  padding: "8px",
});

export const hover = css({
  "&:hover, &.active": {
    backgroundColor: "var(--myoxus-hover-color)",
    cursor: "pointer",
  },
});

export const icon16 = css({
  fontSize: "16px",
  color: cssVar("iconColor"),
});
export const icon20 = css({
  fontSize: "20px",
  color: cssVar("iconColor"),
});

export const border = css({
  border: `1px solid ${cssVar("borderColor")}`,
});
export const round4 = css({
  borderRadius: "4px",
});
export const round8 = css({
  borderRadius: "8px",
});
export const color2 = css({
  color: "var(--myoxus-text-secondary-color)",
});
export const shadow2 = css({
  boxShadow: "var(--myoxus-shadow-2)",
});

export const dividerH = css({
  height: "1px",
  backgroundColor: "var(--myoxus-divider-color)",
  margin: "8px 0",
});
export const dividerV = css({
  width: "1px",
  backgroundColor: "var(--myoxus-divider-color)",
  margin: "0 8px",
});

export const dv = {
  p2,
  p4,
  p8,
  hover,
  icon16,
  icon20,
  border,
  round4,
  round8,
  color2,
  shadow2,
  dividerH,
  dividerV,
};
