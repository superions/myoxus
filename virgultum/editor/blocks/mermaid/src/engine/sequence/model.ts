// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SequenceSourceDocument } from "./source-document.js";

export type MermaidSequenceParticipantKind = "actor" | "participant";
export const SEQUENCE_PARTICIPANT_TYPES = [
  "actor",
  "boundary",
  "collections",
  "control",
  "database",
  "entity",
  "participant",
  "queue",
] as const;
export type SequenceParticipantType =
  (typeof SEQUENCE_PARTICIPANT_TYPES)[number];
export const MERMAID_SEQUENCE_MESSAGE_ARROWS = [
  "<<-->>",
  "<<->>",
  "-->>",
  "->>",
  "-->",
  "->",
  "--x",
  "-x",
  "--)",
  "-)",
  "--|\\",
  "--|/",
  "--\\\\",
  "--//",
  "/|--",
  "\\|--",
  "//--",
  "\\\\--",
  "-|\\",
  "-|/",
  "-\\\\",
  "-//",
  "/|-",
  "\\|-",
  "//-",
  "\\\\-",
] as const;

export type MermaidSequenceMessageArrow =
  (typeof MERMAID_SEQUENCE_MESSAGE_ARROWS)[number];
export type MermaidSequenceActivationKind =
  "activate" | "create" | "deactivate" | "destroy";
export type MermaidSequenceNotePlacement = "left of" | "over" | "right of";
export type MermaidSequenceControlKind =
  "alt" | "break" | "critical" | "loop" | "opt" | "par" | "par_over";
export type MermaidSequenceControlBranchKind =
  "and" | "else" | "option" | "primary";
export type MermaidSequenceBackgroundKind = "box" | "rect";

export type MermaidSequenceParticipant = {
  sourceKey: string;
  type: SequenceParticipantType;
  declared: boolean;
  declarationKeys: string[];
  boxId: string | null;
  wrap?: boolean;
  createdBy?: string;
  destroyedBy?: string;
  config: string;
  detailsId: string;
  id: string;
  kind: MermaidSequenceParticipantKind;
  label: string;
  links: MermaidSequenceParticipantLink[];
  order: number;
  properties: Record<string, unknown>;
  width: number;
  x: number;
};

export type MermaidSequenceParticipantLink = {
  label: string;
  url: string;
};

export type MermaidSequenceMessage = {
  activation?: "+" | "-";
  wrap?: boolean;
  arrow: MermaidSequenceMessageArrow;
  centralFrom: boolean;
  centralTo: boolean;
  from: string;
  id: string;
  label: string;
  order: number;
  to: string;
  y: number;
};

export type MermaidSequenceNote = {
  wrap?: boolean;
  id: string;
  label: string;
  order: number;
  participantIds: string[];
  placement: MermaidSequenceNotePlacement;
  x: number;
  y: number;
};

export type MermaidSequenceActivation = {
  messageId?: string;
  embedded?: boolean;
  id: string;
  kind: MermaidSequenceActivationKind;
  order: number;
  participantId: string;
  y: number;
};

export type MermaidSequenceControlBranch = {
  id: string;
  kind: MermaidSequenceControlBranchKind;
  label: string;
  order: number;
  startOrder: number;
};

export type MermaidSequenceControl = {
  branches: MermaidSequenceControlBranch[];
  endOrder: number;
  id: string;
  kind: MermaidSequenceControlKind;
  label: string;
  order: number;
  parentId?: string;
  startOrder: number;
};

export type MermaidSequenceBackground = {
  wrap?: boolean;
  color: string;
  endOrder: number;
  id: string;
  kind: MermaidSequenceBackgroundKind;
  label: string;
  order: number;
  participantIds: string[];
  parentId?: string;
  startOrder: number;
};

