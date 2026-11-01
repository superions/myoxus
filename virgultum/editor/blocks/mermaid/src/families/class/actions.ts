// SPDX-License-Identifier: AGPL-3.0-or-later
import * as engine from "../../engine/class/index.js";
import type { MermaidPageSelectionToolsContribution } from "../runtime/contracts.js";
import { classNodeGfxData, classProjectionBinding } from "./gfx-data.js";
import { mermaidMessages } from "../../i18n.js";
/** One semantic command catalog serves Page, embedded controls and native roots. */
export const CLASS_COMMANDS = {
  addClass: engine.addClass,
  addClassAnnotation: engine.addClassAnnotation,
  editClassAnnotation: engine.editClassAnnotation,
  editClass: engine.editClass,
  renameClassId: engine.renameClassId,
  deleteClasses: engine.deleteClasses,
  deleteClassSelection: engine.deleteClassSelection,
  addClassMember: engine.addClassMember,
  editClassMember: engine.editClassMember,
  duplicateClassMember: engine.duplicateClassMember,
  deleteClassMember: engine.deleteClassMember,
  reorderClassMember: engine.reorderClassMember,
  connectClasses: engine.connectClasses,
  editClassRelation: engine.editClassRelation,
  deleteClassRelation: engine.deleteClassRelation,
  addClassNamespace: engine.addClassNamespace,
  editClassNamespace: engine.editClassNamespace,
  moveClassNamespace: engine.moveClassNamespace,
  deleteClassNamespace: engine.deleteClassNamespace,
  groupClasses: engine.groupClasses,
  setClassNamespace: engine.setClassNamespace,
  addClassNote: engine.addClassNote,
  editClassNote: engine.editClassNote,
  deleteClassNote: engine.deleteClassNote,
  editClassAppearance: engine.editClassAppearance,
  editClassAccessibility: engine.editClassAccessibility,
  editClassDiagramTitle: engine.editClassDiagramTitle,
  editClassLink: engine.editClassLink,
  editClassOpaqueConfig: engine.editClassOpaqueConfig,
  editClassStyleAssignment: engine.editClassStyleAssignment,
  editClassOpaquePayload: engine.editClassOpaquePayload,
  addClassStyle: engine.addClassStyle,
  setClassStyleProperty: engine.setClassStyleProperty,
  renameClassStyleDefinition: engine.renameClassStyleDefinition,
  deleteClassStyle: engine.deleteClassStyle,
  addClassComment: engine.addClassComment,
  editClassComment: engine.editClassComment,
  deleteClassComment: engine.deleteClassComment,
  reorderClassComment: engine.reorderClassComment,
};
export type ClassCommandName = keyof typeof CLASS_COMMANDS;
export type ClassCommandArgs<K extends ClassCommandName> =
  Parameters<(typeof CLASS_COMMANDS)[K]> extends [
    engine.MermaidClassModel,
    ...infer Args,
  ]
    ? Args
    : never;
export function runClassCommand<K extends ClassCommandName>(
  model: engine.MermaidClassModel,
  name: K,
  args: ClassCommandArgs<K>,
) {
  const command = CLASS_COMMANDS[name] as unknown as (
    model: engine.MermaidClassModel,
    ...args: ClassCommandArgs<K>
  ) => engine.ClassCommandResult;
  return command(model, ...args);
}
export const classPageSelectionTools: MermaidPageSelectionToolsContribution = {
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
    id: "class.group",
    label: () => mermaidMessages.classGroup(),
    minimumSelectionCount: 2,
    eligibleKinds: ["node"],
    validationMessage: () => mermaidMessages.classGroupSelection(),
    validate: ({ items, visualModel }) => {
      if (
        items.length < 2 ||
        items.some(
          (item) =>
            item.kind !== "node" ||
            classNodeGfxData(
              visualModel.nodes.find((n) => n.id === item.editKey) ?? {},
            )?.kind !== "class",
        )
      )
        return { valid: false, code: "class.group" };
      return new Set(
        items.map(
          (item) =>
            classProjectionBinding(
              visualModel.nodes.find((n) => n.id === item.editKey) ?? {},
            )?.namespaceId ?? null,
        ),
      ).size === 1
        ? { valid: true }
        : { valid: false, code: "class.group" };
    },
  },
};
export const CLASS_PARENT_ACTIONS = [
  "addClass",
  "connect",
  "group",
  "addNote",
  "comments",
  "appearance",
  "accessibility",
  "data",
  "emptyNamespace",
  "deleteSelection",
] as const;
export type ClassParentAction = (typeof CLASS_PARENT_ACTIONS)[number];

export const CLASS_PARENT_ACTION_LABELS: Record<
  ClassParentAction,
  () => string
> = {
  addClass: mermaidMessages.classAddClass,
  connect: mermaidMessages.visualConnect,
  group: mermaidMessages.classGroup,
  addNote: mermaidMessages.classAddNote,
  comments: mermaidMessages.visualComments,
  appearance: mermaidMessages.visualAppearance,
  accessibility: mermaidMessages.visualAccessibility,
  data: mermaidMessages.pieData,
  emptyNamespace: mermaidMessages.classEmptyNamespace,
  deleteSelection: mermaidMessages.visualDelete,
};
