import { createElement } from "react";
import {
  PageIcon as NativePageIcon,
  PenIcon as NativePenIcon,
} from "@myoxus/icons/react";
import {
  renderToolCallCard,
  renderToolFailedCard,
  renderToolResultCard,
} from "./tool-cards";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";

import type { ReactToLit } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/core/primitives/lit";
import { ShadowlessElement } from "@virgultum/core/runtime";
import { nothing } from "lit";
import { property } from "lit/decorators.js";

import type { DocDisplayConfig } from "../ai-chat-chips";
import type { ToolError } from "./type";

type DocWriteToolName = "doc_create" | "doc_update" | "doc_update_meta";

type DocWriteToolArgs = {
  doc_id?: string;
  title?: string;
  content?: string;
};

interface DocWriteToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: DocWriteToolName;
  args: DocWriteToolArgs;
}

interface DocWriteToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: DocWriteToolName;
  args: DocWriteToolArgs;
  result:
    | {
        success?: boolean;
        docId?: string;
        message?: string;
      }
    | ToolError
    | null;
}

const isToolError = (result: unknown): result is ToolError =>
  !!result &&
  typeof result === "object" &&
  "type" in result &&
  (result as ToolError).type === "error";

export class DocWriteTool extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  @property({ attribute: false })
  accessor data!: DocWriteToolCall | DocWriteToolResult;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  @property({ attribute: false })
  accessor docDisplayService!: DocDisplayConfig;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  private getDocId() {
    const { data } = this;
    if (
      data.type === "tool-result" &&
      data.result &&
      !isToolError(data.result)
    ) {
      const docId =
        typeof data.result.docId === "string" ? data.result.docId : undefined;
      if (docId) return docId;
    }
    const docId = data.args.doc_id;
    return typeof docId === "string" && docId.trim() ? docId : undefined;
  }

  private getDocTitle(docId?: string) {
    const { data } = this;
    if (data.toolName === "doc_create" || data.toolName === "doc_update_meta") {
      const title = data.args.title;
      if (title) return title;
    }
    if (docId && this.docDisplayService) {
      const title = this.docDisplayService.getTitle(docId);
      if (title) return title;
    }
    return undefined;
  }

  private getToolIcon() {
    return this.data.toolName === "doc_create"
      ? createElement(NativePageIcon)
      : createElement(NativePenIcon);
  }

  private getCallLabel(title?: string) {
    switch (this.data.toolName) {
      case "doc_create":
        return title ? `Creating "${title}"` : "Creating document";
      case "doc_update":
        return title ? `Updating "${title}"` : "Updating document";
      case "doc_update_meta":
        return title ? `Renaming to "${title}"` : "Updating document title";
      default:
        return "Updating document";
    }
  }

  private getResultLabel(title?: string) {
    switch (this.data.toolName) {
      case "doc_create":
        return title ? `Created "${title}"` : "Document created";
      case "doc_update":
        return title ? `Updated "${title}"` : "Document updated";
      case "doc_update_meta":
        return title ? `Renamed "${title}"` : "Document title updated";
      default:
        return "Document updated";
    }
  }

  private openDoc(docId?: string) {
    if (!docId) return;
    if (this.peekViewService) {
      this.peekViewService.peekView
        .open({ type: "doc", docRef: { docId } })
        .catch(console.error);
      return;
    }
    this.onOpenDoc?.(docId);
  }

  renderToolCall() {
    const docId = this.getDocId();
    const title = this.getDocTitle(docId);
    return renderToolCallCard(this.reactToLit, {
      name: this.getCallLabel(title),
      icon: this.getToolIcon(),
    });
  }

  renderToolResult() {
    if (this.data.type !== "tool-result") {
      return nothing;
    }

    const result = this.data.result;
    if (!result || isToolError(result)) {
      const name = isToolError(result) ? result.name : "Document action failed";
      return renderToolFailedCard(this.reactToLit, {
        name: name,
        icon: this.getToolIcon(),
      });
    }

    const docId = this.getDocId();
    const title = this.getDocTitle(docId) ?? "Document";
    const parts: string[] = [];
    if (result.message) parts.push(result.message);
    if (docId) parts.push(`Doc ID: ${docId}`);
    const content = parts.length ? parts.join("\n") : undefined;

    return renderToolResultCard(this.reactToLit, {
      name: this.getResultLabel(title),
      icon: this.getToolIcon(),
      results: [
        {
          title,
          icon: createElement(NativePageIcon),
          content,
          onClick: () => this.openDoc(docId),
        },
      ],
    });
  }

  protected override render() {
    if (this.data.type === "tool-call") {
      return this.renderToolCall();
    }
    if (this.data.type === "tool-result") {
      return this.renderToolResult();
    }
    return nothing;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "doc-write-tool": DocWriteTool;
  }
}
