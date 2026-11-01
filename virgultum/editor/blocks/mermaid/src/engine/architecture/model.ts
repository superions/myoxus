import type { MermaidArchitectureSourceDocument } from "./source-document.js";

export type MermaidArchitectureGroup = {
  hasIcon: boolean;
  hasLabel: boolean;
  icon: string;
  id: string;
  label: string;
  order: number;
  parentId: string;
};

export type MermaidArchitectureService = {
  groupId: string;
  hasIcon: boolean;
  hasLabel: boolean;
  icon: string;
  iconKind: "icon" | "none" | "text";
  id: string;
  label: string;
  order: number;
};

export type MermaidArchitectureJunction = {
  groupId: string;
  id: string;
  order: number;
};

export type MermaidArchitectureAlignment = {
  direction: "column" | "row";
  id: string;
  members: string[];
  order: number;
};

export type MermaidArchitectureEdge = {
  from: string;
  fromArrow: boolean;
  fromGroup: boolean;
  fromPort: string;
  id: string;
  label: string;
  order: number;
  to: string;
  toArrow: boolean;
  toGroup: boolean;
  toPort: string;
};

export type MermaidArchitectureComment = {
  anchorId?: string;
  anchorKind:
    | "alignment"
    | "diagram"
    | "edge"
    | "group"
    | "junction"
    | "metadata"
    | "service";
  id: string;
  line: string;
  position: "after" | "before";
};

export type MermaidArchitectureConfig = {
  edgeElasticity?: number;
  fontSize?: number;
  iconSize?: number;
  idealEdgeLengthMultiplier?: number;
  nodeSeparation?: number;
  numIter?: number;
  padding?: number;
  randomize?: boolean;
  seed?: number;
};

export type MermaidArchitectureModel = {
  accessibilityDescription: string;
  accessibilityTitle: string;
  comments?: MermaidArchitectureComment[];
  diagramType: "architecture";
  alignments: MermaidArchitectureAlignment[];
  directives: string[];
  diagramTitle: string;
  edges: MermaidArchitectureEdge[];
  groups: MermaidArchitectureGroup[];
  headerLine: string;
  junctions: MermaidArchitectureJunction[];
  sourceAnnotations: string[];
  services: MermaidArchitectureService[];
  sourceDocument?: MermaidArchitectureSourceDocument;
  sourceHash: string;
  version: 1;
};

export type MermaidArchitectureSourceDiagnostic = {
  construct: string;
  line: number;
  message: string;
};
