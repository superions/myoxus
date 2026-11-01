// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { CommentIcon, PlusIcon } from "@myoxus/icons";
import {
  Alert,
  Button,
  Group,
  IconButton,
  MyoxusText,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
} from "@myoxus/ui-facade";
import type {
  MermaidArchitectureCommentAnchor,
  MermaidArchitectureCommentsProps,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

export function MermaidArchitectureCommentPopover({
  anchor,
  props,
  comments = props.comments,
  marker = false,
}: {
  readonly anchor?: MermaidArchitectureCommentAnchor;
  readonly comments?: MermaidArchitectureCommentsProps["comments"];
  readonly marker?: boolean;
  readonly props: MermaidArchitectureCommentsProps;
}) {
  const t = useI18n();
  const [opened, setOpened] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [newComment, setNewComment] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const label = t["com.myoxus.comment.comments"]();
  const count = new Intl.NumberFormat(t.language).format(comments.length);
  const triggerLabel = `${label}: ${count}`;
  const incomingValues = JSON.stringify(
    Object.fromEntries(comments.map((comment) => [comment.id, comment.text])),
  );

  useEffect(() => {
    setValues(JSON.parse(incomingValues));
  }, [incomingValues]);
  useEffect(() => {
    setOpened(false);
    setInvalid(null);
  }, [props.selectionKey]);

  return (
    <Popover opened={opened} onChange={setOpened}>
      <PopoverTarget>
        {marker ? (
          <IconButton
            aria-label={triggerLabel}
            icon={<CommentIcon />}
            onClick={() => setOpened((current) => !current)}
            tooltip={triggerLabel}
          />
        ) : (
          <Button
            aria-expanded={opened}
            onClick={() => setOpened((current) => !current)}
            variant="plain"
          >
            {triggerLabel}
          </Button>
        )}
      </PopoverTarget>
      <PopoverContent>
        <Stack gap="xs">
          {comments.map((comment) => (
            <Stack gap="xs" key={comment.id}>
              <MyoxusText tone="secondary" typographySlot="body-small">
                {comment.anchor}
              </MyoxusText>
              {props.readonly ? (
                <MyoxusText>{comment.text}</MyoxusText>
              ) : (
                <MyoxusTextInput
                  aria-label={`${label}: ${comment.anchor}`}
                  onChange={(value) =>
                    setValues((current) => ({
                      ...current,
                      [comment.id]: value,
                    }))
                  }
                  value={values[comment.id] ?? comment.text}
                />
              )}
              {!props.readonly ? (
                <Group justify="flex-end">
                  <Button
                    onClick={() =>
                      setInvalid(props.onCommentDelete(comment.id))
                    }
                    variant="plain"
                  >
                    {props.labels.deleteComment}
                  </Button>
                  <Button
                    onClick={() =>
                      setInvalid(
                        props.onCommentChange(
                          comment.id,
                          values[comment.id] ?? comment.text,
                        ),
                      )
                    }
                    variant="secondary"
                  >
                    {t["com.myoxus.editCollection.save"]()}
                  </Button>
                </Group>
              ) : null}
            </Stack>
          ))}
          {invalid ? (
            <Alert color="myoxusError" role="alert" variant="light">
              {invalid}
            </Alert>
          ) : null}
          {!props.readonly ? (
            <Stack gap="xs">
              <MyoxusTextInput
                aria-label={label}
                onChange={setNewComment}
                value={newComment}
              />
              <Button
                disabled={!newComment.trim()}
                onClick={() => {
                  const diagnostic = props.onAddComment(newComment, anchor);
                  setInvalid(diagnostic);
                  if (!diagnostic) setNewComment("");
                }}
                prefix={<PlusIcon />}
                variant="secondary"
              >
                {label}
              </Button>
            </Stack>
          ) : null}
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
