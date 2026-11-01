// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  OrdinalTimelineViewProps,
  TimelineObject,
} from "@myoxus/ui-facade";
import type { TimelineDraft } from "./interaction";
import {
  mermaidMessages as messages,
  type MermaidTimelineModel,
  TIMELINE_UNSECTIONED_ID,
  timelineDiagnosticMessage,
  type TimelineSelection,
} from "@virgultum/block-mermaid";

export function projectTimelineView(
  model: MermaidTimelineModel,
  selection: TimelineSelection,
  readonly: boolean,
): Omit<OrdinalTimelineViewProps, "onSelect"> {
  const diagnosticAnchor = (id: string | null) => {
    if (model.sections.some((item) => item.id === id)) return id;
    if (model.periods.some((item) => item.id === id)) return id;
    const event = model.events.find((item) => item.id === id);
    if (event) return event.periodId;
    const record = model.sourceDocument.statements.find(
      (item) =>
        item.id === id || item.segments.some((segment) => segment.id === id),
    );
    return record && model.periods.some((item) => item.id === record.id)
      ? record.id
      : null;
  };
  return {
    axis: { kind: "ordinal", direction: model.direction },
    sections: model.sections.map((section) => ({
      id: section.id,
      label: section.implicit ? messages.timelineUnsectioned() : section.label,
      implicit: section.implicit,
      periods: model.periods
        .filter((period) => period.sectionId === section.id)
        .map((period) => ({
          id: period.id,
          label: period.label,
          events: model.events
            .filter((event) => event.periodId === period.id)
            .map((event) => ({ id: event.id, label: event.label })),
        })),
    })),
    selection:
      selection?.id &&
      selection.kind !== "comment" &&
      selection.kind !== "diagram"
        ? (selection as TimelineObject)
        : null,
    readonly,
    selectionCapability: { enabled: true },
    diagnostics: model.diagnostics.map((item) => ({
      id: `${item.anchorId}:${item.code}:${item.range.start}`,
      anchorId: diagnosticAnchor(item.anchorId),
      message: timelineDiagnosticMessage(item),
    })),
    accessibility: {
      title:
        model.metadata.find(
          (item) => item.field === "accessibilityTitle" && item.effective,
        )?.value ||
        model.title ||
        messages.visualEditorLabel(),
      description: model.metadata.find(
        (item) => item.field === "accessibilityDescription" && item.effective,
      )?.value,
    },
  };
}

/** Local draft objects never enter source. Insert positions retain source order and ownership. */
export function projectTimelineDraft(
  sections: ReturnType<typeof projectTimelineView>["sections"],
  draft: TimelineDraft | undefined,
  movingPeriod: boolean,
) {
  const implicit = {
    id: TIMELINE_UNSECTIONED_ID,
    label: messages.timelineUnsectioned(),
    implicit: true,
    periods: [],
  };
  const available =
    !sections.some((s) => s.implicit) &&
    (movingPeriod ||
      (draft?.kind === "period-add" &&
        draft.targetId === TIMELINE_UNSECTIONED_ID))
      ? [implicit, ...sections]
      : sections;
  if (!draft || draft.kind === "rename" || draft.order === null)
    return available;
  const insert = <T>(items: readonly T[], item: T, slot: number) => [
    ...items.slice(0, slot),
    item,
    ...items.slice(slot),
  ];
  if (draft.kind === "section-add") {
    const target = available.filter((s) => !s.implicit)[draft.order]?.id;
    const section = { id: draft.object.id, label: draft.label, periods: [] };
    return target
      ? available.flatMap((s) => (s.id === target ? [section, s] : [s]))
      : [...available, section];
  }
  return available.map((section) => ({
    ...section,
    periods:
      draft.kind === "period-add" && section.id === draft.targetId
        ? insert(
            section.periods,
            { id: draft.object.id, label: draft.label, events: [] },
            draft.order!,
          )
        : section.periods.map((period) => ({
            ...period,
            events:
              draft.kind === "event-add" && period.id === draft.targetId
                ? insert(
                    period.events,
                    { id: draft.object.id, label: draft.label },
                    draft.order!,
                  )
                : period.events,
          })),
  }));
}
