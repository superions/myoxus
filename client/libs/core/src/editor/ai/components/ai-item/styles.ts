import { fontSMStyle, fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css } from "lit";

export const menuItemStyles = css`
  .menu-item {
    position: relative;
    width: 100%;
    display: flex;
    flex-direction: row;
    align-items: center;
    padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")}
      var(--item-padding, ${unsafeCSSValue("var(--mantine-spacing-md)")});
    gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    align-self: stretch;
    border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
    box-sizing: border-box;
  }

  .menu-item:hover {
    background: ${unsafeCSSVar("--myoxus-hover-color")};
    cursor: pointer;
  }

  .item-icon {
    display: flex;
    color: ${unsafeCSSVar("--myoxus-brand-color")};

    svg {
      width: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
    }
  }

  .menu-item:hover .item-icon {
    color: ${unsafeCSSVar("--myoxus-brand-color")};
  }

  .menu-item.discard:hover {
    background: ${unsafeCSSVar("backgroundErrorColor")};
    .item-name,
    .item-icon,
    .enter-icon {
      color: ${unsafeCSSVar("errorColor")};
    }
  }

  .item-name {
    display: flex;
    padding: 0 ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    align-items: baseline;
    flex: 1 0 0;
    color: ${unsafeCSSVar("textPrimaryColor")};
    text-align: start;
    white-space: nowrap;
  }

  .item-beta {
    color: ${unsafeCSSVar("textSecondaryColor")};
    margin-left: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
  }

  .enter-icon,
  .arrow-right-icon {
    color: ${unsafeCSSVar("iconColor")};
    display: flex;
  }

  .enter-icon {
    opacity: 0;
  }

  .arrow-right-icon,
  .menu-item:hover .enter-icon {
    opacity: 1;
  }

  ${fontSMStyle(".item-name")}
  ${fontXSStyle(".item-beta")}
`;
