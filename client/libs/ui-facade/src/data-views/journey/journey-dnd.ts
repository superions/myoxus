// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DNDData } from "../../dnd/types";
import type {
  JourneyMapSection,
  JourneyMapStepMove,
  JourneyMapSectionMove,
} from "./types";
export function wouldMoveJourneyStep(
  sections: ReadonlyArray<JourneyMapSection>,
  move: JourneyMapStepMove,
) {
  const sourceSection = sections.find(
    (section) => section.id === move.fromSectionId,
  );
  const targetSection = sections.find(
    (section) => section.id === move.toSectionId,
  );
  if (
    !sourceSection?.steps.some((step) => step.id === move.stepId) ||
    !targetSection ||
    targetSection.add?.enabled === false ||
    sourceSection.steps.find((step) => step.id === move.stepId)?.move
      ?.enabled === false
  ) {
    return false;
  }
  const targetSteps = targetSection.steps.filter(
    (step) => step.id !== move.stepId,
  );
  if (
    move.targetStepId &&
    !targetSteps.some(
      (step) => step.id === move.targetStepId && step.move?.enabled !== false,
    )
  ) {
    return false;
  }
  if (sourceSection.id !== targetSection.id) return true;
  const before = sourceSection.steps.map((step) => step.id);
  const after = targetSteps.map((step) => step.id);
  const targetIndex = move.targetStepId ? after.indexOf(move.targetStepId) : -1;
  after.splice(
    targetIndex < 0
      ? after.length
      : targetIndex + (move.edge === "after" ? 1 : 0),
    0,
    move.stepId,
  );
  return before.some((id, index) => id !== after[index]);
}

export function wouldMoveJourneySection(
  sections: ReadonlyArray<JourneyMapSection>,
  move: JourneyMapSectionMove,
) {
  const before = sections.map((section) => section.id);
  if (
    move.sectionId === move.targetSectionId ||
    !before.includes(move.sectionId) ||
    !before.includes(move.targetSectionId) ||
    sections.some(
      (section) =>
        section.reorder?.enabled === false &&
        (section.id === move.sectionId ||
          (section.id === move.targetSectionId &&
            !(section.implicit && move.edge === "after"))),
    )
  ) {
    return false;
  }
  const after = before.filter((id) => id !== move.sectionId);
  const targetIndex = after.indexOf(move.targetSectionId);
  after.splice(
    targetIndex + (move.edge === "after" ? 1 : 0),
    0,
    move.sectionId,
  );
  return before.some((id, index) => id !== after[index]);
}

export type JourneyDndData = DNDData<
  | {
      type: "journey-step";
      mapId: string;
      stepId: string;
      sectionId: string;
    }
  | { type: "journey-section"; mapId: string; sectionId: string },
  | {
      type: "journey-step";
      mapId: string;
      stepId: string;
      sectionId: string;
    }
  | { type: "journey-section"; mapId: string; sectionId: string }
>;

export type JourneyKeyboardStepDrag = {
  readonly stepId: string;
  readonly sectionIndex: number;
  readonly insertionIndex: number;
};

export type JourneyKeyboardSectionDrag = {
  readonly sectionId: string;
  readonly targetIndex: number;
};

export function isJourneyActionTarget(target: EventTarget, boundary: Element) {
  if (!(target instanceof Element)) return false;
  // React portal events bubble through their logical owner, outside this object.
  if (!boundary.contains(target)) return true;
  const action = target.closest(
    "button, a, input, textarea, select, [contenteditable='true'], [data-myoxus-journey-interaction], [data-myoxus-ui-role='inline-edit-input']",
  );
  // An enclosing editor's contenteditable root is outside the object's actions.
  return action !== null && boundary.contains(action);
}

/** A move ghost derives from neutral display order only; actual apply remains a consumer intent. */
export function previewJourneyMove(
  sections: readonly JourneyMapSection[],
  move: JourneyMapStepMove | JourneyMapSectionMove | undefined,
): JourneyMapSection[] | undefined {
  if (!move) return;
  if ("stepId" in move) {
    if (!wouldMoveJourneyStep(sections, move)) return;
    const step = sections
      .flatMap((s) => s.steps)
      .find((s) => s.id === move.stepId)!;
    return sections.map((section) => {
      const steps = section.steps.filter((s) => s.id !== move.stepId);
      if (section.id === move.toSectionId) {
        const target = move.targetStepId
          ? steps.findIndex((s) => s.id === move.targetStepId)
          : -1;
        steps.splice(
          target < 0 ? steps.length : target + (move.edge === "after" ? 1 : 0),
          0,
          step,
        );
      }
      return { ...section, steps };
    });
  }
  if (!wouldMoveJourneySection(sections, move)) return;
  const section = sections.find((s) => s.id === move.sectionId)!;
  const result = sections.filter((s) => s.id !== move.sectionId);
  result.splice(
    result.findIndex((s) => s.id === move.targetSectionId) +
      (move.edge === "after" ? 1 : 0),
    0,
    section,
  );
  return result;
}
