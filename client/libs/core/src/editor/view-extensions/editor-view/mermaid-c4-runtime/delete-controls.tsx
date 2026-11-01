// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  ConfirmModal,
  Group,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  Select,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  prepareC4Delete,
  mermaidMessages as m,
  type C4ReactHostProps,
  type C4DeleteTarget,
  type C4FieldValue,
} from "@virgultum/block-mermaid";
import {
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
  useC4CommandPreview,
  useC4Draft,
} from "./drafts";

/** Local controls and host/keyboard delete share this exact intent and confirmation. */
export function C4DeleteControl({
  props,
  target,
  onDeleted,
}: {
  props: C4ReactHostProps;
  target: C4DeleteTarget;
  onDeleted?: () => void;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover
      closeOnEscape={false}
      fitViewport
      trapFocus
      opened={opened}
      onChange={setOpened}
    >
      <PopoverTarget>
        <Button
          disabled={props.readonly || props.displayOnly}
          onClick={() => setOpened(true)}
        >
          {m.visualDelete()}
        </Button>
      </PopoverTarget>
      <PopoverContent
        data-myoxus-editor-keyboard-owner="c4"
        onMouseDown={isolateC4PortalledMouseDown}
        onKeyDown={(event) =>
          handleC4PopoverKeyDown(event, () => setOpened(false))
        }
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <C4DeleteForm
              props={props}
              target={target}
              onClose={() => {
                setOpened(false);
                props.resolveReturnFocusTarget()?.focus();
              }}
              onDeleted={() => {
                setOpened(false);
                onDeleted?.();
              }}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
export function C4DeleteForm({
  props,
  target,
  onClose,
  onDeleted,
}: {
  props: C4ReactHostProps;
  target: C4DeleteTarget;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useI18n(),
    owner = [
      ...props.model.elements,
      ...props.model.boundaries,
      ...props.model.relationships,
    ].find((o) => o.resolution!.selectionId === target.selectionId)!;
  const d = useC4Draft(
      {
        recordKey: target.recordKey ?? "",
        strategy: target.children?.strategy ?? "",
        parentKey:
          target.children?.strategy === "adopt"
            ? (target.children.parentKey ?? "")
            : "",
      },
      props,
    ),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const [confirming, setConfirming] = useState(false);
  if (
    !owner ||
    (target.recordKey &&
      !props.model.sourceDocument.records.some(
        (r) => r.sourceKey === target.recordKey,
      ))
  )
    return null;
  const boundary = "parentId" in owner,
    records = props.model.sourceDocument.records;
  const current: C4DeleteTarget = {
    selectionId: target.selectionId,
    recordKey: d.value.recordKey || undefined,
    ...(boundary && d.value.strategy
      ? {
          children:
            d.value.strategy === "adopt"
              ? { strategy: "adopt", parentKey: d.value.parentKey || null }
              : { strategy: "delete" },
        }
      : {}),
  };
  const prepared = prepareC4Delete(props.model, current);
  const deletedKeys = new Set(
    d.value.recordKey ? [d.value.recordKey] : owner.resolution!.sourceKeys,
  );
  const position = (call: string, line: number) =>
    t["com.myoxus.editor.mermaid.c4-record-position"]({
      call,
      line: new Intl.NumberFormat(t.language).format(line),
    });
  const fieldValue = (value: C4FieldValue | undefined) =>
    typeof value === "number"
      ? new Intl.NumberFormat(t.language).format(value)
      : typeof value === "string"
        ? value
        : (value?.text ?? "—");
  const scope = (aliases: readonly string[]) =>
    aliases.join(" › ") || m.chartRoot();
  const name = (id: string) => {
    const object = [
      ...props.model.elements,
      ...props.model.boundaries,
      ...props.model.relationships,
    ].find((o) => o.resolution!.selectionId === id);
    return object
      ? "from" in object
        ? `${object.from} → ${object.to}`
        : object.alias
      : id === "c4-layout"
        ? m.layoutLabel()
        : "—";
  };
  const close = () => {
    preview.clear();
    onClose();
  };
  const edit = <K extends keyof typeof d.value>(
    key: K,
    value: (typeof d.value)[K],
  ) => {
    preview.clear();
    setConfirming(false);
    d.set(key, value);
  };
  const ready = writable && !!prepared.draft;
  return (
    <Stack
      onKeyDown={(event) =>
        handleC4DraftKeyDown(
          event,
          writable,
          () => {
            if (ready) setConfirming(true);
          },
          close,
        )
      }
    >
      <Text>
        {"from" in owner ? `${owner.from} → ${owner.to}` : owner.alias}
      </Text>
      {!target.recordKey ? (
        <Select
          label={t["com.myoxus.editor.mermaid.c4-delete-scope"]()}
          value={d.value.recordKey}
          disabled={!writable}
          data={[
            {
              value: "",
              label: t["com.myoxus.editor.mermaid.c4-delete-object"](),
            },
            ...records
              .filter((r) => owner.resolution!.sourceKeys.includes(r.sourceKey))
              .map((r) => ({
                value: r.sourceKey,
                label: position(r.callKind!, r.range.line),
              })),
          ]}
          onChange={(value) => edit("recordKey", value)}
        />
      ) : (
        <Text>
          {position(
            records.find((r) => r.sourceKey === target.recordKey)!.callKind!,
            records.find((r) => r.sourceKey === target.recordKey)!.range.line,
          )}
        </Text>
      )}
      <Text>
        {d.value.recordKey
          ? t["com.myoxus.editor.mermaid.c4-delete-record"]()
          : t["com.myoxus.editor.mermaid.c4-delete-object"]()}
      </Text>
      {boundary ? (
        <Select
          label={m.stateDeleteChildren()}
          value={d.value.strategy || null}
          disabled={!writable}
          data={[
            { value: "delete", label: m.stateDeleteChildren() },
            {
              value: "adopt",
              label: t["com.myoxus.editor.mermaid.c4-adopt-children"](),
            },
          ]}
          onChange={(value) => {
            if (value === "delete" || value === "adopt")
              edit("strategy", value);
          }}
        />
      ) : null}
      {boundary && d.value.strategy === "adopt" ? (
        <Select
          label={m.chartParent()}
          value={d.value.parentKey}
          disabled={!writable}
          data={[
            { value: "", label: m.chartRoot() },
            ...records
              .filter(
                (r) =>
                  r.kind === "boundary-open" &&
                  r.closeKey &&
                  !deletedKeys.has(r.sourceKey) &&
                  !r.scopeKeys.some((key) => deletedKeys.has(key)),
              )
              .map((r) => ({
                value: r.sourceKey,
                label: position(r.arguments![1].value, r.range.line),
              })),
          ]}
          onChange={(value) => edit("parentKey", value)}
        />
      ) : null}
      {d.diagnostic ||
      preview.diagnostic ||
      (prepared.diagnostic && (!boundary || d.value.strategy)) ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? prepared.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!ready}
            onClick={() => {
              if (prepared.draft)
                preview.preview("deleteC4", [prepared.draft, true]);
            }}
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button disabled={!ready} onClick={() => setConfirming(true)}>
          {m.visualDelete()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
      <ConfirmModal
        open={confirming && ready}
        onOpenChange={setConfirming}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (!prepared.draft) return;
          preview.clear();
          const result = d.commit("deleteC4", [prepared.draft, true]);
          if (!result.diagnostic) {
            setConfirming(false);
            onDeleted();
          }
        }}
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack>
            {prepared.draft?.removed.map((r) => (
              <Text key={r.sourceKey}>
                {m.visualDelete()} · {position(r.call, r.line)} ·{" "}
                {scope(r.beforeScope)}
              </Text>
            ))}
            {prepared.draft?.moved.map((r) => (
              <Text key={r.sourceKey}>
                {position(r.call, r.line)} · {scope(r.beforeScope)} →{" "}
                {scope(r.afterScope ?? [])}
              </Text>
            ))}
            {prepared.draft?.impact.map((i) => (
              <Text key={`${i.selectionId}:${i.field}`}>
                {name(i.selectionId)} · {i.field}: {fieldValue(i.before)} →{" "}
                {fieldValue(i.after)}
                {i.providers?.before
                  ? ` · ${position(i.providers.before.call, i.providers.before.line)}`
                  : ""}
                {i.providers?.after
                  ? ` → ${position(i.providers.after.call, i.providers.after.line)}`
                  : ""}
              </Text>
            ))}
            {prepared.draft?.pairs
              .filter((i) => i.beforeStep !== i.afterStep)
              .map((i) => (
                <Text key={i.selectionId}>
                  {i.beforePair ?? i.afterPair} ·{" "}
                  {i.beforeStep === undefined
                    ? "—"
                    : new Intl.NumberFormat(t.language).format(
                        i.beforeStep,
                      )}{" "}
                  →{" "}
                  {i.afterStep === undefined
                    ? "—"
                    : new Intl.NumberFormat(t.language).format(i.afterStep)}
                </Text>
              ))}
            {prepared.draft?.styles.map((r) => (
              <Text key={r.sourceKey}>
                {position(r.call, r.line)} ·{" "}
                {r.beforeApplied && r.beforeFields.length
                  ? r.beforeFields.join(", ")
                  : m.stateNoNativeEffect()}{" "}
                →{" "}
                {r.afterApplied && r.afterFields.length
                  ? r.afterFields.join(", ")
                  : m.stateNoNativeEffect()}
              </Text>
            ))}
          </Stack>
        </Scrollable.Viewport>
      </ConfirmModal>
    </Stack>
  );
}
