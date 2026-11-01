// SPDX-License-Identifier: AGPL-3.0-or-later
import { Bound } from "@virgultum/global/gfx";
import type { ToolbarContext } from "@virgultum/shared/services";
import type {
  MermaidFamilyHostAdapter,
  MermaidFamilyEdgelessToolbarContribution,
  MermaidPageSelectionItem,
} from "../runtime/contracts.js";
import { MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS } from "../runtime/contracts.js";
import type {
  MermaidGfxActionContext,
  MermaidHostProjectionContext,
  MermaidGfxObjectEditIntent,
} from "../runtime/editor-capabilities.js";
import { MermaidFamilyReactHostIdentifier } from "../runtime/react-host.js";
import {
  mermaidSequenceRendererToken,
  type SequenceReactHostProps,
  type SequenceSelection,
} from "./react-host-contract.js";
import {
  SEQUENCE_PARENT_ACTIONS,
  SEQUENCE_PARENT_ACTION_LABELS,
  runSequenceCommand,
  sequencePageSelectionTools,
  type SequenceParentAction,
} from "./actions.js";
import { sequenceNodeBinding, sequenceFamilyPayload } from "./gfx-data.js";
import { readSequenceProjectionModel } from "./source-application.js";
import { sequenceModelToVisual } from "./visual-model.js";
import { sequenceCommentMarkers } from "./annotation-projection.js";
import * as engine from "../../engine/sequence/index.js";
import { mermaidMessages as m } from "../../i18n.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  resolveMermaidEdgelessSelection,
  resolveMermaidEdgelessOwnerSelection,
  runMermaidEdgelessMutation,
} from "../../edgeless-toolbar/selection-context.js";
import { getMermaidBlockSource } from "../../utils.js";
import { detectMermaidDiagramType } from "../../engine/diagram-types.js";
import {
  getMermaidGfxNode,
  getMermaidGfxConnector,
  getMermaidGfxSubgraph,
  getMermaidVisualModelForEditing,
  applyMermaidVisualModelCommand,
} from "../../commands.js";
import {
  readMermaidGfxNodeId,
  readMermaidGfxEdgeId,
  readMermaidGfxSubgraphId,
  readMermaidGfxMeta,
} from "../../mermaid-gfx-metadata.js";
import { MERMAID_GFX_TITLE_ROLE } from "../runtime/gfx-element-roles.js";
import { previewMermaidGfxModel } from "../runtime/gfx-preview.js";

export function sequenceSelection(
  visual: MermaidVisualModel,
  item: MermaidPageSelectionItem | MermaidGfxObjectEditIntent | null,
): SequenceSelection | null {
  if (!item) return null;
  const key = "editKey" in item ? item.editKey : item.id;
  if (item.kind === "edge")
    return visual.edges.some((e) => e.id === key)
      ? { kind: "message", key }
      : null;
  if (item.kind === "subgraph") {
    const group = visual.subgraphs?.find((g) => g.id === key),
      role = group && sequenceFamilyPayload(group)?.role;
    return role === "fragment" || role === "box" || role === "rect"
      ? { kind: role, key }
      : null;
  }
  const node = visual.nodes.find((n) => n.id === key),
    binding = node && sequenceNodeBinding(node);
  if (!binding) return null;
  if (["lifeline", "lifecycle"].includes(binding.role))
    return { kind: "participant", key: binding.sourceKey, visualKey: node!.id };
  return {
    kind: binding.role as "participant" | "activation" | "note" | "branch",
    key: binding.sourceKey,
    visualKey: node!.id,
  };
}
export function sequenceSelectionImpact(
  model: engine.MermaidSequenceModel,
  item: SequenceSelection,
  keepContents = false,
): engine.SequenceImpact {
  if (item.kind === "participant")
    return engine.sequenceParticipantDeleteImpact(model, item.key);
  const result =
    item.kind === "message"
      ? engine.deleteSequenceMessage(model, item.key)
      : item.kind === "activation"
        ? engine.deleteSequenceActivation(model, item.key)
        : item.kind === "fragment"
          ? engine.deleteSequenceFragment(model, item.key, keepContents)
          : item.kind === "branch"
            ? engine.deleteSequenceBranch(model, item.key)
            : item.kind === "box" || item.kind === "rect"
              ? engine.deleteSequenceBackground(model, item.key)
              : item.kind === "note"
                ? engine.deleteSequenceNote(model, item.key)
                : null;
  return result?.impact ?? { records: [] };
}
export type SequenceCommandPort = {
  getSource: () => string;
  getReadonly: () => boolean;
  getVisualModel: () => MermaidVisualModel;
  applyVisualModel: MermaidGfxActionContext["applyVisualModel"];
  selectAfterProjection: MermaidGfxActionContext["selectAfterProjection"];
  previewVisualModel: (visual: MermaidVisualModel) => () => void;
  getPreview: () => (() => void) | null;
  setPreview: (dispose: (() => void) | null) => void;
};
/** Page, embedded Notes and native owners execute this same checked command.
 * Candidate projection already contains advanced bindings when it is committed. */
