// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import type {
  ErReactHostProps,
  ErParentAction,
  MermaidGfxObjectEditIntent,
} from "@virgultum/block-mermaid";
/** Native toolbar drafts are ephemeral UI; Source and geometry remain at the family port. */
export function useErSelection(props: ErReactHostProps): ErReactHostProps {
  const [parentIntent, setParentIntent] = useState<ErParentAction | null>(null);
  const [intent, setIntent] = useState<MermaidGfxObjectEditIntent | null>(null);
  const [placement, setPlacement] = useState<{
    centerX: number;
    centerY: number;
  } | null>(null);
  const [placementPending, setPlacementPending] = useState(false);
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
        setParentIntent(null);
        setIntent(next.action === "select" ? null : next);
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
            props.selected.kind === "attribute"
              ? "detail"
              : props.selected.kind === "relation"
                ? "edge"
                : props.selected.kind === "subgraph"
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
      if (value === "addEntity" && props.requestPlacement) {
        setParentIntent(null);
        setPlacementPending(true);
        cancelPlacement.current = props.requestPlacement(
          (point) => {
            setPlacementPending(false);
            setPlacement(point);
            cancelPlacement.current = null;
            setParentIntent("addEntity");
          },
          () => setPlacementPending(false),
        );
      } else setParentIntent(value);
    },
    onEditIntent: (value) => {
      setParentIntent(null);
      setIntent(value);
    },
    onCloseSelection: () => {
      setIntent(null);
      setParentIntent(null);
      props.resolveReturnFocusTarget()?.focus();
    },
  };
}
