import { whenHover } from "@virgultum/core/view/hover";
import { RefNodeSlotsProvider } from "../../reference/index";
import type { ReferenceInfo } from "@virgultum/core/models";
import {
  ParseDocUrlProvider,
  ToolbarRegistryIdentifier,
} from "@virgultum/core/services";
import { myoxusTextStyles } from "@virgultum/core/styles";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { normalizeUrl } from "@virgultum/core/utils";
import {
  BLOCK_ID_ATTR,
  type BlockComponent,
  type BlockStdScope,
  NativeViewElement,
  installEditorStyles,
} from "@virgultum/core/runtime";
import {
  INLINE_ROOT_ATTR,
  inlineChild,
  setInlineStyles,
  type InlineRootElement,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/core/runtime/inline";
import type { DeltaInsert } from "@virgultum/core/store";
const linkStyles = `
    myoxus-link a {
      text-decoration: var(--myoxus-typography-link-decoration);
    }

    myoxus-link a:is(:hover, :focus-visible) {
      text-decoration: var(
        --myoxus-typography-link-hover-decoration,
        var(--myoxus-typography-link-decoration)
      );
    }
  `;

export class MyoxusLink extends NativeViewElement {
  // The link has been identified.
  private _identified: boolean = false;

  // Temporarily disable editing so mouse-up can activate the link reliably.
  private readonly _onMouseUp = () => {
    const anchorElement = this.querySelector("a");
    if (!anchorElement || !anchorElement.isContentEditable) return;
    anchorElement.contentEditable = "false";
    setTimeout(() => {
      anchorElement.removeAttribute("contenteditable");
    }, 0);
  };

  private _referenceInfo: ReferenceInfo | null = null;

  openLink = (e?: MouseEvent) => {
    if (!this._identified) {
      this._identified = true;
      this._identify();
    }

    const referenceInfo = this._referenceInfo;
    if (!referenceInfo) return;

    const refNodeSlotsProvider = this.std.getOptional(RefNodeSlotsProvider);
    if (!refNodeSlotsProvider) return;

    e?.preventDefault();

    refNodeSlotsProvider.docLinkClicked.next({
      ...referenceInfo,
      openMode: e?.button === 1 ? "open-in-new-tab" : undefined,
      host: this.std.host,
    });
  };

  private hover?: ReturnType<typeof whenHover>;
  connectedCallback() {
    installEditorStyles(this, linkStyles);
    this.updateLink();
    const hover = whenHover(
      (hovered) => {
        const message$ = this.std.get(ToolbarRegistryIdentifier).message$;

        if (hovered) {
          message$.value = {
            flavour: "myoxus:link",
            element: this,
            setFloating: hover.setFloating,
          };
          return;
        }

        // Clears previous bindings
        message$.value = null;
        hover.setFloating();
      },
      { enterDelay: 500 },
    );

    this.hover = hover;
    hover.setReference(this);
  }

  disconnectedCallback() {
    const message = this.std.get(ToolbarRegistryIdentifier).message$;
    if (message.peek()?.element === this) message.value = null;
    this.hover?.dispose();
    this.hover = undefined;
  }

  // Workaround for links not working in contenteditable div
  // see also https://stackoverflow.com/questions/12059211/how-to-make-clickable-anchor-in-contenteditable-div
  //
  // Note: We cannot use JS to directly open a new page as this may be blocked by the browser.
  //
  // Please also note that when readonly mode active,
  // this workaround is not necessary and links work normally.
  get block() {
    if (!this.inlineEditor?.rootElement) return null;
    const block = this.inlineEditor.rootElement.closest<BlockComponent>(
      `[${BLOCK_ID_ATTR}]`,
    );
    return block;
  }

  get inlineEditor() {
    const inlineRoot = this.closest<InlineRootElement<MyoxusTextAttributes>>(
      `[${INLINE_ROOT_ATTR}]`,
    );
    return inlineRoot?.inlineEditor;
  }

  get link() {
    return normalizeUrl(this.delta.attributes?.link ?? "");
  }

  get selfInlineRange() {
    const selfInlineRange = this.inlineEditor?.getInlineRangeFromElement(this);
    return selfInlineRange;
  }

  // Identify if url is an internal link
  private _identify() {
    const link = this.link;
    if (!link) return;

    const result = this.std.getOptional(ParseDocUrlProvider)?.parseDocUrl(link);
    if (!result) return;

    const { docId: pageId, workspaceId, ...params } = result;

    this._referenceInfo = { pageId, workspaceId, params };
  }

  // Keep authored decorations on the text so they coexist with the anchor's
  // theme decoration, including hover and keyboard focus.
  private updateLink() {
    const attributes = this.delta.attributes ?? {};
    const textStyle = !attributes.code ? myoxusTextStyles(attributes) : {};
    // Link defaults come from the theme; explicit document emphasis is retained.
    // Code links keep their monospace face and surrounding code metrics.
    const linkStyle = {
      ...textStyle,
      color: textStyle.color ?? "var(--myoxus-link-color)",
      fill: textStyle.color ?? "var(--myoxus-link-color)",
      "text-decoration": undefined,
      "font-weight": attributes.bold
        ? "bolder"
        : attributes.code
          ? "inherit"
          : "var(--myoxus-typography-link-weight)",
      "font-style": attributes.italic
        ? "italic"
        : attributes.code
          ? "inherit"
          : "var(--myoxus-typography-link-font-style)",
      cursor: "pointer",
      ...(!attributes.code
        ? {
            "font-family": "var(--myoxus-typography-link-family)",
            "font-size":
              "calc(var(--myoxus-typography-link-size) * var(--myoxus-document-reading-scale, 1))",
            "line-height": "var(--myoxus-typography-link-line-height)",
            "letter-spacing": "var(--myoxus-typography-link-letter-spacing)",
            "text-transform":
              "var(--myoxus-typography-link-text-transform, none)",
          }
        : {}),
    };

    const parent = attributes.code ? inlineChild(this, "code") : this;
    if (attributes.code) setInlineStyles(parent, myoxusTextStyles(attributes));
    const anchor = inlineChild(parent, "a");
    anchor.setAttribute("href", this.link);
    anchor.rel = "noopener noreferrer";
    anchor.target = "_blank";
    anchor.onclick = this.openLink;
    anchor.onauxclick = this.openLink;
    anchor.onmouseup = this._onMouseUp;
    setInlineStyles(anchor, linkStyle);
    const text = inlineChild(anchor, "v-text", { str: this.delta.insert });
    text.style.textDecoration = [
      attributes.underline ? "underline" : "",
      attributes.strike ? "line-through" : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private value: DeltaInsert<MyoxusTextAttributes> = {
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
  };
  get delta() {
    return this.value;
  }
  set delta(value: DeltaInsert<MyoxusTextAttributes>) {
    if (value.attributes?.link !== this.value.attributes?.link) {
      this._identified = false;
      this._referenceInfo = null;
    }
    this.value = value;
    if (this.isConnected) this.updateLink();
  }
  std!: BlockStdScope;
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-link": MyoxusLink;
  }
}
