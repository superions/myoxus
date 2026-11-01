import { EmptyIcon } from "@myoxus/icons/lit";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontWebStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { ShadowlessElement } from "@virgultum/editor/std";
import { css, html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

import type { AIChatContent } from "../ai-chat-content";

function getChatPanel(target: HTMLElement) {
  return target.closest("ai-chat-content") as AIChatContent;
}

export const isPreviewPanelOpen = (target: HTMLElement) => {
  const chatPanel = getChatPanel(target);
  return chatPanel?.isPreviewPanelOpen ?? false;
};

export const renderPreviewPanel = (
  target: HTMLElement,
  content: TemplateResult<1>,
  controls?: TemplateResult<1>,
) => {
  const chatPanel = getChatPanel(target);

  if (!chatPanel) {
    console.error("chat-panel not found");
    return;
  }

  const preview = html`<artifact-preview-panel
    .content=${content}
    .controls=${controls ?? nothing}
  ></artifact-preview-panel>`;
  chatPanel.openPreviewPanel(preview);
};

export const closePreviewPanel = (target: HTMLElement) => {
  const chatPanel = getChatPanel(target);

  if (!chatPanel) {
    console.error("chat-panel not found");
    return;
  }

  chatPanel.closePreviewPanel();
};

export class ArtifactPreviewPanel extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    .artifact-panel-preview-root {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      padding: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
    }

    .artifact-preview-panel {
      border-radius: ${unsafeCSSValue("var(--mantine-radius-xl)")};
      background-color: ${unsafeCSSVar("backgroundOverlayPanelColor")};
      box-shadow: ${unsafeCSSVar("overlayPanelShadow")};
      height: 100%;
      overflow: hidden;
    }

    .artifact-panel-header {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-md)")};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
      background: ${unsafeCSSVar("backgroundOverlayPanelColor")};
    }

    .artifact-panel-title {
      color: ${unsafeCSSVar("textPrimaryColor")};
    }

    ${fontWebStyle(".artifact-panel-title", "card-title")}

    .artifact-panel-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      flex: 1;
    }

    .artifact-panel-close {
      margin-left: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      display: flex;
      align-items: center;
      justify-content: center;
      width: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
      height: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
      border-radius: 50%;
      cursor: pointer;
      transition: background-color ${unsafeCSSValue("200ms")} ease-in-out;
      color: ${unsafeCSSVar("iconSecondary")};
    }

    .artifact-panel-content {
      overflow-y: auto;
      height: calc(
        100% -
          ${unsafeCSSValue(
            "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
          )}
      );
      position: relative;
    }

    .artifact-panel-close:hover {
      background-color: ${unsafeCSSVar("backgroundTertiaryColor")};
    }
  `;

  @property({ attribute: false })
  accessor content: TemplateResult<1> | null = null;

  @property({ attribute: false })
  accessor controls: TemplateResult<1> | null = null;

  private readonly _handleClose = () => {
    closePreviewPanel(this);
  };

  protected override render() {
    return html`<div class="artifact-panel-preview-root">
      <div class="artifact-preview-panel">
        <div class="artifact-panel-header">
          <div class="artifact-panel-actions">
            ${this.controls ?? nothing}
            <icon-button
              class="artifact-panel-close"
              @click=${this._handleClose}
            >
              ${EmptyIcon({
                width: "var(--mantine-spacing-xl)",
                height: "var(--mantine-spacing-xl)",
              })}
            </icon-button>
          </div>
        </div>
        <div class="artifact-panel-content">${this.content}</div>
      </div>
    </div>`;
  }
}
