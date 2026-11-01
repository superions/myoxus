import { provide } from "@lit/context";
import { effect, signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { DocModeProvider } from "@virgultum/shared/services";
import {
  type EditorHost,
  PropTypes,
  requiredProperties,
  ShadowlessElement,
} from "@virgultum/std";
import { html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";

import {
  defaultOutlinePanelLabels,
  type OutlinePanelLabels,
  outlineSettingsKey,
  type TocContext,
  tocContext,
} from "./config.js";
import * as styles from "./outline-panel.styles";

export const MYOXUS_OUTLINE_PANEL = "myoxus-outline-panel";

const trackSignalDependencies = (...values: readonly unknown[]) =>
  values.length;

export type OutlinePanelSettings = {
  enableSorting: boolean;
  isEdgelessMode: boolean;
  showIcons: boolean;
};

@requiredProperties({
  editor: PropTypes.object,
})
export class OutlinePanel extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private _getEditorMode(host: EditorHost) {
    const docModeService = host.std.get(DocModeProvider);
    const mode = docModeService.getEditorMode();
    return mode;
  }

  private _emitSettingsChange() {
    this.dispatchEvent(
      new CustomEvent<OutlinePanelSettings>("myoxus-outline-settings-change", {
        bubbles: true,
        composed: true,
        detail: this.getSettings(),
      }),
    );
  }

  private _setContext() {
    this._context = {
      compactWindowRadius$: signal<number>(this.compactWindowRadius),
      editor$: signal(this.editor),
      showIcons$: signal<boolean>(false),
      enableSorting$: signal<boolean>(false),
      fitPadding$: signal<number[]>(this.fitPadding),
      labels$: signal<OutlinePanelLabels>(this.labels),
    };

    this.disposables.add(
      effect(() => {
        const settingsString = localStorage.getItem(outlineSettingsKey);
        const settings = settingsString ? JSON.parse(settingsString) : null;

        if (settings) {
          this._context.showIcons$.value = settings.showIcons;
        }

        const editor = this._context.editor$.value;
        if (this._getEditorMode(editor) === "edgeless") {
          this._context.enableSorting$.value = true;
        } else if (settings) {
          this._context.enableSorting$.value = settings.enableSorting;
        }
      }),
    );

    this.disposables.add(
      effect(() => {
        trackSignalDependencies(
          this._context.showIcons$.value,
          this._context.enableSorting$.value,
          this._context.editor$.value,
        );
        this._emitSettingsChange();
      }),
    );
  }

  private _watchSettingsChange() {
    this.disposables.add(
      effect(() => {
        if (this._getEditorMode(this._context.editor$.value) === "edgeless")
          return;

        const showPreviewIcon = this._context.showIcons$.value;
        const enableNotesSorting = this._context.enableSorting$.value;
        localStorage.setItem(
          outlineSettingsKey,
          JSON.stringify({
            showIcons: showPreviewIcon,
            enableSorting: enableNotesSorting,
          }),
        );
      }),
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    this.classList.add(styles.outlinePanel);

    this._setContext();
    this._watchSettingsChange();
  }

  getSettings(): OutlinePanelSettings {
    if (!this._context || !this.editor) {
      return {
        enableSorting: false,
        isEdgelessMode: false,
        showIcons: false,
      };
    }

    const isEdgelessMode =
      this._getEditorMode(this._context.editor$.value) === "edgeless";

    return {
      enableSorting: this._context.enableSorting$.value,
      isEdgelessMode: !!isEdgelessMode,
      showIcons: this._context.showIcons$.value,
    };
  }

  setEnableSorting(enableSorting: boolean) {
    if (!this._context) return;
    if (this._getEditorMode(this._context.editor$.value) === "edgeless") {
      this._context.enableSorting$.value = true;
      return;
    }
    this._context.enableSorting$.value = enableSorting;
  }

  setShowIcons(showIcons: boolean) {
    if (!this._context) return;
    this._context.showIcons$.value = showIcons;
  }

  override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has("editor")) {
      this._context.editor$.value = this.editor;
    }
    if (changedProperties.has("compactWindowRadius")) {
      this._context.compactWindowRadius$.value = this.compactWindowRadius;
    }
    if (changedProperties.has("fitPadding")) {
      this._context.fitPadding$.value = this.fitPadding;
    }
    if (changedProperties.has("labels")) {
      this._context.labels$.value = this.labels;
    }
  }

  override render() {
    if (!this.editor) return;

    return html`
      ${
        this.hideHeader
          ? null
          : html`<myoxus-outline-panel-header></myoxus-outline-panel-header>`
      }
      <myoxus-outline-panel-body> </myoxus-outline-panel-body>
      <myoxus-outline-notice></myoxus-outline-notice>
    `;
  }

  @provide({ context: tocContext })
  private accessor _context!: TocContext;

  @property({ attribute: false })
  accessor compactWindowRadius = 0;

  @property({ attribute: false })
  accessor editor!: EditorHost;

  @property({ attribute: false })
  accessor fitPadding!: number[];

  @property({ attribute: false })
  accessor hideHeader = false;

  @property({ attribute: false })
  accessor labels: OutlinePanelLabels = defaultOutlinePanelLabels;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_OUTLINE_PANEL]: OutlinePanel;
  }
}
