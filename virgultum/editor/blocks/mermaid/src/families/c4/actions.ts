// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  deleteC4Selection,
  groupC4Elements,
  changeC4Header,
  deleteC4,
  editC4AccessibilityRecord,
  createC4AccessibilityRecord,
  editC4PreambleRecord,
  editC4Comment,
  removeC4Comment,
  editC4Configuration,
  editC4LayoutRows,
  createC4Element,
  editC4ElementLabel,
  editC4ElementRecordLabel,
  renameC4Alias,
  editC4ElementFields,
  editC4ElementArgument,
  editC4BoundaryArgument,
  createC4Boundary,
  editC4BoundaryFields,
  moveC4SourceRecord,
  createC4Relationship,
  reconnectC4Relationship,
  changeC4RelationshipNotation,
  editC4RelationshipFields,
  editC4RelationshipArgument,
  reorderC4DynamicPair,
  editC4ElementAppearance,
  editC4ElementStyleArgument,
  removeC4ElementStyleRecord,
  editC4RelationshipAppearance,
  editC4RelationshipStyleArgument,
  removeC4RelationshipStyleRecord,
  reconnectC4Record,
  type MermaidC4Model,
  type C4CommandResult,
} from "../../engine/c4/index.js";

/** One typed semantic catalog serves Page, Embedded and native Root controls. */
export const C4_COMMANDS = {
  deleteC4Selection,
  groupC4Elements,
  changeC4Header,
  deleteC4,
  editC4AccessibilityRecord,
  createC4AccessibilityRecord,
  editC4PreambleRecord,
  editC4Comment,
  removeC4Comment,
  editC4Configuration,
  editC4LayoutRows,
  createC4Element,
  editC4ElementLabel,
  editC4ElementRecordLabel,
  renameC4Alias,
  editC4ElementFields,
  editC4ElementArgument,
  editC4BoundaryArgument,
  createC4Boundary,
  editC4BoundaryFields,
  moveC4SourceRecord,
  createC4Relationship,
  reconnectC4Relationship,
  changeC4RelationshipNotation,
  editC4RelationshipFields,
  editC4RelationshipArgument,
  reorderC4DynamicPair,
  editC4ElementAppearance,
  editC4ElementStyleArgument,
  removeC4ElementStyleRecord,
  editC4RelationshipAppearance,
  editC4RelationshipStyleArgument,
  removeC4RelationshipStyleRecord,
  reconnectC4Record,
};
export type C4CommandName = keyof typeof C4_COMMANDS;
export type C4CommandArgs<K extends C4CommandName> =
  Parameters<(typeof C4_COMMANDS)[K]> extends [MermaidC4Model, ...infer Args]
    ? Args
    : never;
export function runC4Command<K extends C4CommandName>(
  model: MermaidC4Model,
  name: K,
  args: C4CommandArgs<K>,
) {
  const command = C4_COMMANDS[name] as unknown as (
    model: MermaidC4Model,
    ...args: C4CommandArgs<K>
  ) => C4CommandResult;
  return command(model, ...args);
}
