// SPDX-License-Identifier: AGPL-3.0-or-later
import { FileSizeLimitProvider } from "@virgultum/shared/services";
import { insertMermaidEdgelessDiagramCommand } from "../../commands.js";
import { writeMindmapPatches } from "../../engine/mindmap/index.js";
import type { PreparedMindmapImport } from "./import/foreign.js";
import { changeMindmapProjection } from "./projection/options.js";
import { createMermaidClipboardPort } from "../../clipboard.js";
import { duplicateMermaidBlockCommand } from "../../commands.js";
import { copiedMindmapProjection } from "./interaction/clipboard.js";
import { recordMermaidSelectionHistory } from "../../mermaid-selection-history.js";
import { SurfaceBlockComponent } from "@virgultum/block-surface";
import { MermaidEdgelessOwnerGfxSync } from "../../presentation/edgeless-owner-gfx-sync.js";
import {
  mindmapPopoverAnchorSide,
  mindmapCommentMarkers,
} from "./interaction/anchors.js";
import { createMindmapPreviewConsumer } from "./interaction/preview.js";
import {
  mindmapNodeHandlePlans,
  mindmapChildSideOptions,
} from "./interaction/handles.js";
import { mindmapMoveProjectionOptions } from "./interaction/move.js";
import { mindmapIntentFromObjectEdit } from "./interaction/keyboard.js";
import { Bound } from "@virgultum/global/gfx";
import { mountShapeTextEditor } from "@virgultum/gfx-shape";
import { previewMermaidGfxModel } from "../runtime/gfx-preview.js";
import { revealNativeMermaidNode } from "../runtime/gfx-edgeless-toolbar.js";
import { getMermaidGfxTitleBandHeight } from "../runtime/gfx-element-projection.js";
import {
  getMermaidVisualElementOriginBound,
  getMermaidVisualElementOriginFromAnchor,
} from "../../commands.js";
import {
  beginMindmapLabelDraft,
  type MindmapLabelDraft,
} from "./interaction/label-draft.js";
import type { ToolbarContext } from "@virgultum/shared/services";
import type {
  MermaidFamilyHostAdapter,
  MermaidFamilyEdgelessToolbarContribution,
} from "../runtime/contracts.js";
import { MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS } from "../runtime/contracts.js";
import type {
  MermaidGfxActionContext,
  MermaidHostProjectionContext,
  MermaidGfxObjectEditIntent,
} from "../runtime/editor-capabilities.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { MermaidFamilyReactHostIdentifier } from "../runtime/react-host.js";
import {
  applyMermaidVisualModelCommand,
  getMermaidVisualModelForEditing,
  getMermaidGfxNode,
} from "../../commands.js";
import {
  resolveMermaidEdgelessSelection,
  runMermaidEdgelessMutation,
} from "../../edgeless-toolbar/selection-context.js";
import { readMermaidGfxNodeId } from "../../mermaid-gfx-metadata.js";
import { getMermaidBlockSource } from "../../utils.js";
import { mermaidMessages as m } from "../../i18n.js";
import { projectMindmapTree } from "./projection/tree.js";
import { readMindmapProjectionOptions } from "./gfx-data.js";
import { readMindmapProjectionModel } from "./source-application.js";
import {
  mindmapPageSelectionTools,
  mindmapControlActions,
  runMindmapAction,
} from "./actions.js";
import { formatMindmapDiagnostic } from "./readback.js";
import {
  mermaidMindmapRendererToken,
  type MindmapReactHostProps,
  type MindmapEditIntent,
} from "./react-host-contract.js";

