// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  nextPacketSourceKey,
  type MermaidPacketModel,
  type PacketCommand,
  type PacketCommandResult,
  type MermaidPacketReactHostProps,
  mermaidMessages as messages,
} from "@virgultum/block-mermaid";
import type { PacketGeometryIntent } from "@myoxus/ui-facade";
export type PacketDraft = {
  kind: "field" | "add" | "split" | "merge" | "delete";
  source: string;
  fieldKey?: string;
  secondKey: string;
  row?: number;
};
export function createPacketDraft(
  kind: PacketDraft["kind"],
  model: MermaidPacketModel,
  fieldKey?: string,
  row?: number,
): PacketDraft {
  return {
    kind,
    source: model.sourceDocument.source,
    fieldKey,
    row,
    secondKey: nextPacketSourceKey(),
  };
}
export type PacketForm = {
  label: string;
  startBit: number;
  endBit: number;
  width: number;
  boundary: number;
  sourceForm: "single" | "range" | "count";
  position: "before" | "after" | "append";
  neighborKey: string;
};
export function packetForm(
  model: MermaidPacketModel,
  draft: PacketDraft,
): PacketForm {
  const field = model.fields.find((f) => f.id === draft.fieldKey);
  return {
    label:
      draft.kind === "add" || draft.kind === "split" || draft.kind === "merge"
        ? ""
        : (field?.label ?? ""),
    startBit: field?.startBit ?? model.totalWidth,
    endBit: field?.endBit ?? model.totalWidth + 7,
    width: 8,
    boundary: field ? field.startBit + Math.floor(field.width / 2) : 0,
    sourceForm:
      draft.kind === "field" ? (field?.sourceForm ?? "range") : "range",
    position: "append",
    neighborKey: "",
  };
}
export function packetDraftCommand(
  draft: PacketDraft,
  form: PacketForm,
): PacketCommand {
  switch (draft.kind) {
    case "add":
      return {
        type: "add-field",
        draft: {
          label: form.label,
          width: form.width,
          position: form.position,
          anchorKey: draft.fieldKey,
          sourceForm: form.sourceForm === "count" ? "count" : "range",
          fieldKey: draft.secondKey,
        },
      };
    case "split":
      return {
        type: "split-field",
        fieldKey: draft.fieldKey!,
        boundary: form.boundary,
        label: form.label,
        sourceForm: form.sourceForm === "count" ? "count" : "range",
        secondKey: draft.secondKey,
      };
    case "merge":
      return {
        type: "merge-fields",
        fieldKey: draft.fieldKey!,
        neighborKey: form.neighborKey,
        label: form.label,
        sourceForm: form.sourceForm === "count" ? "count" : "range",
      };
    case "delete":
      return { type: "delete-field", fieldKey: draft.fieldKey! };
    case "field":
      return {
        type: "edit-field",
        fieldKey: draft.fieldKey!,
        edit: {
          label: form.label,
          startBit: form.startBit,
          endBit: form.endBit,
          sourceForm: form.sourceForm,
        },
      };
  }
}
export function packetGeometryCommand(
  intent: PacketGeometryIntent,
): PacketCommand {
  return intent.kind === "reorder"
    ? {
        type: "reorder-field",
        fieldKey: intent.fieldKey,
        targetIndex: intent.targetIndex,
      }
    : intent.rightKey
      ? {
          type: "move-boundary",
          leftKey: intent.leftKey,
          rightKey: intent.rightKey,
          nextBoundary: intent.bit,
        }
      : {
          type: "resize-end",
          fieldKey: intent.leftKey,
          nextEnd: intent.bit - 1,
        };
}

import { useEffect, useMemo, useRef, useState } from "react";
import { packetSelectedField, type usePacketSelection } from "./selection";
import type { PacketCommentTarget } from "./comments-popover";
type Overlay = "appearance" | "accessibility" | "data";
/** Core owns the exact-source basis and command result. Capture, coordinates
 * and gesture intents remain exclusively in the neutral Facade hook. */
