import { consume } from "@lit/context";
import { CloseIcon, SortIcon } from "@myoxus/icons/lit";
import { effect, signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { NoteDisplayMode } from "@virgultum/model";
import { ShadowlessElement } from "@virgultum/std";
import { html, nothing } from "lit";

import { type TocContext, tocContext } from "../config";
import { getNotesFromStore } from "../utils/query";
import * as styles from "./outline-notice.styles";

export const MYOXUS_OUTLINE_NOTICE = "myoxus-outline-notice";

export class OutlineNotice extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private readonly _visible$ = signal(false);

  override connectedCallback(): void {
    super.connectedCallback();
    this.disposables.add(
      effect(() => {
        const enableSorting = this._context.enableSorting$.value;

        if (enableSorting) {
          if (this._visible$.peek()) {
            this._visible$.value = false;
          }
          return;
        }

        const shouldShowNotice =
          getNotesFromStore(this._context.editor$.value.store, [
            NoteDisplayMode.DocOnly,
          ]).length > 0;

        if (shouldShowNotice && !this._visible$.peek()) {
          this._visible$.value = true;
        }
      }),
    );
  }

  override render() {
    if (!this._visible$.value) {
      return nothing;
    }
    const labels = this._context.labels$.value;

    return html`
      <div data-testid=${MYOXUS_OUTLINE_NOTICE} class=${styles.outlineNotice}>
        <div class=${styles.outlineNoticeHeader}>
          <span class=${styles.outlineNoticeLabel}
            >${labels.hiddenNoticeTitle}</span
          >
          <span
            data-testid="outline-notice-close-button"
            class=${styles.outlineNoticeCloseButton}
            @click=${() => {
              this._visible$.value = false;
            }}
            >${CloseIcon({ width: "16px", height: "16px" })}</span
          >
        </div>
        <div class=${styles.outlineNoticeBody}>
          <div class="${styles.notice}">${labels.hiddenNoticeBody}</div>
          <div
            data-testid="outline-notice-sort-button"
            class="${styles.button}"
            @click=${() => {
              this._context.enableSorting$.value = true;
              this._visible$.value = false;
            }}
          >
            <span class=${styles.buttonSpan}
              >${labels.hiddenNoticeActionPrefix}</span
            >
            <span class=${styles.buttonSpan}
              >${SortIcon({ width: "20px", height: "20px" })}</span
            >
            <span class=${styles.buttonSpan}
              >${labels.hiddenNoticeActionSuffix}</span
            >
          </div>
        </div>
      </div>
    `;
  }

  @consume({ context: tocContext })
  private accessor _context!: TocContext;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_OUTLINE_NOTICE]: OutlineNotice;
  }
}
