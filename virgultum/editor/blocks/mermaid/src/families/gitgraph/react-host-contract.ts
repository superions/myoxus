// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TemplateResult } from "lit";
import type {
  MermaidGitGraphModel,
  GitGraphCommandResult,
  GitGraphInsertAnchor,
} from "../../engine/gitgraph/index.js";
import type {
  MermaidGfxActionContext,
  MermaidGfxObjectEditIntent,
} from "../runtime/editor-capabilities.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";
import type {
  GitGraphAction,
  GitGraphCommandName,
  GitGraphCommandArgs,
} from "./actions.js";
import type { GitGraphBinding } from "./gfx-data.js";
export type GitGraphFeedback = {
  changed: boolean;
  sourceBasis?: string;
  selection?: string;
  diagnostic?: string;
  impact?: GitGraphCommandResult["impact"];
};
export type GitGraphSelection = GitGraphBinding & {
  visualKey: string;
  kind: "node" | "edge";
};
export type GitGraphReactHostProps = {
  surface: "editor" | "controls";
  model: MermaidGitGraphModel;
  sourceBasis: string;
  visualModel: MermaidVisualModel;
  selected: GitGraphSelection | null;
  selectedKeys: readonly string[];
  selectionProblem?: string;
  guidesVisible: boolean;
  commentsVisible: boolean;
  onCopySource?: () => Promise<void>;
  onExportMmd?: () => void;
  onVisibility: (kind: "guides" | "comments", visible: boolean) => void;
  /** Visible carrier extent, in the same viewport coordinates as the anchor. */
  selectedAnchor: { left: number; top: number; height?: number } | null;
  intent: MermaidGfxObjectEditIntent | null;
  parentIntent: GitGraphAction | null;
  readonly: boolean;
  displayOnly: boolean;
  embedded: boolean;
  embeddedEditing: boolean;
  actionTarget: HTMLElement | null;
  workarea: TemplateResult | null;
  workareaFooter: TemplateResult | null;
  pageViewport?: MermaidPageViewportProjection;
  viewportIdentity?: object;
  onCommand: <K extends GitGraphCommandName>(
    name: K,
    args: GitGraphCommandArgs<K>,
    basis: string,
  ) => GitGraphFeedback;
  onPreview: <K extends GitGraphCommandName>(
    name: K,
    args: GitGraphCommandArgs<K>,
    basis: string,
  ) => GitGraphFeedback;
  onCancelPreview: () => void;
  onCloseSelection: () => void;
  onEditIntent: (intent: MermaidGfxObjectEditIntent | null) => void;
  onParentIntent: (intent: GitGraphAction | null) => void;
  resolveVisualAnchor: MermaidGfxActionContext["resolveVisualAnchor"];
  resolveSequenceAnchor: (
    point: { left: number; top: number },
    key: string,
  ) => GitGraphInsertAnchor | null;
  selectSourceKey: (key: string, role?: "origin" | "head") => void;
  onWorkareaResize: () => void;
  onEmbeddedActionsInsetChange: (height: number) => void;
  resolveReturnFocusTarget: () => HTMLElement | null;
  subscribeEditIntent?: (
    handler: (intent: MermaidGfxObjectEditIntent) => void,
  ) => () => void;
};
export const mermaidGitGraphRendererToken =
  defineMermaidFamilyReactRendererToken<GitGraphReactHostProps>(
    "mermaid.gitgraph",
  );

export type GitGraphRepairHostProps = {
  surface: "editor" | "controls";
  model: MermaidGitGraphModel;
  sourceBasis: string;
  diagnostics: import("../../engine/gitgraph/diagnostics.js").GitGraphDiagnostic[];
  readonly: boolean;
  embedded: boolean;
  workarea: TemplateResult | null;
  workareaFooter: TemplateResult | null;
  pageViewport?: MermaidPageViewportProjection;
  viewportIdentity?: object;
  onRename: (
    sourceKey: string,
    id: string,
    basis: string,
    preview: boolean,
  ) => GitGraphFeedback;
  onCancelPreview: () => void;
  resolveReturnFocusTarget: () => HTMLElement | null;
  onWorkareaResize: () => void;
};
export const mermaidGitGraphRepairRendererToken =
  defineMermaidFamilyReactRendererToken<GitGraphRepairHostProps>(
    "mermaid.gitgraph.repair",
  );
