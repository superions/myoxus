// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ToolbarContext } from "@virgultum/shared/services";

import {
  getMermaidGfxConnector,
  getMermaidGfxNode,
  getMermaidGfxSubgraph,
} from "../../commands.js";
import {
  applyArchitectureEdgelessAlignment,
  architectureEdgelessAlignmentForSelection,
  architectureEdgelessCommentsProjection,
  architectureEdgelessDeleteProjection,
  architectureEdgelessPropertiesProjection,
  architectureEdgelessSettingsProjection,
  deleteArchitectureEdgelessAlignment,
} from "./action-projection.js";
import {
  addMermaidGfxEdgeCommand,
  addMermaidGfxNodeCommand,
} from "../../families/runtime/gfx-commands.js";
import { addMermaidGfxSubgraphCommand } from "../../families/runtime/gfx-subgraph-commands.js";
import {
  MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  type MermaidFamilyEdgelessToolbarContribution,
} from "../../families/runtime/contracts.js";
import { MermaidFamilyReactHostIdentifier } from "../../families/runtime/react-host.js";
import { mermaidArchitectureRendererToken } from "../../families/architecture/react-host-contract.js";
import { mermaidArchitecturePageSelectionTools } from "../../families/architecture/page-selection-tools.js";
import { validateMermaidPageSelectionContainerAction } from "../../families/runtime/contracts.js";
import { mermaidMessages } from "../../i18n.js";
import { readMermaidGfxNodeId } from "../../mermaid-gfx-metadata.js";
import {
  architectureOwnerForSelection,
  architectureSelection,
  architectureSelectionDescriptor,
  runArchitectureMutation,
  selectArchitectureElement,
  selectedArchitectureItems,
  selectedArchitectureModels,
} from "./context.js";

function renderArchitectureSurface(
  context: ToolbarContext,
  props:
    | ReturnType<typeof architectureEdgelessCommentsProjection>
    | ReturnType<typeof architectureEdgelessDeleteProjection>
    | ReturnType<typeof architectureEdgelessPropertiesProjection>
    | ReturnType<typeof architectureEdgelessSettingsProjection>,
) {
  if (!props) return null;
  return (
    context.std
      .getOptional(MermaidFamilyReactHostIdentifier)
      ?.toolbarControl(mermaidArchitectureRendererToken, props) ?? null
  );
}

