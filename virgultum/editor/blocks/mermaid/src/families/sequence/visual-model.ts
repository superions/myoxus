// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidSequenceModel } from "../../engine/sequence/index.js";
import { getMermaidFrontmatterTitle } from "../../engine/diagram-types.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { layoutSequence } from "./layout.js";
import { sequenceModelFamilyData } from "./gfx-data.js";
import { sequenceParticipantProjection } from "./participant-projection.js";
import { sequenceMessageProjection } from "./message-projection.js";
import { sequenceActivationProjection } from "./activation-projection.js";
import { sequenceFragmentProjection } from "./fragment-projection.js";
import { sequenceBackgroundProjection } from "./background-projection.js";
import { sequenceNoteProjection } from "./annotation-projection.js";
export function sequenceModelToVisual(
  model: MermaidSequenceModel,
): MermaidVisualModel {
  const layout = layoutSequence(model),
    participants = sequenceParticipantProjection(model, layout),
    fragments = sequenceFragmentProjection(model, layout),
    nodes = [
      ...participants,
      ...sequenceActivationProjection(model, layout),
      ...sequenceNoteProjection(model, layout),
      ...fragments.branches,
    ];
  return {
    diagramType: "sequenceDiagram",
    version: 1,
    direction: "LR",
    diagramTitle:
      model.diagramTitle || getMermaidFrontmatterTitle(model.directives),
    accessibilityTitle: model.accessibilityTitle,
    accessibilityDescription: model.accessibilityDescription,
    nodes,
    edges: sequenceMessageProjection(model, layout, participants),
    subgraphs: [
      ...sequenceBackgroundProjection(model, layout),
      ...fragments.frames,
    ],
    familyData: sequenceModelFamilyData(
      model,
      [...layout.rows.values()],
      layout.typography,
    ),
  };
}
