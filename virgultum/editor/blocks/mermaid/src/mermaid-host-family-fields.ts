import { applyMermaidVisualModelCommand } from "./commands.js";
import {
  applyMermaidGfxEdgeCommand,
  applyMermaidGfxNodeCommand,
  applyMermaidGfxSubgraphCommand,
} from "./families/runtime/gfx-commands.js";
import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "./families/runtime/gfx-host-contract.js";
import type { MermaidRuntimeTransactionOptions } from "./families/runtime/transaction.js";
import {
  resolveTypeOwnedMermaidEdgeInlineRename,
  resolveTypeOwnedMermaidNodeInlineRename,
  resolveTypeOwnedMermaidSubgraphInlineRename,
} from "./families/runtime/gfx-inline-hooks.js";
import {
  resolveMermaidGfxEdgeStyleStatementEdit,
  resolveMermaidGfxSubgraphTitleEdit,
} from "./mermaid-gfx-edit.js";
import { MermaidHostGfxMutations } from "./mermaid-host-gfx-mutations.js";
import { getMermaidBlockSource } from "./utils.js";

export abstract class MermaidHostFamilyFields extends MermaidHostGfxMutations {
  protected _setVisualNodeLabel(value: string) {
    const nodeId = this._visualSelectionAnchorKey("node");
    if (!nodeId) return;
    const visualModel = this._getMermaidVisualModelForEditing();
    const typeOwned = visualModel
      ? resolveTypeOwnedMermaidNodeInlineRename(
          visualModel,
          nodeId,
          value,
          getMermaidBlockSource(this.model.props),
        )
      : { handled: false as const };
    this._applyGfxMutation(
      () =>
        typeOwned.handled && typeOwned.visualModel
          ? this.std.command.exec(applyMermaidVisualModelCommand, {
              model: this.model,
              visualModel: typeOwned.visualModel,
            })[1]?.applied === true
          : typeOwned.handled
            ? false
            : this.std.command.exec(applyMermaidGfxNodeCommand, {
                label: value,
                model: this.model,
                nodeId,
              })[0],
      { coalesceKey: `node:${nodeId}:label` },
    );
  }

  protected _setVisualEdgeLabel(value: string) {
    const edgeId = this._visualSelectionAnchorKey("edge");
    if (!edgeId) return;
    const visualModel = this._getMermaidVisualModelForEditing();
    const typeOwned = visualModel
      ? resolveTypeOwnedMermaidEdgeInlineRename(
          visualModel,
          edgeId,
          value,
          getMermaidBlockSource(this.model.props),
        )
      : { handled: false as const };
    this._applyGfxMutation(
      () =>
        typeOwned.handled && typeOwned.visualModel
          ? this.std.command.exec(applyMermaidVisualModelCommand, {
              model: this.model,
              visualModel: typeOwned.visualModel,
            })[1]?.applied === true
          : typeOwned.handled
            ? false
            : this.std.command.exec(applyMermaidGfxEdgeCommand, {
                edgeId,
                label: value,
                model: this.model,
              })[0],
      { coalesceKey: `edge:${edgeId}:label` },
    );
  }

  protected _setVisualEdgeStyleStatement(value: string) {
    const edit = resolveMermaidGfxEdgeStyleStatementEdit({
      edgeId: this._visualSelectionAnchorKey("edge"),
      value,
    });
    if (!edit) return;
    this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidGfxEdgeCommand, {
          edgeId: edit.edgeId,
          model: this.model,
          visualStyle: edit.visualStyle,
        })[0],
    );
  }

  protected _setVisualSubgraphTitle(value: string) {
    const edit = resolveMermaidGfxSubgraphTitleEdit({
      subgraphId: this._visualSelectionAnchorKey("subgraph"),
      value,
    });
    if (!edit) return;
    const visualModel = this._getMermaidVisualModelForEditing();
    const typeOwned = visualModel
      ? resolveTypeOwnedMermaidSubgraphInlineRename(
          visualModel,
          edit.subgraphId,
          edit.title,
          getMermaidBlockSource(this.model.props),
        )
      : { handled: false as const };
    this._applyGfxMutation(
      () =>
        typeOwned.handled && typeOwned.visualModel
          ? this.std.command.exec(applyMermaidVisualModelCommand, {
              model: this.model,
              visualModel: typeOwned.visualModel,
            })[1]?.applied === true
          : typeOwned.handled
            ? false
            : this.std.command.exec(applyMermaidGfxSubgraphCommand, {
                model: this.model,
                subgraphId: edit.subgraphId,
                title: edit.title,
              })[0],
      { coalesceKey: edit.coalesceKey },
    );
  }

  protected _setVisualSubgraphDirection(
    direction: MermaidVisualModel["direction"],
  ) {
    const subgraphId = this._visualSelectionAnchorKey("subgraph");
    if (!subgraphId) return;
    this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidGfxSubgraphCommand, {
          direction,
          model: this.model,
          subgraphId,
        })[0],
    );
  }

  protected _patchSelectedVisualNode(
    patch: Partial<MermaidVisualNode>,
    options?: MermaidRuntimeTransactionOptions,
  ) {
    const nodeId = this._visualSelectionAnchorKey("node");
    if (!nodeId) return;
    this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidGfxNodeCommand, {
          ...patch,
          model: this.model,
          nodeId,
        })[0],
      options,
    );
  }

  protected _patchSelectedVisualEdge(
    patch: Partial<MermaidVisualEdge>,
    options?: MermaidRuntimeTransactionOptions,
  ) {
    const edgeId = this._visualSelectionAnchorKey("edge");
    if (!edgeId) return;
    this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidGfxEdgeCommand, {
          ...patch,
          edgeId,
          model: this.model,
        })[0],
      options,
    );
    this.requestUpdate();
  }

  protected _patchSelectedVisualSubgraph(
    patch: Partial<MermaidVisualSubgraph>,
    options?: MermaidRuntimeTransactionOptions,
  ) {
    const subgraphId = this._visualSelectionAnchorKey("subgraph");
    if (!subgraphId) return;
    this._applyGfxMutation(
      () =>
        this.std.command.exec(applyMermaidGfxSubgraphCommand, {
          ...patch,
          model: this.model,
          subgraphId,
        })[0],
      options,
    );
  }

  protected _applyVisualModel(
    visualModel: MermaidVisualModel,
    options?: MermaidRuntimeTransactionOptions,
  ) {
    let diagnostic: string | undefined;
    const applied = this._applyGfxMutation(() => {
      const [, result] = this.std.command.exec(applyMermaidVisualModelCommand, {
        model: this.model,
        visualModel,
        sourceWrite: options?.sourceWrite,
      });
      diagnostic = result?.diagnostic;
      return result?.applied === true;
    }, options);
    return { applied, ...(diagnostic ? { diagnostic } : {}) };
  }
}
