import {
  DocEmbedProvider,
  awaitDocEmbedReference,
} from "@virgultum/core/services";
import { flip, offset, shift } from "@floating-ui/dom";
import { computed, effect, signal } from "@preact/signals-core";
import { baseTheme, cssVar } from "@myoxus/theme";
import { mountEditorPortal } from "@virgultum/core/view/portal";
import { HoverController } from "@virgultum/core/view/hover";
import { PeekViewProvider } from "@virgultum/core/view/peek";
import type { FootNote } from "@virgultum/core/models";
import {
  CitationProvider,
  EditorChromeHostIdentifier,
  FootnoteReactHostIdentifier,
  type FootnoteMarkerHostProps,
} from "@virgultum/core/services";
import {
  navigateLocalFootnote,
  localFootnotePresentation,
} from "@virgultum/core/commands";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { isValidUrl, normalizeUrl } from "@virgultum/core/utils";
import {
  BlockSelection,
  type BlockStdScope,
  NativeViewElement,
  installEditorStyles,
  TextSelection,
} from "@virgultum/core/runtime";
import {
  INLINE_ROOT_ATTR,
  type InlineRootElement,
  ZERO_WIDTH_FOR_EMBED_NODE,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/core/runtime/inline";
import type { DeltaInsert } from "@virgultum/core/store";
import type { FootNoteNodeConfigProvider } from "./footnote-config";
import { createCitationPreviewControls } from "./citation-preview-session";

// Virtual padding for the footnote popup overflow detection offsets.
const POPUP_SHIFT_PADDING = 8;
// The offset between the footnote node and the popup.
const POPUP_OFFSET = 4;

const markerStyles = `
    .footnote-node {
      padding: 0 2px;
      user-select: none;
      cursor: pointer;
    }

    .footnote-node {
      .footnote-content-default {
        display: inline-block;
        background: ${cssVar("primaryColor")};
        color: ${cssVar("pureWhite")};
        width: 14px;
        height: 14px;
        line-height: 14px;
        font-size: 10px;
        font-weight: 400;
        border-radius: 50%;
        text-align: center;
        text-overflow: ellipsis;
        font-family: ${baseTheme.fontSansFamily};
        transition: background 0.3s ease-in-out;
        transform: translateY(-0.2em);
      }
    }

    .footnote-node.hover-effect {
      .footnote-content-default {
        color: var(--myoxus-text-primary-color);
        background: ${cssVar("backgroundSecondaryColor")};
      }
    }

    .footnote-node.hover-effect:hover {
      .footnote-content-default {
        color: ${cssVar("pureWhite")};
        background: ${cssVar("primaryColor")};
      }
    }
  `;

export class MyoxusFootnoteNode extends NativeViewElement {
  std!: BlockStdScope;
  config?: FootNoteNodeConfigProvider;
  private readonly input = signal<DeltaInsert<MyoxusTextAttributes>>({
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
  });
  set delta(value: DeltaInsert<MyoxusTextAttributes>) {
    this.input.value = value;
  }
  get delta() {
    return this.input.value;
  }
  private release?: () => void;

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

  private readonly _whenHover: HoverController = new HoverController(
    this,
    ({ abortController }) => {
      const { footnote } = this;
      const chrome = this.std.getOptional(EditorChromeHostIdentifier);
      if (!chrome || !footnote || footnote.definitionId !== undefined)
        return null;

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

      return mountEditorPortal(
        this.std.host,
        abortController,
        (anchor) =>
          chrome.mountCitationPreview(
            anchor,
            createCitationPreviewControls(
              this.std,
              this,
              footnote,
              () => this.footnote,
              abortController,
              this.onPopupClick ?? this.onFootnoteClick,
              this._updateFootnoteAttributes,
            ),
          ),
        {
          referenceElement: this,
          placement: "top",
          autoUpdate: true,
          middleware: [
            shift({ padding: POPUP_SHIFT_PADDING }),
            flip(),
            offset(POPUP_OFFSET),
          ],
        },
      );
    },
    { enterDelay: 300 },
  );

  connectedCallback() {
    installEditorStyles(this, markerStyles);
    const doc = this.ownerDocument,
      hover = this._whenHover;
    hover.hostConnected();
    const host = this.std.getOptional(FootnoteReactHostIdentifier);
    const kind = computed(() => {
      const note = this.footnote;
      return !note
        ? null
        : note.definitionId !== undefined
          ? "local"
          : "citation";
    });
    const stop = effect(() => {
      this.replaceChildren();
      const mode = kind.value;
      if (!mode) return;
      const marker = doc.createElement("sup");
      marker.contentEditable = "false";
      const caret = doc.createElement("v-text");
      caret.str = ZERO_WIDTH_FOR_EMBED_NODE;
      const wrapper = mode === "local" ? this : doc.createElement("span");
      if (wrapper !== this) {
        wrapper.className = this.disableHoverEffect
          ? "footnote-node"
          : "footnote-node hover-effect";
        this.append(wrapper);
      }
      wrapper.append(marker, caret);
      if (mode === "citation" && !this.hidePopup) hover.setReference(wrapper);
      const revision = signal(0);
      const changes =
        mode === "local"
          ? this.std.store.slots.blockUpdated.subscribe(() => revision.value++)
          : undefined;
      const state = computed<FootnoteMarkerHostProps>(() => {
        const note = this.footnote;
        if (note?.definitionId !== undefined) {
          void revision.value;
          const presentation = localFootnotePresentation(this.std.store).get(
            note.definitionId,
          );
          return {
            ...presentation,
            missing: !presentation?.placement,
            navigate: this.onFootnoteClick,
          };
        }
        return {
          hasPreview:
            !this.hidePopup &&
            !!this.std.getOptional(EditorChromeHostIdentifier),
          label: note?.label,
          missing: false,
          navigate: this.onFootnoteClick,
        };
      });
      let unmount: () => void;
      if (host) unmount = host.mountMarker(marker, state);
      else {
        const fallback = doc.createElement(
          mode === "local" ? "button" : "span",
        );
        if (fallback instanceof HTMLButtonElement) fallback.type = "button";
        else fallback.className = "footnote-content-default";
        fallback.onclick = this.onFootnoteClick;
        if (mode === "local") marker.append(fallback);
        else marker.replaceWith(fallback);
        unmount = effect(() => {
          fallback.textContent = String(
            state.value.label ?? state.value.number ?? "?",
          );
        });
      }
      return () => {
        hover.abort(true);
        hover.setReference(undefined);
        changes?.unsubscribe();
        unmount();
      };
    });
    this.release = () => {
      stop();
      hover.hostDisconnected();
    };
  }
  disconnectedCallback() {
    this.release?.();
    this.release = undefined;
  }
}
