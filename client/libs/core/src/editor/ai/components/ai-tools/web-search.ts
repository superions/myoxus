import { createElement } from "react";
import { WebIcon as NativeWebIcon } from "@myoxus/icons/react";
import {
  renderToolCallCard,
  renderToolResultCard,
  renderToolFailedCard,
} from "./tool-cards";

import type { ReactToLit } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { nothing } from "lit";
import { property } from "lit/decorators.js";

import type { ToolError } from "./type";

interface WebSearchToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: { query: string };
}

interface WebSearchToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  args: { query: string };
  result:
    | Array<{
        title: string;
        url: string;
        content: string;
        favicon: string;
        publishedDate: string;
        author: string;
      }>
    | ToolError
    | null;
}

export class WebSearchTool extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  @property({ attribute: false })
  accessor data!: WebSearchToolCall | WebSearchToolResult;

  renderToolCall() {
    return renderToolCallCard(this.reactToLit, {
      name: `Searching the web for "${this.data.args.query}"`,
      icon: createElement(NativeWebIcon),
    });
  }

  renderToolResult() {
    if (this.data.type !== "tool-result") {
      return nothing;
    }

    const result = this.data.result;
    if (result && Array.isArray(result)) {
      const results = result.map((item) => {
        const { favicon, title, content, url } = item;
        return {
          title: title,
          icon: favicon || createElement(NativeWebIcon),
          content: content,
          href: url,
        };
      });
      const footerIcons = result.map((item) => item.favicon).filter(Boolean);

      return renderToolResultCard(this.reactToLit, {
        name: "The search is complete, and these webpages have been searched",
        icon: createElement(NativeWebIcon),
        footerIcons: footerIcons,
        results: results,
      });
    }

    return renderToolFailedCard(this.reactToLit, {
      name: "Web search failed",
      icon: createElement(NativeWebIcon),
    });
  }

  protected override render() {
    const { data } = this;

    if (data.type === "tool-call") {
      return this.renderToolCall();
    }
    if (data.type === "tool-result") {
      return this.renderToolResult();
    }
    return nothing;
  }
}
