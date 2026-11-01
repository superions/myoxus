import { css, unsafeCSS } from "lit";

import { unsafeCSSValue, unsafeCSSVar } from "../theme/css-variables";

/**
 * You should add a container before the scrollbar style to prevent the style pollution of the whole doc.
 */
export const scrollbarStyle = (container: string) => {
  if (!container) {
    console.error(
      "To prevent style pollution of the whole doc, you must add a container before the scrollbar style.",
    );
    return css``;
  }

  // sanitize container name
  if (container.includes("{") || container.includes("}")) {
    console.error("Invalid container name! Please use a valid CSS selector.");
    return css``;
  }

  return css`
    ${unsafeCSS(container)} {
      scrollbar-gutter: stable;
    }
    ${unsafeCSS(container)}::-webkit-scrollbar {
      -webkit-appearance: none;
      width: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      height: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    }
    ${unsafeCSS(container)}::-webkit-scrollbar-thumb {
      border-radius: ${unsafeCSSValue("var(--mantine-radius-xs)")};
      background-color: ${unsafeCSSVar("iconSecondary")};
    }
    ${unsafeCSS(container)}::-webkit-scrollbar-corner {
      display: none;
    }
  `;
};
