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
  MermaidFlowchartMetadataReactHostProps,
  MermaidFlowchartReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

export function MermaidFlowchartComments({
  applyLabel,
  comments,
  marker = false,
  onAddComment,
  props,
  showCancel = false,
}: {
  readonly applyLabel?: string;
  readonly comments: MermaidFlowchartReactHostProps["comments"];
  readonly marker?: boolean;
  readonly onAddComment?: MermaidFlowchartReactHostProps["onAddComment"];
  readonly props:
    MermaidFlowchartReactHostProps | MermaidFlowchartMetadataReactHostProps;
  readonly showCancel?: boolean;
}) {
  const t = useI18n();
  const [invalid, setInvalid] = useState<string | null>(null);
  const [newComment, setNewComment] = useState("");
  const [opened, setOpened] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const label = t["com.myoxus.comment.comments"]();
  const triggerLabel = `${label}: ${new Intl.NumberFormat(t.language).format(comments.length)}`;
  const incoming = JSON.stringify(
    Object.fromEntries(comments.map((comment) => [comment.id, comment.text])),
  );

  useEffect(() => setValues(JSON.parse(incoming)), [incoming]);
  useEffect(() => {
    setInvalid(null);
    setOpened(false);
  }, [props.selectionKey]);

  const closeAndReset = () => {
    setInvalid(null);
    setNewComment("");
    setValues(JSON.parse(incoming));
    setOpened(false);
  };
  const handleOpenChange = (nextOpened: boolean) => {
    if (!nextOpened && showCancel) closeAndReset();
    else setOpened(nextOpened);
  };

  return (
    <Popover
      opened={opened}
      onChange={handleOpenChange}
      returnFocus={showCancel}
      trapFocus={showCancel}
      zIndex={showCancel ? "var(--myoxus-z-index-popover)" : undefined}
    >
      <PopoverTarget>
        {marker ? (
          <IconButton
            aria-label={triggerLabel}
            icon={<CommentIcon />}
            onClick={() => handleOpenChange(!opened)}
            tooltip={triggerLabel}
          />
        ) : (
          <Button
            aria-expanded={opened}
            onClick={() => handleOpenChange(!opened)}
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
              <MyoxusTextInput
                aria-label={`${label}: ${comment.anchor}`}
                disabled={props.readonly}
                onChange={(value) =>
                  setValues((current) => ({ ...current, [comment.id]: value }))
                }
                value={values[comment.id] ?? comment.text}
              />
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
                  const diagnostic = (onAddComment ?? props.onAddComment)(
                    newComment,
                  );
                  setInvalid(diagnostic);
                  if (!diagnostic) setNewComment("");
                }}
                prefix={<PlusIcon />}
                variant="secondary"
              >
                {applyLabel ?? label}
              </Button>
            </Stack>
          ) : null}
          {showCancel ? (
            <Group justify="flex-end">
              <Button onClick={closeAndReset} variant="plain">
                {t["Cancel"]()}
              </Button>
            </Group>
          ) : null}
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
