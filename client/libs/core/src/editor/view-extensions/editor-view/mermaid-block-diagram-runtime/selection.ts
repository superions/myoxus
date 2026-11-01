// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import type {
  BlockReactHostProps,
  BlockParentAction,
  MermaidGfxObjectEditIntent,
} from "@virgultum/block-mermaid";
/** Native toolbar drafts are ephemeral UI; Source and geometry remain at the family port. */
export function useBlockSelection(
  props: BlockReactHostProps,
): BlockReactHostProps {
  const [parentIntent, setParentIntent] = useState<BlockParentAction | null>(
    null,
  );
  const [intent, setIntent] = useState<MermaidGfxObjectEditIntent | null>(null);
  const [placement, setPlacement] = useState<{
    centerX: number;
    centerY: number;
  } | null>(null);
  const [placementPending, setPlacementPending] = useState(false);
  const [, refreshViewport] = useState(0);
  const { subscribeViewportChange } = props;
  useEffect(
    () =>
      subscribeViewportChange?.(() => refreshViewport((value) => value + 1)),
    [subscribeViewportChange],
  );
  const cancelPlacement = useRef<(() => void) | null>(null);
  const { subscribeEditIntent } = props;
  useEffect(() => () => cancelPlacement.current?.(), []);
  useEffect(() => {
    cancelPlacement.current?.();
    cancelPlacement.current = null;
    setPlacementPending(false);
    setPlacement(null);
  }, [props.sourceBasis, props.readonly]);
  useEffect(
    () =>
      subscribeEditIntent?.((next) => {
        setParentIntent(next.action === "delete" ? "deleteSelection" : null);
        setIntent(
          next.action === "select" || next.action === "delete" ? null : next,
        );
      }),
    [subscribeEditIntent],
  );
  const key = props.selected
    ? `${props.selected.kind}:${props.selected.key}`
    : "";
  useEffect(() => {
    setIntent(null);
    setParentIntent(null);
  }, [
    key,
    props.surface,
    props.selected?.kind,
    props.selected?.key,
    props.selected?.ownerKey,
  ]);
  useEffect(() => {
    if (props.surface !== "controls") return;
    const handler = (event: KeyboardEvent) => {
      if (
        props.readonly ||
        !props.selectedKeys.length ||
        !["Delete", "Backspace", "Enter"].includes(event.key) ||
        (event.target instanceof Element &&
          event.target.closest(
            "input,textarea,select,button,[role=combobox],[role=dialog],[contenteditable]",
          ))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Enter" && props.selected) {
        setParentIntent(null);
        setIntent({
          kind:
            props.selected.kind === "connection"
              ? "edge"
              : props.selected.kind === "composite"
                ? "subgraph"
                : "node",
          id: props.selected.key,
          ownerId: props.selected.ownerKey,
        });
      } else {
        setIntent(null);
        setParentIntent("deleteSelection");
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [props.surface, props.readonly, props.selectedKeys, props.selected]);
  if (props.surface !== "controls") return props;
  const closeSelection = () => {
    setIntent(null);
    setParentIntent(null);
    props.resolveReturnFocusTarget()?.focus({ preventScroll: true });
  };
  return {
    ...props,
    parentIntent,
    intent,
    placement,
    placementPending,
    onParentIntent: (value) => {
      cancelPlacement.current?.();
      cancelPlacement.current = null;
      setIntent(null);
      setPlacementPending(false);
      if (!value) closeSelection();
      else if (value === "addBlock" && props.requestPlacement) {
        setParentIntent(null);
        setPlacementPending(true);
        cancelPlacement.current = props.requestPlacement(
          (point) => {
            setPlacementPending(false);
            setPlacement(point);
            cancelPlacement.current = null;
            setParentIntent("addBlock");
          },
          () => setPlacementPending(false),
        );
      } else setParentIntent(value);
    },
    onEditIntent: (value) => {
      // Native forms close by clearing their intent. Return focus through the
      // same owner as explicit dismissal so the next Canvas shortcut works.
      if (!value) {
        closeSelection();
        return;
      }
      setParentIntent(null);
      setIntent(value);
    },
    onCloseSelection: closeSelection,
  };
}
