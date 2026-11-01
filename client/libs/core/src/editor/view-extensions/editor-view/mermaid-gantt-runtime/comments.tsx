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
  type GanttComment,
  type MermaidGanttReactHostProps,
} from "@virgultum/block-mermaid";
import { useState } from "react";

function anchorLabel(
  props: MermaidGanttReactHostProps,
  anchor: GanttComment["anchor"],
) {
  if (anchor.kind === "diagram") return messages.visualEditorLabel();
  if (anchor.kind === "section")
    return (
      props.model.sections.find((section) => section.id === anchor.id)?.title ??
      messages.selectedPlanningLaneTitle()
    );
  if (anchor.kind === "task")
    return (
      props.model.tasks.find((task) => task.recordId === anchor.id)?.label ??
      messages.visualEditorLabel()
    );
  return anchor.id;
}

/** Comment markers and the Facade list; never an inspector field. */
export function GanttComments({
  props,
}: {
  readonly props: MermaidGanttReactHostProps;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  return (
    <Stack p="sm" w={360}>
      <Stack gap={4}>
        {props.model.comments.length === 0 ? (
          <MyoxusText tone="secondary" typographySlot="body-small">
            {messages.visualComments()}
          </MyoxusText>
        ) : (
          props.model.comments.map((comment) => (
            <Stack gap={4} key={comment.id}>
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={0}>
                  <MyoxusText typographySlot="body-small">
                    {comment.text}
                  </MyoxusText>
                  <MyoxusText tone="muted" typographySlot="caption">
                    {anchorLabel(props, comment.anchor)}
                  </MyoxusText>
                </Stack>
                <Group gap="xs">
                  {editing?.id === comment.id ? (
                    <Button
                      disabled={
                        props.readonly ||
                        !editing.text.trim() ||
                        /[\r\n]/.test(editing.text)
                      }
                      size="xs"
                      onClick={() => {
                        if (
                          props.onCommand({
                            commentId: comment.id,
                            text: editing.text,
                            type: "comment.edit",
                          }).changed
                        )
                          setEditing(undefined);
                      }}
                    >
                      {messages.architectureApply()}
                    </Button>
                  ) : (
                    <Button
                      disabled={props.readonly}
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        setEditing({ id: comment.id, text: comment.text })
                      }
                    >
                      {messages.displayEdit()}
                    </Button>
                  )}
                  <Button
                    color="myoxusError"
                    disabled={props.readonly}
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      props.onCommand({
                        commentId: comment.id,
                        type: "comment.delete",
                      })
                    }
                  >
                    {messages.visualDelete()}
                  </Button>
                </Group>
              </Group>
              {editing?.id === comment.id ? (
                <MyoxusTextInput
                  autoFocus
                  disabled={props.readonly}
                  value={editing.text}
                  onChange={(text) => setEditing({ ...editing, text })}
                />
              ) : null}
            </Stack>
          ))
        )}
      </Stack>
      <Group gap="xs">
        <MyoxusTextInput
          disabled={props.readonly}
          flex={1}
          value={draft}
          onChange={setDraft}
          placeholder={messages.architectureAddComment()}
        />
        <Button
          disabled={props.readonly || !draft.trim() || /[\r\n]/.test(draft)}
          onClick={() => {
            const selected = props.selection;
            const anchor: GanttComment["anchor"] =
              selected?.kind === "task"
                ? { id: selected.id, kind: "task" }
                : selected?.kind === "section"
                  ? { id: selected.id, kind: "section" }
                  : { kind: "diagram" };
            if (
              props.onCommand({ anchor, text: draft, type: "comment.add" })
                .changed
            )
              setDraft("");
          }}
        >
          {messages.architectureAddComment()}
        </Button>
      </Group>
    </Stack>
  );
}
