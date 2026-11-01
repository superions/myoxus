import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { getMyoxusWorkspaceSchema } from "@myoxus/core/modules/workspace";
import { CopyIcon, PageIcon, ToolIcon } from "@myoxus/icons/lit";
import { getEmbedLinkedDocIcons } from "@virgultum/editor/blocks/embed-doc";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import type { ColorScheme } from "@virgultum/editor/model";
import { fontSMStyle, fontWebStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { MarkdownTransformer } from "@virgultum/editor/widgets/linked-doc";
import {
  DocEmbedProvider,
  type NotificationService,
} from "@virgultum/shared/services";
import type { BlockStdScope } from "@virgultum/std";
import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { getCustomPageEditorBlockSpecs } from "../page-editor-block-specs";
import { ArtifactTool } from "./artifact-tool";
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
  static override styles = css`
    .doc-compose-result-preview {
      padding: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
    }

    .doc-compose-result-preview-title {
      padding: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))",
        )}
        0
        calc(
          ${unsafeCSSValue(
              "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
            )} -
            ${unsafeCSSValue("var(--mantine-spacing-2xs)")}
        )
        0;
    }

    ${fontWebStyle(".doc-compose-result-preview-title", "section-title")}

    .doc-compose-result-save-as-doc {
      background: transparent;
      border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("black10")};
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))",
      )};
    }

    ${fontSMStyle(".doc-compose-result-save-as-doc")}

    .doc-compose-result-save-as-doc svg {
      width: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
      color: ${unsafeCSSVar("iconColor")};
    }

    .doc-compose-result-preview-loading {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }

    .doc-compose-result-save-as-doc:hover {
      background: ${unsafeCSSVar("hoverColor")};
    }
  `;

  @property({ attribute: false })
  accessor std: BlockStdScope | undefined;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  protected getBanner(theme: ColorScheme) {
    const { LinkedDocEmptyBanner } = getEmbedLinkedDocIcons(
      theme,
      "page",
      "horizontal",
    );
    return LinkedDocEmptyBanner;
  }

  protected getCardMeta() {
    return {
      title: this.data.args.title,
      className: "doc-compose-result",
    };
  }

  protected override getIcon() {
    return PageIcon();
  }

  protected override getPreviewContent() {
    if (!this.std) return html``;
    const resultData = this.data;
    const title = this.data.args.title;
    const result = resultData.type === "tool-result" ? resultData.result : null;
    const successResult = result && "markdown" in result ? result : null;

    return html`<div class="doc-compose-result-preview">
      <div class="doc-compose-result-preview-title">${title}</div>
      ${
        successResult
          ? html`<text-renderer
              .answer=${successResult.markdown}
              .schema=${this.std?.store.schema}
              .options=${{
                customHeading: true,
                extensions: getCustomPageEditorBlockSpecs(),
                theme: this.theme,
              }}
            ></text-renderer>`
          : html``
      }
    </div>`;
  }

  protected override getPreviewControls() {
    if (!this.std) return;
    const std = this.std;
    const resultData = this.data;
    const title = this.data.args.title;
    const result = resultData.type === "tool-result" ? resultData.result : null;
    const successResult = result && "markdown" in result ? result : null;

    const copyMarkdown = async () => {
      if (!successResult) {
        return;
      }
      await navigator.clipboard
        .writeText(successResult.markdown)
        .catch(console.error);
      this.notificationService.toast("Copied markdown to clipboard");
    };

    const saveAsDoc = async () => {
      try {
        if (!successResult) {
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
        if (docId) {
          const open = await this.notificationService.confirm({
            title: "Open the doc you just created",
            message: "Doc saved successfully! Would you like to open it now?",
            cancelText: "Cancel",
            confirmText: "Open",
          });
          if (open) {
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

    return this.data.type === "tool-call"
      ? undefined
      : html`
          <button class="doc-compose-result-save-as-doc" @click=${saveAsDoc}>
            ${PageIcon({
              width:
                "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
              height:
                "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
            })}
            Save as doc
          </button>
          <icon-button @click=${copyMarkdown} title="Copy markdown">
            ${CopyIcon({
              width:
                "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
              height:
                "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
            })}
          </icon-button>
        `;
  }

  protected override getErrorTemplate() {
    if (
      this.data.type === "tool-result" &&
      this.data.result &&
      "type" in this.data.result &&
      (this.data.result as any).type === "error"
    ) {
      return html`<tool-call-failed
        .reactToLit=${this.reactToLit}
        .name=${"Doc compose failed"}
        .icon=${ToolIcon()}
      ></tool-call-failed>`;
    }
    return null;
  }
}
