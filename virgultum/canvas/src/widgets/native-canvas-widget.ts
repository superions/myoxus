// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { BlockComponent } from "@virgultum/core/runtime";

/** Coalesce Canvas geometry notifications without replacing the widget's anchors. */
export abstract class NativeCanvasWidget extends HTMLElement {
  protected block!: BlockComponent;
  protected disposables = new DisposableGroup();
  private pending = false;

  get std() {
    return this.block.std;
  }

  get store() {
    return this.std.store;
  }

  get host() {
    return this.std.host;
  }

  protected findBlock() {
    return this.closest<BlockComponent>("myoxus-edgeless-root");
  }

  connectedCallback() {
    const block = this.findBlock();
    if (!block) throw new Error("Canvas widget requires an edgeless root");
    this.block = block;
    this.disposables = new DisposableGroup();
    this.requestUpdate();
  }

  disconnectedCallback() {
    this.disposables.dispose();
    this.pending = false;
    this.replaceChildren();
  }

  requestUpdate() {
    if (this.pending || !this.isConnected) return;
    this.pending = true;
    const lifetime = this.disposables;
    queueMicrotask(() => {
      if (this.disposables !== lifetime || !this.isConnected) return;
      this.pending = false;
      this.paint();
    });
  }

  protected abstract paint(): void;
}
