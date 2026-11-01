/**
 * `StructureTreeContext` — React context used to propagate shared tree
 * state down the structure-tree component hierarchy.
 *
 * Carries the nesting `level`, inherited child operations and a registration
 * callback used by roots/nodes to hide empty placeholders once real children
 * are mounted. The root is level 0; each nested `StructureTreeNode`
 * increments it so child nodes can apply the correct indentation and visual
 * treatment without prop-drilling.
 */
import React from "react";

import type { NodeOperation } from "./types";

export interface StructureTreeContextData {
  /**
   * The level of the current tree node.
   */
  level: number;
  operations?: NodeOperation[];
  registerChild: () => () => void;
}

export const StructureTreeContext =
  React.createContext<StructureTreeContextData | null>(null);