export function usePacketDraftSession(
  props: MermaidPacketReactHostProps,
  selectionState: ReturnType<typeof usePacketSelection>,
) {
  const { selection, selectionRef, selectionRow, select, focus, clearFocus } =
    selectionState;
  const [draft, setDraft] = useState<PacketDraft>();
  const [overlay, setOverlay] = useState<Overlay>();
  const [commentAnchor, setCommentAnchor] = useState<PacketCommentTarget>();
  const [geometryActive, setGeometryActive] = useState(false);
  const [commentsVisible, setCommentsVisible] = useState(true);
  const [previewModel, setPreviewModel] = useState<MermaidPacketModel>();
  const [notice, setNotice] = useState<string>();
  const entry = useRef<HTMLElement | undefined>(undefined);
  const geometryBasis = useRef<string | undefined>(undefined);
  const source = props.model.sourceDocument.source;
  const [gestureCancel, setGestureCancel] = useState<object>();
  const gestureSession = useMemo(() => ({}), [source, gestureCancel]);
  const writable = !props.readonly && !props.displayOnly;
  const geometryWritable =
    writable &&
    !props.projectionModel &&
    !props.model.issues.length &&
    !props.model.diagnostics.length &&
    props.model.configResolution.mutableGeometry;
  const selected = packetSelectedField(props.model, selection);
  const busy = geometryActive || Boolean(draft || overlay || commentAnchor);
  const focusCurrent = (key = selectionRef.current) => {
    if (packetSelectedField(props.projectionModel ?? props.model, key))
      focus(key);
    else if (geometryWritable && !props.model.fields.length) focus();
    else clearFocus();
  };
  const cancel = () => {
    setGestureCancel({});
    setGeometryActive(false);
    setDraft(undefined);
    setOverlay(undefined);
    setCommentAnchor(undefined);
    setPreviewModel(undefined);
    geometryBasis.current = undefined;
    setNotice(undefined);
    const origin = entry.current;
    entry.current = undefined;
    if (origin?.isConnected) {
      clearFocus();
      // One return after the native popover closes; confirmed writes instead
      // use the remapped object request, never this cancelled-action origin.
      queueMicrotask(() => {
        if (origin.isConnected) origin.focus();
      });
    } else focusCurrent();
  };
  const applied = (result: PacketCommandResult) => {
    if (result.changed || result.reason === "no-change") {
      entry.current = undefined;
      setDraft(undefined);
      setOverlay(undefined);
      setCommentAnchor(undefined);
      setPreviewModel(undefined);
      if (result.changed) select(result.selection);
      focus(
        result.changed
          ? result.focus === "add"
            ? undefined
            : (result.focus ?? result.selection)
          : selectionRef.current,
      );
      setNotice(undefined);
      return true;
    }
    setNotice(result.diagnostic ?? messages.ganttDiagnosticConflict());
    return false;
  };
  const open = (kind: PacketDraft["kind"], key = selection, row?: number) => {
    if (!geometryWritable || geometryActive) return;
    const field = packetSelectedField(props.model, key);
    const selectedRow = selectionRow.current;
    if (row === undefined && selectedRow && selectedRow.fieldKey === key)
      row = selectedRow.row;
    if (row === undefined && field)
      row = Math.floor(
        field.startBit /
          (props.model.configResolution.config?.bitsPerRow ?? 32),
      );
    setOverlay(undefined);
    setCommentAnchor(undefined);
    setPreviewModel(undefined);
    entry.current =
      (kind === "add" || kind === "split" || kind === "merge") &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    setDraft(createPacketDraft(kind, props.model, key, row));
  };
  useEffect(() => {
    const staleDraft = draft && draft.source !== source;
    const staleGeometry =
      geometryBasis.current !== undefined && geometryBasis.current !== source;
    setPreviewModel(undefined);
    geometryBasis.current = undefined;
    setGeometryActive(false);
    if (staleDraft) {
      setDraft(undefined);
      entry.current = undefined;
      clearFocus();
      setNotice(messages.packetSourceConflict());
    }
    if (staleGeometry) clearFocus();
    if (props.replayed) {
      setDraft(undefined);
      setOverlay(undefined);
      setCommentAnchor(undefined);
      setNotice(undefined);
      entry.current = undefined;
      focusCurrent(props.selection);
    }
    if (commentAnchor) {
      const anchor = commentAnchor.anchor;
      const exists = anchor.anchorId
        ? props.model.sourceDocument.records.some(
            (record) => record.sourceKey === anchor.anchorId,
          )
        : props.model.comments?.some(
            (comment) =>
              comment.anchorKind === anchor.anchorKind &&
              comment.anchorId === anchor.anchorId,
          );
      // Deleting the last positional comment removes its marker. External
      // Source edits can likewise remove an object anchor without a local close.
      if (!exists) {
        setCommentAnchor(undefined);
        focusCurrent(props.selection);
      }
    }
    if (!writable) {
      setDraft(undefined);
      setOverlay(undefined);
      setCommentAnchor(undefined);
      entry.current = undefined;
      setNotice(undefined);
      clearFocus();
    }
  }, [source, props.replayed, writable]);

  return {
    draft,
    overlay,
    setOverlay,
    commentAnchor,
    setCommentAnchor,
    geometryActive,
    setGeometryActive,
    commentsVisible,
    setCommentsVisible,
    previewModel,
    setPreviewModel,
    notice,
    setNotice,
    geometryBasis,
    source,
    gestureSession,
    writable,
    geometryWritable,
    focusCurrent,
    selected,
    busy,
    cancel,
    applied,
    open,
    setDraft,
  };
}
