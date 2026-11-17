import { WithDisposable } from "@virgultum/editor/global/lit";
import { DocModeProvider } from "@virgultum/editor/shared/services";
import { createElement } from "react";
import { ShadowlessElement } from "@virgultum/editor/std";
import { AIWidgetUI } from "../widgets/native-ui";
import { AIActionMenu } from "../widgets/ai-panel/view";
import { type EditorHost } from "@virgultum/editor/std";
import { property } from "lit/decorators.js";

import type { AIItemGroupConfig } from "./ai-item/types";

export type AskAIPanelWidth = "default" | "comfortable" | "wide" | "display";

export class AskAIPanel extends WithDisposable(ShadowlessElement) {
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
    return this.host.std.get(AIWidgetUI)(
      createElement(AIActionMenu, {
        host: this.host,
        groups: this._actionGroups,
        onChoose: this.onItemClick,
        panelWidth: this.panelWidth,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ask-ai-panel": AskAIPanel;
  }
}
