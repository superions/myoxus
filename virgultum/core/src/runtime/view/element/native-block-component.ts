// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, effect, signal, untracked } from "@preact/signals-core";
import { DisposableGroup } from "../../../primitives/disposable/index.js";
import type { BlockModel, BlockViewType, Store } from "../../../store/index.js";
import type { EventName, UIEventHandler } from "../../event/index.js";
import type { BlockService } from "../../extension/service.js";
import { BlockServiceIdentifier } from "../../identifier.js";
import type { BlockStdScope } from "../../scope/std-scope.js";
import { BlockSelection } from "../../selection/block.js";
import type { BlockComponent } from "./block-component.js";
import { blockComponentSymbol, NativeViewElement } from "./consts.js";
import {
  type EditorHost,
  blockVersionWarning,
  resolveBlockView,
  createRetainedBlockView,
  createRetainedWidgetViews,
  findEditorHost,
} from "./document-host.js";

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
      const view = resolveBlockView(this.host.std, model);
      const viewType = view?.viewType;
      let entry = this.views.get(model.id);
      if (
        entry &&
        (entry.model !== model ||
          entry.viewType !== viewType ||
          entry.element.localName !== view?.tag)
      ) {
        entry.element.remove();
        this.views.delete(model.id);
        entry = undefined;
      }
      if (!entry && view && viewType) {
        const element = createRetainedBlockView(this.host, model, view);
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
    const owner = findEditorHost(this);
    if (!owner) return false;
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

const installedStyles = new WeakMap<Node, Set<string>>();

/** Light-DOM editor views share their stylesheet within each rendering root. */
export function installEditorStyles(element: HTMLElement, css: string) {
  const root = element.getRootNode();
  const styleRoot =
    root instanceof ShadowRoot ? root : element.ownerDocument.head;
  const installed = installedStyles.get(styleRoot) ?? new Set<string>();
  if (css && !installed.has(css)) {
    const style = element.ownerDocument.createElement("style");
    style.textContent = css;
    styleRoot.append(style);
    installed.add(css);
    installedStyles.set(styleRoot, installed);
  }
}

/** A container projects registered children in document order. Bypassed
 * containers keep their children without mounting editing chrome. */
export abstract class NativeContainerBlock<
  Model extends BlockModel,
> extends NativeBlockComponent<Model> {
  protected abstract readonly blockStyles: string;
  protected abstract mountBody(): HTMLElement;
  protected projectedModels(): readonly BlockModel[] {
    return this.model.children;
  }
  protected afterProjection(_body: HTMLElement) {}
  private readonly revision = signal(0);

  connectedCallback() {
    if (!this.connectBlock()) return;
    installEditorStyles(this, this.blockStyles);
    if (this.viewType === "hidden") return;
    const display = this.viewType === "display";
    if (display && this.isVersionMismatch) {
      this.replaceChildren(blockVersionWarning(this.ownerDocument, this.model));
      return;
    }
    const body = display ? this.mountBody() : this;
    const children = new NativeBlockProjection(this.host);
    this.disposables.add(
      effect(() => {
        void this.revision.value;
        const models = display ? this.projectedModels() : this.model.children;
        untracked(() => children.sync(models, body));
      }),
    );
    this.disposables.add(() => children.dispose());
    if (display) this.afterProjection(body);
  }

  override requestUpdate() {
    this.revision.value++;
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.replaceChildren();
  }
}