type MindmapCommandPort = {
  getSource: () => string;
  getReadonly: () => boolean;
  getVisualModel: () => MermaidVisualModel;
  applyVisualModel: MermaidGfxActionContext["applyVisualModel"];
  selectAfterProjection: MermaidGfxActionContext["selectAfterProjection"];
  selectEmpty: () => void;
};
/** Page, local 3E and native toolbar commit the same checked Source exactly once. */
export function createMindmapCommandConsumer(
  port: MindmapCommandPort,
): MindmapReactHostProps["onCommand"] {
  return (action, basis) => {
    if (port.getReadonly())
      return { changed: false, diagnostic: m.ganttReadOnly() };
    const current = port.getSource();
    if (current !== basis)
      return { changed: false, diagnostic: m.chartSourceChanged() };
    const stored = port.getVisualModel();
    const model = readMindmapProjectionModel(current, stored);
    if (!model)
      return {
        changed: false,
        diagnostic: m.visualMutationSourceRejected("mindmap"),
      };
    const projection =
      action.type === "settings"
        ? changeMindmapProjection(stored, model, action)
        : null;
    if (action.type === "settings" && !projection)
      return {
        changed: false,
        diagnostic: m.visualMutationSourceRejected("mindmap"),
      };
    const result = runMindmapAction(model, action);
    const moveProjection =
      action.type === "move" && result.status !== "rejected"
        ? mindmapMoveProjectionOptions(stored, model, action, result.changed)
        : null;
    if (
      result.status === "rejected" ||
      (!result.changed && !moveProjection?.changed && !projection?.changed)
    )
      return {
        changed: false,
        diagnostic:
          result.status === "rejected"
            ? result.diagnostics[0]
              ? formatMindmapDiagnostic(result.diagnostics[0])
              : m.visualMutationSourceRejected("mindmap")
            : undefined,
      };
    let copyProjection = result.keyMap
      ? copiedMindmapProjection(
          readMindmapProjectionOptions(stored),
          action.type === "paste"
            ? action.projection
            : readMindmapProjectionOptions(stored),
          result.keyMap,
          action.type === "paste"
            ? Boolean(
                model.nodes.find((node) => node.sourceKey === action.parentKey)
                  ?.root,
              )
            : true,
        )
      : null;
    if (copyProjection && action.type === "paste") {
      const collapsed = new Set(copyProjection.collapsed);
      let parent = model.nodes.find(
        (node) => node.sourceKey === action.parentKey,
      );
      while (parent) {
        collapsed.delete(parent.sourceKey);
        parent = model.nodes.find((node) => node.id === parent!.parentId);
      }
      copyProjection = { ...copyProjection, collapsed };
    }
    const visual = projectMindmapTree(
      result.model,
      projection?.options ??
        copyProjection ??
        moveProjection?.options ??
        (action.type === "add-child" && result.selection
          ? mindmapChildSideOptions(
              stored,
              model,
              result.selection,
              action.key,
              action.side,
            )
          : readMindmapProjectionOptions(stored)),
    );
    const committed = port.applyVisualModel(visual, {
      preserveSourceBytes: true,
      sourceWrite: { baseSource: current, source: result.source },
      // Creation returns to its parent on Undo and to the new node on Redo.
      selectionHistory:
        action.type === "delete" ||
        action.type === "duplicate" ||
        action.type === "paste" ||
        action.type === "add-root" ||
        action.type === "add-child" ||
        action.type === "add-sibling"
          ? {
              before: ("keys" in action
                ? action.keys
                : "key" in action
                  ? [action.key]
                  : action.type === "paste"
                    ? [action.parentKey]
                    : []
              ).map((editKey) => ({ kind: "node", editKey })),
              after: result.selection
                ? [{ kind: "node", editKey: result.selection }]
                : [],
            }
          : undefined,
    });
    if (!committed.applied)
      return {
        changed: false,
        diagnostic:
          committed.diagnostic ?? m.visualMutationSourceRejected("mindmap"),
      };
    const selection =
      result.selection ?? (action.type === "move" ? action.key : undefined);
    if (selection)
      port.selectAfterProjection(
        { kind: "node", editKey: selection },
        { focus: true },
      );
    if (action.type === "delete" && !result.model.nodes.length)
      port.selectEmpty();
    return {
      changed: true,
      sourceBasis: result.source,
      selection,
    };
  };
}

/** Projection-only operation: no semantic writer or Source text mutation. */
function createMindmapCollapseConsumer(port: MindmapCommandPort) {
  return (key: string, basis: string) => {
    if (port.getReadonly() || port.getSource() !== basis) return;
    const stored = port.getVisualModel();
    const model = readMindmapProjectionModel(basis, stored);
    const node = model?.nodes.find((n) => n.sourceKey === key);
    if (!model || !node || !model.nodes.some((n) => n.parentId === node.id))
      return;
    const options = readMindmapProjectionOptions(stored);
    const collapsed = new Set(options.collapsed);
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    const visual = projectMindmapTree(model, {
      ...options,
      collapsed,
    });
    const result = port.applyVisualModel(visual, {
      preserveSourceBytes: true,
      sourceWrite: { baseSource: basis, source: basis },
    });
    if (result.applied)
      port.selectAfterProjection(
        { kind: "node", editKey: key },
        { focus: true },
      );
  };
}

