import { consume } from "@lit/context";
import { SettingsIcon, SortIcon } from "@myoxus/icons/lit";
import { signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { createButtonPopper } from "@virgultum/shared/utils";
import { ShadowlessElement } from "@virgultum/std";
import { html } from "lit";
import { query } from "lit/decorators.js";

import { type TocContext, tocContext } from "../config";
import * as styles from "./outline-panel-header.styles";

export const MYOXUS_OUTLINE_PANEL_HEADER = "myoxus-outline-panel-header";

export class OutlinePanelHeader extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private _notePreviewSettingMenuPopper: ReturnType<
    typeof createButtonPopper
  > | null = null;

  private readonly _settingPopperShow$ = signal(false);

  override firstUpdated() {
    this._notePreviewSettingMenuPopper = createButtonPopper({
      reference: this._noteSettingButton,
      popperElement: this._notePreviewSettingMenu,
      stateUpdated: ({ display }) => {
        this._settingPopperShow$.value = display === "show";
      },
      mainAxis: 14,
      crossAxis: -30,
    });
    this.disposables.add(this._notePreviewSettingMenuPopper);
  }

  override render() {
    const sortingEnabled = this._context.enableSorting$.value;
    const showSettingPopper = this._settingPopperShow$.value;
    const labels = this._context.labels$.value;

    return html`<div class=${styles.container}>
        <div class=${styles.noteSettingContainer}>
          <span class=${styles.label}>${labels.title}</span>
          <edgeless-tool-icon-button
            data-testid="toggle-toc-setting-button"
            class="${showSettingPopper ? "active" : ""}"
            .tooltip=${showSettingPopper ? "" : labels.previewSettings}
            .tipPosition=${"bottom"}
            .iconContainerWidth=${"var(--mantine-spacing-xl)"}
            .iconContainerHeight=${"var(--mantine-spacing-xl)"}
            .active=${showSettingPopper}
            .activeMode=${"background"}
            @click=${() => this._notePreviewSettingMenuPopper?.toggle()}
          >
            ${SettingsIcon({ width: "20px", height: "20px" })}
          </edgeless-tool-icon-button>
        </div>
        <edgeless-tool-icon-button
          data-testid="toggle-notes-sorting-button"
          class="${sortingEnabled ? "active" : ""}"
          .tooltip=${labels.visibilityAndSort}
          .tipPosition=${"left"}
          .iconContainerPadding=${0}
          .iconContainerWidth=${"var(--mantine-spacing-xl)"}
          .iconContainerHeight=${"var(--mantine-spacing-xl)"}
          .active=${sortingEnabled}
          .activeMode=${"color"}
          @click=${() => {
            this._context.enableSorting$.value = !sortingEnabled;
          }}
        >
          ${SortIcon({ width: "20px", height: "20px" })}
        </edgeless-tool-icon-button>
      </div>
      <div class=${styles.notePreviewSettingContainer}>
        <myoxus-outline-note-preview-setting-menu></myoxus-outline-note-preview-setting-menu>
      </div>`;
  }

  @query(`.${styles.notePreviewSettingContainer}`)
  private accessor _notePreviewSettingMenu!: HTMLDivElement;

  @query(`.${styles.noteSettingContainer}`)
  private accessor _noteSettingButton!: HTMLDivElement;

  @consume({ context: tocContext })
  private accessor _context!: TocContext;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_OUTLINE_PANEL_HEADER]: OutlinePanelHeader;
  }
}