export type MermaidSequenceModel = {
  sourceDocument: SequenceSourceDocument;
  commentRecords: SequenceComment[];
  activationIntervals: SequenceActivationInterval[];
  autonumber: { enabled: boolean; start: number; step: number };
  accessibilityDescription: string;
  accessibilityTitle: string;
  autonumberLine?: string;
  activations: MermaidSequenceActivation[];
  backgrounds: MermaidSequenceBackground[];
  controls: MermaidSequenceControl[];
  diagramType: "sequenceDiagram";
  diagramTitle: string;
  directives: string[];
  headerLine: string;
  messages: MermaidSequenceMessage[];
  notes: MermaidSequenceNote[];
  participants: MermaidSequenceParticipant[];
  passthroughLines: string[];
  sourceHash: string;
  version: 1;
};

export type SequenceComment = {
  id: string;
  text: string;
  anchorKind:
    | "diagram"
    | "participant"
    | "message"
    | "activation"
    | "note"
    | "fragment"
    | "branch"
    | "record";
  anchorId?: string;
  position: "before" | "after" | "inside";
};
export type SequenceActivationInterval = {
  id: string;
  participantId: string;
  startId: string;
  endId?: string;
  depth: number;
};

export type SequenceArrowMarker =
  | "none"
  | "filled"
  | "open"
  | "cross"
  | "filled-top"
  | "filled-bottom"
  | "open-top"
  | "open-bottom";
/** Exact source tokens own line and endpoint markers. Central decorations remain
 * independent endpoint flags; reversing a message does not change its token. */
export const SEQUENCE_ARROW_MAP: Record<
  MermaidSequenceMessageArrow,
  {
    dotted: boolean;
    start: SequenceArrowMarker;
    end: SequenceArrowMarker;
  }
> = Object.fromEntries(
  MERMAID_SEQUENCE_MESSAGE_ARROWS.map((token) => {
    const dotted = token.includes("--");
    const body = token.replaceAll("-", "");
    const reverse = !token.startsWith("-") && !token.startsWith("<");
    let marker: SequenceArrowMarker = "none";
    if (body.includes("x")) marker = "cross";
    else if (body.includes(")")) marker = "open";
    else if (body.includes("|"))
      marker = body.includes(reverse ? "/" : "\\")
        ? "filled-top"
        : "filled-bottom";
    else if (body === "//" || body === "\\\\")
      marker = body === (reverse ? "//" : "\\\\") ? "open-top" : "open-bottom";
    else if (body.includes(">>")) marker = "filled";
    else if (body.includes(">")) marker = "open";
    const bidirectional = body.startsWith("<<");
    return [
      token,
      {
        dotted,
        start: bidirectional ? marker : reverse ? marker : "none",
        end: reverse ? "none" : marker,
      },
    ];
  }),
) as Record<
  MermaidSequenceMessageArrow,
  { dotted: boolean; start: SequenceArrowMarker; end: SequenceArrowMarker }
>;

const SEQUENCE_MESSAGE_ARROW_SET = new Set<string>(
  MERMAID_SEQUENCE_MESSAGE_ARROWS,
);

export function isMermaidSequenceMessageArrow(
  value: unknown,
): value is MermaidSequenceMessageArrow {
  return typeof value === "string" && SEQUENCE_MESSAGE_ARROW_SET.has(value);
}

export function isDottedMermaidSequenceMessageArrow(
  arrow: MermaidSequenceMessageArrow,
) {
  return arrow.includes("--");
}

export function cloneSequenceModel(model: MermaidSequenceModel) {
  return JSON.parse(JSON.stringify(model)) as MermaidSequenceModel;
}

/** Message actor lexing differs from declaration IDs in Mermaid 11.17.2:
 * leading arrow decorations and embedded arrow tokens are not actor names. */
export function isSequenceMessageParticipantId(value: string) {
  return (
    !/^(?:box|participant|actor|create|destroy|loop|rect|opt|alt|else|par|par_over|and|critical|option|break|end|left of|right of|links|link|properties|details|over|note|activate|deactivate|title|accTitle|accDescr|sequenceDiagram|autonumber|off)\b/i.test(
      value.trim(),
    ) &&
    /^[^/\\+()<>\-:\r\n,;]+((?!(-x|--x|-\)|--\)|-\|\\|-\\|-\/|-\/\/|-\|\/|\/\|-|\\\|-|\/\/-|\\\\-|--\|\\|--|\(\)))[-]*[^+<>\-:\r\n,;]+)*$/i.test(
      value.trim(),
    )
  );
}
