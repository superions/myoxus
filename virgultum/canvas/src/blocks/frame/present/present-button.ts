import { QuickToolMixin } from "../../../widgets/edgeless-toolbar/index";
import {
  EditorI18nProvider,
  EditorChromeHostIdentifier,
  resolveLegacyEditorText,
} from "@virgultum/core/services";
import { NativeViewElement } from "@virgultum/core/runtime";

import { PresentTool } from "../present-tool";

export class EdgelessPresentButton extends QuickToolMixin(NativeViewElement) {
  private readonly _btnWrap: HTMLSpanElement;

  override type = PresentTool;

  constructor() {
    super();
    this._btnWrap = this.ownerDocument.createElement("span");
    this._btnWrap.className = "edgeless-frame-navigator-button";
  }

  protected override onConnected() {
    this.style.display = "flex";
    if (!this._btnWrap.parentElement) {
      this.append(this._btnWrap);
    }
  }

  protected override paint() {
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    const text = (value: string) =>
      resolveLegacyEditorText(value, i18n) ?? value;

    this.mountSlot("tool", this._btnWrap, chrome.mountCanvasTool, {
      action: {
        id: "presentation-start",
        icon: "PresentationIcon",
        label: text("Present"),
        disabled: false,
        run: () => this.setEdgelessTool(PresentTool),
      },
    });
  }
}
