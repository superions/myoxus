// SPDX-License-Identifier: AGPL-3.0-or-later
import * as engine from "../../engine/sequence/index.js";
import type { MermaidPageSelectionToolsContribution } from "../runtime/contracts.js";
import { sequenceNodeBinding, sequenceFamilyPayload } from "./gfx-data.js";
import { mermaidMessages as m } from "../../i18n.js";

/** Timeline controls name the bound object and its Source scope, never expose
 * raw statements as an Edgeless editor or infer scope from canvas overlap. */
export function sequenceTimelineLabel(
  model: engine.MermaidSequenceModel,
  key: string,
): string {
  const record = model.sourceDocument.records.find((r) => r.sourceKey === key);
  if (!record) return m.sequenceEnd();
  const participant = (id: string) =>
    model.participants.find((p) => p.id === id)?.label ?? id;
  const message = model.messages.find((item) => item.id === key);
  const activation = model.activations.find((item) => item.id === key);
  const note = model.notes.find((item) => item.id === key);
  const fragment = model.controls.find((item) => item.id === key);
  const branch = model.controls
    .flatMap((item) => item.branches)
    .find((item) => item.id === key);
  const background = model.backgrounds.find((item) => item.id === key);
  const identity = model.participants.find(
    (item) => item.sourceKey === key || item.id === record.ownerId,
  );
  const owner =
    record.blockKey &&
    model.controls.find((item) => item.id === record.blockKey);
  const scope = model.controls.find((item) => item.id === record.parentId);
  const scopeBranch = scope?.branches.find(
    (item) => item.id === record.branchId,
  );
  const label = message
    ? `${participant(message.from)} → ${participant(message.to)} · ${message.label || m.sequenceMessage()}`
    : activation
      ? `${activation.kind === "activate" ? m.sequenceActivationStart() : activation.kind === "deactivate" ? m.sequenceActivationEnd() : activation.kind === "create" ? m.sequenceLifecycleCreate() : m.sequenceLifecycleDestroy()} · ${participant(activation.participantId)}`
      : note
        ? `${m.sequenceNote()} · ${note.label}`
        : fragment
          ? `${m.sequenceFragmentKind(fragment.kind)} · ${fragment.label}`
          : branch
            ? `${m.sequenceBranch()} · ${branch.label}`
            : background
              ? `${background.kind === "box" ? m.sequenceBox() : m.sequenceRect()} · ${background.label}`
              : record.kind === "end"
                ? `${m.sequenceEnd()}${owner ? ` · ${m.sequenceFragmentKind(owner.kind)} · ${owner.label}` : ""}`
                : identity
                  ? `${record.kind === "participant" ? m.sequenceParticipant() : record.kind === "link" ? m.sequenceOpenLink() : m.pieData()} · ${identity.label}`
                  : record.kind === "autonumber"
                    ? m.sequenceAutonumber()
                    : record.kind === "title"
                      ? m.titlePlaceholder()
                      : record.kind === "comment"
                        ? m.visualComments()
                        : m.pieData();
  return `${record.range.line} · ${label}${scope ? ` [${m.sequenceFragmentKind(scope.kind)} · ${scopeBranch?.label || scope.label}]` : ""}`;
}
export const SEQUENCE_COMMANDS = {
  deleteSequenceSelection: engine.deleteSequenceSelection,
  editSequenceOpaqueData: engine.editSequenceOpaqueData,
  editSequenceDiagramTitle: engine.editSequenceDiagramTitle,
  addSequenceParticipant: engine.addSequenceParticipant,
  editSequenceParticipant: engine.editSequenceParticipant,
  moveSequenceParticipant: engine.moveSequenceParticipant,
  deleteSequenceParticipant: engine.deleteSequenceParticipant,
  setSequenceLifecycle: engine.setSequenceLifecycle,
  addSequenceMessage: engine.addSequenceMessage,
  editSequenceMessage: engine.editSequenceMessage,
  flipSequenceMessage: engine.flipSequenceMessage,
  reorderSequenceMessage: engine.reorderSequenceMessage,
  deleteSequenceMessage: engine.deleteSequenceMessage,
  addSequenceActivation: engine.addSequenceActivation,
  editSequenceActivation: engine.editSequenceActivation,
  deleteSequenceActivation: engine.deleteSequenceActivation,
  addSequenceNote: engine.addSequenceNote,
  editSequenceNote: engine.editSequenceNote,
  reorderSequenceNote: engine.reorderSequenceNote,
  deleteSequenceNote: engine.deleteSequenceNote,
  addSequenceFragment: engine.addSequenceFragment,
  editSequenceFragment: engine.editSequenceFragment,
  reorderSequenceFragment: engine.reorderSequenceFragment,
  nestSequenceFragment: engine.nestSequenceFragment,
  deleteSequenceFragment: engine.deleteSequenceFragment,
  addSequenceBranch: engine.addSequenceBranch,
  editSequenceBranch: engine.editSequenceBranch,
  reorderSequenceBranch: engine.reorderSequenceBranch,
  deleteSequenceBranch: engine.deleteSequenceBranch,
  addSequenceBox: engine.addSequenceBox,
  addSequenceRect: engine.addSequenceRect,
  editSequenceBackground: engine.editSequenceBackground,
  deleteSequenceBackground: engine.deleteSequenceBackground,
  addSequenceComment: engine.addSequenceComment,
  editSequenceComment: engine.editSequenceComment,
  reanchorSequenceComment: engine.reanchorSequenceComment,
  deleteSequenceComment: engine.deleteSequenceComment,
  editSequenceLink: engine.editSequenceLink,
  editSequenceAppearance: engine.editSequenceAppearance,
  editSequenceAccessibility: engine.editSequenceAccessibility,
  editSequenceAutonumber: engine.editSequenceAutonumber,
  editSequenceData: engine.editSequenceData,
};
export type SequenceCommandName = keyof typeof SEQUENCE_COMMANDS;
export type SequenceCommandArgs<K extends SequenceCommandName> =
  Parameters<(typeof SEQUENCE_COMMANDS)[K]> extends [
    engine.MermaidSequenceModel,
    ...infer Args,
  ]
    ? Args
    : never;
