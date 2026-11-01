// SPDX-License-Identifier: AGPL-3.0-or-later

import { CommentIcon } from "@myoxus/icons";
import {
  Button,
  Group,
  IconButton,
  MyoxusTextInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type SankeyCommand,
  type SankeySelection,
  type MermaidSankeyReactHostProps,
} from "@virgultum/block-mermaid";
import { useState } from "react";

function CommentDraft({
  initial,
  onSave,
  onDelete,
  onSelect,
  readonly,
}: {
  readonly initial: string;
  readonly readonly: boolean;
  readonly onSave: (text: string) => boolean;
  readonly onDelete?: () => void;
  readonly onSelect?: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <Group>
      {onSelect ? (
        <IconButton
          icon={<CommentIcon />}
          aria-label={messages.visualComments()}
          tooltip={messages.visualComments()}
          onClick={onSelect}
        />
      ) : null}
      <MyoxusTextInput
        label={messages.visualComments()}
        value={text}
        onChange={setText}
        disabled={readonly}
      />
      <Button
        disabled={readonly || text === initial}
        onClick={() => {
          if (onSave(text) && !initial) setText("");
        }}
      >
        {messages.architectureApply()}
      </Button>
      {onDelete ? (
        <Button variant="plain" disabled={readonly} onClick={onDelete}>
          {messages.visualDelete()}
        </Button>
      ) : null}
    </Group>
  );
}

export function SankeyComments({
  props,
  linkId,
  onApply,
  onSelect,
}: {
  readonly props: MermaidSankeyReactHostProps;
  readonly linkId?: string;
  readonly onApply: (command: SankeyCommand) => boolean;
  readonly onSelect: (selection: SankeySelection) => void;
}) {
  return (
    <Stack>
      {props.model.comments
        .filter((comment) => comment.linkId === linkId)
        .map((comment) => (
          <CommentDraft
            key={`${comment.id}:${comment.text}`}
            initial={comment.text}
            readonly={props.readonly}
            onSave={(text) =>
              onApply({ type: "comment.edit", id: comment.id, text })
            }
            onDelete={() => onApply({ type: "comment.delete", id: comment.id })}
            onSelect={() => onSelect({ kind: "comment", id: comment.id })}
          />
        ))}
      {!props.readonly ? (
        <CommentDraft
          initial=""
          readonly={false}
          onSave={(text) => onApply({ type: "comment.add", linkId, text })}
        />
      ) : null}
    </Stack>
  );
}
