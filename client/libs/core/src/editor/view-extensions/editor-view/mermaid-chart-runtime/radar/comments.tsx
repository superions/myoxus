// SPDX-License-Identifier: AGPL-3.0-or-later

import { MoreHorizontalIcon } from "@myoxus/icons";
import {
  Alert,
  Button,
  CountIndicator,
  DataChartCommentMarker,
  Group,
  IconButton,
  MyoxusText,
  MyoxusTextInput,
  MyoxusTextarea,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Stack,
} from "@myoxus/ui-facade";
import type {
  MermaidRadarCommentAnchor,
  MermaidRadarCommentCommand,
  MermaidRadarReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useRef, useState } from "react";

export function MermaidRadarCommentMarker({
  anchor,
  onCommand,
  props,
}: {
  readonly anchor: MermaidRadarCommentAnchor;
  readonly onCommand: (command: MermaidRadarCommentCommand) => boolean;
  readonly props: MermaidRadarReactHostProps;
}) {
  const comments = props.model.comments.filter((comment) =>
    anchor.kind === "diagram"
      ? comment.anchor.kind === "diagram" ||
        (comment.anchor.kind === "metadata" && comment.anchor.id === "title") ||
        (props.readonly &&
          (comment.anchor.kind === "metadata" ||
            comment.anchor.kind === "options"))
      : sameAnchor(comment.anchor, anchor),
  );
  return (
    <DataChartCommentMarker
      addLabel={props.labels.addComment}
      applyLabel={props.labels.apply}
      deleteLabel={props.labels.delete}
      invalidLabel={props.labels.invalid}
      items={comments}
      label={props.labels.comments}
      onAdd={(text) =>
        onCommand({ anchor, position: "after", text, type: "comment.add" })
      }
      onDelete={(commentId) => onCommand({ commentId, type: "comment.delete" })}
      onUpdate={(commentId, text) =>
        onCommand({ commentId, text, type: "comment.edit" })
      }
      readonly={props.readonly}
      revision={props.model.sourceHash}
    />
  );
}

function sameAnchor(
  left: MermaidRadarCommentAnchor,
  right: MermaidRadarCommentAnchor,
) {
  return (
    left.kind === right.kind &&
    (!("id" in left) || ("id" in right && left.id === right.id))
  );
}

function commentAnchorLabel(
  comment: MermaidRadarReactHostProps["model"]["comments"][number],
  props: MermaidRadarReactHostProps,
) {
  const { anchor } = comment;
  const objectLabel =
    anchor.kind === "axis"
      ? `${props.labels.axis}: ${
          props.model.axes.find((axis) => axis.id === anchor.id)?.label ??
          props.labels.invalid
        }`
      : anchor.kind === "curve"
        ? `${props.labels.curve}: ${
            props.model.curves.find((curve) => curve.id === anchor.id)?.label ??
            props.labels.invalid
          }`
        : anchor.kind === "options"
          ? props.labels.options
          : anchor.kind === "metadata"
            ? anchor.id === "accessibilityTitle"
              ? props.labels.accessibilityTitle
              : props.labels.accessibilityDescription
            : props.model.title || props.labels.visualEditor;
  const record = props.model.sourceDocument.records.find(
    (candidate) => candidate.id === comment.sourceRecordId,
  );
  return props.labels.commentAnchor(
    objectLabel,
    comment.position === "before"
      ? props.labels.commentBefore
      : props.labels.commentAfter,
    (record?.range.startLine ?? 0) + 1,
  );
}

