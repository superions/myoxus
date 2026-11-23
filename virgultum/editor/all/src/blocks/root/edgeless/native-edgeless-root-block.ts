// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, effect, untracked } from "@preact/signals-core";
import type { SurfaceBlockModel } from "@virgultum/canvas-runtime/surface";
import type { RootBlockModel } from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  BlockSelection,
  BlockServiceIdentifier,
  blockComponentSymbol,
  bindRetainedWidgetContexts,
  createRetainedBlockView,
  createRetainedWidgetViews,
  editorHostSelector,
  isEditorHost,
  type BlockComponent,
  type BlockStdScope,
  type EditorHost,
  type EventName,
  type UIEventHandler,
} from "@virgultum/core/runtime";
import {
  type GfxViewportElement,
  GfxControllerIdentifier,
} from "@virgultum/core/runtime/gfx";
import {
  FontLoaderService,
  ViewportElementProvider,
} from "@virgultum/core/services";
import type { BlockModel, BlockViewType, Store } from "@virgultum/core/store";
import { hasTextControlEventTarget } from "@virgultum/core/utils";

import {
  canvasRootCss,
  EdgelessRootController,
} from "./edgeless-root-block.js";
import type { EdgelessRootService } from "./edgeless-root-service.js";

const styledRoots = new WeakSet<Node>();
type ChildView = {
  model: BlockModel;
  element: HTMLElement;
  viewType: BlockViewType;
};

