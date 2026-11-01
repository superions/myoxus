// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidTreemapReactHostProps,
  type TreemapCommand,
  type TreemapSelection,
} from "@virgultum/block-mermaid";
import { useState } from "react";

export function TreemapComments({
  onApply,
  onSelect,
  props,
  selection,
}: {
  readonly onApply: (command: TreemapCommand) => boolean;
  readonly onSelect: (selection: TreemapSelection) => void;
  readonly props: MermaidTreemapReactHostProps;
  readonly selection: TreemapSelection;
}) {
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [editingText, setEditingText] = useState("");
  const anchor =
    selection?.kind === "node" || selection?.kind === "class-def"
      ? ({ kind: selection.kind, id: selection.id } as const)
      : ({ kind: "diagram" } as const);
  return (
    <Stack>
      {props.model.comments.map((comment) => {
        const anchorId = "id" in comment.anchor ? comment.anchor.id : undefined;
        const node =
          comment.anchor.kind === "node"
            ? props.model.nodes.find((candidate) => candidate.id === anchorId)
            : undefined;
        const definition =
          comment.anchor.kind === "class-def"
            ? props.model.classDefs.find(
                (candidate) => candidate.id === anchorId,
              )
            : undefined;
        const anchorLabel =
          node?.label ?? definition?.name ?? messages.treemapDiagramComments();
        return (
          <Stack key={comment.id}>
            <MyoxusText typographySlot="caption">{anchorLabel}</MyoxusText>
            {editingId === comment.id ? (
              <Group align="flex-end" wrap="nowrap">
                <MyoxusTextInput
                  autoFocus
                  label={messages.treemapEditComment()}
                  value={editingText}
                  onChange={setEditingText}
                />
                <Button
                  disabled={!editingText.trim() || editingText === comment.text}
                  onClick={() => {
                    if (
                      onApply({
                        type: "comment.update",
                        id: comment.id,
                        text: editingText,
                      })
                    )
                      setEditingId(undefined);
                  }}
                >
                  {messages.architectureApply()}
                </Button>
                <Button variant="plain" onClick={() => setEditingId(undefined)}>
                  {messages.cancel()}
                </Button>
              </Group>
            ) : (
              <Group justify="space-between" wrap="nowrap">
                <Button
                  variant="plain"
                  onClick={() => onSelect({ kind: "comment", id: comment.id })}
                  onDoubleClick={() => {
                    if (props.readonly) return;
                    setEditingId(comment.id);
                    setEditingText(comment.text);
                  }}
                >
                  {comment.text}
                </Button>
                {!props.readonly ? (
                  <>
                    <Button
                      variant="plain"
                      onClick={() => {
                        setEditingId(comment.id);
                        setEditingText(comment.text);
                      }}
                    >
                      {messages.treemapEditComment()}
                    </Button>
                    <Button
                      color="myoxusError"
                      variant="plain"
                      onClick={() =>
                        onApply({ type: "comment.delete", id: comment.id })
                      }
                    >
                      {messages.visualDelete()}
                    </Button>
                  </>
                ) : null}
              </Group>
            )}
          </Stack>
        );
      })}
      {!props.model.comments.length ? (
        <MyoxusText>{messages.previewEmpty()}</MyoxusText>
      ) : null}
      {!props.readonly ? (
        <Group align="flex-end" wrap="nowrap">
          <MyoxusTextInput
            label={messages.visualComments()}
            value={text}
            onChange={setText}
          />
          <Button
            disabled={!text.trim()}
            onClick={() => {
              if (onApply({ type: "comment.add", anchor, text })) setText("");
            }}
          >
            {messages.structuredAddEntry()}
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}
