// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  deriveGitGraph,
  scanGitGraphSource,
  editGitGraphCommit,
  gitGraphDocument,
  type MermaidGitGraphModel,
} from "../../engine/gitgraph/index.js";
import { mermaidMessages as m } from "../../i18n.js";
import { formatGitGraphDiagnostic } from "./diagnostics.js";
import { gitGraphModelToVisual } from "./visual-model.js";
import type {
  GitGraphRepairHostProps,
  GitGraphFeedback,
} from "./react-host-contract.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { readGitGraphBoundSource } from "./gfx-data.js";
export type GitGraphSourceRepairPort = {
  getSource: () => string;
  getReadonly: () => boolean;
  getSourceMetadata?: () => MermaidVisualModel["familyData"];
  getTransientState: (key: string) => unknown;
  setTransientState: (key: string, value: unknown) => void;
  apply: (
    visual: MermaidVisualModel,
    sourceWrite: { baseSource: string; source: string },
  ) => { applied: boolean; diagnostic?: string };
  preview?: (visual: MermaidVisualModel) => () => void;
  /** Preserve only the whole owner transform; semantics come from current Source. */
  projectVisual?: (visual: MermaidVisualModel) => MermaidVisualModel;
  select?: (key: string) => void;
};
/** Both host slots repair current Source through this checked port. Retained
 * graphics are optional readonly context; they never supply command data. */
export function createGitGraphSourceRepairProps(
  port: GitGraphSourceRepairPort,
  view: Omit<
    GitGraphRepairHostProps,
    | "model"
    | "sourceBasis"
    | "diagnostics"
    | "readonly"
    | "onRename"
    | "onCancelPreview"
  >,
): GitGraphRepairHostProps {
  const source = port.getSource(),
    cache = port.getTransientState("gitgraph.invalidDocument") as
      { source: string; model: MermaidGitGraphModel } | undefined,
    current =
      cache?.source === source
        ? cache.model
        : !cache && port.getSourceMetadata
          ? readGitGraphBoundSource(source, port.getSourceMetadata())
              .currentModel
          : deriveGitGraph(
              scanGitGraphSource(source, {
                previous: cache?.model.sourceDocument,
              }),
            ).model;
  port.setTransientState("gitgraph.invalidDocument", {
    source,
    model: current,
  });
  let cancel = port.getTransientState("gitgraph.cancelPreview") as
    (() => void) | undefined;
  if (!cancel) {
    cancel = () => {
      (
        port.getTransientState("gitgraph.preview") as (() => void) | undefined
      )?.();
      port.setTransientState("gitgraph.preview", null);
      port.setTransientState("gitgraph.previewedSource", null);
    };
    port.setTransientState("gitgraph.cancelPreview", cancel);
  }
  return {
    ...view,
    model: current,
    sourceBasis: source,
    diagnostics: (current.derivedGraph?.diagnostics ?? []).map((d) => ({
      ...d,
      message: formatGitGraphDiagnostic(d, source),
    })),
    readonly: port.getReadonly(),
    onCancelPreview: cancel,
    onRename: (key, id, basis, preview): GitGraphFeedback => {
      const previewedSource = port.getTransientState(
        "gitgraph.previewedSource",
      );
      cancel!();
      if (port.getReadonly())
        return { changed: false, diagnostic: m.ganttReadOnly() };
      if (
        basis !== port.getSource() ||
        basis !== gitGraphDocument(current).source
      )
        return { changed: false, diagnostic: m.chartSourceChanged() };
      const record = current.sourceDocument!.records.find(
        (r) => r.sourceKey === key,
      );
      if (
        !record ||
        !["commit", "merge"].includes(record.kind) ||
        current.derivedGraph?.diagnostics.some(
          (d) => d.stage !== "render" && d.severity === "error",
        )
      )
        return { changed: false, diagnostic: m.classPatchRejected() };
      const result = editGitGraphCommit(current, key, { id });
      if (result.status === "rejected")
        return {
          changed: false,
          diagnostic: result.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) =>
              formatGitGraphDiagnostic(
                d,
                result.diagnosticSource ?? result.source,
              ),
            )
            .join("\n"),
          impact: result.impact,
        };
      if (!result.changed) return { changed: false, impact: result.impact };
      const canonical = gitGraphModelToVisual(result.model);
      const visual = port.projectVisual?.(canonical) ?? canonical;
      if (preview) {
        if (!port.preview)
          return { changed: false, diagnostic: m.classPatchRejected() };
        port.setTransientState("gitgraph.preview", port.preview(visual));
        port.setTransientState("gitgraph.previewedSource", result.source);
        return { changed: false, impact: result.impact };
      }
      if (result.impact.length && previewedSource !== result.source)
        return {
          changed: false,
          diagnostic: m.gitGraphPreviewImpact(),
          impact: result.impact,
        };
      const committed = port.apply(visual, {
        baseSource: basis,
        source: result.source,
      });
      if (!committed.applied)
        return {
          changed: false,
          diagnostic: committed.diagnostic ?? m.classPatchRejected(),
        };
      port.select?.(key);
      return {
        changed: true,
        sourceBasis: result.source,
        selection: key,
        impact: result.impact,
      };
    },
  };
}
