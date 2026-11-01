// SPDX-License-Identifier: AGPL-3.0-or-later

export type MermaidGitDirection = "BT" | "LR" | "TB";
export type MermaidGitSourceCommitType = "HIGHLIGHT" | "NORMAL" | "REVERSE";
export type MermaidGitCommitKind = "cherry-pick" | "commit" | "merge";

export type MermaidGitBranch = {
  /** A native array-valued main name is a DB key, not a Source Reference. */
  referenceable?: boolean;
  sourceKey?: string;
  declaredOrder: number | null;
  id: string;
  name: string;
  order: number;
  y: number;
};

export type MermaidGitCommit = {
  branchId: string;
  customType: MermaidGitSourceCommitType | null;
  id: string;
  kind: MermaidGitCommitKind;
  message: string;
  order: number;
  parents: string[];
  sourceId: string;
  tags: string[];
  type: "CHERRY_PICK" | "HIGHLIGHT" | "MERGE" | "NORMAL" | "REVERSE";
  typeExplicit: boolean;
  x: number;
  y: number;
};

export type MermaidGitEvent =
  | {
      commitId: string;
      kind: "commit";
      order: number;
    }
  | {
      branchId: string;
      branchOrder: number | null;
      kind: "branch";
      order: number;
      targetBranchId: string;
    }
  | {
      branchId: string;
      keyword: "checkout" | "switch";
      kind: "checkout";
      order: number;
      targetBranchId: string;
    }
  | {
      branchId: string;
      commitId: string;
      customId: string;
      kind: "merge";
      order: number;
      tags: string[];
      targetBranchId: string;
      type: MermaidGitSourceCommitType | null;
    }
  | {
      branchId: string;
      commitId: string;
      kind: "cherry-pick";
      order: number;
      parentCommitId: string;
      sourceCommitId: string;
      tags: string[];
    };

export type MermaidGitOperation = Exclude<
  MermaidGitEvent,
  { kind: "commit" }
> & { id: string };

export type MermaidGitGraphModel = {
  accessibilityDescription: string;
  accessibilityTitle: string;
  branches: MermaidGitBranch[];
  commits: MermaidGitCommit[];
  diagramTitle: string;
  diagramType: "gitGraph";
  direction: MermaidGitDirection;
  directives: string[];
  events: MermaidGitEvent[];
  explicitDirection: boolean;
  headerLine: string;
  /** Display rows; the config CST/nativeConfig retain the actual scalar/list. */
  mainBranchName: string;
  /** Native string key or header binding for a non-string native DB key. */
  mainBranchId: string;
  mainBranchOrder: number;
  operations: MermaidGitOperation[];
  sourceAnnotations: string[];
  sourceHash: string;
  version: 1;
  sourceDocument?: import("./source-document.js").GitGraphSourceDocument;
  derivedGraph?: GitGraphDerivedGraph;
};

/** Execution snapshots retain the head object separately from ID references.
 * A later map overwrite never rewrites already executed command context. */
export type GitGraphCommitOccurrence = MermaidGitCommit & {
  sourceKey: string;
  runtimeId: string;
  parentReferences: string[];
  executionParents: string[];
  shadowed: boolean;
  referenceable: boolean;
};
export type GitGraphStatementContext = {
  sourceKey: string;
  branch: string;
  head: string | null;
  branchHeads: ReadonlyMap<string, string | null>;
  commitIds: ReadonlyMap<string, string>;
};
/** A lane ID can be an occurrence binding when native config uses an array key. */
export function gitGraphBranchName(
  model: MermaidGitGraphModel,
  id: string | undefined,
) {
  return model.branches.find((branch) => branch.id === id)?.name ?? "";
}
/** Native undeclared order is parseFloat(`0.${creationIndex}`), including
 * its repeated values after index 9. NaN is a stable sort tie, not invalid XY. */
export function orderedGitGraphBranches(model: MermaidGitGraphModel) {
  const value = (branch: MermaidGitBranch) =>
    branch.declaredOrder ?? Number(`0.${branch.order}`);
  return [...model.branches].sort((a, b) => value(a) - value(b));
}
export type GitGraphDerivedGraph = {
  sanitization: Readonly<Record<string, unknown>>;
  occurrences: GitGraphCommitOccurrence[];
  effectiveMap: ReadonlyMap<string, GitGraphCommitOccurrence>;
  contexts: GitGraphStatementContext[];
  finalContext: GitGraphStatementContext;
  diagnostics: import("./diagnostics.js").GitGraphDiagnostic[];
  abortedAt?: string;
};