export const architectureEdgelessToolbarConfig = {
  actions: [
    {
      id: "mermaid-architecture.add-service",
      label: mermaidMessages.architectureAddService(),
      showLabel: true,
      when: (context) => !context.readonly,
      run(context) {
        const state = architectureOwnerForSelection(context);
        if (!state) return;
        let nodeId = "";
        const applied = runArchitectureMutation(context, state.owner, () => {
          const [ok, result] = context.command.exec(addMermaidGfxNodeCommand, {
            model: state.owner,
            shape: "subroutine",
          });
          nodeId = result?.nodeId ?? "";
          return ok;
        });
        if (!applied || !nodeId) return;
        selectArchitectureElement(
          context,
          getMermaidGfxNode(context.store, state.projection.model, nodeId)?.id,
        );
      },
    },
    {
      id: "mermaid-architecture.add-junction",
      label: mermaidMessages.architectureAddJunction(),
      showLabel: true,
      when: (context) => !context.readonly,
      run(context) {
        const state = architectureOwnerForSelection(context);
        if (!state) return;
        let nodeId = "";
        const applied = runArchitectureMutation(context, state.owner, () => {
          const [ok, result] = context.command.exec(addMermaidGfxNodeCommand, {
            model: state.owner,
            shape: "circle",
          });
          nodeId = result?.nodeId ?? "";
          return ok;
        });
        if (!applied || !nodeId) return;
        selectArchitectureElement(
          context,
          getMermaidGfxNode(context.store, state.projection.model, nodeId)?.id,
        );
      },
    },
    {
      id: "mermaid-architecture.add-group",
      label: mermaidMessages.architectureAddGroup(),
      showLabel: true,
      when: (context) => {
        const state = architectureOwnerForSelection(context);
        return Boolean(
          !context.readonly &&
          state &&
          validateMermaidPageSelectionContainerAction(
            mermaidArchitecturePageSelectionTools.containerAction,
            selectedArchitectureItems(context),
            state.visualModel,
          ).valid,
        );
      },
      run(context) {
        const state = architectureOwnerForSelection(context);
        if (!state) return;
        const selectedNodeIds = selectedArchitectureModels(context)
          .map(readMermaidGfxNodeId)
          .filter((nodeId): nodeId is string => Boolean(nodeId));
        let subgraphId = "";
        const applied = runArchitectureMutation(context, state.owner, () => {
          const [ok, result] = context.command.exec(
            addMermaidGfxSubgraphCommand,
            { model: state.owner, selectedNodeIds },
          );
          subgraphId = result?.subgraphId ?? "";
          return ok;
        });
        if (!applied || !subgraphId) return;
        selectArchitectureElement(
          context,
          getMermaidGfxSubgraph(
            context.store,
            state.projection.model,
            subgraphId,
          )?.id,
        );
      },
    },
    {
      id: "mermaid-architecture.connect",
      label: mermaidMessages.visualConnect(),
      showLabel: true,
      when(context) {
        const items = selectedArchitectureItems(context);
        return (
          !context.readonly &&
          items.length === 2 &&
          items.every((item) => item.kind === "node")
        );
      },
      run(context) {
        const state = architectureOwnerForSelection(context);
        const nodeIds = selectedArchitectureModels(context)
          .map(readMermaidGfxNodeId)
          .filter((nodeId): nodeId is string => Boolean(nodeId));
        if (!state || nodeIds.length !== 2) return;
        let edgeId = "";
        const applied = runArchitectureMutation(context, state.owner, () => {
          const [ok, result] = context.command.exec(addMermaidGfxEdgeCommand, {
            model: state.owner,
            sourceNodeId: nodeIds[0],
            targetNodeId: nodeIds[1],
          });
          edgeId = result?.edgeId ?? "";
          return ok;
        });
        if (!applied || !edgeId) return;
        selectArchitectureElement(
          context,
          getMermaidGfxConnector(context.store, state.projection.model, edgeId)
            ?.id,
        );
      },
    },
    ...(["row", "column"] as const).map((direction) => ({
      id: `mermaid-architecture.align-${direction}`,
      label:
        direction === "row"
          ? mermaidMessages.architectureAlignRow()
          : mermaidMessages.architectureAlignColumn(),
      showLabel: true,
      when(context: ToolbarContext) {
        const items = selectedArchitectureItems(context);
        return (
          !context.readonly &&
          items.length >= 2 &&
          items.every((item) => item.kind === "node")
        );
      },
      run(context: ToolbarContext) {
        const state = architectureOwnerForSelection(context);
        const nodeIds = selectedArchitectureModels(context)
          .map(readMermaidGfxNodeId)
          .filter((nodeId): nodeId is string => Boolean(nodeId));
        if (!state) return;
        applyArchitectureEdgelessAlignment(context, state, nodeIds, direction);
      },
    })),
    {
      id: "mermaid-architecture.delete-alignment",
      label: mermaidMessages.architectureDeleteAlignment(),
      showLabel: true,
      when(context) {
        const state = architectureOwnerForSelection(context);
        return Boolean(
          !context.readonly &&
          state &&
          architectureEdgelessAlignmentForSelection(context, state),
        );
      },
      run(context) {
        const state = architectureOwnerForSelection(context);
        if (state) deleteArchitectureEdgelessAlignment(context, state);
      },
    },
    {
      id: "mermaid-architecture.diagram-settings",
      label: mermaidMessages.architectureDiagramSettings(),
      control(context) {
        const state = architectureOwnerForSelection(context);
        return state
          ? renderArchitectureSurface(
              context,
              architectureEdgelessSettingsProjection(context, state),
            )
          : null;
      },
    },
    {
      id: "mermaid-architecture.comments",
      label: mermaidMessages.architectureComments(),
      when(context) {
        const state = architectureOwnerForSelection(context);
        return Boolean(
          selectedArchitectureItems(context).length <= 1 ||
          (state && architectureEdgelessAlignmentForSelection(context, state)),
        );
      },
      control(context) {
        const state = architectureOwnerForSelection(context);
        return state
          ? renderArchitectureSurface(
              context,
              architectureEdgelessCommentsProjection(context, state),
            )
          : null;
      },
    },
    {
      id: "mermaid-architecture.properties",
      label: mermaidMessages.architectureProperties(),
      when(context) {
        const state = architectureOwnerForSelection(context);
        return Boolean(state && architectureSelection(context, state));
      },
      control(context) {
        const state = architectureOwnerForSelection(context);
        return state
          ? renderArchitectureSurface(
              context,
              architectureEdgelessPropertiesProjection(context, state),
            )
          : null;
      },
    },
    {
      id: "e.delete",
      label: mermaidMessages.visualDelete(),
      when(context) {
        const state = architectureOwnerForSelection(context);
        return Boolean(
          !context.readonly &&
          state &&
          architectureSelectionDescriptor(context),
        );
      },
      control(context) {
        const state = architectureOwnerForSelection(context);
        return state
          ? renderArchitectureSurface(
              context,
              architectureEdgelessDeleteProjection(context, state),
            )
          : null;
      },
    },
  ],
  suppressBaseActionIds: MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  when: (context) => architectureOwnerForSelection(context) !== null,
} as const satisfies MermaidFamilyEdgelessToolbarContribution;
