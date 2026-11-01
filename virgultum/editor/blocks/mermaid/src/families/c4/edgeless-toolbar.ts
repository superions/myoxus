// SPDX-License-Identifier: AGPL-3.0-or-later

import { Bound } from "@virgultum/global/gfx";
import type { ToolbarContext } from "@virgultum/shared/services";
import {
  applyMermaidVisualModelCommand,
  getMermaidVisualModelForEditing,
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
import { createC4EditorProps } from "./host-adapter.js";
import { isC4DiagramType } from "./family.js";
import {
  mermaidC4RendererToken,
  type C4ParentIntent,
  type C4EditorReactHostProps,
} from "./react-host-contract.js";
import type { MermaidGfxObjectEditIntent } from "../runtime/editor-capabilities.js";
import { mermaidMessages as m } from "../../i18n.js";

/** The real Root selection resolves the owner; embedded Note edits remain local. */
export function nativeC4Props(
  context: ToolbarContext,
  parentIntent: C4ParentIntent | null = null,
): C4EditorReactHostProps | null {
  if (!context.getSurfaceModels().length) return null;
  const state = resolveMermaidEdgelessSelection(context);
  if (!state?.visualModel || !isC4DiagramType(state.diagramType)) return null;
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
  const transient = new Map<string, unknown>([
    ["c4.parentIntent", parentIntent],
    ["c4.editIntent", intent],
  ]);
  const props = createC4EditorProps(
    {
      visualModel: visual,
      getVisualModel: () =>
        getMermaidVisualModelForEditing(context.std, owner) ?? visual,
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
        if (!surface) throw new Error("Missing native C4 Surface");
        const current =
          getMermaidVisualModelForEditing(context.std, owner) ?? visual;
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
      getReadonly: () => context.readonly,
      getTransientState: (key) => transient.get(key),
      setTransientState: (key, value) => transient.set(key, value),
    },
  );
  return props
    ? {
        ...props,
        surface: "controls",
        markersInClientSpace: true,
        subscribeEditIntent: (handler) => {
          const listener = (event: Event) => {
            const intent = (event as CustomEvent<MermaidGfxObjectEditIntent>)
              .detail;
            if (
              intent &&
              props.selectedKeys.includes(intent.ownerId ?? intent.id)
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
export const c4EdgelessToolbar = {
  readonlySelection: true,
  invalidSourceSelection: true,
  actions: [
    {
      id: "mermaid-c4.controls",
      label: m.controlsLabel(),
      control(context) {
        const props = nativeC4Props(context);
        return props && !props.readonly
          ? (context.std
              .getOptional(MermaidFamilyReactHostIdentifier)
              ?.toolbarControl(mermaidC4RendererToken, props) ?? null)
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
      isC4DiagramType(
        detectMermaidDiagramType(getMermaidBlockSource(owner.props)),
      )
    );
  },
} as const satisfies MermaidFamilyEdgelessToolbarContribution;
