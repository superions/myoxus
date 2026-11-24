import type { IconData } from "@virgultum/core/services";
import { IconPickerServiceIdentifier } from "@virgultum/core/services";
import type { CalloutBlockModel } from "@virgultum/core/models";
import type { UniComponent, UniComponentReturn } from "@virgultum/core/types";
import { type BlockStdScope, NativeViewElement } from "@virgultum/core/runtime";
import { cssVar } from "@myoxus/theme";
import {
  createPopup,
  popupTargetFromElement,
} from "@virgultum/core/view/portal";

export interface IconPickerWrapperProps {
  onSelect?: (iconData?: IconData) => void;
  onClose?: () => void;
}

export class IconPickerWrapper extends NativeViewElement {
  iconPickerComponent?: UniComponent<IconPickerWrapperProps>;
  props?: IconPickerWrapperProps;
  private picker?: UniComponentReturn<IconPickerWrapperProps>;
  connectedCallback() {
    this.picker = this.iconPickerComponent?.(this, this.props ?? {}, () => {});
  }
  disconnectedCallback() {
    this.picker?.unmount();
    this.picker = undefined;
  }
}

/** The same picker session serves the document glyph and the selection toolbar. */
export function openCalloutIconPicker(
  std: BlockStdScope,
  model: CalloutBlockModel,
  anchor: HTMLElement,
  onClose?: () => void,
) {
  const store = std.store;
  const component = std.getOptional(
    IconPickerServiceIdentifier,
  )?.iconPickerComponent;
  if (!component || store.readonly || store.getModelById(model.id) !== model)
    return;
  const wrapper = anchor.ownerDocument.createElement("icon-picker-wrapper");
  wrapper.iconPickerComponent = component;
  wrapper.props = {
    onSelect(icon) {
      if (!store.readonly && store.getModelById(model.id) === model) {
        store.captureSync();
        store.updateBlock(model, () => {
          model.props.icon = icon;
        });
        store.captureSync();
      }
      close();
    },
    onClose: () => close(),
  };
  wrapper.style.position = "absolute";
  wrapper.style.backgroundColor = cssVar("backgroundOverlayPanelColor");
  wrapper.style.boxShadow = "var(--myoxus-menu-shadow)";
  wrapper.style.borderRadius = "var(--mantine-radius-md)";
  const close = createPopup(popupTargetFromElement(anchor), wrapper, {
    onClose,
  });
  return close;
}

declare global {
  interface HTMLElementTagNameMap {
    "icon-picker-wrapper": IconPickerWrapper;
  }
}
