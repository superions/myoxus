import { computed, signal } from "@preact/signals-core";
import { type NavigatorMode, PresentTool } from "@virgultum/canvas/blocks";
import { EdgelessLegacySlotIdentifier } from "@virgultum/canvas-runtime/surface";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import type { EditorHost } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import {
  DocModeProvider,
  EditPropsStore,
  type EditorCanvasMenuControls,
  type EditorCanvasPopoverControls,
  type EditorChromeHost,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";

import {
  defaultFramePanelLabels,
  type FramePanelLabels,
} from "../frame-panel.js";

export const MYOXUS_FRAME_PANEL_HEADER = "myoxus-frame-panel-header";

export class FramePanelHeader extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _revision$ = signal(0);
  private readonly _settingPopperShow$ = signal(false);
  private readonly _blackBackground$ = signal(true);
  private readonly _fillScreen$ = signal(false);
  private readonly _hideToolbar$ = signal(false);

  private _editorHost!: EditorHost;
  private _labels: FramePanelLabels = defaultFramePanelLabels;
  private _menuHost: HTMLDivElement | null = null;
  private _popoverHost: HTMLDivElement | null = null;
  private _chromeUnmount: (() => void) | null = null;
  private _popoverUnmount: (() => void) | null = null;
  private _mountedChrome: EditorChromeHost | null = null;

  private readonly _clearEdgelessDisposables = () => {
    this._edgelessDisposables?.dispose();
    this._edgelessDisposables = null;
  };

  private _edgelessDisposables: DisposableGroup | null = null;

  private get _gfx() {
    return this.editorHost.std.get(GfxControllerIdentifier);
  }

  private get _editPropsStore() {
    return this.editorHost.std.get(EditPropsStore);
  }

  private readonly _enterPresentationMode = () => {
    const docModeProvider = this.editorHost.std.get(DocModeProvider);
    if (docModeProvider.getEditorMode() !== "edgeless") {
      this.editorHost.std.get(DocModeProvider).setEditorMode("edgeless");
    }

    setTimeout(() => {
      this._gfx.tool.setTool(PresentTool, {
        mode: this._navigatorMode,
      });
    }, 100);
  };

  private _navigatorMode: NavigatorMode = "fit";

  private readonly _onBlackBackgroundChange = (checked: boolean) => {
    this._blackBackground$.value = checked;
    this.editorHost.std
      .get(EdgelessLegacySlotIdentifier)
      .navigatorSettingUpdated.next({ blackBackground: checked });
    this._editPropsStore.setStorage("presentBlackBackground", checked);
  };

  private readonly _onFillScreenChange = (checked: boolean) => {
    this._fillScreen$.value = checked;
    this._navigatorMode = checked ? "fill" : "fit";
    this.editorHost.std
      .get(EdgelessLegacySlotIdentifier)
      .navigatorSettingUpdated.next({ fillScreen: checked });
    this._editPropsStore.setStorage("presentFillScreen", checked);
  };

  private readonly _onHideToolbarChange = (checked: boolean) => {
    this._hideToolbar$.value = checked;
    this.editorHost.std
      .get(EdgelessLegacySlotIdentifier)
      .navigatorSettingUpdated.next({ hideToolbar: checked });
    this._editPropsStore.setStorage("presentHideToolbar", checked);
  };

  private readonly _controls$ = computed<EditorCanvasMenuControls | null>(
    () => {
      void this._revision$.value;
      const show = this._settingPopperShow$.value;
      if (!this._editorHost) return null;
      return {
        actions: [
          {
            id: "frame-panel-label",
            label: this._labels.allFrames,
            disabled: false,
          },
          {
            id: "frame-panel-settings",
            label: this._labels.allFramesSettings,
            icon: "SettingsIcon",
            active: show,
            disabled: false,
            run: () => {
              this._settingPopperShow$.value = !this._settingPopperShow$.peek();
            },
          },
          {
            id: "frame-panel-presentation",
            label: this._labels.presentation,
            icon: "PresentationIcon",
            showLabel: true,
            disabled: false,
            run: this._enterPresentationMode,
          },
        ],
      };
    },
  );

  private readonly _popoverControls$ =
    computed<EditorCanvasPopoverControls | null>(() => {
      void this._revision$.value;
      if (!this._editorHost) return null;
      const opened = this._settingPopperShow$.value;
      return {
        opened,
        onClose: () => {
          this._settingPopperShow$.value = false;
        },
        position: "bottom-end",
        offset: 8,
        label: this._labels.allFramesSettings,
        content: {
          kind: "menu",
          controls: {
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
                  checked: this._fillScreen$.value,
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
                  checked: this._blackBackground$.value,
                  change: this._onBlackBackgroundChange,
                },
              },
              {
                id: "presentation-hide-toolbar",
                label: this._labels.hideToolbar,
                disabled: false,
                control: {
                  type: "toggle",
                  checked: this._hideToolbar$.value,
                  change: this._onHideToolbarChange,
                },
              },
            ],
          },
        },
      };
    });

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

  private _bump() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private readonly _setEdgelessDisposables = () => {
    const slots = this.editorHost.std.get(EdgelessLegacySlotIdentifier);

    this._clearEdgelessDisposables();
    this._edgelessDisposables = new DisposableGroup();
    this._edgelessDisposables.add(
      slots.navigatorSettingUpdated.subscribe(
        ({ fillScreen, blackBackground, hideToolbar }) => {
          if (fillScreen !== undefined) {
            this._navigatorMode = fillScreen ? "fill" : "fit";
            this._fillScreen$.value = fillScreen;
          }
          if (blackBackground !== undefined) {
            this._blackBackground$.value = blackBackground;
          }
          if (hideToolbar !== undefined) {
            this._hideToolbar$.value = hideToolbar;
          }
        },
      ),
    );
  };

  private _tryLoadNavigatorStateLocalRecord() {
    if (!this._editorHost) return;
    const fillScreen =
      this._editPropsStore.getStorage("presentFillScreen") ?? false;
    this._fillScreen$.value = fillScreen;
    this._navigatorMode = fillScreen ? "fill" : "fit";
    this._blackBackground$.value =
      this._editPropsStore.getStorage("presentBlackBackground") ?? true;
    this._hideToolbar$.value =
      this._editPropsStore.getStorage("presentHideToolbar") ?? false;
  }

  private _ensureDom() {
    this.style.position = "relative";
    this.style.display = "block";
    if (!this._menuHost) {
      this._menuHost = this.ownerDocument.createElement("div");
      this._menuHost.style.display = "contents";
    }
    if (!this._popoverHost) {
      this._popoverHost = this.ownerDocument.createElement("div");
      this._popoverHost.style.position = "absolute";
      this._popoverHost.style.inset = "0";
      this._popoverHost.style.pointerEvents = "none";
    }
    if (this._menuHost.parentElement !== this) {
      this.replaceChildren(this._menuHost, this._popoverHost);
    }
  }

  private _bindHost() {
    if (!this._editorHost || !this._menuHost || !this._popoverHost) return;
    this._tryLoadNavigatorStateLocalRecord();

    const docModeProvider = this._editorHost.std.get(DocModeProvider);
    if (docModeProvider.getEditorMode() === "edgeless") {
      this._setEdgelessDisposables();
    } else {
      this._clearEdgelessDisposables();
    }

    const chrome =
      this._editorHost.std.getOptional(EditorChromeHostIdentifier) ?? null;
    if (this._mountedChrome !== chrome) {
      this._chromeUnmount?.();
      this._chromeUnmount = null;
      this._popoverUnmount?.();
      this._popoverUnmount = null;
      this._mountedChrome = chrome;
      if (chrome) {
        this._chromeUnmount = chrome.mountCanvasMenu(
          this._menuHost,
          this._controls$,
        );
        this._popoverUnmount =
          chrome.mountCanvasPopover?.(
            this._popoverHost,
            this._popoverControls$,
          ) ?? null;
      }
    }
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    this._ensureDom();
    this._bindHost();
    this._bump();
  }

  disconnectedCallback() {
    this._chromeUnmount?.();
    this._chromeUnmount = null;
    this._popoverUnmount?.();
    this._popoverUnmount = null;
    this._mountedChrome = null;
    this._settingPopperShow$.value = false;
    this._clearEdgelessDisposables();
    this.disposables.dispose();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_PANEL_HEADER]: FramePanelHeader;
  }
}
