// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidJourneyModel,
  MermaidJourneySelection,
} from "@virgultum/block-mermaid";
export function journeySelectionExists(
  model: MermaidJourneyModel,
  selection: MermaidJourneySelection,
) {
  return selection?.stepId
    ? model.steps.some((step) => step.id === selection.stepId)
    : selection?.sectionId
      ? model.sections.some((section) => section.id === selection.sectionId)
      : false;
}
export function nextJourneySelection(
  model: MermaidJourneyModel,
  id: string,
): MermaidJourneySelection {
  const step = model.steps.find((step) => step.id === id);
  if (step) {
    const peers = model.steps.filter(
      (item) => item.sectionId === step.sectionId,
    );
    const index = peers.indexOf(step);
    const next = peers[index + 1] ?? peers[index - 1];
    return next ? { stepId: next.id } : { sectionId: step.sectionId };
  }
  const index = model.sections.findIndex((section) => section.id === id);
  const next = model.sections[index + 1] ?? model.sections[index - 1];
  return next ? { sectionId: next.id } : undefined;
}
