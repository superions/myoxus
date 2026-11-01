import {
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import { consume } from "@lit/context";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { ShadowlessElement } from "@virgultum/std";
import { html } from "lit";

import { type TocContext, tocContext } from "../config";
import * as styles from "./outline-setting-menu.styles";

export const MYOXUS_OUTLINE_NOTE_PREVIEW_SETTING_MENU =
  "myoxus-outline-note-preview-setting-menu";

export class OutlineNotePreviewSettingMenu extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this._context.editor$.value.std.getOptional(EditorI18nProvider) ??
        undefined,
    );
  }

  override render() {
    const showPreviewIcon = this._context.showIcons$.value;

    return html`<div
      class=${styles.notePreviewSettingMenuContainer}
      @click=${(e: MouseEvent) => e.stopPropagation()}
    >
      <div class=${styles.notePreviewSettingMenuItem}>
        <div class=${styles.settingLabel}>
          ${this._text(editorMessage("com.myoxus.sidebar.outline.settings", "Settings"))}
        </div>
      </div>
      <div class="${styles.notePreviewSettingMenuItem} ${styles.action}">
        <div class=${styles.actionLabel}>
          ${this._text(editorMessage("com.myoxus.sidebar.outline.show-type-icon", "Show type icon"))}
        </div>
        <div class=${styles.toggleButton}>
          <toggle-switch
            .on=${showPreviewIcon}
            .onChange=${() => {
              this._context.showIcons$.value = !showPreviewIcon;
            }}
          ></toggle-switch>
        </div>
      </div>
    </div>`;
  }

  @consume({ context: tocContext })
  private accessor _context!: TocContext;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_OUTLINE_NOTE_PREVIEW_SETTING_MENU]: OutlineNotePreviewSettingMenu;
  }
}
