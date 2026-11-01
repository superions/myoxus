import {
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import { SignalWatcher } from "@virgultum/global/lit";
import { DefaultTool } from "@virgultum/block-surface";
import { EdgelessToolbarToolMixin } from "@virgultum/widget-edgeless-toolbar";
import { css, html, LitElement } from "lit";
import { repeat } from "lit/directives/repeat.js";

import { EdgelessFrameManagerIdentifier } from "../frame-manager.js";
import { FrameTool } from "../frame-tool";
import { FrameConfig } from "./config.js";

export class EdgelessFrameMenu extends EdgelessToolbarToolMixin(
  SignalWatcher(LitElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = css`
    :host {
      position: absolute;
      display: flex;
      z-index: -1;
    }
    .menu-content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
    }

    .frame-add-button {
      width: 40px;
      height: 24px;
      border-radius: 4px;
      border: 1px solid var(--myoxus-border-color);
      color: var(--myoxus-text-primary-color);
      line-height: 20px;
      font-weight: 400;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      position: relative;
    }

    .frame-add-button::before {
      content: "";
      position: absolute;
      width: 100%;
      height: 100%;
      left: 0;
      top: 0;
      border-radius: 3px;
      background: transparent;
      transition: background-color 0.23s ease;
      pointer-events: none;
    }
    .frame-add-button:hover::before {
      background: var(--myoxus-hover-color);
    }

    .custom {
      width: 60px;
      background: var(--myoxus-hover-color);
    }

    .divider {
      width: 1px;
      height: 20px;
      background: var(--myoxus-border-color);
      transform: scaleX(0.5);
    }
  `;

  override type = FrameTool;

  get frameManager() {
    return this.edgeless.std.get(EdgelessFrameManagerIdentifier);
  }

  override render() {
    const { gfx, frameManager } = this;
    return html`
      <edgeless-slide-menu .showNext=${false}>
        <div class="menu-content">
          <div class="frame-add-button custom">
            ${this._text(editorMessage("com.myoxus.editor.frame.custom", "Custom"))}
          </div>
          <div class="divider"></div>
          ${repeat(
            FrameConfig,
            (item) => item.name,
            (item, index) => html`
              <div
                @click=${() => {
                  gfx.tool.setTool(DefaultTool);
                  frameManager.createFrameOnViewportCenter(item.wh);
                }}
                class="frame-add-button ${index}"
                data-name="${item.name}"
                data-w="${item.wh[0]}"
                data-h="${item.wh[1]}"
              >
                ${item.name}
              </div>
            `,
          )}
        </div>
      </edgeless-slide-menu>
    `;
  }
}
