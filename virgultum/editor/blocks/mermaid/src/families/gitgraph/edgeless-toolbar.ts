// SPDX-License-Identifier: AGPL-3.0-or-later

import { ShapeElementModel } from "@virgultum/model";
import { getMermaidVisualModel } from "../../commands/model-resolution.js";
import { parseMermaidVisualFamilyData } from "../runtime/gfx-family-data.js";
import { resolveMermaidSourceLifecycle } from "../runtime/source-lifecycle.js";
import { createGitGraphSourceRepairProps } from "./source-repair.js";
import { exportMermaidMmdOwner } from "../../edgeless-toolbar/mmd-file-actions.js";

import { Bound } from "@virgultum/global/gfx";
import type { ToolbarContext } from "@virgultum/shared/services";
import {
  applyMermaidVisualModelCommand,
  readMermaidVisualModelFromProjectionGroup,
  getMermaidGfxNode,
  getMermaidGfxConnector,
  getMermaidGfxSubgraph,
  getMermaidVisualElementOriginBound,
  getMermaidVisualElementOriginFromAnchor,
} from "../../commands.js";
import {
  resolveMermaidEdgelessSelection,
  resolveMermaidEdgelessOwnerSelection,
  runMermaidEdgelessMutation,
} from "../../edgeless-toolbar/selection-context.js";
import {
  readMermaidGfxNodeId,
  readMermaidGfxEdgeId,
  readMermaidGfxSubgraphId,
  readMermaidGfxMeta,
} from "../../mermaid-gfx-metadata.js";
import { detectMermaidDiagramType } from "../../engine/diagram-types.js";
import { getMermaidBlockSource } from "../../utils.js";
import { previewMermaidGfxModel } from "../runtime/gfx-preview.js";
import { getMermaidGfxTitleBandHeight } from "../runtime/gfx-element-projection.js";
import { MERMAID_GFX_TITLE_ROLE } from "../runtime/gfx-element-roles.js";
import {
  MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  type MermaidFamilyEdgelessToolbarContribution,
  type MermaidPageSelectionItem,
} from "../runtime/contracts.js";
import { MermaidFamilyReactHostIdentifier } from "../runtime/react-host.js";
import { createGitGraphEditorProps } from "./host-adapter.js";
import { isGitGraphDiagramType } from "./family.js";
import { gitGraphModelToVisual } from "./visual-model.js";
import { preserveGitGraphOwnerTransform } from "./source-application.js";
import {
  readGitGraphProjectionModel,
  gitGraphBinding,
  gitGraphPayload,
} from "./gfx-data.js";
import type { GitGraphAction } from "./actions.js";
import {
  mermaidGitGraphRendererToken,
  mermaidGitGraphRepairRendererToken,
  type GitGraphReactHostProps,
} from "./react-host-contract.js";
import type { MermaidGfxObjectEditIntent } from "../runtime/editor-capabilities.js";
import { mermaidMessages as m } from "../../i18n.js";

const nativeGitGraphStates = new WeakMap<
  object,
  WeakMap<object, Map<string, unknown>>
>();
function nativeGitGraphState(viewport: object, owner: object) {
  let owners = nativeGitGraphStates.get(viewport);
  if (!owners) {
    owners = new WeakMap();
    nativeGitGraphStates.set(viewport, owners);
  }
  let state = owners.get(owner);
  if (!state) {
    state = new Map();
    owners.set(owner, state);
  }
  return state;
}

