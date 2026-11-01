// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  ConfirmModal,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type ClassReactHostProps,
  type MermaidClassNamespace,
} from "@virgultum/block-mermaid";
import { useState } from "react";
import { useClassDraft } from "./drafts";
export function ClassNamespaceForm({
  props,
  namespace,
  group,
  onClose,
}: {
  props: ClassReactHostProps;
  namespace?: MermaidClassNamespace;
  group?: boolean;
  onClose: () => void;
}) {
  const t = useI18n(),
    initial = {
      id: namespace?.id.split(".").at(-1) ?? "",
      label: namespace?.label ?? "",
      parentId: namespace?.parentId ?? "",
      before: "",
    },
    d = useClassDraft(initial, props),
    v = d.value;
  const [deleting, setDeleting] = useState(false),
    [strategy, setStrategy] = useState("ungroup"),
    [notes, setNotes] = useState("");
  const impact = namespace
    ? props.getImpact({
        kind: "namespace",
        key: namespace.sourceKey,
        deleteStrategy: strategy as "ungroup" | "delete",
      })
    : null;
  const targets = [
    { value: "", label: t["admin.common.none"]() },
    ...props.model.namespaces.map((n) => ({ value: n.id, label: n.label })),
  ];
  return (
    <Stack>
      <MyoxusTextInput
        autoFocus
        label={m.classNamespace()}
        value={v.id}
        disabled={props.readonly}
        onChange={(value) => d.set("id", value)}
      />
      <MyoxusTextInput
        label={m.timelineLabel()}
        value={v.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
      />
      {!group ? (
        <Select
          label={m.classNamespace()}
          data={targets}
          value={v.parentId}
          disabled={props.readonly}
          onChange={(value) => d.set("parentId", value)}
        />
      ) : null}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      {!props.readonly ? (
        <Button
          disabled={group && !props.groupAllowed}
          onClick={() => {
            const result = namespace
              ? d.commit("editClassNamespace", [
                  namespace.sourceKey,
                  { id: v.id, label: v.label },
                ])
              : group
                ? d.commit("groupClasses", [
                    props.selectedKeys,
                    { id: v.id, label: v.label },
                  ])
                : d.commit("addClassNamespace", [
                    { id: v.id, label: v.label, parentId: v.parentId || null },
                  ]);
            if (!result.diagnostic) onClose();
          }}
        >
          {t["com.myoxus.editCollection.save"]()}
        </Button>
      ) : null}
      {namespace ? (
        <>
          <Select
            label={m.visualMoveUp()}
            data={targets}
            value={v.before}
            disabled={props.readonly}
            onChange={(value) => d.set("before", value)}
          />
          {!props.readonly ? (
            <Group>
              <Button
                onClick={() => {
                  const result = d.commit("moveClassNamespace", [
                    namespace.sourceKey,
                    v.parentId || null,
                    undefined,
                    v.before || undefined,
                  ]);
                  if (!result.diagnostic) onClose();
                }}
              >
                {m.visualMoveSubgraph()}
              </Button>
              <Button onClick={() => setDeleting(true)}>
                {m.visualDelete()}
              </Button>
            </Group>
          ) : null}
          <ConfirmModal
            open={deleting}
            onOpenChange={setDeleting}
            title={m.visualDelete()}
            confirmText={m.visualDelete()}
            confirmButtonOptions={{
              variant: "destructive",
              disabled:
                strategy === "delete" &&
                Boolean(impact?.attachedNotes.length && !notes),
            }}
            onConfirm={() => {
              const result = d.commit("deleteClassNamespace", [
                namespace.sourceKey,
                strategy as "ungroup" | "delete",
                (notes as "keep-free" | "delete") || undefined,
              ]);
              if (!result.diagnostic) {
                setDeleting(false);
                onClose();
              }
            }}
          >
            <Stack>
              <Select
                label={m.visualDelete()}
                data={[
                  { value: "ungroup", label: m.classUngroup() },
                  { value: "delete", label: m.classDeleteContent() },
                ]}
                value={strategy}
                onChange={setStrategy}
              />
              {impact?.records.map((r) => (
                <MyoxusText key={r.id}>{r.label}</MyoxusText>
              ))}
              {strategy === "delete" && impact?.attachedNotes.length ? (
                <Select
                  label={m.classNotesStrategy()}
                  data={[
                    { value: "keep-free", label: m.classKeepNotes() },
                    { value: "delete", label: m.classDeleteNotes() },
                  ]}
                  value={notes}
                  onChange={setNotes}
                />
              ) : null}
              {d.diagnostic ? (
                <Alert color="myoxusError" role="alert">
                  {d.diagnostic}
                </Alert>
              ) : null}
            </Stack>
          </ConfirmModal>
        </>
      ) : null}
    </Stack>
  );
}
