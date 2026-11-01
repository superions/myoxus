// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  ConfirmModal,
  Group,
  MyoxusText,
  MyoxusTextInput,
  NavLink,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  Select,
  Stack,
  Text,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  stateDisplayText,
  type StateReactHostProps,
  type MermaidStateNote,
} from "@virgultum/block-mermaid";
import { useStateDraft, handleStateDraftKeyDown } from "./drafts";
import { StateScopeSelect, stateScopeAnchor } from "./state-popover";
export function StateNoteForm({
  props,
  initialDelete = false,
  note,
  targetId,
  showRelated = true,
  onClose,
}: {
  props: StateReactHostProps;
  initialDelete?: boolean;
  note?: MermaidStateNote;
  targetId?: string;
  showRelated?: boolean;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useStateDraft(
      {
        form: note?.form ?? "multiline",
        text: stateDisplayText(note?.label ?? ""),
        target:
          note?.stateId ??
          targetId ??
          props.model.states.find((s) => s.sourceKey === props.selected?.key)
            ?.id ??
          "",
        floatingId: note?.floatingId ?? "",
        side: note?.placement ?? "right of",
      },
      props,
    );
  const targetObject = [...props.model.states, ...props.model.composites].find(
    (n) => n.id === d.value.target,
  );
  const [scope, setScope] = useState(
      note?.regionKey ?? targetObject?.regionKey ?? "",
    ),
    [deleting, setDeleting] = useState(initialDelete);
  const save = () => {
    const value = {
        ...d.value,
        ...(!note || scope !== (note.regionKey ?? "")
          ? { anchor: stateScopeAnchor(props, scope) }
          : {}),
      },
      r = note
        ? d.commit("editStateNote", [note.id, value])
        : d.commit("addStateNote", [value]);
    if (!r.diagnostic) onClose();
  };
  const siblings = props.model.notes.filter(
    (n) => n.stateId === d.value.target && n.form !== "floating",
  );
  return (
    <Stack
      onKeyDown={(event) =>
        handleStateDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <Select
        label={m.sequenceNote()}
        value={d.value.form}
        disabled={props.readonly}
        data={[
          { value: "multiline", label: m.stateMultilineNote() },
          { value: "inline", label: m.stateInlineNote() },
          { value: "floating", label: m.stateFloatingId() },
        ]}
        onChange={(value) => d.set("form", value as typeof d.value.form)}
      />
      {d.value.form === "floating" ? (
        <MyoxusTextInput
          label={m.stateFloatingId()}
          value={d.value.floatingId}
          disabled={props.readonly}
          onChange={(value) => d.set("floatingId", value)}
        />
      ) : (
        <>
          <Select
            label={m.architectureEndpointObject()}
            value={d.value.target}
            disabled={props.readonly}
            data={[
              ...props.model.states.filter(
                (n) => n.kind !== "start" && n.kind !== "end",
              ),
              ...props.model.composites,
            ].map((n) => ({ value: n.id, label: `${n.label} · ${n.id}` }))}
            onChange={(value) => d.set("target", value)}
          />
          <Select
            label={m.sequenceNote()}
            value={d.value.side}
            disabled={props.readonly}
            data={[
              { value: "left of", label: m.pieLegendLeft() },
              { value: "right of", label: m.pieLegendRight() },
            ]}
            onChange={(value) => d.set("side", value as typeof d.value.side)}
          />
          {note ? (
            <MyoxusText>
              {note.effective ? m.stateEffectiveNote() : m.stateEarlierNote()}
            </MyoxusText>
          ) : null}
        </>
      )}
      <Textarea
        autoFocus
        data-autofocus
        label={m.sequenceNote()}
        value={d.value.text}
        disabled={props.readonly}
        autosize
        onChange={(value) => d.set("text", value)}
      />
      <StateScopeSelect props={props} value={scope} onChange={setScope} />
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button disabled={props.readonly} onClick={save}>
          {t["Save"]()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
        {note ? (
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
        ) : null}
      </Group>
      {showRelated
        ? siblings
            .filter((n) => n.id !== note?.id)
            .map((n) => <StateNotePopover key={n.id} props={props} note={n} />)
        : null}
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (note && !d.commit("deleteStateNote", [note.id]).diagnostic)
            onClose();
        }}
      >
        <MyoxusText>{note?.label}</MyoxusText>
      </ConfirmModal>
    </Stack>
  );
}
export function StateNotePopover({
  props,
  note,
  targetId,
}: {
  props: StateReactHostProps;
  note?: MermaidStateNote;
  targetId?: string;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover fitViewport opened={opened} onChange={setOpened}>
      <PopoverTarget>
        <NavLink
          component="button"
          onClick={() => setOpened(!opened)}
          label={
            <Text textWrap="pretty">
              {note
                ? `${note.effective ? m.stateEffectiveNote() : m.stateEarlierNote()} · ${stateDisplayText(note.label)}`
                : m.sequenceNote()}
            </Text>
          }
        />
      </PopoverTarget>
      <PopoverContent>
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <StateNoteForm
              props={props}
              note={note}
              targetId={targetId}
              showRelated={false}
              onClose={() => setOpened(false)}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
/** Every Source note remains editable locally, including overridden native notes. */
export function StateObjectNotes({
  props,
  targetId,
}: {
  props: StateReactHostProps;
  targetId: string;
}) {
  return (
    <Stack>
      {props.model.notes
        .filter((n) => n.stateId === targetId)
        .map((n) => (
          <StateNotePopover key={n.id} props={props} note={n} />
        ))}
      <StateNotePopover props={props} targetId={targetId} />
    </Stack>
  );
}
