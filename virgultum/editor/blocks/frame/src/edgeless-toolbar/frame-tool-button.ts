import { FrameIcon } from "@myoxus/icons/lit";
import { QuickToolMixin } from "@virgultum/widget-edgeless-toolbar";
import { css, html, LitElement } from "lit";

import { FrameTool } from "../frame-tool";

type EdgelessFrameMenuElement = HTMLElement & {
  edgeless: EdgelessFrameToolButton["edgeless"];
};

export class EdgelessFrameToolButton extends QuickToolMixin(LitElement) {
  static override styles = css`
    :host {
      display: flex;
    }
  `;

  override type = FrameTool;

  private _toggleFrameMenu() {
    if (this.tryDisposePopper()) return;

    const menu = this.createPopper("edgeless-frame-menu" as never, this);
    (menu.element as EdgelessFrameMenuElement).edgeless = this.edgeless;
  }

  override render() {
    const type = this.edgelessTool?.toolType?.toolName;
    return html`
      <edgeless-tool-icon-button
        class="edgeless-frame-button"
        .tooltip=${
          this.popper
            ? ""
            : html`<myoxus-tooltip-content-with-shortcut
                data-tip="${"Frame"}"
                data-shortcut="${"F"}"
              ></myoxus-tooltip-content-with-shortcut>`
        }
        .tooltipOffset=${17}
        .iconSize=${"24px"}
        .active=${type === "frame"}
        .iconContainerPadding=${6}
        @click=${() => {
          // don't update tool before toggling menu
          this._toggleFrameMenu();
          this.setEdgelessTool(FrameTool);
        }}
      >
        ${FrameIcon()}
        <toolbar-arrow-up-icon></toolbar-arrow-up-icon>
      </edgeless-tool-icon-button>
    `;
  }
}
