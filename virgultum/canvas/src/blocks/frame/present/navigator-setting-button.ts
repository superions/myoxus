import { effect, signal, type Signal } from "@preact/signals-core";
import {
  EdgelessCRUDIdentifier,
  EdgelessLegacySlotIdentifier,
} from "@virgultum/canvas-runtime/surface";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
  type EditorCanvasMenuControls,
  type EditorCanvasPopoverControls,
  type EditorFrameOrderControls,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import {
  type BlockComponent,
  NativeViewElement,
} from "@virgultum/core/runtime";
import { generateKeyBetweenV2 } from "@virgultum/core/runtime/gfx";

import { EdgelessFrameManagerIdentifier } from "../frame-manager.js";

export class EdgelessNavigatorSettingButton extends NativeViewElement {
  private _disposables = new DisposableGroup();
  private readonly _revision$ = signal(0);
  private _bound = false;
  private _blackBackground = false;
  private _edgeless!: BlockComponent;
  private _hideToolbar = false;
  private _includeFrameOrder = false;
  private _onHideToolbarChange: undefined | ((hideToolbar: boolean) => void) =
    undefined;
  private _popperShow = false;
  private _setPopperShow: (show: boolean) => void = () => {};

  private _chrome?: {
    host: HTMLSpanElement;
    state$: Signal<EditorCanvasPopoverControls | null>;
    unmount: () => void;
  };

  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  get blackBackground() {
    return this._blackBackground;
  }

  set blackBackground(value: boolean) {
    if (this._blackBackground === value) return;
    this._blackBackground = value;
    this._requestUpdate();
  }

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

  get hideToolbar() {
    return this._hideToolbar;
  }

  set hideToolbar(value: boolean) {
    if (this._hideToolbar === value) return;
    this._hideToolbar = value;
    this._requestUpdate();
  }

  get includeFrameOrder() {
    return this._includeFrameOrder;
  }

  set includeFrameOrder(value: boolean) {
    if (this._includeFrameOrder === value) return;
    this._includeFrameOrder = value;
    this._requestUpdate();
  }

  get onHideToolbarChange() {
    return this._onHideToolbarChange;
  }

  set onHideToolbarChange(value: undefined | ((hideToolbar: boolean) => void)) {
    this._onHideToolbarChange = value;
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

  private readonly _onBlackBackgroundChange = (checked: boolean) => {
    this.blackBackground = checked;
    const slots = this.edgeless.std.get(EdgelessLegacySlotIdentifier);
    slots.navigatorSettingUpdated.next({
      blackBackground: this.blackBackground,
    });
    this.edgeless.std
      .get(EditPropsStore)
      .setStorage("presentBlackBackground", checked);
  };

  private _tryRestoreSettings() {
    const blackBackground = this.edgeless.std
      .get(EditPropsStore)
      .getStorage("presentBlackBackground");
    this.blackBackground = blackBackground ?? false;
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
    this._tryRestoreSettings();
    this.setPopperShow(false);

    this._disposables.add(
      effect(() => {
        void this._revision$.value;
        if (!this.isConnected || !this._edgeless) return;
        this._paint();
      }),
    );
  }

  connectedCallback(): void {
    this._ensureBound();
  }

  disconnectedCallback(): void {
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

    const settingsLabel = this._text(
      editorMessage("com.myoxus.sidebar.outline.settings", "Settings"),
    );

    const menuControls: EditorCanvasMenuControls = {
      actions: [
        {
          id: "presentation-settings-label",
          label: this._text(
            editorMessage(
              "com.myoxus.sidebar.frame.playback-settings",
              "Playback Settings",
            ),
          ),
          disabled: false,
        },
        {
          id: "presentation-dark-background",
          label: this._text(
            editorMessage(
              "com.myoxus.sidebar.frame.dark-background",
              "Black background",
            ),
          ),
          disabled: false,
          control: {
            type: "toggle",
            checked: this.blackBackground,
            change: this._onBlackBackgroundChange,
          },
        },
        {
          id: "presentation-hide-toolbar",
          label: this._text(
            editorMessage(
              "com.myoxus.sidebar.frame.hide-toolbar",
              "Hide toolbar",
            ),
          ),
          disabled: false,
          control: {
            type: "toggle",
            checked: this.hideToolbar,
            change: (checked: boolean) => this.onHideToolbarChange?.(checked),
          },
        },
        ...(this.includeFrameOrder
          ? [
              {
                id: "presentation-frame-order-label",
                label: this._text(
                  editorMessage(
                    "com.myoxus.editor.presentation.frame-order",
                    "Frame Order",
                  ),
                ),
                disabled: false,
              },
            ]
          : []),
      ],
    };

    const frameOrderControls: EditorFrameOrderControls | null = this
      .includeFrameOrder
      ? {
          items: this.edgeless.std
            .get(EdgelessFrameManagerIdentifier)
            .frames.map((frame) => ({
              id: frame.id,
              title: frame.props.title.toString(),
            })),
          embedded: true,
          readonly: this.edgeless.store.readonly,
          move: this._moveFrame,
        }
      : null;

    const popoverControls: EditorCanvasPopoverControls = {
      opened: this.popperShow,
      onClose: () => this.setPopperShow(false),
      position: "top",
      offset: 16,
      label: settingsLabel,
      trigger: {
        action: {
          id: "presentation-settings",
          label: settingsLabel,
          icon: "SettingsIcon",
          disabled: false,
          run: () => this.setPopperShow(!this.popperShow),
        },
        expanded: this.popperShow,
      },
      content: frameOrderControls
        ? {
            kind: "menu-with-frame-order",
            menu: menuControls,
            frameOrder: frameOrderControls,
          }
        : {
            kind: "menu",
            controls: menuControls,
          },
    };

    if (!this._chrome) {
      const host = this.ownerDocument.createElement("span");
      host.style.display = "contents";
      this.replaceChildren(host);
      const state$ = signal<EditorCanvasPopoverControls | null>(
        popoverControls,
      );
      const unmount = chrome.mountCanvasPopover(host, state$);
      this._chrome = { host, state$, unmount };
    } else {
      this._chrome.state$.value = popoverControls;
    }
  }
}
