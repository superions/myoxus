// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { CommentIcon } from "@myoxus/icons";
import {
  Alert,
  Button,
  ConfirmModal,
  Group,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  sequenceTimelineLabel,
  type SequenceComment,
  type SequenceCommentAnchor,
  type SequenceReactHostProps,
} from "@virgultum/block-mermaid";
import { useSequenceDraft } from "./drafts";
function sequenceCommentAnchors(props: SequenceReactHostProps) {
  return [
    { value: "diagram:", label: m.visualComments() },
    ...props.model.participants.map((p) => ({
      value: `participant:${p.sourceKey}`,
      label: `${m.sequenceParticipant()} · ${p.label}`,
    })),
    ...props.model.messages.map((msg) => ({
      value: `message:${msg.id}`,
      label: `${msg.from} → ${msg.to} · ${msg.label}`,
    })),
    ...props.model.activationIntervals.map((a) => ({
      value: `activation:${a.id}`,
      label: `${m.sequenceActivation()} · ${a.participantId}`,
    })),
    ...props.model.notes.map((note) => ({
      value: `note:${note.id}`,
      label: `${m.sequenceNote()} · ${note.label}`,
    })),
    ...props.model.controls.flatMap((fragment) => [
      {
        value: `fragment:${fragment.id}`,
        label: `${m.sequenceFragmentKind(fragment.kind)} · ${fragment.label}`,
      },
      ...fragment.branches.map((branch) => ({
        value: `branch:${branch.id}`,
        label: `${m.sequenceBranch()} · ${branch.label}`,
      })),
    ]),
    ...props.model.sourceDocument.records
      .filter(
        (r) =>
          !["blank", "comment", "header", "frontmatter", "directive"].includes(
            r.kind,
          ),
      )
      .map((r) => ({
        value: `record:${r.sourceKey}`,
        label: sequenceTimelineLabel(props.model, r.sourceKey),
      })),
  ];
}
function readAnchor(
  value: string,
  position: SequenceCommentAnchor["position"],
): SequenceCommentAnchor {
  const delimiter = value.indexOf(":");
  return {
    anchorKind: value.slice(
      0,
      delimiter,
    ) as SequenceCommentAnchor["anchorKind"],
    anchorId: value.slice(delimiter + 1) || undefined,
    position,
  };
}
export function SequenceCommentsForm({
  props,
  fixedAnchor,
}: {
  props: SequenceReactHostProps;
  fixedAnchor?: SequenceCommentAnchor;
}) {
  const d = useSequenceDraft(
      {
        anchor: fixedAnchor
          ? `${fixedAnchor.anchorKind}:${fixedAnchor.anchorId ?? ""}`
          : "diagram:",
        position:
          fixedAnchor?.position ??
          ("before" as SequenceCommentAnchor["position"]),
        text: "",
      },
      props,
    ),
    anchor = readAnchor(d.value.anchor, d.value.position),
    comments = props.model.commentRecords.filter(
      (c) =>
        c.anchorKind === anchor.anchorKind && c.anchorId === anchor.anchorId,
    );
  return (
    <Stack>
      {comments.map((comment) => (
        <SequenceCommentForm key={comment.id} props={props} comment={comment} />
      ))}
      {!props.readonly ? (
        <>
          <Select
            label={m.sequencePosition()}
            value={d.value.position}
            data={[
              { value: "before", label: m.sequenceBefore() },
              { value: "after", label: m.sequenceAfter() },
              { value: "inside", label: m.sequenceInside() },
            ]}
            onChange={(value) =>
              d.set("position", value as SequenceCommentAnchor["position"])
            }
          />
          <Textarea
            autosize
            label={m.visualComments()}
            value={d.value.text}
            onChange={(value) => d.set("text", value)}
          />
          <Group>
            <Button
              disabled={!d.value.text.trim()}
              onClick={() =>
                d.preview("addSequenceComment", [anchor, d.value.text])
              }
            >
              {m.sequencePreview()}
            </Button>
            <Button
              disabled={!d.value.text.trim()}
              onClick={() => {
                if (
                  !d.commit("addSequenceComment", [anchor, d.value.text])
                    .diagnostic
                )
                  d.set("text", "");
              }}
            >
              {m.sequenceApply()}
            </Button>
          </Group>
        </>
      ) : null}
      {d.diagnostic && !props.readonly ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
    </Stack>
  );
}
function SequenceCommentForm({
  props,
  comment,
}: {
  props: SequenceReactHostProps;
  comment: SequenceComment;
}) {
  const d = useSequenceDraft(
      {
        text: comment.text,
        anchor: `${comment.anchorKind}:${comment.anchorId ?? ""}`,
        position: comment.position,
      },
      props,
    ),
    [deleting, setDeleting] = useState(false);
  return (
    <Stack>
      <Textarea
        label={m.visualComments()}
        value={d.value.text}
        autosize
        disabled={props.readonly}
        onChange={(value) => d.set("text", value)}
      />
      <Select
        label={m.sequenceAnchor()}
        value={d.value.anchor}
        data={sequenceCommentAnchors(props)}
        disabled={props.readonly}
        onChange={(value) => d.set("anchor", value ?? "diagram:")}
      />
      <Select
        label={m.sequencePosition()}
        value={d.value.position}
        data={[
          { value: "before", label: m.sequenceBefore() },
          { value: "after", label: m.sequenceAfter() },
          { value: "inside", label: m.sequenceInside() },
        ]}
        disabled={props.readonly}
        onChange={(value) =>
          d.set("position", value as SequenceCommentAnchor["position"])
        }
      />
      <Group>
        <Button
          disabled={props.readonly}
          onClick={() =>
            d.preview("editSequenceComment", [comment.id, d.value.text])
          }
        >
          {m.sequencePreview()}
        </Button>
        <Button
          disabled={props.readonly}
          onClick={() =>
            d.commit("editSequenceComment", [comment.id, d.value.text])
          }
        >
          {m.sequenceApply()}
        </Button>
        <Button
          disabled={props.readonly}
          onClick={() =>
            d.commit("reanchorSequenceComment", [
              comment.id,
              readAnchor(d.value.anchor, d.value.position),
            ])
          }
        >
          {m.treemapMove()}
        </Button>
        <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
          {m.visualDelete()}
        </Button>
      </Group>
      {d.diagnostic && !props.readonly ? (
        <Alert color="myoxusError">{d.diagnostic}</Alert>
      ) : null}
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (!d.commit("deleteSequenceComment", [comment.id]).diagnostic)
            setDeleting(false);
        }}
      >
        {comment.text}
      </ConfirmModal>
    </Stack>
  );
}
export function SequenceCommentsPopover({
  props,
  anchor,
  count,
  marker = false,
}: {
  props: SequenceReactHostProps;
  anchor: SequenceCommentAnchor;
  count?: number;
  marker?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover
      fitViewport
      trapFocus
      opened={opened}
      onChange={(value) => {
        if (!value) props.onCancelPreview();
        setOpened(value);
      }}
    >
      <PopoverTarget>
        {marker ? (
          <IconButton
            aria-label={`${m.visualComments()} (${count ?? 0})`}
            onClick={() => setOpened(!opened)}
          >
            <CommentIcon />
          </IconButton>
        ) : (
          <Button onClick={() => setOpened(!opened)}>
            {m.visualComments()}
          </Button>
        )}
      </PopoverTarget>
      <PopoverContent
        aria-label={m.visualComments()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Scrollable.Viewport autosize maxHeight="floating" scrollbars="y">
          {opened ? (
            <SequenceCommentsForm props={props} fixedAnchor={anchor} />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
