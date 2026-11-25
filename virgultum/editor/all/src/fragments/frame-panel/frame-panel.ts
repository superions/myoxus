import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import type { EditorHost } from "@virgultum/core/runtime";

import type { FramePanelBody } from "./body/frame-panel-body.js";
import type { FramePanelHeader } from "./header/frame-panel-header.js";

const STYLE_ID = "myoxus-frame-panel-styles";
const STYLES = `
  myoxus-frame-panel {
    flex-grow: 1;
  }

  frame-panel {
    display: block;
    width: 100%;
    height: 100%;
  }

  .frame-panel-container {
    background-color: var(--myoxus-background-primary-color);
    box-sizing: border-box;

    display: flex;
    flex-direction: column;
    align-items: stretch;

    height: 100%;
    font-family: var(--mantine-font-family-body, var(--mantine-font-family));
    padding: 8px;
  }

  .frame-panel-body {
    padding-top: 12px;
    flex-grow: 1;
    width: 100%;

    overflow: auto;
    overflow-x: hidden;
    scrollbar-width: thin; /* For Firefox */
    scrollbar-color: transparent transparent; /* For Firefox */
  }

  .frame-panel-body::-webkit-scrollbar {
    width: 4px;
  }

  .frame-panel-body::-webkit-scrollbar-thumb {
    border-radius: 2px;
  }

  .frame-panel-body:hover::-webkit-scrollbar-thumb {
    background-color: var(--myoxus-black-30);
  }

  .frame-panel-body::-webkit-scrollbar-track {
    background-color: transparent;
  }

  .frame-panel-body::-webkit-scrollbar-corner {
    display: none;
  }
`;

function ensureStyles(doc: Document) {
  if (!doc.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.append(style);
}

export const MYOXUS_FRAME_PANEL = "myoxus-frame-panel";

export const defaultFramePanelLabels = {
  allFrames: "All frames",
  allFramesSettings: "All frames settings",
  presentation: "Presentation",
  previewSettings: "Preview settings",
  fillScreen: "Fill screen",
  playbackSettings: "Playback settings",
  darkBackground: "Dark background",
  hideToolbar: "Hide toolbar",
  emptyPlaceholder: "Add frames to organize and present your Edgeless.",
};

export type FramePanelLabels = typeof defaultFramePanelLabels;

export class FramePanel extends NativeViewElement {
  disposables = new DisposableGroup();

  private _fitPadding: number[] = [50, 380, 50, 50];
  private _host!: EditorHost;
  private _hideHeader = false;
  private _labels: FramePanelLabels = defaultFramePanelLabels;

  private _container: HTMLDivElement | null = null;
  private _header: FramePanelHeader | null = null;
  private _body: FramePanelBody | null = null;

  get fitPadding(): number[] {
    return this._fitPadding;
  }
  set fitPadding(value: number[]) {
    this._fitPadding = value;
    this._sync();
  }

  get host(): EditorHost {
    return this._host;
  }
  set host(value: EditorHost) {
    this._host = value;
    this._sync();
  }

  get hideHeader(): boolean {
    return this._hideHeader;
  }
  set hideHeader(value: boolean) {
    this._hideHeader = value;
    this._sync();
  }

  get labels(): FramePanelLabels {
    return this._labels;
  }
  set labels(value: FramePanelLabels) {
    this._labels = value;
    this._sync();
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    ensureStyles(this.ownerDocument);
    this._ensureDom();
    this._sync();
  }

  disconnectedCallback() {
    this.disposables.dispose();
  }

  private _ensureDom() {
    if (!this._container) {
      this._container = this.ownerDocument.createElement("div");
      this.replaceChildren(this._container);
    }
    if (!this._body) {
      this._body = this.ownerDocument.createElement(
        "myoxus-frame-panel-body",
      ) as FramePanelBody;
    }
  }

  private _sync() {
    if (!this.isConnected || !this._container || !this._body) return;

    this._container.className = this._hideHeader ? "" : "frame-panel-container";
    this._body.className = this._hideHeader ? "" : "frame-panel-body";
    this._body.editorHost = this._host;
    this._body.fitPadding = this._fitPadding;
    this._body.labels = this._labels;

    if (this._hideHeader) {
      if (this._header?.parentElement === this._container) {
        this._header.remove();
      }
      if (this._body.parentElement !== this._container) {
        this._container.append(this._body);
      }
    } else {
      if (!this._header) {
        this._header = this.ownerDocument.createElement(
          "myoxus-frame-panel-header",
        ) as FramePanelHeader;
      }
      this._header.editorHost = this._host;
      this._header.labels = this._labels;
      if (this._header.parentElement !== this._container) {
        this._container.prepend(this._header);
      }
      if (this._body.parentElement !== this._container) {
        this._container.append(this._body);
      }
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_PANEL]: FramePanel;
  }
}
