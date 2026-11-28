/**
 * Structure tree — public re-exports for workspace folder hierarchy surfaces.
 *
 * - **`StructureTreeRoot`** — initializes the tree context and renders nodes.
 * - **`StructureTreeContext`** — React context carrying shared tree state.
 * - **`StructureTreeOrganizeTree`** — folder-based workspace hierarchy.
 * - **Types** — `BaseStructureTreeNodeProps`, `StructureTreeNodeIcon`,
 *   `NodeOperation` for custom tree nodes.
 */
export { StructureTreeOrganizeTree } from "./sections/organize";
export { StructureTreeRoot } from "./tree";
export { StructureTreeContext } from "./tree/context";
export type {
  BaseStructureTreeNodeProps,
  StructureTreeNodeIcon,
} from "./tree/node";
export type { NodeOperation } from "./tree/types";
