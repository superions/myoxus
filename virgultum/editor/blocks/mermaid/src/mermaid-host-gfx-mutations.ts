import { recordMermaidSelectionHistory } from "./mermaid-selection-history.js";
import { mermaidRuntimePreservesSourceBytes } from "./families/runtime/factory.js";
import {
  getMermaidSourceAuthoritativeVisualModel,
  getMermaidVisualModelForEditing,
} from "./commands.js";

import type { MermaidVisualNodeShape } from "./families/runtime/gfx-host-contract.js";
import type { MermaidVisualModel } from "./families/runtime/gfx-model.js";
import { validateMermaidPageSelectionContainerAction } from "./families/runtime/contracts.js";
import {
  addMermaidGfxSubgraphCommand,
  applyMermaidGfxEdgeCommand,
  applyMermaidGfxNodeCommand,
} from "./families/runtime/gfx-commands.js";
import {
  beginMermaidRuntimeTransaction,
  commitMermaidRuntimeTransaction,
  type MermaidRuntimeTransactionOptions,
} from "./families/runtime/transaction.js";

import {
  resolveMermaidGfxEdgeLinkTypeEdit,
  resolveMermaidGfxEdgeStyleEdit,
  resolveMermaidGfxNodeStyleClassEdit,
} from "./mermaid-gfx-edit.js";

import { toggleMermaidGfxPendingNodeInsertPatch } from "./mermaid-gfx-selection-state.js";

import { getMermaidFamilyRuntime } from "./families/runtime/registry.js";
import { getMermaidBlockSource } from "./utils.js";

import { MermaidHostControls } from "./mermaid-host-controls.js";

export abstract class MermaidHostGfxMutations extends MermaidHostControls {
  protected _getMermaidVisualModelForEditing() {
    return getMermaidVisualModelForEditing(this.std, this.model);
  }

  protected _applyGfxMutation(
    run: () => boolean,
    options: MermaidRuntimeTransactionOptions = {},
    gestureStartVisualModel?: MermaidVisualModel | null,
  ) {
    const currentSnapshot = getMermaidSourceAuthoritativeVisualModel(
      this.std,
      this.model,
    );
    const beforeVisualModel = gestureStartVisualModel
      ? {
          ...gestureStartVisualModel,
          projectionOrigin: currentSnapshot?.projectionOrigin,
        }
      : currentSnapshot;
    const transaction = beginMermaidRuntimeTransaction({
      currentSource: getMermaidBlockSource(this.model.props),
      currentVisualModel: beforeVisualModel,
      options: {
        preserveSourceBytes: mermaidRuntimePreservesSourceBytes(
          getMermaidFamilyRuntime(
            beforeVisualModel?.diagramType ?? "flowchart",
          ),
          beforeVisualModel?.diagramType ?? "flowchart",
        ),
        ...options,
      },
      readonly: this.store.readonly,
    });
    if (!transaction) return false;
    const applied = run();
    const commit = commitMermaidRuntimeTransaction({
      applied,
      currentSource: getMermaidBlockSource(this.model.props),
      currentVisualModel: getMermaidSourceAuthoritativeVisualModel(
        this.std,
        this.model,
      ),
      owner: this.model,
      transaction,
    });
    if (!commit) return false;
    recordMermaidSelectionHistory(
      this.store,
      this.model.id,
      options.selectionHistory,
    );
    // The command already committed Source and its owner projection as
    // one mutation. Surface observers may have queued their fallback readback
    // while that transaction was running; accepting the resulting key without
    // cancelling that timer would create a second visual-history step for the
    // same user action.
    this._pauseProjectionOwnerSourceSync();
    this._acceptProjectionOwnerSourceSyncKey();
    this._remapVisualSelection();
    if (!commit.deferUpdate) {
      // Source-backed semantic mutations need a render pass. Projection-only
      // GFX mutations already updated the projection owner atomically; rendering
      // unchanged Source here would overwrite that projected geometry.
      if (commit.after !== commit.before) this._scheduleRender();
      this.requestUpdate();
    }
    return true;
  }

