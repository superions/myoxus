// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  type BlockComponent,
  type BlockService,
  type BlockStdScope,
  type EditorHost,
  type EventName,
  type UIEventHandler,
  BlockSelection,
  BlockServiceIdentifier,
  bindRetainedWidgetContexts,
  blockComponentSymbol,
  createRetainedBlockView,
  createRetainedWidgetViews,
  editorHostSelector,
  isEditorHost,
  NativeViewElement,
} from "@virgultum/core/runtime";
import type { BlockModel, BlockViewType, Store } from "@virgultum/core/store";

type ChildView = {
  model: BlockModel;
  element: HTMLElement;
  viewType: BlockViewType;
};

/** Bind a DOM node to the exact materialized child model, including after restore. */
export class NativeBlockProjection {
  private readonly views = new Map<string, ChildView>();

  constructor(private readonly host: EditorHost) {}

  get nodes() {
    return [...this.views.values()].map(({ element }) => element);
  }

  dispose() {
    for (const { element } of this.views.values()) element.remove();
    this.views.clear();
  }

  /** Keep each child element tied to its materialized model across ordering changes. */
  sync(models: readonly BlockModel[], container: HTMLElement) {
    const remaining = new Set(this.views.keys());
    const ordered: HTMLElement[] = [];
    for (const model of models) {
      const viewType = this.host.store.getBlock(model.id)?.blockViewType;
      let entry = this.views.get(model.id);
      if (entry && (entry.model !== model || entry.viewType !== viewType)) {
        entry.element.remove();
        this.views.delete(model.id);
        entry = undefined;
      }
      if (!entry && viewType) {
        const element = createRetainedBlockView(this.host, model);
        if (element) {
          entry = { model, element, viewType };
          this.views.set(model.id, entry);
        }
      }
      if (entry) {
        ordered.push(entry.element);
        remaining.delete(model.id);
      }
    }
    for (const id of remaining) {
      this.views.get(id)?.element.remove();
      this.views.delete(id);
    }
    ordered.forEach((element, index) => {
      const current = container.children.item(index);
      if (element !== current) container.insertBefore(element, current);
    });
  }
}

export abstract class NativeBlockComponent<
  Model extends BlockModel,
  Service extends BlockService = BlockService,
>
  extends NativeViewElement
  implements BlockComponent<Model, Service>
{
  [blockComponentSymbol] = true;
  std!: BlockStdScope;
  store!: Store;
  model!: Model;
  host!: EditorHost;
  service!: Service;
  viewType: BlockViewType = "display";
  disposables = new DisposableGroup();
  private contextsBound = false;
  private retainedWidgets = new Map<string, HTMLElement>();

  get blockId() {
    return this.model.id;
  }
  get flavour() {
    return this.model.flavour;
  }
  get selection() {
    return this.std.selection;
  }
  get parentComponent() {
    const parent = this.model.parent;
    return parent ? this.std.view.getBlock(parent.id) : null;
  }
  get rootComponent() {
    const root = this.store.root;
    return root ? this.std.view.getBlock(root.id) : null;
  }
  get topContenteditableElement() {
    return this.rootComponent;
  }
  get childBlocks() {
    return this.model.children
      .map((model) => this.std.view.getBlock(model.id))
      .filter((view): view is BlockComponent => view !== null);
  }
  get widgetComponents() {
    return Object.fromEntries(
      [...this.retainedWidgets.keys()].map((id) => [
        id,
        this.std.view.getWidget(id, this.blockId) ?? undefined,
      ]),
    );
  }
  get isVersionMismatch() {
    return (
      this.store.schema.flavourSchemaMap.get(this.flavour)?.version !==
      this.model.version
    );
  }
  get renderChildren() {
    return this.host.renderChildren;
  }
  readonly selected$ = computed(
    () =>
      this.std?.selection.value.some(
        (item) => item.blockId === this.model.id && item.is(BlockSelection),
      ) ?? false,
  );
  get updateComplete() {
    return this.waitForViews(this.childBlocks);
  }

  protected waitForViews(views: HTMLElement[]) {
    return Promise.all(
      [...views, ...this.retainedWidgets.values()].map((element) =>
        "updateComplete" in element ? element.updateComplete : undefined,
      ),
    ).then(() => this.isConnected);
  }

  protected connectBlock() {
    const owner = this.closest(editorHostSelector);
    if (!isEditorHost(owner)) return false;
    const model = owner.store.getModelById<Model>(this.dataset.blockId!);
    if (!model) return false;
    this.std = owner.std;
    this.store = owner.store;
    this.host = owner;
    this.model = model;
    this.service = this.std.getOptional(
      BlockServiceIdentifier(this.flavour),
    ) as Service;
    this.disposables = new DisposableGroup();
    if (!this.contextsBound) {
      bindRetainedWidgetContexts(this, model, this.service);
      this.contextsBound = true;
    }
    this.std.view.setBlock(this);
    return true;
  }

  disconnectedCallback() {
    this.disposables.dispose();
    if (this.std?.view.getBlock(this.model.id) === this)
      this.std.view.deleteBlock(this);
    this.retainedWidgets.clear();
  }

  protected mountBlockWidgets(anchor: HTMLElement) {
    this.retainedWidgets = createRetainedWidgetViews(
      this,
      this.std,
      this.model,
    );
    anchor.append(...this.retainedWidgets.values());
  }

  abstract requestUpdate(): void;

  handleEvent(
    name: EventName,
    handler: UIEventHandler,
    options?: { global?: boolean; flavour?: boolean },
  ) {
    this.disposables.add(
      this.std.event.add(name, handler, this.eventScope(options)),
    );
  }

  bindHotKey(
    keymap: Record<string, UIEventHandler>,
    options?: { global?: boolean; flavour?: boolean },
  ) {
    const dispose = this.std.event.bindHotkey(keymap, this.eventScope(options));
    this.disposables.add(dispose);
    return dispose;
  }

  private eventScope(options?: { global?: boolean; flavour?: boolean }) {
    return {
      flavour: !options?.global && options?.flavour ? this.flavour : undefined,
      blockId: options?.global || options?.flavour ? undefined : this.blockId,
    };
  }
}
