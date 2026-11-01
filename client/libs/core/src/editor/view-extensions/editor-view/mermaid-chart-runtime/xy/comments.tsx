// SPDX-License-Identifier: AGPL-3.0-or-later

import { MoreHorizontalIcon } from "@myoxus/icons";
import {
  Button,
  DataChartCommentMarker,
  Group,
  IconButton,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import type {
  MermaidXyCommentAnchor,
  MermaidXyCommentCommand,
  MermaidXyReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useRef, useState } from "react";

export function MermaidXyCommentMarker({
  anchor,
  onCommand,
  props,
}: {
  readonly anchor: MermaidXyCommentAnchor;
  readonly onCommand: (command: MermaidXyCommentCommand) => boolean;
  readonly props: MermaidXyReactHostProps;
}) {
  const comments = props.model.comments.filter(
    (comment) =>
      (anchor.kind === "diagram" &&
        (comment.anchor.kind === "diagram" ||
          comment.anchor.kind === "metadata")) ||
      (comment.anchor.kind === anchor.kind &&
        anchor.kind !== "diagram" &&
        "id" in comment.anchor &&
        comment.anchor.id === anchor.id),
  );
  const plot =
    anchor.kind === "plot"
      ? props.model.plots.find((candidate) => candidate.id === anchor.id)
      : undefined;
  const anchorLabel =
    anchor.kind === "x-axis"
      ? props.labels.x
      : anchor.kind === "y-axis"
        ? props.labels.y
        : plot
          ? plot.titleExplicit
            ? plot.title
            : `${plot.kind === "bar" ? props.labels.bar : props.labels.line} ${plot.order + 1}`
          : "";
  return (
    <DataChartCommentMarker
      addLabel={props.labels.addComment}
      applyLabel={props.labels.apply}
      deleteLabel={props.labels.delete}
      invalidLabel={props.labels.invalid}
      items={comments}
      label={
        anchorLabel
          ? `${props.labels.comments} · ${anchorLabel}`
          : props.labels.comments
      }
      onAdd={(text) =>
        onCommand({ anchor, position: "after", text, type: "comment.add" })
      }
      onDelete={(commentId) => onCommand({ commentId, type: "comment.delete" })}
      onUpdate={(commentId, text) =>
        onCommand({ commentId, text, type: "comment.update" })
      }
      readonly={props.readonly}
      revision={props.model.sourceHash}
    />
  );
}

export function MermaidXyAccessibilityPopover({
  onApply,
  onOpenedChange,
  opened,
  props,
}: {
  readonly onApply: (title: string, description: string) => boolean;
  readonly onOpenedChange: (opened: boolean) => void;
  readonly opened: boolean;
  readonly props: MermaidXyReactHostProps;
}) {
  const sourceHashRef = useRef(props.model.sourceHash);
  const [title, setTitle] = useState(props.model.accessibilityTitle);
  const [description, setDescription] = useState(
    props.model.accessibilityDescription,
  );
  useEffect(() => {
    if (sourceHashRef.current === props.model.sourceHash) return;
    sourceHashRef.current = props.model.sourceHash;
    onOpenedChange(false);
    setTitle(props.model.accessibilityTitle);
    setDescription(props.model.accessibilityDescription);
  }, [
    props.model.accessibilityDescription,
    props.model.accessibilityTitle,
    props.model.sourceHash,
    onOpenedChange,
  ]);
  const invalidTitle = /[\r\n]/.test(title);
  const invalidDescription = description
    .split(/\r\n|\r|\n/)
    .some((line) => line.trim() === "}");
  return (
    <Popover onChange={onOpenedChange} opened={opened} returnFocus trapFocus>
      <PopoverTarget>
        <IconButton
          aria-label={props.labels.more}
          aria-pressed={opened}
          icon={<MoreHorizontalIcon />}
          onClick={() => onOpenedChange(!opened)}
          tooltip={props.labels.more}
          variant={opened ? "solid" : "plain"}
        />
      </PopoverTarget>
      <PopoverContent>
        <Stack gap="xs">
          <MyoxusTextInput
            aria-label={props.labels.accessibilityTitle}
            error={invalidTitle ? props.labels.invalid : undefined}
            onChange={setTitle}
            value={title}
          />
          <Textarea
            aria-label={props.labels.accessibilityDescription}
            error={invalidDescription ? props.labels.invalid : undefined}
            onChange={setDescription}
            value={description}
          />
          <Group justify="flex-end">
            <Button onClick={() => onOpenedChange(false)} variant="plain">
              {props.labels.cancel}
            </Button>
            <Button
              disabled={invalidTitle || invalidDescription}
              onClick={() => {
                if (onApply(title, description)) onOpenedChange(false);
              }}
            >
              {props.labels.apply}
            </Button>
          </Group>
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
