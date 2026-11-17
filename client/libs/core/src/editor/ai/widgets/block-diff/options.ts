import { createElement } from "react";
import type { EditorHost } from "@virgultum/editor/std";
import { AIWidgetUI } from "../native-ui";
import { DiffOptions } from "./view";
import track from "@myoxus/track";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { LitElement } from "lit";
import { property } from "lit/decorators.js";

import type { PatchOp } from "../../utils/apply-model/markdown-diff";

export class BlockDiffOptions extends WithDisposable(LitElement) {
  override createRenderRoot() {
    return this;
  }
  override connectedCallback() {
    super.connectedCallback();
    // The diff renderer owns the anchor outside the document text bounds.
    Object.assign(this.style, {
      position: "absolute",
      right:
        "calc((var(--mantine-spacing-lg) + var(--mantine-spacing-xs)) * -1)",
      top: "0",
      pointerEvents: "auto",
    });
  }

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor onAccept!: (op: PatchOp) => void;

  @property({ attribute: false })
  accessor op!: PatchOp;

  @property({ attribute: false })
  accessor onReject!: (op: PatchOp) => void;

  private readonly _handleAcceptClick = () => {
    track.applyModel.widget.block.accept();
    this.onAccept(this.op);
  };

  private readonly _handleRejectClick = () => {
    track.applyModel.widget.block.reject();
    this.onReject(this.op);
  };

  override render() {
    return this.host.std.get(AIWidgetUI)(
      createElement(DiffOptions, {
        accept: this._handleAcceptClick,
        reject: this._handleRejectClick,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-block-diff-options": BlockDiffOptions;
  }
}
