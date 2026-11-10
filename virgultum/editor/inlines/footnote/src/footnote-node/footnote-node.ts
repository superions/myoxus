import {
  DocEmbedProvider,
  awaitDocEmbedReference,
} from "@virgultum/shared/services";
import { flip, offset, shift } from "@floating-ui/dom";
import { baseTheme } from "@myoxus/theme";
import { HoverController } from "@virgultum/components/hover";
import { PeekViewProvider } from "@virgultum/components/peek";
import { WithDisposable } from "@virgultum/global/lit";
import type { FootNote } from "@virgultum/model";
import {
  CitationProvider,
  FootnoteReactHostIdentifier,
} from "@virgultum/shared/services";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import {
  navigateLocalFootnote,
  localFootnotePresentation,
} from "@virgultum/shared/commands";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { isValidUrl, normalizeUrl } from "@virgultum/shared/utils";
import {
  BlockSelection,
  type BlockStdScope,
  ShadowlessElement,
  TextSelection,
} from "@virgultum/std";
import {
  INLINE_ROOT_ATTR,
  type InlineRootElement,
  ZERO_WIDTH_FOR_EMBED_NODE,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/std/inline";
import type { DeltaInsert } from "@virgultum/store";
import { css, html, nothing, unsafeCSS } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit-html/directives/class-map.js";
import { ref } from "lit-html/directives/ref.js";

import type { FootNoteNodeConfigProvider } from "./footnote-config";
import { renderCitationPreview } from "./citation-preview-session";

// Virtual padding for the footnote popup overflow detection offsets.
const POPUP_SHIFT_PADDING = 8;
// The offset between the footnote node and the popup.
const POPUP_OFFSET = 4;

export class MyoxusFootnoteNode extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    .footnote-node {
      padding: 0 2px;
      user-select: none;
      cursor: pointer;
    }

    .footnote-node {
      .footnote-content-default {
        display: inline-block;
        background: ${unsafeCSSVar("primaryColor")};
        color: ${unsafeCSSVar("pureWhite")};
        width: 14px;
        height: 14px;
        line-height: 14px;
        font-size: 10px;
        font-weight: 400;
        border-radius: 50%;
        text-align: center;
        text-overflow: ellipsis;
        font-family: ${unsafeCSS(baseTheme.fontSansFamily)};
        transition: background 0.3s ease-in-out;
        transform: translateY(-0.2em);
      }
    }

    .footnote-node.hover-effect {
      .footnote-content-default {
        color: var(--myoxus-text-primary-color);
        background: ${unsafeCSSVar("backgroundSecondaryColor")};
      }
    }

    .footnote-node.hover-effect:hover {
      .footnote-content-default {
        color: ${unsafeCSSVar("pureWhite")};
        background: ${unsafeCSSVar("primaryColor")};
      }
    }
  `;

  get customNodeRenderer() {
    return this.config?.customNodeRenderer;
  }

  get customPopupRenderer() {
    return this.config?.customPopupRenderer;
  }

  get interactive() {
    return this.config?.interactive;
  }

  get hidePopup() {
    return this.config?.hidePopup;
  }

  get disableHoverEffect() {
    return this.config?.disableHoverEffect;
  }

  get onPopupClick() {
    return this.config?.onPopupClick;
  }

  get inlineEditor() {
    const inlineRoot = this.closest<InlineRootElement<MyoxusTextAttributes>>(
      `[${INLINE_ROOT_ATTR}]`,
    );
    return inlineRoot?.inlineEditor;
  }

  get selfInlineRange() {
    const selfInlineRange = this.inlineEditor?.getInlineRangeFromElement(this);
    return selfInlineRange;
  }

  get footnote() {
    return this.delta.attributes?.footnote;
  }

  get readonly() {
    return this.std.store.readonly;
  }

  get citationService() {
    return this.std.get(CitationProvider);
  }

  onFootnoteClick = () => {
    if (!this.footnote) {
      return;
    }
    if (this.footnote.definitionId !== undefined) {
      const block = this.closest("[data-block-id]");
      const model = block?.getAttribute("data-block-id");
      const origin = model ? this.std.store.getModelById(model) : null;
      const inlineEditor = this.inlineEditor;
      const range = this.selfInlineRange;
      navigateLocalFootnote(
        this.std,
        this.footnote.definitionId,
        origin && inlineEditor && range
          ? {
              model: origin,
              index: range.index,
              text: inlineEditor.yText,
              // Non-block text (for example table cells) keeps its existing inline
              // range owner; no synthetic paragraph selection or table controller.
              restore:
                origin.text?.yText === inlineEditor.yText
                  ? undefined
                  : (index, length) => {
                      const root = inlineEditor.rootElement;
                      if (!root?.isConnected) return false;
                      this.std.event.active = true;
                      this.std.selection.setGroup("note", []);
                      root.focus();
                      inlineEditor.setInlineRange({ index, length });
                      inlineEditor.syncInlineRange();
                      root.scrollIntoView({ block: "center" });
                      return true;
                    },
            }
          : undefined,
      );
      return;
    }
    const { type, docId, url, workspaceId } = this.footnote.reference;

    switch (type) {
      case "doc":
        if (docId) {
          this._handleDocReference(docId, workspaceId).catch(console.error);
        }
        break;
      case "url":
        if (url) {
          this._handleUrlReference(url);
        }
        break;
    }
  };

  private readonly _handleDocReference = async (
    docId: string,
    workspaceId?: string,
  ) => {
    const provider = this.std.getOptional(DocEmbedProvider);
    const resolved = await awaitDocEmbedReference(
      provider,
      docId,
      workspaceId ?? this.std.workspace.id,
    );
    try {
      if (
        provider?.openReference &&
        (!resolved || !(await resolved.access.canRead(resolved.docId)))
      )
        return;
      await this.std.getOptional(PeekViewProvider)?.peek({
        docId: resolved?.docId ?? docId,
        workspaceId: resolved?.collection.id ?? workspaceId,
      });
    } finally {
      resolved?.dispose();
    }
  };

  private readonly _handleUrlReference = (url: string) => {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl || !isValidUrl(normalizedUrl)) return;
    window.open(normalizedUrl, "_blank", "noopener,noreferrer");
  };

  private readonly _updateFootnoteAttributes = (footnote: FootNote) => {
    if (!this.footnote || this.readonly) {
      return;
    }

    if (!this.inlineEditor || !this.selfInlineRange) {
      return;
    }

    this.inlineEditor.formatText(this.selfInlineRange, {
      footnote: footnote,
    });
  };

  private readonly _FootNoteDefaultContent = (footnote: FootNote) => {
    return html`<span
      class="footnote-content-default"
      @click=${this.onFootnoteClick}
      >${footnote.label}</span
    >`;
  };

  private readonly _FootNotePopup = (
    footnote: FootNote,
    abortController: AbortController,
  ) => {
    if (footnote.definitionId !== undefined) return html``;
    return this.customPopupRenderer
      ? this.customPopupRenderer(footnote, this.std, abortController)
      : renderCitationPreview(
          this.std,
          this,
          footnote,
          () => this.footnote,
          abortController,
          this.onPopupClick ?? this.onFootnoteClick,
          this._updateFootnoteAttributes,
        );
  };

  private readonly _whenHover: HoverController = new HoverController(
    this,
    ({ abortController }) => {
      const { footnote } = this;
      if (!footnote || footnote.definitionId) return null;

      if (
        this.config?.hidePopup ||
        !this.selfInlineRange ||
        !this.inlineEditor
      ) {
        return null;
      }

      const selection = this.std?.selection;
      if (!selection) {
        return null;
      }
      const textSelection = selection.find(TextSelection);
      if (!!textSelection && !textSelection.isCollapsed()) {
        return null;
      }

      const blockSelections = selection.filter(BlockSelection);
      if (blockSelections.length) {
        return null;
      }

      this.citationService.trackEvent("Hover", {
        control: "Source Footnote",
      });

      return {
        template: this._FootNotePopup(footnote, abortController),
        // Native Facade styles live in the document; custom renderers keep their existing shadow root.
        shadowDom: !!this.customPopupRenderer,
        container: this.std.host,
        computePosition: {
          referenceElement: this,
          placement: "top",
          autoUpdate: true,
          middleware: [
            shift({ padding: POPUP_SHIFT_PADDING }),
            flip(),
            offset(POPUP_OFFSET),
          ],
        },
      };
    },
    { enterDelay: 300 },
  );

  override connectedCallback() {
    super.connectedCallback();
    this.disposables.add(
      this.std.store.slots.blockUpdated.subscribe(() => this.requestUpdate()),
    );
  }

  override render() {
    const attributes = this.delta.attributes;
    const footnote = attributes?.footnote;
    if (!footnote) {
      return nothing;
    }

    if (footnote.definitionId !== undefined) {
      const presentation = localFootnotePresentation(this.std.store).get(
        footnote.definitionId,
      );
      const missing = !presentation?.placement;
      const host = this.std.getOptional(FootnoteReactHostIdentifier);
      return html`<sup contenteditable="false"
          >${host?.renderMarker({ ...presentation, missing, navigate: this.onFootnoteClick }) ?? html`<button type="button" @click=${this.onFootnoteClick}>${presentation?.number ?? "?"}</button>`}</sup
        ><v-text .str=${ZERO_WIDTH_FOR_EMBED_NODE}></v-text>`;
    }
    const host = this.std.getOptional(FootnoteReactHostIdentifier);
    const node = this.customNodeRenderer
      ? this.customNodeRenderer(footnote, this.std)
      : host
        ? html`<sup contenteditable="false"
            >${host.renderMarker({ label: footnote.label, missing: false, navigate: this.onFootnoteClick })}</sup
          >`
        : this._FootNoteDefaultContent(footnote);

    const nodeClasses = classMap({
      "footnote-node": true,
      "hover-effect": !this.disableHoverEffect,
    });

    return html`<span
      ${this.hidePopup ? "" : ref(this._whenHover.setReference)}
      class=${nodeClasses}
      >${node}<v-text .str=${ZERO_WIDTH_FOR_EMBED_NODE}></v-text
    ></span>`;
  }

  @property({ attribute: false })
  accessor config: FootNoteNodeConfigProvider | undefined = undefined;

  @property({ type: Object })
  accessor delta: DeltaInsert<MyoxusTextAttributes> = {
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
    attributes: {},
  };

  @property({ attribute: false })
  accessor std!: BlockStdScope;
}