export function runSequenceCommand<K extends SequenceCommandName>(
  model: engine.MermaidSequenceModel,
  name: K,
  args: SequenceCommandArgs<K>,
): engine.SequenceCommandResult {
  return (
    SEQUENCE_COMMANDS[name] as unknown as (
      model: engine.MermaidSequenceModel,
      ...args: SequenceCommandArgs<K>
    ) => engine.SequenceCommandResult
  )(model, ...args);
}
export const sequencePageSelectionTools: MermaidPageSelectionToolsContribution =
  {
    boxSelectableKinds: ["node", "edge"],
    selectableKinds: ["node", "edge", "subgraph"],
    selectAllKinds: ["node", "edge", "subgraph"],
    operations: {
      deleteSelection: true,
      duplicateSelection: false,
      moveSelection: false,
    },
    resolveItems: (model) => [
      ...model.nodes
        .filter((n) => {
          const b = sequenceNodeBinding(n);
          return Boolean(b);
        })
        .map((n) => {
          const binding = sequenceNodeBinding(n)!;
          const participant = model.nodes.find(
            (node) => node.id === binding.participantKey,
          );
          return {
            kind: "node" as const,
            editKey: n.id,
            label:
              binding.role === "lifecycle"
                ? `${m.sequenceLifecycleDestroy()} · ${participant?.label ?? ""}`
                : binding.role === "lifeline"
                  ? `${m.sequenceParticipant()} · ${n.label}`
                  : n.label || m.sequenceFragment(),
          };
        }),
      ...model.edges.map((e) => ({ kind: "edge" as const, editKey: e.id })),
      ...(model.subgraphs ?? [])
        .filter((g) => sequenceFamilyPayload(g)?.role !== "fragment")
        .map((g) => ({
          kind: "subgraph" as const,
          editKey: g.id,
          label: g.title || g.displayLabel,
        })),
    ],
  };
export const SEQUENCE_PARENT_ACTIONS = [
  "participant",
  "message",
  "activation",
  "fragment",
  "box",
  "rect",
  "note",
  "comments",
  "appearance",
  "accessibility",
  "data",
  "deleteSelection",
] as const;
export type SequenceParentAction = (typeof SEQUENCE_PARENT_ACTIONS)[number];
export const SEQUENCE_PARENT_ACTION_LABELS: Record<
  SequenceParentAction,
  () => string
> = {
  participant: m.optionParticipant,
  message: m.sequenceMessage,
  activation: m.sequenceActivation,
  fragment: m.sequenceFragment,
  box: m.sequenceBox,
  rect: m.sequenceRect,
  note: m.sequenceNote,
  comments: m.visualComments,
  appearance: m.visualAppearance,
  accessibility: m.visualAccessibility,
  data: m.pieData,
  deleteSelection: m.visualDelete,
};
