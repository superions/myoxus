import { css, unsafeCSS } from "lit";

import { unsafeCSSValue, unsafeCSSVar } from "../theme/css-variables";
import { fontSMStyle } from "./font";

export const panelBaseColorsStyle = (container: string) => css`
  ${unsafeCSS(container)} {
    color: var(--myoxus-icon-color);
    box-shadow: var(--myoxus-overlay-shadow);
    background: ${unsafeCSSVar("backgroundOverlayPanelColor")};
  }
`;

export const panelBaseStyle = (container: string) => css`
  ${unsafeCSS(container)} {
    display: flex;
    align-items: center;
    gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    width: max-content;
    padding: 0
      ${unsafeCSSValue(
        "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
      )};
    border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
    border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
      ${unsafeCSSVar("borderColor")};
  }
  ${panelBaseColorsStyle(container)}
  ${fontSMStyle(container)}
`;
