// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect } from "react";
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
  stateDisplayText,
  type StateReactHostProps,
  type MermaidStateTransition,
} from "@virgultum/block-mermaid";
import {
  useStateDraft,
  handleStateDraftKeyDown,
  useStateCommandPreview,
} from "./drafts";
import { StateScopeSelect, stateScopeAnchor } from "./state-popover";
export function StateTransitionForm({
  props,
  initialDelete = false,
  transition,
  onClose,
}: {
  props: StateReactHostProps;
  initialDelete?: boolean;
  transition?: MermaidStateTransition;
  onClose: () => void;
}) {
  const t = useI18n(),
    from = props.model.states.find((n) => n.id === transition?.from),
    to = props.model.states.find((n) => n.id === transition?.to);
  const d = useStateDraft(
    {
      from:
        from?.kind === "start"
          ? "[*]"
          : (transition?.from ??
            props.model.states.find((n) => n.sourceKey === props.selected?.key)
              ?.id ??
            ""),
      to: to?.kind === "end" ? "[*]" : (transition?.to ?? ""),
      label: stateDisplayText(transition?.label ?? ""),
      fromClass: transition?.fromClass ?? "",
      toClass: transition?.toClass ?? "",
    },
    props,
  );
  const [scope, setScope] = useState(transition?.regionKey ?? ""),
    [deleting, setDeleting] = useState(initialDelete),
    [previewDiagnostic, setPreviewDiagnostic] = useState<string | null>(null);
  const preview = useStateCommandPreview(props);
  useEffect(() => {
    preview.clear();
    setPreviewDiagnostic(null);
  }, [d.value, scope, preview.clear]);
  const endpoints = [
    ...props.model.states.filter((n) => n.kind !== "start" && n.kind !== "end"),
    ...props.model.composites,
  ].map((n) => ({
    value: n.id,
    label: `${stateDisplayText(n.label)} · ${n.id}`,
  }));
  const siblings = props.model.transitions.filter(
      (r) =>
        r.parentId === transition?.parentId &&
        r.regionKey === transition?.regionKey,
    ),
    index = siblings.findIndex((r) => r.id === transition?.id);
  const value = {
    ...d.value,
    ...(!transition || scope !== (transition.regionKey ?? "")
      ? { anchor: stateScopeAnchor(props, scope) }
      : {}),
  };
  const save = () => {
    const r = transition
      ? d.commit("editStateTransition", [transition.id, value])
      : d.commit("addStateTransition", [value]);
    if (!r.diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) =>
        handleStateDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <Select
        label={m.architectureSourceEndpoint()}
        value={d.value.from}
        disabled={props.readonly}
        data={[{ value: "[*]", label: m.stateStart() }, ...endpoints]}
        onChange={(value) => d.set("from", value)}
      />
      <Select
        label={m.architectureTargetEndpoint()}
        value={d.value.to}
        disabled={props.readonly}
        data={[{ value: "[*]", label: m.stateEnd() }, ...endpoints]}
        onChange={(value) => d.set("to", value)}
      />
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={m.selectedEdgeLabel()}
        value={d.value.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
      />
      <MyoxusTextInput
        label={`${m.architectureSourceEndpoint()} · ${m.treemapClasses()}`}
        value={d.value.fromClass}
        disabled={props.readonly}
        onChange={(value) => d.set("fromClass", value)}
      />
      <MyoxusTextInput
        label={`${m.architectureTargetEndpoint()} · ${m.treemapClasses()}`}
        value={d.value.toClass}
        disabled={props.readonly}
        onChange={(value) => d.set("toClass", value)}
      />
      <StateScopeSelect props={props} value={scope} onChange={setScope} />
      <MyoxusText>
        {d.value.from === "[*]"
          ? m.stateStart()
          : endpoints.find((n) => n.value === d.value.from)?.label}
        {" → "}
        {d.value.to === "[*]"
          ? m.stateEnd()
          : endpoints.find((n) => n.value === d.value.to)?.label}
        {d.value.label ? ` · ${d.value.label}` : ""}
      </MyoxusText>
      {d.diagnostic || previewDiagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? previewDiagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={props.readonly || !d.value.from || !d.value.to}
          onClick={() => {
            const result = transition
              ? preview.preview("editStateTransition", [transition.id, value])
              : preview.preview("addStateTransition", [value]);
            setPreviewDiagnostic(result?.diagnostic ?? null);
          }}
        >
          {m.sequencePreview()}
        </Button>
        <Button disabled={props.readonly} onClick={save}>
          {t["Save"]()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
      {transition ? (
        <>
          <Group>
            <Button
              disabled={props.readonly || index <= 0}
              onClick={() =>
                d.commit("reorderStateTransition", [
                  transition.id,
                  siblings[index - 1]!.id,
                ])
              }
            >
              {m.visualMoveUp()}
            </Button>
            <Button
              disabled={props.readonly || index >= siblings.length - 1}
              onClick={() =>
                d.commit("reorderStateTransition", [
                  siblings[index + 1]!.id,
                  transition.id,
                ])
              }
            >
              {m.visualMoveDown()}
            </Button>
            <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
              {m.visualDelete()}
            </Button>
          </Group>
          <ConfirmModal
            open={deleting}
            onOpenChange={setDeleting}
            title={m.visualDelete()}
            confirmText={m.visualDelete()}
            onConfirm={() => {
              if (
                !d.commit("deleteStateTransition", [transition.id]).diagnostic
              )
                onClose();
            }}
          >
            <MyoxusText>
              {transition.from} → {transition.to} · {transition.label}
            </MyoxusText>
          </ConfirmModal>
        </>
      ) : null}
    </Stack>
  );
}
