export {
  convertMermaidCodeBlockCommand,
  deleteMermaidBlockCommand,
  duplicateMermaidBlockCommand,
  insertMermaidBlockCommand,
  insertMermaidEdgelessDiagramCommand,
  type DeletedMermaidDiagram,
  type DuplicatedMermaidDiagram,
  type InsertedMermaidDiagram,
  type InsertMermaidBlockOptions,
  type InsertMermaidEdgelessDiagramOptions,
} from "./commands/block-lifecycle.js";
export { ensureMermaidProjectionOwnerCommand } from "./commands/owner-projection.js";
export {
  addMermaidProjectionOwnerChild,
  assignGfxProps,
  createMermaidBlockInsertProps,
  createMermaidElementIndexMaps,
  getMermaidProjectionOwnerChildrenByRole,
  getMermaidProjectionOwnerChildrenByType,
  getMermaidGfxConnector,
  getMermaidGfxElementIdMap,
  getMermaidGfxNode,
  getMermaidGfxSubgraph,
  getMermaidSourceAuthoritativeVisualModel,
  getMermaidVisualElementOriginBound,
  getMermaidVisualElementOriginFromAnchor,
  getMermaidVisualFrameGeometry,
  getMermaidVisualModelForEditing,
  getMermaidVisualModelFromProjectionOwner,
  materializeMermaidVisualModelWithStd,
  readMermaidVisualModelFromProjectionGroup,
  reconcileMermaidProjectionOwnerWithVisualModel,
  resolveMermaidProjectionGroup,
  resizeMermaidProjectionOwnerToVisualModel,
  updateMermaidElementsInPlaceIfCompatible,
  visualNodeWithDiagramDetails,
  type MermaidCompoundCommandOptions,
} from "./commands/materialization.js";
export { resolveMermaidBlockInsertIdentity } from "./mermaid-insert-identity.js";
export {
  applyMermaidVisualModelCommand,
  finishMermaidGfxMutation,
  getMermaidVisualModel,
  syncMermaidVisualModelFromProjectionOwnerCommand,
  type MermaidGfxMutationResult,
} from "./commands/source-sync.js";

export { setMermaidVisualEdgeC4Relationship } from "./families/c4/object-data.js";
export { setMermaidVisualEdgeRequirementRelationKind } from "./families/requirement/gfx-data.js";
export {
  addMermaidVisualNode,
  addMermaidVisualSubgraph,
  connectMermaidVisualNodes,
  deleteMermaidVisualSelection,
  moveMermaidVisualNode,
  reconnectMermaidVisualEdge,
  renameMermaidVisualEdge,
  renameMermaidVisualNode,
  renameMermaidVisualSubgraph,
  resizeMermaidVisualNode,
  resizeMermaidVisualSubgraph,
  setMermaidVisualNodeShape,
  setMermaidVisualSubgraphDirection,
} from "./mermaid-visual-model-operations.js";
export {
  setMermaidVisualEdgeLinkType,
  setMermaidVisualEdgeStyle,
  setMermaidVisualEdgeStyleStatement,
  setMermaidVisualNodeStyleClass,
} from "./families/flowchart/model-operations.js";
