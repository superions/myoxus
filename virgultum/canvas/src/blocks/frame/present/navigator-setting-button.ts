import { effect, signal, type Signal } from "@preact/signals-core";
import { EdgelessLegacySlotIdentifier } from "@virgultum/canvas-runtime/surface";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
  type EditorCanvasMenuControls,
  type EditorCanvasToolControls,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { createButtonPopper } from "@virgultum/core/utils";
import {
  type BlockComponent,
  NativeViewElement,
} from "@virgultum/core/runtime";
import type { EdgelessFrameOrderMenu } from "./frame-order-menu.js";

// The owning popper controls visibility; native chrome owns appearance and density.
const navigatorSettingStyles = `
  edgeless-navigator-setting-button .navigator-setting-menu {
    display: none;
  }
  edgeless-navigator-setting-button .navigator-setting-menu[data-show] {
    display: block;
  }
`;

export class EdgelessNavigatorSettingButton extends NativeViewElement {
  private _disposables = new DisposableGroup();
  private readonly _revision$ = signal(0);
  private _bound = false;
  private _domReady = false;
  private _blackBackground = false;
  private _edgeless!: BlockComponent;
  private _hideToolbar = false;
  private _includeFrameOrder = false;
  private _onHideToolbarChange: undefined | ((hideToolbar: boolean) => void) =
    undefined;
  private _popperShow = false;
  private _setPopperShow: (show: boolean) => void = () => {};

  private _navigatorSettingButton!: HTMLSpanElement;
  private _navigatorSettingMenu!: HTMLDivElement;
  private _embeddedFrameOrder: EdgelessFrameOrderMenu | null = null;
  private _toolChrome?: {
    host: HTMLSpanElement;
    state$: Signal<EditorCanvasToolControls | null>;
    unmount: () => void;
  };
  private _menuChrome?: {
    host: HTMLSpanElement;
    state$: Signal<EditorCanvasMenuControls | null>;
    unmount: () => void;
  };

  private _navigatorSettingPopper?: ReturnType<
    typeof createButtonPopper
  > | null = null;

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
    if (this._embeddedFrameOrder) {
      this._embeddedFrameOrder.edgeless = value;
    }
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

  private _ensureDom() {
    if (this._domReady) return;
    this._domReady = true;
    const style = this.ownerDocument.createElement("style");
    style.textContent = navigatorSettingStyles;
    this._navigatorSettingButton = this.ownerDocument.createElement("span");
    this._navigatorSettingButton.className = "navigator-setting-button";
    this._navigatorSettingMenu = this.ownerDocument.createElement("div");
    this._navigatorSettingMenu.className = "navigator-setting-menu";
    this._navigatorSettingMenu.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    this.append(
      style,
      this._navigatorSettingButton,
      this._navigatorSettingMenu,
    );
  }

  private _ensureBound() {
    if (this._bound || !this.isConnected || !this._edgeless) return;
    this._bound = true;
    if (this._disposables.disposed) {
      this._disposables = new DisposableGroup();
    }
    this._ensureDom();
    this._tryRestoreSettings();
    this._navigatorSettingPopper = createButtonPopper({
      reference: this._navigatorSettingButton,
      popperElement: this._navigatorSettingMenu,
      stateUpdated: ({ display }) => this.setPopperShow(display === "show"),
      mainAxis: 22,
    });
    // A remounted popper starts closed; do not retain the previous session's expanded flag.
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
    this._navigatorSettingPopper?.dispose();
    this._navigatorSettingPopper = null;
    if (this._toolChrome) {
      this._toolChrome.unmount();
      this._toolChrome.host.remove();
      this._toolChrome = undefined;
    }
    if (this._menuChrome) {
      this._menuChrome.unmount();
      this._menuChrome.host.remove();
      this._menuChrome = undefined;
    }
    this._disposables.dispose();
    this._bound = false;
  }

  private _paint() {
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;

    const toolControls: EditorCanvasToolControls = {
      action: {
        id: "presentation-settings",
        label: this._text(
          editorMessage("com.myoxus.sidebar.outline.settings", "Settings"),
        ),
        icon: "SettingsIcon",
        disabled: false,
        run: () => this._navigatorSettingPopper?.toggle(),
      },
      expanded: this.popperShow,
    };

    if (!this._toolChrome) {
      const host = this.ownerDocument.createElement("span");
      host.style.display = "contents";
      this._navigatorSettingButton.append(host);
      const state$ = signal<EditorCanvasToolControls | null>(toolControls);
      const unmount = chrome.mountCanvasTool(host, state$);
      this._toolChrome = { host, state$, unmount };
    } else {
      this._toolChrome.state$.value = toolControls;
    }

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

    if (!this._menuChrome) {
      const host = this.ownerDocument.createElement("span");
      host.style.display = "contents";
      this._navigatorSettingMenu.insertBefore(
        host,
        this._navigatorSettingMenu.firstChild,
      );
      const state$ = signal<EditorCanvasMenuControls | null>(menuControls);
      const unmount = chrome.mountCanvasMenu(host, state$);
      this._menuChrome = { host, state$, unmount };
    } else {
      this._menuChrome.state$.value = menuControls;
    }

    if (this.includeFrameOrder) {
      if (!this._embeddedFrameOrder) {
        this._embeddedFrameOrder = this.ownerDocument.createElement(
          "edgeless-frame-order-menu",
        );
        this._embeddedFrameOrder.embed = true;
        this._navigatorSettingMenu.append(this._embeddedFrameOrder);
      }
      this._embeddedFrameOrder.edgeless = this.edgeless;
    } else if (this._embeddedFrameOrder) {
      this._embeddedFrameOrder.remove();
      this._embeddedFrameOrder = null;
    }
  }
}
