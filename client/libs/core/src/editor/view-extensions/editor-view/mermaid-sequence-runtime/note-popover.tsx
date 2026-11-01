// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type SequenceReactHostProps,
  type MermaidSequenceNote,
} from "@virgultum/block-mermaid";
import {
  useSequenceDraft,
  changedSequenceFields,
  sequenceDraftAnchor,
  sequenceParticipantOptions,
  sequenceTimelineOptions,
} from "./drafts";
export function SequenceNoteForm({
  props,
  note,
  onClose,
}: {
  props: SequenceReactHostProps;
  note?: MermaidSequenceNote;
  onClose: () => void;
}) {
  const initial = {
      label: note?.label ?? "",
      placement: note?.placement ?? ("over" as const),
      participantIds: note?.participantIds ?? [
        props.model.participants[0]?.id ?? "",
      ],
      wrap: note?.wrap ?? props.config.wrap,
    },
    d = useSequenceDraft(initial, props),
    anchor = useSequenceDraft(
      { key: "", position: "before" as "before" | "after" },
      props,
    );
  const run = (preview = false) =>
    note
      ? (preview ? d.preview : d.commit)("editSequenceNote", [
          note.id,
          changedSequenceFields(initial, d.value),
        ])
      : (preview ? d.preview : d.commit)("addSequenceNote", [
          d.value,
          sequenceDraftAnchor(anchor.value.key, anchor.value.position),
        ]);
  return (
    <Stack>
      <Textarea
        autoFocus
        label={m.sequenceNote()}
        value={d.value.label}
        disabled={props.readonly}
        autosize
        onChange={(value) => d.set("label", value)}
      />
      <Select
        label={m.sequencePosition()}
        value={d.value.placement}
        data={[
          { value: "left of", label: m.pieLegendLeft() },
          { value: "over", label: m.sequenceOver() },
          { value: "right of", label: m.pieLegendRight() },
        ]}
        disabled={props.readonly}
        onChange={(value) => {
          d.set("placement", value as typeof initial.placement);
          if (value !== "over")
            d.set("participantIds", d.value.participantIds.slice(0, 1));
        }}
      />
      <Select
        label={m.sequenceParticipant()}
        value={d.value.participantIds[0]}
        data={sequenceParticipantOptions(props)}
        disabled={props.readonly}
        onChange={(value) =>
          d.set("participantIds", [
            value ?? "",
            ...d.value.participantIds.slice(1),
          ])
        }
      />
      {d.value.placement === "over" ? (
        <Select
          label={m.sankeyLinkTarget()}
          value={d.value.participantIds[1] ?? ""}
          data={[
            { value: "", label: m.sequenceOff() },
            ...sequenceParticipantOptions(props),
          ]}
          disabled={props.readonly}
          onChange={(value) =>
            d.set(
              "participantIds",
              value
                ? [d.value.participantIds[0]!, value]
                : d.value.participantIds.slice(0, 1),
            )
          }
        />
      ) : null}
      <Checkbox
        label={m.sequenceWrap()}
        checked={d.value.wrap}
        disabled={props.readonly}
        onChange={(event) => d.set("wrap", event.currentTarget.checked)}
      />
      <Select
        label={m.sequenceSourceOrder()}
        data={sequenceTimelineOptions(props).filter(
          (option) => option.value !== note?.id,
        )}
        value={anchor.value.key}
        disabled={props.readonly}
        onChange={(value) => anchor.set("key", value ?? "")}
      />
      <Select
        label={m.sequencePosition()}
        data={[
          { value: "before", label: m.sequenceBefore() },
          { value: "after", label: m.sequenceAfter() },
        ]}
        value={anchor.value.position}
        disabled={props.readonly}
        onChange={(value) =>
          anchor.set("position", value as "before" | "after")
        }
      />
      {note ? (
        <Group>
          <Button
            disabled={props.readonly}
            onClick={() =>
              anchor.preview("reorderSequenceNote", [
                note.id,
                sequenceDraftAnchor(anchor.value.key, anchor.value.position),
              ])
            }
          >
            {m.sequencePreview()}
          </Button>
          <Button
            disabled={props.readonly}
            onClick={() => {
              if (
                !anchor.commit("reorderSequenceNote", [
                  note.id,
                  sequenceDraftAnchor(anchor.value.key, anchor.value.position),
                ]).diagnostic
              )
                onClose();
            }}
          >
            {m.treemapMove()}
          </Button>
        </Group>
      ) : null}
      {d.diagnostic || anchor.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic || anchor.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button disabled={props.readonly} onClick={() => run(true)}>
          {m.sequencePreview()}
        </Button>
        <Button
          disabled={props.readonly}
          onClick={() => {
            if (!run().diagnostic) onClose();
          }}
        >
          {m.sequenceApply()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
        {note ? (
          <Button
            disabled={props.readonly}
            onClick={() => {
              if (!d.commit("deleteSequenceNote", [note.id]).diagnostic)
                onClose();
            }}
          >
            {m.visualDelete()}
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
