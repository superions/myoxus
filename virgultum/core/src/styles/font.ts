import { css, unsafeCSS } from "lit";

import { unsafeCSSValue } from "../theme/css-variables";

export type WebTypographySlot =
  | "nav"
  | "section"
  | "section-title"
  | "card-title"
  | "label-compact"
  | "body-small"
  | "dense-label"
  | "journal-title"
  | "journal-caption"
  | "mobile-dialog";

export const fontBaseStyle = (container: string) => css`
  ${unsafeCSS(container)} {
    font-family: ${unsafeCSSValue(
      "var(--mantine-font-family-nav, var(--mantine-font-family))",
    )};
    font-feature-settings:
      "clig" off,
      "liga" off;
    font-style: normal;
  }
`;

/**
 * Projects a named Myoxus web typography slot into Lit-based editor chrome.
 *
 * Product code should call this helper instead of declaring local
 * font-size/weight/line-height values. The slots are owned by the global theme
 * projection and are mirrored into the Mantine theme by @myoxus/ui-facade.
 */
export const fontWebStyle = (container: string, slot: WebTypographySlot) => css`
  ${unsafeCSS(container)} {
    font-family: ${unsafeCSSValue(
      `var(--mantine-font-family-${slot}, var(--mantine-font-family))`,
    )};
    font-feature-settings:
      "clig" off,
      "liga" off;
    font-size: ${unsafeCSSValue(
      `var(--mantine-font-size-${slot}, var(--mantine-font-size-md))`,
    )};
    font-style: normal;
    font-weight: ${unsafeCSSValue(
      `var(--mantine-font-weight-${slot}, var(--mantine-font-weight-regular))`,
    )};
    line-height: ${unsafeCSSValue(
      `var(--mantine-line-height-${slot}, var(--mantine-line-height-md))`,
    )};
  }
`;

/**
 * Projects the global mono typography slot into Lit code/content previews.
 *
 * This is for code rendering surfaces only. Normal product chrome should use
 * `fontSMStyle`, `fontXSStyle` or `fontWebStyle`.
 */
export const fontMonoStyle = (container: string) => css`
  ${unsafeCSS(container)} {
    font-family: var(
      --myoxus-typography-mono-family,
      var(--myoxus-font-code-family)
    );
    font-feature-settings:
      "clig" off,
      "liga" off;
    font-size: var(--myoxus-typography-mono-size);
    font-style: var(--myoxus-typography-mono-font-style);
    font-weight: var(--myoxus-typography-mono-weight);
    line-height: var(--myoxus-typography-mono-line-height);
  }
`;

export const fontSMStyle = (container: string) => css`
  ${fontBaseStyle(container)}
  ${unsafeCSS(container)} {
    font-size: ${unsafeCSSValue(
      "var(--mantine-font-size-nav, var(--mantine-font-size-md))",
    )};
    font-weight: ${unsafeCSSValue(
      "var(--mantine-font-weight-nav, var(--mantine-font-weight-regular))",
    )};
    line-height: ${unsafeCSSValue(
      "var(--mantine-line-height-nav, var(--mantine-line-height-md))",
    )};
  }
`;

export const fontXSStyle = (container: string) => css`
  ${fontBaseStyle(container)}
  ${unsafeCSS(container)} {
    font-size: ${unsafeCSSValue(
      "var(--mantine-font-size-body-small, var(--mantine-font-size-md))",
    )};
    font-weight: ${unsafeCSSValue(
      "var(--mantine-font-weight-body-small, var(--mantine-font-weight-regular))",
    )};
    line-height: ${unsafeCSSValue(
      "var(--mantine-line-height-body-small, var(--mantine-line-height-md))",
    )};
  }
`;