function fillEmptyMindmap(
  port: MindmapCommandPort,
  candidate: PreparedMindmapImport,
  basis: string,
) {
  if (port.getReadonly() || port.getSource() !== basis)
    return { changed: false, diagnostic: m.chartSourceChanged() };
  const model = readMindmapProjectionModel(basis, port.getVisualModel());
  if (!model || model.nodes.length)
    return {
      changed: false,
      diagnostic: m.visualMutationSourceRejected("mindmap"),
    };
  const first = candidate.model.sourceDocument.records.find(
    (record) => record.kind === "node",
  );
  if (!first) return { changed: false };
  const body = candidate.source.slice(first.range.start),
    prefix = /[\r\n]$/.test(basis) ? "" : model.sourceDocument.newline;
  const result = writeMindmapPatches(model, [
    {
      start: basis.length,
      end: basis.length,
      text: prefix + body,
      identities: candidate.model.sourceDocument.records
        .filter((record) => record.range.start >= first.range.start)
        .map(
          (record) =>
            [
              prefix.length + record.range.start - first.range.start,
              record.sourceKey,
            ] as const,
        ),
    },
  ]);
  if (
    result.status === "rejected" ||
    result.source.length > candidate.maxTextSize
  )
    return {
      changed: false,
      diagnostic: m.visualMutationSourceRejected("mindmap"),
    };
  const visual = projectMindmapTree(
    result.model,
    readMindmapProjectionOptions(candidate.visualModel),
  );
  const commit = port.applyVisualModel(visual, {
    preserveSourceBytes: true,
    sourceWrite: { baseSource: basis, source: result.source },
  });
  return { changed: commit.applied, diagnostic: commit.diagnostic };
}

