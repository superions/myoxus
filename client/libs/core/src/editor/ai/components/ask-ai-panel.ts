import { WithDisposable } from "@virgultum/editor/global/lit";
import { DocModeProvider } from "@virgultum/editor/shared/services";
import { scrollbarStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { type EditorHost } from "@virgultum/editor/std";
import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

import type { AIItemGroupConfig } from "./ai-item/types";

export type AskAIPanelWidth = "default" | "comfortable" | "wide" | "display";

export class AskAIPanel extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      position: relative;
    }

    .ask-ai-panel {
      box-sizing: border-box;
      min-inline-size: ${unsafeCSSValue(
        "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 7)",
      )};
      padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")}
        ${unsafeCSSValue("var(--mantine-spacing-xs)")}
        ${unsafeCSSValue("var(--mantine-spacing-sm)")}
        ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      max-block-size: ${unsafeCSSValue(
        "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 13)",
      )};
      overflow-y: auto;
      background: ${unsafeCSSVar("backgroundOverlayPanelColor")};
      box-shadow: ${unsafeCSSVar("overlayPanelShadow")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
      z-index: var(--myoxus-z-index-popover);
      scrollbar-gutter: stable;
    }

    .ask-ai-panel[data-panel-width="default"] {
      min-inline-size: ${unsafeCSSValue(
        "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 4 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))\n  )",
      )};
    }

    .ask-ai-panel[data-panel-width="comfortable"] {
      min-inline-size: ${unsafeCSSValue(
        "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 5 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))\n  )",
      )};
    }

    .ask-ai-panel[data-panel-width="wide"] {
      min-inline-size: ${unsafeCSSValue(
        "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 6 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))\n  )",
      )};
    }

    .ask-ai-panel[data-panel-width="display"] {
      min-inline-size: ${unsafeCSSValue(
        "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 7)",
      )};
    }

    ${scrollbarStyle(".ask-ai-panel")}
  `;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor actionGroups!: AIItemGroupConfig[];

  @property({ attribute: false })
  accessor abortController: AbortController | null = null;

  @property({ attribute: false })
  accessor onItemClick: (() => void) | undefined = undefined;

  @property({ attribute: false })
  accessor panelWidth: AskAIPanelWidth = "display";

  get _isEdgelessMode() {
    return this.host.std.get(DocModeProvider).getEditorMode() === "edgeless";
  }

  get _actionGroups() {
    const filteredConfig = this.actionGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          item.showWhen
            ? item.showWhen(
                this.host.command.chain(),
                this._isEdgelessMode ? "edgeless" : "page",
                this.host,
              )
            : true,
        ),
      }))
      .filter((group) => group.items.length > 0);
    return filteredConfig;
  }

  override render() {
    return html`<div class="ask-ai-panel" data-panel-width=${this.panelWidth}>
      <ai-item-list
        .host=${this.host}
        .groups=${this._actionGroups}
        .onClick=${this.onItemClick}
      ></ai-item-list>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ask-ai-panel": AskAIPanel;
  }
}
