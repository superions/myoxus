import { createElement } from "react";
import {
  ViewIcon as NativeViewIcon,
  PageIcon as NativePageIcon,
} from "@myoxus/icons/react";
import { renderToolCallCard, renderToolResultCard } from "./tool-cards";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";

import type { ReactToLit } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/core/primitives/lit";
import { ShadowlessElement } from "@virgultum/core/runtime";
import { nothing } from "lit";
import { property } from "lit/decorators.js";

interface DocReadToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: { doc_id: string };
}

interface DocReadToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  args: { doc_id: string };
  result: {
    /** Old result may not have docId */
    docId?: string;
    title: string;
    markdown: string;
  };
}

export class DocReadResult extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  @property({ attribute: false })
  accessor data!: DocReadToolCall | DocReadToolResult;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  renderToolCall() {
    // TODO: get document name by doc_id
    return renderToolCallCard(this.reactToLit, {
      name: `Reading document`,
      icon: createElement(NativeViewIcon),
    });
  }

  renderToolResult() {
    if (this.data.type !== "tool-result") {
      return nothing;
    }
    // TODO: better markdown rendering
    return renderToolResultCard(this.reactToLit, {
      name: `Read "${this.data.result.title}"`,
      icon: createElement(NativeViewIcon),
      results: [
        {
          title: this.data.result.title,
          icon: createElement(NativePageIcon),
          content: this.data.result.markdown,
          onClick: () => {
            const docId = (this.data as DocReadToolResult).result.docId;
            if (!docId) {
              return;
            }
            this.peekViewService.peekView
              .open({
                type: "doc",
                docRef: { docId },
              })
              .catch(console.error);
          },
        },
      ],
    });
  }

  protected override render() {
    if (this.data.type === "tool-call") {
      return this.renderToolCall();
    }
    if (this.data.type === "tool-result") {
      return this.renderToolResult();
    }
    return nothing;
  }
}
