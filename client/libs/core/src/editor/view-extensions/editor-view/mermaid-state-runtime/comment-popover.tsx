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
  type StateReactHostProps,
  type StateCommentAnchor,
  type StateComment,
  stateCompositeBodyKeys,
} from "@virgultum/block-mermaid";
import { useStateDraft } from "./drafts";
function stateCommentAnchors(props: StateReactHostProps) {
  return [
    { value: "diagram:", label: m.visualComments() },
    ...props.model.states.flatMap((n) => [
      { value: `state:${n.sourceKey}`, label: n.label },
      ...(n.descriptions ?? []).map((d) => ({
        value: `description:${d.id}`,
        label: `${n.label} · ${d.text}`,
      })),
    ]),
    ...props.model.composites.flatMap((n) => [
      { value: `composite:${n.sourceKey}`, label: n.label },
      ...stateCompositeBodyKeys(props.model, n).map((key, index) => ({
        value: `region:${key}`,
        label: `${n.label} · ${m.statePrimaryRegion()} ${index + 1}`,
      })),
      ...props.model.regions
        .filter((r) => r.compositeId === n.id)
        .map((r) => ({
          value: `region:${r.id}`,
          label: `${n.label} · ${m.stateRegion()} ${r.regionIndex + 1}`,
        })),
    ]),
    ...props.model.transitions.map((r) => ({
      value: `transition:${r.id}`,
      label: `${r.from} · ${r.label} · ${r.to}`,
    })),
    ...props.model.notes.map((n) => ({
      value: `note:${n.id}`,
      label: n.label,
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
export function StateCommentsForm({
  props,
  fixedAnchor,
}: {
  props: StateReactHostProps;
  fixedAnchor?: StateCommentAnchor;
}) {
  const t = useI18n(),
    selected = props.selected;
  const selectedKind =
    selected?.kind === "title" ? "diagram" : (selected?.kind ?? "diagram");
  const anchors = stateCommentAnchors(props);
  const d = useStateDraft(
    {
      anchor: fixedAnchor
        ? `${fixedAnchor.anchorKind}:${fixedAnchor.anchorId ?? ""}`
        : selected
          ? `${selectedKind}:${selected.key}`
          : "diagram:",
      position: (fixedAnchor?.position ??
        (selectedKind === "state" || selectedKind === "composite"
          ? "after"
          : "before")) as "before" | "after" | "inside",
      text: "",
    },
    props,
  );
  const delimiter = d.value.anchor.indexOf(":"),
    anchor: StateCommentAnchor = {
      anchorKind: d.value.anchor.slice(
        0,
        delimiter,
      ) as StateCommentAnchor["anchorKind"],
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
              value.startsWith("state:") || value.startsWith("composite:")
                ? "after"
                : "before",
            );
          }}
        />
      ) : null}
      {comments.map((comment) => (
        <StateCommentForm
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
              ...(anchor.anchorKind === "composite"
                ? [{ value: "inside", label: m.stateComposite() }]
                : []),
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
            onClick={() =>
              d.commit("addStateComment", [{ ...anchor, text: d.value.text }])
            }
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
function StateCommentForm({
  props,
  comment,
  comments,
}: {
  props: StateReactHostProps;
  comment: StateComment;
  comments: readonly StateComment[];
}) {
  const [deleting, setDeleting] = useState(false);
  const t = useI18n(),
    d = useStateDraft(
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
        data={stateCommentAnchors(props)}
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
              ) as StateCommentAnchor["anchorKind"];
            d.commit("editStateComment", [
              comment.id,
              {
                anchorKind: kind,
                anchorId: d.value.anchor.slice(index + 1) || undefined,
                position: kind === "composite" ? "inside" : "before",
                text: d.value.text,
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
              d.commit("editStateComment", [
                comment.id,
                { ...comment, text: d.value.text },
              ])
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
              d.commit("reorderStateComment", [
                comment.id,
                siblings[index - 1]!.id,
              ])
            }
          >
            {m.visualMoveUp()}
          </Button>
          <Button
            disabled={index >= siblings.length - 1}
            onClick={() =>
              d.commit("reorderStateComment", [
                siblings[index + 1]!.id,
                comment.id,
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
          const result = d.commit("deleteStateComment", [comment.id]);
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

export function StateCommentsPopover({
  props,
  anchor,
  marker = false,
  count = 0,
  anchorLabel,
}: {
  props: StateReactHostProps;
  anchor: StateCommentAnchor;
  marker?: boolean;
  count?: number;
  anchorLabel?: string;
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
            aria-label={`${m.visualComments()}${anchorLabel ? ` · ${anchorLabel}` : ""} · ${new Intl.NumberFormat(t.language).format(count)}`}
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
            <StateCommentsForm props={props} fixedAnchor={anchor} />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