export function createSequenceCommandConsumer(
  port: SequenceCommandPort,
  preview = false,
): SequenceReactHostProps["onCommand"] {
  return (name, args, basis) => {
    // Every attempt replaces its preview, including invalid drafts and stale
    // Source/rights. A rejected command must restore the last valid projection.
    port.getPreview()?.();
    port.setPreview(null);
    if (port.getReadonly())
      return { changed: false, diagnostic: m.ganttReadOnly() };
    const current = port.getSource();
    if (current !== basis)
      return { changed: false, diagnostic: m.sequenceSourceConflict() };
    const model = readSequenceProjectionModel(current, port.getVisualModel());
    if (!model)
      return { changed: false, diagnostic: m.sequencePatchRejected() };
    const result = runSequenceCommand(model, name, args);
    if (result.status === "rejected")
      return {
        changed: false,
        diagnostic: result.diagnostic,
        impact: result.impact,
      };
    if (!result.changed) return { changed: false, impact: result.impact };
    const visual = sequenceModelToVisual(result.model);
    if (preview) {
      port.setPreview(port.previewVisualModel(visual));
      return {
        changed: false,
        impact: result.impact,
        selection: result.selection,
      };
    }
    const feedback = port.applyVisualModel(visual, {
      preserveSourceBytes: true,
      sourceWrite: { baseSource: current, source: result.source },
    });
    if (!feedback.applied)
      return {
        changed: false,
        diagnostic: feedback.diagnostic ?? m.sequencePatchRejected(),
        impact: result.impact,
      };
    if (result.selection) {
      const kind = visual.nodes.some((n) => n.id === result.selection)
        ? "node"
        : visual.edges.some((e) => e.id === result.selection)
          ? "edge"
          : visual.subgraphs?.some((g) => g.id === result.selection)
            ? "subgraph"
            : null;
      if (kind) port.selectAfterProjection({ kind, editKey: result.selection });
    }
    return {
      changed: true,
      sourceBasis: result.source,
      selection: result.selection,
      impact: result.impact,
    };
  };
}
function sequenceTimelineAnchor(
  model: engine.MermaidSequenceModel,
  anchor: engine.SequenceTimelineAnchor,
  resolve: (
    kind: "node" | "edge" | "subgraph",
    key: string,
  ) => { left: number; top: number; width: number; height: number } | null,
) {
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === anchor.key,
  );
  if (!record) return null;
  let key = record.sourceKey,
    kind: "node" | "edge" | "subgraph" =
      record.kind === "message"
        ? "edge"
        : ["fragment", "rect", "box", "end"].includes(record.kind)
          ? "subgraph"
          : "node",
    bottom = anchor.position === "after";
  if (record.kind === "end") {
    key = record.blockKey ?? record.parentId ?? key;
    bottom = true;
  }
  if (record.kind === "activation") {
    const interval = model.activationIntervals.find(
      (a) => a.startId === key || a.endId === key,
    );
    if (interval) {
      bottom = interval.endId === key;
      key = interval.id;
    }
  }
  const rect = resolve(kind, key);
  return rect
    ? {
        left: rect.left + rect.width,
        top: rect.top + (bottom ? rect.height : 0),
      }
    : null;
}
function timelineDropAnchor(
  model: engine.MermaidSequenceModel,
  point: { left: number; top: number },
  excluded: string,
  resolve: (
    anchor: engine.SequenceTimelineAnchor,
  ) => { left: number; top: number } | null,
  bounds: { left: number; top: number; width: number; height: number } | null,
): engine.SequenceTimelineAnchor | null {
  const points = model.sourceDocument.records
    .filter((r) => r.temporal && r.sourceKey !== excluded)
    .flatMap((record) => {
      const anchor = resolve({ key: record.sourceKey });
      return anchor ? [{ record, anchor }] : [];
    });
  if (!points.length) return null;
  if (
    !bounds ||
    point.left < bounds.left ||
    point.left > bounds.left + bounds.width ||
    point.top < bounds.top ||
    point.top > bounds.top + bounds.height
  )
    return null;
  const nearest = points.reduce((a, b) =>
    Math.abs(a.anchor.top - point.top) < Math.abs(b.anchor.top - point.top)
      ? a
      : b,
  );
  return {
    key: nearest.record.sourceKey,
    position: point.top < nearest.anchor.top ? "before" : "after",
  };
}
function participantDropBefore(
  model: engine.MermaidSequenceModel,
  point: { left: number; top: number },
  key: string,
  resolve: (
    key: string,
  ) => { left: number; top: number; width: number; height: number } | null,
) {
  const participant = model.participants.find((p) => p.sourceKey === key);
  if (!participant || participant.createdBy) return null;
  const points = model.participants
    .filter(
      (p) => p !== participant && p.boxId === participant.boxId && !p.createdBy,
    )
    .flatMap((p) => {
      const anchor = resolve(p.sourceKey);
      return anchor ? [{ p, anchor }] : [];
    });
  const nearest = points.reduce<(typeof points)[number] | null>(
    (a, b) =>
      !a ||
      Math.abs(a.anchor.left + a.anchor.width / 2 - point.left) >
        Math.abs(b.anchor.left + b.anchor.width / 2 - point.left)
        ? b
        : a,
    null,
  );
  const own = resolve(key);
  if (!nearest || !own) return null;
  const top = Math.min(own.top, ...points.map((p) => p.anchor.top)),
    bottom = Math.max(
      own.top + own.height,
      ...points.map((p) => p.anchor.top + p.anchor.height),
    );
  if (point.top < top || point.top > bottom) return null;
  return point.left < nearest.anchor.left + nearest.anchor.width / 2
    ? nearest.p.sourceKey
    : (points[points.indexOf(nearest) + 1]?.p.sourceKey ?? "");
}
export function createSequenceEditorProps(
  context: MermaidGfxActionContext,
  host: MermaidHostProjectionContext,
): SequenceReactHostProps | null {
  const model = readSequenceProjectionModel(
    host.getSource(),
    context.visualModel,
  );
  if (!model) return null;
  const intent = host.getTransientState(
      "sequence.editIntent",
    ) as MermaidGfxObjectEditIntent | null,
    parentIntent = host.getTransientState(
      "sequence.parentIntent",
    ) as SequenceParentAction | null,
    selected = sequenceSelection(
      context.visualModel,
      intent ??
        (context.selectedItems.length === 1 ? context.selectedItems[0]! : null),
    ),
    cancelPreview = () => {
      (host.getTransientState("sequence.preview") as (() => void) | null)?.();
      host.setTransientState("sequence.preview", null);
    },
    port: SequenceCommandPort = {
      getSource: host.getSource,
      getReadonly: () => host.getReadonly() || context.readonly,
      getVisualModel: () => context.visualModel,
      applyVisualModel: context.applyVisualModel,
      selectAfterProjection: context.selectAfterProjection,
      previewVisualModel: (visual) => {
        if (!context.previewVisualModel)
          throw new Error("Missing native GFX preview port");
        return context.previewVisualModel(visual);
      },
      getPreview: () =>
        host.getTransientState("sequence.preview") as (() => void) | null,
      setPreview: (dispose) =>
        host.setTransientState("sequence.preview", dispose),
    };
  const close = (value: MermaidGfxObjectEditIntent | null) => {
    cancelPreview();
    host.setTransientState("sequence.editIntent", value);
    context.refreshWorkarea();
    if (!value)
      requestAnimationFrame(() => {
        if (
          !host.getTransientState("sequence.editIntent") &&
          !host.getTransientState("sequence.parentIntent")
        )
          context.resolveReturnFocusTarget()?.focus({ preventScroll: true });
      });
  };
  return {
    surface: "editor",
    model,
    config: engine.readSequenceConfig(model.sourceDocument).config,
    sourceBasis: host.getSource(),
    selected,
    selectedKeys: context.selectedItems.flatMap((item) => {
      const value = sequenceSelection(context.visualModel, item);
      return value ? [value.key] : [];
    }),
    selectedBounds: selected
      ? context.resolveVisualBounds?.(
          selected.kind === "message"
            ? "edge"
            : ["box", "rect", "fragment"].includes(selected.kind)
              ? "subgraph"
              : "node",
          selected.visualKey ?? selected.key,
        )
      : null,
    resolveParticipantAnchor: (key) => {
      const rect = context.resolveVisualBounds?.("node", key, true);
      return rect ? { left: rect.left + rect.width / 2, top: rect.top } : null;
    },
    resolveTimelineDropAnchor: (point, key) =>
      timelineDropAnchor(
        model,
        point,
        key,
        (anchor) =>
          sequenceTimelineAnchor(
            model,
            anchor,
            (kind, key) =>
              context.resolveVisualBounds?.(kind, key, true) ?? null,
          ),
        context.resolveVisualBounds?.("diagram", "", true) ?? null,
      ),
    resolveParticipantDropBefore: (point, key) =>
      participantDropBefore(
        model,
        point,
        key,
        (key) => context.resolveVisualBounds?.("node", key, true) ?? null,
      ),
    selectedAnchor:
      intent?.anchor ??
      (selected
        ? context.resolveVisualAnchor(
            selected.kind === "message"
              ? "edge"
              : ["box", "rect", "fragment"].includes(selected.kind)
                ? "subgraph"
                : "node",
            selected.visualKey ?? selected.key,
          )
        : null),
    intent,
    parentIntent,
    readonly: context.readonly,
    displayOnly: context.displayOnly,
    embedded: context.embedded,
    embeddedEditing: context.embeddedEditing,
    actionTarget: context.actionTarget,
    workarea: context.workarea,
    workareaFooter: context.workareaFooter,
    pageViewport: context.pageViewport,
    commentMarkers: sequenceCommentMarkers(model, context.resolveVisualAnchor),
    getImpact: (item, keepContents) =>
      sequenceSelectionImpact(model, item, keepContents),
    getDeleteImpact: (keys) =>
      engine.deleteSequenceSelection(model, keys).impact ?? { records: [] },
    onCommand: createSequenceCommandConsumer(port),
    onPreview: createSequenceCommandConsumer(port, true),
    onCancelPreview: cancelPreview,
    resolveTimelineAnchor: (anchor) =>
      sequenceTimelineAnchor(
        model,
        anchor,
        (kind, key) => context.resolveVisualBounds?.(kind, key, true) ?? null,
      ),
    onParentIntent: (value) => {
      cancelPreview();
      host.setTransientState("sequence.editIntent", null);
      host.setTransientState("sequence.parentIntent", value);
      context.refreshWorkarea();
    },
    onEditIntent: close,
    onCloseSelection: () => {
      close(null);
      context.closeInspector();
    },
    onWorkareaResize: context.refreshWorkarea,
    onEmbeddedActionsInsetChange: context.onEmbeddedActionsInsetChange,
    resolveReturnFocusTarget: context.resolveReturnFocusTarget,
  };
}
export const mermaidSequenceHostAdapter: MermaidFamilyHostAdapter = {
  projectGfx: (resolution) => ({
    kind: "gfx",
    readonlyExploration: true,
    renderSurface: resolution.renderSurface,
    pageSelectionTools: sequencePageSelectionTools,
    project: (host, displayOnly) =>
      host.renderGfx(resolution.visualModel, {
        displayOnly,
        embeddedFacadeSurface: true,
        renderSurface: resolution.renderSurface,
        pageSelectionTools: sequencePageSelectionTools,
        onObjectEditIntent: (intent) => {
          if (host.getReadonly()) return false;
          host.setTransientState("sequence.pendingEditIntent", intent);
          return true;
        },
        projectActions: (context) => {
          const edit = host.getTransientState(
            "sequence.pendingEditIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (edit) {
            if (edit.kind === "edge") context.selectEdge(edit.id);
            else if (edit.kind === "subgraph") context.selectContainer(edit.id);
            else context.selectNode(edit.ownerId ?? edit.id);
            host.setTransientState(
              "sequence.editIntent",
              edit.action === "select" ? null : edit,
            );
            host.setTransientState(
              "sequence.parentIntent",
              edit.action === "delete" ? "deleteSelection" : null,
            );
            host.setTransientState("sequence.pendingEditIntent", null);
          }
          const active = host.getTransientState(
            "sequence.editIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (
            !edit &&
            active &&
            !context.selectedItems.some(
              (item) => item.editKey === (active.ownerId ?? active.id),
            )
          )
            host.setTransientState("sequence.editIntent", null);
          const props = createSequenceEditorProps(context, host);
          host.setSelectionAction(
            context.selectedItems.length
              ? {
                  label: m.visualDelete(),
                  disabled: context.readonly,
                  onSelect: () => {
                    props?.onParentIntent("deleteSelection");
                  },
                }
              : null,
          );
          if (!props) return null;
          const body = context.reactHost?.renderFamilyEditor(
            mermaidSequenceRendererToken,
            props,
          );
          return body
            ? {
                body,
                actions: {
                  actions:
                    displayOnly || context.embedded
                      ? []
                      : SEQUENCE_PARENT_ACTIONS.map((id) => ({
                          id: `sequence.${id}`,
                          label: SEQUENCE_PARENT_ACTION_LABELS[id](),
                          disabled: context.readonly && id !== "data",
                        })),
                  portal: !context.embedded,
                  selectionAction: host.getSelectionAction(),
                },
              }
            : null;
        },
      }),
  }),
  projectPreview: (visual, source) =>
    mermaidSequenceHostAdapter.projectGfx({
      visualModel: visual,
      source,
      diagramType: "sequenceDiagram",
      renderSurface: "core-facade",
    }),
};

