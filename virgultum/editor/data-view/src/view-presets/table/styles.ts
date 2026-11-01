import { cssVar } from "@myoxus/theme";
import { css } from "@virgultum/shared/styles";

export const cellDivider = css({
  height: "100%",
  width: "1px",
  backgroundColor: cssVar("borderColor"),
});
