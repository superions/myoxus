// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidKanbanReactHostProps,
  type KanbanCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";
export function KanbanCommentsPopover({
  props,
  anchorId,
  commentId,
  onClose,
}: {
  props: MermaidKanbanReactHostProps;
  anchorId: string | null;
  commentId?: string;
  onClose: () => void;
}) {
  const [basis, setBasis] = useState(props.model.sourceDocument.source);
  const [draft, setDraft] = useState<{ id?: string; text: string }>({
    text: "",
  });
  const [notice, setNotice] = useState(false);
  const readonly =
    props.readonly ||
    props.model.ambiguous ||
    Boolean(
      anchorId &&
      ![...props.model.columns, ...props.model.cards].find(
        (node) => node.id === anchorId,
      )?.writable,
    );
  const comments = props.model.comments.filter((comment) =>
    commentId
      ? comment.id === commentId
      : comment.anchorId === anchorId && comment.affinity === "object",
  );
  const apply = (command: KanbanCommand) => {
    const result = props.onCommand(command, basis);
    if (result.changed || result.reason === "no-change") {
      setBasis(result.source);
      setDraft({ text: "" });
      setNotice(false);
    } else setNotice(true);
  };
  return (
    <Stack>
      {notice ? <Alert>{messages.ganttDiagnosticConflict()}</Alert> : null}
      {comments.map((comment) => (
        <Group key={comment.id}>
          <MyoxusText>{comment.text}</MyoxusText>
          {!readonly ? (
            <>
              <Button
                variant="plain"
                onClick={() => setDraft({ id: comment.id, text: comment.text })}
              >
                {messages.displayEdit()}
              </Button>
              <Button
                variant="destructive"
                onClick={() => apply({ type: "comment", id: comment.id })}
              >
                {messages.visualDelete()}
              </Button>
            </>
          ) : null}
        </Group>
      ))}
      {!readonly ? (
        <>
          <MyoxusTextInput
            label={messages.visualComments()}
            value={draft.text}
            onChange={(text) => setDraft({ ...draft, text })}
          />
          <Button
            disabled={!draft.text.trim()}
            onClick={() =>
              apply({
                type: "comment",
                id: draft.id,
                anchorId,
                positionId: commentId,
                text: draft.text,
              })
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
