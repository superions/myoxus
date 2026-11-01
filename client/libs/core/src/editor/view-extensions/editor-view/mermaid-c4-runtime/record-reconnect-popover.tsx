// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
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
  mermaidMessages as m,
  prepareC4RecordReconnect,
  type C4ReactHostProps,
  type C4RecordStylePolicy,
  type C4FieldValue,
} from "@virgultum/block-mermaid";
import {
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
  useC4Draft,
  useC4CommandPreview,
} from "./drafts";

export function C4RecordReconnectControl({
  props,
  sourceKey,
}: {
  props: C4ReactHostProps;
  sourceKey: string;
}) {
  const [opened, setOpened] = useState(false),
    t = useI18n();
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
          {t["com.myoxus.editor.mermaid.c4-reconnect-record"]()}
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
            <C4RecordReconnectForm
              key={sourceKey}
              props={props}
              sourceKey={sourceKey}
              onClose={() => {
                setOpened(false);
                props.resolveReturnFocusTarget()?.focus();
              }}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
function C4RecordReconnectForm({
  props,
  sourceKey,
  onClose,
}: {
  props: C4ReactHostProps;
  sourceKey: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    occurrence = props.model.occurrences.find(
      (o) => o.sourceKey === sourceKey,
    )!,
    owner = props.model.relationships.find(
      (r) => r.resolution!.selectionId === occurrence.selectionId,
    )!;
  const d = useC4Draft(
      {
        from: owner.from,
        to: owner.to,
        policy: null as C4RecordStylePolicy | null,
      },
      props,
    ),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const prepared = prepareC4RecordReconnect(
    props.model,
    sourceKey,
    d.value.from,
    d.value.to,
    d.value.policy,
  );
  const endpoints = props.model.elements.map((e) => ({
    value: e.alias,
    label: `${e.label} · ${e.alias}`,
  }));
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    if (!prepared.draft) return;
    preview.clear();
    if (!d.commit("reconnectC4Record", [prepared.draft, true]).diagnostic)
      close();
  };
  const value = (v: C4FieldValue | undefined) =>
    typeof v === "number"
      ? new Intl.NumberFormat(t.language).format(v)
      : typeof v === "string"
        ? v
        : (v?.text ?? "—");
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <Select
        label={m.chartSource()}
        value={d.value.from}
        disabled={!writable}
        data={endpoints}
        onChange={(from) => {
          preview.clear();
          d.set("from", from);
          d.set("policy", null);
        }}
      />
      <Select
        label={m.chartTarget()}
        value={d.value.to}
        disabled={!writable}
        data={endpoints}
        onChange={(to) => {
          preview.clear();
          d.set("to", to);
          d.set("policy", null);
        }}
      />
      {prepared.needsPolicy || d.value.policy ? (
        <Select
          label={t["com.myoxus.editor.mermaid.c4-style-policy"]()}
          value={d.value.policy}
          disabled={!writable}
          data={[
            {
              value: "keep",
              label: t["com.myoxus.editor.mermaid.c4-style-keep"](),
            },
            {
              value: "transfer",
              label: t["com.myoxus.editor.mermaid.c4-style-transfer"](),
            },
          ]}
          onChange={(policy) => {
            if (policy === "keep" || policy === "transfer") {
              preview.clear();
              d.set("policy", policy);
            }
          }}
        />
      ) : null}
      <Scrollable.Viewport autosize maxHeight="floating">
        <Stack>
          {prepared.impact?.map((i) => (
            <Stack key={i.selectionId}>
              <Text>
                {i.beforePair ?? "—"} → {i.afterPair ?? "—"}
              </Text>
              {i.beforeStep !== i.afterStep ? (
                <Text>
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
              ) : null}
              {i.fields.map((f) => (
                <Text key={f.field}>
                  {f.field}: {value(f.before)} → {value(f.after)}
                </Text>
              ))}
            </Stack>
          ))}
          {prepared.styles?.map((s) => (
            <Stack key={s.sourceKey}>
              <Text>
                {t["com.myoxus.editor.mermaid.c4-record-position"]({
                  call: s.call,
                  line: `${new Intl.NumberFormat(t.language).format(s.line)} → ${new Intl.NumberFormat(t.language).format(s.afterLine)}`,
                })}{" "}
                · {s.beforeScope.join(" › ") || m.chartRoot()} →{" "}
                {s.afterScope.join(" › ") || m.chartRoot()}
              </Text>
              <Text>
                {s.target ?? "—"} · {s.beforeFields.join(", ") || "—"} →{" "}
                {s.afterFields.join(", ") || "—"}
              </Text>
              {!s.applied ? <Text>{m.stateNoNativeEffect()}</Text> : null}
            </Stack>
          ))}
        </Stack>
      </Scrollable.Viewport>
      {prepared.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? prepared.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand && prepared.draft ? (
          <Button
            disabled={!writable}
            onClick={() =>
              preview.preview("reconnectC4Record", [prepared.draft!, true])
            }
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button disabled={!writable || !prepared.draft} onClick={save}>
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