function editorProps(
  context: MermaidGfxActionContext,
  host: MermaidHostProjectionContext,
): MindmapReactHostProps | null {
  const model = readMindmapProjectionModel(
    host.getSource(),
    context.visualModel,
  );
  if (!model) return null;
  const selected =
    context.selectedItems.length === 1 &&
    context.selectedItems[0].kind === "node"
      ? context.selectedItems[0].editKey
      : null;
  const selectedKey = model.nodes.some((node) => node.sourceKey === selected)
    ? selected
    : null;
  let intent = host.getTransientState(
    "mindmap.intent",
  ) as MindmapEditIntent | null;
  if (
    intent &&
    (context.readonly ||
      context.displayOnly ||
      ("key" in intent && intent.key !== selectedKey))
  ) {
    host.setTransientState("mindmap.intent", null);
    intent = null;
  }
  const commandPort: MindmapCommandPort = {
    getSource: host.getSource,
    getReadonly: host.getReadonly,
    getVisualModel: () => context.getVisualModel?.() ?? context.visualModel,
    applyVisualModel: context.applyVisualModel,
    selectAfterProjection: context.selectAfterProjection,
    selectEmpty: context.closeInspector,
  };
  const command = createMindmapCommandConsumer(commandPort);
  const collapse = createMindmapCollapseConsumer(commandPort);
  const activeDraft = host.getTransientState(
    "mindmap.createDraft",
  ) as MindmapLabelDraft | null;
  if (
    activeDraft &&
    (context.readonly || context.displayOnly || !activeDraft.valid())
  )
    activeDraft.cancel();
  const onIntent = (value: MindmapEditIntent | null) => {
    if (value?.type === "duplicate") {
      if (host.getReadonly() || context.displayOnly) return;
      if (
        model.nodes.some(
          (node) => node.root && value.keys.includes(node.sourceKey),
        )
      )
        context.duplicateOwner?.();
      else command(value, host.getSource());
      return;
    }
    if (value?.type === "toggle-collapse") {
      (
        host.getTransientState(
          "mindmap.createDraft",
        ) as MindmapLabelDraft | null
      )?.cancel();
      host.setTransientState("mindmap.intent", null);
      collapse(value.key, host.getSource());
      return;
    }
    if (
      value &&
      value.type !== "properties" &&
      value.type !== "move" &&
      value.type !== "layout" &&
      value.type !== "import" &&
      value.type !== "delete"
    ) {
      host.setTransientState("mindmap.intent", null);
      (
        host.getTransientState(
          "mindmap.createDraft",
        ) as MindmapLabelDraft | null
      )?.cancel();
      let draft: MindmapLabelDraft | null = null;
      draft = beginMindmapLabelDraft(
        {
          getSource: host.getSource,
          getReadonly: host.getReadonly,
          getVisualModel: () =>
            context.getVisualModel?.() ?? context.visualModel,
          previewVisualModel: context.previewVisualModel,
          mountShapeDraft: context.mountShapeDraft,
          renderActions: (actions) =>
            context.reactHost?.renderFamilyEditor(mermaidMindmapRendererToken, {
              surface: "label-actions",
              ...actions,
            }),
          command,
          subscribeInvalidation: context.subscribeDraftInvalidation,
          clearSelection: context.closeInspector,
          selectAfterPreview: context.selectNode,
          restoreSelection: () =>
            "key" in value
              ? context.selectNode(value.key)
              : context.closeInspector(),
          finish: () => {
            if (host.getTransientState("mindmap.createDraft") === draft)
              host.setTransientState("mindmap.createDraft", null);
            context.refreshWorkarea();
            requestAnimationFrame(() => {
              if (
                !host.getTransientState("mindmap.createDraft") &&
                !host.getTransientState("mindmap.intent") &&
                (!document.activeElement ||
                  document.activeElement === document.body)
              )
                context
                  .resolveReturnFocusTarget()
                  ?.focus({ preventScroll: true });
            });
          },
        },
        value,
      );
      host.setTransientState("mindmap.createDraft", draft);
      return;
    }
    host.setTransientState("mindmap.intent", value);
    context.refreshWorkarea();
    if (!value)
      requestAnimationFrame(() => {
        if (
          !host.getTransientState("mindmap.intent") &&
          !host.getTransientState("mindmap.createDraft")
        )
          context.resolveReturnFocusTarget()?.focus({ preventScroll: true });
      });
  };
  return {
    surface: "editor",
    history: context.history,
    onExportMmd: context.exportMmd,
    importFileSizeLimit: context.importFileSizeLimit ?? 0,
    onImport: (candidate, basis, position) => {
      if (
        host.getReadonly() ||
        context.displayOnly ||
        host.getSource() !== basis
      )
        return { changed: false, diagnostic: m.chartSourceChanged() };
      return model.nodes.length
        ? {
            changed: Boolean(
              context.insertDiagram?.(
                candidate.source,
                candidate.visualModel,
                position,
              ),
            ),
          }
        : fillEmptyMindmap(commandPort, candidate, basis);
    },
    clipboard: context.clipboard,
    model,
    projection: readMindmapProjectionOptions(context.visualModel),
    sourceBasis: host.getSource(),
    commentMarkers: mindmapCommentMarkers(model, context.resolveVisualAnchor),
    selectedKey,
    selectedKeys: context.selectedItems
      .filter(
        (item) =>
          item.kind === "node" &&
          model.nodes.some((node) => node.sourceKey === item.editKey),
      )
      .map((item) => item.editKey),
    nodeHandles: context.resolveVisualBounds
      ? mindmapNodeHandlePlans(
          model,
          context.visualModel,
          context.resolveVisualBounds,
        )
      : [],
    draftActive: Boolean(host.getTransientState("mindmap.createDraft")),
    drag:
      context.viewportIdentity &&
      context.resolveViewportPoint &&
      context.resolveVisualBounds &&
      context.previewVisualModel
        ? {
            viewportIdentity: context.viewportIdentity,
            registerPointerDown: (handler) => {
              host.setTransientState("mindmap.dragStart", handler);
              return () => {
                if (host.getTransientState("mindmap.dragStart") === handler)
                  host.setTransientState("mindmap.dragStart", null);
              };
            },
            visual: context.visualModel,
            containsEvent: (event) => {
              const viewport = context
                .resolveReturnFocusTarget()
                ?.closest(".myoxus-mermaid-gfx-viewport");
              return Boolean(
                viewport &&
                event.composedPath().includes(viewport) &&
                (!context.embedded || context.embeddedEditing),
              );
            },
            resolvePoint: context.resolveViewportPoint,
            resolveNodeBounds: (key) =>
              context.resolveVisualBounds!("node", key, true),
            preview: (candidate) =>
              context.previewVisualModel!(candidate, { scopeToViewport: true }),
            select: context.selectNode,
          }
        : undefined,
    selectedAnchorSide:
      selectedKey &&
      mindmapPopoverAnchorSide(context.visualModel, selectedKey) === "end"
        ? "right"
        : "left",
    selectedAnchor: selectedKey
      ? context.resolveVisualAnchor("node", selectedKey)
      : null,
    intent:
      context.readonly ||
      (intent && "key" in intent && intent.key !== selectedKey)
        ? null
        : intent,
    onIntent,
    readonly: context.readonly,
    displayOnly: context.displayOnly,
    embedded: context.embedded,
    embeddedEditing: context.embeddedEditing,
    actionTarget: context.actionTarget,
    workarea: context.workarea,
    workareaFooter: context.workareaFooter,
    pageViewport: context.pageViewport,
    onWorkareaResize: context.refreshWorkarea,
    onFitViewport: context.fitViewport,
    onEmbeddedActionsInsetChange: context.onEmbeddedActionsInsetChange,
    resolveReturnFocusTarget: context.resolveReturnFocusTarget,
    onPreviewCollapsed: (collapsed) =>
      context.previewVisualModel?.(
        projectMindmapTree(model, {
          ...readMindmapProjectionOptions(context.visualModel),
          collapsed,
        }),
        { scopeToViewport: true, includeInNavigation: true },
      ) ?? null,
    onCommand: command,
    onPreview: createMindmapPreviewConsumer({
      getSource: host.getSource,
      getReadonly: host.getReadonly,
      getVisualModel: () => context.getVisualModel?.() ?? context.visualModel,
      previewVisualModel: context.previewVisualModel,
    }),
  };
}

