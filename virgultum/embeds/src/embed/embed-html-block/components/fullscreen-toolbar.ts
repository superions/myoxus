import { SignalWatcher } from "@virgultum/core/primitives/lit";
import { ShadowlessElement } from "@virgultum/core/runtime";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import type { EmbedHtmlBlockComponent } from "../embed-html-block.js";

export class EmbedHtmlFullscreenToolbar extends SignalWatcher(
  ShadowlessElement,
) {
  // Fullscreen anchoring and the existing hover-reveal hit area are technical geometry.
  static override styles = css`
    embed-html-fullscreen-toolbar {
      position: absolute;
      z-index: 1;
      left: 50%;
      transform: translateX(-50%);
      bottom: 0;
      user-select: none;
    }
    embed-html-fullscreen-toolbar .toolbar-toggle-control {
      padding-bottom: 20px;
    }
    embed-html-fullscreen-toolbar
      .toolbar-toggle-control[data-auto-hide="true"] {
      transition: 0.27s ease;
      padding-top: 100px;
      transform: translateY(100px);
    }
    embed-html-fullscreen-toolbar
      .toolbar-toggle-control[data-auto-hide="true"]:hover {
      padding-top: 0;
      transform: translateY(0);
    }
  `;

  private copyTimeout: ReturnType<typeof setTimeout> | undefined;

  copyCode = () => {
    if (this._copied) return;
    this.embedHtml.std.clipboard
      .writeToClipboard((items) => ({
        ...items,
        "text/plain": this.embedHtml.model.props.html ?? "",
      }))
      .then(() => {
        if (!this.isConnected) return;
        this._copied = true;
        this.copyTimeout = setTimeout(() => (this._copied = false), 1500);
      })
      .catch(console.error);
  };

  private get autoHideToolbar() {
    return (
      this.embedHtml.std
        .get(EditPropsStore)
        .getStorage("autoHideEmbedHTMLFullScreenToolbar") ?? false
    );
  }
  private set autoHideToolbar(value: boolean) {
    this.embedHtml.std
      .get(EditPropsStore)
      .setStorage("autoHideEmbedHTMLFullScreenToolbar", value);
    this.requestUpdate();
  }

  override disconnectedCallback() {
    clearTimeout(this.copyTimeout);
    this._copied = false;
    super.disconnectedCallback();
  }

  override render() {
    return html`<div
      class="toolbar-toggle-control"
      data-auto-hide=${!this._popperVisible && this.autoHideToolbar}
    >
      ${this.embedHtml.std
        .get(EditorChromeHostIdentifier)
        .renderHtmlFullscreenToolbar({
          copied: this._copied,
          autoHide: this.autoHideToolbar,
          settingsOpen: this._popperVisible,
          setSettingsOpen: (value) => {
            this._popperVisible = value;
          },
          setAutoHide: (value) => {
            this.autoHideToolbar = value;
          },
          close: () => {
            this._popperVisible = false;
            this.embedHtml.close();
          },
          copy: this.copyCode,
        })}
    </div>`;
  }

  @state() private accessor _copied = false;
  @state() private accessor _popperVisible = false;
  @property({ attribute: false }) accessor embedHtml!: EmbedHtmlBlockComponent;
}
