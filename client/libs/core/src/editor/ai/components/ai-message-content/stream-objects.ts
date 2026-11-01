import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import type { Signal } from "@preact/signals-core";
import { WithDisposable } from "@virgultum/editor/global/lit";
import type { ColorScheme } from "@virgultum/editor/model";
import {
  type BlockStdScope,
  type EditorHost,
  ShadowlessElement,
} from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import type { NotificationService } from "@virgultum/shared/services";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { createElement, type ReactNode } from "react";
import { ReasoningSection } from "./reasoning";

import type { MyoxusAIPanelState } from "../../widgets/ai-panel/type";
import type { DocDisplayConfig } from "../ai-chat-chips";
import type { StreamObject } from "../ai-chat-messages";

export class ChatContentStreamObjects extends WithDisposable(
  ShadowlessElement,
) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;

  @property({ attribute: false }) accessor reasoningIdentity: ReactNode;

  @property({ attribute: false })
  accessor answer!: StreamObject[];

  @property({ attribute: false })
  accessor host: EditorHost | null | undefined;

  @property({ attribute: false })
  accessor std: BlockStdScope | null | undefined;

  @property({ attribute: false })
  accessor state: MyoxusAIPanelState = "finished";

  @property({ attribute: false })
  accessor width: Signal<number | undefined> | undefined;

  @property({ attribute: false })
  accessor extensions!: ExtensionType[];

  @property({ attribute: false })
  accessor myoxusFeatureFlagService!: FeatureFlagService;

  @property({ attribute: false })
  accessor theme!: Signal<ColorScheme>;

  @property({ attribute: false })
  accessor independentMode: boolean | undefined;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor docDisplayService!: DocDisplayConfig;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  private renderToolCall(streamObject: StreamObject) {
    if (streamObject.type !== "tool-call") {
      return nothing;
    }

    switch (streamObject.toolName) {
      case "web_crawl_exa":
        return html`
          <web-crawl-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
            .width=${this.width}
          ></web-crawl-tool>
        `;
      case "web_search_exa":
        return html`
          <web-search-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
            .width=${this.width}
          ></web-search-tool>
        `;
      case "doc_compose":
        return html`
          <doc-compose-tool
            .reactToLit=${this.reactToLit}
            .std=${this.std || this.host?.std}
            .data=${streamObject}
            .width=${this.width}
            .theme=${this.theme}
            .notificationService=${this.notificationService}
          ></doc-compose-tool>
        `;
      case "code_artifact":
        return html`
          <code-artifact-tool
            .reactToLit=${this.reactToLit}
            .std=${this.std || this.host?.std}
            .data=${streamObject}
            .width=${this.width}
            .theme=${this.theme}
          ></code-artifact-tool>
        `;
      case "doc_edit":
        return html`
          <doc-edit-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
            .doc=${this.host?.store}
            .notificationService=${this.notificationService}
          ></doc-edit-tool>
        `;
      case "doc_semantic_search":
        return html`<doc-semantic-search-result
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
          .width=${this.width}
          .peekViewService=${this.peekViewService}
        ></doc-semantic-search-result>`;
      case "doc_keyword_search":
        return html`<doc-keyword-search-result
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
          .width=${this.width}
        ></doc-keyword-search-result>`;
      case "doc_read":
        return html`<doc-read-result
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
          .width=${this.width}
        ></doc-read-result>`;
      case "doc_create":
      case "doc_update":
      case "doc_update_meta":
        return html`<doc-write-tool
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
          .width=${this.width}
          .peekViewService=${this.peekViewService}
          .docDisplayService=${this.docDisplayService}
          .onOpenDoc=${this.onOpenDoc}
        ></doc-write-tool>`;
      case "section_edit":
        return html`
          <section-edit-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
            .extensions=${this.extensions}
            .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
            .notificationService=${this.notificationService}
            .theme=${this.theme}
            .host=${this.host}
            .independentMode=${this.independentMode}
          ></section-edit-tool>
        `;
      default: {
        const name = streamObject.toolName + " tool calling";
        return html`
          <tool-call-card
            .reactToLit=${this.reactToLit}
            .name=${name}
          ></tool-call-card>
        `;
      }
    }
  }

  private renderToolResult(streamObject: StreamObject) {
    if (streamObject.type !== "tool-result") {
      return nothing;
    }

    switch (streamObject.toolName) {
      case "web_crawl_exa":
        return html`
          <web-crawl-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
            .width=${this.width}
          ></web-crawl-tool>
        `;
      case "web_search_exa":
        return html`
          <web-search-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
            .width=${this.width}
          ></web-search-tool>
        `;
      case "doc_compose":
        return html`
          <doc-compose-tool
            .reactToLit=${this.reactToLit}
            .std=${this.std || this.host?.std}
            .data=${streamObject}
            .width=${this.width}
            .theme=${this.theme}
            .notificationService=${this.notificationService}
          ></doc-compose-tool>
        `;
      case "code_artifact":
        return html`
          <code-artifact-tool
            .reactToLit=${this.reactToLit}
            .std=${this.std || this.host?.std}
            .data=${streamObject}
            .width=${this.width}
            .theme=${this.theme}
            .notificationService=${this.notificationService}
          ></code-artifact-tool>
        `;
      case "doc_edit":
        return html`
          <doc-edit-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
            .host=${this.host}
            .renderRichText=${this.renderRichText.bind(this)}
            .notificationService=${this.notificationService}
          ></doc-edit-tool>
        `;
      case "doc_semantic_search":
        return html`<doc-semantic-search-result
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
          .width=${this.width}
          .docDisplayService=${this.docDisplayService}
          .peekViewService=${this.peekViewService}
          .onOpenDoc=${this.onOpenDoc}
        ></doc-semantic-search-result>`;
      case "doc_keyword_search":
        return html`<doc-keyword-search-result
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
          .width=${this.width}
          .peekViewService=${this.peekViewService}
          .onOpenDoc=${this.onOpenDoc}
        ></doc-keyword-search-result>`;
      case "doc_read":
        return html`<doc-read-result
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
          .width=${this.width}
          .peekViewService=${this.peekViewService}
          .onOpenDoc=${this.onOpenDoc}
        ></doc-read-result>`;
      case "doc_create":
      case "doc_update":
      case "doc_update_meta":
        return html`<doc-write-tool
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
          .width=${this.width}
          .peekViewService=${this.peekViewService}
          .docDisplayService=${this.docDisplayService}
          .onOpenDoc=${this.onOpenDoc}
        ></doc-write-tool>`;
      case "section_edit":
        return html`
          <section-edit-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
            .extensions=${this.extensions}
            .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
            .notificationService=${this.notificationService}
            .theme=${this.theme}
            .host=${this.host}
            .independentMode=${this.independentMode}
          ></section-edit-tool>
        `;
      default: {
        const name = streamObject.toolName + " tool result";
        return html`
          <tool-result-card
            .reactToLit=${this.reactToLit}
            .name=${name}
            .width=${this.width}
          ></tool-result-card>
        `;
      }
    }
  }

  private renderRichText(text: string, annotation = false) {
    return html`<chat-content-rich-text
      .text=${text}
      .state=${this.state}
      .extensions=${this.extensions}
      .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
      .theme=${this.theme}
      .annotation=${annotation}
    ></chat-content-rich-text>`;
  }

  protected override render() {
    return html`<div>
      ${this.answer.map((data, index) => {
        switch (data.type) {
          case "text-delta":
            return this.renderRichText(data.textDelta);
          case "reasoning":
            // Static block previews have no portal owner and show final text
            // only. Their interactive peek supplies the existing host factory.
            return this.reactToLit
              ? this.reactToLit(
                  createElement(
                    ReasoningSection,
                    {
                      identity:
                        index === 0 ? this.reasoningIdentity : undefined,
                      followedByContent: index < this.answer.length - 1,
                      generating:
                        this.state === "generating" &&
                        data === this.answer.at(-1),
                    },
                    toReactNode(this.renderRichText(data.textDelta, true)),
                  ),
                  true,
                )
              : nothing;
          case "tool-call":
            return this.renderToolCall(data);
          case "tool-result":
            return this.renderToolResult(data);
          default:
            return nothing;
        }
      })}
    </div>`;
  }
}
