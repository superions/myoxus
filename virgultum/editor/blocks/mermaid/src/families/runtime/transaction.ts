import type { MermaidSelectionHistory } from "../../mermaid-selection-history.js";
import { usesTypeOwnedMermaidDocumentHistory } from "./gfx-owner-hooks.js";
import { pushMermaidVisualHistoryForOwner } from "../../mermaid-visual-source-history.js";
import { cloneMermaidVisualModel } from "../../mermaid-visual-model-operations.js";
import { hashMermaidSource, normalizeMermaidSourceInput } from "../../utils.js";
import type { MermaidVisualModel } from "./gfx-model.js";

export type MermaidRuntimeTransactionOptions = {
  readonly selectionHistory?: MermaidSelectionHistory;
  /** A checked minimal patch committed with its GFX projection in this transaction. */
  readonly sourceWrite?: {
    readonly baseSource: string;
    readonly source: string;
  };
  readonly coalesceKey?: string;
  readonly deferUpdate?: boolean;
  readonly preserveSourceBytes?: boolean;
};

export type MermaidRuntimeTransaction = {
  readonly before: string;
  readonly beforeVisualModel?: MermaidVisualModel | null;
  readonly options: MermaidRuntimeTransactionOptions;
};

export function beginMermaidRuntimeTransaction({
  currentSource,
  currentVisualModel,
  readonly,
  options = {},
}: {
  readonly currentSource: string;
  readonly currentVisualModel?: MermaidVisualModel | null;
  readonly readonly: boolean;
  readonly options?: MermaidRuntimeTransactionOptions;
}): MermaidRuntimeTransaction | null {
  if (readonly) return null;
  return {
    before: options.preserveSourceBytes
      ? currentSource
      : normalizeMermaidSourceInput(currentSource),
    beforeVisualModel: currentVisualModel
      ? cloneMermaidVisualModel(currentVisualModel)
      : null,
    options,
  };
}

export function commitMermaidRuntimeTransaction({
  applied,
  currentSource,
  currentVisualModel,
  owner,
  transaction,
}: {
  readonly applied: boolean;
  readonly currentSource: string;
  readonly currentVisualModel?: MermaidVisualModel | null;
  readonly owner: object;
  readonly transaction: MermaidRuntimeTransaction;
}) {
  if (!applied) return null;
  const after = transaction.options.preserveSourceBytes
    ? currentSource
    : normalizeMermaidSourceInput(currentSource);
  const historyAdded = Boolean(
    transaction.beforeVisualModel &&
    currentVisualModel &&
    !usesTypeOwnedMermaidDocumentHistory(currentVisualModel.diagramType) &&
    pushMermaidVisualHistoryForOwner({
      after: currentVisualModel,
      before: transaction.beforeVisualModel,
      coalesceKey: transaction.options.coalesceKey,
      owner,
      undoSourceHash: hashMermaidSource(after),
    }),
  );
  return {
    after,
    before: transaction.before,
    deferUpdate: Boolean(transaction.options.deferUpdate),
    historyAdded,
  };
}
