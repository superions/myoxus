import { createElement } from "react";
import {
  SearchIcon as NativeSearchIcon,
  PageIcon as NativePageIcon,
} from "@myoxus/icons/react";
import { renderToolCallCard, renderToolResultCard } from "./tool-cards";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";

import type { ReactToLit } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/core/primitives/lit";
import { ShadowlessElement } from "@virgultum/core/runtime";
import { nothing } from "lit";
import { property } from "lit/decorators.js";

import type { ToolResult } from "./tool-cards";

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
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  renderToolCall() {
    return renderToolCallCard(this.reactToLit, {
      name: `Searching workspace documents for "${this.data.args.query}"`,
      icon: createElement(NativeSearchIcon),
    });
  }

  renderToolResult() {
    if (this.data.type !== "tool-result") {
      return nothing;
    }
    let results: ToolResult[] = [];
    try {
      results = this.data.result.map((item) => ({
        title: item.title,
        icon: createElement(NativePageIcon),
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
    return renderToolResultCard(this.reactToLit, {
      name: `Found ${this.data.result.length} pages for "${this.data.args.query}"`,
      icon: createElement(NativeSearchIcon),
      results: results,
    });
  }

  protected override render() {
    if (this.data.type === "tool-call") {
      return this.renderToolCall();
    }
    return this.renderToolResult();
  }
}
