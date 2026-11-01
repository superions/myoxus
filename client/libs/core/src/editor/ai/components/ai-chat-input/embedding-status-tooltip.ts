import type { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { SignalWatcher } from "@virgultum/editor/global/lit";
import { fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { debounce } from "lodash-es";

export class AIChatEmbeddingStatusTooltip extends SignalWatcher(LitElement) {
  static override styles = css`
    :host {
      width: 100%;
    }
    .embedding-status {
      display: flex;
      width: 100%;
      align-items: center;
      justify-content: space-between;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      user-select: none;
    }
    .embedding-status-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: min(
        100%,
        calc(
          ${unsafeCSSValue(
            "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
          )} *
            12 +
            ${unsafeCSSValue(
              "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
            )}
        )
      );
    }
    .check-status {
      padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      cursor: pointer;
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
    }
    .check-status:hover {
      background-color: ${unsafeCSSVar("hoverColor")};
    }

    ${fontXSStyle(".embedding-status")}
  `;

  @property({ attribute: false })
  accessor myoxusWorkspaceDialogService!: WorkspaceDialogService;

  override connectedCallback() {
    super.connectedCallback();
  }

  private readonly _handleCheckStatusClick = debounce(
    () => {
      this.myoxusWorkspaceDialogService.open("workspace-settings", {
        activeTab: "workspace:embedding",
      });
    },
    1000,
    { leading: true },
  );

  override render() {
    return html`
      <div
        class="embedding-status"
        data-testid="ai-chat-embedding-status-tooltip"
      >
        <div class="embedding-status-text">
          Better results after embedding finished.
        </div>
        <div
          class="check-status"
          data-testid="ai-chat-embedding-status-tooltip-check"
          @click=${this._handleCheckStatusClick}
        >
          Check status
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-chat-embedding-status-tooltip": AIChatEmbeddingStatusTooltip;
  }
}
