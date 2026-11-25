import { effect, signal, type Signal } from "@preact/signals-core";
import { EdgelessCRUDIdentifier } from "@virgultum/canvas-runtime/surface";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  type BlockComponent,
  NativeViewElement,
} from "@virgultum/core/runtime";
import { generateKeyBetweenV2 } from "@virgultum/core/runtime/gfx";
import {
  EditorChromeHostIdentifier,
  type EditorFrameOrderControls,
} from "@virgultum/core/services";

import { EdgelessFrameManagerIdentifier } from "../frame-manager";

export class EdgelessFrameOrderMenu extends NativeViewElement {
  private _disposables = new DisposableGroup();
  private readonly _revision$ = signal(0);
  private _bound = false;
  private _edgeless!: BlockComponent;
  private _embed = false;
  private _chrome?: {
    host: HTMLSpanElement;
    state$: Signal<EditorFrameOrderControls | null>;
    unmount: () => void;
  };

  get edgeless() {
    return this._edgeless;
  }

  set edgeless(value: BlockComponent) {
    if (this._edgeless === value) return;
    this._edgeless = value;
    if (this.isConnected) {
      this._ensureBound();
      this.requestUpdate();
    }
  }

  get embed() {
    return this._embed;
  }

  set embed(value: boolean) {
    if (this._embed === value) return;
    this._embed = value;
    this.requestUpdate();
  }

  requestUpdate() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private get frameManager() {
    return this.edgeless.std.get(EdgelessFrameManagerIdentifier);
  }

  private readonly move = (id: string, before: string | null) => {
    if (this.edgeless.store.readonly || id === before) return;
    const manager = this.frameManager;
    const frames = manager.frames;
    const source = frames.findIndex((frame) => frame.id === id);
    const target =
      before === null
        ? frames.length
        : frames.findIndex((frame) => frame.id === before);
    if (source < 0 || target < 0 || target === source || target === source + 1)
      return;

    // Normalize old presentation indices using the same command as the original menu.
    manager.refreshLegacyFrameOrder();
    const neighbours = manager.frames.filter((frame) => frame.id !== id);
    const insertion =
      before === null
        ? neighbours.length
        : neighbours.findIndex((frame) => frame.id === before);
    this.edgeless.std.get(EdgelessCRUDIdentifier).updateElement(id, {
      presentationIndex: generateKeyBetweenV2(
        neighbours[insertion - 1]?.props.presentationIndex || null,
        neighbours[insertion]?.props.presentationIndex || null,
      ),
    });
    this.edgeless.store.captureSync();
    this.requestUpdate();
  };

  private _ensureBound() {
    if (this._bound || !this.isConnected || !this._edgeless) return;
    this._bound = true;
    if (this._disposables.disposed) {
      this._disposables = new DisposableGroup();
    }
    this._disposables.add(
      effect(() => {
        void this._revision$.value;
        if (!this.isConnected || !this._edgeless) return;
        this._paint();
      }),
    );
  }

  connectedCallback() {
    this._ensureBound();
  }

  disconnectedCallback() {
    if (this._chrome) {
      this._chrome.unmount();
      this._chrome.host.remove();
      this._chrome = undefined;
    }
    this._disposables.dispose();
    this._bound = false;
  }

  private _paint() {
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const controls: EditorFrameOrderControls = {
      items: this.frameManager.frames.map((frame) => ({
        id: frame.id,
        title: frame.props.title.toString(),
      })),
      embedded: this.embed,
      readonly: this.edgeless.store.readonly,
      move: this.move,
    };
    if (!this._chrome) {
      const host = this.ownerDocument.createElement("span");
      host.style.display = "contents";
      this.append(host);
      const state$ = signal<EditorFrameOrderControls | null>(controls);
      const unmount = chrome.mountFrameOrder(host, state$);
      this._chrome = { host, state$, unmount };
    } else {
      this._chrome.state$.value = controls;
    }
  }
}
