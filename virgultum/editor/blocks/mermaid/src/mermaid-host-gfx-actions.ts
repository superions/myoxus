import { getMermaidGfxFamilyHooks } from "./families/runtime/gfx-family-hooks-registry.js";
import { typeOwnedMermaidGeometrySelection } from "./families/runtime/gfx-owner-hooks.js";
import { html } from "lit";

import { applyMermaidVisualModelCommand } from "./commands.js";

import { deleteMermaidGfxSelectionCommand } from "./families/runtime/gfx-commands.js";
import { duplicateTypeOwnedMermaidGfxSelection } from "./families/runtime/gfx-graph-operations.js";
import { parseMermaidSourceToGfxVisualModel } from "./families/runtime/gfx-host-contract.js";
import type { MermaidShellNoticeReactHostProps } from "./families/runtime/shell-contract.js";
import { mermaidMessages } from "./i18n.js";
import { accumulateMermaidGfxNodeDrag } from "./mermaid-gfx-drag.js";

import { getMermaidBlockSource } from "./utils.js";

import { MermaidHostFamilyFields } from "./mermaid-host-family-fields.js";

export abstract class MermaidHostGfxActions extends MermaidHostFamilyFields {
  protected _duplicateSelectedVisualNodes(
    offset: Readonly<{ x: number; y: number }> = { x: 24, y: 24 },
  ) {
    if (this.store.readonly) return false;
    const nodeIds = this._visualSelectionKeys("node");
    const visualModel = this._getMermaidVisualModelForEditing();
    if (!visualModel || nodeIds.length === 0) return false;
    const intent = getMermaidGfxFamilyHooks(visualModel)?.nodeKeyboardIntent?.(
      visualModel,
      nodeIds[0],
      "Duplicate",
    );
    if (intent && this._consumeVisualObjectIntent(intent)) return true;
    const duplicated = duplicateTypeOwnedMermaidGfxSelection(
      visualModel,
      nodeIds,
      offset,
    );
    if (!duplicated) return false;
    const applied = this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidVisualModelCommand, {
          model: this.model,
          visualModel: duplicated.visualModel,
        })[1]?.applied === true,
      {},
      visualModel,
    );
    if (!applied) return false;
    this._queueVisualSelectionForProjection(
      duplicated.nodeIds.map((editKey) => ({ editKey, kind: "node" })),
    );
    return true;
  }

  protected _handleDeleteVisualSelection = () => {
    const nodeIds = this._visualSelectionKeys("node");
    const edgeIds = this._visualSelectionKeys("edge");
    const subgraphIds = this._visualSelectionKeys("subgraph");
    const visualModel = this._getMermaidVisualModelForEditing();
    const item = this._visualSelection.items.at(-1);
    if (
      item &&
      this._consumeVisualObjectIntent({
        action: "delete",
        kind:
          item.kind === "subgraph"
            ? "subgraph"
            : item.kind === "edge"
              ? "edge"
              : "node",
        id: item.editKey,
      })
    )
      return;
    const selectedNodeIds = new Set(nodeIds);
    const sourceNodeIds = visualModel?.nodes.map((node) => node.id) ?? [];
    const selectedIndexes = sourceNodeIds.flatMap((nodeId, index) =>
      selectedNodeIds.has(nodeId) ? [index] : [],
    );
    const lastSelectedIndex = Math.max(-1, ...selectedIndexes);
    const firstSelectedIndex = Math.min(
      sourceNodeIds.length,
      ...selectedIndexes,
    );
    const nextNodeId = nodeIds.length
      ? (sourceNodeIds
          .slice(lastSelectedIndex + 1)
          .find((nodeId) => !selectedNodeIds.has(nodeId)) ??
        sourceNodeIds
          .slice(0, firstSelectedIndex)
          .reverse()
          .find((nodeId) => !selectedNodeIds.has(nodeId)) ??
        "")
      : "";
    const applied = this._applyGfxMutation(
      () =>
        this.std.command.exec(deleteMermaidGfxSelectionCommand, {
          edgeId: edgeIds.at(-1),
          edgeIds,
          model: this.model,
          nodeId: nodeIds.at(-1) || undefined,
          nodeIds,
          subgraphId: subgraphIds.at(-1),
          subgraphIds,
        })[0],
    );
    if (!applied) return;
    if (nextNodeId) this._selectVisualNode(nextNodeId);
    requestAnimationFrame(() => {
      const focusTarget = nextNodeId
        ? [
            ...this.renderRoot.querySelectorAll<HTMLElement>(
              '.myoxus-mermaid-gfx-object-focus-proxy[data-object-kind="node"]',
            ),
          ].find((element) => element.dataset.mermaidEditKey === nextNodeId)
        : null;
      const viewport = this._gfxViewportBridge.getViewportElement();
      const resolvedFocusTarget =
        focusTarget ?? (viewport instanceof HTMLElement ? viewport : null);
      resolvedFocusTarget?.focus({ preventScroll: true });
    });
  };

  protected _handleResetVisualLayout = () => {
    if (this.store.readonly) return;
    const parsed = parseMermaidSourceToGfxVisualModel(
      getMermaidBlockSource(this.model.props),
    );
    if (!parsed.model) return;
    const applied = this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidVisualModelCommand, {
          model: this.model,
          visualModel: parsed.model,
        })[1]?.applied === true,
    );
    if (!applied) return;
  };

  protected _moveSelectedVisualNode(dx: number, dy: number) {
    const nodeIds = this._visualSelectionKeys("node");
    const visualModel = this._getMermaidVisualModelForEditing();
    if (!visualModel || nodeIds.length === 0) return;
    const moved = typeOwnedMermaidGeometrySelection(
      visualModel,
      nodeIds,
    ).reduce(
      (model, nodeId) => accumulateMermaidGfxNodeDrag(model, nodeId, dx, dy),
      visualModel,
    );
    this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidVisualModelCommand, {
          model: this.model,
          visualModel: moved,
        })[1]?.applied === true,
      { coalesceKey: `visual-node-keyboard-move:${nodeIds.join("\u0000")}` },
      visualModel,
    );
  }

  protected _renderPreview() {
    if (this._renderState === "finish") {
      return html`<div .innerHTML=${this._svg}></div>`;
    }
    if (this._renderState === "error") {
      return this._lastValidSvg
        ? html`<div
            class="myoxus-mermaid-last-valid-preview"
            aria-label=${mermaidMessages.lastValidPreviewLabel()}
            .innerHTML=${this._lastValidSvg}
          ></div>`
        : null;
    }
    return null;
  }

  protected _getPreviewNotice(): MermaidShellNoticeReactHostProps | undefined {
    if (this._renderState === "loading") {
      return {
        message: mermaidMessages.loading(),
        title: mermaidMessages.loading(),
        tone: "warning",
      };
    }
    if (this._renderState === "error") {
      const guidance = this._renderErrorLine
        ? mermaidMessages.errorLine({ line: this._renderErrorLine })
        : mermaidMessages.errorCopy();
      return {
        message: [
          guidance,
          this._renderErrorMessage,
          this._lastValidSvg ? mermaidMessages.lastValidPreviewLabel() : null,
        ]
          .filter(Boolean)
          .join(" "),
        title: mermaidMessages.errorTitle(),
        tone: "error",
      };
    }
    if (
      this._renderState === "empty" ||
      (this._renderState === "finish" && !this._svg)
    ) {
      return {
        message: mermaidMessages.previewEmpty(),
        title: mermaidMessages.previewEmpty(),
        tone: "warning",
      };
    }
    return undefined;
  }

  protected _handleProjectionOwnerSelection = (elementIds: string[]) => {
    const selectionKey = elementIds.join(",");
    // In Page mode native SurfaceSelection is only the transport projection
    // of the semantic controller. Toolbar focus and tool replacement may emit
    // a transient empty native selection; accepting that echo would erase the
    // real selection before the next Page gesture starts. Explicit Page clears
    // already update the semantic owner first and record the empty key.
    if (
      this._pageSelectionEnabled &&
      elementIds.length === 0 &&
      this._visualSelection.items.length > 0 &&
      this._lastProjectionOwnerSelectionKey !== selectionKey
    ) {
      return;
    }
    // Structural create already uses the normal pending-selection contract.
    // Consume its title-edit intent only when the replacement scoped GFX owner
    // has echoed that exact group as its native selection; this is the first
    // stable point at which the existing inline editor can remain mounted.
    const pending = this._pendingVisualSelectionProjection;
    const createdSubgraph =
      pending?.items.length === 1 && pending.items[0]?.kind === "subgraph"
        ? pending.items[0]
        : null;
    // Semantic selection records the projected key before GFX emits its
    // synchronous echo. That normally prevents a redundant hydration, but a
    // newly created group deliberately keeps its pending edit intent until
    // this echo confirms that the replacement scoped owner is mounted.
    if (
      selectionKey === this._lastProjectionOwnerSelectionKey &&
      !createdSubgraph
    ) {
      return;
    }
    this._lastProjectionOwnerSelectionKey = selectionKey;
    this._hydrateVisualSelectionFromGfxIds(elementIds, !createdSubgraph);
    if (
      createdSubgraph &&
      this._visualSelectionAnchorKey("subgraph") === createdSubgraph.editKey
    ) {
      this._pendingVisualSelectionProjection = null;
      this._startInlineSubgraphTextEdit(null, createdSubgraph.editKey);
    } else if (createdSubgraph) {
      this.requestUpdate();
    }
  };
}
