// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  ConfirmModal,
  Group,
  MyoxusText,
  Select,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  getMermaidClassNoteDisplayText,
  type ClassReactHostProps,
  type MermaidClassNote,
} from "@virgultum/block-mermaid";
import { useState } from "react";
import { changedClassFields, useClassDraft } from "./drafts";
export function ClassNoteForm({
  props,
  note,
  onClose,
}: {
  props: ClassReactHostProps;
  note?: MermaidClassNote;
  onClose: () => void;
}) {
  const t = useI18n(),
    initial = {
      text: note ? getMermaidClassNoteDisplayText(note.text) : "",
      classId: note?.classId ?? null,
    },
    d = useClassDraft(initial, props),
    v = d.value,
    [deleting, setDeleting] = useState(false);
  const impact = note
    ? props.getImpact({ kind: "note", key: note.sourceKey })
    : null;
  return (
    <Stack>
      <Textarea
        autoFocus
        label={m.classAddNote()}
        value={v.text}
        disabled={props.readonly}
        onChange={(value) => d.set("text", value)}
        autosize
      />
      <Select
        label={m.classClassId()}
        data={[
          { value: "", label: m.classFreeNote() },
          ...props.model.nodes
            .filter((n) => n.kind === "class")
            .map((n) => ({ value: n.sourceId, label: n.label })),
        ]}
        value={v.classId ?? ""}
        disabled={props.readonly}
        onChange={(value) => d.set("classId", value || null)}
      />
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      {!props.readonly ? (
        <Group>
          <Button
            onClick={() => {
              const result = note
                ? d.commit("editClassNote", [
                    note.id,
                    changedClassFields(initial, v),
                  ])
                : d.commit("addClassNote", [v]);
              if (!result.diagnostic) onClose();
            }}
          >
            {t["com.myoxus.editCollection.save"]()}
          </Button>
          {note ? (
            <Button onClick={() => setDeleting(true)}>
              {m.visualDelete()}
            </Button>
          ) : null}
        </Group>
      ) : null}
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (!note) return;
          const result = d.commit("deleteClassNote", [note.id]);
          if (!result.diagnostic) {
            setDeleting(false);
            onClose();
          }
        }}
      >
        <Stack>
          {impact?.records.map((r) => (
            <MyoxusText key={r.id}>{r.label}</MyoxusText>
          ))}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
