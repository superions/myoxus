import { consumeMyoxusEditorEscape } from "@virgultum/shared/utils";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { SortIcon } from "@myoxus/icons";
import { Alert, IconButton, Stack, MyoxusText } from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type GitGraphReactHostProps,
  type GitGraphInsertAnchor,
} from "@virgultum/block-mermaid";
/** Explicit temporal handle: generic canvas drag never enters this command. */
export function GitGraphReorderHandle({
  props,
  onOpen,
}: {
  props: GitGraphReactHostProps;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const [target, setTarget] = useState<GitGraphInsertAnchor | null>(null),
    [error, setError] = useState<string | undefined>(),
    latest = useRef(props),
    basis = useRef(props.sourceBasis),
    dragged = useRef(false),
    dispose = useRef<(() => void) | null>(null);
  latest.current = props;
  useEffect(() => () => dispose.current?.(), []);
  useEffect(() => {
    dispose.current?.();
    basis.current = props.sourceBasis;
    setTarget(null);
  }, [props.sourceBasis, props.readonly, props.selected?.sourceKey]);
  const execute = (preview: boolean, anchor: GitGraphInsertAnchor) => {
    const p = latest.current;
    if (p.selectionProblem) {
      setError(p.selectionProblem);
      return;
    }
    const result = (preview ? p.onPreview : p.onCommand)(
      "moveGitGraphStatements",
      [p.selectedKeys, anchor],
      basis.current,
    );
    setError(result.diagnostic);
    if (result.changed && result.sourceBasis)
      basis.current = result.sourceBasis;
    return result;
  };
  const records = props.model.sourceDocument!.records.filter(
    (r) =>
      !props.selectedKeys.includes(r.sourceKey) &&
      ["commit", "branch", "checkout", "merge", "cherry-pick"].includes(r.kind),
  );
  return (
    <Stack>
      <IconButton
        tooltip={m.gitGraphReorder()}
        data-myoxus-editor-keyboard-owner="gitgraph-reorder"
        disabled={props.readonly || !!props.selectionProblem}
        aria-label={m.gitGraphReorder()}
        onClick={(e) => {
          if (!dragged.current) onOpen(e.currentTarget);
        }}
        onKeyDown={(e) => {
          if (!["ArrowUp", "ArrowDown", "Escape", "Enter"].includes(e.key))
            return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") {
            consumeMyoxusEditorEscape(e.nativeEvent);
            props.onCancelPreview();
            setTarget(null);
            return;
          }
          if (e.key === "Enter") {
            if (target) {
              execute(false, target);
              props.onCancelPreview();
              setTarget(null);
            } else onOpen(e.currentTarget);
            return;
          }
          const index = records.findIndex(
              (r) => r.sourceKey === target?.sourceKey,
            ),
            current =
              props.model.sourceDocument!.records.find(
                (r) => r.sourceKey === props.selectedKeys[0],
              )?.range.start ?? 0,
            next =
              index < 0
                ? e.key === "ArrowUp"
                  ? records.findLast((r) => r.range.start < current)
                  : records.find((r) => r.range.start > current)
                : records[index + (e.key === "ArrowUp" ? -1 : 1)];
          if (next) {
            const anchor = {
              sourceKey: next.sourceKey,
              position:
                e.key === "ArrowUp" ? ("before" as const) : ("after" as const),
            };
            setTarget(anchor);
            execute(true, anchor);
          }
        }}
        onPointerDown={(e) => {
          if (props.readonly || props.selectionProblem) return;
          e.preventDefault();
          e.stopPropagation();
          // Preventing canvas pointer selection also suppresses native focus.
          // Keep Escape on this gesture owner instead of the former GFX proxy.
          e.currentTarget.focus({ preventScroll: true });
          // Escape can cancel while the pointer is still held. Keep its release
          // on the handle so the canvas cannot treat it as a fresh object hit.
          e.currentTarget.setPointerCapture(e.pointerId);
          dispose.current?.();
          basis.current = props.sourceBasis;
          dragged.current = false;
          let candidate: GitGraphInsertAnchor | null = null;
          const move = (event: PointerEvent) => {
            dragged.current = true;
            const p = latest.current,
              next = p.resolveSequenceAnchor(
                { left: event.clientX, top: event.clientY },
                p.selectedKeys[0] ?? "",
              );
            if (
              next?.sourceKey === candidate?.sourceKey &&
              next?.position === candidate?.position
            )
              return;
            candidate = next;
            setTarget(next);
            if (next) execute(true, next);
            else p.onCancelPreview();
          };
          const cleanup = () => {
            document.removeEventListener("pointermove", move, true);
            document.removeEventListener("pointerup", up, true);
            document.removeEventListener("pointercancel", cancel, true);
            document.removeEventListener("keydown", key, true);
            latest.current.onCancelPreview();
            setTarget(null);
            dispose.current = null;
          };
          const up = () => {
            const anchor = candidate;
            if (anchor) execute(false, anchor);
            cleanup();
          };
          const cancel = () => cleanup();
          const key = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
              consumeMyoxusEditorEscape(event);
              event.preventDefault();
              event.stopImmediatePropagation();
              cleanup();
            }
          };
          dispose.current = cleanup;
          document.addEventListener("pointermove", move, true);
          document.addEventListener("pointerup", up, true);
          document.addEventListener("pointercancel", cancel, true);
          document.addEventListener("keydown", key, true);
        }}
      >
        <SortIcon />
      </IconButton>
      {target ? (
        <MyoxusText>
          {target.position === "before"
            ? m.sequenceBefore()
            : m.sequenceAfter()}{" "}
          · {records.find((r) => r.sourceKey === target.sourceKey)?.raw.trim()}
        </MyoxusText>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
    </Stack>
  );
}
