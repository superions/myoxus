// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FileTextIcon,
  PencilIcon,
  DeleteIcon,
} from "@myoxus/icons/react";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  AnnotationPaper,
  Button,
  Group,
  IconButton,
  MyoxusText,
  Stack,
  Textarea,
  Popover,
  PopoverTarget,
  PopoverContent,
} from "@myoxus/ui-facade";
import {
  AnnotationReactHostExtension,
  type AnnotationBlockHostProps,
  type AnnotationInlineHostProps,
} from "@virgultum/editor/blocks/annotation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function AnnotationBlock({
  body,
  readonly,
  editRequest,
  apply,
}: AnnotationBlockHostProps) {
  const t = useI18n();
  const [opened, setOpened] = useState(true);
  const [editing, setEditing] = useState(false);
  // Cancelable local draft only; the authoritative body remains the Yjs Text.
  const [draft, setDraft] = useState(body);
  const [base, setBase] = useState(body);
  const lastRequest = useRef(0);
  const wasEditing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);

  const start = () => {
    if (readonly) return;
    setBase(body);
    setDraft(body);
    setOpened(true);
    setEditing(true);
  };

  useEffect(() => {
    if (lastRequest.current === editRequest) return;
    lastRequest.current = editRequest;
    if (!readonly) {
      setBase(body);
      setDraft(body);
      setOpened(true);
      setEditing(true);
    }
  }, [editRequest, body, readonly]);

  useLayoutEffect(() => {
    if (editing) input.current?.focus();
    else if (wasEditing.current)
      (editButton.current ?? toggleButton.current)?.focus();
    wasEditing.current = editing;
  }, [editing]);

  useEffect(() => {
    if (readonly) setEditing(false);
  }, [readonly]);

  const changed = editing && body !== base;
  return (
    <AnnotationPaper>
      <Stack
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            event.key === "Escape" &&
            !event.nativeEvent.isComposing &&
            editing
          ) {
            event.preventDefault();
            setEditing(false);
          }
        }}
      >
        <Group justify="space-between" wrap="nowrap">
          <Group wrap="nowrap">
            <FileTextIcon aria-hidden="true" />
            <MyoxusText tone="annotation" typographySlot="label-compact">
              {t["com.myoxus.editor.annotation"]()}
            </MyoxusText>
          </Group>
          <Group wrap="nowrap">
            {!readonly && opened && (
              <IconButton
                ref={editButton}
                aria-label={t["Edit"]()}
                onClick={start}
              >
                <PencilIcon />
              </IconButton>
            )}
            <IconButton
              ref={toggleButton}
              aria-label={opened ? t["Collapse"]() : t["Expand"]()}
              aria-expanded={opened}
              onClick={() => {
                setEditing(false);
                setOpened(!opened);
              }}
            >
              {opened ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </IconButton>
          </Group>
        </Group>
        {opened &&
          (editing && !readonly ? (
            <Stack>
              <Textarea
                ref={input}
                label={t["com.myoxus.editor.annotation"]()}
                value={draft}
                onChange={setDraft}
                autosize
                onPaste={(event) => event.stopPropagation()}
                onInput={(event) => event.stopPropagation()}
              />
              {changed && (
                <MyoxusText role="status">
                  {t["com.myoxus.editor.annotation.changed"]()}
                </MyoxusText>
              )}
              <Group justify="flex-end">
                <Button onClick={() => setEditing(false)}>
                  {t["Cancel"]()}
                </Button>
                <Button
                  variant="primary"
                  disabled={changed}
                  onClick={() => {
                    if (changed || readonly) return;
                    if (apply(draft, base)) setEditing(false);
                  }}
                >
                  {t["Apply"]()}
                </Button>
              </Group>
            </Stack>
          ) : (
            <MyoxusText tone="annotation" data-myoxus-annotation-body>
              {body}
            </MyoxusText>
          ))}
      </Stack>
    </AnnotationPaper>
  );
}

