// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Select,
  Stack,
  IconButton,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidPacketReactHostProps,
  type PacketCommentAnchor,
  type PacketCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";
import { CommentIcon } from "@myoxus/icons";
export function PacketCommentsPopover({
  props,
  anchor,
  commentKey,
  onClose,
}: {
  props: MermaidPacketReactHostProps;
  anchor: PacketCommentAnchor;
  commentKey?: string;
  onClose: () => void;
}) {
  const [basis, setBasis] = useState(props.model.sourceDocument.source);
  const [draft, setDraft] = useState<{ id?: string; text: string }>({
    text: "",
  });
  const [position, setPosition] = useState(anchor.position);
  const [notice, setNotice] = useState<string>();
  const readonly =
    props.readonly ||
    props.displayOnly ||
    Boolean(props.model.issues.length || props.model.diagnostics.length);
  const comments = (props.model.comments ?? []).filter((c) =>
    commentKey
      ? c.id === commentKey
      : c.anchorKind === anchor.anchorKind && c.anchorId === anchor.anchorId,
  );
  const apply = (command: PacketCommand) => {
    const result = props.onCommand(command, basis);
    if (result.changed || result.reason === "no-change") {
      setBasis(result.source);
      setDraft({ text: "" });
      setNotice(undefined);
    } else setNotice(result.diagnostic ?? messages.ganttDiagnosticConflict());
  };
  return (
    <Stack data-myoxus-editor-keyboard-owner="packet-comments">
      {notice ? <Alert>{notice}</Alert> : null}
      {comments.map((comment, index) => (
        <Group key={comment.id}>
          <MyoxusText>{comment.text}</MyoxusText>
          {!readonly ? (
            <>
              <Button
                variant="plain"
                onClick={() =>
                  setDraft({ id: comment.id, text: comment.text ?? "" })
                }
              >
                {messages.displayEdit()}
              </Button>
              <Button
                variant="destructive"
                onClick={() =>
                  apply({ type: "comment-delete", commentKey: comment.id })
                }
              >
                {messages.visualDelete()}
              </Button>
              {index > 0 &&
              comments[index - 1]?.position === comment.position ? (
                <Button
                  variant="plain"
                  aria-label={messages.treemapMoveUp()}
                  onClick={() =>
                    apply({
                      type: "comment-reorder",
                      commentKey: comment.id,
                      targetKey: comments[index - 1]!.id,
                    })
                  }
                >
                  ↑
                </Button>
              ) : null}
            </>
          ) : null}
        </Group>
      ))}
      {!readonly && (anchor.anchorKind !== "diagram" || anchor.anchorId) ? (
        <>
          <MyoxusTextInput
            label={messages.visualComments()}
            value={draft.text}
            onChange={(text) => setDraft({ ...draft, text })}
          />
          {!draft.id && anchor.anchorKind !== "diagram" ? (
            <Select
              label={messages.timelineMetadataForm()}
              data={["before", "inline", "after"].map((value) => ({
                value,
                label:
                  value === "before"
                    ? messages.radarCommentBefore()
                    : value === "after"
                      ? messages.radarCommentAfter()
                      : messages.packetCommentInline(),
              }))}
              value={position}
              onChange={(value) => setPosition(value as typeof position)}
            />
          ) : null}
          <Button
            disabled={!draft.text.trim()}
            onClick={() =>
              apply(
                draft.id
                  ? {
                      type: "comment-edit",
                      commentKey: draft.id,
                      text: draft.text,
                    }
                  : {
                      type: "comment-add",
                      anchor: { ...anchor, position },
                      text: draft.text,
                    },
              )
            }
          >
            {messages.architectureApply()}
          </Button>
        </>
      ) : null}
      <Button variant="plain" onClick={onClose}>
        {messages.cancel()}
      </Button>
    </Stack>
  );
}

export type PacketCommentTarget = {
  anchor: PacketCommentAnchor;
  row?: number;
  commentKey?: string;
};

export function PacketCommentMarker({
  props,
  target,
  active,
  visible,
  writable,
  selectedFieldId,
  disabled,
  onOpen,
  onClose,
}: {
  props: MermaidPacketReactHostProps;
  target: PacketCommentTarget;
  active?: PacketCommentTarget;
  visible: boolean;
  writable: boolean;
  selectedFieldId?: string;
  disabled: boolean;
  onOpen: (target: PacketCommentTarget) => void;
  onClose: () => void;
}) {
  const { anchor, row, commentKey } = target;
  const comments = (props.model.comments ?? []).filter((comment) =>
    commentKey
      ? comment.id === commentKey
      : comment.anchorKind === anchor.anchorKind &&
        comment.anchorId === anchor.anchorId,
  );
  if (
    !visible ||
    (!comments.length &&
      (!writable ||
        (anchor.anchorKind === "diagram" && !anchor.anchorId) ||
        (anchor.anchorKind === "field" && anchor.anchorId !== selectedFieldId)))
  )
    return null;
  const opened = Boolean(
    active &&
    active.anchor.anchorKind === anchor.anchorKind &&
    active.anchor.anchorId === anchor.anchorId &&
    active.row === row &&
    active.commentKey === commentKey,
  );
  const owner =
    anchor.anchorKind === "field"
      ? props.model.fields.find((field) => field.id === anchor.anchorId)?.label
      : anchor.anchorKind === "title"
        ? messages.titlePlaceholder()
        : anchor.anchorKind === "accessibility-title"
          ? messages.visualAccessibilityTitle()
          : anchor.anchorKind === "accessibility-description"
            ? messages.visualAccessibilityDescription()
            : anchor.anchorKind === "end"
              ? messages.selectedPacketEndBit()
              : messages.packetBitLayout();
  const line = props.model.sourceDocument.records.find(
    (record) => record.sourceKey === anchor.anchorId,
  )?.range.line;
  const label = `${owner}${line ? ` · ${line}` : ""} · ${messages.radarCommentCount(comments.length)}`;
  return (
    <Popover
      opened={opened}
      onChange={(open) => {
        if (!open && opened) onClose();
      }}
      fitViewport
      returnFocus={false}
      trapFocus
      withArrow
    >
      <PopoverTarget>
        <IconButton
          aria-label={label}
          tooltip={label}
          disabled={disabled}
          onClick={() => (opened ? onClose() : onOpen(target))}
        >
          <CommentIcon />
        </IconButton>
      </PopoverTarget>
      <PopoverContent data-myoxus-editor-keyboard-owner="packet-comments">
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <PacketCommentsPopover
              props={props}
              anchor={anchor}
              commentKey={commentKey}
              onClose={onClose}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
