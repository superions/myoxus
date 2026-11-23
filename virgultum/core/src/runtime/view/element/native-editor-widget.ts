// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DisposableGroup } from "../../../primitives/disposable/index.js";
import type { BlockModel } from "../../../store/index.js";
import type { EventName, UIEventHandler } from "../../event/index.js";
import type { BlockStdScope } from "../../scope/index.js";

import { NativeViewElement } from "./consts.js";

/** The block view binds the owning Store and model before attaching a widget. */
export class NativeEditorWidget<
  Model extends BlockModel = BlockModel,
> extends NativeViewElement {
  editorWidgetContext!: { std: BlockStdScope; model: Model };
  disposables = new DisposableGroup();

  get model() {
    return this.editorWidgetContext.model;
  }

  get std() {
    return this.editorWidgetContext.std;
  }

  get host() {
    return this.std.host;
  }

  get block() {
    return this.std.view.getBlock(this.model.id);
  }

  handleEvent(name: EventName, handler: UIEventHandler) {
    const release = this.std.event.add(name, handler, {
      flavour: this.model.flavour,
    });
    this.disposables.add(release);
  }

  connectedCallback() {
    this.disposables = new DisposableGroup();
    this.std.view.setWidget(this);
  }

  disconnectedCallback() {
    this.disposables.dispose();
    this.std.view.deleteWidget(this);
  }
}
