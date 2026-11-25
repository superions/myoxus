import { NativeViewElement } from "@virgultum/core/primitives/env";
import type { EditorHost } from "@virgultum/core/runtime";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";

import { defaultOutlinePanelLabels, type OutlinePanelLabels } from "./config";
import { DocumentOutlineController } from "./document-outline-controller";

export const MYOXUS_OUTLINE_PANEL = "myoxus-outline-panel";
export type OutlinePanelSettings = {
  enableSorting: boolean;
  isEdgelessMode: boolean;
  showIcons: boolean;
};

/** Imperative editor mounts adapt the same native controller consumed directly by Core. */
export class OutlinePanel extends NativeViewElement {
  private _compactWindowRadius = 0;
  private _editor!: EditorHost;
  private _fitPadding: number[] = [];
  private _hideHeader = false;
  private _labels: OutlinePanelLabels = defaultOutlinePanelLabels;

  private controller?: DocumentOutlineController;
  private stopSettings?: () => void;
  private settingsIdentity = "";
  private _mountHost: HTMLDivElement | null = null;
  private _chromeUnmount: (() => void) | null = null;

  get compactWindowRadius(): number {
    return this._compactWindowRadius;
  }
  set compactWindowRadius(value: number) {
    if (this._compactWindowRadius === value) return;
    this._compactWindowRadius = value;
    this._rebuild();
  }

  get editor(): EditorHost {
    return this._editor;
  }
  set editor(value: EditorHost) {
    if (this._editor === value) return;
    this._editor = value;
    this._rebuild();
  }

  get fitPadding(): number[] {
    return this._fitPadding;
  }
  set fitPadding(value: number[]) {
    if (this._fitPadding === value) return;
    this._fitPadding = value;
    this._rebuild();
  }

  get hideHeader(): boolean {
    return this._hideHeader;
  }
  set hideHeader(value: boolean) {
    if (this._hideHeader === value) return;
    this._hideHeader = value;
    this._rebuild();
  }

  get labels(): OutlinePanelLabels {
    return this._labels;
  }
  set labels(value: OutlinePanelLabels) {
    if (this._labels === value) return;
    this._labels = value;
    this._rebuild();
  }

  private _cleanup() {
    this._chromeUnmount?.();
    this._chromeUnmount = null;
    this.stopSettings?.();
    this.stopSettings = undefined;
    this.controller = undefined;
  }

  private _rebuild() {
    if (!this.isConnected || !this._mountHost) return;
    this._cleanup();
    if (!this._editor) return;

    this.controller = new DocumentOutlineController(this._editor, {
      labels: this._labels,
      compactWindowRadius: this._compactWindowRadius,
      hideHeader: this._hideHeader,
      fitPadding: this._fitPadding,
    });
    this.stopSettings = this.controller.subscribe(() => {
      const detail = this.getSettings();
      const identity = JSON.stringify(detail);
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

    const chrome = this._editor.std.getOptional(EditorChromeHostIdentifier);
    if (chrome) {
      this._chromeUnmount = chrome.mountDocumentOutline(
        this._mountHost,
        this.controller,
      );
    }
  }

  connectedCallback() {
    if (!this._mountHost) {
      this._mountHost = this.ownerDocument.createElement("div");
      this._mountHost.style.display = "contents";
      this.replaceChildren(this._mountHost);
    }
    this._rebuild();
  }

  disconnectedCallback() {
    this._cleanup();
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
    if (this.controller && this.getSettings().enableSorting !== value) {
      this.controller.toggleSorting();
    }
  }

  setShowIcons(value: boolean) {
    if (this.controller && this.getSettings().showIcons !== value) {
      this.controller.toggleIcons();
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_OUTLINE_PANEL]: OutlinePanel;
  }
}
