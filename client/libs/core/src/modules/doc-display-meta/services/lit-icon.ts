import * as litIcons from "@myoxus/icons/lit";
import { type IconData, IconType } from "@myoxus/ui-facade";
import { html } from "lit";
export const getDocIconComponentLit = (icon: IconData) => {
  return () => {
    if (icon.type === IconType.Emoji) {
      return html`<div class="icon">${icon.unicode}</div>`;
    }
    if (icon.type === IconType.MyoxusIcon) {
      return html`<div
        style="color: ${icon.color}; display: flex; align-items: center; justify-content: center;"
      >
        ${litIcons[`${icon.name}Icon` as keyof typeof litIcons]()}
      </div>`;
    }
    return html``;
  };
};

export function litDocIcon(
  icon:
    | IconData
    | "BlockLinkIcon"
    | "LinkIcon"
    | "PageIcon"
    | "EdgelessIcon"
    | "YesterdayIcon"
    | "TomorrowIcon"
    | "TodayIcon",
) {
  return typeof icon === "string"
    ? litIcons[icon]
    : getDocIconComponentLit(icon);
}
