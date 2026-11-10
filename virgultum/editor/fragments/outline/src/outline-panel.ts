import { EditorChromeHostIdentifier } from "@virgultum/shared/services";
import {
  type EditorHost,
  PropTypes,
  requiredProperties,
  ShadowlessElement,
} from "@virgultum/std";
import { html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { defaultOutlinePanelLabels, type OutlinePanelLabels } from "./config";
import { DocumentOutlineController } from "./document-outline-controller";

export const MYOXUS_OUTLINE_PANEL = "myoxus-outline-panel";
export type OutlinePanelSettings = {
  enableSorting: boolean;
  isEdgelessMode: boolean;
  showIcons: boolean;
};

/** Imperative editor mounts adapt the same native controller consumed directly by Core. */
@requiredProperties({ editor: PropTypes.object })
export class OutlinePanel extends ShadowlessElement {
  private controller?: DocumentOutlineController;
  private stopSettings?: () => void;
  private settingsIdentity = "";

  override willUpdate(changed: PropertyValues<this>) {
    if (
      !this.controller ||
      [
        "editor",
        "labels",
        "compactWindowRadius",
        "fitPadding",
        "hideHeader",
      ].some((key) => changed.has(key as keyof OutlinePanel))
    ) {
      this.stopSettings?.();
      this.controller = this.editor
        ? new DocumentOutlineController(this.editor, {
            labels: this.labels,
            compactWindowRadius: this.compactWindowRadius,
            hideHeader: this.hideHeader,
            fitPadding: this.fitPadding,
          })
        : undefined;
      this.stopSettings = this.controller?.subscribe(() => {
        const detail = this.getSettings(),
          identity = JSON.stringify(detail);
        if (identity !== this.settingsIdentity) {
          this.settingsIdentity = identity;
          this.dispatchEvent(
            new CustomEvent("myoxus-outline-settings-change", {
              detail,
              bubbles: true,
              composed: true,
            }),
          );
        }
      });
    }
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopSettings?.();
    this.stopSettings = undefined;
    this.controller = undefined;
  }
  getSettings(): OutlinePanelSettings {
    const state = this.controller?.getSnapshot();
    return {
      enableSorting: state?.sorting ?? false,
      isEdgelessMode: state?.edgeless ?? false,
      showIcons: state?.showIcons ?? false,
    };
  }
  setEnableSorting(value: boolean) {
    if (this.controller && this.getSettings().enableSorting !== value)
      this.controller.toggleSorting();
  }
  setShowIcons(value: boolean) {
    if (this.controller && this.getSettings().showIcons !== value)
      this.controller.toggleIcons();
  }
  override render() {
    return this.controller
      ? html`${this.editor.std.getOptional(EditorChromeHostIdentifier)?.renderDocumentOutline(this.controller)}`
      : html``;
  }
  @property({ attribute: false }) accessor compactWindowRadius = 0;
  @property({ attribute: false }) accessor editor!: EditorHost;
  @property({ attribute: false }) accessor fitPadding: number[] = [];
  @property({ attribute: false }) accessor hideHeader = false;
  @property({ attribute: false }) accessor labels: OutlinePanelLabels =
    defaultOutlinePanelLabels;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_OUTLINE_PANEL]: OutlinePanel;
  }
}
