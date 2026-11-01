// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { GripVerticalIcon } from "@myoxus/icons";
import { IconButton, Alert } from "@myoxus/ui-facade";
import {
  readC4RelationshipAppearance,
  type C4ReactHostProps,
} from "@virgultum/block-mermaid";

type Offset = { offsetX: number; offsetY: number };
/** Pointer and keyboard drafts share the Source command; only release/Enter writes history. */
export function C4LabelOffsetHandle({
  props,
  selectionId,
}: {
  props: C4ReactHostProps;
  selectionId: string;
}) {
  const t = useI18n(),
    latest = useRef(props),
    candidate = useRef<Offset | null>(null),
    gesture = useRef<(() => void) | null>(null),
    preview = useRef<(() => void) | null>(null),
    basis = useRef(props.sourceBasis),
    viewport = useRef(props.viewportIdentity),
    [diagnostic, setDiagnostic] = useState<string | null>(null);
  latest.current = props;
  const clearPreview = () => {
    preview.current?.();
    preview.current = null;
  };
  const cancel = () => {
    gesture.current?.();
    gesture.current = null;
    clearPreview();
    candidate.current = null;
  };
  useEffect(() => {
    cancel();
    basis.current = props.sourceBasis;
    viewport.current = props.viewportIdentity;
    setDiagnostic(null);
    return cancel;
  }, [
    props.sourceBasis,
    props.readonly,
    props.displayOnly,
    props.viewportIdentity,
    selectionId,
  ]);
  const writable = () =>
    !latest.current.readonly &&
    !latest.current.displayOnly &&
    basis.current === latest.current.sourceBasis &&
    viewport.current === latest.current.viewportIdentity;
  const stage = (offset: Offset) => {
    clearPreview();
    if (!writable()) {
      candidate.current = null;
      return;
    }
    candidate.current = offset;
    const result = latest.current.previewCommand?.(
      "editC4RelationshipAppearance",
      [selectionId, offset],
      basis.current,
    );
    preview.current = result?.dispose ?? null;
    setDiagnostic(result?.feedback.diagnostic ?? null);
    if (result?.feedback.diagnostic) candidate.current = null;
  };
  const commit = () => {
    const offset = candidate.current;
    cancel();
    if (!offset || !writable()) return;
    const result = latest.current.onCommand(
      "editC4RelationshipAppearance",
      [selectionId, offset],
      basis.current,
    );
    if (result.changed && result.sourceBasis !== undefined)
      basis.current = result.sourceBasis;
    setDiagnostic(result.diagnostic ?? null);
  };
  return (
    <>
      <IconButton
        aria-label={t["com.myoxus.editor.mermaid.c4-label-offset"]()}
        disabled={props.readonly || props.displayOnly || !props.previewCommand}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            ![
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Enter",
              "Escape",
            ].includes(event.key)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            cancel();
            setDiagnostic(null);
            return;
          }
          if (!writable()) return;
          if (event.key === "Enter") {
            commit();
            return;
          }
          gesture.current?.();
          gesture.current = null;
          const current =
            candidate.current ??
            readC4RelationshipAppearance(latest.current.model, selectionId);
          stage({
            offsetX:
              current.offsetX +
              (event.key === "ArrowRight"
                ? 1
                : event.key === "ArrowLeft"
                  ? -1
                  : 0),
            offsetY:
              current.offsetY +
              (event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowUp"
                  ? -1
                  : 0),
          });
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !writable() || !props.resolveViewportPoint)
            return;
          event.preventDefault();
          event.stopPropagation();
          cancel();
          const start = props.resolveViewportPoint({
            left: event.clientX,
            top: event.clientY,
          });
          if (!start) return;
          const initial = readC4RelationshipAppearance(
              props.model,
              selectionId,
            ),
            pointerId = event.pointerId;
          const move = (event: PointerEvent) => {
            if (event.pointerId !== pointerId) return;
            if (!writable()) {
              cancel();
              return;
            }
            const point = latest.current.resolveViewportPoint?.({
              left: event.clientX,
              top: event.clientY,
            });
            if (!point) {
              clearPreview();
              candidate.current = null;
              return;
            }
            stage({
              offsetX: Math.trunc(initial.offsetX + point.x - start.x),
              offsetY: Math.trunc(initial.offsetY + point.y - start.y),
            });
          };
          const cleanup = () => {
            document.removeEventListener("pointermove", move, true);
            document.removeEventListener("pointerup", up, true);
            document.removeEventListener("pointercancel", abort, true);
          };
          const up = (event: PointerEvent) => {
            if (event.pointerId !== pointerId) return;
            move(event);
            commit();
          };
          const abort = (event: PointerEvent) => {
            if (event.pointerId === pointerId) cancel();
          };
          gesture.current = cleanup;
          document.addEventListener("pointermove", move, true);
          document.addEventListener("pointerup", up, true);
          document.addEventListener("pointercancel", abort, true);
        }}
      >
        <GripVerticalIcon />
      </IconButton>
      {diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {diagnostic}
        </Alert>
      ) : null}
    </>
  );
}
