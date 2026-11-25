import { effect, signal, type Signal } from "@preact/signals-core";
import { EdgelessCRUDIdentifier } from "@virgultum/canvas-runtime/surface";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { FrameBlockModel } from "@virgultum/core/models";
import {
  type BlockComponent,
  NativeViewElement,
} from "@virgultum/core/runtime";
import { generateKeyBetweenV2 } from "@virgultum/core/runtime/gfx";
import {
  EditorChromeHostIdentifier,
  type EditorCanvasPopoverControls,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";

import { EdgelessFrameManagerIdentifier } from "../frame-manager.js";

export class EdgelessFrameOrderButton extends NativeViewElement {
  private _disposables = new DisposableGroup();
  private readonly _revision$ = signal(0);
  private _bound = false;
  private _edgeless!: BlockComponent;
  private _frames!: FrameBlockModel[];
  private _popperShow = false;
  private _setPopperShow: (show: boolean) => void = () => {};

  private _chrome?: {
    host: HTMLSpanElement;
    state$: Signal<EditorCanvasPopoverControls | null>;
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
      this._requestUpdate();
    }
  }

  get frames() {
    return this._frames;
  }

  set frames(value: FrameBlockModel[]) {
    this._frames = value;
    this._requestUpdate();
  }

  get popperShow() {
    return this._popperShow;
  }

  set popperShow(value: boolean) {
    if (this._popperShow === value) return;
    this._popperShow = value;
    this._requestUpdate();
  }

  get setPopperShow() {
    return this._setPopperShow;
  }

  set setPopperShow(value: (show: boolean) => void) {
    this._setPopperShow = value;
    this._requestUpdate();
  }

  private _requestUpdate() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private _moveFrame = (id: string, before: string | null) => {
    if (this.edgeless.store.readonly || id === before) return;
    const manager = this.edgeless.std.get(EdgelessFrameManagerIdentifier);
    const frames = manager.frames;
    const source = frames.findIndex((frame) => frame.id === id);
    const target =
      before === null
        ? frames.length
        : frames.findIndex((frame) => frame.id === before);
    if (source < 0 || target < 0 || target === source || target === source + 1)
      return;

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
    this._requestUpdate();
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
    if (!chrome?.mountCanvasPopover) return;
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    const { readonly } = this.edgeless.store;
    const label = resolveEditorMessage(
      editorMessage(
        "com.myoxus.editor.presentation.frame-order",
        "Frame order",
      ),
      i18n,
    );
    const manager = this.edgeless.std.get(EdgelessFrameManagerIdentifier);
    const controls: EditorCanvasPopoverControls = {
      opened: this.popperShow && !readonly,
      onClose: () => this.setPopperShow(false),
      position: "top",
      offset: 16,
      label,
      trigger: {
        action: {
          id: "presentation-frame-order",
          icon: "LayerIcon",
          label,
          disabled: readonly,
          run: () => {
            if (readonly) return;
            this.setPopperShow(!this.popperShow);
          },
        },
        expanded: this.popperShow,
      },
      content: {
        kind: "frame-order",
        controls: {
          items: manager.frames.map((frame) => ({
            id: frame.id,
            title: frame.props.title.toString(),
          })),
          embedded: false,
          readonly,
          move: this._moveFrame,
        },
      },
    };

    if (!this._chrome) {
      const host = this.ownerDocument.createElement("span");
      host.style.display = "contents";
      this.replaceChildren(host);
      const state$ = signal<EditorCanvasPopoverControls | null>(controls);
      const unmount = chrome.mountCanvasPopover(host, state$);
      this._chrome = { host, state$, unmount };
    } else {
      this._chrome.state$.value = controls;
    }
  }
}
