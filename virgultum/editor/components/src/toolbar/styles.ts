import {
  type MyoxusCssVariables,
  darkCssVariables,
  lightCssVariables,
} from "@myoxus/theme";
import { unsafeCSS } from "lit";

const toolbarColorKeys: Array<keyof MyoxusCssVariables> = [
  "--myoxus-background-overlay-panel-color",
  "--myoxus-black-10" as never,
  "--myoxus-icon-color" as never,
  "--myoxus-background-error-color",
  "--myoxus-background-primary-color",
  "--myoxus-background-tertiary-color",
  "--myoxus-icon-color",
  "--myoxus-icon-secondary",
  "--myoxus-border-color",
  "--myoxus-divider-color",
  "--myoxus-text-primary-color",
  "--myoxus-hover-color",
  "--myoxus-hover-color-filled",
];

export const lightToolbarStyles = (selector: string) => `
  ${selector}[data-app-theme='light'] {
    ${toolbarColorKeys
      .map((key) => `${key}: ${unsafeCSS(lightCssVariables[key])};`)
      .join("\n")}
  }
`;

export const darkToolbarStyles = (selector: string) => `
  ${selector}[data-app-theme='dark'] {
    ${toolbarColorKeys
      .map((key) => `${key}: ${unsafeCSS(darkCssVariables[key])};`)
      .join("\n")}
  }
`;
