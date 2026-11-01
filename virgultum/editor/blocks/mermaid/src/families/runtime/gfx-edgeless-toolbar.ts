// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolbarContext } from "@virgultum/shared/services";
import { Bound } from "@virgultum/global/gfx";

import {
  getMermaidGfxConnector,
  getMermaidGfxNode,
  getMermaidGfxSubgraph,
} from "../../commands.js";
import {
  resolveMermaidEdgelessSelection,
  runMermaidEdgelessMutation,
} from "../../edgeless-toolbar/selection-context.js";
import { mermaidMessages } from "../../i18n.js";
import {
  readMermaidGfxEdgeId,
  readMermaidGfxNodeId,
  readMermaidGfxSubgraphId,
} from "../../mermaid-gfx-metadata.js";
import type { MermaidGfxFamilyHookRegistration } from "./gfx-family-hooks-contract.js";
import {
  MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  type MermaidFamilyEdgelessToolbarContribution,
} from "./contracts.js";
import {
  addMermaidGfxEdgeCommand,
  addMermaidGfxNodeCommand,
  deleteMermaidGfxSelectionCommand,
} from "./gfx-commands.js";
import { addMermaidGfxSubgraphCommand } from "./gfx-subgraph-commands.js";
import { resolveTypeOwnedMermaidGfxDeletionPlan } from "./gfx-graph-operations.js";

function familyState(
  context: ToolbarContext,
  registration: MermaidGfxFamilyHookRegistration,
) {
  const state = resolveMermaidEdgelessSelection(context);
  return state?.projection &&
    state.visualModel &&
    registration.owns(state.visualModel)
    ? {
        ...state,
        projection: state.projection,
        visualModel: state.visualModel,
      }
    : null;
}

function selection(context: ToolbarContext) {
  const selected = context.getSurfaceModels();
  return {
    edgeId: selected.map(readMermaidGfxEdgeId).find(Boolean),
    nodeId: selected.map(readMermaidGfxNodeId).find(Boolean),
    subgraphId: selected.map(readMermaidGfxSubgraphId).find(Boolean),
  };
}

/** Pan a newly selected native node clear of the rendered controls, retaining
 * its geometry and the user's zoom. Shared by Mindmap and Flowchart creation. */
export function revealNativeMermaidNode(context: ToolbarContext, xywh: string) {
  const viewport = context.gfx.viewport;
  if (viewport.locked) return;
  const bound = Bound.deserialize(xywh);
  const [left, top] = viewport.toViewCoord(bound.x, bound.y);
  const [right, bottom] = viewport.toViewCoord(bound.maxX, bound.maxY);
  const tools = context.host
    .querySelector("edgeless-toolbar-widget")
    ?.getBoundingClientRect();
  const actions = context.host.ownerDocument
    .querySelector("editor-toolbar")
    ?.getBoundingClientRect();
  const inset = 36;
  const minX = inset,
    maxX = viewport.width - inset;
  const minY =
    Math.max(0, (actions?.bottom ?? viewport.top) - viewport.top) + inset;
  const maxY =
    Math.min(
      viewport.height,
      (tools?.top ?? viewport.top + viewport.height) - viewport.top,
    ) - inset;
  const dx = left < minX ? left - minX : Math.max(0, right - maxX);
  const dy = top < minY ? top - minY : Math.max(0, bottom - maxY);
  if (dx || dy)
    viewport.setCenter(
      viewport.centerX + dx / viewport.zoom,
      viewport.centerY + dy / viewport.zoom,
    );
}

