import { PresentationIcon } from "@myoxus/icons/lit";
import {
  EdgelessToolbarToolMixin,
  QuickToolMixin,
} from "@virgultum/widget-edgeless-toolbar";
import {
  EditorI18nProvider,
  resolveLegacyEditorText,
} from "@virgultum/shared/services";
import { css, html, LitElement } from "lit";

import { PresentTool } from "../present-tool";

export class EdgelessPresentButton extends QuickToolMixin(
  EdgelessToolbarToolMixin(LitElement),
) {
  static override styles = css`
    :host {
      display: flex;
    }
    .edgeless-note-button {
      display: flex;
      position: relative;
    }
  `;

  override type = PresentTool;

  override render() {
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    const text = (value: string) =>
      resolveLegacyEditorText(value, i18n) ?? value;

    return html`<edgeless-tool-icon-button
    class="edgeless-frame-navigator-button"
    .tooltip=${text("Present")}
    .tooltipOffset=${17}
    .iconContainerPadding=${6}
    .iconSize=${"24px"}
    @click=${() => {
      this.setEdgelessTool(PresentTool);
    }}
  >
    ${PresentationIcon()}
    </edgeless-tool-icon-button>
  </div>`;
  }
}
