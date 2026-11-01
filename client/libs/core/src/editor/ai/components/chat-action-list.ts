import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import type { ImageSelection } from "@virgultum/editor/shared/selection";
import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import type {
  BlockSelection,
  EditorHost,
  TextSelection,
} from "@virgultum/editor/std";
import type { NotificationService } from "@virgultum/shared/services";
import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";

import type { ChatAction } from "../_common/chat-actions-handle";
import { insertBelow } from "../utils/editor-actions";

export class ChatActionList extends LitElement {
  static override styles = css`
    .actions-container {
      display: flex;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    }
    .actions-container > div {
      display: flex;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    }
    .actions-container[data-with-margin="true"] {
      margin-top: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    }
    .actions-container.horizontal {
      flex-wrap: wrap;
      justify-content: end;
    }
    .actions-container.vertical {
      flex-direction: column;
      align-items: flex-end;
    }
    .action {
      width: fit-content;
      min-height: ${unsafeCSSValue("var(--mantine-spacing-2xl)")};
      padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")}
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-2xs))",
        )};
      box-sizing: border-box;
      border-radius: ${unsafeCSSValue("var(--mantine-radius-md)")};
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        var(--myoxus-border-color);
      background-color: var(--myoxus-white-10);
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      color: var(--myoxus-text-primary-color);
      cursor: pointer;
      user-select: none;
    }
    .action svg {
      color: var(--myoxus-icon-color);
    }

    ${fontSMStyle(".action")}
  `;

  private get _selectionValue() {
    return this.host.selection.value;
  }

  private get _currentTextSelection(): TextSelection | undefined {
    return this._selectionValue.find((v) => v.type === "text") as TextSelection;
  }

  private get _currentBlockSelections(): BlockSelection[] | undefined {
    return this._selectionValue.filter((v) => v.type === "block");
  }

  private get _currentImageSelections(): ImageSelection[] | undefined {
    return this._selectionValue.filter((v) => v.type === "image");
  }

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor actions: ChatAction[] = [];

  @property({ attribute: false })
  accessor content: string = "";

  @property({ attribute: false })
  accessor session!: CopilotChatHistoryFragment | null | undefined;

  @property({ attribute: false })
  accessor messageId: string | undefined = undefined;

  @property({ attribute: false })
  accessor layoutDirection: "horizontal" | "vertical" = "vertical"; // New property for layout direction

  @property({ attribute: false })
  accessor withMargin = false;

  @property({ attribute: "data-testid", reflect: true })
  accessor testId = "chat-action-list";

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  override render() {
    const { actions } = this;
    if (!actions.length) {
      return nothing;
    }

    const { host, content, messageId, layoutDirection } = this;
    const classes = classMap({
      "actions-container": true,
      horizontal: layoutDirection === "horizontal",
      vertical: layoutDirection === "vertical",
    });

    return html`<div class=${classes} data-with-margin=${this.withMargin}>
      ${repeat(
        actions.filter((action) => action.showWhen(host)),
        (action) => action.title,
        (action) => {
          return html`<div
            class="action"
            @click=${async () => {
              if (
                action.title === "Insert below" &&
                this._selectionValue.length === 1 &&
                this._selectionValue[0].type === "database"
              ) {
                const element = this.host.view.getBlock(
                  this._selectionValue[0].blockId,
                );
                if (!element) return;
                await insertBelow(host, content, element);
                return;
              }
              const currentSelections = {
                text: this._currentTextSelection,
                blocks: this._currentBlockSelections,
                images: this._currentImageSelections,
              };
              const sessionId = this.session?.sessionId;
              const success = await action.handler(
                host,
                content,
                currentSelections,
                sessionId,
                messageId,
              );
              if (success) {
                this.notificationService.notify({
                  title: action.toast,
                  accent: "success",
                  onClose: function (): void {},
                });
              }
            }}
          >
            ${action.icon}
            <div
              data-testid="action-${action.title
                .toLowerCase()
                .replaceAll(" ", "-")}"
            >
              ${action.title}
            </div>
          </div>`;
        },
      )}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-action-list": ChatActionList;
  }
}
