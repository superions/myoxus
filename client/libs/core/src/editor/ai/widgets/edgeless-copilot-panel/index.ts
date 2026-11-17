import { WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { createElement } from "react";
import { AIWidgetUI } from "../native-ui";
import { AIActionMenu } from "../ai-panel/view";
import { on, stopPropagation } from "@virgultum/editor/shared/utils";
import type { EditorHost } from "@virgultum/editor/std";
import { nothing } from "lit";
import { property } from "lit/decorators.js";

import type { AIItemGroupConfig } from "../../components/ai-item/types";

export class EdgelessCopilotPanel extends WithDisposable(ShadowlessElement) {
  private _getChain() {
    return this.host.std.command.chain();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.position = "absolute";
    this.style.zIndex = "var(--myoxus-z-index-popover)";
    this._disposables.add(on(this, "wheel", stopPropagation));
    this._disposables.add(on(this, "pointerdown", stopPropagation));
  }

  hide() {
    this.remove();
  }

  override render() {
    const chain = this._getChain();
    const groups = this.groups.reduce((pre, group) => {
      const filtered = group.items.filter((item) =>
        item.showWhen?.(chain, "edgeless", this.host),
      );

      if (filtered.length > 0) pre.push({ ...group, items: filtered });

      return pre;
    }, [] as AIItemGroupConfig[]);

    if (groups.every((group) => group.items.length === 0)) return nothing;

    return this.host.std.get(AIWidgetUI)(
      createElement(AIActionMenu, {
        host: this.host,
        groups,
        maxHeight: "floating",
        onChoose: () => this.onClick?.(),
      }),
    );
  }

  @property({ attribute: false })
  accessor entry: "toolbar" | "selection" | undefined = undefined;

  @property({ attribute: false })
  accessor groups!: AIItemGroupConfig[];

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor onClick: (() => void) | undefined = undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-copilot-panel": EdgelessCopilotPanel;
  }
}
