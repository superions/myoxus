import { renderNativeMcpTool } from "../ai-tools/native-mcp-tools";
import {
  renderToolCallCard,
  renderToolResultCard,
} from "../ai-tools/tool-cards";
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
import type { NotificationService } from "@virgultum/core/services";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { createElement, type ReactNode } from "react";
import { Stack } from "@myoxus/ui-facade";
import { ReasoningSection } from "./reasoning";

import { mergeStreamObjects } from "../../utils/stream-objects";
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

  // Call and result share one template per logical call. Replacing the element
  // would lose explicit-close/selection state and dispose its active renderer.
  private renderArtifact(
    streamObject: Extract<StreamObject, { type: "tool-call" | "tool-result" }>,
  ) {
    switch (streamObject.toolName) {
      case "doc_compose":
        return keyed(
          streamObject.toolCallId,
          html`<doc-compose-tool
            .reactToLit=${this.reactToLit}
            .independentMode=${this.independentMode}
            .std=${this.std || this.host?.std}
            .data=${streamObject}
            .width=${this.width}
            .theme=${this.theme}
            .notificationService=${this.notificationService}
          ></doc-compose-tool>`,
        );
      case "code_artifact":
        return keyed(
          streamObject.toolCallId,
          html`<code-artifact-tool
            .reactToLit=${this.reactToLit}
            .independentMode=${this.independentMode}
            .std=${this.std || this.host?.std}
            .data=${streamObject}
            .width=${this.width}
            .theme=${this.theme}
            .notificationService=${this.notificationService}
          ></code-artifact-tool>`,
        );
      default:
        return nothing;
    }
  }

  private renderToolCall(streamObject: StreamObject) {
    if (streamObject.type !== "tool-call") {
      return nothing;
    }

    switch (streamObject.toolName) {
      case "read_doc":
      case "search_docs":
      case "workspace_get":
        return renderNativeMcpTool(this.reactToLit, streamObject, {
          generating: this.state === "generating",
          contained: !this.independentMode,
          getDocumentTitle: (id) => this.docDisplayService?.getTitle(id),
          openDocument: this.peekViewService
            ? (docId) => {
                this.peekViewService.peekView
                  .open({ type: "doc", docRef: { docId } })
                  .catch(console.error);
              }
            : undefined,
        });
      case "web_crawl_exa":
        return html`
          <web-crawl-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
          ></web-crawl-tool>
        `;
      case "web_search_exa":
        return html`
          <web-search-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
          ></web-search-tool>
        `;
      case "doc_compose":
      case "code_artifact":
        return this.renderArtifact(streamObject);
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
          .peekViewService=${this.peekViewService}
        ></doc-semantic-search-result>`;
      case "doc_keyword_search":
        return html`<doc-keyword-search-result
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
        ></doc-keyword-search-result>`;
      case "doc_read":
        return html`<doc-read-result
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
        ></doc-read-result>`;
      case "doc_create":
      case "doc_update":
      case "doc_update_meta":
        return html`<doc-write-tool
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
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
        return renderToolCallCard(this.reactToLit, { name: name });
      }
    }
  }

  private renderToolResult(streamObject: StreamObject) {
    if (streamObject.type !== "tool-result") {
      return nothing;
    }

    switch (streamObject.toolName) {
      case "read_doc":
      case "search_docs":
      case "workspace_get":
        return renderNativeMcpTool(this.reactToLit, streamObject, {
          generating: this.state === "generating",
          contained: !this.independentMode,
          getDocumentTitle: (id) => this.docDisplayService?.getTitle(id),
          openDocument: this.peekViewService
            ? (docId) => {
                this.peekViewService.peekView
                  .open({ type: "doc", docRef: { docId } })
                  .catch(console.error);
              }
            : undefined,
        });
      case "web_crawl_exa":
        return html`
          <web-crawl-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
          ></web-crawl-tool>
        `;
      case "web_search_exa":
        return html`
          <web-search-tool
            .reactToLit=${this.reactToLit}
            .data=${streamObject}
          ></web-search-tool>
        `;
      case "doc_compose":
      case "code_artifact":
        return this.renderArtifact(streamObject);
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
          .docDisplayService=${this.docDisplayService}
          .peekViewService=${this.peekViewService}
          .onOpenDoc=${this.onOpenDoc}
        ></doc-semantic-search-result>`;
      case "doc_keyword_search":
        return html`<doc-keyword-search-result
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
          .peekViewService=${this.peekViewService}
          .onOpenDoc=${this.onOpenDoc}
        ></doc-keyword-search-result>`;
      case "doc_read":
        return html`<doc-read-result
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
          .peekViewService=${this.peekViewService}
          .onOpenDoc=${this.onOpenDoc}
        ></doc-read-result>`;
      case "doc_create":
      case "doc_update":
      case "doc_update_meta":
        return html`<doc-write-tool
          .reactToLit=${this.reactToLit}
          .data=${streamObject}
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
        return renderToolResultCard(this.reactToLit, { name: name });
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
    // Persisted history keeps both events; the same call/result merge owns live and replay presentation.
    const answer = mergeStreamObjects(this.answer);
    const content = html`
      ${answer.map((data, index) => {
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
                      followedByContent: index < answer.length - 1,
                      generating:
                        this.state === "generating" && data === answer.at(-1),
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
    `;
    return this.reactToLit
      ? this.reactToLit(
          createElement(Stack, { gap: "xs" }, toReactNode(content)),
          true,
        )
      : content;
  }
}
