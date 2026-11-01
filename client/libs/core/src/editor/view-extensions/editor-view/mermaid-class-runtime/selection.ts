// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import type {
  ClassReactHostProps,
  ClassParentAction,
  MermaidGfxObjectEditIntent,
} from "@virgultum/block-mermaid";
/** Native toolbar drafts are ephemeral UI; Source and geometry remain at the family port. */
export function useClassSelection(
  props: ClassReactHostProps,
): ClassReactHostProps {
  const [parentIntent, setParentIntent] = useState<ClassParentAction | null>(
    null,
  );
  const [intent, setIntent] = useState<MermaidGfxObjectEditIntent | null>(null);
  const [placement, setPlacement] = useState<{
    centerX: number;
    centerY: number;
  } | null>(null);
  const [placementPending, setPlacementPending] = useState(false);
  const cancelPlacement = useRef<(() => void) | null>(null);
  const { subscribeEditIntent } = props;
  useEffect(() => () => cancelPlacement.current?.(), []);
  useEffect(
    () =>
      subscribeEditIntent?.((next) => {
        setParentIntent(null);
        setIntent(next);
      }),
    [subscribeEditIntent],
  );
  const key = props.selected
    ? `${props.selected.kind}:${props.selected.key}`
    : "";
  useEffect(() => {
    setIntent(
      props.surface === "controls" && props.selected?.kind === "member"
        ? {
            kind: "detail",
            id: props.selected.key,
            ownerId: props.selected.ownerKey,
          }
        : null,
    );
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
        !["Delete", "Backspace"].includes(event.key) ||
        (event.target instanceof Element &&
          event.target.closest("input,textarea,select,[contenteditable]"))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIntent(null);
      setParentIntent("deleteSelection");
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [props.surface, props.readonly, props.selectedKeys]);
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
      if (value === "addClass" && props.requestPlacement) {
        setParentIntent(null);
        setPlacementPending(true);
        cancelPlacement.current = props.requestPlacement(
          (point) => {
            setPlacementPending(false);
            setPlacement(point);
            cancelPlacement.current = null;
            setParentIntent("addClass");
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
