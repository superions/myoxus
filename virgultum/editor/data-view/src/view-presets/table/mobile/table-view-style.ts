import { cssVar } from "@myoxus/theme";
import { css } from "@virgultum/shared/styles";

export const mobileTableViewWrapper = css({
  position: "relative",
  width: "100%",
  paddingBottom: "4px",
  overflowY: "hidden",
});

export const mobileTableViewContainer = css({
  position: "relative",
  width: "fit-content",
  minWidth: "100%",
});

export const mobileCellDivider = css({
  width: "1px",
  height: "100%",
  backgroundColor: cssVar("borderColor"),
});
