// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  ConfirmModal,
  Group,
  Scrollable,
  Select,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  prepareC4BatchDelete,
  mermaidMessages as m,
  type C4DeleteTarget,
  type C4EditorReactHostProps,
} from "@virgultum/block-mermaid";
import {
  handleC4DraftKeyDown,
  useC4CommandPreview,
  useC4Draft,
} from "./drafts";

export function C4SelectionDeleteForm({
  props,
  onClose,
}: {
  props: C4EditorReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n(),
    draft = useC4Draft({ children: "", parentKey: "" }, props),
    preview = useC4CommandPreview(props),
    [confirming, setConfirming] = useState(false);
  const boundaries = props.model.boundaries.filter((b) =>
    props.selectedKeys.includes(b.resolution!.selectionId),
  );
  const targets: C4DeleteTarget[] = props.selectedKeys.map((selectionId) => ({
    selectionId,
    ...(boundaries.some((b) => b.resolution!.selectionId === selectionId) &&
    draft.value.children === "delete"
      ? { children: { strategy: "delete" as const } }
      : boundaries.some((b) => b.resolution!.selectionId === selectionId) &&
          draft.value.children === "adopt"
        ? {
            children: {
              strategy: "adopt" as const,
              parentKey: draft.value.parentKey || null,
            },
          }
        : {}),
  }));
  const prepared = prepareC4BatchDelete(props.model, targets),
    writable = !props.readonly && !props.displayOnly;
  useEffect(
    () => setConfirming(false),
    [props.sourceBasis, props.draftIdentity, writable],
  );
  const close = () => {
    preview.clear();
    onClose();
  };
  const objects = [
    ...props.model.elements,
    ...props.model.boundaries,
    ...props.model.relationships,
  ].filter((o) => props.selectedKeys.includes(o.resolution!.selectionId));
  return (
    <Stack
      onKeyDown={(e) =>
        handleC4DraftKeyDown(
          e,
          writable,
          () => {
            if (prepared.draft) setConfirming(true);
          },
          close,
        )
      }
    >
      {boundaries.length ? (
        <Select
          label={m.visualDelete()}
          value={draft.value.children}
          disabled={!writable}
          data={[
            { value: "delete", label: m.stateDeleteChildren() },
            {
              value: "adopt",
              label: t["com.myoxus.editor.mermaid.c4-adopt-children"](),
            },
          ]}
          onChange={(value) => {
            preview.clear();
            setConfirming(false);
            draft.set("children", value);
          }}
        />
      ) : null}
      {boundaries.length && draft.value.children === "adopt" ? (
        <Select
          label={m.chartTarget()}
          value={draft.value.parentKey}
          disabled={!writable}
          data={[
            { value: "", label: "global" },
            ...props.model.boundaries
              .filter(
                (b) => !props.selectedKeys.includes(b.resolution!.selectionId),
              )
              .map((b) => ({
                value: b.resolution!.declarationKey,
                label: `${b.label} · ${b.alias}`,
              })),
          ]}
          onChange={(value) => {
            preview.clear();
            setConfirming(false);
            draft.set("parentKey", value);
          }}
        />
      ) : null}
      {prepared.diagnostic || draft.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {draft.diagnostic ?? preview.diagnostic ?? prepared.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!writable || !prepared.draft}
            onClick={() => {
              if (prepared.draft)
                preview.preview("deleteC4Selection", [prepared.draft, true]);
            }}
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button
          disabled={!writable || !prepared.draft}
          onClick={() => setConfirming(true)}
        >
          {m.visualDelete()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
      <ConfirmModal
        open={confirming && writable && !!prepared.draft}
        onOpenChange={setConfirming}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (!prepared.draft) return;
          preview.clear();
          if (
            !draft.commit("deleteC4Selection", [prepared.draft, true])
              .diagnostic
          )
            close();
        }}
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack>
            {objects.map((o) => (
              <Text key={o.resolution!.selectionId}>
                {"alias" in o ? o.alias : `${o.from} → ${o.to}`} · {o.kind} ·{" "}
                {"boundaryId" in o
                  ? o.boundaryId || "global"
                  : "parentId" in o
                    ? o.parentId || "global"
                    : "global"}
              </Text>
            ))}
            {prepared.draft?.impact.map((change, index) => (
              <Text key={index}>
                {change.selectionId} · {change.field}:{" "}
                {String(
                  change.before && typeof change.before === "object"
                    ? change.before.text
                    : (change.before ?? ""),
                )}{" "}
                →{" "}
                {String(
                  change.after && typeof change.after === "object"
                    ? change.after.text
                    : (change.after ?? ""),
                )}
              </Text>
            ))}
            {prepared.draft?.moved.map((r) => (
              <Text key={r.sourceKey}>
                {t["com.myoxus.editor.mermaid.c4-record-position"]({
                  call: r.call,
                  line: new Intl.NumberFormat(t.language).format(r.line),
                })}{" "}
                · {r.beforeScope.join(" › ") || m.chartRoot()} →{" "}
                {r.afterScope?.join(" › ") || m.chartRoot()}
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
                {t["com.myoxus.editor.mermaid.c4-record-position"]({
                  call: r.call,
                  line: new Intl.NumberFormat(t.language).format(r.line),
                })}{" "}
                ·{" "}
                {r.beforeApplied && r.beforeFields.length
                  ? r.beforeFields.join(", ")
                  : m.stateNoNativeEffect()}{" "}
                →{" "}
                {r.afterApplied && r.afterFields.length
                  ? r.afterFields.join(", ")
                  : m.stateNoNativeEffect()}
              </Text>
            ))}
            {prepared.draft?.removed.map((r) => (
              <Text key={r.sourceKey}>
                {t["com.myoxus.editor.mermaid.c4-record-position"]({
                  call: r.call,
                  line: new Intl.NumberFormat(t.language).format(r.line),
                })}
              </Text>
            ))}
          </Stack>
        </Scrollable.Viewport>
      </ConfirmModal>
    </Stack>
  );
}