export function patchAnnotationHost(
  reactToLit: ReactToLit,
  showAnnotations: boolean,
) {
  return AnnotationReactHostExtension({
    showAnnotations,
    renderBlock: (props) => reactToLit(<AnnotationBlock {...props} />, true),
    renderInline: (props) =>
      reactToLit(<AnnotationInline key={props.id} {...props} />, true),
  });
}

export function AnnotationInline({
  body,
  readonly,
  apply,
  remove,
  focusEditor,
}: AnnotationInlineHostProps) {
  const t = useI18n();
  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [base, setBase] = useState(body);
  const marker = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useLayoutEffect(() => {
    if (editing) input.current?.focus();
    else if (wasEditing.current && opened) edit.current?.focus();
    wasEditing.current = editing;
  }, [editing, opened]);
  useEffect(() => {
    if (readonly) setEditing(false);
  }, [readonly]);
  const close = () => {
    setEditing(false);
    setOpened(false);
    marker.current?.focus();
  };
  const changed = editing && body !== base;
  return (
    <Popover
      opened={opened}
      onChange={(value) => {
        if (value) setOpened(true);
        else close();
      }}
      withArrow
      contentMeasure="reading"
      closeOnEscape={false}
      trapFocus
      returnFocus
      fitViewport
    >
      <PopoverTarget>
        <IconButton
          ref={marker}
          aria-label={t["com.myoxus.editor.annotation"]()}
          aria-expanded={opened}
          data-myoxus-annotation-marker
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (opened) close();
            else setOpened(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            } else if (
              event.key === "ArrowLeft" ||
              event.key === "ArrowRight"
            ) {
              event.preventDefault();
              close();
              focusEditor(event.key === "ArrowLeft" ? "before" : "after");
            } else if (
              !readonly &&
              (event.key === "Backspace" || event.key === "Delete")
            ) {
              event.preventDefault();
              remove(body);
            }
          }}
        >
          <FileTextIcon />
        </IconButton>
      </PopoverTarget>
      <PopoverContent
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            close();
          }
        }}
      >
        <Stack
          onPointerDown={(event) => event.stopPropagation()}
          onPaste={(event) => event.stopPropagation()}
          onInput={(event) => event.stopPropagation()}
        >
          <Group justify="space-between" wrap="nowrap">
            <Group wrap="nowrap">
              <FileTextIcon />
              <MyoxusText typographySlot="label-compact">
                {t["com.myoxus.editor.annotation"]()}
              </MyoxusText>
            </Group>
            {!readonly && !editing && (
              <Group wrap="nowrap">
                <IconButton
                  ref={edit}
                  aria-label={t["Edit"]()}
                  onClick={() => {
                    setBase(body);
                    setDraft(body);
                    setEditing(true);
                  }}
                >
                  <PencilIcon />
                </IconButton>
                <IconButton
                  aria-label={t["Delete"]()}
                  onClick={() => remove(body)}
                >
                  <DeleteIcon />
                </IconButton>
              </Group>
            )}
          </Group>
          {editing && !readonly ? (
            <Stack>
              <Textarea
                ref={input}
                label={t["com.myoxus.editor.annotation"]()}
                value={draft}
                onChange={setDraft}
                autosize
              />
              {changed && (
                <MyoxusText role="status">
                  {t["com.myoxus.editor.annotation.changed"]()}
                </MyoxusText>
              )}
              <Group justify="flex-end">
                <Button onClick={() => setEditing(false)}>
                  {t["Cancel"]()}
                </Button>
                <Button
                  variant="primary"
                  disabled={changed}
                  onClick={() => {
                    if (!changed && !readonly && apply(draft, base))
                      setEditing(false);
                  }}
                >
                  {t["Apply"]()}
                </Button>
              </Group>
            </Stack>
          ) : (
            <MyoxusText data-myoxus-annotation-body>{body}</MyoxusText>
          )}
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
