// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JourneyMapSection, JourneyMapStep } from "@myoxus/ui-facade";
import type { MermaidJourneyModel } from "@virgultum/block-mermaid";
import type { JourneyDraft } from "./drafts";
/** Source keys adapt to neutral IDs; only uncommitted creation adds a transient projection. */
export function projectJourneyMap(
  model: MermaidJourneyModel,
  readonly: boolean,
  draft?: JourneyDraft,
): JourneyMapSection[] {
  const step = (s: MermaidJourneyModel["steps"][number]): JourneyMapStep => ({
    id: s.id,
    sectionId: s.sectionId,
    label: s.label,
    score: s.score,
    actors: s.actors,
    open: { enabled: true },
    rename: { enabled: !readonly && s.writable },
    move: { enabled: !readonly && s.writable },
    remove: { enabled: !readonly && s.writable },
  });
  const sections: JourneyMapSection[] = model.sections.map((s) => ({
    id: s.id,
    label: s.title,
    implicit: s.implicit,
    add: { enabled: !readonly && s.writable },
    rename: { enabled: !readonly && s.writable },
    reorder: { enabled: !readonly && s.writable && !s.implicit },
    remove: { enabled: !readonly && s.writable },
    steps: [
      ...model.steps.filter((t) => t.sectionId === s.id).map(step),
      ...(draft?.kind === "step" && draft.sectionId === s.id
        ? [
            {
              id: draft.key,
              sectionId: s.id,
              label: draft.label ?? "",
              score: draft.score ?? 3,
              actors: draft.actors ?? [],
              draft: true,
              move: { enabled: false },
              remove: { enabled: false },
              open: { enabled: true },
            },
          ]
        : []),
    ],
  }));
  if (draft?.kind === "section")
    sections.splice(
      draft.afterId
        ? sections.findIndex((s) => s.id === draft.afterId) + 1
        : sections.length,
      0,
      {
        id: draft.key,
        label: draft.label ?? "",
        steps: [],
        add: { enabled: false },
        reorder: { enabled: false },
        remove: { enabled: false },
      },
    );
  return sections;
}