const nativePreviews = new WeakMap<object, () => void>();
function nativeSequenceProps(
  context: ToolbarContext,
): SequenceReactHostProps | null {
  const state = resolveMermaidEdgelessSelection(context);
  if (!state?.visualModel || state.diagramType !== "sequenceDiagram")
    return null;
  const source = getMermaidBlockSource(state.owner.props),
    visual = state.visualModel,
    model = readSequenceProjectionModel(source, visual);
  if (!model) return null;
  const items = [
      ...new Map(
        state.selectedModels
          .flatMap<MermaidPageSelectionItem>((element) => {
            const node = readMermaidGfxNodeId(element),
              edge = readMermaidGfxEdgeId(element),
              group = readMermaidGfxSubgraphId(element);
            return node
              ? [{ kind: "node", editKey: node }]
              : edge
                ? [{ kind: "edge", editKey: edge }]
                : group
                  ? [{ kind: "subgraph", editKey: group }]
                  : [];
          })
          .map((item) => [`${item.kind}:${item.editKey}`, item]),
      ).values(),
    ],
    title =
      state.selectedModels.length === 1 &&
      readMermaidGfxMeta(state.selectedModels[0], "mermaidRole") ===
        MERMAID_GFX_TITLE_ROLE,
    selected: SequenceSelection | null = title
      ? { kind: "title", key: state.selectedModels[0]!.id }
      : sequenceSelection(visual, items.length === 1 ? items[0]! : null),
    cancelPreview = () => {
      nativePreviews.get(state.owner)?.();
      nativePreviews.delete(state.owner);
    };
  const getElement = (kind: string, key: string) =>
    kind === "edge"
      ? getMermaidGfxConnector(context.store, state.owner, key)
      : kind === "subgraph"
        ? getMermaidGfxSubgraph(context.store, state.owner, key)
        : getMermaidGfxNode(context.store, state.owner, key);
  const point = (kind: string, key: string) => {
    const element = getElement(kind, key);
    if (!element?.xywh) return null;
    const bound = Bound.deserialize(element.xywh),
      rect = context.gfx.viewport.boundingClientRect,
      [left, top] = context.gfx.viewport.toViewCoord(bound.maxX, bound.y);
    return { left: left + rect.left, top: top + rect.top };
  };
  const nativeBounds = (kind: string, key: string) => {
    const element = kind === "diagram" ? state.owner : getElement(kind, key);
    if (!element?.xywh) return null;
    const b = Bound.deserialize(element.xywh),
      rect = context.gfx.viewport.boundingClientRect,
      a = context.gfx.viewport.toViewCoord(b.x, b.y),
      z = context.gfx.viewport.toViewCoord(b.maxX, b.maxY);
    return {
      left: a[0] + rect.left,
      top: a[1] + rect.top,
      width: z[0] - a[0],
      height: z[1] - a[1],
    };
  };
  const port: SequenceCommandPort = {
    getSource: () => getMermaidBlockSource(state.owner.props),
    getReadonly: () => context.store.readonly,
    getVisualModel: () =>
      getMermaidVisualModelForEditing(context.std, state.owner) ?? visual,
    getPreview: () => nativePreviews.get(state.owner) ?? null,
    setPreview: (dispose) => {
      if (dispose) nativePreviews.set(state.owner, dispose);
      else nativePreviews.delete(state.owner);
    },
    previewVisualModel: (candidate) => {
      const first = visual.nodes.find((n) =>
          getMermaidGfxNode(context.store, state.owner, n.id),
        ),
        element =
          first && getMermaidGfxNode(context.store, state.owner, first.id),
        surface = state.owner.surface;
      if (!surface) throw new Error("Missing native GFX Surface");
      const bound = element
        ? Bound.deserialize(element.xywh)
        : Bound.deserialize(state.owner.xywh);
      return previewMermaidGfxModel(candidate, {
        surface,
        creator: state.owner,
        viewport: context.gfx.viewport,
        origin: new Bound(
          bound.x - (first?.x ?? 0),
          bound.y - (first?.y ?? 0),
          bound.w,
          bound.h,
        ),
        elements: state.owner.childIds.flatMap((id) => {
          const element = surface.getElementById(id);
          return element &&
            "stash" in element &&
            readMermaidGfxMeta(element, "mermaidRole") !==
              MERMAID_GFX_TITLE_ROLE
            ? [element]
            : [];
        }),
        refresh: () => context.gfx.surfaceComponent?.requestUpdate(),
      });
    },
    applyVisualModel: (next, options) => {
      let feedback: { applied: boolean; diagnostic?: string } = {
        applied: false,
      };
      const applied = runMermaidEdgelessMutation(context, state.owner, () => {
        const [ok, result] = context.command.exec(
          applyMermaidVisualModelCommand,
          {
            model: state.owner,
            visualModel: next,
            sourceWrite: options?.sourceWrite,
          },
        );
        feedback = {
          applied: Boolean(ok && result?.applied),
          diagnostic: result?.diagnostic,
        };
        return feedback.applied;
      });
      return { ...feedback, applied };
    },
    selectAfterProjection: (item) => {
      const element = getElement(item.kind, item.editKey);
      if (element)
        context.gfx.selection.set({ editing: false, elements: [element.id] });
    },
  };
  return {
    surface: "controls",
    model,
    config: engine.readSequenceConfig(model.sourceDocument).config,
    sourceBasis: source,
    selected,
    selectedKeys: items.flatMap((item) => {
      const value = sequenceSelection(visual, item);
      return value ? [value.key] : [];
    }),
    resolveTimelineDropAnchor: (point, key) =>
      timelineDropAnchor(
        model,
        point,
        key,
        (anchor) => sequenceTimelineAnchor(model, anchor, nativeBounds),
        nativeBounds("diagram", ""),
      ),
    resolveParticipantDropBefore: (position, key) =>
      participantDropBefore(model, position, key, (key) =>
        nativeBounds("node", key),
      ),
    selectedAnchor: null,
    selectedBounds: selected
      ? nativeBounds(
          selected.kind === "message"
            ? "edge"
            : ["box", "rect", "fragment"].includes(selected.kind)
              ? "subgraph"
              : "node",
          selected.visualKey ?? selected.key,
        )
      : null,
    resolveParticipantAnchor: (key) => point("node", key),
    intent: null,
    parentIntent: null,
    readonly: context.readonly,
    displayOnly: false,
    embedded: false,
    embeddedEditing: false,
    workarea: null,
    workareaFooter: null,
    commentMarkers: sequenceCommentMarkers(model, (kind, key) =>
      kind === "diagram"
        ? point("node", visual.nodes[0]?.id ?? "")
        : point(kind, key ?? ""),
    ),
    markersInClientSpace: true,
    getImpact: (item, keepContents) =>
      sequenceSelectionImpact(model, item, keepContents),
    getDeleteImpact: (keys) =>
      engine.deleteSequenceSelection(model, keys).impact ?? { records: [] },
    onCommand: createSequenceCommandConsumer(port),
    onPreview: createSequenceCommandConsumer(port, true),
    onCancelPreview: cancelPreview,
    resolveTimelineAnchor: (anchor) =>
      sequenceTimelineAnchor(model, anchor, nativeBounds),
    subscribeEditIntent: (handler) => {
      const listener = (event: Event) => {
        const intent = (event as CustomEvent<MermaidGfxObjectEditIntent>)
          .detail;
        if (intent) handler(intent);
      };
      context.host.addEventListener("mermaid-gfx-object-edit", listener);
      return () =>
        context.host.removeEventListener("mermaid-gfx-object-edit", listener);
    },
    onParentIntent: () => {},
    onEditIntent: () => {},
    onCloseSelection: cancelPreview,
    onWorkareaResize: () => {},
    onEmbeddedActionsInsetChange: () => {},
    resolveReturnFocusTarget: () => context.host,
  };
}
export const sequenceEdgelessToolbar = {
  readonlySelection: true,
  invalidSourceSelection: true,
  actions: [
    {
      id: "mermaid-sequence.controls",
      label: m.controlsLabel(),
      control(context) {
        const owner = resolveMermaidEdgelessOwnerSelection(context)?.model;
        if (!owner) return null;
        const props = nativeSequenceProps(context);
        return props
          ? (context.std
              .getOptional(MermaidFamilyReactHostIdentifier)
              ?.toolbarControl(mermaidSequenceRendererToken, props) ?? null)
          : {
              type: "notice" as const,
              title: m.sourceFirstTitle(),
              message: engine
                .resolveMermaidSequenceSource(
                  getMermaidBlockSource(owner.props),
                )
                .diagnostics.map(engine.sequenceSourceDiagnostic)
                .join(" "),
              tone: "warning" as const,
            };
      },
    },
  ],
  suppressBaseActionIds: MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  when: (context) => {
    const owner = resolveMermaidEdgelessOwnerSelection(context)?.model;
    return Boolean(
      owner &&
      detectMermaidDiagramType(getMermaidBlockSource(owner.props)) ===
        "sequenceDiagram",
    );
  },
} as const satisfies MermaidFamilyEdgelessToolbarContribution;
