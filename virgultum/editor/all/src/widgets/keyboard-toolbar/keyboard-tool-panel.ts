import { SignalWatcher, WithDisposable } from "@virgultum/core/primitives/lit";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  resolveLegacyEditorText,
} from "@virgultum/core/services";
import {
  PropTypes,
  requiredProperties,
  ShadowlessElement,
} from "@virgultum/core/runtime";
import { nothing } from "lit";
import { property } from "lit/decorators.js";

import type {
  KeyboardToolbarActionItem,
  KeyboardToolbarContext,
  KeyboardToolPanelConfig,
  KeyboardToolPanelGroup,
} from "./config.js";

export const MYOXUS_KEYBOARD_TOOL_PANEL = "myoxus-keyboard-tool-panel";

@requiredProperties({
  context: PropTypes.object,
})
export class MyoxusKeyboardToolPanel extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private readonly _handleItemClick = (item: KeyboardToolbarActionItem) => {
    if (item.disableWhen && item.disableWhen(this.context)) return;
    if (item.action) {
      Promise.resolve(item.action(this.context)).catch(console.error);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    // The parent supplies the measured keyboard height and safe-area padding.
    Object.assign(this.style, { display: "block", boxSizing: "border-box" });
  }

  override render() {
    if (!this.config) return nothing;
    const i18n = this.context.std.getOptional(EditorI18nProvider) ?? undefined;
    const text = (label: string) =>
      resolveLegacyEditorText(label, i18n) ?? label;
    const groups = this.config.groups
      .map((group) =>
        typeof group === "function" ? group(this.context) : group,
      )
      .filter((group): group is KeyboardToolPanelGroup => group !== null)
      .map((group) => ({
        label: text(group.name),
        actions: group.items
          .filter((item) => item.showWhen?.(this.context) ?? true)
          .map((item, index) => ({
            id: `${group.name}:${index}`,
            label: text(item.name),
            icon:
              typeof item.icon === "function"
                ? item.icon(this.context)
                : item.icon,
            disabled: item.disableWhen?.(this.context) ?? false,
            run: () => this._handleItemClick(item),
          })),
      }));
    return (
      this.context.std
        .getOptional(EditorChromeHostIdentifier)
        ?.renderKeyboardPanel({ groups }) ?? nothing
    );
  }

  @property({ attribute: false })
  accessor config: KeyboardToolPanelConfig | null = null;

  @property({ attribute: false })
  accessor context!: KeyboardToolbarContext;
}
