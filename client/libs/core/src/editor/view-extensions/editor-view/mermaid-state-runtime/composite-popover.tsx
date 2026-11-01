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
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  stateDisplayText,
  type StateReactHostProps,
  type MermaidStateComposite,
} from "@virgultum/block-mermaid";
import {
  useStateDraft,
  handleStateDraftKeyDown,
  changedStateFields,
  useStateCommandPreview,
} from "./drafts";
import {
  StateScopeSelect,
  stateScopeAnchor,
  StateReparentForm,
  StateForm,
} from "./state-popover";
import { StateRegionPopover } from "./region-popover";
import { StateObjectNotes } from "./note-popover";
import { StateAppearanceForm } from "./appearance-popover";
export function StateCompositeForm({
  props,
  initialDelete = false,
  composite,
  group = false,
  onClose,
}: {
  props: StateReactHostProps;
  initialDelete?: boolean;
  composite?: MermaidStateComposite;
  group?: boolean;
  onClose: () => void;
}) {
  const t = useI18n(),
    initial = {
      id: composite?.id ?? "",
      label: stateDisplayText(composite?.label ?? ""),
      direction: composite?.direction ?? "TB",
    },
    d = useStateDraft(initial, props);
  const preview = useStateCommandPreview(props),
    [groupConfirm, setGroupConfirm] = useState(false),
    [groupDiagnostic, setGroupDiagnostic] = useState<string | null>(null);
  const [scope, setScope] = useState(composite?.regionKey ?? ""),
    [deleting, setDeleting] = useState(initialDelete),
    [children, setChildren] = useState<"delete" | "reassign">("reassign"),
    [target, setTarget] = useState(composite?.regionKey ?? ""),
    [addingChild, setAddingChild] = useState(false),
    [appearance, setAppearance] = useState(false);
  const save = (confirmed = false) => {
    if (group && !confirmed) {
      const candidate = preview.preview("addStateComposite", [
        {
          id: d.value.id,
          label: d.value.label || undefined,
          selection: props.selectedKeys,
        },
      ]);
      setGroupDiagnostic(candidate?.diagnostic ?? null);
      if (!candidate?.diagnostic) setGroupConfirm(true);
      return;
    }
    const r = composite
      ? d.commit("editStateComposite", [
          composite.sourceKey!,
          changedStateFields(initial, d.value),
        ])
      : d.commit("addStateComposite", [
          {
            id: d.value.id,
            label: d.value.label || undefined,
            ...(group
              ? { selection: props.selectedKeys }
              : { anchor: stateScopeAnchor(props, scope) }),
          },
        ]);
    if (!r.diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) =>
        handleStateDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={m.stateIdentifier()}
        value={d.value.id}
        disabled={props.readonly}
        onChange={(value) => d.set("id", value)}
      />
      <MyoxusTextInput
        label={m.stateHeading()}
        value={d.value.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
      />
      {composite ? (
        <Select
          label={m.erLayoutDirection()}
          value={d.value.direction}
          disabled={props.readonly}
          data={["LR", "RL", "TB", "BT"].map((value) => ({
            value,
            label: value,
          }))}
          onChange={(value) =>
            d.set("direction", value as typeof d.value.direction)
          }
        />
      ) : !group ? (
        <StateScopeSelect props={props} value={scope} onChange={setScope} />
      ) : (
        <MyoxusText>{m.stateGroupHelp()}</MyoxusText>
      )}
      {d.diagnostic || groupDiagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? groupDiagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={props.readonly || (group && !props.groupAllowed)}
          onClick={() => save()}
        >
          {t["Save"]()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
      <ConfirmModal
        open={groupConfirm}
        onOpenChange={(opened) => {
          setGroupConfirm(opened);
          if (!opened) preview.clear();
        }}
        title={m.stateGroup()}
        confirmText={t["Save"]()}
        onConfirm={() => save(true)}
      >
        <Stack>
          <MyoxusText>{d.value.label || d.value.id}</MyoxusText>
          {props.selectedKeys.map((key) => (
            <MyoxusText key={key}>
              {props.model.states.find((n) => n.sourceKey === key)?.label}
            </MyoxusText>
          ))}
          {d.diagnostic ? (
            <Alert color="myoxusError" role="alert">
              {d.diagnostic}
            </Alert>
          ) : null}
        </Stack>
      </ConfirmModal>
      {composite ? (
        <>
          <StateReparentForm props={props} node={composite} />
          <Group>
            <Popover fitViewport opened={addingChild} onChange={setAddingChild}>
              <PopoverTarget>
                <Button
                  disabled={props.readonly}
                  onClick={() => setAddingChild(!addingChild)}
                >
                  {m.stateLabel()}
                </Button>
              </PopoverTarget>
              <PopoverContent>
                <Scrollable.Viewport autosize maxHeight="floating">
                  {addingChild ? (
                    <StateForm
                      props={props}
                      initialScope={composite.primaryRegionKey!}
                      onClose={() => setAddingChild(false)}
                    />
                  ) : null}
                </Scrollable.Viewport>
              </PopoverContent>
            </Popover>
            <Popover fitViewport opened={appearance} onChange={setAppearance}>
              <PopoverTarget>
                <Button onClick={() => setAppearance(!appearance)}>
                  {m.visualAppearance()}
                </Button>
              </PopoverTarget>
              <PopoverContent>
                <Scrollable.Viewport autosize maxHeight="floating">
                  {appearance ? (
                    <StateAppearanceForm
                      props={props}
                      objectId={composite.id}
                    />
                  ) : null}
                </Scrollable.Viewport>
              </PopoverContent>
            </Popover>
          </Group>
          <StateObjectNotes props={props} targetId={composite.id} />
          <Stack>
            <StateRegionPopover
              props={props}
              composite={composite}
              regionKey={composite.primaryRegionKey!}
            />
            {props.model.regions
              .filter((r) => r.compositeId === composite.id)
              .map((r) => (
                <StateRegionPopover
                  key={r.id}
                  props={props}
                  composite={composite}
                  regionKey={r.id}
                />
              ))}
          </Stack>
          <Button
            disabled={props.readonly}
            onClick={() => d.commit("addStateRegion", [composite.sourceKey!])}
          >
            {m.stateAddRegion()}
          </Button>
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
          <ConfirmModal
            open={deleting}
            onOpenChange={setDeleting}
            title={m.visualDelete()}
            confirmText={m.visualDelete()}
            onConfirm={() => {
              const r = d.commit("deleteStateComposite", [
                composite.sourceKey!,
                {
                  children,
                  ...(children === "reassign"
                    ? { anchor: stateScopeAnchor(props, target) }
                    : {}),
                },
              ]);
              if (!r.diagnostic) onClose();
            }}
          >
            <Stack>
              <Select
                label={m.stateComposite()}
                value={children}
                data={[
                  { value: "reassign", label: m.stateReassignChildren() },
                  { value: "delete", label: m.stateDeleteChildren() },
                ]}
                onChange={(value) => setChildren(value as typeof children)}
              />
              {children === "reassign" ? (
                <StateScopeSelect
                  props={props}
                  value={target}
                  onChange={setTarget}
                  excludedId={composite.id}
                />
              ) : null}
              {props
                .getImpact({ kind: "composite", key: composite.sourceKey! })
                .records.map((r) => (
                  <MyoxusText key={r.id}>{r.label}</MyoxusText>
                ))}
            </Stack>
          </ConfirmModal>
        </>
      ) : null}
    </Stack>
  );
}
