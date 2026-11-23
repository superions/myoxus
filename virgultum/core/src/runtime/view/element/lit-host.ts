import { ContextProvider, createContext, provide } from "@lit/context";
import type { DisposableGroup } from "../../../primitives/disposable/index.js";
import {
  ErrorCode,
  handleError,
  VirgultumError,
} from "../../../primitives/exceptions/index";
import { SignalWatcher, WithDisposable } from "../../../primitives/lit/index";
import {
  type BlockModel,
  Store,
  type StoreSelectionExtension,
} from "../../../store/index";
import { css, LitElement, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { keyed } from "lit/directives/keyed.js";
import { html, unsafeStatic } from "lit/static-html.js";

import type { CommandManager } from "../../command/index.js";
import type { UIEventDispatcher } from "../../event/index.js";
import type { BlockService } from "../../extension/index.js";
import { WidgetViewIdentifier } from "../../identifier.js";
import type { RangeManager } from "../../inline/index.js";
import type { BlockViewType } from "../../spec/type.js";
import type { BlockStdScope } from "../../scope/std-scope.js";
import { PropTypes, requiredProperties } from "../decorators/index.js";
import type { ViewStore } from "../view-store.js";
import {
  BLOCK_ID_ATTR,
  modelContext,
  serviceContext,
  WIDGET_ID_ATTR,
} from "./consts.js";
import { ShadowlessElement } from "./shadowless-element.js";

export const storeContext = createContext<Store>("store");
export const stdContext = createContext<BlockStdScope>("std");

function isMatchFlavour(widgetFlavour: string, block: BlockModel) {
  if (widgetFlavour.endsWith("/*")) {
    const path = widgetFlavour.slice(0, -2).split("/");
    let current: BlockModel | null = block.parent;
    for (let i = path.length - 1; i >= 0; i--) {
      if (!current || current.flavour !== path[i]) {
        return false;
      }
      current = current.parent;
    }
    return true;
  }
  return block.flavour === widgetFlavour;
}

export interface EditorHost extends HTMLElement {
  std: BlockStdScope;
  store: Store;
  readonly command: CommandManager;
  readonly event: UIEventDispatcher;
  readonly range: RangeManager;
  readonly selection: StoreSelectionExtension;
  readonly view: ViewStore;
  readonly disposables: DisposableGroup;
  readonly updateComplete: Promise<boolean>;
  renderChildren(
    model: BlockModel,
    filter?: (model: BlockModel) => boolean,
  ): TemplateResult;
  rebuildViews(): void;
}

export const editorHostSelector = "editor-host, [data-myoxus-canvas-host]";

export function isEditorHost(target: unknown): target is EditorHost {
  return target instanceof HTMLElement && target.matches(editorHostSelector);
}

function blockViewTag(view: BlockViewType, model: BlockModel) {
  const tag = typeof view === "function" ? view(model) : view;
  return typeof tag === "string" ? tag : tag._$litStatic$;
}

function resolveBlockView(std: BlockStdScope, model: BlockModel) {
  const block = std.store.getBlock(model.id);
  if (!block || block.blockViewType === "hidden") return;
  const view = std.getView(model.flavour);
  if (!std.store.schema.flavourSchemaMap.has(model.flavour) || !view) {
    console.warn(`Cannot find render flavour ${model.flavour}.`);
    return;
  }

  const widgets: Record<string, TemplateResult> = {};
  for (const [key, tag] of std.provider
    .getAll(WidgetViewIdentifier)
    .entries()) {
    const [widgetFlavour, id] = key.split("|");
    if (isMatchFlavour(widgetFlavour, model))
      widgets[id] =
        html`<${tag} ${unsafeStatic(WIDGET_ID_ATTR)}=${id}></${tag}>`;
  }
  return {
    tag: blockViewTag(view, model),
    viewType: block.blockViewType,
    widgets,
  };
}

function renderBlockView(
  std: BlockStdScope,
  model: BlockModel,
): TemplateResult {
  const view = resolveBlockView(std, model);
  if (!view) return html`${nothing}`;
  const { viewType, widgets } = view;
  const tag = unsafeStatic(view.tag);
  // A restored block can retain its ID while acquiring a new model.
  return html`${keyed(
    model,
    html`<${tag}
      ${unsafeStatic(BLOCK_ID_ATTR)}=${model.id}
      .widgets=${widgets}
      .viewType=${viewType}
    ></${tag}>`,
  )}`;
}

export function renderRetainedChildren(
  std: BlockStdScope,
  model: BlockModel,
  filter?: (model: BlockModel) => boolean,
): TemplateResult {
  return html`${repeat(
    filter ? model.children.filter(filter) : model.children,
    (child) => child.id,
    (child) => renderBlockView(std, child),
  )}`;
}

/** Bridge the retained block views until their owning feature mounts them directly. */
export function bindRetainedBlockContexts(host: EditorHost) {
  const store = new ContextProvider(host, {
    context: storeContext,
    initialValue: host.store,
  });
  const std = new ContextProvider(host, {
    context: stdContext,
    initialValue: host.std,
  });
  store.hostConnected();
  std.hostConnected();
}

/** Existing widgets consume the owning block context even in a native projection. */
export function bindRetainedWidgetContexts(
  element: HTMLElement,
  model: BlockModel,
  service?: BlockService,
) {
  new ContextProvider(element, {
    context: modelContext,
    initialValue: model,
  }).hostConnected();
  if (service) {
    new ContextProvider(element, {
      context: serviceContext,
      initialValue: service,
    }).hostConnected();
  }
}

export function createRetainedWidgetViews(
  root: HTMLElement,
  std: BlockStdScope,
  model: BlockModel,
) {
  const widgets = new Map<string, HTMLElement>();
  for (const [key, tag] of std.provider
    .getAll(WidgetViewIdentifier)
    .entries()) {
    const [flavour, id] = key.split("|");
    if (!isMatchFlavour(flavour, model)) continue;
    const element = root.ownerDocument.createElement(tag._$litStatic$);
    element.setAttribute(WIDGET_ID_ATTR, id);
    widgets.set(id, element);
  }
  return widgets;
}

export function createRetainedBlockView(host: EditorHost, model: BlockModel) {
  const view = resolveBlockView(host.std, model);
  if (!view) return null;
  const { tag, viewType, widgets } = view;
  const element = host.ownerDocument.createElement(tag);
  element.setAttribute(BLOCK_ID_ATTR, model.id);
  return Object.assign(element, { widgets, viewType });
}

export async function waitForRetainedRootView(
  host: EditorHost,
  root: HTMLElement | null,
) {
  if (root && "updateComplete" in root) await root.updateComplete;
  const model = host.store.root;
  if (!model || !host.isConnected) return false;
  const widgetViews = host.std.provider.getAll(
    WidgetViewIdentifier(model.flavour),
  );
  await Promise.all(
    Object.entries(widgetViews).map(([key, tag]) => {
      if (key.split("|")[0] !== model.flavour) return undefined;
      const element = host.querySelector(tag._$litStatic$);
      return element instanceof LitElement ? element.updateComplete : undefined;
    }),
  );
  return host.isConnected;
}

@requiredProperties({
  store: PropTypes.instanceOf(Store),
  std: PropTypes.object,
})
export class LitEditorHost
  extends SignalWatcher(WithDisposable(ShadowlessElement))
  implements EditorHost
{
  static override styles = css`
    editor-host {
      outline: none;
      isolation: isolate;
      display: block;
      height: 100%;
    }
  `;

  renderChildren = (
    model: BlockModel,
    filter?: (model: BlockModel) => boolean,
  ) => renderRetainedChildren(this.std, model, filter);

  rebuildViews() {
    const root = this.renderRoot;
    root.replaceChildren();
    // Cross-block IME can replace the browser-managed DOM. Discard Lit's
    // cached child part before scheduling the fresh projection.
    delete (root as HTMLElement & { _$litPart$?: unknown })._$litPart$;
    this.requestUpdate();
  }

  get command(): CommandManager {
    return this.std.command;
  }

  get event(): UIEventDispatcher {
    return this.std.event;
  }

  get range(): RangeManager {
    return this.std.range;
  }

  get selection(): StoreSelectionExtension {
    return this.std.selection;
  }

  get view(): ViewStore {
    return this.std.view;
  }

  override connectedCallback() {
    super.connectedCallback();

    if (!this.store.root) {
      throw new VirgultumError(
        ErrorCode.NoRootModelError,
        "This doc is missing root block. Please initialize the default block structure before connecting the editor to DOM.",
      );
    }

    this.std.mount();
    this.tabIndex = 0;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.std.unmount();
  }

  override async getUpdateComplete(): Promise<boolean> {
    try {
      const result = await super.getUpdateComplete();
      const rootModel = this.store.root;
      if (!rootModel) return result;

      const view = this.std.getView(rootModel.flavour);
      if (!view) return result;

      const tag = blockViewTag(view, rootModel);
      const root = this.renderRoot.querySelector<HTMLElement>(tag);
      await waitForRetainedRootView(this, root);
      return result;
    } catch (e) {
      if (e instanceof Error) {
        handleError(e);
      } else {
        console.error(e);
      }
      return true;
    }
  }

  override render() {
    const { root } = this.store;
    if (!root) return nothing;

    return renderBlockView(this.std, root);
  }

  @provide({ context: storeContext })
  @property({ attribute: false })
  accessor store!: Store;

  @provide({ context: stdContext })
  @property({ attribute: false })
  accessor std!: BlockStdScope;
}

export const EditorHost = LitEditorHost;

declare global {
  interface HTMLElementTagNameMap {
    "editor-host": LitEditorHost;
  }
}
