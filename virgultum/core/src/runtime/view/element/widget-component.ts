import { SignalWatcher, WithDisposable } from "../../../primitives/lit/index";
import { BlockServiceIdentifier } from "../../identifier.js";
import type { BlockModel } from "../../../store/index";
import { LitElement } from "lit";

import type { EventName, UIEventHandler } from "../../event/index.js";
import type { BlockService } from "../../extension/index.js";
import type { BlockStdScope } from "../../scope/index.js";
import type { BlockComponent } from "./block-component.js";

export class WidgetComponent<
  Model extends BlockModel = BlockModel,
  B extends BlockComponent = BlockComponent,
  S extends BlockService = BlockService,
> extends SignalWatcher(WithDisposable(LitElement)) {
  editorWidgetContext!: { std: BlockStdScope; model: Model };

  handleEvent = (
    name: EventName,
    handler: UIEventHandler,
    options?: { global?: boolean },
  ) => {
    this._disposables.add(
      this.host.event.add(name, handler, {
        flavour: options?.global ? undefined : this.flavour,
      }),
    );
  };

  get block() {
    return this.std.view.getBlock(this.model.id) as B | null;
  }

  get store() {
    return this.std.store;
  }

  get flavour(): string {
    return this.model.flavour;
  }

  get host() {
    return this.std.host;
  }

  get model() {
    return this.editorWidgetContext.model;
  }

  get service() {
    return this.std.getOptional(BlockServiceIdentifier(this.flavour)) as S;
  }

  get std() {
    return this.editorWidgetContext.std;
  }

  get widgetId() {
    return this.dataset.widgetId as string;
  }

  bindHotKey(
    keymap: Record<string, UIEventHandler>,
    options?: { global: boolean },
  ) {
    this._disposables.add(
      this.host.event.bindHotkey(keymap, {
        flavour: options?.global ? undefined : this.flavour,
      }),
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    this.std.view.setWidget(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.std?.view.deleteWidget(this);
  }

  override render(): unknown {
    return null;
  }
}
