import { PresentationIcon, SettingsIcon } from "@myoxus/icons/lit";
import { type NavigatorMode, PresentTool } from "@virgultum/block-frame";
import { EdgelessLegacySlotIdentifier } from "@virgultum/block-surface";
import { DisposableGroup } from "@virgultum/global/disposable";
import { WithDisposable } from "@virgultum/global/lit";
import { DocModeProvider, EditPropsStore } from "@virgultum/shared/services";
import { createButtonPopper } from "@virgultum/shared/utils";
import type { EditorHost } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { css, html, LitElement, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";

import {
  defaultFramePanelLabels,
  type FramePanelLabels,
} from "../frame-panel.js";

const styles = css`
  :host {
    display: flex;
    width: 100%;
    justify-content: start;
  }

  .frame-panel-header {
    display: flex;
    width: 100%;
    height: 36px;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
    padding: 0 8px;
  }

  .all-frames-setting {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 100px;
    height: 24px;
    margin: 8px 4px;
  }

  .all-frames-setting-button svg {
    color: var(--myoxus-icon-secondary);
  }

  .all-frames-setting-button:hover svg,
  .all-frames-setting-button.active svg {
    color: var(--myoxus-icon-color);
  }

  .all-frames-setting-label {
    min-width: 68px;
    height: 22px;
    font-family: var(--mantine-font-family-section, var(--mantine-font-family));
    font-size: var(--mantine-font-size-section, var(--mantine-font-size-md));
    font-weight: var(
      --mantine-font-weight-section,
      var(--mantine-font-weight-regular)
    );
    line-height: var(
      --mantine-line-height-section,
      var(--mantine-line-height-md)
    );
    color: var(--myoxus-text-primary-color);
    white-space: nowrap;
  }

  .frames-setting-container {
    display: none;
    justify-content: center;
    align-items: center;
    background: var(--myoxus-background-overlay-panel-color);
    box-shadow: var(--myoxus-shadow-2);
    border-radius: 8px;
  }

  .frames-setting-container[data-show] {
    display: flex;
  }

  .presentation-button {
    display: flex;
    align-items: center;
    gap: 4px;
    box-sizing: border-box;
    min-height: calc(
      var(--mantine-spacing-xl) + var(--mantine-spacing-xs) +
        var(--mantine-spacing-2xs)
    );
    padding: var(--mantine-spacing-xs) var(--mantine-spacing-sm);
    border-radius: var(--mantine-radius-md);
    margin: 4px 0;
    border: 1px solid var(--myoxus-border-color);
    background: var(--myoxus-background-primary-color);
    color: var(--myoxus-text-primary-color);
    font: inherit;
  }

  .presentation-button:hover {
    background: var(--myoxus-hover-color);
    cursor: pointer;
  }

  .presentation-button svg {
    fill: var(--myoxus-icon-color);
    margin-right: 4px;
  }

  .presentation-button-label {
    font-family: var(--mantine-font-family-section, var(--mantine-font-family));
    font-size: var(--mantine-font-size-section, var(--mantine-font-size-md));
    font-weight: var(
      --mantine-font-weight-section,
      var(--mantine-font-weight-regular)
    );
    line-height: var(
      --mantine-line-height-section,
      var(--mantine-line-height-md)
    );
  }
`;

export const MYOXUS_FRAME_PANEL_HEADER = "myoxus-frame-panel-header";

export class FramePanelHeader extends WithDisposable(LitElement) {
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

  override firstUpdated() {
    const disposables = this.disposables;

    this._framesSettingMenuPopper = createButtonPopper({
      reference: this._frameSettingButton,
      popperElement: this._frameSettingMenu,
      stateUpdated: ({ display }) => {
        this._settingPopperShow = display === "show";
      },
      mainAxis: 14,
      crossAxis: -100,
    });
    disposables.add(this._framesSettingMenuPopper);
  }

  override render() {
    return html`<div class="frame-panel-header">
      <div class="all-frames-setting">
        <span class="all-frames-setting-label">${this.labels.allFrames}</span>
        <edgeless-tool-icon-button
          class="all-frames-setting-button ${
            this._settingPopperShow ? "active" : ""
          }"
          .tooltip=${
            this._settingPopperShow ? "" : this.labels.allFramesSettings
          }
          .tipPosition=${"top"}
          .iconContainerWidth=${"var(--mantine-spacing-xl)"}
          .iconContainerHeight=${"var(--mantine-spacing-xl)"}
          .active=${this._settingPopperShow}
          .activeMode=${"background"}
          @click=${() => this._framesSettingMenuPopper?.toggle()}
        >
          ${SettingsIcon({ width: "20px", height: "20px" })}
        </edgeless-tool-icon-button>
      </div>
      <div class="frames-setting-container">
        <myoxus-frames-setting-menu
          .editorHost=${this.editorHost}
          .labels=${this.labels}
        ></myoxus-frames-setting-menu>
      </div>
      <button
        type="button"
        class="presentation-button"
        data-myoxus-ui-role="button:secondary"
        @click=${this._enterPresentationMode}
      >
        ${PresentationIcon({ width: "16px", height: "16px" })}<span
          class="presentation-button-label"
          >${this.labels.presentation}</span
        >
      </button>
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

  @query(".all-frames-setting-button")
  private accessor _frameSettingButton!: HTMLDivElement;

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
