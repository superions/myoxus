import type { IconData } from "@virgultum/shared/services";
import type { UniComponent, UniComponentReturn } from "@virgultum/shared/types";
import { ShadowlessElement } from "@virgultum/std";
import { html } from "lit";
import { ref } from "lit/directives/ref.js";

export interface IconPickerWrapperProps {
  onSelect?: (iconData?: IconData) => void;
  onClose?: () => void;
}

export class IconPickerWrapper extends ShadowlessElement {
  iconPickerComponent?: UniComponent<IconPickerWrapperProps>;
  props?: IconPickerWrapperProps;
  private _picker?: UniComponentReturn<IconPickerWrapperProps>;

  // The popup owns the React portal lifetime, including disconnect/reconnect.
  private readonly _mountPicker = (element?: Element) => {
    this._picker?.unmount();
    this._picker =
      element instanceof HTMLElement
        ? this.iconPickerComponent?.(element, this.props ?? {}, () => {})
        : undefined;
  };

  override render() {
    if (!this.iconPickerComponent) {
      return html``;
    }

    return html`<div ${ref(this._mountPicker)}></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "icon-picker-wrapper": IconPickerWrapper;
  }
}
