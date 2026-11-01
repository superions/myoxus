// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  ConfirmModal,
  Group,
  MyoxusTextInput,
  Scrollable,
  Select,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  C4_BOUNDARY_KINDS,
  prepareC4Grouping,
  mermaidMessages as m,
  type C4EditorReactHostProps,
  type MermaidC4BoundaryKind,
} from "@virgultum/block-mermaid";
import {
  useC4Draft,
  useC4CommandPreview,
  handleC4DraftKeyDown,
} from "./drafts";

export function C4GroupForm({
  props,
  onClose,
}: {
  props: C4EditorReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n(),
    draft = useC4Draft(
      {
        kind: (props.model.headerLine === "C4Deployment"
          ? "Deployment_Node"
          : "System_Boundary") as MermaidC4BoundaryKind,
        label: "",
      },
      props,
    ),
    preview = useC4CommandPreview(props);
  const [confirming, setConfirming] = useState(false);
  const prepared = prepareC4Grouping(
      props.model,
      props.selectedKeys,
      draft.value,
    ),
    writable = !props.readonly && !props.displayOnly;
  useEffect(
    () => setConfirming(false),
    [props.sourceBasis, props.draftIdentity, writable],
  );
  const close = () => {
    preview.clear();
    onClose();
  };
  const position = (call: string, line: number) =>
    t["com.myoxus.editor.mermaid.c4-record-position"]({
      call,
      line: new Intl.NumberFormat(t.language).format(line),
    });
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
      <Select
        label={m.erType()}
        value={draft.value.kind}
        disabled={!writable}
        data={C4_BOUNDARY_KINDS.map((kind) => ({ value: kind, label: kind }))}
        onChange={(value) => {
          const kind = C4_BOUNDARY_KINDS.find((k) => k === value);
          if (kind) {
            preview.clear();
            setConfirming(false);
            draft.set("kind", kind);
          }
        }}
      />
      <MyoxusTextInput
        label={m.timelineLabel()}
        value={draft.value.label}
        disabled={!writable}
        onChange={(value) => {
          preview.clear();
          setConfirming(false);
          draft.set("label", value);
        }}
      />
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
                preview.preview("groupC4Elements", [prepared.draft, true]);
            }}
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button
          disabled={!writable || !prepared.draft}
          onClick={() => setConfirming(true)}
        >
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
      <ConfirmModal
        open={confirming && writable && !!prepared.draft}
        onOpenChange={setConfirming}
        title={m.c4Group()}
        confirmText={t["Apply"]()}
        onConfirm={() => {
          if (!prepared.draft) return;
          preview.clear();
          const result = draft.commit("groupC4Elements", [
            prepared.draft,
            true,
          ]);
          if (!result.diagnostic) close();
        }}
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack>
            {prepared.draft ? (
              <Text>
                {prepared.draft.value.alias} · {prepared.draft.value.kind} ·{" "}
                {prepared.draft.parent || "global"}
              </Text>
            ) : null}
            {prepared.draft?.objects.map((o) => (
              <Text key={o.alias}>
                {o.alias} · {o.kind} · {o.parent || "global"}
              </Text>
            ))}
            {prepared.draft?.records.map((r) => (
              <Text key={r.sourceKey}>{position(r.call, r.line)}</Text>
            ))}
          </Stack>
        </Scrollable.Viewport>
      </ConfirmModal>
    </Stack>
  );
}
