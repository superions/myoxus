import { DoneIcon } from "@myoxus/icons/lit";
import { SignalWatcher } from "@virgultum/global/lit";
import {
  DocModeProvider,
  TelemetryProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css, html } from "lit";

import { EmbedIframeLinkInputBase } from "./embed-iframe-link-input-base";

export class EmbedIframeLinkEditPopup extends SignalWatcher(
  EmbedIframeLinkInputBase,
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = css`
    .embed-iframe-link-edit-popup {
      display: flex;
      padding: 12px;
      align-items: center;
      gap: 12px;
      color: var(--myoxus-text-primary-color);
      border-radius: 8px;
      border: 0.5px solid ${unsafeCSSVar("borderColor")};
      background: ${unsafeCSSVar("backgroundPrimaryColor")};
      box-shadow: ${unsafeCSSVar("overlayPanelShadow")};

      .input-container {
        display: flex;
        width: 280px;
        align-items: center;
        border: 1px solid var(--myoxus-border-color);
        border-radius: 4px;
        padding: 0 8px;
        background-color: var(--myoxus-background-color);
        gap: 8px;

        .input-label {
          color: var(--myoxus-text-secondary-color);
          font-size: 14px;
          margin-right: 8px;
          white-space: nowrap;
        }

        .link-input {
          flex: 1;
          border: none;
          outline: none;
          padding: 8px 0;
          background: transparent;
          font-size: 14px;
        }
      }

      .input-container:focus-within {
        border-color: var(--myoxus-blue-700);
        outline: none;
      }

      .confirm-button {
        cursor: pointer;
        display: flex;
        padding: 2px;
        justify-content: center;
        align-items: center;
        color: ${unsafeCSSVar("primaryColor")};
      }

      .confirm-button[disabled] {
        color: ${unsafeCSSVar("iconColor")};
      }
    }
  `;

  protected override track(status: "success" | "failure") {
    this.telemetryService?.track("EditLink", {
      type: "embed iframe block",
      page: this.editorMode === "page" ? "doc editor" : "whiteboard editor",
      segment: "editor",
      module: "embed block",
      control: "edit button",
      result: status,
    });
  }

  override render() {
    const isInputEmpty = this.isInputEmpty();
    const { url$ } = this.model.props;

    return html`
      <div class="embed-iframe-link-edit-popup">
        <div class="input-container">
          <span class="input-label"
            >${this._text(editorMessage("com.myoxus.editor.keyboard.link", "Link"))}</span
          >
          <input
            class="link-input"
            type="text"
            spellcheck="false"
            placeholder=${url$.value}
            @input=${this.handleInput}
            @keydown=${this.handleKeyDown}
          />
        </div>
        <div
          class="confirm-button"
          ?disabled=${isInputEmpty}
          @click=${this.onConfirm}
        >
          ${DoneIcon({ width: "24px", height: "24px" })}
        </div>
      </div>
    `;
  }

  get telemetryService() {
    return this.std.getOptional(TelemetryProvider);
  }

  get editorMode() {
    const docModeService = this.std.get(DocModeProvider);
    const mode = docModeService.getEditorMode();
    return mode ?? "page";
  }
}
