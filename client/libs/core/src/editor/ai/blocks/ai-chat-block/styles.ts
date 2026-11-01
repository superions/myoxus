import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css } from "lit";

export const AIChatBlockStyles = css`
  .myoxus-ai-chat-block-container {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    padding: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
    color: ${unsafeCSSVar("textPrimaryColor")};
    border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
    user-select: none;
    pointer-events: none;

    .ai-chat-messages-container {
      display: block;
      flex: 1 0 0;
      width: 100%;
      box-sizing: border-box;
      background: linear-gradient(
        to top,
        transparent,
        ${unsafeCSSVar("backgroundPrimaryColor")}
      );
      -webkit-mask-image: linear-gradient(
        to bottom,
        ${unsafeCSSVar("backgroundPrimaryColor")} 25%,
        transparent
      );
      mask-image: linear-gradient(
        to bottom,
        ${unsafeCSSVar("backgroundPrimaryColor")} 25%,
        transparent
      );
      overflow: hidden;
    }

    .ai-chat-block-button {
      display: flex;
      width: 100%;
      min-height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))",
      )};
      flex-direction: row;
      align-items: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      svg {
        color: ${unsafeCSSVar("iconColor")};
      }
    }
  }

  ${fontSMStyle(".myoxus-ai-chat-block-container")}
  ${fontSMStyle(".ai-chat-block-button")}
`;
