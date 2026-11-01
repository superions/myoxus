// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Stack,
  Group,
  Button,
  Select,
  MyoxusTextInput,
  Checkbox,
  Alert,
  ConfirmModal,
  MyoxusText,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  blockConnectionTokenCandidate,
  type BlockReactHostProps,
  type MermaidBlockEdge,
  type MermaidBlockEdgeStyle,
  type MermaidBlockEndpointMarker,
} from "@virgultum/block-mermaid";
import {
  useBlockDraft,
  useBlockCommandPreview,
  handleBlockDraftKeyDown,
} from "./drafts";
export function BlockConnectionForm({
  props,
  connection,
  onClose,
}: {
  props: BlockReactHostProps;
  connection?: MermaidBlockEdge;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useBlockDraft(
      {
        from: connection?.from ?? "",
        to: connection?.to ?? "",
        label: connection?.label ?? "",
        style: connection?.style ?? ("solid" as MermaidBlockEdgeStyle),
        sourceMarker:
          connection?.sourceMarker ?? ("none" as MermaidBlockEndpointMarker),
        targetMarker:
          connection?.targetMarker ?? ("arrow" as MermaidBlockEndpointMarker),
        invisible: connection?.invisible ?? false,
      },
      props,
    ),
    preview = useBlockCommandPreview(props),
    [loss, setLoss] = useState(false),
    [deleting, setDeleting] = useState(false);
  const changedNotation =
      !connection ||
      d.value.style !== connection.style ||
      d.value.sourceMarker !== connection.sourceMarker ||
      d.value.targetMarker !== connection.targetMarker ||
      d.value.invisible !== connection.invisible,
    token = changedNotation
      ? blockConnectionTokenCandidate(
          d.value.style,
          d.value.sourceMarker,
          d.value.targetMarker,
          d.value.invisible,
        )
      : connection.token,
    targets = [
      ...props.model.nodes,
      ...props.model.groups.filter((g) => g.explicitId),
    ].map((n) => ({ value: n.id, label: String(n.label || n.id) })),
    markers = [
      { value: "none", label: m.optionOpen() },
      { value: "arrow", label: m.optionArrow() },
      { value: "circle", label: m.shapeCircle() },
      { value: "cross", label: m.optionCross() },
    ];
  const changes = (confirmed = false) => ({
    from: d.value.from,
    to: d.value.to,
    label: d.value.label,
    ...(changedNotation ? { token: token ?? "" } : {}),
    confirmLabelLoss: confirmed,
  });
  const save = (confirmed = false) => {
    if (!token) return;
    if (d.value.invisible && d.value.label && !confirmed) {
      setLoss(true);
      return;
    }
    preview.clear();
    const r = connection
      ? d.commit("updateBlockConnection", [
          connection.sourceKey,
          changes(confirmed),
        ])
      : d.commit("addBlockConnection", [
          {
            from: d.value.from,
            to: d.value.to,
            label: d.value.invisible ? "" : d.value.label,
            token,
          },
        ]);
    if (!r.diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(e) =>
        handleBlockDraftKeyDown(e, props.readonly, () => save(), onClose)
      }
    >
      <Select
        label={m.visualReconnectSource()}
        value={d.value.from}
        data={targets}
        disabled={props.readonly}
        onChange={(v) => d.set("from", v)}
      />
      <Select
        label={m.visualReconnectTarget()}
        value={d.value.to}
        data={targets}
        disabled={props.readonly}
        onChange={(v) => d.set("to", v)}
      />
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={m.sequenceAlias()}
        value={d.value.label}
        disabled={props.readonly}
        onChange={(v) => d.set("label", v)}
      />
      <Select
        label={m.selectedEdgeStyle()}
        value={d.value.style}
        data={[
          { value: "solid", label: m.optionSolid() },
          { value: "dotted", label: m.optionDotted() },
          { value: "thick", label: m.optionThick() },
        ]}
        disabled={props.readonly || d.value.invisible}
        onChange={(v) => d.set("style", v as MermaidBlockEdgeStyle)}
      />
      <Select
        label={m.architectureSourceArrowhead()}
        value={d.value.sourceMarker}
        data={markers}
        disabled={props.readonly || d.value.invisible}
        onChange={(v) => d.set("sourceMarker", v as MermaidBlockEndpointMarker)}
      />
      <Select
        label={m.architectureTargetArrowhead()}
        value={d.value.targetMarker}
        data={markers}
        disabled={props.readonly || d.value.invisible}
        onChange={(v) => d.set("targetMarker", v as MermaidBlockEndpointMarker)}
      />
      <Checkbox
        label={m.blockInvisible()}
        checked={d.value.invisible}
        disabled={props.readonly}
        onChange={(e) => d.set("invisible", e.currentTarget.checked)}
      />
      <MyoxusText>
        {m.blockToken()}: {token ?? m.blockInvalidToken()}
      </MyoxusText>
      {!token ? (
        <Alert color="myoxusError" role="alert">
          {m.blockInvalidToken()}
        </Alert>
      ) : null}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={props.readonly || !token || !d.value.from || !d.value.to}
          onClick={() => save()}
        >
          {t["Save"]()}
        </Button>
        <Button
          disabled={props.readonly || !connection || !token}
          onClick={() => {
            if (connection)
              preview.preview("updateBlockConnection", [
                connection.sourceKey,
                changes(),
              ]);
          }}
        >
          {m.sequencePreview()}
        </Button>
        <Button
          onClick={() => {
            preview.clear();
            onClose();
          }}
        >
          {m.cancel()}
        </Button>
        {connection ? (
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
        ) : null}
      </Group>
      <ConfirmModal
        open={loss}
        onOpenChange={setLoss}
        title={m.blockInvisible()}
        confirmText={t["Confirm"]()}
        onConfirm={() => {
          setLoss(false);
          save(true);
        }}
      >
        <MyoxusText>{m.blockLabelLoss()}</MyoxusText>
      </ConfirmModal>
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (
            connection &&
            !d.commit("deleteBlockConnection", [connection.sourceKey])
              .diagnostic
          )
            onClose();
        }}
      >
        <MyoxusText>{connection?.label}</MyoxusText>
      </ConfirmModal>
    </Stack>
  );
}
