// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import type {
  SequenceReactHostProps,
  SequenceParentAction,
  MermaidGfxObjectEditIntent,
} from "@virgultum/block-mermaid";
/** Native toolbar lifetime owns only transient intents; it uses the same ports
 * and persisted owner as Page and embedded Notes. */
export function useSequenceSelection(
  input: SequenceReactHostProps,
): SequenceReactHostProps {
  const [parent, setParent] = useState<SequenceParentAction | null>(null),
    [intent, setIntent] = useState<MermaidGfxObjectEditIntent | null>(null);
  const {
    subscribeEditIntent,
    sourceBasis,
    readonly,
    selected,
    onCancelPreview,
  } = input;
  // A host refresh may replace its port without changing the selected Source
  // object. Cancel on semantic changes, using the current port when it fires.
  const cancelPreview = useRef(onCancelPreview);
  cancelPreview.current = onCancelPreview;
  useEffect(() => {
    cancelPreview.current();
    setParent(null);
    setIntent(null);
  }, [sourceBasis, readonly, selected?.kind, selected?.key]);
  useEffect(
    () =>
      subscribeEditIntent?.((next) => {
        setParent(next.action === "delete" ? "deleteSelection" : null);
        setIntent(
          next.action === "select" || next.action === "delete" ? null : next,
        );
      }),
    [subscribeEditIntent],
  );
  useEffect(() => {
    if (input.surface !== "controls") return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (
        readonly ||
        !input.selectedKeys.length ||
        !["Enter", "Delete", "Backspace"].includes(event.key) ||
        (event.target instanceof Element &&
          event.target.closest(
            "input,textarea,select,button,[role=combobox],[role=dialog],[contenteditable]",
          ))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Enter" && selected) {
        setParent(null);
        setIntent({
          kind:
            selected.kind === "message"
              ? "edge"
              : ["box", "rect", "fragment"].includes(selected.kind)
                ? "subgraph"
                : "node",
          id: selected.visualKey ?? selected.key,
        });
      } else {
        setIntent(null);
        setParent("deleteSelection");
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [input.surface, readonly, input.selectedKeys, selected]);
  if (input.surface !== "controls") return input;
  return {
    ...input,
    parentIntent: parent,
    intent,
    onParentIntent: (value) => {
      onCancelPreview();
      setIntent(null);
      setParent(value);
    },
    onEditIntent: (value) => {
      onCancelPreview();
      setParent(null);
      setIntent(value);
    },
    onCloseSelection: () => {
      onCancelPreview();
      setParent(null);
      setIntent(null);
      input.resolveReturnFocusTarget()?.focus({ preventScroll: true });
    },
  };
}