/** The real Root selection resolves the owner; embedded Note edits remain local. */
export function nativeGitGraphProps(
  context: ToolbarContext,
  parentIntent: GitGraphAction | null = null,
): GitGraphReactHostProps | null {
  if (!context.getSurfaceModels().length) return null;
  const state = resolveMermaidEdgelessSelection(context);
  if (!state?.visualModel || !isGitGraphDiagramType(state.diagramType))
    return null;
  const visual = state.visualModel,
    owner = state.owner;
  // Keep non-element selections in the exact set so grouping cannot accept a subset.
  const items = state.selectedModels.flatMap<
    | MermaidPageSelectionItem
    | { readonly kind: "diagram"; readonly editKey: string }
  >((element) => {
    const node =
        readMermaidGfxNodeId(element) ||
        readMermaidGfxMeta(element, "mermaidDetailOwnerNodeId"),
      edge = readMermaidGfxEdgeId(element),
      group = readMermaidGfxSubgraphId(element);
    return node
      ? [{ kind: "node", editKey: node }]
      : edge
        ? [{ kind: "edge", editKey: edge }]
        : group
          ? [{ kind: "subgraph", editKey: group }]
          : [{ kind: "diagram", editKey: element.id }];
  });
  const selectedItems = [
    ...new Map(items.map((i) => [`${i.kind}:${i.editKey}`, i])).values(),
  ];
  const elementFor = (kind: string, id?: string) =>
    kind === "node"
      ? getMermaidGfxNode(context.store, owner, id ?? "")
      : kind === "edge"
        ? getMermaidGfxConnector(context.store, owner, id ?? "")
        : kind === "subgraph"
          ? getMermaidGfxSubgraph(context.store, owner, id ?? "")
          : kind === "detail"
            ? owner.childIds
                .map((id) => owner.surface?.getElementById(id))
                .find(
                  (e) =>
                    readMermaidGfxMeta(e, "mermaidDetailId") === id ||
                    readMermaidGfxMeta(e, "mermaidDetailSourceKey") === id,
                )
            : owner;
  const sole =
    state.selectedModels.length === 1 ? state.selectedModels[0] : null;
  const detail = readMermaidGfxMeta(sole, "mermaidDetailSourceKey");
  const intent: MermaidGfxObjectEditIntent | null =
    !parentIntent && detail && selectedItems.length === 1
      ? { kind: "detail", id: detail, ownerId: selectedItems[0].editKey }
      : null;
  const transient = nativeGitGraphState(context.gfx.viewport, owner);
  const readDisplayedModel = () =>
    readMermaidVisualModelFromProjectionGroup(
      context.store,
      owner,
      getMermaidVisualModel(owner),
    ) ?? visual;
  if (parentIntent) transient.set("gitgraph.parentIntent", parentIntent);
  if (intent) transient.set("gitgraph.editIntent", intent);
  const props = createGitGraphEditorProps(
    {
      visualModel: visual,
      getVisualModel: readDisplayedModel,
      selectedItems,
      readonly: context.readonly,
      displayOnly: false,
      embedded: false,
      embeddedEditing: false,
      actionTarget: null,
      workarea: null,
      workareaFooter: null,
      viewportIdentity: context.gfx.viewport,
      resolveViewportPoint: (point) => {
        const rect = context.gfx.viewport.boundingClientRect;
        const [x, y] = context.gfx.viewport.toModelCoord(
          point.left - rect.left,
          point.top - rect.top,
        );
        return { x, y };
      },
      resolveVisualAnchor: (kind, id, visible) => {
        const element = elementFor(kind, id);
        if (!element?.xywh) return null;
        const bound = Bound.deserialize(element.xywh),
          rect = context.gfx.viewport.boundingClientRect;
        const [x, y] = context.gfx.viewport.toViewCoord(bound.maxX, bound.y);
        const left = x + rect.left,
          top = y + rect.top;
        return visible
          ? {
              left: Math.min(rect.right, Math.max(rect.left, left)),
              top: Math.min(rect.bottom, Math.max(rect.top, top)),
            }
          : { left, top };
      },
      resolveVisualBounds: (kind, id, client = false) => {
        const element = elementFor(kind, id);
        if (!element?.xywh) return null;
        const bound = Bound.deserialize(element.xywh),
          rect = context.gfx.viewport.boundingClientRect;
        const [left, top] = context.gfx.viewport.toViewCoord(bound.x, bound.y),
          [right, bottom] = context.gfx.viewport.toViewCoord(
            bound.maxX,
            bound.maxY,
          );
        return {
          left: left + (client ? rect.left : 0),
          top: top + (client ? rect.top : 0),
          width: right - left,
          height: bottom - top,
        };
      },
      resolveReturnFocusTarget: () => context.host,
      onEmbeddedActionsInsetChange: () => {},
      refreshWorkarea: () => context.gfx.surfaceComponent?.requestUpdate(),
      selectNode: (id) => {
        const element = elementFor("node", id);
        if (element)
          context.gfx.selection.set({ editing: false, elements: [element.id] });
      },
      selectAfterProjection: (item) => {
        const element = elementFor(item.kind, item.editKey);
        if (element)
          context.gfx.selection.set({ editing: false, elements: [element.id] });
      },
      applyVisualModel: (candidate, options) => {
        let feedback: { applied: boolean; diagnostic?: string } = {
          applied: false,
        };
        const applied = runMermaidEdgelessMutation(context, owner, () => {
          const [ok, result] = context.command.exec(
            applyMermaidVisualModelCommand,
            {
              model: owner,
              visualModel: candidate,
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
      previewVisualModel: (candidate) => {
        const surface = owner.surface;
        if (!surface) throw new Error("Missing native GitGraph Surface");
        const current = readDisplayedModel();
        const first =
          current.nodes.find((n) =>
            getMermaidGfxNode(context.store, owner, n.id),
          ) ??
          current.subgraphs?.find((g) =>
            getMermaidGfxSubgraph(context.store, owner, g.id),
          );
        const anchor =
          first &&
          (getMermaidGfxNode(context.store, owner, first.id) ??
            getMermaidGfxSubgraph(context.store, owner, first.id));
        const fallback = Bound.deserialize(owner.xywh);
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
        return previewMermaidGfxModel(candidate, {
          surface,
          creator: owner,
          viewport: context.gfx.viewport,
          origin,
          elements: owner.childIds.flatMap((id) => {
            const e = surface.getElementById(id);
            return e &&
              "stash" in e &&
              readMermaidGfxMeta(e, "mermaidRole") !== MERMAID_GFX_TITLE_ROLE
              ? [e]
              : [];
          }),
          refresh: () => context.gfx.surfaceComponent?.requestUpdate(),
        });
      },
    },
    {
      getSource: () => getMermaidBlockSource(owner.props),
      copySource: () =>
        context.std.clipboard.writeToClipboard(async (items) => ({
          ...items,
          "text/plain": getMermaidBlockSource(owner.props),
        })),
      exportMmd: () => exportMermaidMmdOwner(owner),
      getReadonly: () => context.readonly,
      getTransientState: (key) => transient.get(key),
      setTransientState: (key, value) => transient.set(key, value),
    },
  );
  return props
    ? {
        ...props,
        surface: "controls",
        onVisibility: (kind, visible) => {
          transient.set(`gitgraph.${kind}Visible`, visible);
          for (const node of visual.nodes) {
            const b = gitGraphBinding(node),
              p = gitGraphPayload(node);
            if (
              kind === "comments"
                ? b?.role !== "comment"
                : b?.role !== "statement" && p?.authoringGuide !== true
            )
              continue;
            const element = getMermaidGfxNode(context.store, owner, node.id);
            if (element instanceof ShapeElementModel) {
              element.stash("hidden");
              element.hidden = !visible;
            }
          }
          context.gfx.surfaceComponent?.requestUpdate();
        },

        subscribeEditIntent: (handler) => {
          const listener = (event: Event) => {
            const intent = (event as CustomEvent<MermaidGfxObjectEditIntent>)
              .detail;
            if (
              intent &&
              (props.selected?.visualKey === (intent.ownerId ?? intent.id) ||
                props.selectedKeys.includes(
                  gitGraphBinding(
                    props.visualModel.nodes.find(
                      (n) => n.id === (intent.ownerId ?? intent.id),
                    ) ?? {},
                  )?.sourceKey ?? intent.id,
                ))
            )
              handler(intent);
          };
          context.host.addEventListener("mermaid-gfx-object-edit", listener);
          return () =>
            context.host.removeEventListener(
              "mermaid-gfx-object-edit",
              listener,
            );
        },
      }
    : null;
}

/** The existing Root toolbar embeds this inline family contribution. Its React
 * consumer renders catalog buttons, not another toolbar or already-open forms. */
export const gitGraphEdgelessToolbar = {
  readonlySelection: true,
  invalidSourceSelection: true,
  actions: [
    {
      id: "mermaid-gitGraph.controls",
      label: m.controlsLabel(),
      control(context) {
        const owner = resolveMermaidEdgelessOwnerSelection(context)?.model;
        if (
          owner &&
          resolveMermaidSourceLifecycle(getMermaidBlockSource(owner.props))
            .kind === "invalid"
        ) {
          const state = nativeGitGraphState(context.gfx.viewport, owner),
            visual = readMermaidVisualModelFromProjectionGroup(
              context.store,
              owner,
              getMermaidVisualModel(owner),
              "gitGraph",
            );
          const props = createGitGraphSourceRepairProps(
            {
              getSource: () => getMermaidBlockSource(owner.props),
              projectVisual: (next) => {
                const previous =
                  visual &&
                  readGitGraphProjectionModel(
                    owner.props.lastValidSource ?? "",
                    visual,
                  );
                return previous && visual
                  ? preserveGitGraphOwnerTransform(
                      next,
                      gitGraphModelToVisual(previous),
                      visual,
                    )
                  : next;
              },
              getReadonly: () => owner.store.readonly || context.readonly,
              select: (key) => {
                const element = getMermaidGfxNode(context.store, owner, key);
                if (element)
                  context.gfx.selection.set({ elements: [element.id] });
                context.host.focus({ preventScroll: true });
              },
              getSourceMetadata: () =>
                parseMermaidVisualFamilyData(owner.props.familyData),
              getTransientState: (key) => state.get(key),
              setTransientState: (key, value) => state.set(key, value),
              apply: (candidate, sourceWrite) => {
                let diagnostic: string | undefined;
                const applied = runMermaidEdgelessMutation(
                  context,
                  owner,
                  () => {
                    const [ok, result] = context.command.exec(
                      applyMermaidVisualModelCommand,
                      { model: owner, visualModel: candidate, sourceWrite },
                    );
                    diagnostic = result?.diagnostic;
                    return !!ok && result?.applied === true;
                  },
                  sourceWrite,
                );
                return { applied, diagnostic };
              },
              preview:
                visual && owner.surface
                  ? (candidate) =>
                      previewMermaidGfxModel(candidate, {
                        surface: owner.surface!,
                        creator: owner,
                        viewport: context.gfx.viewport,
                        origin: getMermaidVisualElementOriginBound(
                          visual,
                          Bound.deserialize(owner.xywh),
                          getMermaidGfxTitleBandHeight(visual),
                        ),
                        elements: owner.childIds.flatMap((id) => {
                          const e = owner.surface?.getElementById(id);
                          return e && "hidden" in e && "stash" in e ? [e] : [];
                        }),
                        refresh: () =>
                          context.gfx.surfaceComponent?.requestUpdate(),
                      })
                  : undefined,
            },
            {
              surface: "controls",
              embedded: false,
              workarea: null,
              workareaFooter: null,
              viewportIdentity: context.gfx.viewport,
              resolveReturnFocusTarget: () => context.host,
              onWorkareaResize: () =>
                context.gfx.surfaceComponent?.requestUpdate(),
            },
          );
          return (
            context.std
              .getOptional(MermaidFamilyReactHostIdentifier)
              ?.toolbarControl(mermaidGitGraphRepairRendererToken, props) ??
            null
          );
        }
        const props = nativeGitGraphProps(context);
        return props
          ? (context.std
              .getOptional(MermaidFamilyReactHostIdentifier)
              ?.toolbarControl(mermaidGitGraphRendererToken, props) ?? null)
          : null;
      },
    },
  ],
  suppressBaseActionIds: MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  when: (context) => {
    if (!context.getSurfaceModels().length) return false;
    const owner = resolveMermaidEdgelessOwnerSelection(context)?.model;
    return (
      !!owner &&
      isGitGraphDiagramType(
        detectMermaidDiagramType(getMermaidBlockSource(owner.props)),
      )
    );
  },
} as const satisfies MermaidFamilyEdgelessToolbarContribution;
