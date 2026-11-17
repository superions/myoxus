import { type NavigatorMode, PresentTool } from "@virgultum/canvas/blocks";
import { EdgelessLegacySlotIdentifier } from "@virgultum/canvas-runtime/surface";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { WithDisposable } from "@virgultum/core/primitives/lit";
import {
  DocModeProvider,
  EditPropsStore,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import { createButtonPopper } from "@virgultum/core/utils";
import { type EditorHost, ShadowlessElement } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";

import {
  defaultFramePanelLabels,
  type FramePanelLabels,
} from "../frame-panel.js";

const styles = css`
  myoxus-frame-panel-header .frames-setting-container {
    display: none;
  }
  myoxus-frame-panel-header .frames-setting-container[data-show] {
    display: block;
  }
`;

export const MYOXUS_FRAME_PANEL_HEADER = "myoxus-frame-panel-header";

export class FramePanelHeader extends WithDisposable(ShadowlessElement) {
  static override styles = styles;

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
    this._navigatorMode = this.editorHost.std
      .get(EditPropsStore)
      .getStorage("presentFillScreen")
      ? "fill"
      : "fit";
  }

  override connectedCallback() {
    super.connectedCallback();
    this._tryLoadNavigatorStateLocalRecord();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._edgelessDisposables) {
      this._clearEdgelessDisposables();
    }
  }

  private _toggleSettings(anchor: HTMLElement) {
    if (!this._framesSettingMenuPopper) {
      this._framesSettingMenuPopper = createButtonPopper({
        // React supplies the mounted native button; the frame popper keeps its existing geometry.
        reference: anchor,
        popperElement: this._frameSettingMenu,
        stateUpdated: ({ display }) => {
          this._settingPopperShow = display === "show";
        },
        mainAxis: 14,
        crossAxis: -100,
      });
      this.disposables.add(this._framesSettingMenuPopper);
    }
    this._framesSettingMenuPopper.toggle();
  }

  override render() {
    return html` ${
        this.editorHost.std
          .getOptional(EditorChromeHostIdentifier)
          ?.renderCanvasMenu({
            actions: [
              {
                id: "frame-panel-label",
                label: this.labels.allFrames,
                disabled: false,
              },
              {
                id: "frame-panel-settings",
                label: this.labels.allFramesSettings,
                icon: "SettingsIcon",
                active: this._settingPopperShow,
                disabled: false,
                run: (anchor) => this._toggleSettings(anchor),
              },
              {
                id: "frame-panel-presentation",
                label: this.labels.presentation,
                icon: "PresentationIcon",
                showLabel: true,
                disabled: false,
                run: this._enterPresentationMode,
              },
            ],
          }) ?? nothing
      }
      <div class="frames-setting-container">
        <myoxus-frames-setting-menu
          .editorHost=${this.editorHost}
          .labels=${this.labels}
        ></myoxus-frames-setting-menu>
      </div>`;
  }

  override updated(_changedProperties: PropertyValues) {
    if (_changedProperties.has("editorHost")) {
      const docModeProvider = this.editorHost.std.get(DocModeProvider);
      if (docModeProvider.getEditorMode() === "edgeless") {
        this._setEdgelessDisposables();
      } else {
        this._clearEdgelessDisposables();
      }
    }
  }

  @query(".frames-setting-container")
  private accessor _frameSettingMenu!: HTMLDivElement;

  @state()
  private accessor _settingPopperShow = false;

  @property({ attribute: false })
  accessor editorHost!: EditorHost;

  @property({ attribute: false })
  accessor labels: FramePanelLabels = defaultFramePanelLabels;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_PANEL_HEADER]: FramePanelHeader;
  }
}
