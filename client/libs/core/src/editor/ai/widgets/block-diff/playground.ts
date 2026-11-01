import { createLitPortal } from "@virgultum/components/portal";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontSMStyle, fontWebStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { WidgetComponent, WidgetViewExtension } from "@virgultum/editor/std";
import type { Store } from "@virgultum/editor/store";
import { css, html, LitElement } from "lit";
import { property, query, state } from "lit/decorators.js";
import { literal, unsafeStatic } from "lit/static-html.js";

import { BlockDiffProvider } from "../../services/block-diff";

export const MYOXUS_BLOCK_DIFF_PLAYGROUND = "myoxus-block-diff-playground";
export const MYOXUS_BLOCK_DIFF_PLAYGROUND_MODAL =
  "myoxus-block-diff-playground-modal";

export class BlockDiffPlaygroundModal extends WithDisposable(LitElement) {
  static override styles = css`
    .playground-modal {
      z-index: var(--myoxus-z-index-modal);
      inline-size: min(
        100%,
        ${unsafeCSSValue(
          "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 20\n  )",
        )}
      );
      background: ${unsafeCSSVar("backgroundOverlayPanelColor")};
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("borderColor")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-xl)")};
      box-shadow: ${unsafeCSSValue("var(--mantine-shadow-sm)")};
      padding: ${unsafeCSSValue("var(--mantine-spacing-xl)")}
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )}
        ${unsafeCSSValue("var(--mantine-spacing-lg)")};
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      color: ${unsafeCSSVar("textPrimaryColor")};
    }

    .playground-modal-title {
      color: ${unsafeCSSVar("textPrimaryColor")};
    }

    .playground-textarea {
      width: 100%;
      min-height: calc(
        ${unsafeCSSValue("calc(var(--mantine-spacing-2xl) * 2)")} * 5
      );
      resize: vertical;
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("borderColor")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
      padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      outline: none;
      font-family: inherit;
      box-sizing: border-box;
      background: ${unsafeCSSVar("backgroundPrimaryColor")};
      color: ${unsafeCSSVar("textPrimaryColor")};
    }

    .playground-textarea:focus-visible {
      border-color: ${unsafeCSSVar("primaryColor")};
      box-shadow: ${unsafeCSSValue(
        "0px 0px 0px 2px\n    color-mix(in srgb, var(--myoxus-accent-primary) 30%, transparent)",
      )};
    }

    .playground-actions {
      display: flex;
      justify-content: flex-end;
      gap: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      margin-top: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    }

    .playground-btn {
      min-block-size: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))",
      )};
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-lg)")};
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("borderColor")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      cursor: pointer;
      background: ${unsafeCSSVar("backgroundPrimaryColor")};
      color: ${unsafeCSSVar("textPrimaryColor")};
      transition:
        background ${unsafeCSSValue("200ms")} ease,
        border-color ${unsafeCSSValue("200ms")} ease,
        box-shadow ${unsafeCSSValue("200ms")} ease;
    }

    .playground-btn.primary {
      background: ${unsafeCSSVar("primaryColor")};
      border-color: ${unsafeCSSVar("primaryColor")};
      color: ${unsafeCSSVar("pureWhite")};
    }

    .playground-btn.primary:hover {
      background: ${unsafeCSSVar("primaryColor")};
      border-color: ${unsafeCSSVar("primaryColor")};
    }

    .playground-btn:hover {
      background: ${unsafeCSSVar("hoverColor")};
    }

    .playground-btn:focus-visible {
      outline: none;
      box-shadow: ${unsafeCSSValue(
        "0px 0px 0px 2px\n    color-mix(in srgb, var(--myoxus-accent-primary) 30%, transparent)",
      )};
    }

    ${fontWebStyle(".playground-modal-title", "card-title")}
    ${fontSMStyle(".playground-textarea")}
    ${fontSMStyle(".playground-btn")}
  `;

  @state()
  private accessor markdown = "";

  @property({ attribute: false })
  accessor diffService!: BlockDiffProvider;

  @property({ attribute: false })
  accessor store!: Store;

  @property({ attribute: false })
  accessor onClose!: () => void;

  private readonly handleInput = (e: Event) => {
    this.markdown = (e.target as HTMLTextAreaElement).value;
  };

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

  private readonly stopPropagation = (e: MouseEvent) => {
    e.stopPropagation();
  };

  override render() {
    return html`
      <div class="playground-modal">
        <div class="playground-modal-title">Block Diff Playground</div>
        <div class="playground-modal-content">
          <textarea
            class="playground-textarea"
            placeholder="Please input the markdown you want to apply."
            .value=${this.markdown}
            @input=${this.handleInput}
            @focus=${(e: FocusEvent) => e.stopPropagation()}
            @pointerdown=${this.stopPropagation}
            @mousedown=${this.stopPropagation}
            @mouseup=${this.stopPropagation}
            @click=${this.stopPropagation}
            @keydown=${this.stopPropagation}
            @keyup=${this.stopPropagation}
            @copy=${this.stopPropagation}
            @cut=${this.stopPropagation}
            @paste=${this.stopPropagation}
            @blur=${(e: FocusEvent) => e.stopPropagation()}
          ></textarea>
          <div class="playground-actions">
            <button
              class="playground-btn"
              @click=${this.handleInsertCurrentMarkdown}
            >
              Insert Current Doc MD
            </button>
            <button class="playground-btn" @click=${this.handleClear}>
              Clear
            </button>
            <button class="playground-btn primary" @click=${this.handleConfirm}>
              Confirm
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

export class BlockDiffPlayground extends WidgetComponent {
  static override styles = css`
    .playground-fab {
      position: fixed;
      right: ${unsafeCSSValue("var(--mantine-spacing-2xl)")};
      bottom: ${unsafeCSSValue("var(--mantine-spacing-2xl)")};
      z-index: var(--myoxus-z-index-modal);
      width: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
      border-radius: 50%;
      background: ${unsafeCSSVar("primaryColor")};
      color: ${unsafeCSSVar("pureWhite")};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
      box-shadow: ${unsafeCSSValue("var(--mantine-shadow-sm)")};
      cursor: pointer;
      transition:
        background ${unsafeCSSValue("200ms")} ease,
        box-shadow ${unsafeCSSValue("200ms")} ease;
    }

    .playground-fab:hover {
      background: ${unsafeCSSVar("primaryColor")};
      box-shadow: ${unsafeCSSValue("var(--mantine-shadow-md)")};
    }

    .playground-fab:focus-visible {
      outline: none;
      box-shadow: ${unsafeCSSValue(
        "0px 0px 0px 2px\n    color-mix(in srgb, var(--myoxus-accent-primary) 30%, transparent)",
      )};
    }
  `;

  @query(".playground-fab")
  accessor fab!: HTMLDivElement;

  private _abortController: AbortController | null = null;

  private get diffService() {
    return this.std.get(BlockDiffProvider);
  }

  private readonly handleOpen = () => {
    this._abortController?.abort();
    this._abortController = new AbortController();

    createLitPortal({
      template: html`
        <myoxus-block-diff-playground-modal
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

  override render() {
    // Read-only answer previews share page extensions but must not expose a
    // document mutation playground or its viewport-fixed development control.
    if (this.std.store.readonly) return html``;
    return html`
      <div>
        <div
          class="playground-fab"
          @click=${this.handleOpen}
          title="Block Diff Playground"
        >
          🧪
        </div>
      </div>
    `;
  }
}

export const blockDiffPlayground = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_BLOCK_DIFF_PLAYGROUND,
  literal`${unsafeStatic(MYOXUS_BLOCK_DIFF_PLAYGROUND)}`,
);
