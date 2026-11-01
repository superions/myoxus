// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import type { MermaidRuntimeTransactionOptions } from "../runtime/transaction.js";
import type { MermaidArchitectureGfxControl } from "./control-contract.js";

export type MermaidArchitectureMutationControl =
  MermaidArchitectureGfxControl | "nodeLabel" | "subgraphTitle";

export type ArchitectureFieldMutation =
  | {
      readonly target: "edge";
      readonly patch: Partial<MermaidVisualEdge>;
      readonly options?: MermaidRuntimeTransactionOptions;
    }
  | {
      readonly target: "node";
      readonly patch: Partial<MermaidVisualNode>;
      readonly options?: MermaidRuntimeTransactionOptions;
    }
  | {
      readonly target: "subgraph";
      readonly patch: Partial<MermaidVisualSubgraph>;
      readonly options?: MermaidRuntimeTransactionOptions;
    }
  | {
      readonly target: "visualModel";
      readonly visualModel: MermaidVisualModel;
      readonly options?: MermaidRuntimeTransactionOptions;
    };

export interface ArchitectureMutationContext {
  readonly control: MermaidArchitectureMutationControl;
  readonly edge: MermaidVisualEdge | undefined;
  readonly node: MermaidVisualNode | undefined;
  readonly subgraph: MermaidVisualSubgraph | undefined;
  readonly subgraphId: string | undefined;
  readonly value: string;
  readonly visualModel: MermaidVisualModel;
}

export function architectureNodeMutationOptions(
  nodeId: string | undefined,
  field: string,
) {
  return nodeId ? { coalesceKey: `node:${nodeId}:${field}` } : undefined;
}
