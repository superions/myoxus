// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import type {
  MermaidPacketReactHostProps,
  MermaidPacketModel,
} from "@virgultum/block-mermaid";
export function packetSelectedField(model: MermaidPacketModel, key?: string) {
  return model.fields.find((field) => field.id === key);
}

/** Session selection and focus are transient; the host owns history identity. */
export function usePacketSelection(props: MermaidPacketReactHostProps) {
  const [selection, setSelection] = useState(props.selection);
  // A pointer can select and cancel its predecessor before React rerenders.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selectionRow = useRef<{ fieldKey: string; row: number } | undefined>(
    undefined,
  );
  const [focusRequest, setFocusRequest] = useState<{
    fieldId?: string;
    requestId: number;
  }>();
  const sequence = useRef(0);
  const select = (fieldId?: string) => {
    selectionRef.current = fieldId;
    setSelection(fieldId);
    props.onSelectionChange(fieldId);
  };
  const focus = (fieldId?: string) =>
    setFocusRequest({ fieldId, requestId: ++sequence.current });
  useEffect(() => {
    selectionRef.current = props.selection;
    setSelection(props.selection);
  }, [props.selection]);
  const clearFocus = () => setFocusRequest(undefined);
  return {
    selection,
    selectionRef,
    selectionRow,
    focusRequest,
    select,
    focus,
    clearFocus,
  };
}
