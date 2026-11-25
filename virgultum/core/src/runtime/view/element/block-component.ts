import type { ReadonlySignal } from "@preact/signals-core";
import type { DisposableGroup } from "../../../primitives/disposable/index";
import type { BlockModel, BlockViewType, Store } from "../../../store/index";
import type { EventName, UIEventHandler } from "../../event/index.js";
import type { BlockService } from "../../extension/index.js";
import type { BlockStdScope } from "../../scope/index.js";
import type { EditorWidgetView } from "../view-store.js";
import type { blockComponentSymbol } from "./consts.js";
import type { EditorHost } from "./document-host.js";

/** Runtime contract shared by native block views. */
export interface BlockComponent<
  Model extends BlockModel = BlockModel,
  Service extends BlockService = BlockService,
  WidgetName extends string = string,
> extends HTMLElement {
  [blockComponentSymbol]: boolean;
  std: BlockStdScope;
  store: Store;
  readonly model: Model;
  readonly service: Service;
  readonly blockId: string;
  readonly flavour: string;
  readonly host: EditorHost;
  readonly selection: EditorHost["selection"];
  readonly disposables: DisposableGroup;
  readonly selected$: ReadonlySignal<boolean>;
  readonly parentComponent: BlockComponent | null;
  readonly rootComponent: BlockComponent | null;
  readonly topContenteditableElement: BlockComponent | null;
  readonly childBlocks: BlockComponent[];
  readonly isVersionMismatch: boolean;
  readonly widgetComponents: Partial<Record<WidgetName, EditorWidgetView>>;
  readonly updateComplete: Promise<boolean>;
  viewType: BlockViewType;

  requestUpdate(): void;
  handleEvent(
    name: EventName,
    handler: UIEventHandler,
    options?: { global?: boolean; flavour?: boolean },
  ): void;
  bindHotKey(
    keymap: Record<string, UIEventHandler>,
    options?: { global?: boolean; flavour?: boolean },
  ): () => void;
}
