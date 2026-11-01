// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMindmapDraftBasis, handleMindmapSelectKeyDown } from "./drafts";
import { useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { AddCommentIcon, CommentIcon } from "@myoxus/icons";
import {
  Alert,
  Button,
  Group,
  IconButton,
  MyoxusSelect,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
} from "@myoxus/ui-facade";
import {
  isMindmapComment,
  mindmapCommentText,
  mermaidMessages as m,
  type MindmapReactHostProps,
} from "@virgultum/block-mermaid";

export function MindmapCommentsPopover({
  props,
  sourceKeys,
}: {
  props: MindmapReactHostProps;
  sourceKeys?: readonly string[];
}) {
  const [opened, setOpened] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpened(false);
    // Source reconciliation can remove the marker after Delete. Resolve its
    // return target only after React has committed that removal.
    requestAnimationFrame(() => {
      (button.current?.isConnected
        ? button.current
        : props.resolveReturnFocusTarget()
      )?.focus({ preventScroll: true });
    });
  };
  return (
    <Popover
      closeOnEscape={false}
      opened={opened}
      onChange={(open) => (open ? setOpened(true) : close())}
      fitViewport
      trapFocus
      returnFocus={false}
    >
      <PopoverTarget>
        {sourceKeys ? (
          <IconButton
            ref={button}
            aria-label={`${m.visualComments()} (${sourceKeys.length})`}
            onClick={() => setOpened(true)}
          >
            <CommentIcon />
          </IconButton>
        ) : (
          <IconButton
            ref={button}
            aria-label={m.architectureAddComment()}
            tooltip={m.architectureAddComment()}
            icon={<AddCommentIcon />}
            disabled={props.readonly}
            onClick={() => setOpened(true)}
          />
        )}
      </PopoverTarget>
      <PopoverContent
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {opened ? (
          <MindmapCommentForm
            props={props}
            sourceKeys={sourceKeys}
            close={close}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function MindmapCommentForm({
  props,
  sourceKeys,
  close,
}: {
  props: MindmapReactHostProps;
  sourceKeys?: readonly string[];
  close: () => void;
}) {
  const t = useI18n();
  const records = props.model.sourceDocument.records;
  const comments = records.filter(
    (r) => isMindmapComment(r) && sourceKeys?.includes(r.sourceKey),
  );
  const [key, setKey] = useState(comments[0]?.sourceKey ?? "");
  const [text, setText] = useState(
    comments[0] ? mindmapCommentText(comments[0]) : "",
  );
  const [anchorKey, setAnchorKey] = useState(
    props.selectedKey ?? records.find((r) => r.kind === "header")!.sourceKey,
  );
  const [position, setPosition] = useState<"before" | "after">("after");
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const basis = useMindmapDraftBasis(props, close);
  const save = (remove = false) => {
    if (props.readonly || props.displayOnly) return;
    const result = props.onCommand(
      remove
        ? { type: "remove-comment", key }
        : { type: "comment", key: key || undefined, text, anchorKey, position },
      basis,
    );
    if (result.diagnostic) setDiagnostic(result.diagnostic);
    else close();
  };
  return (
    <Stack
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (
          event.key === "Enter" &&
          !event.nativeEvent.isComposing &&
          event.target instanceof HTMLInputElement &&
          event.target.getAttribute("role") !== "combobox"
        ) {
          event.preventDefault();
          event.stopPropagation();
          save();
        }
      }}
    >
      {comments.length ? (
        <MyoxusSelect
          onKeyDown={handleMindmapSelectKeyDown}
          label={m.visualComments()}
          comboboxProps={{ withinPortal: false }}
          value={key}
          data={comments.map((r) => ({
            value: r.sourceKey,
            label: m.radarCommentAnchor(
              mindmapCommentText(r),
              "%%",
              r.range.line,
            ),
          }))}
          onChange={(value) => {
            setKey(value);
            setText(
              mindmapCommentText(records.find((r) => r.sourceKey === value)!),
            );
          }}
        />
      ) : null}
      {!key ? (
        <Group>
          <MyoxusSelect
            onKeyDown={handleMindmapSelectKeyDown}
            label={m.sequenceAnchor()}
            value={anchorKey}
            comboboxProps={{ withinPortal: false }}
            data={records
              .filter((r) =>
                ["header", "node", "icon", "class", "comment"].includes(r.kind),
              )
              .map((r) => ({
                value: r.sourceKey,
                label: m.radarCommentAnchor(r.raw.trim(), "%%", r.range.line),
              }))}
            onChange={setAnchorKey}
          />
          <MyoxusSelect
            onKeyDown={handleMindmapSelectKeyDown}
            label={m.sequencePosition()}
            value={position}
            comboboxProps={{ withinPortal: false }}
            data={[
              { value: "before", label: m.radarCommentBefore() },
              { value: "after", label: m.radarCommentAfter() },
            ]}
            onChange={(value) => {
              if (value === "before" || value === "after") setPosition(value);
            }}
          />
        </Group>
      ) : null}
      <MyoxusTextInput
        label={m.visualComments()}
        value={text}
        readOnly={props.readonly}
        onChange={setText}
      />
      {diagnostic ? (
        <Alert role="alert" color="myoxusError">
          {diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={props.readonly || props.displayOnly}
          onClick={() => save()}
        >
          {t.Save()}
        </Button>
        {key ? (
          <Button
            disabled={props.readonly || props.displayOnly}
            onClick={() => save(true)}
          >
            {t.Delete()}
          </Button>
        ) : null}
        <Button variant="default" onClick={close}>
          {t.Cancel()}
        </Button>
      </Group>
    </Stack>
  );
}
