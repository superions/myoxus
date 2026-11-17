import { createElement } from "react";
import {
  PenIcon as NativeEditIcon,
  CopyIcon as NativeCopyIcon,
  ExpandCloseIcon as NativeExpandCloseIcon,
  ExpandFullIcon as NativeExpandFullIcon,
} from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import { Group, IconButton } from "@myoxus/ui-facade";
import { renderToolCallCard, renderToolFailedCard } from "./tool-cards";
import track from "@myoxus/track";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import type { NotificationService } from "@virgultum/core/services";
import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

import { AIProvider } from "../../provider";
import { BlockDiffProvider } from "../../services/block-diff";
import { diffMarkdown } from "../../utils/apply-model/markdown-diff";
import { copyText } from "../../utils/editor-actions";
import type { ToolError } from "./type";
import { DocEditResultView } from "./doc-edit-result-view";

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

// Stable React identity keeps mounted action focus while the existing locale provider updates labels.
function DocEditResultActions({
  collapsed,
  toggleCollapse,
  copy,
}: {
  collapsed: boolean;
  toggleCollapse: () => void;
  copy: () => void;
}) {
  const t = useI18n();
  const collapseLabel = collapsed ? t.Expand() : t.Collapse();
  return createElement(
    Group,
    null,
    createElement(IconButton, {
      icon: createElement(
        collapsed ? NativeExpandFullIcon : NativeExpandCloseIcon,
      ),
      tooltip: collapseLabel,
      "aria-label": collapseLabel,
      onClick: toggleCollapse,
    }),
    createElement(IconButton, {
      icon: createElement(NativeCopyIcon),
      tooltip: t.Copy(),
      "aria-label": t.Copy(),
      onClick: copy,
    }),
  );
}

function removeMarkdownComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "");
}

export class DocEditTool extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  static override styles = css`
    /* Technical diff content keeps its existing rendering and semantic colors. */
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
    return renderToolCallCard(this.reactToLit, {
      name: "Editing the document",
      icon: createElement(NativeEditIcon),
    });
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
          // Keep the existing operation-keyed producer and portal through updates.
          return (
            this.reactToLit?.(
              createElement(
                DocEditResultView,
                {
                  docId,
                  operation: op,
                  collapsed: this.isCollapsed,
                  applying: !!this.applyingMap[op],
                  accepting: !!this.acceptingMap[op],
                  actions: createElement(DocEditResultActions, {
                    collapsed: this.isCollapsed,
                    toggleCollapse: () => this._toggleCollapse(),
                    copy: () => this._handleCopy(changedContent),
                  }),
                  apply: () => this._handleApply(op, updates),
                  reject: () => this._handleReject(op),
                  accept: () => this._handleAccept(op, updates),
                },
                toReactNode(this.renderBlockDiffs(diffs)),
              ),
              true,
            ) ?? html`${op}: ${docId}${this.renderBlockDiffs(diffs)}`
          );
        },
      );
    }

    return renderToolFailedCard(this.reactToLit, {
      name: "Document editing failed",
      icon: createElement(NativeEditIcon),
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
