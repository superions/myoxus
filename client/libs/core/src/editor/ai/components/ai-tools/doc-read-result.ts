import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import { PageIcon, ViewIcon } from "@myoxus/icons/lit";
import type { ReactToLit } from "@myoxus/lit-react";
import type { Signal } from "@preact/signals-core";
import { WithDisposable } from "@virgultum/global/lit";
import { ShadowlessElement } from "@virgultum/std";
import { html, nothing } from "lit";
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
  accessor width: Signal<number | undefined> | undefined;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  renderToolCall() {
    // TODO: get document name by doc_id
    return html`<tool-call-card
      .reactToLit=${this.reactToLit}
      .name=${`Reading document`}
      .icon=${ViewIcon()}
      .width=${this.width}
    ></tool-call-card>`;
  }

  renderToolResult() {
    if (this.data.type !== "tool-result") {
      return nothing;
    }
    // TODO: better markdown rendering
    return html`<tool-result-card
      .reactToLit=${this.reactToLit}
      .name=${`Read "${this.data.result.title}"`}
      .icon=${ViewIcon()}
      .width=${this.width}
      .results=${[
        {
          title: this.data.result.title,
          icon: PageIcon(),
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
      ]}
    ></tool-result-card>`;
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
