// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { CommentIcon } from "@myoxus/icons";
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
  type ErReactHostProps,
  type ErCommentAnchor,
  type MermaidErComment,
} from "@virgultum/block-mermaid";
import { useErDraft } from "./drafts";
function erCommentAnchors(props: ErReactHostProps) {
  return [
    { value: "diagram:", label: m.visualComments() },
    ...props.model.entities.flatMap((n) => [
      { value: `entity:${n.sourceKey}`, label: n.label },
      ...n.attributes.map((a) => ({
        value: `attribute:${a.id}`,
        label: `${n.label} · ${a.name}`,
      })),
    ]),
    ...props.model.subgraphs.map((n) => ({
      value: `subgraph:${n.sourceKey}`,
      label: n.label,
    })),
    ...props.model.relationships.map((r) => ({
      value: `relation:${r.sourceKey}`,
      label: `${r.from} · ${r.label} · ${r.to}`,
    })),
    ...[
      ...new Set(
        props.model.commentRecords
          .filter((c) => c.anchorKind === "record")
          .map((c) => c.anchorId),
      ),
    ].flatMap((key) => {
      const record = props.model.sourceDocument.records.find(
        (r) => r.sourceKey === key,
      );
      return record
        ? [{ value: `record:${key}`, label: record.raw.trim() }]
        : [];
    }),
  ];
}
export function ErCommentsForm({
  props,
  fixedAnchor,
}: {
  props: ErReactHostProps;
  fixedAnchor?: ErCommentAnchor;
}) {
  const t = useI18n(),
    selected = props.selected;
  const selectedKind =
    selected?.kind === "title" ? "diagram" : (selected?.kind ?? "diagram");
  const anchors = erCommentAnchors(props);
  const d = useErDraft(
    {
      anchor: fixedAnchor
        ? `${fixedAnchor.anchorKind}:${fixedAnchor.anchorId ?? ""}`
        : selected
          ? `${selectedKind}:${selected.key}`
          : "diagram:",
      position: (fixedAnchor?.position ??
        (selectedKind === "entity" || selectedKind === "subgraph"
          ? "after"
          : "before")) as "before" | "after",
      text: "",
    },
    props,
  );
  const delimiter = d.value.anchor.indexOf(":"),
    anchor: ErCommentAnchor = {
      anchorKind: d.value.anchor.slice(
        0,
        delimiter,
      ) as ErCommentAnchor["anchorKind"],
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
          onChange={(value) => {
            d.set("anchor", value);
            d.set(
              "position",
              value.startsWith("entity:") || value.startsWith("subgraph:")
                ? "after"
                : "before",
            );
          }}
        />
      ) : null}
      {comments.map((comment) => (
        <ErCommentForm
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
            onClick={() => d.commit("addErComment", [anchor, d.value.text])}
          >
            {t["Save"]()}
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
function ErCommentForm({
  props,
  comment,
  comments,
}: {
  props: ErReactHostProps;
  comment: MermaidErComment;
  comments: readonly MermaidErComment[];
}) {
  const [deleting, setDeleting] = useState(false);
  const t = useI18n(),
    d = useErDraft(
      {
        text: comment.text,
        anchor: `${comment.anchorKind}:${comment.anchorId ?? ""}`,
      },
      props,
    ),
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
      <Select
        label={m.architectureEndpointObject()}
        data={erCommentAnchors(props)}
        value={d.value.anchor}
        disabled={props.readonly}
        onChange={(value) => d.set("anchor", value)}
      />
      {!props.readonly ? (
        <Button
          disabled={
            d.value.anchor === `${comment.anchorKind}:${comment.anchorId ?? ""}`
          }
          onClick={() => {
            const index = d.value.anchor.indexOf(":"),
              kind = d.value.anchor.slice(
                0,
                index,
              ) as ErCommentAnchor["anchorKind"];
            d.commit("reanchorErComment", [
              comment.id,
              {
                anchorKind: kind,
                anchorId: d.value.anchor.slice(index + 1) || undefined,
                position:
                  kind === "entity" || kind === "subgraph" ? "after" : "before",
              },
            ]);
          }}
        >
          {m.treemapMove()}
        </Button>
      ) : null}
      {!props.readonly ? (
        <Group>
          <Button
            onClick={() =>
              d.commit("editErComment", [comment.id, d.value.text])
            }
          >
            {t["Save"]()}
          </Button>
          <Button onClick={() => setDeleting(true)}>
            {m.visualDeleteComment()}
          </Button>
          <Button
            disabled={index <= 0}
            onClick={() =>
              d.commit("reorderErComment", [
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
              d.commit("reorderErComment", [
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
          const result = d.commit("deleteErComment", [comment.id]);
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

export function ErCommentsPopover({
  props,
  anchor,
  marker = false,
  count = 0,
}: {
  props: ErReactHostProps;
  anchor: ErCommentAnchor;
  marker?: boolean;
  count?: number;
}) {
  const [opened, setOpened] = useState(false);
  const t = useI18n();
  const changeOpened = (next: boolean) => {
    // A marker hands the form over from the parent action; both surfaces must
    // never compete for pointer hits or retain separate drafts for this object.
    if (next && (props.parentIntent || props.intent))
      props.onParentIntent(null);
    setOpened(next);
  };
  return (
    <Popover fitViewport opened={opened} onChange={changeOpened}>
      <PopoverTarget>
        {marker ? (
          <IconButton
            icon={<CommentIcon />}
            aria-label={`${m.visualComments()} · ${new Intl.NumberFormat(t.language).format(count)}`}
            onClick={() => changeOpened(!opened)}
          />
        ) : (
          <Button onClick={() => changeOpened(!opened)}>
            {m.visualComments()}
          </Button>
        )}
      </PopoverTarget>
      <PopoverContent>
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <ErCommentsForm props={props} fixedAnchor={anchor} />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
