import { createElement } from "react";
import type { EditorHost } from "@virgultum/editor/std";
import { AIWidgetUI } from "../native-ui";
import { DiffPlaygroundButton, DiffPlaygroundForm } from "./view";
import { createLitPortal } from "@virgultum/core/view/portal";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { WidgetComponent, WidgetViewExtension } from "@virgultum/editor/std";
import type { Store } from "@virgultum/editor/store";
import { html, LitElement, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";

import { BlockDiffProvider } from "../../services/block-diff";

export const MYOXUS_BLOCK_DIFF_PLAYGROUND = "myoxus-block-diff-playground";
export const MYOXUS_BLOCK_DIFF_PLAYGROUND_MODAL =
  "myoxus-block-diff-playground-modal";

export class BlockDiffPlaygroundModal extends WithDisposable(LitElement) {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  accessor host!: EditorHost;

  @state()
  private accessor markdown = "";

  @property({ attribute: false })
  accessor diffService!: BlockDiffProvider;

  @property({ attribute: false })
  accessor store!: Store;

  @property({ attribute: false })
  accessor onClose!: () => void;

  private readonly handleClear = () => {
    this.markdown = "";
    this.diffService.setChangedMarkdown("");
  };

  private async getOriginalMarkdown() {
    const markdown = await this.diffService.getMarkdownFromDoc(this.store);
    return markdown;
  }

  private readonly handleConfirm = async () => {
    const originalMarkdown = await this.getOriginalMarkdown();
    this.diffService.setOriginalMarkdown(originalMarkdown);
    this.diffService.setChangedMarkdown(this.markdown);
    this.onClose();
  };

  private readonly handleInsertCurrentMarkdown = async () => {
    this.markdown = await this.getOriginalMarkdown();
  };

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "block";
    this.style.width =
      "min(100vw, calc((var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 20))";
  }
  override render() {
    return this.host.std.get(AIWidgetUI)(
      createElement(DiffPlaygroundForm, {
        markdown: this.markdown,
        input: (value: string) => {
          this.markdown = value;
        },
        load: this.handleInsertCurrentMarkdown,
        clear: this.handleClear,
        confirm: this.handleConfirm,
      }),
    );
  }
}

export class BlockDiffPlayground extends WidgetComponent {
  override createRenderRoot() {
    return this;
  }

  @query("button")
  accessor fab!: HTMLButtonElement;

  private _abortController: AbortController | null = null;

  private get diffService() {
    return this.std.get(BlockDiffProvider);
  }

  private readonly handleOpen = () => {
    this._abortController?.abort();
    this._abortController = new AbortController();

    createLitPortal({
      shadowDom: false,
      template: html`
        <myoxus-block-diff-playground-modal
          .host=${this.host}
          .diffService=${this.diffService}
          .store=${this.std.store}
          .onClose=${this.handleClose}
        ></myoxus-block-diff-playground-modal>
      `,
      container: this.host,
      computePosition: {
        referenceElement: this.fab,
        placement: "top-end",
      },
      closeOnClickAway: true,
      abortController: this._abortController,
    });
  };

  private readonly handleClose = () => {
    this._abortController?.abort();
  };

  override firstUpdated() {
    Object.assign(this.style, {
      position: "fixed",
      right: "var(--mantine-spacing-2xl)",
      bottom: "var(--mantine-spacing-2xl)",
      zIndex: "var(--myoxus-z-index-modal)",
    });
  }
  override render() {
    if (this.std.store.readonly) return nothing;
    return this.std.get(AIWidgetUI)(
      createElement(DiffPlaygroundButton, { open: this.handleOpen }),
    );
  }
}

export const blockDiffPlayground = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_BLOCK_DIFF_PLAYGROUND,
  MYOXUS_BLOCK_DIFF_PLAYGROUND,
);