export const mermaidMindmapHostAdapter: MermaidFamilyHostAdapter = {
  projectGfx: (projection) => ({
    kind: "gfx",
    readonlyExploration: true,
    renderSurface: projection.renderSurface,
    pageSelectionTools: mindmapPageSelectionTools,
    project: (host, displayOnly) =>
      host.renderGfx(projection.visualModel, {
        displayOnly,
        embeddedFacadeSurface: true,
        renderSurface: projection.renderSurface,
        pageSelectionTools: mindmapPageSelectionTools,
        onNodePointerDown: (event) => {
          const start = host.getTransientState("mindmap.dragStart") as
            ((event: PointerEvent) => boolean) | null;
          return Boolean(start?.(event));
        },
        onObjectEditIntent: (intent) => {
          if (host.getReadonly() || intent.kind !== "node") return false;
          host.setTransientState("mindmap.pendingIntent", intent);
          return true;
        },
        projectActions: (context) => {
          const pending = host.getTransientState(
            "mindmap.pendingIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (pending) {
            if (
              pending.action !== "delete" &&
              pending.action !== "duplicate" &&
              (context.selectedItems.length !== 1 ||
                context.selectedItems[0].editKey !== pending.id)
            )
              context.selectNode(pending.id);
            host.setTransientState("mindmap.intent", null);
            host.setTransientState("mindmap.pendingIntent", null);
          }
          const props = editorProps(context, host);
          if (!props) return null;
          const edit = pending && mindmapIntentFromObjectEdit(pending);
          if (edit)
            props.onIntent(
              edit.type === "delete" || edit.type === "duplicate"
                ? {
                    type: edit.type,
                    keys: props.selectedKeys.includes(pending!.id)
                      ? props.selectedKeys
                      : [pending!.id],
                  }
                : edit,
            );
          const body = context.reactHost?.renderFamilyEditor(
            mermaidMindmapRendererToken,
            props,
          );
          return body
            ? {
                body,
                actions: {
                  actions: mindmapControlActions(
                    props.model,
                    props.selectedKey,
                    props.readonly || props.displayOnly,
                    props.onIntent,
                    props.projection.collapsed,
                  ),
                  portal: !context.embedded,
                  selectionAction: {
                    disabled:
                      props.readonly ||
                      props.displayOnly ||
                      !props.selectedKeys.length,
                    label: m.visualDelete(),
                    onSelect: () => {
                      if (props.selectedKeys.length)
                        props.onIntent({
                          type: "delete",
                          keys: props.selectedKeys,
                        });
                    },
                  },
                },
              }
            : null;
        },
      }),
  }),
};

const nativeDrafts = new WeakMap<object, MindmapLabelDraft>();