  protected _handleAddVisualSubgraph = () => {
    if (this.store.readonly) return;
    const visualModel = this._getMermaidVisualModelForEditing();
    if (!visualModel) return;
    const action = getMermaidFamilyRuntime(visualModel.diagramType)
      ?.pageSelectionTools?.containerAction;
    if (this._pageSelectionEnabled && action) {
      const validation = validateMermaidPageSelectionContainerAction(
        action,
        this._visualSelection.items,
        visualModel,
      );
      if (!validation.valid) return;
    }
    if (this._containerActionIntent?.()) {
      this._handlePageSelectionToolChange("pointer");
      this.requestUpdate();
      return;
    }
    let subgraphId = "";
    const applied = this._applyGfxMutation(() => {
      const [ok, result] = this.std.command.exec(addMermaidGfxSubgraphCommand, {
        model: this.model,
        selectedNodeIds: this._visualSelectionKeys("node"),
      });
      subgraphId = result?.subgraphId ?? "";
      return ok;
    });
    if (!applied) return;
    if (subgraphId) {
      this._queueVisualSelectionForProjection([
        { editKey: subgraphId, kind: "subgraph" },
      ]);
    } else {
      this._clearVisualSelection();
    }
  };

  protected _handleVisualShapeButton(shape: MermaidVisualNodeShape) {
    if (this.store.readonly) return;
    const visualModel = this._getMermaidVisualModelForEditing();
    if (!visualModel) return;

    const selectedNodeId = this._visualSelectionAnchorKey("node");
    if (!selectedNodeId) {
      this._handlePageSelectionToolChange("pointer");
      this._applyVisualSelectionPatch(
        toggleMermaidGfxPendingNodeInsertPatch({
          currentShape: this._pendingVisualInsertShape,
          shape,
        }),
      );
      this.requestUpdate();
      return;
    }

    const nodeId = selectedNodeId;
    const applied = this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidGfxNodeCommand, {
          model: this.model,
          nodeId,
          shape,
        })[0],
    );
    if (!applied) return;
    this._pendingVisualInsertShape = null;
    this._visualContextMenu = null;
    this._selectVisualNode(nodeId);
  }

  protected _handleAddVisualNode = (shape: MermaidVisualNodeShape = "rect") => {
    if (this.store.readonly) return;
    this._handlePageSelectionToolChange("pointer");
    this._clearVisualSelection();
    this._pendingVisualInsertShape = shape;
    this.requestUpdate();
  };

  protected _handleToggleVisualConnection = () => {
    if (this._gfxSession.isConnectingVisualNodes) {
      this._gfxSession.stopVisualNodeConnection();
      return;
    }
    if (this._gfxSession.startVisualNodeConnection()) {
      this._gfxViewportInteraction.clearPointerSelectionMemory();
    }
  };

  protected _handleVisualNodeStyleClass = (event: Event) => {
    this._setVisualNodeStyleClass((event.target as HTMLSelectElement).value);
  };

  protected _setVisualNodeStyleClass(value: string) {
    const edit = resolveMermaidGfxNodeStyleClassEdit({
      nodeId: this._visualSelectionAnchorKey("node"),
      value,
    });
    if (!edit) return;
    this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidGfxNodeCommand, {
          model: this.model,
          nodeId: edit.nodeId,
          styleClass: edit.styleClass,
        })[0],
    );
  }

  protected _handleVisualEdgeStyle = (event: Event) => {
    this._setVisualEdgeStyle((event.target as HTMLSelectElement).value);
  };

  protected _setVisualEdgeStyle(value: string) {
    const edit = resolveMermaidGfxEdgeStyleEdit({
      edgeId: this._visualSelectionAnchorKey("edge"),
      value,
    });
    if (!edit) return;
    this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidGfxEdgeCommand, {
          edgeId: edit.edgeId,
          model: this.model,
          style: edit.style,
        })[0],
    );
  }

  protected _handleVisualEdgeLinkType = (event: Event) => {
    this._setVisualEdgeLinkType((event.target as HTMLSelectElement).value);
  };

  protected _setVisualEdgeLinkType(value: string) {
    const edit = resolveMermaidGfxEdgeLinkTypeEdit({
      edgeId: this._visualSelectionAnchorKey("edge"),
      value,
    });
    if (!edit) return;
    this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidGfxEdgeCommand, {
          edgeId: edit.edgeId,
          linkType: edit.linkType,
          model: this.model,
        })[0],
    );
  }
}
