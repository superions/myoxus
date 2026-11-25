import { DisposableGroup } from "../../primitives/disposable/index.js";
import { NativeViewElement } from "../../primitives/env/index.js";
import type { ExtensionType, Store } from "../../store/index";

import { BlockStdScope } from "../scope/index.js";

export class TestEditorContainer extends NativeViewElement {
  disposables = new DisposableGroup();
  private _std!: BlockStdScope;

  doc!: Store;
  specs: ExtensionType[] = [];

  get std() {
    return this._std;
  }

  get updateComplete() {
    return Promise.resolve();
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    this._std = new BlockStdScope({
      store: this.doc,
      extensions: this.specs,
    });
    const wrapper = this.ownerDocument.createElement("div");
    wrapper.className = "test-editor-container";
    wrapper.append(this._std.render());
    this.replaceChildren(wrapper);
  }

  disconnectedCallback() {
    this.disposables.dispose();
    this.replaceChildren();
  }
}

if (!customElements.get("test-editor-container")) {
  customElements.define("test-editor-container", TestEditorContainer);
}
