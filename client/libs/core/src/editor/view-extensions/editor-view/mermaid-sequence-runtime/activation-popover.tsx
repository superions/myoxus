// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  ConfirmModal,
  Group,
  MyoxusText,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type SequenceReactHostProps,
  type SequenceActivationInterval,
} from "@virgultum/block-mermaid";
import {
  useSequenceDraft,
  sequenceDraftAnchor,
  sequenceParticipantOptions,
  sequenceTimelineOptions,
} from "./drafts";
export function SequenceActivationForm({
  props,
  activation,
  onClose,
}: {
  props: SequenceReactHostProps;
  activation?: SequenceActivationInterval;
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const endpoint = (key?: string) =>
      props.model.activations.find((a) => a.id === key),
    start = endpoint(activation?.startId),
    end = endpoint(activation?.endId),
    d = useSequenceDraft(
      {
        participantId:
          activation?.participantId ?? props.model.participants[0]?.id ?? "",
        start:
          start?.messageId ?? start?.id ?? props.model.messages[0]?.id ?? "",
        startPosition: "after" as "before" | "after",
        end: end?.messageId ?? end?.id ?? "",
        endPosition: "after" as "before" | "after",
        open: !activation?.endId,
        separate: false,
      },
      props,
    );
  const run = (preview = false) => {
    const call = preview ? d.preview : d.commit,
      v = d.value;
    return activation
      ? call("editSequenceActivation", [
          activation.id,
          {
            participantId: v.participantId,
            start:
              v.start !== (start?.messageId ?? start?.id) ||
              v.startPosition !== "after"
                ? sequenceDraftAnchor(v.start, v.startPosition)
                : undefined,
            end: v.open
              ? null
              : v.end !== (end?.messageId ?? end?.id) ||
                  v.endPosition !== "after"
                ? sequenceDraftAnchor(v.end, v.endPosition)
                : undefined,
            separate: v.separate,
          },
        ])
      : call("addSequenceActivation", [
          {
            participantId: v.participantId,
            start: sequenceDraftAnchor(v.start, v.startPosition),
            end: v.open ? undefined : sequenceDraftAnchor(v.end, v.endPosition),
          },
        ]);
  };
  return (
    <Stack>
      <Select
        autoFocus
        label={m.sequenceParticipant()}
        data={sequenceParticipantOptions(props)}
        value={d.value.participantId}
        disabled={props.readonly}
        onChange={(value) => d.set("participantId", value ?? "")}
      />
      <Select
        label={m.sequenceStart()}
        data={sequenceTimelineOptions(props)}
        value={d.value.start}
        disabled={props.readonly}
        onChange={(value) => d.set("start", value ?? "")}
      />
      <Select
        label={m.sequencePosition()}
        value={d.value.startPosition}
        data={[
          { value: "before", label: m.sequenceBefore() },
          { value: "after", label: m.sequenceAfter() },
        ]}
        disabled={props.readonly}
        onChange={(value) =>
          d.set("startPosition", value as "before" | "after")
        }
      />
      <Checkbox
        label={m.sequenceOpenEnd()}
        checked={d.value.open}
        disabled={props.readonly}
        onChange={(event) => d.set("open", event.currentTarget.checked)}
      />
      {!d.value.open ? (
        <>
          <Select
            label={m.sequenceEnd()}
            data={sequenceTimelineOptions(props)}
            value={d.value.end}
            disabled={props.readonly}
            onChange={(value) => d.set("end", value ?? "")}
          />
          <Select
            label={m.sequencePosition()}
            value={d.value.endPosition}
            data={[
              { value: "before", label: m.sequenceBefore() },
              { value: "after", label: m.sequenceAfter() },
            ]}
            disabled={props.readonly}
            onChange={(value) =>
              d.set("endPosition", value as "before" | "after")
            }
          />
        </>
      ) : null}
      {start?.embedded || end?.embedded ? (
        <Checkbox
          label={m.sequenceSeparateActivation()}
          checked={d.value.separate}
          disabled={props.readonly}
          onChange={(event) => d.set("separate", event.currentTarget.checked)}
        />
      ) : null}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
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
        {activation ? (
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
        ) : null}
      </Group>
      {activation ? (
        <ConfirmModal
          open={deleting}
          onOpenChange={setDeleting}
          title={m.visualDelete()}
          confirmText={m.visualDelete()}
          onConfirm={() => {
            if (
              !d.commit("deleteSequenceActivation", [activation.id]).diagnostic
            )
              onClose();
          }}
        >
          <Stack>
            {props
              .getImpact({ kind: "activation", key: activation.id })
              .records.map((record) => (
                <MyoxusText key={record.id}>{record.label}</MyoxusText>
              ))}
          </Stack>
        </ConfirmModal>
      ) : null}
    </Stack>
  );
}
