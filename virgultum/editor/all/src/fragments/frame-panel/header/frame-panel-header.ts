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
  type EditorChromeHost,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import { createButtonPopper } from "@virgultum/core/utils";

import {
  defaultFramePanelLabels,
  type FramePanelLabels,
} from "../frame-panel.js";
import type { FramesSettingMenu } from "./frames-setting-menu.js";

const STYLE_ID = "myoxus-frame-panel-header-styles";
const STYLES = `
  myoxus-frame-panel-header .frames-setting-container {
    display: none;
  }
  myoxus-frame-panel-header .frames-setting-container[data-show] {
    display: block;
  }
`;

function ensureStyles(doc: Document) {
  if (!doc.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.append(style);
}

export const MYOXUS_FRAME_PANEL_HEADER = "myoxus-frame-panel-header";

export class FramePanelHeader extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _revision$ = signal(0);
  private readonly _settingPopperShow$ = signal(false);

  private _editorHost!: EditorHost;
  private _labels: FramePanelLabels = defaultFramePanelLabels;
  private _menuHost: HTMLDivElement | null = null;
  private _frameSettingMenu: HTMLDivElement | null = null;
  private _settingMenuEl: FramesSettingMenu | null = null;
  private _chromeUnmount: (() => void) | null = null;
  private _mountedChrome: EditorChromeHost | null = null;

  private readonly _clearEdgelessDisposables = () => {
    this._edgelessDisposables?.dispose();
    this._edgelessDisposables = null;
  };

  private _edgelessDisposables: DisposableGroup | null = null;

  private get _gfx() {
    return this.editorHost.std.get(GfxControllerIdentifier);
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

  private _framesSettingMenuPopper: ReturnType<
    typeof createButtonPopper
  > | null = null;

  private _navigatorMode: NavigatorMode = "fit";

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
            run: (anchor) => this._toggleSettings(anchor),
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

  get editorHost(): EditorHost {
    return this._editorHost;
  }

  set editorHost(value: EditorHost) {
    const changed = this._editorHost !== value;
    this._editorHost = value;
    if (this._settingMenuEl) {
      this._settingMenuEl.editorHost = value;
    }
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
    if (this._settingMenuEl) {
      this._settingMenuEl.labels = value;
    }
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
      slots.navigatorSettingUpdated.subscribe(({ fillScreen }) => {
        this._navigatorMode = fillScreen ? "fill" : "fit";
      }),
    );
  };

  private _tryLoadNavigatorStateLocalRecord() {
    if (!this._editorHost) return;
    this._navigatorMode = this._editorHost.std
      .get(EditPropsStore)
      .getStorage("presentFillScreen")
      ? "fill"
      : "fit";
  }

  private _ensureDom() {
    if (!this._menuHost) {
      this._menuHost = this.ownerDocument.createElement("div");
      this._menuHost.style.display = "contents";
    }
    if (!this._frameSettingMenu) {
      this._frameSettingMenu = this.ownerDocument.createElement("div");
      this._frameSettingMenu.className = "frames-setting-container";
      this._settingMenuEl = this.ownerDocument.createElement(
        "myoxus-frames-setting-menu",
      ) as FramesSettingMenu;
      this._frameSettingMenu.append(this._settingMenuEl);
    }
    if (this._menuHost.parentElement !== this) {
      this.replaceChildren(this._menuHost, this._frameSettingMenu);
    }
    if (this._settingMenuEl) {
      this._settingMenuEl.editorHost = this._editorHost;
      this._settingMenuEl.labels = this._labels;
    }
  }

  private _bindHost() {
    if (!this._editorHost || !this._menuHost) return;
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
      this._mountedChrome = chrome;
      if (chrome) {
        this._chromeUnmount = chrome.mountCanvasMenu(
          this._menuHost,
          this._controls$,
        );
      }
    }
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    ensureStyles(this.ownerDocument);
    this._ensureDom();
    this._bindHost();
    this._bump();
  }

  disconnectedCallback() {
    this._chromeUnmount?.();
    this._chromeUnmount = null;
    this._mountedChrome = null;
    this._framesSettingMenuPopper = null;
    this._clearEdgelessDisposables();
    this.disposables.dispose();
  }

  private _toggleSettings(anchor: HTMLElement) {
    if (!this._frameSettingMenu) return;
    if (!this._framesSettingMenuPopper) {
      this._framesSettingMenuPopper = createButtonPopper({
        // React supplies the mounted native button; the frame popper keeps its existing geometry.
        reference: anchor,
        popperElement: this._frameSettingMenu,
        stateUpdated: ({ display }) => {
          this._settingPopperShow$.value = display === "show";
        },
        mainAxis: 14,
        crossAxis: -100,
      });
      this.disposables.add(this._framesSettingMenuPopper);
    }
    this._framesSettingMenuPopper.toggle();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_PANEL_HEADER]: FramePanelHeader;
  }
}
