import type { CalloutBlockModel } from "@virgultum/core/models";
import type { BlockStdScope } from "@virgultum/core/runtime";
import {
  EditorChromeHostIdentifier,
  type IconData,
  mountInlinePopup,
} from "@virgultum/core/services";

export interface IconPickerWrapperProps {
  onSelect?: (iconData?: IconData) => void;
  onClose?: () => void;
}

/** The same picker session serves the document glyph and the selection toolbar. */
export function openCalloutIconPicker(
  std: BlockStdScope,
  model: CalloutBlockModel,
  anchor: HTMLElement,
  onClose?: () => void,
) {
  const store = std.store;
  const chrome = std.getOptional(EditorChromeHostIdentifier);
  if (
    !chrome?.mountIconPicker ||
    store.readonly ||
    store.getModelById(model.id) !== model
  ) {
    return;
  }

  const abort = new AbortController();
  const close = () => {
    if (!abort.signal.aborted) abort.abort();
  };
  if (onClose) {
    abort.signal.addEventListener("abort", onClose, { once: true });
  }

  const mountIconPicker = chrome.mountIconPicker;
  mountInlinePopup(
    std,
    () => (anchor.isConnected ? anchor : null),
    (root, controls) =>
      mountIconPicker(root, {
        ...controls,
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
      }),
    abort,
    () => {
      if (anchor.isConnected) anchor.focus();
    },
  );
  return close;
}
