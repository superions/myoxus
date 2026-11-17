import { createElement } from "react";
import {
  PageIcon as NativePageIcon,
  AiEmbeddingIcon as NativeAiEmbeddingIcon,
} from "@myoxus/icons/react";
import { renderToolCallCard, renderToolResultCard } from "./tool-cards";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";

import type { ReactToLit } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/core/primitives/lit";
import { ShadowlessElement } from "@virgultum/core/runtime";
import { nothing } from "lit";
import { property } from "lit/decorators.js";

import type { DocDisplayConfig } from "../ai-chat-chips";

interface DocSemanticSearchToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: { query: string };
}

interface DocSemanticSearchToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  args: { query: string };
  result: Array<{
    content: string;
    docId: string;
  }>;
}

function parseResultContent(content: string) {
  const properties = [
    "Title",
    "Created at",
    "Updated at",
    "Created by",
    "Updated by",
  ];
  try {
    // A row starts with "Title: ${title}\n"
    const title = content.match(/^Title:\s+(.*)\n/)?.[1];
    // from first row that not starts with "${propertyName}:" to end of the content
    const rows = content.split("\n");
    const startIndex = rows.findIndex(
      (line) => !properties.some((property) => line.startsWith(`${property}:`)),
    );
    const text = rows.slice(startIndex).join("\n");
    return {
      title,
      content: text,
      icon: createElement(NativePageIcon),
    };
  } catch (error) {
    console.error("Failed to parse result content", error);
    return null;
  }
}

export class DocSemanticSearchResult extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  @property({ attribute: false })
  accessor data!: DocSemanticSearchToolCall | DocSemanticSearchToolResult;

  @property({ attribute: false })
  accessor docDisplayService!: DocDisplayConfig;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  renderToolCall() {
    return renderToolCallCard(this.reactToLit, {
      name: `Finding semantically related pages for "${this.data.args.query}"`,
      icon: createElement(NativeAiEmbeddingIcon),
    });
  }

  renderToolResult() {
    if (this.data.type !== "tool-result") {
      return nothing;
    }
    return renderToolResultCard(this.reactToLit, {
      name: `Found semantically related pages for "${this.data.args.query}"`,
      icon: createElement(NativeAiEmbeddingIcon),
      results: this.data.result
        .map((result) => ({
          ...parseResultContent(result.content),
          title: this.docDisplayService.getTitle(result.docId),
          onClick: () => {
            this.peekViewService.peekView
              .open({
                type: "doc",
                docRef: {
                  docId: result.docId,
                },
              })
              .catch(console.error);
          },
        }))
        .filter(Boolean),
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

declare global {
  interface HTMLElementTagNameMap {
    "doc-semantic-search-result": DocSemanticSearchResult;
  }
}
