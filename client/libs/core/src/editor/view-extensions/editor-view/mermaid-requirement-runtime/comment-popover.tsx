// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { CommentIcon, PlusIcon } from "@myoxus/icons/react";
import {
  Alert,
  Button,
  Group,
  IconButton,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  requirementComments,
  type RequirementCommentAnchor,
  type RequirementReactHostProps,
} from "@virgultum/block-mermaid";

function RequirementCommentsForm({
  props,
  anchor,
  commentKeys,
}: {
  props: RequirementReactHostProps;
  anchor: RequirementCommentAnchor;
  commentKeys?: readonly string[];
}) {
  const t = useI18n(),
    [text, setText] = useState(""),
    [diagnostic, setDiagnostic] = useState<string>();
  const basis = useRef(props.sourceBasis),
    [selected, setSelected] = useState(
      commentKeys &&
        new Set(
          requirementComments(props.model)
            .filter((comment) => commentKeys.includes(comment.key))
            .map((comment) => comment.anchor.key),
        ).size > 1
        ? "group"
        : (anchor.key ?? "diagram"),
    );
  const [edits, setEdits] = useState<Record<string, string>>({});
  const invalid = basis.current !== props.sourceBasis;
  useEffect(() => {
    basis.current = props.sourceBasis;
    setEdits({});
    setText("");
    setDiagnostic(undefined);
  }, [props.sourceBasis]);
  const records = props.model.sourceDocument?.records ?? [];
  const choices = [
    ...(selected === "group"
      ? [{ value: "group", label: m.visualComments() }]
      : []),
    { value: "diagram", label: m.visualComments() },
    ...[...props.model.requirements, ...props.model.elements].flatMap(
      (object) => [
        { value: object.sourceKey!, label: object.name },
        ...Object.entries(object.propertyKeys ?? {}).flatMap(([name, keys]) =>
          (keys ?? []).map((key) => ({
            value: key,
            label: `${object.name} · ${name}`,
          })),
        ),
      ],
    ),
    ...props.model.relations.map((relation) => ({
      value: relation.sourceKey!,
      label: `${relation.from} · ${relation.kind} · ${relation.to}`,
    })),
  ];
  for (const comment of requirementComments(props.model))
    if (
      comment.anchor.key &&
      !choices.some((choice) => choice.value === comment.anchor.key)
    ) {
      const record = records.find(
        (record) => record.sourceKey === comment.anchor.key,
      );
      if (record)
        choices.push({
          value: record.sourceKey,
          label: `${record.range.line}: ${record.raw.trim()}`,
        });
    }
  const comments = requirementComments(props.model).filter((comment) =>
    selected === "group"
      ? Boolean(commentKeys?.includes(comment.key))
      : (comment.anchor.key ?? "diagram") === selected,
  );
  const commit = (
    command: Parameters<RequirementReactHostProps["onComment"]>[0],
  ) => {
    if (invalid || props.readonly || props.displayOnly) return;
    const result = props.onComment(command, basis.current);
    setDiagnostic(result.diagnostic);
    if (result.changed) {
      setText("");
      setEdits({});
    }
  };
  return (
    <Stack>
      <Select
        label={m.architectureEndpointObject()}
        comboboxProps={{ withinPortal: false }}
        value={selected}
        data={choices}
        onChange={setSelected}
      />
      {comments.map((comment) => (
        <Stack key={comment.key}>
          <MyoxusTextInput
            label={m.visualComments()}
            value={edits[comment.key] ?? comment.text}
            disabled={props.readonly}
            onChange={(text) =>
              setEdits((edits) => ({ ...edits, [comment.key]: text }))
            }
          />
          <Group>
            <Button
              disabled={
                props.readonly ||
                invalid ||
                !(edits[comment.key] ?? comment.text).trim()
              }
              onClick={() =>
                commit({
                  type: "edit",
                  key: comment.key,
                  text: edits[comment.key] ?? comment.text,
                })
              }
            >
              {t.Save()}
            </Button>
            <Button
              disabled={props.readonly || invalid}
              onClick={() => commit({ type: "delete", key: comment.key })}
            >
              {m.visualDeleteComment()}
            </Button>
          </Group>
        </Stack>
      ))}
      {!props.readonly ? (
        <>
          <MyoxusTextInput
            label={m.visualComments()}
            value={text}
            onChange={setText}
          />
          <Button
            disabled={invalid || !text.trim() || selected === "group"}
            onClick={() =>
              commit({
                type: "add",
                anchor: {
                  key: selected === "diagram" ? undefined : selected,
                  position:
                    records.find((record) => record.sourceKey === selected)
                      ?.kind === "object-open"
                      ? "after"
                      : "before",
                },
                text,
              })
            }
          >
            {t.Save()}
          </Button>
        </>
      ) : null}
      {diagnostic ? <Alert>{diagnostic}</Alert> : null}
    </Stack>
  );
}
/** Marker and toolbar share the same scoped form. No canvas gesture receives
 * an icon/SVG or portalled form click, including native Edgeless. */
export function RequirementCommentsPopover({
  props,
  anchor,
  count,
  commentKeys,
}: {
  props: RequirementReactHostProps;
  anchor: RequirementCommentAnchor;
  count?: number;
  commentKeys?: readonly string[];
}) {
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!opened) return;
    // A confirmed Source write can replace the focused form control. Escape
    // still closes this local draft before the Page root consumes that key.
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpened(false);
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [opened]);
  return (
    <Popover
      fitViewport
      trapFocus
      contentMeasure="reading"
      opened={opened}
      onChange={setOpened}
    >
      <PopoverTarget>
        <IconButton
          aria-label={
            count === undefined
              ? m.architectureAddComment()
              : `${m.visualComments()} · ${count}`
          }
          tooltip={m.visualComments()}
          icon={count === undefined ? <PlusIcon /> : <CommentIcon />}
          onClick={() => setOpened(!opened)}
        />
      </PopoverTarget>
      <PopoverContent
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpened(false);
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <RequirementCommentsForm
              props={props}
              anchor={anchor}
              commentKeys={commentKeys}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
