import { WithDisposable } from "@virgultum/global/lit";
import { type EditorHost, ShadowlessElement } from "@virgultum/std";
import { css, html } from "lit";
import { property } from "lit/decorators.js";

const styles = css`
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

export class FramePanel extends WithDisposable(ShadowlessElement) {
  static override styles = styles;

  override render() {
    return html`<div class="frame-panel-container">
      ${
        this.hideHeader
          ? null
          : html`<myoxus-frame-panel-header
              .editorHost=${this.host}
              .labels=${this.labels}
            ></myoxus-frame-panel-header>`
      }
      <myoxus-frame-panel-body
        class="frame-panel-body"
        .editorHost=${this.host}
        .fitPadding=${this.fitPadding}
        .labels=${this.labels}
      ></myoxus-frame-panel-body>
    </div>`;
  }

  @property({ attribute: false })
  accessor fitPadding: number[] = [50, 380, 50, 50];

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor hideHeader = false;

  @property({ attribute: false })
  accessor labels: FramePanelLabels = defaultFramePanelLabels;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_PANEL]: FramePanel;
  }
}
