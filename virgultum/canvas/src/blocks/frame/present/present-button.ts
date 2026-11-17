import {
  EdgelessToolbarToolMixin,
  QuickToolMixin,
} from "../../../widgets/edgeless-toolbar/index";
import {
  EditorI18nProvider,
  EditorChromeHostIdentifier,
  resolveLegacyEditorText,
} from "@virgultum/core/services";
import { css, html, nothing } from "lit";
import { ShadowlessElement } from "@virgultum/core/runtime";

import { PresentTool } from "../present-tool";

export class EdgelessPresentButton extends QuickToolMixin(
  EdgelessToolbarToolMixin(ShadowlessElement),
) {
  static override styles = css`
    edgeless-present-button {
      display: flex;
    }
  `;

  override type = PresentTool;

  override render() {
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    const text = (value: string) =>
      resolveLegacyEditorText(value, i18n) ?? value;

    return html`<span class="edgeless-frame-navigator-button">
      ${
        this.edgeless.std
          .getOptional(EditorChromeHostIdentifier)
          ?.renderCanvasTool({
            action: {
              id: "presentation-start",
              icon: "PresentationIcon",
              label: text("Present"),
              disabled: false,
              run: () => this.setEdgelessTool(PresentTool),
            },
          }) ?? nothing
      }
    </span>`;
  }
}