export function MermaidRadarCommentsEditor({
  anchor,
  draft,
  includeAnchorKind = false,
  onCommand,
  onDraftChange,
  props,
}: {
  readonly anchor: MermaidRadarCommentAnchor;
  readonly draft: string;
  readonly includeAnchorKind?: boolean;
  readonly onCommand: (command: MermaidRadarCommentCommand) => boolean;
  readonly onDraftChange: (value: string) => void;
  readonly props: MermaidRadarReactHostProps;
}) {
  const comments = props.model.comments.filter(
    (comment) =>
      sameAnchor(comment.anchor, anchor) ||
      (includeAnchorKind && comment.anchor.kind === anchor.kind),
  );
  return (
    <Stack gap="xs">
      {comments.length ? (
        comments.map((comment) => (
          <CommentEditor
            comment={comment}
            key={comment.id}
            onCommand={onCommand}
            props={props}
          />
        ))
      ) : (
        <MyoxusText typographySlot="caption">
          {props.labels.comments}
        </MyoxusText>
      )}
      {props.readonly ? null : (
        <Group align="flex-end" wrap="nowrap">
          <MyoxusTextInput
            aria-label={props.labels.addComment}
            onChange={onDraftChange}
            value={draft}
          />
          <Button
            disabled={!draft.trim()}
            onClick={() => {
              if (
                onCommand({
                  anchor,
                  position: "after",
                  text: draft.trim(),
                  type: "comment.add",
                })
              )
                onDraftChange("");
            }}
          >
            {props.labels.addComment}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function CommentEditor({
  comment,
  onCommand,
  props,
}: {
  readonly comment: MermaidRadarReactHostProps["model"]["comments"][number];
  readonly onCommand: (command: MermaidRadarCommentCommand) => boolean;
  readonly props: MermaidRadarReactHostProps;
}) {
  const [value, setValue] = useState(comment.text);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const anchorLabel = commentAnchorLabel(comment, props);
  useEffect(() => setValue(comment.text), [comment.id, comment.text]);
  return (
    <Stack gap={0}>
      <MyoxusText typographySlot="caption">{anchorLabel}</MyoxusText>
      <Group align="flex-end" wrap="nowrap">
        <MyoxusTextInput
          aria-label={`${props.labels.comments}: ${anchorLabel}`}
          disabled={props.readonly}
          onChange={setValue}
          value={value}
        />
        {props.readonly ? null : (
          <>
            <Button
              disabled={!value.trim() || value.trim() === comment.text}
              onClick={() =>
                onCommand({
                  commentId: comment.id,
                  text: value.trim(),
                  type: "comment.edit",
                })
              }
              variant="plain"
            >
              {props.labels.apply}
            </Button>
            {confirmingDelete ? (
              <Group gap="xs" wrap="nowrap">
                <Button
                  onClick={() => setConfirmingDelete(false)}
                  variant="plain"
                >
                  {props.labels.cancel}
                </Button>
                <Button
                  color="myoxusError"
                  onClick={() =>
                    onCommand({ commentId: comment.id, type: "comment.delete" })
                  }
                >
                  {props.labels.delete}
                </Button>
              </Group>
            ) : (
              <Button
                color="myoxusError"
                onClick={() => setConfirmingDelete(true)}
                variant="plain"
              >
                {props.labels.delete}
              </Button>
            )}
          </>
        )}
      </Group>
    </Stack>
  );
}

export function MermaidRadarMorePopover({
  onApply,
  onCommand,
  onOpenedChange,
  opened,
  props,
}: {
  readonly onApply: (title: string, description: string) => boolean;
  readonly onCommand: (command: MermaidRadarCommentCommand) => boolean;
  readonly onOpenedChange: (opened: boolean) => void;
  readonly opened: boolean;
  readonly props: MermaidRadarReactHostProps;
}) {
  const [title, setTitle] = useState(props.model.accessibilityTitle);
  const [description, setDescription] = useState(
    props.model.accessibilityDescription,
  );
  const [titleCommentDraft, setTitleCommentDraft] = useState("");
  const [descriptionCommentDraft, setDescriptionCommentDraft] = useState("");
  const [sourceConflict, setSourceConflict] = useState(false);
  const openedRef = useRef(false);
  const baseRef = useRef({
    description: props.model.accessibilityDescription,
    sourceHash: props.model.sourceHash,
    title: props.model.accessibilityTitle,
  });
  const draftRef = useRef({ description, title });
  draftRef.current = { description, title };
  useEffect(() => {
    if (!opened) {
      openedRef.current = false;
      return;
    }
    const nextBase = {
      description: props.model.accessibilityDescription,
      sourceHash: props.model.sourceHash,
      title: props.model.accessibilityTitle,
    };
    if (!openedRef.current) {
      openedRef.current = true;
      baseRef.current = nextBase;
      setTitle(nextBase.title);
      setDescription(nextBase.description);
      setSourceConflict(false);
      return;
    }
    if (baseRef.current.sourceHash === nextBase.sourceHash) return;
    const ownerChanged =
      baseRef.current.title !== nextBase.title ||
      baseRef.current.description !== nextBase.description;
    const draftChanged =
      draftRef.current.title.trim() !== baseRef.current.title ||
      draftRef.current.description.trim() !== baseRef.current.description;
    if (ownerChanged && draftChanged) {
      setSourceConflict(true);
      return;
    }
    baseRef.current = nextBase;
    setSourceConflict(false);
    if (ownerChanged) {
      setTitle(nextBase.title);
      setDescription(nextBase.description);
    }
  }, [opened, props.model.sourceHash]);
  const changed =
    title.trim() !== props.model.accessibilityTitle ||
    description.trim() !== props.model.accessibilityDescription;
  const preview = changed
    ? props.onPreviewCommand({
        description: description.trim(),
        title: title.trim(),
        type: "diagram.accessibility",
      })
    : null;
  const validationMessage =
    preview?.diagnosis === "radar.metadata-comments-present"
      ? props.labels.commentOwnerRemovalBlocked
      : props.labels.invalid;
  return (
    <Popover
      fitViewport
      onChange={onOpenedChange}
      opened={opened}
      position="bottom-end"
    >
      <PopoverTarget>
        <CountIndicator
          count={
            props.model.comments.filter(
              (comment) => comment.anchor.kind === "metadata",
            ).length
          }
        >
          <IconButton
            aria-label={props.labels.more}
            aria-pressed={opened}
            icon={<MoreHorizontalIcon />}
            onClick={() => onOpenedChange(!opened)}
            tooltip={props.labels.more}
            tooltipOptions={opened ? { opened: false } : undefined}
            variant={opened ? "solid" : "plain"}
          />
        </CountIndicator>
      </PopoverTarget>
      <PopoverContent>
        <Scrollable.Viewport autosize maxHeight="floating" offsetScrollbars="y">
          <Stack gap="xs">
            {sourceConflict ? (
              <Alert color="myoxusWarning" variant="light">
                {props.labels.sourceChanged}
              </Alert>
            ) : null}
            <MyoxusTextInput
              aria-label={props.labels.accessibilityTitle}
              error={
                changed && !preview?.changed ? validationMessage : undefined
              }
              label={props.labels.accessibilityTitle}
              onChange={setTitle}
              value={title}
            />
            <MyoxusTextarea
              aria-label={props.labels.accessibilityDescription}
              error={
                changed && !preview?.changed ? validationMessage : undefined
              }
              label={props.labels.accessibilityDescription}
              onChange={setDescription}
              value={description}
            />
            {props.model.sourceDocument.records.some(
              (record) =>
                record.kind === "metadata" &&
                record.field === "accessibilityTitle",
            ) ? (
              <MermaidRadarCommentsEditor
                anchor={{ id: "accessibilityTitle", kind: "metadata" }}
                draft={titleCommentDraft}
                onCommand={onCommand}
                onDraftChange={setTitleCommentDraft}
                props={props}
              />
            ) : null}
            {props.model.sourceDocument.records.some(
              (record) =>
                record.kind === "metadata" &&
                record.field === "accessibilityDescription",
            ) ? (
              <MermaidRadarCommentsEditor
                anchor={{ id: "accessibilityDescription", kind: "metadata" }}
                draft={descriptionCommentDraft}
                onCommand={onCommand}
                onDraftChange={setDescriptionCommentDraft}
                props={props}
              />
            ) : null}
            <Group justify="flex-end">
              <Button onClick={() => onOpenedChange(false)} variant="plain">
                {props.labels.cancel}
              </Button>
              <Button
                disabled={sourceConflict || !changed || !preview?.changed}
                onClick={() => {
                  if (preview?.changed && onApply(title, description))
                    onOpenedChange(false);
                }}
              >
                {props.labels.apply}
              </Button>
            </Group>
          </Stack>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
