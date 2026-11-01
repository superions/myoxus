// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Scrollable,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidTimelineReactHostProps,
  type TimelineAnchor,
  type TimelineCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";

export function timelineAnchorLabel(
  props: MermaidTimelineReactHostProps,
  anchor: TimelineAnchor,
) {
  return anchor.kind === "diagram"
    ? messages.visualEditorLabel()
    : ([
        ...props.model.sections,
        ...props.model.periods,
        ...props.model.events,
      ].find((item) => item.id === anchor.id)?.label ??
        messages.visualComments());
}

/** Opening source is the form basis; remote changes never silently retarget an edit. */
export function TimelineComments({
  props,
  anchor,
  onClose,
}: {
  readonly props: MermaidTimelineReactHostProps;
  readonly anchor?: TimelineAnchor;
  readonly onClose: () => void;
}) {
  const [basis, setBasis] = useState(props.model.sourceDocument.source);
  const [draft, setDraft] = useState<{ id?: string; text: string }>({
    text: "",
  });
  const [notice, setNotice] = useState<string>();
  const target = anchor ?? { kind: "diagram", id: null };
  const comments = props.model.comments.filter(
    (c) =>
      !anchor || (c.anchor.kind === anchor.kind && c.anchor.id === anchor.id),
  );
  const command: TimelineCommand = draft.id
    ? { type: "comment-edit", id: draft.id, text: draft.text }
    : { type: "comment-add", anchor: target, text: draft.text };
  const preview = props.onPreviewCommand(command, basis);
  const apply = (intent: TimelineCommand) => {
    const result = props.onCommand(intent, basis);
    if (result.changed || result.reason === "no-change") {
      setBasis(result.source);
      setDraft({ text: "" });
      setNotice(undefined);
    } else
      setNotice(
        result.reason === "conflict"
          ? messages.ganttDiagnosticConflict()
          : messages.ganttCommandRejected(),
      );
  };
  return (
    <Stack
      data-myoxus-editor-keyboard-owner="timeline-comments"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          props.onConsumeEscape(event.nativeEvent);
          onClose();
        }
      }}
    >
      <Scrollable.Viewport autosize maxHeight="floating">
        <Stack>
          <MyoxusText>
            {messages.visualComments()} · {timelineAnchorLabel(props, target)}
          </MyoxusText>
          {comments.map((comment) => (
            <Stack key={comment.id}>
              <MyoxusText>{comment.text}</MyoxusText>
              <MyoxusText>
                {timelineAnchorLabel(props, comment.anchor)}
              </MyoxusText>
              {!props.readonly ? (
                <Group>
                  <Button
                    variant="plain"
                    onClick={() => {
                      setBasis(props.model.sourceDocument.source);
                      setDraft({ id: comment.id, text: comment.text });
                      setNotice(undefined);
                    }}
                  >
                    {messages.displayEdit()}
                  </Button>
                  <Button
                    variant="plain"
                    onClick={() =>
                      apply({ type: "comment-delete", id: comment.id })
                    }
                  >
                    {messages.visualDeleteComment()}
                  </Button>
                </Group>
              ) : null}
            </Stack>
          ))}
          {!props.readonly ? (
            <>
              <MyoxusTextInput
                label={
                  draft.id
                    ? messages.displayEdit()
                    : messages.architectureAddComment()
                }
                value={draft.text}
                onChange={(text) => setDraft({ ...draft, text })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && preview.changed) {
                    event.preventDefault();
                    apply(command);
                  }
                }}
              />
              <Group>
                <Button
                  disabled={!preview.changed || !draft.text.trim()}
                  onClick={() => apply(command)}
                >
                  {messages.architectureApply()}
                </Button>
                <Button variant="plain" onClick={onClose}>
                  {messages.cancel()}
                </Button>
              </Group>
            </>
          ) : null}
          {notice ? (
            <Alert>
              {notice}
              <Button
                onClick={() => {
                  setBasis(props.model.sourceDocument.source);
                  setNotice(undefined);
                }}
              >
                {messages.visualRetry()}
              </Button>
            </Alert>
          ) : null}
        </Stack>
      </Scrollable.Viewport>
    </Stack>
  );
}
