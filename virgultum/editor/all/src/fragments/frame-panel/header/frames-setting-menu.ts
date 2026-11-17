import { EdgelessLegacySlotIdentifier } from "@virgultum/canvas-runtime/surface";
import { WithDisposable } from "@virgultum/core/primitives/lit";
import {
  DocModeProvider,
  EditPropsStore,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import { type EditorHost, ShadowlessElement } from "@virgultum/core/runtime";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

import {
  defaultFramePanelLabels,
  type FramePanelLabels,
} from "../frame-panel.js";

export const MYOXUS_FRAMES_SETTING_MENU = "myoxus-frames-setting-menu";

export class FramesSettingMenu extends WithDisposable(ShadowlessElement) {
  get slots() {
    return this.editorHost.std.get(EdgelessLegacySlotIdentifier);
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

  private _tryRestoreSettings() {
    const blackBackground = this._editPropsStore.getStorage(
      "presentBlackBackground",
    );

    this.blackBackground = blackBackground ?? true;
    this.fillScreen =
      this._editPropsStore.getStorage("presentFillScreen") ?? false;
    this.hideToolbar =
      this._editPropsStore.getStorage("presentHideToolbar") ?? false;
  }

  override connectedCallback() {
    super.connectedCallback();
    this._tryRestoreSettings();
  }

  override render() {
    return html`<div @click=${(event: MouseEvent) => event.stopPropagation()}>
      ${
        this.editorHost.std
          .getOptional(EditorChromeHostIdentifier)
          ?.renderCanvasMenu({
            actions: [
              {
                id: "presentation-preview-label",
                label: this.labels.previewSettings,
                disabled: false,
              },
              {
                id: "presentation-fill-screen",
                label: this.labels.fillScreen,
                disabled: false,
                control: {
                  type: "toggle",
                  checked: this.fillScreen,
                  change: this._onFillScreenChange,
                },
              },
              {
                id: "presentation-settings-label",
                label: this.labels.playbackSettings,
                disabled: false,
              },
              {
                id: "presentation-dark-background",
                label: this.labels.darkBackground,
                disabled: false,
                control: {
                  type: "toggle",
                  checked: this.blackBackground,
                  change: this._onBlackBackgroundChange,
                },
              },
              {
                id: "presentation-hide-toolbar",
                label: this.labels.hideToolbar,
                disabled: false,
                control: {
                  type: "toggle",
                  checked: this.hideToolbar,
                  change: this._onHideToolBarChange,
                },
              },
            ],
          }) ?? nothing
      }
    </div>`;
  }

  override updated(_changedProperties: PropertyValues) {
    if (_changedProperties.has("editorHost")) {
      const docModeProvider = this.editorHost.std.get(DocModeProvider);
      if (docModeProvider.getEditorMode() === "edgeless") {
        this.disposables.add(
          this.slots.navigatorSettingUpdated.subscribe(
            ({ blackBackground, hideToolbar }) => {
              if (
                blackBackground !== undefined &&
                blackBackground !== this.blackBackground
              ) {
                this.blackBackground = blackBackground;
              }

              if (
                hideToolbar !== undefined &&
                hideToolbar !== this.hideToolbar
              ) {
                this.hideToolbar = hideToolbar;
              }
            },
          ),
        );
      } else {
        this.disposables.dispose();
      }
    }
  }

  @state()
  accessor blackBackground = false;

  @property({ attribute: false })
  accessor editorHost!: EditorHost;

  @property({ attribute: false })
  accessor labels: FramePanelLabels = defaultFramePanelLabels;

  @state()
  accessor fillScreen = false;

  @state()
  accessor hideToolbar = false;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAMES_SETTING_MENU]: FramesSettingMenu;
  }
}
