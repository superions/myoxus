import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import { PageIcon, SearchIcon } from "@myoxus/icons/lit";
import type { ReactToLit } from "@myoxus/lit-react";
import type { Signal } from "@preact/signals-core";
import { WithDisposable } from "@virgultum/global/lit";
import { ShadowlessElement } from "@virgultum/std";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";

import type { ToolResult } from "./tool-result-card";

interface DocKeywordSearchToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: { query: string };
}

interface DocKeywordSearchToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  args: { query: string };
  result: Array<{
    title: string;
    docId: string;
  }>;
}

export class DocKeywordSearchResult extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  @property({ attribute: false })
  accessor data!: DocKeywordSearchToolCall | DocKeywordSearchToolResult;

  @property({ attribute: false })
  accessor width: Signal<number | undefined> | undefined;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  renderToolCall() {
    return html`<tool-call-card
      .reactToLit=${this.reactToLit}
      .name=${`Searching workspace documents for "${this.data.args.query}"`}
      .icon=${SearchIcon()}
      .width=${this.width}
    ></tool-call-card>`;
  }

  renderToolResult() {
    if (this.data.type !== "tool-result") {
      return nothing;
    }
    let results: ToolResult[] = [];
    try {
      results = this.data.result.map((item) => ({
        title: item.title,
        icon: PageIcon(),
        onClick: () => {
          this.peekViewService.peekView
            .open({
              type: "doc",
              docRef: { docId: item.docId },
            })
            .catch(console.error);
        },
      }));
    } catch (err) {
      console.error("Failed to parse result", err);
    }
    return html`<tool-result-card
      .reactToLit=${this.reactToLit}
      .name=${`Found ${this.data.result.length} pages for "${this.data.args.query}"`}
      .icon=${SearchIcon()}
      .width=${this.width}
      .results=${results}
    ></tool-result-card>`;
  }

  protected override render() {
    if (this.data.type === "tool-call") {
      return this.renderToolCall();
    }
    return this.renderToolResult();
  }
}
