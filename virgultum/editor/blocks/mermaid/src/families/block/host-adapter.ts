// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidHostProjectionContext,
  MermaidGfxObjectEditIntent,
  MermaidGfxActionContext,
} from "../runtime/editor-capabilities.js";
import type { MermaidFamilyHostAdapter } from "../runtime/contracts.js";
import type {
  BlockReactHostProps,
  BlockSelection,
} from "./react-host-contract.js";
import { mermaidBlockRendererToken } from "./react-host-contract.js";
import { blockProjectionBinding } from "./gfx-data.js";
import { blockCommentMarkers } from "./annotation-projection.js";
import {
  readBlockProjectionModel,
  reconcileBlockVisual,
} from "./source-application.js";
import { blockModelToVisual } from "./visual-model.js";
import {
  runBlockCommand,
  blockCommandReflowScopes,
  blockPageSelectionTools,
  blockGroupAllowed,
  BLOCK_PARENT_ACTIONS,
  BLOCK_PARENT_ACTION_LABELS,
  type BlockParentAction,
} from "./actions.js";
import {
  blockDeleteImpact,
  deleteBlockComposite,
  blockRecord,
} from "../../engine/block/index.js";
import { mermaidMessages } from "../../i18n.js";
function blockSelection(
  visual: MermaidGfxActionContext["visualModel"],
  kind: string,
  key: string,
  ownerKey?: string,
): BlockSelection | null {
  if (kind === "detail") {
    key = ownerKey ?? key.replace(/:label$/, " ").trim();
    kind = "node";
  }
  if (kind === "edge")
    return visual.edges.some((e) => e.id === key)
      ? { kind: "connection", key }
      : null;
  if (kind === "subgraph")
    return visual.subgraphs?.some((g) => g.id === key)
      ? { kind: "composite", key }
      : null;
  const binding = blockProjectionBinding(
    visual.nodes.find((n) => n.id === key) ?? {},
  );
  return binding
    ? { kind: binding.role === "space" ? "space" : "block", key }
    : null;
}
export function blockSelectionImpact(
  model: BlockReactHostProps["model"],
  item: BlockSelection,
) {
  if (item.kind === "block") return blockDeleteImpact(model, item.key);
  if (item.kind === "composite")
    return deleteBlockComposite(model, item.key, { children: "delete" }).impact;
  const r = blockRecord(model, item.key);
  return {
    records: r ? [{ id: r.sourceKey, kind: r.kind, label: r.raw.trim() }] : [],
    grids: [],
  };
}
export type BlockCommandPort = {
  getSource: () => string;
  getReadonly: () => boolean;
  getVisualModel: () => MermaidGfxActionContext["visualModel"];
  applyVisualModel: MermaidGfxActionContext["applyVisualModel"];
  selectAfterProjection: MermaidGfxActionContext["selectAfterProjection"];
  getPlacement?: () => { centerX: number; centerY: number } | null;
  clearPlacement?: () => void;
  clearPreview?: () => void;
};
/** Page, embedded and native commands share the exact Source basis and one
 * document-history commit, including the advanced identity projection. */
