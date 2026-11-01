// SPDX-License-Identifier: AGPL-3.0-or-later
import * as engine from "../../engine/er/index.js";
import type { MermaidPageSelectionToolsContribution } from "../runtime/contracts.js";
import { erProjectionBinding } from "./gfx-data.js";
import { mermaidMessages as m } from "../../i18n.js";
export const ER_COMMANDS = {
  addErEntity: engine.addErEntity,
  editErEntity: engine.editErEntity,
  deleteErSelection: engine.deleteErSelection,
  addErAttribute: engine.addErAttribute,
  editErAttribute: engine.editErAttribute,
  duplicateErAttribute: engine.duplicateErAttribute,
  deleteErAttribute: engine.deleteErAttribute,
  reorderErAttribute: engine.reorderErAttribute,
  addErRelationship: engine.addErRelationship,
  editErRelationship: engine.editErRelationship,
  reverseErRelationship: engine.reverseErRelationship,
  deleteErRelationship: engine.deleteErRelationship,
  addErSubgraph: engine.addErSubgraph,
  editErSubgraph: engine.editErSubgraph,
  reparentErSubgraph: engine.reparentErSubgraph,
  reparentErEntity: engine.reparentErEntity,
  groupErEntities: engine.groupErEntities,
  deleteErSubgraph: engine.deleteErSubgraph,
  editErAppearance: engine.editErAppearance,
  editErAccessibility: engine.editErAccessibility,
  editErDiagramTitle: engine.editErDiagramTitle,
  editErOpaqueConfig: engine.editErOpaqueConfig,
  editErStyleAssignment: engine.editErStyleAssignment,
  addErStyle: engine.addErStyle,
  setErStyleProperty: engine.setErStyleProperty,
  renameErStyleDefinition: engine.renameErStyleDefinition,
  deleteErStyle: engine.deleteErStyle,
  addErComment: engine.addErComment,
  editErComment: engine.editErComment,
  reanchorErComment: engine.reanchorErComment,
  deleteErComment: engine.deleteErComment,
  reorderErComment: engine.reorderErComment,
};
export type ErCommandName = keyof typeof ER_COMMANDS;
export type ErCommandArgs<K extends ErCommandName> =
  Parameters<(typeof ER_COMMANDS)[K]> extends [
    engine.MermaidErModel,
    ...infer Args,
  ]
    ? Args
    : never;
export function runErCommand<K extends ErCommandName>(
  model: engine.MermaidErModel,
  name: K,
  args: ErCommandArgs<K>,
) {
  return (
    ER_COMMANDS[name] as unknown as (
      model: engine.MermaidErModel,
      ...args: ErCommandArgs<K>
    ) => engine.ErCommandResult
  )(model, ...args);
}
export const erPageSelectionTools: MermaidPageSelectionToolsContribution = {
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
    ...model.edges.map((e) => ({ editKey: e.id, kind: "edge" as const })),
    ...(model.subgraphs ?? []).map((g) => ({
      editKey: g.id,
      kind: "subgraph" as const,
    })),
  ],
  containerAction: {
    id: "er.group",
    label: m.erGroup,
    minimumSelectionCount: 2,
    eligibleKinds: ["node"],
    validationMessage: m.erInvalidMembership,
    validate: ({ items, visualModel }) => {
      const nodes = items.map((item) =>
          item.kind === "node"
            ? visualModel.nodes.find((n) => n.id === item.editKey)
            : undefined,
        ),
        bindings = nodes.map((n) => n && erProjectionBinding(n));
      return items.length >= 2 &&
        bindings.every(Boolean) &&
        new Set(bindings.map((b) => b?.subgraphId)).size === 1
        ? { valid: true }
        : { valid: false, code: "er.group" };
    },
  },
};
export const ER_PARENT_ACTIONS = [
  "addEntity",
  "emptySubgraph",
  "connect",
  "attribute",
  "group",
  "comments",
  "appearance",
  "accessibility",
  "data",
  "deleteSelection",
] as const;
export type ErParentAction = (typeof ER_PARENT_ACTIONS)[number];
export const ER_PARENT_ACTION_LABELS: Record<ErParentAction, () => string> = {
  addEntity: m.erEntity,
  emptySubgraph: m.erEmptySubgraph,
  connect: m.erRelationship,
  attribute: m.erAddAttribute,
  group: m.erGroup,
  comments: m.visualComments,
  appearance: m.visualAppearance,
  accessibility: m.visualAccessibility,
  data: m.pieData,
  deleteSelection: m.visualDelete,
};
