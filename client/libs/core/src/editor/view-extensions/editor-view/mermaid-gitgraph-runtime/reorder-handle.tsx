import { consumeMyoxusEditorEscape } from "@virgultum/core/utils";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { SortIcon } from "@myoxus/icons";
import { Alert, IconButton, Stack, MyoxusText } from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type GitGraphReactHostProps,
  type GitGraphInsertAnchor,
} from "@virgultum/block-mermaid";
import { useMermaidCaptureDrag } from "../mermaid-runtime-portal";
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
    drag = useMermaidCaptureDrag();
  latest.current = props;
  useEffect(() => {
    drag.cancel();
    basis.current = props.sourceBasis;
    setTarget(null);
  }, [props.sourceBasis, props.readonly, props.selected?.sourceKey, drag]);
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
          drag.cancel();
          basis.current = props.sourceBasis;
          dragged.current = false;
          let candidate: GitGraphInsertAnchor | null = null;
          const cleanup = drag.start({
            onMove: (event) => {
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
            },
            onUp: () => {
              const anchor = candidate;
              if (anchor) execute(false, anchor);
              cleanup();
            },
            onKeyDown: (event) => {
              if (event.key === "Escape") {
                consumeMyoxusEditorEscape(event);
                event.preventDefault();
                event.stopImmediatePropagation();
                cleanup();
              }
            },
            onCleanup: () => {
              latest.current.onCancelPreview();
              setTarget(null);
            },
          });
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
