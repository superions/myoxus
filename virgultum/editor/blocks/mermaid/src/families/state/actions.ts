// SPDX-License-Identifier: AGPL-3.0-or-later
import * as engine from "../../engine/state/index.js";
import type { MermaidPageSelectionToolsContribution } from "../runtime/contracts.js";
import { mermaidVisualFamilyPayload } from "../runtime/gfx-family-data.js";
import { stateProjectionBinding } from "./gfx-data.js";
import { mermaidMessages as m } from "../../i18n.js";
export const STATE_COMMANDS = {
  addState: engine.addState,
  editState: engine.editState,
  renameStateId: engine.renameStateId,
  setStateHeading: engine.setStateHeading,
  deleteStateSelection: engine.deleteStateSelection,
  addStateDescription: engine.addStateDescription,
  insertStateDescription: engine.insertStateDescription,
  editStateDescription: engine.editStateDescription,
  reorderStateDescription: engine.reorderStateDescription,
  deleteStateDescription: engine.deleteStateDescription,
  addStateTransition: engine.addStateTransition,
  editStateTransition: engine.editStateTransition,
  moveStateTransition: engine.moveStateTransition,
  reorderStateTransition: engine.reorderStateTransition,
  deleteStateTransition: engine.deleteStateTransition,
  addStatePseudostate: engine.addStatePseudostate,
  convertStatePseudostate: engine.convertStatePseudostate,
  editStateNotation: engine.editStateNotation,
  addStateTerminal: engine.addStateTerminal,
  deleteStatePseudostate: engine.deleteStatePseudostate,
  addStateComposite: engine.addStateComposite,
  editStateComposite: engine.editStateComposite,
  reparentStateObject: engine.reparentStateObject,
  deleteStateComposite: engine.deleteStateComposite,
  addStateRegion: engine.addStateRegion,
  reorderStateRegion: engine.reorderStateRegion,
  deleteStateRegion: engine.deleteStateRegion,
  addStateNote: engine.addStateNote,
  editStateNote: engine.editStateNote,
  deleteStateNote: engine.deleteStateNote,
  editStateAppearance: engine.editStateAppearance,
  editStateAccessibility: engine.editStateAccessibility,
  addStateStyle: engine.addStateStyle,
  editStateStyle: engine.editStateStyle,
  renameStateStyleDefinition: engine.renameStateStyleDefinition,
  setStateStyleProperty: engine.setStateStyleProperty,
  deleteStateStyle: engine.deleteStateStyle,
  editStateLink: engine.editStateLink,
  editStateDiagramTitle: engine.editStateDiagramTitle,
  editStateOpaqueConfig: engine.editStateOpaqueConfig,
  addStateComment: engine.addStateComment,
  editStateComment: engine.editStateComment,
  deleteStateComment: engine.deleteStateComment,
  reorderStateComment: engine.reorderStateComment,
};
export type StateCommandName = keyof typeof STATE_COMMANDS;
export type StateCommandArgs<K extends StateCommandName> =
  Parameters<(typeof STATE_COMMANDS)[K]> extends [
    engine.MermaidStateModel,
    ...infer Args,
  ]
    ? Args
    : never;
