import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css } from "lit";

export const PeekViewStyles = css`
  ai-chat-block-peek-view {
    width: 100%;
    height: 100%;

    .ai-chat-block-peek-view-container {
      width: 100%;
      height: 100%;
      display: flex;
      box-sizing: border-box;
      justify-content: start;
      flex-direction: column;
      padding: ${unsafeCSSValue("var(--mantine-spacing-xl)")}
        var(--myoxus-editor-content-padding-inline)
        ${unsafeCSSValue("var(--mantine-spacing-lg)")};
    }

    .ai-chat-messages-container {
      display: flex;
      align-items: center;
      justify-content: start;
      flex-direction: column;
      box-sizing: border-box;
      width: 100%;
      color: ${unsafeCSSVar("textPrimaryColor")};
      overflow-y: auto;
      overflow-x: hidden;
      flex: 1;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
      -ms-overflow-style: none; /* IE and Edge */
      scrollbar-width: none; /* Firefox */
    }

    .new-chat-messages-container {
      width: 100%;
      box-sizing: border-box;
      min-height: calc(
        ${unsafeCSSValue("calc(var(--mantine-spacing-2xl) * 2)")} * 3
      );
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
    }

    .ai-chat-messages-container::-webkit-scrollbar {
      display: none;
    }

    .assistant-message-container {
      width: 100%;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    }

    .history-clear-container {
      display: flex;
      align-items: center;
      flex-direction: row-reverse;
      width: 100%;
    }

    ${fontSMStyle(".ai-chat-messages-container")}
  }
`;
