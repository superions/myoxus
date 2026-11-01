import {
  CloseIcon,
  CopyIcon,
  DoneIcon,
  ExpandCloseIcon,
  ExpandFullIcon,
  PenIcon as EditIcon,
  PenIcon,
} from "@myoxus/icons/lit";
import track from "@myoxus/track";
import type { ReactToLit } from "@myoxus/lit-react";
import { LoadingIcon } from "@virgultum/components/icons";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontSMStyle, fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import type { NotificationService } from "@virgultum/shared/services";
import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

import { AIProvider } from "../../provider";
import { BlockDiffProvider } from "../../services/block-diff";
import { diffMarkdown } from "../../utils/apply-model/markdown-diff";
import { copyText } from "../../utils/editor-actions";
import type { ToolError } from "./type";

interface DocEditToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: "doc_edit";
}

interface DocEditToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: "doc_edit";
  args: {
    instructions: string;
    code_edit: string;
    doc_id: string;
  };
  result:
    | {
        result: {
          op: string;
          updates: string;
          originalContent: string;
          changedContent: string;
        }[];
      }
    | ToolError
    | null;
}

function removeMarkdownComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "");
}

export class DocEditTool extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  static override styles = css`
    :host {
      display: block;
    }

    .doc-edit-tool-result-wrapper {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")};

      svg {
        width: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )};
        height: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )};
      }
    }

    .doc-edit-tool-result-title {
      color: ${unsafeCSSVar("textPrimaryColor")};
      padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      margin-bottom: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    }

    ${fontSMStyle(".doc-edit-tool-result-title")}

    .doc-edit-tool-result-card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      background: ${unsafeCSSVar("backgroundPrimaryColor")};
      box-shadow: ${unsafeCSSValue("var(--mantine-shadow-sm)")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
      width: 100%;

      .doc-edit-tool-result-card-header {
        display: flex;
        flex-direction: row;
        align-items: center;
        padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")};

        width: 100%;
        justify-content: space-between;

        .doc-edit-tool-result-card-header-title {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
          color: ${unsafeCSSVar("textPrimaryColor")};
          text-overflow: ellipsis;
          overflow: hidden;
          white-space: nowrap;
        }

        ${fontSMStyle(".doc-edit-tool-result-card-header-title")}

        .doc-edit-tool-result-card-header-title svg {
          color: ${unsafeCSSVar("primaryColor")};
        }

        .doc-edit-tool-result-card-header-operations {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
          cursor: pointer;
          padding-right: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
          color: ${unsafeCSSVar("textSecondaryColor")};

          button {
            cursor: pointer;
            padding: ${unsafeCSSValue("var(--mantine-spacing-2xs)")};
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
            gap: ${unsafeCSSValue("var(--mantine-spacing-2xs)")};
          }

          ${fontXSStyle(".doc-edit-tool-result-card-header-operations button")}

          button:hover {
            background: ${unsafeCSSVar("hoverColor")};
          }

          button:disabled {
            cursor: default;
            opacity: 0.6;
            pointer-events: none;
          }
        }
      }

      .doc-edit-tool-result-card-content {
        padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
        width: 100%;
        border-top: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
          ${unsafeCSSVar("borderColor")};
      }

      .doc-edit-tool-result-card-footer {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
        width: 100%;
        cursor: pointer;

        button {
          display: flex;
          align-items: center;
          gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
          padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
          border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
        }

        ${fontXSStyle(".doc-edit-tool-result-card-footer button")}

        button:hover {
          background: ${unsafeCSSVar("hoverColor")};
        }

        button:disabled {
          cursor: default;
          opacity: 0.6;
          pointer-events: none;
        }

        .doc-edit-tool-result-reject svg {
          color: ${unsafeCSSVar("iconSecondary")};
        }

        .doc-edit-tool-result-accept svg {
          color: ${unsafeCSSVar("primaryColor")};
        }
      }

      &.collapsed .doc-edit-tool-result-card-content,
      &.collapsed .doc-edit-tool-result-card-footer {
        display: none;
      }

      .doc-edit-tool-result-card-diff {
        border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
        padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
        width: 100%;
      }

      .doc-edit-tool-result-card-diff-replace {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        margin-bottom: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
        gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};

        .doc-edit-tool-result-card-diff.original {
          background: ${unsafeCSSVar("backgroundErrorColor")};
        }

        .doc-edit-tool-result-card-diff.modified {
          background: ${unsafeCSSVar("backgroundProcessingColor")};
        }
      }

      .doc-edit-tool-result-card-diff.deleted {
        background: ${unsafeCSSVar("backgroundErrorColor")};
        margin-bottom: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      }

      .doc-edit-tool-result-card-diff.insert {
        background: ${unsafeCSSVar("backgroundProcessingColor")};
        margin-bottom: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      }

      ${fontXSStyle(".doc-edit-tool-result-card-diff-title")}
    }
  `;

  @property({ attribute: false })
  accessor host!: EditorHost | null;

  @property({ attribute: false })
  accessor data!: DocEditToolCall | DocEditToolResult;

  @property({ attribute: false })
  accessor renderRichText!: (text: string) => string;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @state()
  accessor isCollapsed = false;

  @state()
  accessor applyingMap: Record<string, boolean> = {};

  @state()
  accessor acceptingMap: Record<string, boolean> = {};

  get blockDiffService() {
    return this.host?.std.getOptional(BlockDiffProvider);
  }

  get isBusy() {
    return undefined;
  }

  isBusyForOp(op: string) {
    return this.applyingMap[op] || this.acceptingMap[op];
  }

  private async _handleApply(op: string, updates: string) {
    if (
      !this.host ||
      this.data.type !== "tool-result" ||
      this.isBusyForOp(op)
    ) {
      return;
    }
    this.applyingMap = { ...this.applyingMap, [op]: true };
    try {
      const markdown = await AIProvider.context?.applyDocUpdates(
        this.host.std.workspace.id,
        this.data.args.doc_id,
        op,
        updates,
      );
      if (!markdown) {
        return;
      }
      track.applyModel.chat.$.apply({
        instruction: this.data.args.instructions,
        operation: op,
      });
      await this.blockDiffService?.apply(this.host.store, markdown);
    } catch (error) {
      this.notificationService.notify({
        title: "Failed to apply updates",
        message: error instanceof Error ? error.message : "Unknown error",
        accent: "error",
        onClose: function (): void {},
      });
    } finally {
      this.applyingMap = { ...this.applyingMap, [op]: false };
    }
  }

  private async _handleReject(op: string) {
    if (!this.host || this.data.type !== "tool-result") {
      return;
    }
    // TODO: set the rejected status
    track.applyModel.chat.$.reject({
      instruction: this.data.args.instructions,
      operation: op,
    });
    this.blockDiffService?.setChangedMarkdown(null);
    this.blockDiffService?.rejectAll();
  }

  private async _handleAccept(op: string, updates: string) {
    if (
      !this.host ||
      this.data.type !== "tool-result" ||
      this.isBusyForOp(op)
    ) {
      return;
    }
    this.acceptingMap = { ...this.acceptingMap, [op]: true };
    try {
      const changedMarkdown = await AIProvider.context?.applyDocUpdates(
        this.host.std.workspace.id,
        this.data.args.doc_id,
        op,
        updates,
      );
      if (!changedMarkdown) {
        return;
      }
      track.applyModel.chat.$.accept({
        instruction: this.data.args.instructions,
        operation: op,
      });
      await this.blockDiffService?.apply(this.host.store, changedMarkdown);
      await this.blockDiffService?.acceptAll(this.host.store);
    } catch (error) {
      this.notificationService.notify({
        title: "Failed to apply updates",
        message: error instanceof Error ? error.message : "Unknown error",
        accent: "error",
        onClose: function (): void {},
      });
    } finally {
      this.acceptingMap = { ...this.acceptingMap, [op]: false };
    }
  }

  private async _toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
  }

  private async _handleCopy(changedMarkdown: string) {
    if (!this.host) {
      return;
    }
    track.applyModel.chat.$.copy();
    const success = await copyText(removeMarkdownComments(changedMarkdown));
    if (success) {
      this.notificationService.notify({
        title: "Copied to clipboard",
        accent: "success",
        onClose: function (): void {},
      });
    }
  }

  renderToolCall() {
    return html`
      <tool-call-card
        .reactToLit=${this.reactToLit}
        .name=${"Editing the document"}
        .icon=${EditIcon()}
      ></tool-call-card>
    `;
  }

  renderSantizedText(text: string) {
    return this.renderRichText(removeMarkdownComments(text));
  }

  renderBlockDiffs(diffs: ReturnType<typeof diffMarkdown>) {
    const { patches, oldBlocks } = diffs;

    const oldBlockMap = new Map(oldBlocks.map((b) => [b.id, b]));

    return html`
      <div>
        ${patches.map((patch) => {
          if (patch.op === "replace") {
            const oldBlock = oldBlockMap.get(patch.id);
            return html`
              <div class="doc-edit-tool-result-card-diff-replace">
                <div class="doc-edit-tool-result-card-diff original">
                  <div class="doc-edit-tool-result-card-diff-title">
                    Original
                  </div>
                  <div>${this.renderSantizedText(oldBlock?.content ?? "")}</div>
                </div>
                <div class="doc-edit-tool-result-card-diff modified">
                  <div class="doc-edit-tool-result-card-diff-title">
                    Modified
                  </div>
                  <div>${this.renderSantizedText(patch.content)}</div>
                </div>
              </div>
            `;
          } else if (patch.op === "delete") {
            const oldBlock = oldBlockMap.get(patch.id);
            return html`
              <div class="doc-edit-tool-result-card-diff deleted">
                <div class="doc-edit-tool-result-card-diff-title">Deleted</div>
                <div>${this.renderSantizedText(oldBlock?.content ?? "")}</div>
              </div>
            `;
          } else if (patch.op === "insert") {
            return html`
              <div class="doc-edit-tool-result-card-diff insert">
                <div class="doc-edit-tool-result-card-diff-title">Inserted</div>
                <div>${this.renderSantizedText(patch.block.content)}</div>
              </div>
            `;
          }
          return nothing;
        })}
      </div>
    `;
  }

  renderToolResult() {
    if (this.data.type !== "tool-result") {
      return nothing;
    }

    const result = this.data.result;

    if (result && "result" in result && Array.isArray(result.result)) {
      const { doc_id: docId } = this.data.args;

      return repeat(
        result.result,
        (change) => change.op,
        ({ op, updates, originalContent, changedContent }) => {
          const diffs = diffMarkdown(originalContent, changedContent);
          return html`
            <div class="doc-edit-tool-result-wrapper">
              <div class="doc-edit-tool-result-title">${op}</div>
              <div
                class="doc-edit-tool-result-card ${
                  this.isCollapsed ? "collapsed" : ""
                }"
              >
                <div class="doc-edit-tool-result-card-header">
                  <div class="doc-edit-tool-result-card-header-title">
                    ${PenIcon()} ${docId}
                  </div>
                  <div class="doc-edit-tool-result-card-header-operations">
                    <button @click=${() => this._toggleCollapse()}>
                      ${this.isCollapsed ? ExpandFullIcon() : ExpandCloseIcon()}
                      <myoxus-tooltip>
                        ${this.isCollapsed ? "Expand" : "Collapse"}
                      </myoxus-tooltip>
                    </button>
                    <button @click=${() => this._handleCopy(changedContent)}>
                      ${CopyIcon()}
                      <myoxus-tooltip>Copy</myoxus-tooltip>
                    </button>
                    <button
                      @click=${() => this._handleApply(op, updates)}
                      ?disabled=${this.isBusyForOp(op)}
                    >
                      ${
                        this.applyingMap[op]
                          ? html`${LoadingIcon()} Applying`
                          : "Apply"
                      }
                    </button>
                  </div>
                </div>
                <div class="doc-edit-tool-result-card-content">
                  ${this.renderBlockDiffs(diffs)}
                  <div class="doc-edit-tool-result-card-footer">
                    <button
                      class="doc-edit-tool-result-reject"
                      @click=${() => this._handleReject(op)}
                    >
                      ${CloseIcon()} Reject
                    </button>
                    <button
                      class="doc-edit-tool-result-accept"
                      @click=${() => this._handleAccept(op, updates)}
                      ?disabled=${this.isBusyForOp(op)}
                    >
                      ${
                        this.acceptingMap[op]
                          ? html`${LoadingIcon()}`
                          : DoneIcon()
                      }
                      ${this.acceptingMap[op] ? "Accepting..." : "Accept"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          `;
        },
      );
    }

    return html`
      <tool-call-failed
        .reactToLit=${this.reactToLit}
        .name=${"Document editing failed"}
        .icon=${EditIcon()}
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
