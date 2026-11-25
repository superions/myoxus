import { effect, signal, type Signal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { FrameBlockModel } from "@virgultum/core/models";
import { createButtonPopper } from "@virgultum/core/utils";
import {
  type BlockComponent,
  NativeViewElement,
} from "@virgultum/core/runtime";
import {
  EditorChromeHostIdentifier,
  type EditorCanvasToolControls,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";

import type { EdgelessFrameOrderMenu } from "./frame-order-menu.js";

const frameOrderButtonStyles = `
  edgeless-frame-order-button edgeless-frame-order-menu {
    display: none;
  }

  edgeless-frame-order-button edgeless-frame-order-menu[data-show] {
    display: initial;
  }
`;

export class EdgelessFrameOrderButton extends NativeViewElement {
  private _disposables = new DisposableGroup();
  private readonly _revision$ = signal(0);
  private _bound = false;
  private _domReady = false;
  private _edgeless!: BlockComponent;
  private _frames!: FrameBlockModel[];
  private _popperShow = false;
  private _setPopperShow: (show: boolean) => void = () => {};

  private _edgelessFrameOrderButton!: HTMLSpanElement;
  private _edgelessFrameOrderMenu!: EdgelessFrameOrderMenu;
  private _chrome?: {
    host: HTMLSpanElement;
    state$: Signal<EditorCanvasToolControls | null>;
    unmount: () => void;
  };

  private _edgelessFrameOrderPopper: ReturnType<
    typeof createButtonPopper
  > | null = null;

  get edgeless() {
    return this._edgeless;
  }

  set edgeless(value: BlockComponent) {
    if (this._edgeless === value) return;
    this._edgeless = value;
    if (this._edgelessFrameOrderMenu) {
      this._edgelessFrameOrderMenu.edgeless = value;
    }
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

  private _ensureDom() {
    if (this._domReady) return;
    this._domReady = true;
    const style = this.ownerDocument.createElement("style");
    style.textContent = frameOrderButtonStyles;
    this._edgelessFrameOrderButton = this.ownerDocument.createElement("span");
    this._edgelessFrameOrderButton.className = "edgeless-frame-order-button";
    this._edgelessFrameOrderMenu = this.ownerDocument.createElement(
      "edgeless-frame-order-menu",
    );
    if (this._edgeless) {
      this._edgelessFrameOrderMenu.edgeless = this._edgeless;
    }
    this.append(
      style,
      this._edgelessFrameOrderButton,
      this._edgelessFrameOrderMenu,
    );
  }

  private _ensureBound() {
    if (this._bound || !this.isConnected || !this._edgeless) return;
    this._bound = true;
    if (this._disposables.disposed) {
      this._disposables = new DisposableGroup();
    }
    this._ensureDom();
    this._edgelessFrameOrderMenu.edgeless = this._edgeless;
    this._edgelessFrameOrderPopper = createButtonPopper({
      reference: this._edgelessFrameOrderButton,
      popperElement: this._edgelessFrameOrderMenu,
      stateUpdated: ({ display }) => this.setPopperShow(display === "show"),
      mainAxis: 22,
    });
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
    this._edgelessFrameOrderPopper?.dispose();
    this._edgelessFrameOrderPopper = null;
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
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    const { readonly } = this.edgeless.store;
    const controls: EditorCanvasToolControls = {
      action: {
        id: "presentation-frame-order",
        icon: "LayerIcon",
        label: resolveEditorMessage(
          editorMessage(
            "com.myoxus.editor.presentation.frame-order",
            "Frame order",
          ),
          i18n,
        ),
        disabled: readonly,
        run: () => {
          if (readonly) return;
          this._edgelessFrameOrderPopper?.toggle();
        },
      },
      expanded: this.popperShow,
    };

    if (!this._chrome) {
      const host = this.ownerDocument.createElement("span");
      host.style.display = "contents";
      this._edgelessFrameOrderButton.append(host);
      const state$ = signal<EditorCanvasToolControls | null>(controls);
      const unmount = chrome.mountCanvasTool(host, state$);
      this._chrome = { host, state$, unmount };
    } else {
      this._chrome.state$.value = controls;
    }
  }
}
