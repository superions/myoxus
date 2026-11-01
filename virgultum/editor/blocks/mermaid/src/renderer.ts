// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  adaptC4NativeRender,
  isC4NativeRenderDb,
} from "./families/c4/native-render-projection.js";
import {
  projectBlockNativeRenderEdges,
  type BlockNativeRenderEdge,
} from "./families/block/native-render-projection.js";
import {
  parseTimelineSource,
  projectTimelineNativeRenderSource,
} from "./engine/timeline/parser.js";
import type { Mermaid } from "mermaid";
import { resolveMermaidGitGraphSource } from "./engine/gitgraph/parser.js";
import { formatGitGraphDiagnostic } from "./families/gitgraph/diagnostics.js";
import { gitGraphNativeRenderDefaults } from "./families/gitgraph/native-render-projection.js";
import { projectStateNativeRenderSource } from "./engine/state/source-document.js";
import { parseMermaidPacketSource } from "./engine/packet/parser.js";
import { detectMermaidDiagramType } from "./engine/diagram-types.js";
import { projectKanbanNativeRenderSource } from "./engine/kanban/config.js";
import { parseMermaidGanttSource } from "./engine/gantt/parser.js";
import { ganttDiagnosticText } from "./families/gantt/family.js";
import { timelineDiagnosticMessage } from "./families/timeline/family.js";
import { mermaidMessages } from "./i18n.js";
import {
  projectGanttNativeRenderSource,
  projectGanttNativeRenderTasks,
  type GanttNativeRenderTask,
} from "./engine/gantt/render-source.js";

export type MermaidRenderResult = {
  svg: string;
};

/** Source diagnostics are user-correctable, not transient renderer failures. */
export class MermaidRenderSourceError extends Error {}

export type MermaidRendererOptions = {
  fontFamily?: string;
  idPrefix?: string;
  theme?: "default" | "dark" | "forest" | "neutral";
};

export const DEFAULT_MERMAID_FONT_FAMILY =
  "var(--myoxus-typography-body-family)";

let mermaidModule: Mermaid | null = null;
let renderTail: Promise<void> = Promise.resolve();

function createRenderId(prefix = "myoxus-mermaid-diagram") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function loadMermaid() {
  if (mermaidModule) return mermaidModule;
  const imported = await import("mermaid");
  mermaidModule = imported.default;
  return mermaidModule;
}

/** The renderer initializes Mermaid without overriding this bound native ceiling. */
export async function readMermaidSourceLimit() {
  const mermaid = await loadMermaid();
  const limit = mermaid.mermaidAPI.defaultConfig.maxTextSize;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1)
    throw new Error("source-limit");
  return limit;
}

/** Read native defaults, never the mutable config left by another diagram. */
export async function readMermaidGanttDefaults() {
  const mermaid = await loadMermaid();
  return { ...mermaid.mermaidAPI.defaultConfig.gantt };
}
export async function readMermaidTimelineDefaults() {
  const mermaid = await loadMermaid();
  // The bound LR/TD renderer supplies padding when the schema default omits it.
  return {
    ...mermaid.mermaidAPI.defaultConfig.timeline,
    padding: mermaid.mermaidAPI.defaultConfig.timeline?.padding ?? 50,
  };
}

