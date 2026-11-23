import { signal } from "@preact/signals-core";
import { createElement, type ReactNode } from "react";
import { NativeAIWidgetUI } from "../native-ui";
import { AIActionMenu } from "../ai-panel/view";
import { stopPropagation } from "@virgultum/editor/shared/utils";
import { NativeViewElement, type EditorHost } from "@virgultum/editor/std";

import type { AIItemGroupConfig } from "../../components/ai-item/types";

export class EdgelessCopilotPanel extends NativeViewElement {
  host!: EditorHost;
  groups!: AIItemGroupConfig[];
  onClick?: () => void;
  private dispose?: () => void;

  connectedCallback() {
    const mount = this.host.std.getOptional(NativeAIWidgetUI);
    if (!mount) return;
    const chain = this.host.std.command.chain();
    const groups = this.groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          item.showWhen?.(chain, "edgeless", this.host),
        ),
      }))
      .filter((group) => group.items.length > 0);
    if (!groups.length) return;
    this.style.position = "absolute";
    this.style.zIndex = "var(--myoxus-z-index-popover)";
    const events = new AbortController();
    for (const name of ["wheel", "pointerdown"] as const)
      this.addEventListener(name, stopPropagation, { signal: events.signal });
    const release = mount(
      this,
      signal<ReactNode>(
        createElement(AIActionMenu, {
          host: this.host,
          groups,
          maxHeight: "floating",
          onChoose: () => this.onClick?.(),
        }),
      ),
    );
    this.dispose = () => {
      events.abort();
      release();
    };
  }

  disconnectedCallback() {
    this.dispose?.();
    this.dispose = undefined;
  }

  hide() {
    this.remove();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-copilot-panel": EdgelessCopilotPanel;
  }
}
