// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  ConfirmModal,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  SEQUENCE_FRAGMENT_KINDS,
  sequenceBranchKind,
  type SequenceReactHostProps,
  type MermaidSequenceControl,
  type MermaidSequenceControlBranch,
} from "@virgultum/block-mermaid";
import {
  useSequenceDraft,
  changedSequenceFields,
  handleSequenceDraftKeyDown,
  sequenceDraftAnchor,
  sequenceTimelineOptions,
} from "./drafts";
export function SequenceFragmentForm({
  props,
  fragment,
  onClose,
}: {
  props: SequenceReactHostProps;
  fragment?: MermaidSequenceControl;
  onClose: () => void;
}) {
  const initial = {
      kind: fragment?.kind ?? ("alt" as const),
      label: fragment?.label ?? "",
    },
    d = useSequenceDraft(initial, props),
    span = useSequenceDraft(
      {
        start: "",
        end: "",
        parentId: fragment?.parentId ?? "",
        branchId: "",
        beforeId: "",
      },
      props,
    ),
    [deleting, setDeleting] = useState(false),
    [keepContents, setKeepContents] = useState(true);
  const run = (preview = false) =>
    fragment
      ? (preview ? d.preview : d.commit)("editSequenceFragment", [
          fragment.id,
          changedSequenceFields(initial, d.value),
        ])
      : (preview ? d.preview : d.commit)("addSequenceFragment", [
          {
            ...d.value,
            start: sequenceDraftAnchor(span.value.start),
            end: sequenceDraftAnchor(span.value.end, "after"),
          },
        ]);
  const save = () => {
    if (!run().diagnostic) onClose();
  };
  const parent = props.model.controls.find(
    (control) => control.id === span.value.parentId,
  );
  return (
    <Stack
      onKeyDown={(event) =>
        handleSequenceDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <Select
        autoFocus
        label={m.sequenceFragment()}
        value={d.value.kind}
        disabled={props.readonly}
        data={SEQUENCE_FRAGMENT_KINDS.map((value) => ({
          value,
          label: m.sequenceFragmentKind(value),
        }))}
        onChange={(value) => d.set("kind", value as typeof initial.kind)}
      />
      <MyoxusTextInput
        label={m.timelineLabel()}
        value={d.value.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
      />
      {!fragment ? (
        <>
          <Select
            label={m.sequenceStart()}
            data={sequenceTimelineOptions(props)}
            value={span.value.start}
            disabled={props.readonly}
            onChange={(value) => span.set("start", value ?? "")}
          />
          <Select
            label={m.sequenceEnd()}
            data={sequenceTimelineOptions(props)}
            value={span.value.end}
            disabled={props.readonly}
            onChange={(value) => span.set("end", value ?? "")}
          />
        </>
      ) : null}
      {d.diagnostic || span.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic || span.diagnostic}
        </Alert>
      ) : null}
      {d.impact.map((record) => (
        <MyoxusText key={record.id}>{record.label}</MyoxusText>
      ))}
      <Group>
        <Button disabled={props.readonly} onClick={() => run(true)}>
          {m.sequencePreview()}
        </Button>
        <Button disabled={props.readonly} onClick={save}>
          {m.sequenceApply()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
      {fragment ? (
        <>
          <Select
            label={m.sequenceSourceOrder()}
            data={sequenceTimelineOptions(props).filter(
              (option) => option.value !== fragment.id,
            )}
            value={span.value.beforeId}
            disabled={props.readonly}
            onChange={(value) => span.set("beforeId", value ?? "")}
          />
          <Group>
            <Button
              disabled={props.readonly}
              onClick={() =>
                span.preview("reorderSequenceFragment", [
                  fragment.id,
                  sequenceDraftAnchor(span.value.beforeId),
                ])
              }
            >
              {m.sequencePreview()}
            </Button>
            <Button
              disabled={props.readonly}
              onClick={() => {
                if (
                  !span.commit("reorderSequenceFragment", [
                    fragment.id,
                    sequenceDraftAnchor(span.value.beforeId),
                  ]).diagnostic
                )
                  onClose();
              }}
            >
              {m.treemapMove()}
            </Button>
          </Group>
          <Select
            label={m.sequenceParent()}
            data={[
              { value: "", label: m.sequenceOff() },
              ...props.model.controls
                .filter((control) => control.id !== fragment.id)
                .map((control) => ({
                  value: control.id,
                  label: `${m.sequenceFragmentKind(control.kind)} · ${control.label}`,
                })),
            ]}
            value={span.value.parentId}
            disabled={props.readonly}
            onChange={(value) => {
              span.set("parentId", value ?? "");
              span.set("branchId", "");
            }}
          />
          {parent ? (
            <Select
              label={m.sequenceBranch()}
              data={parent.branches.map((branch) => ({
                value: branch.id,
                label: branch.label || m.sequenceBranch(),
              }))}
              value={span.value.branchId || parent.branches[0]?.id || ""}
              disabled={props.readonly}
              onChange={(value) => span.set("branchId", value ?? "")}
            />
          ) : null}
          <Group>
            <Button
              disabled={props.readonly}
              onClick={() =>
                span.preview("nestSequenceFragment", [
                  fragment.id,
                  span.value.parentId || null,
                  span.value.branchId || parent?.branches[0]?.id,
                ])
              }
            >
              {m.sequencePreview()}
            </Button>
            <Button
              disabled={props.readonly}
              onClick={() => {
                if (
                  !span.commit("nestSequenceFragment", [
                    fragment.id,
                    span.value.parentId || null,
                    span.value.branchId || parent?.branches[0]?.id,
                  ]).diagnostic
                )
                  onClose();
              }}
            >
              {m.sequenceApply()}
            </Button>
          </Group>
          {fragment.branches.map((branch) => (
            <SequenceBranchForm
              key={branch.id}
              props={props}
              fragment={fragment}
              branch={branch}
            />
          ))}
          {sequenceBranchKind(fragment.kind) ? (
            <SequenceBranchForm props={props} fragment={fragment} />
          ) : null}
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
          <ConfirmModal
            open={deleting}
            onOpenChange={setDeleting}
            title={m.visualDelete()}
            confirmText={m.visualDelete()}
            onConfirm={() => {
              if (
                !d.commit("deleteSequenceFragment", [fragment.id, keepContents])
                  .diagnostic
              )
                onClose();
            }}
          >
            <Stack>
              <Checkbox
                label={m.sequenceKeepContents()}
                checked={keepContents}
                onChange={(event) =>
                  setKeepContents(event.currentTarget.checked)
                }
              />
              {props
                .getImpact({ kind: "fragment", key: fragment.id }, keepContents)
                .records.map((record) => (
                  <MyoxusText key={record.id}>{record.label}</MyoxusText>
                ))}
            </Stack>
          </ConfirmModal>
        </>
      ) : null}
    </Stack>
  );
}
export function SequenceBranchForm({
  props,
  fragment,
  branch,
}: {
  props: SequenceReactHostProps;
  fragment: MermaidSequenceControl;
  branch?: MermaidSequenceControlBranch;
}) {
  const d = useSequenceDraft(
      { label: branch?.label ?? "", beforeId: "" },
      props,
    ),
    [deleting, setDeleting] = useState(false),
    run = (preview = false) =>
      branch
        ? (preview ? d.preview : d.commit)("editSequenceBranch", [
            branch.id,
            { label: d.value.label },
          ])
        : (preview ? d.preview : d.commit)("addSequenceBranch", [
            fragment.id,
            { label: d.value.label, beforeId: d.value.beforeId || undefined },
          ]);
  return (
    <Stack>
      <MyoxusText>
        {branch?.kind === "primary"
          ? m.sequenceFragmentKind(fragment.kind)
          : m.sequenceBranch()}
      </MyoxusText>
      <MyoxusTextInput
        label={m.timelineLabel()}
        value={d.value.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
      />
      <Group>
        <Button disabled={props.readonly} onClick={() => run(true)}>
          {m.sequencePreview()}
        </Button>
        <Button disabled={props.readonly} onClick={() => run()}>
          {m.sequenceApply()}
        </Button>
      </Group>
      <Select
        label={m.sequenceSourceOrder()}
        data={[
          { value: "", label: m.sequenceEnd() },
          ...fragment.branches
            .filter((other) => other.id !== branch?.id)
            .map((other) => ({
              value: other.id,
              label: other.label || m.sequenceBranch(),
            })),
        ]}
        value={d.value.beforeId}
        disabled={props.readonly}
        onChange={(value) => d.set("beforeId", value ?? "")}
      />
      {branch ? (
        <>
          <Group>
            <Button
              disabled={props.readonly}
              onClick={() =>
                d.preview("reorderSequenceBranch", [
                  branch.id,
                  d.value.beforeId || undefined,
                ])
              }
            >
              {m.sequencePreview()}
            </Button>
            <Button
              disabled={props.readonly}
              onClick={() =>
                d.commit("reorderSequenceBranch", [
                  branch.id,
                  d.value.beforeId || undefined,
                ])
              }
            >
              {m.treemapMove()}
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
              if (!d.commit("deleteSequenceBranch", [branch.id]).diagnostic)
                setDeleting(false);
            }}
          >
            <Stack>
              {props
                .getImpact({ kind: "branch", key: branch.id })
                .records.map((record) => (
                  <MyoxusText key={record.id}>{record.label}</MyoxusText>
                ))}
            </Stack>
          </ConfirmModal>
        </>
      ) : null}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
    </Stack>
  );
}