export async function renderMermaidSvg(
  source: string,
  options: MermaidRendererOptions = {},
): Promise<MermaidRenderResult> {
  // Mermaid shares initialized config and diagram databases across instances.
  // Serialize initialization plus rendering, including the scoped native DB data
  // projection; a rejected render must not poison later renders.
  const result = renderTail.then(() => renderSerialized(source, options));
  renderTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Native grammar/DB validation shares the render queue because Mermaid's
 * preprocessing and parser initialization mutate the same global runtime. */
export function validateMermaidSource(source: string): Promise<void> {
  const result = renderTail.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    const type = detectMermaidDiagramType(source);
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(
      type === "stateDiagram" || type === "stateDiagram-v2"
        ? projectStateNativeRenderSource(source)
        : source,
    );
    // StateDB also checks resolved group descriptions when extracting data.
    if ("getData" in diagram.db && typeof diagram.db.getData === "function") {
      diagram.db.getData();
    }
  });
  renderTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function renderSerialized(
  source: string,
  options: MermaidRendererOptions,
): Promise<MermaidRenderResult> {
  if (detectMermaidDiagramType(source) === "gitGraph") {
    const errors = resolveMermaidGitGraphSource(source).diagnostics.filter(
      (d) => d.severity === "error",
    );
    // Native GitGraph traverses the final ID map recursively. A cyclic map can
    // overflow or leave partial SVG; expose its owning Source diagnosis first.
    if (errors.length)
      throw new MermaidRenderSourceError(
        errors.map((d) => formatGitGraphDiagnostic(d, source)).join("\n"),
      );
  }
  const packetModel =
    detectMermaidDiagramType(source) === "packet"
      ? parseMermaidPacketSource(source)
      : null;
  const packetDisplayDiagnostic = packetModel?.diagnostics.find(
    (issue) => issue.code !== "syntax",
  );
  // Native populate stops allocating at its row guard without throwing, then returns
  // a partial diagram. Reject that projection before it can look like a complete Packet.
  if (packetDisplayDiagnostic)
    throw new MermaidRenderSourceError(
      `Packet line ${packetDisplayDiagnostic.line}: ${packetDisplayDiagnostic.message}`,
    );
  const ganttModel =
    detectMermaidDiagramType(source) === "gantt"
      ? parseMermaidGanttSource(source)
      : null;
  if (ganttModel?.ambiguous)
    throw new MermaidRenderSourceError(
      ganttModel.diagnostics.map(ganttDiagnosticText).join("\n") ||
        mermaidMessages.ganttAmbiguousSource(),
    );
  if (ganttModel?.tasks.some((task) => !ganttModel.intervals[task.recordId]))
    throw new MermaidRenderSourceError(
      ganttModel.diagnostics.map(ganttDiagnosticText).join("\n") ||
        mermaidMessages.ganttDiagnosticInvalidSchedule(),
    );
  // Native Gantt derives its time scale from tasks. An empty domain makes its
  // today line emit NaN coordinates; preserve the host's existing empty state.
  if (ganttModel && !ganttModel.tasks.length && !ganttModel.diagnostics.length)
    return { svg: "" };
  const timelineModel =
    detectMermaidDiagramType(source) === "timeline"
      ? parseTimelineSource(source)
      : null;
  if (timelineModel?.diagnostics.length)
    throw new MermaidRenderSourceError(
      timelineModel.diagnostics.map(timelineDiagnosticMessage).join("\n"),
    );
  if (
    timelineModel &&
    !timelineModel.periods.length &&
    !timelineModel.sections.length
  )
    return { svg: "" };
  const normalized = timelineModel
    ? projectTimelineNativeRenderSource(timelineModel).trim()
    : detectMermaidDiagramType(source) === "kanban"
      ? projectKanbanNativeRenderSource(source.trim())
      : ["stateDiagram", "stateDiagram-v2"].includes(
            detectMermaidDiagramType(source),
          )
        ? projectStateNativeRenderSource(source.trim())
        : projectGanttNativeRenderSource(source.trim());
  if (!normalized) {
    return { svg: "" };
  }

  const mermaid = await loadMermaid();
  const nativeDefaults =
    detectMermaidDiagramType(source) === "gitGraph"
      ? gitGraphNativeRenderDefaults(source)
      : undefined;
  mermaid.initialize({
    startOnLoad: false,
    ...nativeDefaults,
    theme: options.theme ?? nativeDefaults?.theme ?? "default",
    securityLevel: "strict",
    fontFamily:
      options.fontFamily ??
      nativeDefaults?.fontFamily ??
      DEFAULT_MERMAID_FONT_FAMILY,
    flowchart: {
      htmlLabels: true,
      useMaxWidth: true,
    },
    sequence: {
      useMaxWidth: true,
    },
    gantt: {
      useMaxWidth: true,
    },
    gitGraph: {
      useMaxWidth: true,
    },
    journey: {
      useMaxWidth: true,
    },
    pie: {
      useMaxWidth: true,
    },
  });

  const renderId = createRenderId(options.idPrefix);
  let restoreTasks: (() => void) | undefined;
  let restoreEdges: (() => void) | undefined;
  let restoreC4: (() => void) | undefined;
  try {
    // Use the native public Diagram API and its existing Gantt task getter.
    // Preserve native grammar, styles, excluded bands and strict sanitization;
    // only fixed boundaries come from the same engine as the visual editor.
    if (detectMermaidDiagramType(source) === "gantt") {
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(normalized);
      if (
        !("getTasks" in diagram.db) ||
        typeof diagram.db.getTasks !== "function"
      )
        throw new Error("Native Gantt renderer has no task projection.");
      const db = diagram.db as typeof diagram.db & {
        getTasks: () => GanttNativeRenderTask[];
      };
      const getTasks = db.getTasks;
      db.getTasks = () => {
        const tasks = projectGanttNativeRenderTasks(source, getTasks.call(db));
        if (
          tasks.some(
            (task) =>
              !Number.isFinite(task.startTime.getTime()) ||
              !Number.isFinite(task.endTime.getTime()) ||
              (task.renderEndTime &&
                !Number.isFinite(task.renderEndTime.getTime())),
          )
        )
          throw new MermaidRenderSourceError(
            mermaidMessages.ganttDiagnosticInvalidSchedule(),
          );
        return [...tasks];
      };
      restoreTasks = () => {
        db.getTasks = getTasks;
      };
    }
    if (detectMermaidDiagramType(source) === "block") {
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(normalized);
      if (
        !("getEdges" in diagram.db) ||
        typeof diagram.db.getEdges !== "function"
      )
        throw new Error("Native Block renderer has no edge projection.");
      const db = diagram.db as typeof diagram.db & {
          getEdges: () => BlockNativeRenderEdge[];
        },
        getEdges = db.getEdges;
      db.getEdges = () => [
        ...projectBlockNativeRenderEdges(source, getEdges.call(db)),
      ];
      restoreEdges = () => {
        db.getEdges = getEdges;
      };
    }
    if (detectMermaidDiagramType(source) === "c4") {
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(normalized);
      if (!isC4NativeRenderDb(diagram.db))
        throw new Error("Native C4 renderer has no public DB projection.");
      try {
        restoreC4 = adaptC4NativeRender(source, diagram.db);
      } catch (error) {
        throw new MermaidRenderSourceError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const { svg } = await mermaid.render(renderId, normalized);
    return { svg };
  } finally {
    restoreC4?.();
    restoreEdges?.();
    restoreTasks?.();
    // Mermaid removes its temporary host after successful renders, but leaves
    // the error SVG behind when parsing fails. Own-ID cleanup prevents failed
    // source previews from leaking into the document and accessibility tree.
    globalThis.document?.getElementById(`d${renderId}`)?.remove();
    globalThis.document?.getElementById(`i${renderId}`)?.remove();
  }
}
