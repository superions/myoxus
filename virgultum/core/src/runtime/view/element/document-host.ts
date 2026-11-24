import { DisposableGroup } from "../../../primitives/disposable/index.js";
import {
  ErrorCode,
  VirgultumError,
} from "../../../primitives/exceptions/index";
import {
  type BlockModel,
  type Store,
  type StoreSelectionExtension,
} from "../../../store/index";
import type { CommandManager } from "../../command/index.js";
import type { UIEventDispatcher } from "../../event/index.js";
import { WidgetViewIdentifier } from "../../identifier.js";
import type { RangeManager } from "../../inline/index.js";
import type { BlockViewType } from "../../spec/type.js";
import type { BlockStdScope } from "../../scope/std-scope.js";
import type { ViewStore } from "../view-store.js";
import { BLOCK_ID_ATTR, WIDGET_ID_ATTR, NativeViewElement } from "./consts.js";

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
  rebuildViews(): void;
}

export const editorHostSelector = "editor-host, [data-myoxus-canvas-host]";

export function isEditorHost(target: unknown): target is EditorHost {
  return target instanceof HTMLElement && target.matches(editorHostSelector);
}

/** Nested editor previews own their blocks, including blocks inside a tool's shadow root. */
export function findEditorHost(element: Element): EditorHost | null {
  const host = element.closest(editorHostSelector);
  if (isEditorHost(host)) return host;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? findEditorHost(root.host) : null;
}

function blockViewTag(view: BlockViewType, model: BlockModel) {
  return typeof view === "function" ? view(model) : view;
}

export function resolveBlockView(std: BlockStdScope, model: BlockModel) {
  const block = std.store.getBlock(model.id);
  if (!block || block.blockViewType === "hidden") return;
  const view = std.getView(model.flavour);
  if (!std.store.schema.flavourSchemaMap.has(model.flavour) || !view) {
    console.warn(`Cannot find render flavour ${model.flavour}.`);
    return;
  }

  return { tag: blockViewTag(view, model), viewType: block.blockViewType };
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
    const element = root.ownerDocument.createElement(tag);
    Object.assign(element, { editorWidgetContext: { std, model } });
    element.setAttribute(WIDGET_ID_ATTR, id);
    widgets.set(id, element);
  }
  return widgets;
}

export function createRetainedBlockView(
  host: EditorHost,
  model: BlockModel,
  view = resolveBlockView(host.std, model),
) {
  if (!view) return null;
  const { tag, viewType } = view;
  const element = host.ownerDocument.createElement(tag);
  element.setAttribute(BLOCK_ID_ATTR, model.id);
  return Object.assign(element, { viewType });
}

export function blockVersionWarning(doc: Document, model: BlockModel) {
  const warning = doc.createElement("dl");
  warning.className = "version-mismatch-warning";
  warning.contentEditable = "false";
  const term = doc.createElement("dt");
  const heading = doc.createElement("h4");
  heading.textContent = "Block Version Mismatched";
  term.append(heading);
  const description = doc.createElement("dd");
  const variable = (value: string | number) => {
    const element = doc.createElement("var");
    element.textContent = String(value);
    return element;
  };
  const reason = doc.createElement("p");
  reason.append(
    "We can not render this ",
    variable(model.flavour),
    " block because the version is mismatched.",
  );
  const editor = doc.createElement("p"),
    data = doc.createElement("p");
  editor.append(
    "Editor version: ",
    variable(
      model.store.schema.flavourSchemaMap.get(model.flavour)?.version ?? -1,
    ),
  );
  data.append("Data version: ", variable(model.version));
  description.append(reason, editor, data);
  warning.append(term, description);
  return warning;
}

export async function waitForRetainedRootView(
  host: EditorHost,
  root: HTMLElement | null,
) {
  if (root && "updateComplete" in root) await root.updateComplete;
  const model = host.store.root;
  if (!model || !host.isConnected) return false;
  const block = host.view.getBlock(model.id);
  await Promise.all(
    Object.values(block?.widgetComponents ?? {}).map((view) =>
      view && "updateComplete" in view ? view.updateComplete : undefined,
    ),
  );
  return host.isConnected;
}

const styledRoots = new WeakSet<Document | ShadowRoot>();

/** The shell owns one registered root. Descendant blocks own their own updates. */
export class DocumentEditorHost
  extends NativeViewElement
  implements EditorHost
{
  std!: BlockStdScope;
  get store() {
    return this.std.store;
  }
  get command() {
    return this.std.command;
  }
  get event() {
    return this.std.event;
  }
  get range() {
    return this.std.range;
  }
  get selection() {
    return this.std.selection;
  }
  get view() {
    return this.std.view;
  }

  disposables = new DisposableGroup();
  private projected: BlockModel | null = null;
  private pending?: Promise<void>;

  connectedCallback() {
    if (!this.store.root) {
      throw new VirgultumError(
        ErrorCode.NoRootModelError,
        "This doc is missing root block. Please initialize the default block structure before connecting the editor to DOM.",
      );
    }
    const root = this.getRootNode() as Document | ShadowRoot;
    if (!styledRoots.has(root)) {
      const style = this.ownerDocument.createElement("style");
      style.textContent =
        "editor-host { outline: none; isolation: isolate; display: block; height: 100%; }";
      ("head" in root ? root.head : root).append(style);
      styledRoots.add(root);
    }
    if (this.disposables.disposed) this.disposables = new DisposableGroup();
    this.tabIndex = 0;
    this.std.mount();
    this.disposables.add(
      this.store.slots.rootAdded.subscribe(this.scheduleRoot),
    );
    this.disposables.add(
      this.store.slots.rootDeleted.subscribe(this.scheduleRoot),
    );
    this.scheduleRoot();
  }

  disconnectedCallback() {
    this.disposables.dispose();
    this.std.unmount();
  }

  // Root replacement can remove and restore the same ID in one transaction.
  // Project the final model after the Store has finished both notifications.
  private scheduleRoot = () => {
    this.pending ??= Promise.resolve().then(() => {
      this.pending = undefined;
      if (!this.isConnected) return;
      const model = this.store.root;
      if (model === this.projected && this.firstElementChild) return;
      const view = model && createRetainedBlockView(this, model);
      this.projected = model;
      if (view) this.replaceChildren(view);
      else this.replaceChildren();
    });
  };

  rebuildViews() {
    this.projected = null;
    this.scheduleRoot();
  }

  get updateComplete(): Promise<boolean> {
    return Promise.resolve(this.pending).then(() =>
      waitForRetainedRootView(
        this,
        this.firstElementChild as HTMLElement | null,
      ),
    );
  }
}

export const EditorHost = DocumentEditorHost;

declare global {
  interface HTMLElementTagNameMap {
    "editor-host": DocumentEditorHost;
  }
}
