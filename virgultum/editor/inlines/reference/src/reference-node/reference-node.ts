import { effect } from "@preact/signals-core";
import { LinkIcon } from "@myoxus/icons/lit";
import { whenHover } from "@virgultum/components/hover";
import { Peekable } from "@virgultum/components/peek";
import { WithDisposable } from "@virgultum/global/lit";
import type { ReferenceInfo } from "@virgultum/model";
import { DEFAULT_DOC_NAME, REFERENCE_NODE } from "@virgultum/shared/consts";
import {
  DocDisplayMetaProvider,
  DocDisplayMetaService,
  DocEmbedProvider,
  ToolbarRegistryIdentifier,
} from "@virgultum/shared/services";
import { myoxusTextStyles } from "@virgultum/shared/styles";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { cloneReferenceInfo, referenceToNode } from "@virgultum/shared/utils";
import {
  BLOCK_ID_ATTR,
  type BlockComponent,
  type BlockStdScope,
  ShadowlessElement,
} from "@virgultum/std";
import {
  INLINE_ROOT_ATTR,
  type InlineRootElement,
  ZERO_WIDTH_FOR_EMBED_NODE,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/std/inline";
import type { DeltaInsert, DocMeta, Store } from "@virgultum/store";
import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { choose } from "lit/directives/choose.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { styleMap } from "lit/directives/style-map.js";

import type { ReferenceNodeConfigProvider } from "./reference-config";
import { RefNodeSlotsProvider } from "./reference-node-slots";
import type { DocLinkClickedEvent } from "./types";

@Peekable({ action: false })
export class MyoxusReference extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    .myoxus-reference {
      white-space: normal;
      word-break: break-word;
      color: var(--myoxus-text-primary-color);
      fill: var(--myoxus-icon-color);
      border-radius: 4px;
      text-decoration: none;
      cursor: pointer;
      user-select: none;
      padding: 1px 2px 1px 0;

      svg {
        margin-bottom: 0.1em;
      }
    }
    .myoxus-reference:hover {
      background: var(--myoxus-hover-color);
    }

    .myoxus-reference[data-selected="true"] {
      background: var(--myoxus-hover-color);
    }

    .myoxus-reference-title {
      margin-left: 4px;
      border-bottom: 0.5px solid var(--myoxus-divider-color);
      transition: border 0.2s ease-out;
    }
    .myoxus-reference-title:hover {
      border-bottom: 0.5px solid var(--myoxus-icon-color);
    }
  `;

  private _targetIdentity: string | undefined;
  private _targetScope: ReturnType<
    NonNullable<DocEmbedProvider["inWorkspace"]>
  >;
  private _targetReference:
    ReturnType<NonNullable<DocEmbedProvider["openReference"]>> | undefined;
  private _targetEffect: (() => void) | undefined;
  private get targetContext() {
    const { pageId, workspaceId } = this.referenceInfo;
    const provider = this.std.getOptional(DocEmbedProvider);
    const workspace = workspaceId ?? this.std.workspace.id;
    const identity = JSON.stringify([workspace, pageId]);
    if (identity !== this._targetIdentity) {
      this._targetEffect?.();
      this._targetReference?.dispose();
      this._targetScope?.dispose();
      this._targetIdentity = identity;
      this._targetReference = provider?.openReference?.(workspace, pageId);
      this._targetScope = this._targetReference
        ? undefined
        : provider?.inWorkspace?.(workspace);
      this._targetEffect = effect(() => {
        const context = this.targetContext;
        void context?.access?.readable(context.docId).value;
        this.requestUpdate();
      });
    }
    if (this._targetReference)
      return this._targetReference.target.value ?? undefined;
    if (this._targetScope) return { ...this._targetScope, docId: pageId };
    if (workspaceId !== undefined || provider?.inWorkspace) return undefined;
    return { access: provider, collection: this.std.workspace, docId: pageId };
  }

  /** Host resolution state is independent of a stale source permission cache. */
  get referenceResolutionState(): "checking" | "unavailable" | undefined {
    void this.targetContext;
    if (!this._targetReference) return;
    const target = this._targetReference.target.value;
    return target === undefined
      ? "checking"
      : target === null
        ? "unavailable"
        : undefined;
  }

  /** Read projection only: native source addresses remain unchanged. */
  get resolvedReferenceInfo(): ReferenceInfo {
    const context = this.targetContext;
    return context
      ? {
          ...this.referenceInfo,
          pageId: context.docId,
          workspaceId: context.collection.id,
        }
      : this.referenceInfo;
  }

  get docTitle() {
    return this.refMeta?.title ?? DEFAULT_DOC_NAME;
  }

  private readonly _updateRefMeta = (_doc: Store) => {
    const refAttribute = this.resolvedReferenceInfo;
    if (!refAttribute) {
      return;
    }

    const context = this.targetContext;
    if (
      !context ||
      (context.access &&
        context.access.readable(refAttribute.pageId).value !== true)
    ) {
      this.refMeta = undefined;
      return;
    }
    const refMeta = context.collection.meta.docMetas.find(
      (doc) => doc.id === refAttribute.pageId,
    );
    this.refMeta = refMeta
      ? {
          ...refMeta,
        }
      : undefined;
  };

  // Since the linked doc may be deleted, the `_refMeta` could be undefined.
  @state()
  accessor refMeta: DocMeta | undefined = undefined;

  get _icon() {
    const { pageId, params, title } = this.resolvedReferenceInfo;
    const context = this.targetContext;
    if (
      !context ||
      (context.access && context.access.readable(pageId).value !== true)
    )
      return nothing;
    if (context.collection.id !== this.std.workspace.id)
      return DocDisplayMetaService.icons.linkedPage;
    return this.std
      .get(DocDisplayMetaProvider)
      .icon(pageId, { params, title, referenced: true }).value;
  }

  get _title() {
    const { pageId, params, title } = this.resolvedReferenceInfo;
    const context = this.targetContext;
    if (
      !context ||
      (context.access && context.access.readable(pageId).value !== true)
    )
      return "";
    if (context.collection.id !== this.std.workspace.id)
      return (
        title ?? context.access?.referenceTitleSignal?.(pageId)?.value ?? ""
      );
    return (
      this.std
        .get(DocDisplayMetaProvider)
        .title(pageId, { params, title, referenced: true }).value || title
    );
  }

  get block() {
    if (!this.inlineEditor?.rootElement) return null;
    const block = this.inlineEditor.rootElement.closest<BlockComponent>(
      `[${BLOCK_ID_ATTR}]`,
    );
    return block;
  }

  get customContent() {
    return this.config.customContent;
  }

  get doc() {
    const doc = this.config.doc;
    return doc;
  }

  get inlineEditor() {
    const inlineRoot = this.closest<InlineRootElement<MyoxusTextAttributes>>(
      `[${INLINE_ROOT_ATTR}]`,
    );
    return inlineRoot?.inlineEditor;
  }

  get referenceInfo(): ReferenceInfo {
    const reference = this.delta.attributes?.reference;
    const id = this.doc?.id ?? "";
    if (!reference) return { pageId: id };
    return cloneReferenceInfo(reference);
  }

  get selfInlineRange() {
    const selfInlineRange = this.inlineEditor?.getInlineRangeFromElement(this);
    return selfInlineRange;
  }

  readonly open = (event?: Partial<DocLinkClickedEvent>) => {
    if (!this.config.interactable) return;
    const context = this.targetContext;
    if (
      !context ||
      (context.access && context.access.readable(context.docId).value !== true)
    )
      return;
    if (event?.event?.button === 2) {
      return;
    }

    this.std.getOptional(RefNodeSlotsProvider)?.docLinkClicked.next({
      ...this.resolvedReferenceInfo,
      ...event,
      openMode:
        event?.event?.button === 1 ? "open-in-new-tab" : event?.openMode,
      host: this.std.host,
    });
  };

  _whenHover = whenHover(
    (hovered) => {
      if (!this.config.interactable) return;
      const context = this.targetContext;
      if (
        !context ||
        (context.access &&
          context.access.readable(context.docId).value !== true)
      )
        return;

      const message$ = this.std.get(ToolbarRegistryIdentifier).message$;

      if (hovered) {
        message$.value = {
          flavour: "myoxus:reference",
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
    this.disposables.add(() => {
      this._targetEffect?.();
      this._targetReference?.dispose();
      this._targetScope?.dispose();
      this._targetIdentity = undefined;
    });

    const message$ = this.std.get(ToolbarRegistryIdentifier).message$;

    this._disposables.add(() => {
      if (message$?.value) {
        message$.value = null;
      }
      this._whenHover.dispose();
    });

    if (!this.config) {
      console.error("`reference-node` need `ReferenceNodeConfig`.");
      return;
    }

    if (this.delta.insert !== REFERENCE_NODE) {
      console.error(
        `Reference node must be initialized with '${REFERENCE_NODE}', but got '${this.delta.insert}'`,
      );
    }

    const doc = this.doc;
    if (doc) {
      this._disposables.add(
        doc.workspace.slots.docListUpdated.subscribe(() =>
          this._updateRefMeta(doc),
        ),
      );
    }

    this.updateComplete
      .then(() => {
        if (!this.inlineEditor || !doc) return;

        // observe yText update
        this.disposables.add(
          this.inlineEditor.slots.textChange.subscribe(() =>
            this._updateRefMeta(doc),
          ),
        );
      })
      .catch(console.error);
  }

  // reference to block/element
  referenceToNode() {
    return referenceToNode(this.referenceInfo);
  }

  override render() {
    const refMeta = this.refMeta;
    // A host renderer owns its guarded pending/unavailable presentation.
    const isDeleted = !this.customContent && !refMeta;

    const attributes = this.delta.attributes;
    const reference = attributes?.reference;
    const type = reference?.type;
    if (!attributes || !type) {
      return nothing;
    }

    const title = this._title;
    const icon = choose(type, [
      ["LinkedPage", () => this._icon],
      [
        "Subpage",
        () =>
          LinkIcon({
            width: "1.25em",
            height: "1.25em",
            style:
              "user-select:none;flex-shrink:0;vertical-align:middle;font-size:inherit;margin-bottom:0.1em;",
          }),
      ],
    ]);

    const style = myoxusTextStyles(
      attributes,
      isDeleted
        ? {
            color: "var(--myoxus-text-disable-color)",
            textDecoration: "line-through",
            fill: "var(--myoxus-text-disable-color)",
          }
        : {},
    );

    const content = this.customContent
      ? this.customContent(this)
      : html`${icon}<span
            data-title=${ifDefined(title)}
            class="myoxus-reference-title"
            >${title}</span
          >`;

    // we need to add `<v-text .str=${ZERO_WIDTH_FOR_EMBED_NODE}></v-text>` in an
    // embed element to make sure inline range calculation is correct
    return html`<span
      data-selected=${this.selected}
      class="myoxus-reference"
      style=${styleMap(style)}
      @click=${(event: MouseEvent) => this.open({ event })}
      @auxclick=${(event: MouseEvent) => this.open({ event })}
      >${content}<v-text .str=${ZERO_WIDTH_FOR_EMBED_NODE}></v-text
    ></span>`;
  }

  override willUpdate(_changedProperties: Map<PropertyKey, unknown>) {
    super.willUpdate(_changedProperties);

    const doc = this.doc;
    if (doc) {
      this._updateRefMeta(doc);
    }
  }

  @property({ attribute: false })
  accessor config!: ReferenceNodeConfigProvider;

  @property({ type: Object })
  accessor delta: DeltaInsert<MyoxusTextAttributes> = {
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
    attributes: {},
  };

  @property({ type: Boolean })
  accessor selected = false;

  @property({ attribute: false })
  accessor std!: BlockStdScope;
}
