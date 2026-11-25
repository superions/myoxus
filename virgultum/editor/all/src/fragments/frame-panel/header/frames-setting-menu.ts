import { computed, signal } from "@preact/signals-core";
import { EdgelessLegacySlotIdentifier } from "@virgultum/canvas-runtime/surface";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import type { EditorHost } from "@virgultum/core/runtime";
import {
  DocModeProvider,
  EditPropsStore,
  type EditorCanvasMenuControls,
  type EditorChromeHost,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";

import {
  defaultFramePanelLabels,
  type FramePanelLabels,
} from "../frame-panel.js";

export const MYOXUS_FRAMES_SETTING_MENU = "myoxus-frames-setting-menu";

export class FramesSettingMenu extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _blackBackground$ = signal(false);
  private readonly _fillScreen$ = signal(false);
  private readonly _hideToolbar$ = signal(false);
  private readonly _revision$ = signal(0);

  private _editorHost!: EditorHost;
  private _labels: FramePanelLabels = defaultFramePanelLabels;
  private _container: HTMLDivElement | null = null;
  private _chromeUnmount: (() => void) | null = null;
  private _mountedChrome: EditorChromeHost | null = null;
  private _hostDisposables: DisposableGroup | null = null;

  get blackBackground(): boolean {
    return this._blackBackground$.value;
  }
  set blackBackground(value: boolean) {
    this._blackBackground$.value = value;
  }

  get fillScreen(): boolean {
    return this._fillScreen$.value;
  }
  set fillScreen(value: boolean) {
    this._fillScreen$.value = value;
  }

  get hideToolbar(): boolean {
    return this._hideToolbar$.value;
  }
  set hideToolbar(value: boolean) {
    this._hideToolbar$.value = value;
  }

  get editorHost(): EditorHost {
    return this._editorHost;
  }
  set editorHost(value: EditorHost) {
    const changed = this._editorHost !== value;
    this._editorHost = value;
    if (changed && this.isConnected) {
      this._bindHost();
    }
    this._bump();
  }

  get labels(): FramePanelLabels {
    return this._labels;
  }
  set labels(value: FramePanelLabels) {
    this._labels = value;
    this._bump();
  }

  get slots() {
    return this.editorHost.std.get(EdgelessLegacySlotIdentifier);
  }

  private _bump() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private readonly _onBlackBackgroundChange = (checked: boolean) => {
    this.blackBackground = checked;
    this.slots.navigatorSettingUpdated.next({
      blackBackground: this.blackBackground,
    });
  };

  private readonly _onFillScreenChange = (checked: boolean) => {
    this.fillScreen = checked;
    this.slots.navigatorSettingUpdated.next({
      fillScreen: this.fillScreen,
    });
    this._editPropsStore.setStorage("presentFillScreen", this.fillScreen);
  };

  private readonly _onHideToolBarChange = (checked: boolean) => {
    this.hideToolbar = checked;
    this.slots.navigatorSettingUpdated.next({
      hideToolbar: this.hideToolbar,
    });
    this._editPropsStore.setStorage("presentHideToolbar", this.hideToolbar);
  };

  private get _editPropsStore() {
    return this.editorHost.std.get(EditPropsStore);
  }

  private readonly _controls$ = computed<EditorCanvasMenuControls | null>(
    () => {
      void this._revision$.value;
      const fillScreen = this._fillScreen$.value;
      const blackBackground = this._blackBackground$.value;
      const hideToolbar = this._hideToolbar$.value;
      if (!this._editorHost) return null;
      return {
        actions: [
          {
            id: "presentation-preview-label",
            label: this._labels.previewSettings,
            disabled: false,
          },
          {
            id: "presentation-fill-screen",
            label: this._labels.fillScreen,
            disabled: false,
            control: {
              type: "toggle",
              checked: fillScreen,
              change: this._onFillScreenChange,
            },
          },
          {
            id: "presentation-settings-label",
            label: this._labels.playbackSettings,
            disabled: false,
          },
          {
            id: "presentation-dark-background",
            label: this._labels.darkBackground,
            disabled: false,
            control: {
              type: "toggle",
              checked: blackBackground,
              change: this._onBlackBackgroundChange,
            },
          },
          {
            id: "presentation-hide-toolbar",
            label: this._labels.hideToolbar,
            disabled: false,
            control: {
              type: "toggle",
              checked: hideToolbar,
              change: this._onHideToolBarChange,
            },
          },
        ],
      };
    },
  );

  private _tryRestoreSettings() {
    if (!this._editorHost) return;
    const blackBackground = this._editPropsStore.getStorage(
      "presentBlackBackground",
    );

    this.blackBackground = blackBackground ?? true;
    this.fillScreen =
      this._editPropsStore.getStorage("presentFillScreen") ?? false;
    this.hideToolbar =
      this._editPropsStore.getStorage("presentHideToolbar") ?? false;
  }

  private _clearHostDisposables() {
    this._hostDisposables?.dispose();
    this._hostDisposables = null;
  }

  private _bindHost() {
    if (!this._editorHost || !this._container) return;
    this._tryRestoreSettings();
    this._clearHostDisposables();

    const docModeProvider = this._editorHost.std.get(DocModeProvider);
    if (docModeProvider.getEditorMode() === "edgeless") {
      this._hostDisposables = new DisposableGroup();
      this._hostDisposables.add(
        this.slots.navigatorSettingUpdated.subscribe(
          ({ blackBackground, hideToolbar }) => {
            if (
              blackBackground !== undefined &&
              blackBackground !== this.blackBackground
            ) {
              this.blackBackground = blackBackground;
            }

            if (hideToolbar !== undefined && hideToolbar !== this.hideToolbar) {
              this.hideToolbar = hideToolbar;
            }
          },
        ),
      );
    }

    const chrome =
      this._editorHost.std.getOptional(EditorChromeHostIdentifier) ?? null;
    if (this._mountedChrome !== chrome) {
      this._chromeUnmount?.();
      this._chromeUnmount = null;
      this._mountedChrome = chrome;
      if (chrome) {
        this._chromeUnmount = chrome.mountCanvasMenu(
          this._container,
          this._controls$,
        );
      }
    }
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    if (!this._container) {
      this._container = this.ownerDocument.createElement("div");
      this.replaceChildren(this._container);
    }
    this.disposables.addFromEvent(this._container, "click", (event) => {
      event.stopPropagation();
    });
    this._bindHost();
    this._bump();
  }

  disconnectedCallback() {
    this._chromeUnmount?.();
    this._chromeUnmount = null;
    this._mountedChrome = null;
    this._clearHostDisposables();
    this.disposables.dispose();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAMES_SETTING_MENU]: FramesSettingMenu;
  }
}
