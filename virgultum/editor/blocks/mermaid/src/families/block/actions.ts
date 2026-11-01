// SPDX-License-Identifier: AGPL-3.0-or-later
import * as e from "../../engine/block/index.js";
import { mermaidMessages as m } from "../../i18n.js";
import type { MermaidPageSelectionToolsContribution } from "../runtime/contracts.js";
import { blockProjectionBinding } from "./gfx-data.js";
export const BLOCK_COMMANDS = {
  addBlock: e.addBlock,
  updateBlock: e.updateBlock,
  deleteBlock: e.deleteBlock,
  deleteBlockSelection: e.deleteBlockSelection,
  updateBlockColumns: e.updateBlockColumns,
  reorderBlockItem: e.reorderBlockItem,
  addBlockComposite: e.addBlockComposite,
  deleteBlockComposite: e.deleteBlockComposite,
  addBlockSpace: e.addBlockSpace,
  updateBlockSpace: e.updateBlockSpace,
  deleteBlockSpace: e.deleteBlockSpace,
  addBlockConnection: e.addBlockConnection,
  updateBlockConnection: e.updateBlockConnection,
  deleteBlockConnection: e.deleteBlockConnection,
  editBlockComment: e.editBlockComment,
  editBlockMetadata: e.editBlockMetadata,
  setBlockPadding: e.setBlockPadding,
  editBlockDiagramTitle: e.editBlockDiagramTitle,
  editBlockOpaqueConfig: e.editBlockOpaqueConfig,
};
export type BlockCommandName = keyof typeof BLOCK_COMMANDS;
export type BlockCommandArgs<K extends BlockCommandName> =
  Parameters<(typeof BLOCK_COMMANDS)[K]> extends [
    e.MermaidBlockDiagramModel,
    ...infer Args,
  ]
    ? Args
    : never;
export function runBlockCommand<K extends BlockCommandName>(
  model: e.MermaidBlockDiagramModel,
  name: K,
  args: BlockCommandArgs<K>,
) {
  return (
    BLOCK_COMMANDS[name] as unknown as (
      m: e.MermaidBlockDiagramModel,
      ...a: BlockCommandArgs<K>
    ) => e.BlockCommandResult
  )(model, ...args);
}
export function blockGroupAllowed(
  model: e.MermaidBlockDiagramModel,
  keys: readonly string[],
) {
  const items = keys.map((k) =>
    e.blockItems(model).find((n) => n.sourceKey === k),
  );
  return (
    keys.length >= 2 &&
    new Set(keys).size === keys.length &&
    items.every((n) => n && !e.isBlockGroup(n)) &&
    new Set(items.map((n) => n?.parentKey)).size === 1
  );
}
export const blockPageSelectionTools: MermaidPageSelectionToolsContribution = {
  boxSelectableKinds: ["node"],
  selectableKinds: ["node", "edge", "subgraph"],
  selectAllKinds: ["node"],
  operations: {
    deleteSelection: true,
    duplicateSelection: false,
    moveSelection: true,
  },
  resolveItems: (model) => [
    ...model.nodes.map((n) => ({ editKey: n.id, kind: "node" as const })),
    ...model.edges.map((n) => ({ editKey: n.id, kind: "edge" as const })),
    ...(model.subgraphs ?? []).map((n) => ({
      editKey: n.id,
      kind: "subgraph" as const,
    })),
  ],
  containerAction: {
    id: "block.group",
    label: m.blockGroup,
    minimumSelectionCount: 2,
    eligibleKinds: ["node"],
    validationMessage: m.erInvalidMembership,
    validate: ({ items, visualModel }) => {
      const bindings = items.map((i) =>
        i.kind === "node"
          ? blockProjectionBinding(
              visualModel.nodes.find((n) => n.id === i.editKey) ?? {},
            )
          : undefined,
      );
      return items.length >= 2 &&
        bindings.every((b) => b && ["block", "space"].includes(b.role)) &&
        new Set(bindings.map((b) => b?.parentKey)).size === 1
        ? { valid: true }
        : { valid: false, code: "block.group" };
    },
  },
};
export const BLOCK_PARENT_ACTIONS = [
  "addBlock",
  "emptyComposite",
  "space",
  "connection",
  "grid",
  "group",
  "comments",
  "appearance",
  "accessibility",
  "data",
  "deleteSelection",
] as const;
export type BlockParentAction = (typeof BLOCK_PARENT_ACTIONS)[number];
export const BLOCK_PARENT_ACTION_LABELS: Record<
  BlockParentAction,
  () => string
> = {
  addBlock: m.blockNode,
  emptyComposite: m.blockEmptyComposite,
  space: m.blockSpace,
  connection: m.visualConnect,
  grid: m.blockColumns,
  group: m.blockGroup,
  comments: m.visualComments,
  appearance: m.visualAppearance,
  accessibility: m.visualAccessibility,
  data: m.pieData,
  deleteSelection: m.visualDelete,
};

/** Impact describes Source effects. Reset presentation only for the explicit
 * confirmed grid operations, including Space edits and grouping, not ordinary
 * insertion or deletion of a Block. */
export function blockCommandReflowScopes<K extends BlockCommandName>(
  name: K,
  args: BlockCommandArgs<K>,
  result: e.BlockCommandResult,
) {
  return name === "updateBlockColumns" ||
    name === "reorderBlockItem" ||
    name === "setBlockPadding" ||
    name === "updateBlockSpace" ||
    name === "addBlockSpace" ||
    name === "deleteBlockSpace" ||
    name === "deleteBlockComposite" ||
    (name === "addBlockComposite" &&
      Array.isArray((args[0] as { children?: unknown })?.children)) ||
    (name === "updateBlock" &&
      typeof args[1] === "object" &&
      args[1] !== null &&
      "span" in args[1])
    ? result.impact.grids
    : [];
}

export function blockShapeLabel(syntax: e.MermaidBlockNodeSyntax) {
  const labels: Partial<Record<e.MermaidBlockNodeSyntax, () => string>> = {
    rectangle: m.shapeRect,
    rounded: m.shapeRounded,
    stadium: m.shapeStadium,
    cylinder: m.shapeDatabase,
    circle: m.shapeCircle,
    doublecircle: m.shapeDoubleCircle,
    diamond: m.shapeDiamond,
    hexagon: m.shapeHexagon,
    subroutine: m.shapeSubroutine,
    asymmetric: m.shapeAsymmetric,
    "block-arrow": m.blockArrow,
  };
  if (labels[syntax]) return labels[syntax]!();
  const form = e.SHAPE_SYNTAX.find((s) => s.syntax === syntax);
  if (form)
    return `${syntax.startsWith("lean") ? m.shapeParallelogram() : m.shapeTrapezoid()} ${form.open}…${form.close}`;
  return syntax;
}
