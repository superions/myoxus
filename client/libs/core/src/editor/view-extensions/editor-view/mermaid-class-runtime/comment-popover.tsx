import { useState } from "react";
import { CommentIcon } from "@myoxus/icons";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  ConfirmModal,
  IconButton,
  Popover,
  PopoverContent,
  Scrollable,
  PopoverTarget,
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type ClassReactHostProps,
  type ClassCommentAnchor,
  type MermaidClassComment,
} from "@virgultum/block-mermaid";
import { useClassDraft } from "./drafts";
export function ClassCommentsForm({
  props,
  fixedAnchor,
}: {
  props: ClassReactHostProps;
  fixedAnchor?: ClassCommentAnchor;
}) {
  const t = useI18n(),
    selected = props.selected;
  const selectedKind =
    selected?.kind === "class" ? "class" : (selected?.kind ?? "diagram");
  const anchors = [
    { value: "diagram:", label: m.visualComments() },
    ...props.model.nodes
      .filter((n) => n.kind === "class")
      .flatMap((n) => [
        { value: `class:${n.sourceKey}`, label: n.label },
        ...n.members.map((member) => ({
          value: `member:${member.id}`,
          label: `${n.label} · ${member.raw}`,
        })),
      ]),
    ...props.model.namespaces.map((n) => ({
      value: `namespace:${n.sourceKey}`,
      label: n.label,
    })),
    ...props.model.notes.map((n) => ({
      value: `note:${n.sourceKey}`,
      label: n.text,
    })),
    ...props.model.relations.map((r) => ({
      value: `relation:${r.sourceKey}`,
      label: `${r.fromSourceId} · ${r.label} · ${r.toSourceId}`,
    })),
  ];
  const d = useClassDraft(
    {
      anchor: fixedAnchor
        ? `${fixedAnchor.anchorKind}:${fixedAnchor.anchorId ?? ""}`
        : selected
          ? `${selectedKind}:${selected.key}`
          : "diagram:",
      position: "before" as "before" | "after",
      text: "",
    },
    props,
  );
  const delimiter = d.value.anchor.indexOf(":"),
    anchor: ClassCommentAnchor = {
      anchorKind: d.value.anchor.slice(
        0,
        delimiter,
      ) as ClassCommentAnchor["anchorKind"],
      anchorId: d.value.anchor.slice(delimiter + 1) || undefined,
      position: d.value.position,
    };
  const comments = props.model.commentRecords.filter(
    (c) => c.anchorKind === anchor.anchorKind && c.anchorId === anchor.anchorId,
  );
  return (
    <Stack>
      {!fixedAnchor ? (
        <Select
          label={m.visualComments()}
          data={anchors}
          value={d.value.anchor}
          onChange={(value) => d.set("anchor", value)}
        />
      ) : null}
      {comments.map((comment) => (
        <ClassCommentForm
          key={comment.id}
          props={props}
          comment={comment}
          comments={comments}
        />
      ))}
      {!props.readonly ? (
        <>
          <Select
            label={m.visualComments()}
            value={d.value.position}
            data={[
              { value: "before", label: m.radarCommentBefore() },
              { value: "after", label: m.radarCommentAfter() },
            ]}
            onChange={(value) =>
              d.set("position", value as typeof d.value.position)
            }
          />
          <MyoxusTextInput
            label={m.visualComments()}
            value={d.value.text}
            onChange={(value) => d.set("text", value)}
          />
          <Button
            onClick={() => d.commit("addClassComment", [anchor, d.value.text])}
          >
            {t["com.myoxus.editCollection.save"]()}
          </Button>
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
function ClassCommentForm({
  props,
  comment,
  comments,
}: {
  props: ClassReactHostProps;
  comment: MermaidClassComment;
  comments: readonly MermaidClassComment[];
}) {
  const [deleting, setDeleting] = useState(false);
  const t = useI18n(),
    d = useClassDraft({ text: comment.text }, props),
    siblings = comments.filter((c) => c.position === comment.position),
    index = siblings.findIndex((c) => c.id === comment.id);
  return (
    <Stack>
      <MyoxusText>
        {comment.position === "before"
          ? m.radarCommentBefore()
          : m.radarCommentAfter()}
      </MyoxusText>
      <MyoxusTextInput
        label={m.visualComments()}
        value={d.value.text}
        disabled={props.readonly}
        onChange={(value) => d.set("text", value)}
      />
      {!props.readonly ? (
        <Group>
          <Button
            onClick={() =>
              d.commit("editClassComment", [comment.id, d.value.text])
            }
          >
            {t["com.myoxus.editCollection.save"]()}
          </Button>
          <Button onClick={() => setDeleting(true)}>
            {m.visualDeleteComment()}
          </Button>
          <Button
            disabled={index <= 0}
            onClick={() =>
              d.commit("reorderClassComment", [
                comment.id,
                siblings[index - 1]?.id,
              ])
            }
          >
            {m.visualMoveUp()}
          </Button>
          <Button
            disabled={index >= siblings.length - 1}
            onClick={() =>
              d.commit("reorderClassComment", [
                comment.id,
                siblings[index + 2]?.id,
              ])
            }
          >
            {m.visualMoveDown()}
          </Button>
        </Group>
      ) : null}
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDeleteComment()}
        confirmText={m.visualDeleteComment()}
        onConfirm={() => {
          const result = d.commit("deleteClassComment", [comment.id]);
          if (!result.diagnostic) setDeleting(false);
        }}
      >
        <MyoxusText>{comment.text}</MyoxusText>
      </ConfirmModal>
      {d.diagnostic && !props.readonly ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
    </Stack>
  );
}

export function ClassCommentsPopover({
  props,
  anchor,
  marker = false,
  count = 0,
}: {
  props: ClassReactHostProps;
  anchor: ClassCommentAnchor;
  marker?: boolean;
  count?: number;
}) {
  const [opened, setOpened] = useState(false);
  const t = useI18n();
  return (
    <Popover fitViewport opened={opened} onChange={setOpened}>
      <PopoverTarget>
        {marker ? (
          <IconButton
            icon={<CommentIcon />}
            aria-label={`${m.visualComments()} · ${new Intl.NumberFormat(t.language).format(count)}`}
            onClick={() => setOpened(!opened)}
          />
        ) : (
          <Button onClick={() => setOpened(!opened)}>
            {m.visualComments()}
          </Button>
        )}
      </PopoverTarget>
      <PopoverContent>
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <ClassCommentsForm props={props} fixedAnchor={anchor} />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
