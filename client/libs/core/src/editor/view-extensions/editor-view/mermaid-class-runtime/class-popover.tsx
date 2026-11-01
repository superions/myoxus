// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  ConfirmModal,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  Scrollable,
  PopoverTarget,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type ClassReactHostProps,
  type MermaidClassNode,
} from "@virgultum/block-mermaid";
import { useState } from "react";
import { changedClassFields, useClassDraft } from "./drafts";
import { ClassAddMemberPopover } from "./member-popover";
import { ClassAppearanceForm } from "./appearance-popover";
export function ClassForm({
  props,
  node,
  onClose,
}: {
  props: ClassReactHostProps;
  node?: MermaidClassNode;
  onClose: () => void;
}) {
  const t = useI18n(),
    initial = {
      id: node?.sourceId ?? "",
      label: node?.label ?? "",
      genericType: node?.genericType ?? "",
      annotation: node?.annotations[0] ?? "",
    },
    d = useClassDraft(initial, props),
    v = d.value;
  const [namespace, setNamespace] = useState(node?.namespaceId ?? "");
  const [link, setLink] = useState(false),
    [styles, setStyles] = useState(false);
  return (
    <Stack>
      <MyoxusTextInput
        label={m.classClassId()}
        value={v.id}
        disabled={props.readonly}
        onChange={(value) => d.set("id", value)}
      />
      <MyoxusTextInput
        autoFocus
        label={m.timelineLabel()}
        value={v.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
      />
      <MyoxusTextInput
        label={m.classGeneric()}
        value={v.genericType}
        disabled={props.readonly}
        onChange={(value) => d.set("genericType", value)}
      />
      <MyoxusTextInput
        label={m.classAnnotation()}
        value={v.annotation}
        disabled={props.readonly}
        onChange={(value) => d.set("annotation", value)}
      />
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      {!props.readonly ? (
        <Button
          onClick={() => {
            const result = node
              ? d.commit("editClass", [
                  node.sourceKey,
                  changedClassFields(initial, v),
                ])
              : d.commit("addClass", [v]);
            if (!result.diagnostic) onClose();
          }}
        >
          {t["com.myoxus.editCollection.save"]()}
        </Button>
      ) : null}
      {node ? (
        <>
          <Select
            label={m.classNamespace()}
            value={namespace}
            disabled={props.readonly}
            data={[
              { value: "", label: t["admin.common.none"]() },
              ...props.model.namespaces.map((n) => ({
                value: n.id,
                label: n.label,
              })),
            ]}
            onChange={setNamespace}
          />
          {!props.readonly ? (
            <Button
              disabled={namespace === (node.namespaceId ?? "")}
              onClick={() => {
                const result = d.commit("setClassNamespace", [
                  node.sourceKey,
                  namespace || null,
                ]);
                if (!result.diagnostic) onClose();
              }}
            >
              {m.visualMoveSubgraph()}
            </Button>
          ) : null}
          <ClassAnnotations props={props} node={node} />
          <Group>
            <ClassAddMemberPopover props={props} classKey={node.sourceKey} />
            <Popover fitViewport opened={link} onChange={setLink}>
              <PopoverTarget>
                <Button onClick={() => setLink(!link)}>
                  {m.ganttBindingLink()}
                </Button>
              </PopoverTarget>
              <PopoverContent>
                <Scrollable.Viewport autosize maxHeight="floating">
                  {link ? (
                    <ClassLinkForm
                      props={props}
                      node={node}
                      onClose={() => setLink(false)}
                    />
                  ) : null}
                </Scrollable.Viewport>
              </PopoverContent>
            </Popover>
            <Popover fitViewport opened={styles} onChange={setStyles}>
              <PopoverTarget>
                <Button onClick={() => setStyles(!styles)}>
                  {m.visualAppearance()}
                </Button>
              </PopoverTarget>
              <PopoverContent>
                <Scrollable.Viewport autosize maxHeight="floating">
                  {styles ? (
                    <ClassAppearanceForm
                      props={props}
                      classId={node.sourceId}
                    />
                  ) : null}
                </Scrollable.Viewport>
              </PopoverContent>
            </Popover>
            <ClassDeleteControl props={props} node={node} onClose={onClose} />
          </Group>
        </>
      ) : null}
    </Stack>
  );
}
function ClassLinkForm({
  props,
  node,
  onClose,
}: {
  props: ClassReactHostProps;
  node: MermaidClassNode;
  onClose: () => void;
}) {
  const t = useI18n(),
    link = props.model.interactions.findLast(
      (i) => i.classId === node.sourceId && i.kind === "link",
    );
  const d = useClassDraft(
    {
      url: link?.url ?? "",
      tooltip: link?.tooltip ?? "",
      target: link?.target ?? "_self",
    },
    props,
  );
  return (
    <Stack>
      {link?.url ? (
        <Button onClick={() => props.onOpenLink(node.sourceKey)}>
          {link.tooltip || link.url}
        </Button>
      ) : null}
      <MyoxusTextInput
        label={m.ganttBindingUrl()}
        value={d.value.url}
        disabled={props.readonly}
        onChange={(value) => d.set("url", value)}
      />
      <MyoxusTextInput
        label={m.timelineLabel()}
        value={d.value.tooltip}
        disabled={props.readonly}
        onChange={(value) => d.set("tooltip", value)}
      />
      <Select
        label={m.chartTarget()}
        data={["_self", "_blank", "_parent", "_top"].map((value) => ({
          value,
          label: value,
        }))}
        value={d.value.target}
        disabled={props.readonly}
        onChange={(value) => d.set("target", value as typeof d.value.target)}
      />
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      {!props.readonly ? (
        <Button
          onClick={() => {
            const result = d.commit("editClassLink", [node.sourceKey, d.value]);
            if (!result.diagnostic) onClose();
          }}
        >
          {t["com.myoxus.editCollection.save"]()}
        </Button>
      ) : null}
    </Stack>
  );
}
export function ClassDeleteControl({
  props,
  node,
  onClose,
}: {
  props: ClassReactHostProps;
  node: MermaidClassNode;
  onClose: () => void;
}) {
  const d = useClassDraft({}, props);
  const [opened, setOpened] = useState(false),
    [notes, setNotes] = useState<string>(""),
    [error, setError] = useState<string | null>(null),
    impact = props.getImpact({ kind: "class", key: node.sourceKey });
  return (
    <>
      <Button disabled={props.readonly} onClick={() => setOpened(true)}>
        {m.visualDelete()}
      </Button>
      <ConfirmModal
        open={opened}
        onOpenChange={setOpened}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        confirmButtonOptions={{
          variant: "destructive",
          disabled: Boolean(impact.attachedNotes.length && !notes),
        }}
        onConfirm={() => {
          const result = d.commit("deleteClasses", [
            [node.sourceKey],
            (notes as "keep-free" | "delete") || undefined,
          ]);
          setError(result.diagnostic ?? null);
          if (!result.diagnostic) {
            setOpened(false);
            onClose();
          }
        }}
      >
        <Stack>
          {impact.records.map((r) => (
            <MyoxusText key={r.id}>{r.label}</MyoxusText>
          ))}
          {impact.attachedNotes.length ? (
            <Select
              label={m.classNotesStrategy()}
              value={notes}
              data={[
                { value: "keep-free", label: m.classKeepNotes() },
                { value: "delete", label: m.classDeleteNotes() },
              ]}
              onChange={setNotes}
            />
          ) : null}
          {error ? (
            <Alert color="myoxusError" role="alert">
              {error}
            </Alert>
          ) : null}
        </Stack>
      </ConfirmModal>
    </>
  );
}

function ClassAnnotations({
  props,
  node,
}: {
  props: ClassReactHostProps;
  node: MermaidClassNode;
}) {
  const [opened, setOpened] = useState(false);
  const t = useI18n(),
    d = useClassDraft(
      { text: "", values: {} as Record<string, string> },
      props,
    );
  const records = props.model.sourceDocument.records.filter(
    (r) => r.ownerId === node.sourceId && r.values.annotation,
  );
  return (
    <Popover fitViewport opened={opened} onChange={setOpened}>
      <PopoverTarget>
        <Button onClick={() => setOpened(!opened)}>
          {m.classAnnotation()}
        </Button>
      </PopoverTarget>
      <PopoverContent>
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack>
            {records.map((record) => {
              const original = props.model.sourceDocument.source.slice(
                record.values.annotation!.start,
                record.values.annotation!.end,
              );
              return (
                <Group key={record.sourceKey}>
                  <MyoxusTextInput
                    label={m.classAnnotation()}
                    value={d.value.values[record.sourceKey] ?? original}
                    disabled={props.readonly}
                    onChange={(value) =>
                      d.set("values", {
                        ...d.value.values,
                        [record.sourceKey]: value,
                      })
                    }
                  />
                  {!props.readonly ? (
                    <Button
                      onClick={() =>
                        d.commit("editClassAnnotation", [
                          record.sourceKey,
                          d.value.values[record.sourceKey] ?? original,
                        ])
                      }
                    >
                      {t["com.myoxus.editCollection.save"]()}
                    </Button>
                  ) : null}
                  {!props.readonly ? (
                    <ClassAnnotationDelete
                      props={props}
                      recordKey={record.sourceKey}
                      text={original}
                    />
                  ) : null}
                </Group>
              );
            })}
            {!props.readonly ? (
              <>
                <MyoxusTextInput
                  label={m.classAnnotation()}
                  value={d.value.text}
                  onChange={(value) => d.set("text", value)}
                />
                <Button
                  onClick={() => {
                    const result = d.commit("addClassAnnotation", [
                      node.sourceKey,
                      d.value.text,
                    ]);
                    if (result.changed) d.set("text", "");
                  }}
                >
                  {t["Add"]()}
                </Button>
              </>
            ) : null}
            {d.diagnostic ? (
              <Alert color="myoxusError" role="alert">
                {d.diagnostic}
              </Alert>
            ) : null}
          </Stack>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
function ClassAnnotationDelete({
  props,
  recordKey,
  text,
}: {
  props: ClassReactHostProps;
  recordKey: string;
  text: string;
}) {
  const [opened, setOpened] = useState(false),
    d = useClassDraft({}, props);
  return (
    <>
      <Button onClick={() => setOpened(true)}>{m.visualDelete()}</Button>
      <ConfirmModal
        open={opened}
        onOpenChange={setOpened}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          const result = d.commit("editClassAnnotation", [
            recordKey,
            undefined,
          ]);
          if (!result.diagnostic) setOpened(false);
        }}
      >
        <MyoxusText>{text}</MyoxusText>
      </ConfirmModal>
    </>
  );
}
