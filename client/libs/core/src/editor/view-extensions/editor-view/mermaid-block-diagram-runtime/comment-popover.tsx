// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { CommentIcon } from "@myoxus/icons";
import { useI18n } from "@myoxus/i18n";
import {
  Stack,
  Group,
  Button,
  IconButton,
  Select,
  MyoxusTextInput,
  MyoxusText,
  Alert,
  ConfirmModal,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type BlockReactHostProps,
} from "@virgultum/block-mermaid";
import { useBlockDraft } from "./drafts";
function anchors(props: BlockReactHostProps) {
  return props.model.sourceDocument.records
    .filter(
      (r) =>
        !["comment", "blank", "frontmatter", "directive", "end"].includes(
          r.kind,
        ),
    )
    .map((r) => ({ value: r.sourceKey, label: r.raw.trim() }));
}
export function BlockCommentsForm({
  props,
  anchorKey,
}: {
  props: BlockReactHostProps;
  anchorKey?: string;
}) {
  const t = useI18n(),
    d = useBlockDraft(
      {
        anchor:
          anchorKey ??
          props.model.comments.find((c) => c.sourceKey === props.selected?.key)
            ?.anchorKey ??
          props.model.sourceDocument.records.find((r) => r.kind === "header")!
            .sourceKey,
        position: "before" as "before" | "after",
        text: "",
      },
      props,
    ),
    comments = props.model.comments.filter(
      (c) => c.anchorKey === d.value.anchor,
    );
  return (
    <Stack>
      {!anchorKey ? (
        <Select
          label={m.architectureEndpointObject()}
          data={anchors(props)}
          value={d.value.anchor}
          onChange={(v) => d.set("anchor", v)}
        />
      ) : null}
      {comments.map((c) => (
        <BlockCommentForm
          key={c.sourceKey}
          props={props}
          commentKey={c.sourceKey}
        />
      ))}
      {!props.readonly ? (
        <>
          <Select
            label={m.visualComments()}
            data={[
              { value: "before", label: m.radarCommentBefore() },
              { value: "after", label: m.radarCommentAfter() },
            ]}
            value={d.value.position}
            onChange={(v) => d.set("position", v as typeof d.value.position)}
          />
          <MyoxusTextInput
            label={m.visualComments()}
            value={d.value.text}
            onChange={(v) => d.set("text", v)}
          />
          <Button
            disabled={!d.value.text}
            onClick={() => {
              if (!d.commit("editBlockComment", [d.value]).diagnostic)
                d.set("text", "");
            }}
          >
            {t["Save"]()}
          </Button>
        </>
      ) : null}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
    </Stack>
  );
}
function BlockCommentForm({
  props,
  commentKey,
}: {
  props: BlockReactHostProps;
  commentKey: string;
}) {
  const t = useI18n(),
    comment = props.model.comments.find((c) => c.sourceKey === commentKey)!,
    d = useBlockDraft(
      {
        text: comment.text,
        anchor: comment.anchorKey ?? "",
        position: comment.position === "inline" ? "before" : comment.position,
      },
      props,
    ),
    [deleting, setDeleting] = useState(false);
  return (
    <Stack>
      <MyoxusTextInput
        label={m.visualComments()}
        value={d.value.text}
        disabled={props.readonly}
        onChange={(v) => d.set("text", v)}
      />
      <Select
        label={m.architectureEndpointObject()}
        value={d.value.anchor}
        data={anchors(props)}
        disabled={props.readonly}
        onChange={(v) => d.set("anchor", v)}
      />
      <Select
        label={m.timelineInsertPosition()}
        value={d.value.position}
        data={[
          { value: "before", label: m.radarCommentBefore() },
          { value: "after", label: m.radarCommentAfter() },
        ]}
        disabled={props.readonly}
        onChange={(v) => d.set("position", v as typeof d.value.position)}
      />
      <Group>
        <Button
          disabled={props.readonly}
          onClick={() =>
            d.commit("editBlockComment", [
              {
                key: commentKey,
                text: d.value.text,
                ...(d.value.anchor !== comment.anchorKey ||
                (comment.position !== "inline" &&
                  d.value.position !== comment.position)
                  ? { anchor: d.value.anchor, position: d.value.position }
                  : {}),
              },
            ])
          }
        >
          {t["Save"]()}
        </Button>
        <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
          {m.visualDeleteComment()}
        </Button>
      </Group>
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDeleteComment()}
        confirmText={m.visualDeleteComment()}
        onConfirm={() => {
          if (
            !d.commit("editBlockComment", [{ key: commentKey, delete: true }])
              .diagnostic
          )
            setDeleting(false);
        }}
      >
        <MyoxusText>{comment.text}</MyoxusText>
      </ConfirmModal>
    </Stack>
  );
}
export function BlockCommentsPopover({
  props,
  anchorKey,
  marker = false,
  count = 0,
  commentKey,
}: {
  props: BlockReactHostProps;
  anchorKey?: string;
  marker?: boolean;
  count?: number;
  commentKey?: string;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover fitViewport opened={opened} onChange={setOpened}>
      <PopoverTarget>
        {marker ? (
          <IconButton
            icon={<CommentIcon />}
            aria-label={`${m.visualComments()} · ${count}`}
            onClick={() => {
              props.onParentIntent(null);
              setOpened(!opened);
            }}
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
            commentKey ? (
              <BlockCommentForm props={props} commentKey={commentKey} />
            ) : (
              <BlockCommentsForm props={props} anchorKey={anchorKey} />
            )
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
