// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import {
  hasOpenMyoxusUiOverlay,
  hasMyoxusEditorLocalKeyboardTarget,
} from "@virgultum/shared/utils";
import type {
  C4EditorReactHostProps,
  C4Selection,
  C4ParentIntent,
  MermaidGfxObjectEditIntent,
} from "@virgultum/block-mermaid";

/** Selection refers to the real native alias/pair owner or an actual Source record. */
export function resolveC4Selection(
  props: C4EditorReactHostProps,
): C4Selection | null {
  const key =
    props.intent?.ownerId ??
    props.intent?.id ??
    (props.selectedKeys.length === 1 ? props.selectedKeys[0] : undefined);
  if (!key) return null;
  const semantic = [
    ...props.model.elements,
    ...props.model.boundaries,
    ...props.model.relationships,
  ].some((owner) => owner.resolution!.selectionId === key);
  const occurrence =
    props.intent?.kind === "detail" || !semantic
      ? props.model.occurrences.find(
          (o) =>
            o.sourceKey ===
            (props.intent?.kind === "detail" ? props.intent.id : key),
        )
      : undefined;
  const ownerKey = occurrence?.selectionId ?? key;
  const recordKey = occurrence?.sourceKey;
  const kind = props.model.elements.some(
    (e) => e.resolution!.selectionId === ownerKey,
  )
    ? "element"
    : props.model.boundaries.some((b) => b.resolution!.selectionId === ownerKey)
      ? "boundary"
      : props.model.relationships.some(
            (r) => r.resolution!.selectionId === ownerKey,
          )
        ? "relationship"
        : null;
  return kind ? { kind, key: ownerKey, recordKey } : null;
}

/** Native toolbar intent is ephemeral; Page intent stays at its existing host. */
export function useC4Selection(input: C4EditorReactHostProps) {
  const [nativeIntent, setNativeIntent] =
    useState<MermaidGfxObjectEditIntent | null>(input.intent);
  const [nativeParent, setNativeParent] = useState<C4ParentIntent | null>(
    input.parentIntent,
  );
  const subscribe = input.subscribeEditIntent;
  useEffect(
    () =>
      subscribe?.((intent) => {
        setNativeIntent(intent);
        setNativeParent(null);
      }),
    [subscribe],
  );
  const controls = input.surface === "controls";
  const props: C4EditorReactHostProps = controls
    ? {
        ...input,
        intent: nativeIntent,
        parentIntent: nativeParent,
        onEditIntent: (intent) => {
          setNativeParent(null);
          setNativeIntent(intent);
        },
        onParentIntent: (intent) => {
          setNativeIntent(null);
          setNativeParent(intent);
        },
        onCloseSelection: () => {
          setNativeIntent(null);
          setNativeParent(null);
          input.onCloseSelection();
        },
      }
    : input;
  const selected = resolveC4Selection(props);
  const identity = `${selected?.kind ?? ""}:${selected?.key ?? ""}:${selected?.recordKey ?? ""}:${[...props.selectedKeys].sort().join("\0")}`;
  const signature = `${input.sourceBasis}\0${input.readonly}\0${input.displayOnly}`;
  const previous = useRef(signature);
  useEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;
    if (controls) {
      setNativeIntent(null);
      setNativeParent(null);
    }
    if (props.intent || props.parentIntent) props.onCloseSelection();
  }, [
    signature,
    controls,
    props.intent,
    props.parentIntent,
    props.onCloseSelection,
  ]);
  useEffect(() => {
    if (!controls) return;
    const handler = (event: KeyboardEvent) => {
      if (
        input.readonly ||
        input.displayOnly ||
        hasOpenMyoxusUiOverlay(event) ||
        hasMyoxusEditorLocalKeyboardTarget(event) ||
        !input.selectedKeys.length ||
        !input.selectedKeys.every((key) =>
          [
            ...input.model.elements,
            ...input.model.boundaries,
            ...input.model.relationships,
          ].some((owner) => owner.resolution!.selectionId === key),
        ) ||
        !["Delete", "Backspace"].includes(event.key) ||
        (event.target instanceof Element &&
          event.target.closest("input,textarea,select,[contenteditable]"))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setNativeIntent(null);
      setNativeParent("deleteSelection");
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [
    controls,
    input.readonly,
    input.displayOnly,
    input.selectedKeys,
    input.model,
  ]);
  useEffect(() => {
    if (!controls || !nativeIntent) return;
    const key = nativeIntent.ownerId ?? nativeIntent.id;
    if (!input.selectedKeys.includes(key)) {
      setNativeIntent(null);
      setNativeParent(null);
    }
  }, [controls, nativeIntent, input.selectedKeys]);
  const kind =
    selected?.kind === "element"
      ? "node"
      : selected?.kind === "boundary"
        ? "subgraph"
        : "edge";
  const anchor = selected
    ? props.resolveVisualAnchor(kind, selected.key, true)
    : null;
  return { props: { ...props, draftIdentity: identity }, selected, anchor };
}