export function runStateCommand<K extends StateCommandName>(
  model: engine.MermaidStateModel,
  name: K,
  args: StateCommandArgs<K>,
): engine.StateCommandResult {
  return (
    STATE_COMMANDS[name] as unknown as (
      model: engine.MermaidStateModel,
      ...args: StateCommandArgs<K>
    ) => engine.StateCommandResult
  )(model, ...args);
}
/** Explicit local ordering/direction changes reflow only their owning scope. */
export function stateCommandReflowScopes<K extends StateCommandName>(
  model: engine.MermaidStateModel,
  name: K,
  args: StateCommandArgs<K>,
): readonly string[] {
  const key = args[0];
  if (typeof key !== "string") return [];
  let ownerId: string | undefined;
  if (name === "editStateComposite") {
    const c = model.composites.find((c) => c.sourceKey === key || c.id === key),
      value = args[1] as { direction?: string };
    if (value?.direction && value.direction !== (c?.direction ?? "TB"))
      ownerId = c?.id;
  } else if (name === "addStateRegion")
    ownerId = model.composites.find(
      (c) => c.sourceKey === key || c.id === key,
    )?.id;
  else if (name === "reorderStateRegion" || name === "deleteStateRegion")
    ownerId = engine.stateRegionRecords(model, key)?.open.ownerId;
  const scope = model.composites.find((c) => c.id === ownerId);
  return scope?.sourceKey ? [scope.sourceKey] : [];
}
export const statePageSelectionTools: MermaidPageSelectionToolsContribution = {
  boxSelectableKinds: ["node"],
  selectableKinds: ["node", "edge", "subgraph"],
  selectAllKinds: ["node"],
  operations: {
    deleteSelection: true,
    duplicateSelection: false,
    moveSelection: true,
  },
  resolveItems: (model) => [
    ...model.nodes.map((n) => {
      const b = stateProjectionBinding(n);
      const boxSelectable =
        b?.role === "state" ||
        (b?.role === "note" &&
          !mermaidVisualFamilyPayload(n.familyData, "state")?.noteStateId);
      return {
        editKey: n.id,
        kind: "node" as const,
        boxSelectable,
        selectAllSelectable: boxSelectable,
        label:
          b?.kind === "start"
            ? m.stateStart()
            : b?.kind === "end"
              ? m.stateEnd()
              : b?.kind === "choice"
                ? `${m.stateChoice()} · ${b.sourceId}`
                : b?.kind === "fork"
                  ? `${m.stateFork()} · ${b.sourceId}`
                  : b?.kind === "join"
                    ? `${m.stateJoin()} · ${b.sourceId}`
                    : b?.role === "region"
                      ? m.stateRegion()
                      : (n.displayLabel ?? n.label),
      };
    }),
    ...model.edges.map((e) => ({ editKey: e.id, kind: "edge" as const })),
    ...(model.subgraphs ?? []).map((g) => ({
      editKey: g.id,
      kind: "subgraph" as const,
    })),
  ],
  containerAction: {
    id: "state.group",
    label: m.visualAddComposite,
    minimumSelectionCount: 2,
    eligibleKinds: ["node"],
    validationMessage: m.classPatchRejected,
    validate: ({ items, visualModel }) => {
      const bindings = items.map((i) =>
        i.kind === "node"
          ? stateProjectionBinding(
              visualModel.nodes.find((n) => n.id === i.editKey) ?? {},
            )
          : undefined,
      );
      return items.length >= 2 &&
        bindings.every((b) => b?.role === "state") &&
        new Set(bindings.map((b) => b?.parentId)).size === 1 &&
        new Set(bindings.map((b) => b?.regionKey)).size === 1 &&
        bindings.every(
          (binding) =>
            (binding?.kind !== "start" && binding?.kind !== "end") ||
            visualModel.edges
              .filter(
                (edge) =>
                  edge.source === binding?.sourceKey ||
                  edge.target === binding?.sourceKey,
              )
              .every(
                (edge) =>
                  items.some((item) => item.editKey === edge.source) &&
                  items.some((item) => item.editKey === edge.target) &&
                  mermaidVisualFamilyPayload(edge.familyData, "state")
                    ?.parentId === binding?.parentId &&
                  mermaidVisualFamilyPayload(edge.familyData, "state")
                    ?.regionKey === binding?.regionKey,
              ),
        )
        ? { valid: true }
        : { valid: false, code: "state.group" };
    },
  },
};
export const STATE_PARENT_ACTIONS = [
  "addState",
  "transition",
  "pseudostate",
  "emptyComposite",
  "group",
  "region",
  "note",
  "comments",
  "appearance",
  "accessibility",
  "data",
  "deleteSelection",
] as const;
export type StateParentAction = (typeof STATE_PARENT_ACTIONS)[number];
export const STATE_PARENT_ACTION_LABELS: Record<
  StateParentAction,
  () => string
> = {
  addState: m.stateLabel,
  transition: m.stateTransition,
  pseudostate: m.statePseudostate,
  emptyComposite: m.stateEmptyComposite,
  group: m.stateGroup,
  region: m.stateAddRegion,
  note: m.sequenceNote,
  comments: m.visualComments,
  appearance: m.visualAppearance,
  accessibility: m.visualAccessibility,
  data: m.pieData,
  deleteSelection: m.visualDelete,
};
