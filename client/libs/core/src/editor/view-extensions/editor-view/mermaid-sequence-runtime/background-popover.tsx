// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Alert,
  Button,
  Group,
  MyoxusTextInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type SequenceReactHostProps,
  type MermaidSequenceBackground,
} from "@virgultum/block-mermaid";
import {
  useSequenceDraft,
  changedSequenceFields,
  handleSequenceDraftKeyDown,
  sequenceTimelineOptions,
  sequenceDraftAnchor,
} from "./drafts";
export function SequenceBackgroundForm({
  props,
  background,
  kind,
  onClose,
}: {
  props: SequenceReactHostProps;
  background?: MermaidSequenceBackground;
  kind: "box" | "rect";
  onClose: () => void;
}) {
  const initial = {
      label: background?.label ?? "",
      color: background?.color ?? "",
    },
    d = useSequenceDraft(initial, props),
    span = useSequenceDraft(
      {
        start:
          props.model.sourceDocument.records.find(
            (r) => r.parentId === background?.id,
          )?.sourceKey ?? "",
        end:
          props.model.sourceDocument.records
            .filter((r) => r.parentId === background?.id && r.kind !== "end")
            .at(-1)?.sourceKey ?? "",
      },
      props,
    ),
    membership = useSequenceDraft(
      { participantKey: "", assigned: true },
      props,
    );
  const run = (preview = false) => {
    const call = preview ? d.preview : d.commit;
    return background
      ? call("editSequenceBackground", [
          background.id,
          changedSequenceFields(initial, d.value),
        ])
      : kind === "box"
        ? call("addSequenceBox", [d.value])
        : call("addSequenceRect", [
            {
              color: d.value.color,
              start: sequenceDraftAnchor(span.value.start),
              end: sequenceDraftAnchor(span.value.end, "after"),
            },
          ]);
  };
  const save = () => {
    if (!run().diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) =>
        handleSequenceDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      {kind === "box" ? (
        <MyoxusTextInput
          autoFocus
          label={m.timelineLabel()}
          value={d.value.label}
          disabled={props.readonly}
          onChange={(value) => d.set("label", value)}
        />
      ) : null}
      <MyoxusTextInput
        label={m.quadrantFillColor()}
        value={d.value.color}
        disabled={props.readonly}
        onChange={(value) => d.set("color", value)}
      />
      {kind === "rect" ? (
        <>
          <Select
            label={m.sequenceStart()}
            data={sequenceTimelineOptions(props)}
            value={span.value.start}
            disabled={props.readonly}
            onChange={(value) => span.set("start", value ?? "")}
          />
          <Select
            label={m.sequenceEnd()}
            data={sequenceTimelineOptions(props)}
            value={span.value.end}
            disabled={props.readonly}
            onChange={(value) => span.set("end", value ?? "")}
          />
          {background ? (
            <Group>
              <Button
                disabled={props.readonly}
                onClick={() =>
                  span.preview("editSequenceBackground", [
                    background.id,
                    {
                      start: sequenceDraftAnchor(span.value.start),
                      end: sequenceDraftAnchor(span.value.end, "after"),
                    },
                  ])
                }
              >
                {m.sequencePreview()}
              </Button>
              <Button
                disabled={props.readonly}
                onClick={() => {
                  if (
                    !span.commit("editSequenceBackground", [
                      background.id,
                      {
                        start: sequenceDraftAnchor(span.value.start),
                        end: sequenceDraftAnchor(span.value.end, "after"),
                      },
                    ]).diagnostic
                  )
                    onClose();
                }}
              >
                {m.treemapMove()}
              </Button>
            </Group>
          ) : null}
        </>
      ) : null}
      {d.diagnostic || span.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic || span.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button disabled={props.readonly} onClick={() => run(true)}>
          {m.sequencePreview()}
        </Button>
        <Button disabled={props.readonly} onClick={save}>
          {m.sequenceApply()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
        {background ? (
          <Button
            disabled={props.readonly}
            onClick={() => {
              if (
                !d.commit("deleteSequenceBackground", [background.id])
                  .diagnostic
              )
                onClose();
            }}
          >
            {m.visualDelete()}
          </Button>
        ) : null}
      </Group>
      {kind === "box" && background ? (
        <Stack>
          {props.model.participants
            .filter((p) => p.boxId === background.id)
            .map((p) => (
              <Button
                key={p.sourceKey}
                disabled={props.readonly || Boolean(p.createdBy)}
                onClick={() =>
                  membership.commit("moveSequenceParticipant", [
                    p.sourceKey,
                    { boxId: null },
                  ])
                }
              >
                {m.sequenceRemoveParticipant(p.label)}
              </Button>
            ))}
          <Select
            label={m.sequenceParticipant()}
            value={membership.value.participantKey}
            data={props.model.participants
              .filter((p) => p.boxId !== background.id && !p.createdBy)
              .map((p) => ({ value: p.sourceKey, label: p.label }))}
            disabled={props.readonly}
            onChange={(value) => membership.set("participantKey", value ?? "")}
          />
          <Group>
            <Button
              disabled={props.readonly || !membership.value.participantKey}
              onClick={() =>
                membership.preview("moveSequenceParticipant", [
                  membership.value.participantKey,
                  { boxId: background.id },
                ])
              }
            >
              {m.sequencePreview()}
            </Button>
            <Button
              disabled={props.readonly || !membership.value.participantKey}
              onClick={() =>
                membership.commit("moveSequenceParticipant", [
                  membership.value.participantKey,
                  { boxId: background.id },
                ])
              }
            >
              {m.sequenceApply()}
            </Button>
          </Group>
          {membership.diagnostic ? (
            <Alert color="myoxusError">{membership.diagnostic}</Alert>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
