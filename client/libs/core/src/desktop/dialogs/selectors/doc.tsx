// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  DialogComponentProps,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { Modal } from "@myoxus/ui-facade";
import { useCallback, useRef, useState } from "react";

import { DocPicker } from "./doc-picker";

export const DocSelectorDialog = ({
  close,
  init: selectedDocIds,
  multiple,
  extraFilters,
  returnFocusRef,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["doc-selector"]>) => {
  const [open, setOpen] = useState(true);
  const resultRef = useRef<string[] | undefined>(undefined);

  const requestClose = useCallback(
    (result?: string[]) => {
      if (!open) return;
      resultRef.current = result;
      setOpen(false);
    },
    [open],
  );

  return (
    <Modal
      open={open}
      returnFocusRef={returnFocusRef}
      onExitTransitionEnd={() => close(resultRef.current)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose();
      }}
      withoutCloseButton
      width="lg"
    >
      <DocPicker
        init={selectedDocIds}
        multiple={multiple}
        extraFilters={extraFilters}
        onCancel={() => requestClose()}
        onConfirm={(value) => requestClose(value)}
      />
    </Modal>
  );
};