function nativeProps(context: ToolbarContext): MindmapReactHostProps | null {
  const state = resolveMermaidEdgelessSelection(context);
  if (!state?.visualModel || state.diagramType !== "mindmap") return null;
  const source = getMermaidBlockSource(state.owner.props),
    visual = state.visualModel;
  const model = readMindmapProjectionModel(source, visual);
  if (!model) return null;
  const selectedKey =
    state.selectedModels.length === 1
      ? readMermaidGfxNodeId(state.selectedModels[0]) ||
        (state.selectedModels[0].id === state.owner.id
          ? (model.nodes[0]?.sourceKey ?? null)
          : null)
      : null;
  const commandPort: MindmapCommandPort = {
    getSource: () => getMermaidBlockSource(state.owner.props),
    getReadonly: () => context.store.readonly || state.owner.isLocked(),
    getVisualModel: () =>
      getMermaidVisualModelForEditing(context.std, state.owner) ?? visual,
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
      if (applied)
        recordMermaidSelectionHistory(
          context.store,
          state.owner.id,
          options?.selectionHistory,
        );
      return { ...feedback, applied };
    },
    selectEmpty: () =>
      context.gfx.selection.set({ editing: false, elements: [state.owner.id] }),
    selectAfterProjection: (item) => {
      const element = getMermaidGfxNode(
        context.store,
        state.owner,
        item.editKey,
      );
      if (element) {
        context.gfx.selection.set({ editing: false, elements: [element.id] });
        revealNativeMermaidNode(context, element.xywh);
      }
    },
  };
  const command = createMindmapCommandConsumer(commandPort);
  const collapse = createMindmapCollapseConsumer(commandPort);
  const previewVisualModel: NonNullable<
    MermaidGfxActionContext["previewVisualModel"]
  > = (candidate, options) => {
    const surface = state.owner.surface;
    if (!surface) throw new Error("Missing native Mermaid Surface");
    const current =
      getMermaidVisualModelForEditing(context.std, state.owner) ?? visual;
    const first = current.nodes.find((node) =>
      getMermaidGfxNode(context.store, state.owner, node.id),
    );
    const anchor =
      first && getMermaidGfxNode(context.store, state.owner, first.id);
    const fallback = Bound.deserialize(state.owner.xywh);
    const origin =
      first && anchor
        ? getMermaidVisualElementOriginFromAnchor(
            first,
            Bound.deserialize(anchor.xywh),
            fallback,
          )
        : getMermaidVisualElementOriginBound(
            current,
            fallback,
            current.diagramTitle?.trim()
              ? getMermaidGfxTitleBandHeight(current)
              : 0,
          );
    const component = context.gfx.surfaceComponent;
    const renderer =
      component instanceof SurfaceBlockComponent ? component.renderer : null;
    if (options?.scopeToViewport && !renderer)
      throw new Error("Missing native GFX renderer for local preview");
    return previewMermaidGfxModel(candidate, {
      hideOriginals:
        options?.scopeToViewport && renderer
          ? () =>
              renderer.excludeElementsTemporarily(
                new Set(
                  state.owner.childIds.filter(
                    (id) =>
                      surface.getElementById(id)?.yMap.get("mermaidRole") !==
                      "mermaid-diagram-title",
                  ),
                ),
              )
          : undefined,
      surface,
      creator: state.owner,
      viewport: context.gfx.viewport,
      origin,
      elements: state.owner.childIds.flatMap((id) => {
        const element = surface.getElementById(id);
        return element &&
          "stash" in element &&
          element.yMap.get("mermaidRole") !== "mermaid-diagram-title"
          ? [element]
          : [];
      }),
      refresh: () => context.gfx.surfaceComponent?.requestUpdate(),
    });
  };
  const active = nativeDrafts.get(state.owner);
  if (active && (context.readonly || !active.valid())) active.cancel();
  const onIntent = (intent: MindmapEditIntent | null) => {
    if (intent && (context.readonly || state.owner.isLocked())) return;
    if (intent?.type === "duplicate") {
      if (context.store.readonly) return;
      if (
        model.nodes.some(
          (node) => node.root && intent.keys.includes(node.sourceKey),
        )
      )
        context.command.exec(duplicateMermaidBlockCommand, {
          model: state.owner,
        });
      else command(intent, getMermaidBlockSource(state.owner.props));
      return;
    }
    if (intent?.type === "toggle-collapse") {
      nativeDrafts.get(state.owner)?.cancel();
      collapse(intent.key, getMermaidBlockSource(state.owner.props));
      return;
    }
    if (
      !intent ||
      intent.type === "properties" ||
      intent.type === "move" ||
      intent.type === "layout" ||
      intent.type === "import" ||
      intent.type === "delete"
    )
      return;
    nativeDrafts.get(state.owner)?.cancel();
    const selectedIds = context.gfx.selection.selectedElements.map(
      (element) => element.id,
    );
    let draft: MindmapLabelDraft | null = null;
    draft = beginMindmapLabelDraft(
      {
        getSource: () => getMermaidBlockSource(state.owner.props),
        getReadonly: () => context.store.readonly || state.owner.isLocked(),
        getVisualModel: () =>
          getMermaidVisualModelForEditing(context.std, state.owner) ?? visual,
        command,
        subscribeInvalidation: (invalidate) => {
          const stopSource = state.owner.props.source$.subscribe(invalidate);
          const stopReadonly = context.store.readonly$.subscribe(invalidate);
          const stopLock = state.owner.lockedBySelf$.subscribe(invalidate);
          return () => {
            stopSource();
            stopReadonly();
            stopLock();
          };
        },
        clearSelection: () =>
          context.gfx.selection.set({ editing: false, elements: [] }),
        selectAfterPreview: (key) => {
          const element = getMermaidGfxNode(context.store, state.owner, key);
          if (element) {
            context.gfx.selection.set({
              editing: false,
              elements: [element.id],
            });
            revealNativeMermaidNode(context, element.xywh);
          }
        },
        mountShapeDraft: (shape, edit) => {
          const root =
            context.store.root &&
            context.std.view.getBlock(context.store.root.id);
          if (!root) return null;
          revealNativeMermaidNode(context, shape.xywh);
          const editor = mountShapeTextEditor(shape, root, { draft: edit });
          return editor ? () => editor.cancelDraft() : null;
        },
        renderActions: (actions) =>
          context.std
            .getOptional(MermaidFamilyReactHostIdentifier)
            ?.renderFamilyEditor(mermaidMindmapRendererToken, {
              surface: "label-actions",
              ...actions,
            }),
        previewVisualModel,
        restoreSelection: () => {
          const element =
            "key" in intent
              ? getMermaidGfxNode(context.store, state.owner, intent.key)
              : null;
          context.gfx.selection.set({
            editing: false,
            elements: element ? [element.id] : selectedIds,
          });
        },
        finish: () => {
          if (nativeDrafts.get(state.owner) === draft)
            nativeDrafts.delete(state.owner);
          requestAnimationFrame(() => {
            if (
              !nativeDrafts.has(state.owner) &&
              (!document.activeElement ||
                document.activeElement === document.body)
            )
              context.host.focus({ preventScroll: true });
          });
        },
      },
      intent,
    );
    if (draft) nativeDrafts.set(state.owner, draft);
  };
  return {
    surface: "controls",
    importFileSizeLimit: context.std.get(FileSizeLimitProvider).maxFileSize,
    onImport: (candidate, basis, position) => {
      if (
        context.store.readonly ||
        state.owner.isLocked() ||
        getMermaidBlockSource(state.owner.props) !== basis
      )
        return { changed: false, diagnostic: m.chartSourceChanged() };
      if (!model.nodes.length)
        return fillEmptyMindmap(commandPort, candidate, basis);
      const [, result] = context.command.exec(
        insertMermaidEdgelessDiagramCommand,
        {
          source: candidate.source,
          visualModel: candidate.visualModel,
          position,
        },
      );
      return { changed: Boolean(result?.insertedMermaidBlockId) };
    },
    clipboard: createMermaidClipboardPort(context.std, () => {
      const selected = context.gfx.selection.selectedElements;
      return (
        selected.length > 0 &&
        selected.every(
          (node) =>
            state.owner.childIds.includes(node.id) &&
            Boolean(readMermaidGfxNodeId(node)),
        )
      );
    }),
    model,
    projection: readMindmapProjectionOptions(visual),
    sourceBasis: source,
    history: {
      get canUndo() {
        return context.store.canUndo;
      },
      get canRedo() {
        return context.store.canRedo;
      },
      subscribe: (refresh) => {
        const subscription = context.store.history.onUpdated.subscribe(refresh);
        return () => subscription.unsubscribe();
      },
      onUndo: () => {
        nativeDrafts.get(state.owner)?.cancel();
        context.std
          .get(MermaidEdgelessOwnerGfxSync)
          .replayHistory(state.owner, "undo");
        context.host.focus({ preventScroll: true });
      },
      onRedo: () => {
        nativeDrafts.get(state.owner)?.cancel();
        context.std
          .get(MermaidEdgelessOwnerGfxSync)
          .replayHistory(state.owner, "redo");
        context.host.focus({ preventScroll: true });
      },
    },
    markersInClientSpace: true,
    commentMarkers: mindmapCommentMarkers(model, (kind, key) => {
      const element =
        kind === "node"
          ? getMermaidGfxNode(context.store, state.owner, key ?? "")
          : state.owner;
      if (!element?.xywh) return null;
      const bounds = Bound.deserialize(element.xywh),
        viewport = context.gfx.viewport;
      const [left, top] = viewport.toViewCoord(bounds.maxX, bounds.y);
      return { left: viewport.left + left, top: viewport.top + top };
    }),
    selectedKey: model.nodes.some((node) => node.sourceKey === selectedKey)
      ? selectedKey
      : null,
    selectedKeys:
      state.selectedModels.length === 1 &&
      state.selectedModels[0].id === state.owner.id
        ? model.nodes.filter((node) => node.root).map((node) => node.sourceKey)
        : state.selectedModels
            .map((node) => readMermaidGfxNodeId(node))
            .filter((key): key is string =>
              Boolean(
                key && model.nodes.some((node) => node.sourceKey === key),
              ),
            ),
    selectedAnchor: null,
    nodeHandles: mindmapNodeHandlePlans(model, visual, (_kind, key) => {
      const element = getMermaidGfxNode(context.store, state.owner, key);
      if (!element || ("hidden" in element && element.hidden)) return null;
      const bound = Bound.deserialize(element.xywh),
        viewport = context.gfx.viewport;
      const [left, top] = viewport.toViewCoord(bound.x, bound.y);
      return {
        left: viewport.left + left,
        top: viewport.top + top,
        width: bound.w * viewport.zoom,
        height: bound.h * viewport.zoom,
      };
    }),
    drag: {
      viewportIdentity: context.gfx.viewport,
      registerPointerDown: (handler) => {
        const listener = (request: Event) => {
          if (handler((request as CustomEvent<PointerEvent>).detail))
            request.preventDefault();
        };
        context.host.addEventListener("mermaid-gfx-node-pointerdown", listener);
        return () =>
          context.host.removeEventListener(
            "mermaid-gfx-node-pointerdown",
            listener,
          );
      },
      visual,
      containsEvent: (event) => event.composedPath().includes(context.host),
      resolvePoint: ({ left, top }) => {
        const viewport = context.gfx.viewport;
        const [x, y] = viewport.toModelCoord(
          left - viewport.left,
          top - viewport.top,
        );
        return { x, y };
      },
      resolveNodeBounds: (key) => {
        const element = getMermaidGfxNode(context.store, state.owner, key);
        if (!element) return null;
        const viewport = context.gfx.viewport;
        const [left, top] = viewport.toViewCoord(element.x, element.y);
        return {
          left: viewport.left + left,
          top: viewport.top + top,
          width: element.w * viewport.zoom,
          height: element.h * viewport.zoom,
        };
      },
      preview: (candidate) =>
        previewVisualModel(candidate, { scopeToViewport: true }),
      select: (key) => {
        const element = getMermaidGfxNode(context.store, state.owner, key);
        if (element)
          context.gfx.selection.set({ editing: false, elements: [element.id] });
      },
    },
    intent: null,
    onIntent,
    readonly: context.readonly || state.owner.isLocked(),
    displayOnly: false,
    embedded: false,
    embeddedEditing: false,
    workarea: null,
    workareaFooter: null,
    onWorkareaResize: () => undefined,
    onEmbeddedActionsInsetChange: () => undefined,
    resolveReturnFocusTarget: () => context.host,
    subscribeEditIntent: (handler) => {
      const listener = (event: Event) => {
        const intent = (event as CustomEvent<MermaidGfxObjectEditIntent>)
          .detail;
        if (intent?.kind === "node") handler(intent);
      };
      context.host.addEventListener("mermaid-gfx-object-edit", listener);
      return () =>
        context.host.removeEventListener("mermaid-gfx-object-edit", listener);
    },
    onPreviewCollapsed: (collapsed) =>
      previewVisualModel(
        projectMindmapTree(model, {
          ...readMindmapProjectionOptions(visual),
          collapsed,
        }),
        { scopeToViewport: true },
      ),
    onCommand: command,
    onPreview: createMindmapPreviewConsumer({
      getSource: () => getMermaidBlockSource(state.owner.props),
      getReadonly: () => context.store.readonly || state.owner.isLocked(),
      getVisualModel: () =>
        getMermaidVisualModelForEditing(context.std, state.owner) ?? visual,
      previewVisualModel,
    }),
  };
}
export const mindmapEdgelessToolbar: MermaidFamilyEdgelessToolbarContribution =
  {
    readonlySelection: true,
    actions: [
      {
        id: "mermaid-mindmap.controls",
        label: m.controlsLabel(),
        when: (context) => {
          const state = resolveMermaidEdgelessSelection(context);
          // Whole-owner selection already exposes native owner actions. Mixing
          // both rows crowds the floating toolbar before any node is selected.
          return Boolean(
            state &&
            (!state.visualModel?.nodes.length ||
              state.selectedModels.some(
                (model) => model.id !== state.owner.id,
              )),
          );
        },
        control: (context) => {
          const props = nativeProps(context);
          return props
            ? (context.std
                .getOptional(MermaidFamilyReactHostIdentifier)
                ?.toolbarControl(mermaidMindmapRendererToken, props) ?? null)
            : null;
        },
      },
    ],
    suppressBaseActionIds: MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
    when: (context) => nativeProps(context) !== null,
  };
