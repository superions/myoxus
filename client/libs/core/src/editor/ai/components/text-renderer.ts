import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { createReactComponentFromLit } from "@myoxus/lit-react";
import type { Signal } from "@preact/signals-core";
import { PeekViewProvider } from "@virgultum/editor/components/peek";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import type { ColorScheme } from "@virgultum/editor/model";
import {
  codeBlockWrapMiddleware,
  defaultImageProxyMiddleware,
  ImageProxyService,
} from "@virgultum/editor/shared/adapters";
import {
  fontBaseStyle,
  fontWebStyle,
  scrollbarStyle,
} from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import {
  BlockStdScope,
  type EditorHost,
  ShadowlessElement,
} from "@virgultum/editor/std";
import type {
  ExtensionType,
  Query,
  Store,
  TransformerMiddleware,
} from "@virgultum/editor/store";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, query } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { keyed } from "lit/directives/keyed.js";
import React from "react";
import { filter } from "rxjs/operators";

import { markDownToDoc } from "../../utils";
import type { MyoxusAIPanelState } from "../widgets/ai-panel/type";
import { getCustomPageEditorBlockSpecs } from "./page-editor-block-specs";

const customHeadingStyles = css`
  .custom-heading {
    --myoxus-font-h-1: var(
      --mantine-font-size-section-title,
      var(--mantine-font-size-md)
    );
    --myoxus-font-h-2: var(
      --mantine-font-size-card-title,
      var(--mantine-font-size-md)
    );
    --myoxus-font-h-3: var(
      --mantine-font-size-card-title,
      var(--mantine-font-size-md)
    );
    --myoxus-font-h-4: var(--myoxus-font-base);
    --myoxus-font-h-5: var(--myoxus-font-sm);
    --myoxus-font-h-6: var(--myoxus-font-xs);
  }
`;

export type TextRendererOptions = {
  /** Secondary read-only content uses the theme's small-body role, not document typography. */
  annotation?: boolean;
  customHeading?: boolean;
  extensions?: ExtensionType[];
  additionalMiddlewares?: TransformerMiddleware[];
  testId?: string;
  myoxusFeatureFlagService?: FeatureFlagService;
  theme?: Signal<ColorScheme>;
};

