// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StateSourceDocument, StateRange } from "./source-document.js";
export type MermaidStateNodeKind =
  "choice" | "end" | "fork" | "join" | "start" | "state";
export type MermaidStateDirection = "BT" | "LR" | "RL" | "TB";

export type MermaidStateDescription = {
  id: string;
  text: string;
  form: "alias" | "description";
  recordKey: string;
};

/** Native State ignores empty descriptions while their Source records remain editable. */
export function stateEffectiveDescriptions(node: {
  descriptions?: readonly MermaidStateDescription[];
}) {
  return (node.descriptions ?? []).filter((d) => d.text.trim().length > 0);
}

export type MermaidStateNode = {
  sourceKey?: string;
  declaration?: "implicit" | "bare" | "alias" | "description" | "pseudostate";
  descriptions?: MermaidStateDescription[];
  recordKeys?: string[];
  relationKeys?: string[];
  regionKey?: string | null;
  cssClasses?: string[];
  id: string;
  kind: MermaidStateNodeKind;
  label: string;
  order: number;
  parentId?: string;
  regionIndex?: number;
  sourceId?: string;
};

export type MermaidStateTransition = {
  sourceKey?: string;
  regionKey?: string | null;
  from: string;
  fromClass?: string;
  id: string;
  label: string;
  order: number;
  parentId?: string;
  regionIndex?: number;
  to: string;
  toClass?: string;
};

export type MermaidStateComposite = {
  sourceKey?: string;
  primaryRegionKey?: string;
  closeKey?: string;
  regionKey?: string | null;
  descriptions?: MermaidStateDescription[];
  recordKeys?: string[];
  cssClasses?: string[];
  direction?: MermaidStateDirection;
  id: string;
  label: string;
  nodeIds: string[];
  order: number;
  parentId?: string;
  regionIndex?: number;
};

/** Each authored body retains its own insertion scope, even when StateDB
 * combines repeated declarations into a single visible Composite. */
export function stateCompositeBodyKeys(
  model: MermaidStateModel,
  composite: MermaidStateComposite,
) {
  return (composite.recordKeys ?? []).flatMap((key) =>
    model.sourceDocument.records.some(
      (r) => r.sourceKey === key && r.kind === "composite",
    )
      ? [`${key}:region`]
      : [],
  );
}

export type MermaidStateRegion = {
  sourceKey?: string;
  previousKey?: string;
  compositeId: string;
  id: string;
  order: number;
  regionIndex: number;
};

export type MermaidStateNote = {
  sourceKey?: string;
  form?: "inline" | "multiline" | "floating";
  regionKey?: string | null;
  effective?: boolean;
  floatingId?: string;
  id: string;
  label: string;
  order: number;
  parentId?: string;
  placement: "left of" | "right of";
  regionIndex?: number;
  stateId?: string;
};

export type MermaidStateLink = {
  sourceKey?: string;
  stateId: string;
  tooltip: string;
  url: string;
};

export type StateStyle = {
  id: string;
  sourceKey: string;
  kind: "definition" | "inline" | "assignment";
  owners: string[];
  styles: string[];
  properties: Array<{
    name: string;
    value: string;
    range: StateRange;
    valueRange: StateRange;
  }>;
};
export type StateComment = {
  id: string;
  text: string;
  anchorKind:
    | "diagram"
    | "state"
    | "composite"
    | "transition"
    | "note"
    | "description"
    | "region"
    | "record";
  anchorId?: string;
  position: "before" | "after" | "inside";
};
export type StateCommentAnchor = Pick<
  StateComment,
  "anchorKind" | "anchorId" | "position"
>;

export type MermaidStateModel = {
  sourceDocument: StateSourceDocument;
  commentRecords: StateComment[];
  styles: StateStyle[];
  accessibilityDescription: string;
  accessibilityTitle: string;
  composites: MermaidStateComposite[];
  diagramTitle: string;
  diagramType: "stateDiagram" | "stateDiagram-v2";
  direction: MermaidStateDirection;
  directives: string[];
  headerLine: string;
  hideEmptyDescription: boolean;
  links: MermaidStateLink[];
  notes: MermaidStateNote[];
  regions: MermaidStateRegion[];
  sourceHash: string;
  scaleWidth?: number;
  states: MermaidStateNode[];
  styleStatements: string[];
  transitions: MermaidStateTransition[];
  version: 1;
};

export function isStartStateId(id: string) {
  return id === "__start__" || id.endsWith("::__start__");
}

export function isEndStateId(id: string) {
  return id === "__end__" || id.endsWith("::__end__");
}
