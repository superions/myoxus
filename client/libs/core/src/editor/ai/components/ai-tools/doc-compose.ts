import { createElement } from "react";
import { PageIcon, ToolIcon as NativeToolIcon } from "@myoxus/icons/react";
import { renderToolFailedCard } from "./tool-cards";
import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { getMyoxusWorkspaceSchema } from "@myoxus/core/modules/workspace";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import { MarkdownTransformer } from "@virgultum/editor/widgets/linked-doc";
import {
  DocEmbedProvider,
  type NotificationService,
} from "@virgultum/core/services";
import { html } from "lit";
import { property } from "lit/decorators.js";

import { getCustomPageEditorBlockSpecs } from "../page-editor-block-specs";
import { ArtifactTool } from "./artifact-tool";
import { DocComposeControls } from "./artifact-view";
import type { ToolError } from "./type";

interface DocComposeToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string; // 'doc_compose'
  args: { title: string };
}

interface DocComposeToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string; // 'doc_compose'
  args: { title: string };
  result:
    | {
        title: string;
        markdown: string;
        wordCount: number;
      }
    | ToolError
    | null;
}

/**
 * Component to render doc compose tool call/result inside chat.
 */
export class DocComposeTool extends ArtifactTool<
  DocComposeToolCall | DocComposeToolResult
> {
  @property({ attribute: false }) accessor readOnly = false;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  protected getCardMeta() {
    return {
      title: this.data.args.title,
    };
  }

  protected override getIcon() {
    return createElement(PageIcon);
  }

  protected override getPreviewContent() {
    if (!this.std) return html``;
    const resultData = this.data;
    const result = resultData.type === "tool-result" ? resultData.result : null;
    const successResult = result && "markdown" in result ? result : null;

    return successResult
      ? html`<text-renderer
          .answer=${successResult.markdown}
          .schema=${this.std.store.schema}
          .options=${{
            customHeading: true,
            extensions: getCustomPageEditorBlockSpecs(),
            theme: this.theme,
          }}
        ></text-renderer>`
      : html``;
  }

  protected override getPreviewControls() {
    if (!this.std) return;
    const std = this.std;
    const resultData = this.data;
    const title = this.data.args.title;
    const result = resultData.type === "tool-result" ? resultData.result : null;
    const successResult = result && "markdown" in result ? result : null;

    const copyMarkdown = async () => {
      if (!this.isConnected || !successResult) {
        return;
      }
      try {
        await navigator.clipboard.writeText(successResult.markdown);
        this.notificationService.toast("Copied markdown to clipboard");
      } catch (error) {
        console.error(error);
      }
    };

    const saveAsDoc = async () => {
      try {
        if (!this.isConnected || !successResult || this.readOnly) {
          return;
        }
        const workspace = std.store.workspace;
        const refNodeSlots = std.getOptional(RefNodeSlotsProvider);
        const { docId } = await MarkdownTransformer.importMarkdownToDoc({
          collection: workspace,
          schema: getMyoxusWorkspaceSchema(),
          markdown: successResult.markdown,
          fileName: title,
          extensions: getStoreManager().config.init().value.get("store"),
          access: std.getOptional(DocEmbedProvider) ?? undefined,
        });
        if (!this.isConnected) return;
        if (docId) {
          const open = await this.notificationService.confirm({
            title: "Open the doc you just created",
            message: "Doc saved successfully! Would you like to open it now?",
            cancelText: "Cancel",
            confirmText: "Open",
          });
          if (open && this.isConnected && this.std === std) {
            refNodeSlots?.docLinkClicked.next({
              pageId: docId,
              openMode: "open-in-active-view",
              host: std.host,
            });
          }
        } else {
          this.notificationService.toast("Failed to create document");
        }
      } catch (e) {
        console.error(e);
        this.notificationService.toast("Failed to create document");
      }
    };

    return successResult
      ? createElement(DocComposeControls, {
          copy: () => void copyMarkdown(),
          save: this.readOnly ? undefined : () => void saveAsDoc(),
        })
      : undefined;
  }

  protected override getErrorTemplate() {
    if (
      this.data.type === "tool-result" &&
      this.data.result &&
      "type" in this.data.result &&
      this.data.result.type === "error"
    ) {
      return renderToolFailedCard(this.reactToLit, {
        name: "Doc compose failed",
        icon: createElement(NativeToolIcon),
      });
    }
    return null;
  }
}
