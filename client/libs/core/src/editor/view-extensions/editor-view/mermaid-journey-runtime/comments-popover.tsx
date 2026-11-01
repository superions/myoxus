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
  type MermaidJourneyReactHostProps,
  type JourneyCommand,
} from "@virgultum/block-mermaid";
import { useLayoutEffect, useState } from "react";
export type JourneyCommentFormDraft = {
  basis: string;
  draft: { id?: string; text: string };
};
export function JourneyCommentsPopover({
  props,
  anchorId,
  commentId,
  onClose,
  initialForm,
  onFormDraft,
}: {
  initialForm?: JourneyCommentFormDraft;
  onFormDraft?: (value: JourneyCommentFormDraft) => void;
  props: MermaidJourneyReactHostProps;
  anchorId: string | null;
  commentId?: string;
  onClose: () => void;
}) {
  const [basis, setBasis] = useState(
    initialForm?.basis ?? props.model.sourceDocument.source,
  );
  const [draft, setDraft] = useState<{ id?: string; text: string }>(
    initialForm?.draft ?? { text: "" },
  );
  const [notice, setNotice] = useState(false);
  useLayoutEffect(() => {
    onFormDraft?.({ basis, draft });
  }, [basis, draft, onFormDraft]);
  const readonly =
    props.readonly ||
    props.model.ambiguous ||
    Boolean(
      anchorId &&
      ![...props.model.sections, ...props.model.steps].find(
        (node) => node.id === anchorId,
      )?.writable,
    );
  const comments = props.model.comments.filter((comment) =>
    commentId
      ? comment.id === commentId
      : comment.anchorId === anchorId && comment.affinity === "object",
  );
  const apply = (command: JourneyCommand) => {
    const result = props.onCommand(command, basis);
    if (result.changed || result.reason === "no-change") {
      setBasis(result.source);
      setDraft({ text: "" });
      setNotice(false);
    } else setNotice(true);
  };
  return (
    <Stack>
      {notice && !initialForm ? (
        <Alert>{messages.ganttDiagnosticConflict()}</Alert>
      ) : null}
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
      {readonly && draft.text ? <MyoxusText>{draft.text}</MyoxusText> : null}
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
