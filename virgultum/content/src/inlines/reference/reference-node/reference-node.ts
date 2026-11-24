import { effect, signal } from "@preact/signals-core";
import { createReferenceIcon } from "@virgultum/core/view/icons";
import { whenHover } from "@virgultum/core/view/hover";
import { Peekable } from "@virgultum/core/view/peek";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { ReferenceInfo } from "@virgultum/core/models";
import { DEFAULT_DOC_NAME, REFERENCE_NODE } from "@virgultum/core/consts";
import {
  DocDisplayMetaProvider,
  DocEmbedProvider,
  ToolbarRegistryIdentifier,
} from "@virgultum/core/services";
import { myoxusTextStyles } from "@virgultum/core/styles";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { cloneReferenceInfo, referenceToNode } from "@virgultum/core/utils";
import {
  BLOCK_ID_ATTR,
  type BlockComponent,
  type BlockStdScope,
  NativeViewElement,
  installEditorStyles,
} from "@virgultum/core/runtime";
import {
  INLINE_ROOT_ATTR,
  type InlineRootElement,
  ZERO_WIDTH_FOR_EMBED_NODE,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/core/runtime/inline";
import type { DeltaInsert, DocMeta } from "@virgultum/core/store";
import type { ReferenceNodeConfigProvider } from "./reference-config";
import { RefNodeSlotsProvider } from "./reference-node-slots";
import type { DocLinkClickedEvent } from "./types";

const styles = `
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

@Peekable({ action: false })
export class MyoxusReference extends NativeViewElement {
  std!: BlockStdScope;
  config!: ReferenceNodeConfigProvider;
  disposables = new DisposableGroup();
  private readonly currentDelta = signal<DeltaInsert<MyoxusTextAttributes>>({
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
    attributes: {},
  });
  private readonly currentSelection = signal(false);
  private readonly revision = signal(0);
  get delta() {
    return this.currentDelta.value;
  }
  set delta(value: DeltaInsert<MyoxusTextAttributes>) {
    this.currentDelta.value = value;
  }
  get selected() {
    return this.currentSelection.value;
  }
  set selected(value: boolean) {
    this.currentSelection.value = value;
  }

  private _targetIdentity: string | undefined;
  private _targetScope: ReturnType<
    NonNullable<DocEmbedProvider["inWorkspace"]>
  >;
  private _targetReference:
    ReturnType<NonNullable<DocEmbedProvider["openReference"]>> | undefined;
  private get targetContext() {
    const { pageId, workspaceId } = this.referenceInfo;
    const provider = this.std.getOptional(DocEmbedProvider);
    const workspace = workspaceId ?? this.std.workspace.id;
    const identity = JSON.stringify([workspace, pageId]);
    if (identity !== this._targetIdentity) {
      this._targetReference?.dispose();
      this._targetScope?.dispose();
      this._targetIdentity = identity;
      this._targetReference = provider?.openReference?.(workspace, pageId);
      this._targetScope = this._targetReference
        ? undefined
        : provider?.inWorkspace?.(workspace);
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

  get refMeta(): DocMeta | undefined {
    const context = this.targetContext;
    if (
      !context ||
      (context.access && context.access.readable(context.docId).value !== true)
    )
      return;
    return context.collection.meta.docMetas.find(
      (doc) => doc.id === context.docId,
    );
  }

  get _icon() {
    const { pageId, params } = this.resolvedReferenceInfo;
    const context = this.targetContext;
    if (
      !context ||
      (context.access && context.access.readable(pageId).value !== true)
    )
      return null;
    if (context.collection.id !== this.std.workspace.id)
      return createReferenceIcon(this.ownerDocument, "LinkIcon");
    return createReferenceIcon(
      this.ownerDocument,
      this.std.get(DocDisplayMetaProvider).referenceIcon(pageId, params),
    );
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

  connectedCallback() {
    this.disposables = new DisposableGroup();
    if (!this.config || !this.std) return;
    if (this.delta.insert !== REFERENCE_NODE) {
      console.error(
        `Reference node must be initialized with '${REFERENCE_NODE}', but got '${this.delta.insert}'`,
      );
    }
    const doc = this.ownerDocument;
    installEditorStyles(this, styles);
    const label = doc.createElement("span");
    label.className = "myoxus-reference";
    const content = doc.createElement("span");
    const marker = doc.createElement("v-text");
    marker.str = ZERO_WIDTH_FOR_EMBED_NODE;
    label.append(content, marker);
    this.replaceChildren(label);
    const open = (event: MouseEvent) => this.open({ event });
    this.disposables.addFromEvent(label, "click", open);
    this.disposables.addFromEvent(label, "auxclick", open);
    this._whenHover.setReference(this);
    const refresh = () => this.revision.value++;
    this.disposables.add(
      this.doc.workspace.slots.docListUpdated.subscribe(refresh),
    );
    this.disposables.add(
      effect(() => {
        label.dataset.selected = String(this.selected);
      }),
    );
    this.disposables.add(
      effect(() => {
        const attrs = this.delta.attributes;
        const type = attrs?.reference?.type;
        label.hidden = !type;
        if (!attrs || !type) return undefined;
        const mount = this.customContent;
        if (!mount) void this.revision.value;
        const deleted = !mount && !this.refMeta;
        const styles = myoxusTextStyles(
          attrs,
          deleted
            ? {
                color: "var(--myoxus-text-disable-color)",
                "text-decoration": "line-through",
                fill: "var(--myoxus-text-disable-color)",
              }
            : {},
        );
        label.removeAttribute("style");
        for (const [key, value] of Object.entries(styles)) {
          if (value != null) label.style.setProperty(key, String(value));
        }
        if (mount) return mount(content, this);

        const title = this._title;
        const icon =
          type === "Subpage"
            ? createReferenceIcon(doc, "LinkIcon")
            : this._icon;
        const name = doc.createElement("span");
        name.className = "myoxus-reference-title";
        if (title !== undefined) name.dataset.title = title;
        name.textContent = title ?? "";
        content.replaceChildren(...(icon ? [icon, name] : [name]));
        return undefined;
      }),
    );
  }

  disconnectedCallback() {
    this.disposables.dispose();
    this._targetReference?.dispose();
    this._targetScope?.dispose();
    this._targetIdentity = undefined;
    const message = this.std?.getOptional(ToolbarRegistryIdentifier)?.message$;
    if (message?.value?.element === this) message.value = null;
    this._whenHover.dispose();
  }

  referenceToNode() {
    return referenceToNode(this.referenceInfo);
  }
}