// todo: refactor it for more general purpose usage instead of AI only?
export class TextRenderer extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = css`
    .ai-answer-text-editor.myoxus-page-viewport {
      background: transparent;
      margin-top: 0;
      margin-bottom: 0;
    }

    ${fontBaseStyle(".ai-answer-text-editor.myoxus-page-viewport")}

    /* The embedded document sets explicit fonts and colors. Project the same
       small-body role as the Facade wrapper at the renderer's actual root. */
    ${fontWebStyle(".annotation .ai-answer-text-editor .myoxus-page-root-block-container", "body-small")}

    .annotation .ai-answer-text-editor .myoxus-page-root-block-container {
      --myoxus-font-base: var(--mantine-font-size-body-small);
      font-style: italic;
      color: ${unsafeCSSVar("textSecondaryColor")};
    }

    .ai-answer-text-editor .myoxus-page-root-block-container {
      padding: 0;
      margin: 0;
      color: ${unsafeCSSVar("textPrimaryColor")};
    }

    .ai-answer-text-editor {
      .myoxus-note-block-container {
        > .myoxus-block-children-container {
          > :first-child:not(myoxus-callout),
          > :first-child:not(myoxus-callout) * {
            margin-top: 0 !important;
          }
          > :last-child,
          > :last-child * {
            margin-bottom: 0 !important;
          }
        }
      }

      .myoxus-paragraph-block-container {
        .h6 {
          padding-left: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
          color: ${unsafeCSSVar("linkColor")};

          .toggle-icon {
            transform: translateX(0);
            svg {
              color: ${unsafeCSSVar("linkColor")};
            }
          }
        }
      }
    }

    .text-renderer-container {
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0;
    }

    ${scrollbarStyle(".text-renderer-container.show-scrollbar")}

    .text-renderer-container.show-scrollbar:hover::-webkit-scrollbar-thumb {
      background-color: ${unsafeCSSVar("iconColor")};
    }

    .text-renderer-container {
      rich-text .nowrap-lines v-text span,
      rich-text .nowrap-lines v-element span {
        white-space: pre;
      }
      editor-host:focus-visible {
        outline: none;
      }
      editor-host * {
        box-sizing: border-box;
      }
      editor-host {
        isolation: isolate;
      }
    }

    ${customHeadingStyles}
  `;

  private _answers: string[] = [];

  private _maxContainerHeight = 0;

  private readonly _clearTimer = () => {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  };

  private _doc: Store | null = null;

  private _host: EditorHost | null = null;

  private readonly _query: Query = {
    mode: "strict",
    match: [
      "myoxus:page",
      "myoxus:note",
      "myoxus:table",
      "myoxus:surface",
      "myoxus:paragraph",
      "myoxus:callout",
      "myoxus:code",
      "myoxus:list",
      "myoxus:divider",
      "myoxus:latex",
      "myoxus:bookmark",
      "myoxus:attachment",
      "myoxus:embed-linked-doc",
    ].map((flavour) => ({ flavour, viewType: "display" })),
  };

  private _timer?: ReturnType<typeof setInterval> | null = null;

  private readonly _subscribeDocLinkClicked = () => {
    const refNodeSlots = this._host?.std.getOptional(RefNodeSlotsProvider);
    if (!refNodeSlots) return;
    this.disposables.add(
      refNodeSlots.docLinkClicked
        .pipe(
          filter(
            (options) =>
              !!this._previewHost && options.host === this._previewHost,
          ),
        )
        .subscribe((options) => {
          // Open the doc in center peek
          this._host?.std
            .getOptional(PeekViewProvider)
            ?.peek({
              docId: options.pageId,
              workspaceId: options.workspaceId,
            })
            .catch(console.error);
        }),
    );
  };

  private readonly _updateDoc = () => {
    if (this._answers.length > 0) {
      const latestAnswer = this._answers.pop();
      this._answers = [];
      if (latestAnswer) {
        const middlewares = [
          defaultImageProxyMiddleware,
          codeBlockWrapMiddleware(true),
          ...(this.options.additionalMiddlewares ?? []),
        ];
        markDownToDoc(
          latestAnswer,
          middlewares,
          this.options.myoxusFeatureFlagService,
        )
          .then((doc) => {
            this.disposeDoc();
            this._doc = doc.doc.getStore({
              query: this._query,
            });
            this._host = new BlockStdScope({
              store: this._doc,
              extensions:
                this.options.extensions ?? getCustomPageEditorBlockSpecs(),
            }).render();
            this.disposables.add(() => {
              doc.doc.removeStore({ query: this._query });
            });
            this._doc.readonly = true;
            this.requestUpdate();
            if (this.state !== "generating") {
              this._doc.load();
              const imageProxyService = this._host.std.get(ImageProxyService);
              imageProxyService.setImageProxyURL(
                imageProxyService.imageProxyURL,
              );
              this._clearTimer();
            }
          })
          .catch(console.error);
      }
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this._answers.push(this.answer);

    this._updateDoc();
    if (this.state === "generating") {
      this._timer = setInterval(this._updateDoc, 600);
    }
  }

  override firstUpdated() {
    this._subscribeDocLinkClicked();
  }

  private disposeDoc() {
    this._doc?.dispose();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._clearTimer();
    this.disposeDoc();
  }

  override render() {
    if (!this._doc) {
      return nothing;
    }

    const { customHeading, testId = "ai-text-renderer" } = this.options;
    const classes = classMap({
      "text-renderer-container": true,
      "custom-heading": !!customHeading,
      annotation: !!this.options.annotation,
    });
    return html`
      <div class=${classes} data-testid=${testId}>
        ${keyed(
          this._doc,
          html`<div class="ai-answer-text-editor myoxus-page-viewport">
            ${this._host}
          </div>`,
        )}
      </div>
    `;
  }

  override shouldUpdate(changedProperties: PropertyValues) {
    if (changedProperties.has("answer")) {
      this._answers.push(this.answer);
      return false;
    }

    return true;
  }

  override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    requestAnimationFrame(() => {
      if (!this._container) return;
      // Track max height during generation
      if (this.state === "generating") {
        this._maxContainerHeight = Math.max(
          this._maxContainerHeight,
          this._container.scrollHeight,
        );
        // Preserve the renderer's measured content height during streaming;
        // this is runtime geometry, not a product-authored responsive value.
        this._container.style.minHeight = `${this._maxContainerHeight}px`;
      } else {
        setTimeout(() => {
          this._maxContainerHeight = 0;
          this._container.style.minHeight = "";
        }, 500);
      }
    });
  }

  @query(".text-renderer-container")
  private accessor _container!: HTMLDivElement;

  @query(".text-renderer-container editor-host")
  private accessor _previewHost: EditorHost | null = null;

  @property({ attribute: false })
  accessor answer!: string;

  @property({ attribute: false })
  accessor options!: TextRendererOptions;

  @property({ attribute: false })
  accessor state: MyoxusAIPanelState | undefined = undefined;
}

export const createTextRenderer = (options: TextRendererOptions) => {
  return (answer: string, state?: MyoxusAIPanelState) => {
    return html`<text-renderer
      contenteditable="false"
      .answer=${answer}
      .state=${state}
      .options=${options}
    ></text-renderer>`;
  };
};

export const LitTextRenderer = createReactComponentFromLit({
  react: React,
  elementClass: TextRenderer,
});

declare global {
  interface HTMLElementTagNameMap {
    "text-renderer": TextRenderer;
  }
}