export function createMermaidGfxEdgelessToolbarConfig(
  registration: MermaidGfxFamilyHookRegistration,
  actionIds: {
    readonly addNode?: string;
    readonly addSubgraph?: string;
    readonly connect?: string;
    readonly deleteSelection?: string;
  } = {},
) {
  return {
    actions: [
      {
        id: actionIds.addNode ?? "mermaid-family.add-node",
        label: mermaidMessages.visualAddNode(),
        showLabel: true,
        when: (context) =>
          !context.readonly &&
          Boolean(familyState(context, registration)) &&
          Boolean(registration.hooks.createNode),
        run(context) {
          const state = familyState(context, registration);
          if (!state?.projection) return;
          let nodeId = "";
          const applied = runMermaidEdgelessMutation(
            context,
            state.owner,
            () => {
              const [ok, result] = context.command.exec(
                addMermaidGfxNodeCommand,
                { model: state.owner },
              );
              nodeId = result?.nodeId ?? "";
              return ok;
            },
          );
          if (!applied || !nodeId) return;
          const node = getMermaidGfxNode(
            context.store,
            state.projection.model,
            nodeId,
          );
          if (node) {
            context.gfx.selection.set({ editing: false, elements: [node.id] });
          }
        },
      },
      {
        id: actionIds.connect ?? "mermaid-family.connect",
        label: mermaidMessages.visualConnect(),
        showLabel: true,
        when(context) {
          const state = familyState(context, registration);
          const nodeIds = context
            .getSurfaceModels()
            .map(readMermaidGfxNodeId)
            .filter(Boolean);
          return (
            !context.readonly &&
            Boolean(state?.projection) &&
            Boolean(registration.hooks.createEdge) &&
            nodeIds.length === 2
          );
        },
        run(context) {
          const state = familyState(context, registration);
          const nodeIds = context
            .getSurfaceModels()
            .map(readMermaidGfxNodeId)
            .filter(Boolean);
          if (!state?.projection || nodeIds.length !== 2) return;
          let edgeId = "";
          const applied = runMermaidEdgelessMutation(
            context,
            state.owner,
            () => {
              const [ok, result] = context.command.exec(
                addMermaidGfxEdgeCommand,
                {
                  model: state.owner,
                  sourceNodeId: nodeIds[0],
                  targetNodeId: nodeIds[1],
                },
              );
              edgeId = result?.edgeId ?? "";
              return ok;
            },
          );
          if (!applied || !edgeId) return;
          const connector = getMermaidGfxConnector(
            context.store,
            state.projection.model,
            edgeId,
          );
          if (connector) {
            context.gfx.selection.set({
              editing: false,
              elements: [connector.id],
            });
          }
        },
      },
      {
        id: actionIds.addSubgraph ?? "mermaid-family.add-subgraph",
        label: mermaidMessages.visualAddSubgraph(),
        showLabel: true,
        when(context) {
          const state = familyState(context, registration);
          const nodeIds = context
            .getSurfaceModels()
            .map(readMermaidGfxNodeId)
            .filter((nodeId): nodeId is string => Boolean(nodeId));
          return Boolean(
            !context.readonly &&
            state?.projection &&
            nodeIds.length >= 2 &&
            registration.hooks.createSubgraph?.(state.visualModel, nodeIds),
          );
        },
        run(context) {
          const state = familyState(context, registration);
          const selectedNodeIds = context
            .getSurfaceModels()
            .map(readMermaidGfxNodeId)
            .filter((nodeId): nodeId is string => Boolean(nodeId));
          if (
            !state?.projection ||
            selectedNodeIds.length < 2 ||
            !registration.hooks.createSubgraph?.(
              state.visualModel,
              selectedNodeIds,
            )
          ) {
            return;
          }
          let subgraphId = "";
          const applied = runMermaidEdgelessMutation(
            context,
            state.owner,
            () => {
              const [ok, result] = context.command.exec(
                addMermaidGfxSubgraphCommand,
                { model: state.owner, selectedNodeIds },
              );
              subgraphId = result?.subgraphId ?? "";
              return ok;
            },
          );
          if (!applied || !subgraphId) return;
          const subgraph = getMermaidGfxSubgraph(
            context.store,
            state.projection.model,
            subgraphId,
          );
          if (subgraph) {
            context.gfx.selection.set({
              editing: false,
              elements: [subgraph.id],
            });
          }
        },
      },
      {
        id: actionIds.deleteSelection ?? "e.delete",
        generate(context) {
          const state = familyState(context, registration);
          const selected = selection(context);
          if (
            context.readonly ||
            !state ||
            !(selected.nodeId || selected.edgeId || selected.subgraphId) ||
            !registration.hooks.deleteSelection
          ) {
            return null;
          }
          const deletionPlan = resolveTypeOwnedMermaidGfxDeletionPlan(
            state.visualModel,
            selected,
          );
          if (!deletionPlan) return null;
          const label = mermaidMessages.visualDelete();
          return {
            icon: "DeleteIcon",
            label,
            tooltip: `${mermaidMessages.selectionDeleteImpact()}: ${[
              ...deletionPlan.impact,
            ].join(", ")}`,
            variant: "destructive",
            run(runContext) {
              const current = familyState(runContext, registration);
              if (!current) return;
              const applied = runMermaidEdgelessMutation(
                runContext,
                current.owner,
                () =>
                  runContext.command.exec(deleteMermaidGfxSelectionCommand, {
                    ...selection(runContext),
                    model: current.owner,
                  })[0],
              );
              if (applied) {
                runContext.gfx.selection.set({
                  editing: false,
                  elements: [],
                });
              }
            },
          };
        },
      },
    ],
    suppressBaseActionIds: MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
    when: (context) => Boolean(familyState(context, registration)),
  } as const satisfies MermaidFamilyEdgelessToolbarContribution;
}