export function createBlockCommandConsumer(
  port: BlockCommandPort,
): BlockReactHostProps["onCommand"] {
  return (name, args, basis, requestedPlacement) => {
    if (port.getReadonly())
      return { changed: false, diagnostic: mermaidMessages.ganttReadOnly() };
    const source = port.getSource();
    if (source !== basis)
      return {
        changed: false,
        diagnostic: mermaidMessages.stateSourceConflict(),
      };
    const active = readBlockProjectionModel(source, port.getVisualModel());
    if (!active)
      return {
        changed: false,
        diagnostic: mermaidMessages.blockInvalidRecord(),
      };
    const result = runBlockCommand(active, name, args);
    if (result.status === "rejected" || !result.changed)
      return {
        changed: false,
        diagnostic:
          result.diagnostic ??
          (result.status === "rejected"
            ? mermaidMessages.blockInvalidRecord()
            : undefined),
        impact: result.impact,
      };
    const visual = reconcileBlockVisual(
        blockModelToVisual(result.model),
        port.getVisualModel(),
        true,
        blockCommandReflowScopes(name, args, result),
      ),
      placement = requestedPlacement ?? port.getPlacement?.();
    if (name === "addBlock" && placement) {
      const n = visual.nodes.find((n) => n.id === result.selection);
      if (n) {
        n.x = placement.centerX - n.width / 2;
        n.y = placement.centerY - n.height / 2;
      }
    }
    port.clearPreview?.();
    const committed = port.applyVisualModel(visual, {
      preserveSourceBytes: true,
      sourceWrite: { baseSource: source, source: result.source },
    });
    if (!committed.applied)
      return {
        changed: false,
        diagnostic:
          committed.diagnostic ?? mermaidMessages.blockInvalidRecord(),
      };
    const key = result.selection,
      kind =
        key && visual.nodes.some((n) => n.id === key)
          ? "node"
          : key && visual.edges.some((e) => e.id === key)
            ? "edge"
            : key && visual.subgraphs?.some((g) => g.id === key)
              ? "subgraph"
              : null;
    if (key && kind) port.selectAfterProjection({ editKey: key, kind });
    port.clearPlacement?.();
    return {
      changed: true,
      sourceBasis: result.source,
      selection: key,
      impact: result.impact,
    };
  };
}
export function createBlockEditorProps(
  context: MermaidGfxActionContext,
  host: MermaidHostProjectionContext,
): BlockReactHostProps | null {
  const model = readBlockProjectionModel(host.getSource(), context.visualModel);
  if (!model) return null;
  const intent = host.getTransientState(
      "block.editIntent",
    ) as MermaidGfxObjectEditIntent | null,
    parentIntent = host.getTransientState(
      "block.parentIntent",
    ) as BlockParentAction | null,
    item = intent
      ? { kind: intent.kind, editKey: intent.id }
      : context.selectedItems.length === 1
        ? context.selectedItems[0]
        : null,
    selected = item
      ? blockSelection(
          context.visualModel,
          item.kind,
          item.editKey,
          intent?.ownerId,
        )
      : null;
  const clearPreview = () => {
    const dispose = host.getTransientState("block.preview") as
      (() => void) | null;
    host.setTransientState("block.preview", null);
    dispose?.();
  };
  const onEditIntent = (value: MermaidGfxObjectEditIntent | null) => {
    host.setTransientState("block.editIntent", value);
    context.refreshWorkarea();
    if (!value)
      requestAnimationFrame(() => {
        if (
          !host.getTransientState("block.editIntent") &&
          !host.getTransientState("block.parentIntent")
        )
          context.resolveReturnFocusTarget()?.focus({ preventScroll: true });
      });
  };
  return {
    surface: "editor",
    model,
    config: model.config,
    visualModel: context.visualModel,
    sourceBasis: model.sourceDocument.source,
    selected,
    selectedKeys: context.selectedItems.map((i) => i.editKey),
    selectedAnchor:
      intent?.anchor ??
      (selected
        ? context.resolveVisualAnchor(
            selected.kind === "connection"
              ? "edge"
              : selected.kind === "composite"
                ? "subgraph"
                : "node",
            selected.key,
            true,
          )
        : null),
    intent,
    parentIntent,
    groupAllowed:
      blockGroupAllowed(
        model,
        context.selectedItems.map((i) => i.editKey),
      ) &&
      (blockPageSelectionTools.containerAction?.validate({
        items: context.selectedItems,
        visualModel: context.visualModel,
      }).valid ??
        false),
    readonly: context.readonly || host.getReadonly(),
    displayOnly: context.displayOnly,
    embedded: context.embedded,
    embeddedEditing: context.embeddedEditing,
    actionTarget: context.actionTarget,
    workarea: context.workarea,
    workareaFooter: context.workareaFooter,
    pageViewport: context.pageViewport,
    commentMarkers: blockCommentMarkers(model, context.resolveVisualAnchor),
    resolveVisualBounds: context.resolveVisualBounds,
    selectObject: (kind, key) => {
      if (kind === "node") context.selectNode(key);
      else if (kind === "edge") context.selectEdge(key);
      else context.selectContainer(key);
    },
    getImpact: (item) => blockSelectionImpact(model, item),
    onCommand: createBlockCommandConsumer({
      getSource: host.getSource,
      getReadonly: () =>
        host.getReadonly() || context.readonly || context.displayOnly,
      getVisualModel: () => context.visualModel,
      applyVisualModel: context.applyVisualModel,
      selectAfterProjection: context.selectAfterProjection,
      clearPreview,
      getPlacement: () =>
        host.getTransientState("block.placement") as {
          centerX: number;
          centerY: number;
        } | null,
      clearPlacement: () => host.setTransientState("block.placement", null),
    }),
    previewCommand: (name, args, basis) => {
      clearPreview();
      if (basis !== host.getSource() || host.getReadonly() || context.readonly)
        return {
          feedback: {
            changed: false,
            diagnostic: mermaidMessages.stateSourceConflict(),
          },
          dispose: () => {},
        };
      const result = runBlockCommand(model, name, args),
        dispose = result.changed
          ? (context.previewVisualModel?.(
              reconcileBlockVisual(
                blockModelToVisual(result.model),
                context.visualModel,
                true,
                blockCommandReflowScopes(name, args, result),
              ),
            ) ?? (() => {}))
          : () => {};
      const ownedDispose = () => {
        if (host.getTransientState("block.preview") === ownedDispose)
          host.setTransientState("block.preview", null);
        dispose();
      };
      host.setTransientState("block.preview", ownedDispose);
      return {
        feedback: {
          changed: result.changed,
          impact: result.impact,
          diagnostic:
            result.diagnostic ??
            (result.status === "rejected"
              ? mermaidMessages.blockInvalidRecord()
              : undefined),
        },
        dispose: ownedDispose,
      };
    },
    placement: host.getTransientState("block.placement") as {
      centerX: number;
      centerY: number;
    } | null,
    onParentIntent: (value) => {
      host.setTransientState("block.editIntent", null);
      host.setTransientState("block.parentIntent", value);
      if (value === "addBlock") {
        host.setTransientState("block.parentIntent", null);
        context.beginNodePlacement((point) => {
          host.setTransientState("block.placement", point);
          host.setTransientState("block.parentIntent", value);
          context.refreshWorkarea();
        });
      } else context.refreshWorkarea();
    },
    onEditIntent,
    onCloseSelection: () => {
      onEditIntent(null);
      context.closeInspector();
    },
    onWorkareaResize: context.refreshWorkarea,
    onEmbeddedActionsInsetChange: context.onEmbeddedActionsInsetChange,
    resolveReturnFocusTarget: context.resolveReturnFocusTarget,
  };
}
export const mermaidBlockHostAdapter: MermaidFamilyHostAdapter = {
  projectGfx: (resolution) => ({
    kind: "gfx",
    readonlyExploration: true,
    renderSurface: resolution.renderSurface,
    pageSelectionTools: blockPageSelectionTools,
    project: (host, displayOnly) =>
      host.renderGfx(resolution.visualModel, {
        displayOnly,
        embeddedFacadeSurface: true,
        renderSurface: resolution.renderSurface,
        pageSelectionTools: blockPageSelectionTools,
        onContainerActionIntent: () => {
          if (host.getReadonly()) return false;
          host.setTransientState("block.editIntent", null);
          host.setTransientState("block.parentIntent", "group");
          return true;
        },
        onObjectEditIntent: (intent) => {
          if (host.getReadonly()) return false;
          if (intent.action === "delete") {
            host.setTransientState("block.editIntent", null);
            host.setTransientState("block.parentIntent", "deleteSelection");
          } else {
            host.setTransientState("block.pendingEditIntent", intent);
            host.setTransientState("block.parentIntent", null);
          }
          return true;
        },
        projectActions: (context) => {
          const pending = host.getTransientState(
            "block.pendingEditIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (pending) {
            const id = pending.ownerId ?? pending.id;
            if (pending.kind === "edge") context.selectEdge(id);
            else if (pending.kind === "subgraph") context.selectContainer(id);
            else context.selectNode(id);
            host.setTransientState(
              "block.editIntent",
              pending.action === "select" ? null : pending,
            );
            host.setTransientState("block.pendingEditIntent", null);
          }
          const active = host.getTransientState(
            "block.editIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (
            !pending &&
            active &&
            !context.selectedItems.some(
              (i) => i.editKey === (active.ownerId ?? active.id),
            )
          )
            host.setTransientState("block.editIntent", null);
          const props = createBlockEditorProps(context, host);
          host.setSelectionAction(
            context.selectedItems.length
              ? {
                  label: mermaidMessages.visualDelete(),
                  disabled: context.readonly,
                  onSelect: () => {
                    host.setTransientState(
                      "block.parentIntent",
                      "deleteSelection",
                    );
                    context.refreshWorkarea();
                  },
                }
              : null,
          );
          if (!props) return null;
          const body = context.reactHost?.renderFamilyEditor(
            mermaidBlockRendererToken,
            props,
          );
          return body
            ? {
                body,
                actions: {
                  actions:
                    displayOnly || context.embedded
                      ? []
                      : BLOCK_PARENT_ACTIONS.map((id) => ({
                          id: `block.${id}`,
                          label: BLOCK_PARENT_ACTION_LABELS[id](),
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
    mermaidBlockHostAdapter.projectGfx({
      visualModel: visual,
      source,
      diagramType: "block",
      renderSurface: "core-facade",
    }),
};

import { previewMermaidGfxModel } from "../runtime/gfx-preview.js";
import type { ToolbarContext } from "@virgultum/shared/services";
import { Bound } from "@virgultum/global/gfx";
import {
  resolveMermaidEdgelessSelection,
  resolveMermaidEdgelessOwnerSelection,
  runMermaidEdgelessMutation,
} from "../../edgeless-toolbar/selection-context.js";
import {
  applyMermaidVisualModelCommand,
  getMermaidVisualModelForEditing,
  getMermaidGfxNode,
  getMermaidGfxConnector,
  getMermaidGfxSubgraph,
} from "../../commands.js";
import {
  readMermaidGfxNodeId,
  readMermaidGfxEdgeId,
  readMermaidGfxSubgraphId,
  readMermaidGfxMeta,
} from "../../mermaid-gfx-metadata.js";
import { getMermaidBlockSource } from "../../utils.js";
import { MermaidFamilyReactHostIdentifier } from "../runtime/react-host.js";
import { MERMAID_GFX_TITLE_ROLE } from "../runtime/gfx-element-roles.js";
import {
  MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  type MermaidFamilyEdgelessToolbarContribution,
  type MermaidPageSelectionItem,
} from "../runtime/contracts.js";
const nativeBlockPreviews = new WeakMap<object, () => void>();
function nativeBlockProps(context: ToolbarContext): BlockReactHostProps | null {
  const block = resolveMermaidEdgelessSelection(context);
  if (!block?.visualModel || block.diagramType !== "block") return null;
  const source = getMermaidBlockSource(block.owner.props),
    visualModel = block.visualModel;
  const model = readBlockProjectionModel(source, visualModel);
  if (!model) return null;
  const items = block.selectedModels.flatMap<MermaidPageSelectionItem>(
    (element) => {
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
    },
  );
  const unique = [
    ...new Map(items.map((i) => [`${i.kind}:${i.editKey}`, i])).values(),
  ];
  const sole =
    block.selectedModels.length === 1 ? block.selectedModels[0] : null;

  const selected: BlockSelection | null =
    sole && readMermaidGfxMeta(sole, "mermaidRole") === MERMAID_GFX_TITLE_ROLE
      ? { kind: "title", key: sole.id }
      : unique.length === 1
        ? blockSelection(visualModel, unique[0]!.kind, unique[0]!.editKey)
        : null;
  let placement: { centerX: number; centerY: number } | null = null;
  const clearPreview = () => {
    const dispose = nativeBlockPreviews.get(block.owner);
    nativeBlockPreviews.delete(block.owner);
    dispose?.();
  };
  const resolveAnchor: MermaidGfxActionContext["resolveVisualAnchor"] = (
    kind,
    key,
  ) => {
    const element =
      kind === "detail"
        ? block.owner.childIds
            .map((id) => block.owner.surface?.getElementById(id))
            .find(
              (child) => readMermaidGfxMeta(child, "mermaidDetailId") === key,
            )
        : kind === "node"
          ? getMermaidGfxNode(context.store, block.owner, key ?? "")
          : kind === "edge"
            ? getMermaidGfxConnector(context.store, block.owner, key ?? "")
            : kind === "subgraph"
              ? getMermaidGfxSubgraph(context.store, block.owner, key ?? "")
              : block.owner;
    if (!element?.xywh) return null;
    const bound = Bound.deserialize(element.xywh),
      rect = context.gfx.viewport.boundingClientRect;
    const [left, top] = context.gfx.viewport.toViewCoord(bound.maxX, bound.y);
    // Keep local controls attached to the visible part of the rendered object.
    return {
      left: Math.min(rect.right, Math.max(rect.left, left + rect.left)),
      top: Math.min(rect.bottom, Math.max(rect.top, top + rect.top)),
    };
  };
  const commandPort: BlockCommandPort = {
    getSource: () => getMermaidBlockSource(block.owner.props),
    getReadonly: () => context.readonly || context.store.readonly,
    getVisualModel: () =>
      getMermaidVisualModelForEditing(context.std, block.owner) ?? visualModel,
    getPlacement: () => placement,
    clearPlacement: () => {
      placement = null;
    },
    clearPreview,
    applyVisualModel: (visual, options) => {
      let feedback: { applied: boolean; diagnostic?: string } = {
        applied: false,
      };
      const applied = runMermaidEdgelessMutation(context, block.owner, () => {
        const [ok, result] = context.command.exec(
          applyMermaidVisualModelCommand,
          {
            model: block.owner,
            visualModel: visual,
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
    selectAfterProjection: (value) => {
      const element =
        value.kind === "node"
          ? getMermaidGfxNode(context.store, block.owner, value.editKey)
          : value.kind === "edge"
            ? getMermaidGfxConnector(context.store, block.owner, value.editKey)
            : getMermaidGfxSubgraph(context.store, block.owner, value.editKey);
      if (element)
        context.gfx.selection.set({ editing: false, elements: [element.id] });
    },
  };
  return {
    surface: "controls",
    model,
    config: model.config,
    visualModel,
    resolveVisualBounds: (kind, key) => {
      const element =
        kind === "node"
          ? getMermaidGfxNode(context.store, block.owner, key)
          : kind === "edge"
            ? getMermaidGfxConnector(context.store, block.owner, key)
            : kind === "subgraph"
              ? getMermaidGfxSubgraph(context.store, block.owner, key)
              : block.owner;
      if (!element?.xywh) return null;
      const b = Bound.deserialize(element.xywh),
        rect = context.gfx.viewport.boundingClientRect,
        [left, top] = context.gfx.viewport.toViewCoord(b.x, b.y);
      return {
        left: left + rect.left,
        top: top + rect.top,
        width: b.w * context.gfx.viewport.zoom,
        height: b.h * context.gfx.viewport.zoom,
      };
    },
    selectObject: (kind, key) =>
      commandPort.selectAfterProjection({ kind, editKey: key }),
    sourceBasis: source,
    selected,
    selectedKeys:
      selected?.kind === "title"
        ? [selected.key]
        : unique.map((i) => i.editKey),
    selectedAnchor: null,
    intent: null,
    parentIntent: null,
    groupAllowed:
      blockGroupAllowed(
        model,
        unique.map((i) => i.editKey),
      ) &&
      (blockPageSelectionTools.containerAction?.validate({
        items: unique,
        visualModel,
      }).valid ??
        false),
    readonly: context.readonly || context.store.readonly,
    displayOnly: false,
    embedded: false,
    embeddedEditing: false,
    workarea: null,
    workareaFooter: null,
    markersInClientSpace: true,
    get commentMarkers() {
      return blockCommentMarkers(model, resolveAnchor);
    },
    subscribeViewportChange: (handler) => {
      const moved = context.gfx.viewport.viewportUpdated.subscribe(handler),
        resized = context.gfx.viewport.sizeUpdated.subscribe(handler);
      return () => {
        moved.unsubscribe();
        resized.unsubscribe();
      };
    },
    getImpact: (item) => blockSelectionImpact(model, item),
    onCommand: createBlockCommandConsumer(commandPort),
    previewCommand: (name, args, basis) => {
      clearPreview();
      if (commandPort.getReadonly() || commandPort.getSource() !== basis)
        return {
          feedback: {
            changed: false,
            diagnostic: mermaidMessages.stateSourceConflict(),
          },
          dispose: () => {},
        };
      const active = readBlockProjectionModel(
        basis,
        commandPort.getVisualModel(),
      );
      if (!active)
        return {
          feedback: {
            changed: false,
            diagnostic: mermaidMessages.classPatchRejected(),
          },
          dispose: () => {},
        };
      const result = runBlockCommand(active, name, args);
      if (!result.changed || result.status === "rejected")
        return {
          feedback: {
            changed: false,
            diagnostic: result.diagnostic,
            impact: result.impact,
          },
          dispose: () => {},
        };
      const stored = commandPort.getVisualModel(),
        first = stored.nodes.find((n) =>
          getMermaidGfxNode(context.store, block.owner, n.id),
        ),
        element =
          first && getMermaidGfxNode(context.store, block.owner, first.id),
        surface = block.owner.surface;
      if (!surface) throw new Error("Missing native GFX Surface");
      const bound = Bound.deserialize(element?.xywh ?? block.owner.xywh);
      const dispose = previewMermaidGfxModel(
        reconcileBlockVisual(
          blockModelToVisual(result.model),
          stored,
          true,
          blockCommandReflowScopes(name, args, result),
        ),
        {
          surface,
          creator: block.owner,
          viewport: context.gfx.viewport,
          origin: new Bound(
            bound.x - (first?.x ?? 0),
            bound.y - (first?.y ?? 0),
            bound.w,
            bound.h,
          ),
          elements: block.owner.childIds.flatMap((id) => {
            const e = surface.getElementById(id);
            return e &&
              "stash" in e &&
              readMermaidGfxMeta(e, "mermaidRole") !== MERMAID_GFX_TITLE_ROLE
              ? [e]
              : [];
          }),
          refresh: () => context.gfx.surfaceComponent?.requestUpdate(),
        },
      );
      const ownedDispose = () => {
        if (nativeBlockPreviews.get(block.owner) === ownedDispose)
          nativeBlockPreviews.delete(block.owner);
        dispose();
      };
      nativeBlockPreviews.set(block.owner, ownedDispose);
      return {
        feedback: { changed: true, impact: result.impact },
        dispose: ownedDispose,
      };
    },
    subscribeEditIntent: (handler) => {
      const listener = (event: Event) => {
        const value = (event as CustomEvent<MermaidGfxObjectEditIntent>).detail;
        if (value) handler(value);
      };
      context.host.addEventListener("mermaid-gfx-object-edit", listener);
      return () =>
        context.host.removeEventListener("mermaid-gfx-object-edit", listener);
    },
    requestPlacement: (onPlace, onCancel) => {
      const host = context.host,
        basis = source;
      let pointer: number | null = null,
        point: { centerX: number; centerY: number } | null = null;
      host.setAttribute("data-mermaid-placement-owner", block.owner.id);
      const dispose = () => {
        host.removeAttribute("data-mermaid-placement-owner");
        if (pointer !== null && host.hasPointerCapture(pointer))
          host.releasePointerCapture(pointer);
        host.removeEventListener("pointerdown", down, true);
        host.removeEventListener("pointerup", up, true);
        host.removeEventListener("pointercancel", cancelPointer, true);
        host.removeEventListener("keydown", key, true);
      };
      const consume = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const abort = () => {
        dispose();
        onCancel?.();
      };
      const key = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          consume(event);
          abort();
        }
      };
      const cancelPointer = (event: PointerEvent) => {
        if (event.pointerId === pointer) {
          consume(event);
          abort();
        }
      };
      const down = (event: PointerEvent) => {
        if (
          event.button !== 0 ||
          !event
            .composedPath()
            .some(
              (e) =>
                e instanceof HTMLElement &&
                (e.tagName === "MYOXUS-SURFACE" ||
                  e.tagName === "CANVAS" ||
                  e.classList.contains("edgeless-background") ||
                  e.classList.contains("edgeless-block-children-container")),
            )
        )
          return;
        consume(event);
        if (context.store.readonly || commandPort.getSource() !== basis) {
          abort();
          return;
        }
        pointer = event.pointerId;
        host.setPointerCapture(pointer);
        const [x, y] = context.gfx.viewport.toModelCoordFromClientCoord([
          event.clientX,
          event.clientY,
        ]);
        const current = commandPort.getVisualModel(),
          first = current.nodes[0];
        const element =
          first && getMermaidGfxNode(context.store, block.owner, first.id);
        const origin = Bound.deserialize(element?.xywh ?? block.owner.xywh);
        point = {
          centerX: x - (first ? origin.x - first.x : origin.x),
          centerY: y - (first ? origin.y - first.y : origin.y),
        };
      };
      const up = (event: PointerEvent) => {
        if (event.pointerId !== pointer) return;
        consume(event);
        dispose();
        if (
          !point ||
          context.store.readonly ||
          commandPort.getSource() !== basis
        ) {
          onCancel?.();
          return;
        }
        placement = point;
        onPlace(point);
      };
      // Keep the entire gesture away from the generic ShapeEditor, including its release.
      host.addEventListener("pointerdown", down, true);
      host.addEventListener("pointerup", up, true);
      host.addEventListener("pointercancel", cancelPointer, true);
      host.addEventListener("keydown", key, true);
      return dispose;
    },
    onParentIntent: () => {},
    onEditIntent: () => {},
    onCloseSelection: () => {},
    onWorkareaResize: () => {},
    onEmbeddedActionsInsetChange: () => {},
    resolveReturnFocusTarget: () => context.host,
  };
}
export const blockEdgelessToolbar = {
  readonlySelection: true,
  invalidSourceSelection: true,
  actions: [
    {
      id: "mermaid-block.controls",
      label: mermaidMessages.controlsLabel(),
      control(context) {
        const host = context.std.getOptional(MermaidFamilyReactHostIdentifier),
          props = nativeBlockProps(context);
        if (props)
          return host?.toolbarControl(mermaidBlockRendererToken, props) ?? null;
        // The native owner's presentation already owns the retained-preview
        // diagnostic. Keep file actions in the Root slot without a second notice.
        return null;
      },
    },
  ],
  suppressBaseActionIds: MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  when: (context) => {
    const owner = resolveMermaidEdgelessOwnerSelection(context)?.model;
    return Boolean(
      owner &&
      /^\s*block(?:-beta)?\b/m.test(getMermaidBlockSource(owner.props)),
    );
  },
} as const satisfies MermaidFamilyEdgelessToolbarContribution;
