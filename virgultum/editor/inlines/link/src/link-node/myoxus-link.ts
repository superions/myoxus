import { whenHover } from "@virgultum/components/hover";
import { WithDisposable } from "@virgultum/global/lit";
import { RefNodeSlotsProvider } from "@virgultum/inline-reference";
import type { ReferenceInfo } from "@virgultum/model";
import {
  ParseDocUrlProvider,
  ToolbarRegistryIdentifier,
} from "@virgultum/shared/services";
import { myoxusTextStyles } from "@virgultum/shared/styles";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { normalizeUrl } from "@virgultum/shared/utils";
import {
  BLOCK_ID_ATTR,
  type BlockComponent,
  type BlockStdScope,
  ShadowlessElement,
} from "@virgultum/std";
import {
  INLINE_ROOT_ATTR,
  type InlineRootElement,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/std/inline";
import type { DeltaInsert } from "@virgultum/store";
import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { type StyleInfo, styleMap } from "lit/directives/style-map.js";

export class MyoxusLink extends WithDisposable(ShadowlessElement) {
  static override styles = css`
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

  _whenHover = whenHover(
    (hovered) => {
      const message$ = this.std.get(ToolbarRegistryIdentifier).message$;

      if (hovered) {
        message$.value = {
          flavour: "myoxus:link",
          element: this,
          setFloating: this._whenHover.setFloating,
        };
        return;
      }

      // Clears previous bindings
      message$.value = null;
      this._whenHover.setFloating();
    },
    { enterDelay: 500 },
  );

  override connectedCallback() {
    super.connectedCallback();

    this._whenHover.setReference(this);

    const message$ = this.std.get(ToolbarRegistryIdentifier).message$;

    this._disposables.add(() => {
      if (message$?.value) {
        message$.value = null;
      }
      this._whenHover.dispose();
    });
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
  private _renderLink(style: StyleInfo) {
    return html`<a
      href=${this.link}
      rel="noopener noreferrer"
      target="_blank"
      style=${styleMap(style)}
      @click=${this.openLink}
      @auxclick=${this.openLink}
      @mouseup=${this._onMouseUp}
      ><v-text
        style=${styleMap({
          "text-decoration":
            [
              this.delta.attributes?.underline ? "underline" : "",
              this.delta.attributes?.strike ? "line-through" : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined,
        })}
        .str=${this.delta.insert}
      ></v-text
    ></a>`;
  }

  override render() {
    const attributes = this.delta.attributes ?? {};
    const textStyle = !attributes.code ? myoxusTextStyles(attributes) : {};
    // Link defaults come from the theme; explicit document emphasis is retained.
    // Code links keep their monospace face and surrounding code metrics.
    const linkStyle: StyleInfo = {
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

    if (attributes.code) {
      return html`<code style=${styleMap(myoxusTextStyles(attributes))}>
        ${this._renderLink(linkStyle)}
      </code>`;
    }

    return this._renderLink(linkStyle);
  }

  @property({ type: Object })
  accessor delta: DeltaInsert<MyoxusTextAttributes> = {
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
  };

  @property({ attribute: false })
  accessor std!: BlockStdScope;
}
