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
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  stateDisplayText,
  type StateReactHostProps,
  type MermaidStateNode,
} from "@virgultum/block-mermaid";
import { useStateDraft, handleStateDraftKeyDown } from "./drafts";
import { StateTransitionForm } from "./transition-popover";
import {
  StateScopeSelect,
  stateScopeAnchor,
  StateReparentForm,
} from "./state-popover";
export function StatePseudostateForm({
  props,
  initialDelete = false,
  node,
  onClose,
}: {
  props: StateReactHostProps;
  initialDelete?: boolean;
  node?: MermaidStateNode;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useStateDraft(
      {
        id: node?.id ?? "",
        kind: node?.kind ?? "choice",
        target: "",
        label: "",
      },
      props,
    );
  const [scope, setScope] = useState(node?.regionKey ?? ""),
    [convert, setConvert] = useState(false),
    [deleting, setDeleting] = useState(initialDelete),
    [relation, setRelation] = useState("all"),
    [editRelation, setEditRelation] = useState(""),
    [editingRelation, setEditingRelation] = useState(false);
  const terminal = node
    ? node.kind === "start" || node.kind === "end"
    : d.value.kind === "start" || d.value.kind === "end";
  const save = () => {
    if (node && node.kind !== d.value.kind) {
      setConvert(true);
      return;
    }
    const r = node
      ? d.commit("renameStateId", [node.sourceKey!, d.value.id])
      : terminal
        ? d.commit("addStateTerminal", [
            {
              kind: d.value.kind as "start" | "end",
              target: d.value.target,
              label: d.value.label,
              anchor: stateScopeAnchor(props, scope),
            },
          ])
        : d.commit("addStatePseudostate", [
            {
              id: d.value.id,
              kind: d.value.kind as "choice" | "fork" | "join",
              anchor: stateScopeAnchor(props, scope),
            },
          ]);
    if (!r.diagnostic) onClose();
  };
  const kinds = [
    { value: "choice", label: m.stateChoice() },
    { value: "fork", label: m.stateFork() },
    { value: "join", label: m.stateJoin() },
    ...(node
      ? [{ value: "state", label: m.stateLabel() }]
      : [
          { value: "start", label: m.stateStart() },
          { value: "end", label: m.stateEnd() },
        ]),
  ];
  const bound = props.model.transitions.filter((r) =>
    node?.relationKeys?.includes(r.id),
  );
  const endpointLabel = (id: string) => {
    const state = props.model.states.find((n) => n.id === id);
    return state?.kind === "start"
      ? m.stateStart()
      : state?.kind === "end"
        ? m.stateEnd()
        : stateDisplayText(
            state?.label ??
              props.model.composites.find((n) => n.id === id)?.label ??
              id,
          );
  };
  const relationLabel = (r: (typeof bound)[number]) =>
    `${endpointLabel(r.from)} → ${endpointLabel(r.to)}${r.label ? ` · ${stateDisplayText(r.label)}` : ""}`;
  const selectedRelation = bound.find((r) => r.id === editRelation);
  if (editingRelation && selectedRelation)
    return (
      <StateTransitionForm
        props={props}
        transition={selectedRelation}
        onClose={() => setEditingRelation(false)}
      />
    );
  return (
    <Stack
      onKeyDown={(event) =>
        handleStateDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      {!terminal ? (
        <MyoxusTextInput
          autoFocus
          data-autofocus
          label={m.stateIdentifier()}
          value={d.value.id}
          disabled={props.readonly}
          onChange={(value) => d.set("id", value)}
        />
      ) : null}
      {!node || !terminal ? (
        <Select
          label={m.statePseudostate()}
          value={d.value.kind}
          disabled={props.readonly}
          data={kinds}
          onChange={(value) => d.set("kind", value as typeof d.value.kind)}
        />
      ) : (
        <MyoxusText>
          {node.kind === "start" ? m.stateStart() : m.stateEnd()}
        </MyoxusText>
      )}
      {!node && terminal ? (
        <>
          <Select
            label={m.architectureEndpointObject()}
            value={d.value.target}
            data={[
              ...props.model.states.filter(
                (n) => n.kind !== "start" && n.kind !== "end",
              ),
              ...props.model.composites,
            ].map((n) => ({ value: n.id, label: n.label }))}
            onChange={(value) => d.set("target", value)}
          />
          <MyoxusTextInput
            label={m.selectedEdgeLabel()}
            value={d.value.label}
            onChange={(value) => d.set("label", value)}
          />
        </>
      ) : null}
      {!node ? (
        <StateScopeSelect props={props} value={scope} onChange={setScope} />
      ) : !terminal ? (
        <StateReparentForm props={props} node={node} />
      ) : null}
      {node && terminal ? (
        <>
          <Select
            label={m.stateTransition()}
            value={editRelation}
            data={bound.map((r) => ({ value: r.id, label: relationLabel(r) }))}
            onChange={setEditRelation}
          />
          <Button
            disabled={props.readonly || !editRelation}
            onClick={() => setEditingRelation(true)}
          >
            {m.stateTransition()}
          </Button>
        </>
      ) : null}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {!node || !terminal ? (
          <Button disabled={props.readonly} onClick={save}>
            {t["Save"]()}
          </Button>
        ) : null}
        <Button onClick={onClose}>{m.cancel()}</Button>
        {node ? (
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
        ) : null}
      </Group>
      <ConfirmModal
        open={convert}
        onOpenChange={setConvert}
        title={m.statePseudostate()}
        confirmText={t["Save"]()}
        onConfirm={() => {
          if (
            node &&
            !d.commit("editStateNotation", [
              node.sourceKey!,
              {
                id: d.value.id,
                kind: d.value.kind as "state" | "choice" | "fork" | "join",
              },
            ]).diagnostic
          )
            onClose();
        }}
      >
        <Stack>
          {node?.descriptions?.map((r) => (
            <MyoxusText key={r.id}>{r.text}</MyoxusText>
          ))}
        </Stack>
      </ConfirmModal>
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (
            node &&
            !d.commit("deleteStatePseudostate", [
              node.sourceKey!,
              relation === "all" ? "all" : [relation],
            ]).diagnostic
          )
            onClose();
        }}
      >
        <Stack>
          {terminal ? (
            <Select
              label={m.stateTransition()}
              data={[
                { value: "all", label: m.stateAllTransitions() },
                ...bound.map((r) => ({
                  value: r.id,
                  label: relationLabel(r),
                })),
              ]}
              value={relation}
              onChange={setRelation}
            />
          ) : null}
          {(terminal
            ? bound
                .filter((r) => relation === "all" || relation === r.id)
                .map((r) => ({
                  id: r.id,
                  label: relationLabel(r),
                }))
            : props.getImpact({ kind: "state", key: node?.sourceKey ?? "" })
                .records
          ).map((r) => (
            <MyoxusText key={r.id}>{r.label}</MyoxusText>
          ))}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
