// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMermaidSelectionAction } from "../mermaid-editor-workbench";
import { useEffect, useRef, useState } from "react";
import type { TimelineObject, TimelineMoveIntent } from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidTimelineReactHostProps,
  type TimelineSelection,
  type TimelineCommand,
  type TimelineAnchor,
  timelineDeleteImpact,
} from "@virgultum/block-mermaid";

export type TimelineDraft = {
  readonly kind: "rename" | "section-add" | "period-add" | "event-add";
  readonly targetId?: string | null;
  readonly object: TimelineObject;
  readonly label: string;
  readonly order: number | null;
  readonly source: string;
};
export function timelineMoveCommand(
  intent: TimelineMoveIntent,
): TimelineCommand {
  if (intent.object.kind === "period")
    return {
      type: "period-move",
      id: intent.object.id,
      targetSectionId: intent.targetSectionId ?? "",
      targetOrder: intent.targetOrder,
    };
  if (intent.object.kind === "event")
    return {
      type: "event-move",
      id: intent.object.id,
      targetPeriodId: intent.targetPeriodId ?? "",
      targetOrder: intent.targetOrder,
    };
  return {
    type: "section-move",
    id: intent.object.id,
    targetOrder: intent.targetOrder,
  };
}
/** Drafts compare source bytes, not projection-array identity. Conflict leaves the draft visible. */
export function useTimelineInteraction(props: MermaidTimelineReactHostProps) {
  const [selection, setSelection] = useState<TimelineSelection>(
    props.selection,
  );
  const [draft, setDraft] = useState<TimelineDraft>();
  const [move, setMove] = useState<{
    intent: TimelineMoveIntent;
    source: string;
  }>();
  const [deleting, setDeleting] = useState<TimelineAnchor>();
  const [notice, setNotice] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const source = props.model.sourceDocument.source;
  const returnFocus = (id?: string) =>
    requestAnimationFrame(() => {
      const root = rootRef.current;
      const target = Array.from(
        root?.querySelectorAll<HTMLElement>(
          "[data-timeline-id], [data-timeline-drag-id]",
        ) ?? [],
      ).find(
        (n) => n.dataset.timelineId === id || n.dataset.timelineDragId === id,
      );
      (
        target ?? root?.querySelector<HTMLElement>("button:not(:disabled)")
      )?.focus();
    });
  useEffect(() => setSelection(props.selection), [props.selection]);
  useEffect(() => {
    if (props.readonly || props.displayOnly) {
      setDraft(undefined);
      setMove(undefined);
      setDeleting(undefined);
    } else if (
      draft?.kind === "rename" &&
      ![
        ...props.model.sections,
        ...props.model.periods,
        ...props.model.events,
      ].some((item) => item.id === draft.object.id)
    )
      setDraft(undefined);
  }, [props.readonly, props.displayOnly, props.model, draft]);
  useEffect(() => {
    if (
      move &&
      ![
        ...props.model.sections,
        ...props.model.periods,
        ...props.model.events,
      ].some((item) => item.id === move.intent.object.id)
    )
      setMove(undefined);
  }, [move, props.model]);
  const select = (object: TimelineObject) => {
    setSelection(object);
    props.onSelectionChange(object);
  };
  const command: TimelineCommand | undefined = !draft
    ? undefined
    : draft.kind === "rename"
      ? { type: "rename", anchor: draft.object, label: draft.label }
      : draft.order === null
        ? undefined
        : draft.kind === "section-add"
          ? {
              type: "section-add",
              label: draft.label,
              targetOrder: draft.order,
            }
          : !draft.targetId
            ? undefined
            : draft.kind === "period-add"
              ? {
                  type: "period-add",
                  label: draft.label,
                  targetSectionId: draft.targetId,
                  targetOrder: draft.order,
                }
              : {
                  type: "event-add",
                  label: draft.label,
                  targetPeriodId: draft.targetId,
                  targetOrder: draft.order,
                };
  const preview = command
    ? props.onPreviewCommand(command, draft?.source)
    : undefined;
  const movePreview = move
    ? props.onPreviewCommand(timelineMoveCommand(move.intent), move.source)
    : undefined;
  const failure = (reason: string) =>
    reason === "conflict"
      ? messages.ganttDiagnosticConflict()
      : reason === "readonly"
        ? messages.ganttReadOnly()
        : messages.ganttCommandRejected();
  const apply = (cmd: TimelineCommand, basis: string) => {
    const result = props.onCommand(cmd, basis);
    if (result.changed) {
      setNotice(undefined);
      setDraft(undefined);
      setMove(undefined);
      returnFocus(result.selection?.id ?? undefined);
      return true;
    }
    if (result.reason === "no-change") {
      setDraft(undefined);
      setMove(undefined);
      returnFocus(selection?.id ?? undefined);
      return true;
    }
    setNotice(failure(result.reason));
    return false;
  };
  const cancel = () => {
    const id =
      draft?.object.id ?? move?.intent.object.id ?? selection?.id ?? undefined;
    setDraft(undefined);
    setMove(undefined);
    setNotice(undefined);
    returnFocus(id);
  };
  const requestDelete = (object: TimelineObject) => {
    if (props.readonly || props.displayOnly) return;
    const impact = timelineDeleteImpact(props.model, object);
    if (!impact) return;
    if (impact.direct) apply({ type: "delete", anchor: object }, source);
    else {
      cancel();
      select(object);
      setDeleting(object);
    }
  };
  useMermaidSelectionAction({
    disabled:
      props.readonly || props.displayOnly || Boolean(draft) || Boolean(move),
    label: messages.visualDelete(),
    selectionKey:
      selection?.kind === "section" ||
      selection?.kind === "period" ||
      selection?.kind === "event"
        ? timelineDeleteImpact(props.model, selection)
          ? selection.id
          : null
        : null,
    onSelect: () => {
      if (
        selection?.id &&
        selection.kind !== "comment" &&
        selection.kind !== "diagram"
      )
        requestDelete({ kind: selection.kind, id: selection.id });
    },
    register: props.onSelectionActionChange,
  });
  return {
    selection,
    select,
    deleting,
    requestDelete,
    closeDelete: () => {
      setDeleting(undefined);
      returnFocus(selection?.id ?? undefined);
    },
    deleteApplied: (id?: string) => {
      setDeleting(undefined);
      returnFocus(id);
    },
    draft,
    setDraft,
    move,
    notice,
    reloadDraft: () => {
      setDraft((value) => (value ? { ...value, source } : undefined));
      setMove((value) => (value ? { ...value, source } : undefined));
      setNotice(undefined);
    },
    rootRef,
    preview,
    movePreview,
    cancel,
    add: (kind: "period" | "event", targetId?: string) => {
      if (props.readonly) return;
      const period = props.model.periods.find(
        (p) =>
          p.id ===
          (selection?.kind === "period"
            ? selection.id
            : selection?.kind === "event"
              ? props.model.events.find((e) => e.id === selection.id)?.periodId
              : undefined),
      );
      const target =
        targetId ??
        (kind === "period"
          ? selection?.kind === "section"
            ? selection.id
            : period?.sectionId
          : period?.id) ??
        null;
      const length =
        kind === "period"
          ? props.model.periods.filter((p) => p.sectionId === target).length
          : props.model.events.filter((e) => e.periodId === target).length;
      setMove(undefined);
      setNotice(undefined);
      setDraft({
        kind: kind === "period" ? "period-add" : "event-add",
        object: { kind, id: "timeline-create-draft" },
        label: "",
        targetId: target,
        order: target ? length : null,
        source,
      });
    },
    addSection: () => {
      if (props.readonly) return;
      setMove(undefined);
      setNotice(undefined);
      setDraft({
        kind: "section-add",
        object: { kind: "section", id: "timeline-create-draft" },
        label: "",
        order: null,
        source,
      });
    },
    rename: (object: TimelineObject) => {
      if (props.readonly) return;
      const item = [
        ...props.model.sections,
        ...props.model.periods,
        ...props.model.events,
      ].find((item) => item.id === object.id);
      if (!item) return;
      select(object);
      setMove(undefined);
      setNotice(undefined);
      setDraft({
        kind: "rename",
        object,
        label: "implicit" in item && item.implicit ? "" : item.label,
        order: null,
        source,
      });
    },
    changeLabel: (label: string) => {
      setNotice(undefined);
      setDraft((value) => (value ? { ...value, label } : undefined));
    },
    confirm: () => {
      if (command && preview?.reason === "no-change") cancel();
      else if (command && preview?.changed) apply(command, draft!.source);
    },
    movePreviewIntent: (intent: TimelineMoveIntent) => {
      if (props.readonly) return;
      setDraft(undefined);
      setNotice(undefined);
      setMove((value) => ({ intent, source: value?.source ?? source }));
    },
    moveApply: (intent: TimelineMoveIntent) => {
      if (!props.readonly)
        apply(timelineMoveCommand(intent), move?.source ?? source);
    },
  };
}
