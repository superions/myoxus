import { WebIcon } from "@myoxus/icons/lit";
import type { ReactToLit } from "@myoxus/lit-react";
import type { Signal } from "@preact/signals-core";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";

import type { ToolError } from "./type";

interface WebCrawlToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: { url: string };
}

interface WebCrawlToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  args: { url: string };
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

export class WebCrawlTool extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  @property({ attribute: false })
  accessor data!: WebCrawlToolCall | WebCrawlToolResult;

  @property({ attribute: false })
  accessor width: Signal<number | undefined> | undefined;

  renderToolCall() {
    return html`
      <tool-call-card
        .reactToLit=${this.reactToLit}
        .name=${`Reading the website "${this.data.args.url}"`}
        .icon=${WebIcon()}
      ></tool-call-card>
    `;
  }

  renderToolResult() {
    if (this.data.type !== "tool-result") {
      return nothing;
    }

    const result = this.data.result;
    if (result && Array.isArray(result) && result.length > 0) {
      const { favicon, title, content } = result[0];
      return html`
        <tool-result-card
          .reactToLit=${this.reactToLit}
          .name=${"The reading is complete, and this webpage has been read"}
          .icon=${WebIcon()}
          .footerIcons=${favicon ? [favicon] : []}
          .results=${[
            {
              title: title,
              icon: favicon,
              content: content,
            },
          ]}
          .width=${this.width}
        ></tool-result-card>
      `;
    }

    return html`
      <tool-call-failed
        .reactToLit=${this.reactToLit}
        .name=${"Web reading failed"}
        .icon=${WebIcon()}
      ></tool-call-failed>
    `;
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