export class EdgelessRootBlockComponent
  extends HTMLElement
  implements BlockComponent<RootBlockModel, EdgelessRootService>
{
  [blockComponentSymbol] = true;
  std!: BlockStdScope;
  store!: Store;
  model!: RootBlockModel;
  host!: EditorHost;
  service!: EdgelessRootService;
  viewType: BlockViewType = "display";
  disposables = new DisposableGroup();
  private controller?: EdgelessRootController;
  private readonly views = new Map<string, ChildView>();
  private readonly retainedWidgets = new Map<string, HTMLElement>();
  private contextsBound = false;

  backgroundElm!: HTMLDivElement;
  gfxViewportElm!: GfxViewportElement;
  overlayElm!: HTMLDivElement;
  mountElm!: HTMLDivElement;

  get selection() {
    return this.std.selection;
  }
  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }
  get surface() {
    return this.gfxViewportElm?.querySelector("myoxus-surface") ?? null;
  }
  get surfaceBlockModel() {
    return this.model.children.find(
      (child) => child.flavour === "myoxus:surface",
    ) as SurfaceBlockModel;
  }
  get viewportElement() {
    return this.std.get(ViewportElementProvider).viewportElement;
  }
  get fontLoader() {
    return this.std.get(FontLoaderService);
  }
  get keyboardManager() {
    return this.controller?.keyboardManager ?? null;
  }
  get blockId() {
    return this.model.id;
  }
  get flavour() {
    return this.model.flavour;
  }
  get parentComponent() {
    return null;
  }
  get rootComponent() {
    return this;
  }
  get topContenteditableElement() {
    return this;
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
    const views = [...this.views.values()].map(({ element }) => element);
    return Promise.all(
      [...views, ...this.retainedWidgets.values()].map((element) =>
        "updateComplete" in element ? element.updateComplete : undefined,
      ),
    ).then(() => this.isConnected);
  }

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
    const handlers = Object.fromEntries(
      Object.entries(keymap).map(([key, handler]) => [
        key,
        key.length === 1 && key >= "A" && key <= "z"
          ? (context: Parameters<UIEventHandler>[0]) => {
              if (!hasTextControlEventTarget(context.get("keyboardState").raw))
                handler(context);
            }
          : handler,
      ]),
    );
    const dispose = this.std.event.bindHotkey(
      handlers,
      this.eventScope(options),
    );
    this.disposables.add(dispose);
    return dispose;
  }

  private eventScope(options?: { global?: boolean; flavour?: boolean }) {
    return {
      flavour: !options?.global && options?.flavour ? this.flavour : undefined,
      blockId: options?.global || options?.flavour ? undefined : this.blockId,
    };
  }

  connectedCallback() {
    const owner = this.closest(editorHostSelector);
    if (!isEditorHost(owner)) return;
    const model = owner.store.getModelById<RootBlockModel>(
      this.dataset.blockId!,
    );
    if (!model) return;
    this.std = owner.std;
    this.store = owner.store;
    this.host = owner;
    this.model = model;
    this.service = this.std.get(
      BlockServiceIdentifier(this.flavour),
    ) as EdgelessRootService;
    this.disposables = new DisposableGroup();

    const root = this.getRootNode();
    const styleRoot =
      root instanceof ShadowRoot ? root : this.ownerDocument.head;
    if (!styledRoots.has(styleRoot)) {
      const style = this.ownerDocument.createElement("style");
      style.textContent = canvasRootCss;
      styleRoot.append(style);
      styledRoots.add(styleRoot);
    }

    if (!this.contextsBound) {
      bindRetainedWidgetContexts(this, model, this.service);
      this.contextsBound = true;
    }
    this.std.view.setBlock(this);

    if (this.viewType === "hidden") return;
    if (this.isVersionMismatch) {
      const warning = this.ownerDocument.createElement("dl");
      warning.className = "version-mismatch-warning";
      warning.contentEditable = "false";
      const title = this.ownerDocument.createElement("h4");
      title.textContent = "Block Version Mismatched";
      warning.append(title);
      this.replaceChildren(warning);
      return;
    }

    const showCanvas = this.viewType === "display";
    if (showCanvas) {
      this.backgroundElm = this.ownerDocument.createElement("div");
      this.backgroundElm.className = "edgeless-background edgeless-container";
      this.gfxViewportElm = this.ownerDocument.createElement(
        "gfx-viewport",
      ) as GfxViewportElement;
      this.gfxViewportElm.maxConcurrentRenders = 6;
      this.gfxViewportElm.gfx = this.gfx;
      this.backgroundElm.append(this.gfxViewportElm);
      this.mountElm = this.ownerDocument.createElement("div");
      this.mountElm.className = "edgeless-mount-point";
      this.overlayElm = this.ownerDocument.createElement("div");
      this.overlayElm.className = "widgets-container";

      this.controller = new EdgelessRootController(this);
      this.controller.connect();
      this.replaceChildren(this.backgroundElm, this.mountElm, this.overlayElm);
    }

    this.disposables.add(
      effect(() => {
        const children = showCanvas
          ? [...model.children, ...(this.surfaceBlockModel?.children ?? [])]
          : model.children;
        untracked(() =>
          this.syncChildren(children, showCanvas ? this.gfxViewportElm : this),
        );
      }),
    );
    if (showCanvas) {
      const widgets = createRetainedWidgetViews(this, this.std, model);
      for (const [key, element] of widgets)
        this.retainedWidgets.set(key, element);
      this.overlayElm.append(...this.retainedWidgets.values());
      this.controller?.mount();
    }
  }

  requestUpdate() {
    if (!this.isConnected || !this.gfxViewportElm) return;
    this.syncChildren(
      [...this.model.children, ...(this.surfaceBlockModel?.children ?? [])],
      this.gfxViewportElm,
    );
  }

  disconnectedCallback() {
    this.disposables.dispose();
    this.controller?.dispose();
    this.controller = undefined;
    if (this.std?.view.getBlock(this.model.id) === this)
      this.std.view.deleteBlock(this);
    this.views.clear();
    this.retainedWidgets.clear();
    this.replaceChildren();
  }

  /** Keep each child element tied to its materialized model across ordering changes. */
  private syncChildren(models: readonly BlockModel[], container: HTMLElement) {
    const remaining = new Set(this.views.keys());
    const ordered: HTMLElement[] = [];
    for (const model of models) {
      const viewType = this.store.getBlock(model.id)?.blockViewType;
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
