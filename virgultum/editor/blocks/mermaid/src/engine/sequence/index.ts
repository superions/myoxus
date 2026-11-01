// SPDX-License-Identifier: AGPL-3.0-or-later

export {
  MERMAID_SEQUENCE_MESSAGE_ARROWS,
  SEQUENCE_PARTICIPANT_TYPES,
  SEQUENCE_ARROW_MAP,
  isMermaidSequenceMessageArrow,
  isDottedMermaidSequenceMessageArrow,
} from "./model.js";
export type {
  MermaidSequenceParticipantKind,
  SequenceParticipantType,
  SequenceArrowMarker,
  SequenceActivationInterval,
  SequenceComment,
  MermaidSequenceMessageArrow,
  MermaidSequenceActivationKind,
  MermaidSequenceNotePlacement,
  MermaidSequenceControlKind,
  MermaidSequenceControlBranchKind,
  MermaidSequenceBackgroundKind,
  MermaidSequenceParticipant,
  MermaidSequenceParticipantLink,
  MermaidSequenceMessage,
  MermaidSequenceNote,
  MermaidSequenceActivation,
  MermaidSequenceControlBranch,
  MermaidSequenceControl,
  MermaidSequenceBackground,
  MermaidSequenceModel,
} from "./model.js";
export {
  parseMermaidSequenceSource,
  resolveMermaidSequenceSource,
  mermaidSequenceParticipantConfigType,
} from "./parser.js";
export * from "./writer.js";
export * from "./commands/index.js";

export * from "./config.js";
export * from "./source-document.js";
export * from "./diagnostics.js";
