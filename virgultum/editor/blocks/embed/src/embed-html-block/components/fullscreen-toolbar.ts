import { SignalWatcher } from "@virgultum/global/lit";
import { autoPlacement, flip, offset } from "@floating-ui/dom";
import {
  CopyIcon,
  DoneIcon,
  ExpandCloseIcon,
  SettingsIcon,
} from "@myoxus/icons/lit";
import {
  menu,
  popMenu,
  popupTargetFromElement,
} from "@virgultum/components/context-menu";
import {
  EditPropsStore,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import { css, html, LitElement } from "lit";
import { property, query, state } from "lit/decorators.js";

import type { EmbedEdgelessHtmlBlockComponent } from "../embed-edgeless-html-block.js";

export class EmbedHtmlFullscreenToolbar extends SignalWatcher(LitElement) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.embedHtml.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = css`
    :host {
      box-sizing: border-box;
      position: absolute;
      z-index: 1;
      left: 50%;
      transform: translateX(-50%);
      bottom: 0;
      -webkit-user-select: none;
      user-select: none;
    }

    .toolbar-toggle-control {
      padding-bottom: 20px;
    }

    .toolbar-toggle-control[data-auto-hide="true"] {
      transition: 0.27s ease;
      padding-top: 100px;
      transform: translateY(100px);
    }

    .toolbar-toggle-control[data-auto-hide="true"]:hover {
      padding-top: 0;
      transform: translateY(0);
    }

    .fullscreen-toolbar-container {
      background: var(--myoxus-background-overlay-panel-color);
      box-shadow: var(--myoxus-menu-shadow);
      border: 1px solid var(--myoxus-border-color);
      border-radius: 40px;

      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;

      padding: 0 20px;

      height: 64px;
    }

    .short-v-divider {
      display: inline-block;
      background-color: var(--myoxus-border-color);
      width: 1px;
      height: 36px;
    }
  `;

  private readonly _popSettings = () => {
    this._popperVisible = true;
    popMenu(popupTargetFromElement(this._fullScreenToolbarContainer), {
      options: {
        i18n: this.embedHtml.std.getOptional(EditorI18nProvider) ?? undefined,
        items: [
          () =>
            html` <div class="settings-header">
              <span
                >${this._text(editorMessage("com.myoxus.sidebar.outline.settings", "Settings"))}</span
              >
            </div>`,
          menu.group({
            name: "thing",
            items: [
              menu.toggleSwitch({
                name: this._text(
                  editorMessage(
                    "com.myoxus.editor.toolbar.hide-toolbar",
                    "Hide toolbar",
                  ),
                ),
                on: this.autoHideToolbar,
                onChange: (on) => {
                  this.autoHideToolbar = on;
                },
              }),
            ],
          }),
        ],
        onClose: () => {
          this._popperVisible = false;
        },
      },
      middleware: [
        autoPlacement({ allowedPlacements: ["top-end"] }),
        flip(),
        offset({ mainAxis: 4, crossAxis: -40 }),
      ],
      container: this.embedHtml.iframeWrapper,
    });
  };

  copyCode = () => {
    if (this._copied) return;

    this.embedHtml.std.clipboard
      .writeToClipboard((items) => ({
        ...items,
        "text/plain": this.embedHtml.model.props.html ?? "",
      }))
      .then(() => {
        this._copied = true;
        setTimeout(() => (this._copied = false), 1500);
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

  private set autoHideToolbar(val: boolean) {
    this.embedHtml.std
      .get(EditPropsStore)
      .setStorage("autoHideEmbedHTMLFullScreenToolbar", val);
  }

  override render() {
    const hideToolbar = !this._popperVisible && this.autoHideToolbar;

    return html`
      <div data-auto-hide="${hideToolbar}" class="toolbar-toggle-control">
        <div class="fullscreen-toolbar-container">
          <icon-button @click="${this.embedHtml.close}"
            >${ExpandCloseIcon()}
          </icon-button>
          <icon-button
            @click="${this._popSettings}"
            hover="${this._popperVisible}"
            >${SettingsIcon()}
          </icon-button>

          <div class="short-v-divider"></div>

          <icon-button class="copy-button" @click="${this.copyCode}"
            >${this._copied ? DoneIcon() : CopyIcon()}
          </icon-button>
        </div>
      </div>
    `;
  }

  @state()
  private accessor _copied = false;

  @query(".fullscreen-toolbar-container")
  private accessor _fullScreenToolbarContainer!: HTMLElement;

  @state()
  private accessor _popperVisible = false;

  @property({ attribute: false })
  accessor embedHtml!: EmbedEdgelessHtmlBlockComponent;
}
