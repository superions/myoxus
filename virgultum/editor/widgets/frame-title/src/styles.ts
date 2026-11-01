import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css } from "lit";

export const frameTitleStyleVars = {
  nestedFrameOffset: 4,
  height: 22,
  fontSize: 14,
};

export const frameTitleStyle = css`
  :host {
    position: absolute;
    display: flex;
    align-items: center;
    z-index: 3;
    border: 1px solid ${unsafeCSSVar("borderColor")};
    border-radius: 4px;
    width: fit-content;
    height: ${frameTitleStyleVars.height}px;
    padding: 0px 4px;
    transform-origin: left bottom;
    background-color: var(--bg-color);

    font-family: var(--myoxus-font-family);
    font-size: ${frameTitleStyleVars.fontSize}px;
    cursor: default;
    /* Only the title owns DOM click/edit handlers. Keep the surrounding frame
       pointer-transparent so it cannot intercept canvas controls or toolbars. */
    pointer-events: auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :hover {
    background-color: color-mix(in srgb, var(--bg-color), #000000 7%);
  }
`;
