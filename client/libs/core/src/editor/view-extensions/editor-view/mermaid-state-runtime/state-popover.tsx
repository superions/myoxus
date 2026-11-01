// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect, useRef } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  ConfirmModal,
  Group,
  MyoxusText,
  MyoxusTextInput,
  NavLink,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
  Text,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  stateDisplayText,
  stateEffectiveDescriptions,
  stateCompositeBodyKeys,
  type StateReactHostProps,
  type MermaidStateNode,
  type MermaidStateDescription,
  type StateInsertAnchor,
  type StateImpact,
} from "@virgultum/block-mermaid";
import {
  useStateDraft,
  changedStateFields,
  handleStateDraftKeyDown,
} from "./drafts";
import { StateAppearanceForm } from "./appearance-popover";
import { StateObjectNotes } from "./note-popover";
import { StatePseudostateForm } from "./pseudostate-popover";
export function stateScopeOptions(
  props: StateReactHostProps,
  excludedId?: string,
) {
  const t = [{ value: "", label: props.model.diagramTitle || m.slashName() }];
  const excluded = new Set(excludedId ? [excludedId] : []);
  for (const c of props.model.composites)
    if (c.parentId && excluded.has(c.parentId)) excluded.add(c.id);
  for (const c of props.model.composites.filter((c) => !excluded.has(c.id))) {
    stateCompositeBodyKeys(props.model, c).forEach((key, index) =>
      t.push({
        value: key,
        label: `${c.label} · ${m.statePrimaryRegion()} ${index + 1}`,
      }),
    );
    for (const r of props.model.regions.filter((r) => r.compositeId === c.id))
      t.push({
        value: r.id,
        label: `${c.label} · ${m.stateRegion()} ${r.regionIndex + 1}`,
      });
  }
  return t;
}
export function stateScopeAnchor(
  props: StateReactHostProps,
  key: string,
): StateInsertAnchor {
  const region = props.model.regions.find((r) => r.id === key);
  const composite = region
    ? props.model.composites.find((c) => c.id === region.compositeId)
    : props.model.composites.find((c) =>
        stateCompositeBodyKeys(props.model, c).includes(key),
      );
  return composite ? { parentId: composite.id, regionKey: key } : {};
}
export function StateScopeSelect({
  props,
  value,
  onChange,
  excludedId,
}: {
  props: StateReactHostProps;
  value: string;
  onChange: (value: string) => void;
  excludedId?: string;
}) {
  return (
    <Select
      label={m.stateRegion()}
      value={value}
      disabled={props.readonly}
      data={stateScopeOptions(props, excludedId)}
      onChange={onChange}
    />
  );
}
export function StateReparentForm({
  props,
  node,
}: {
  props: StateReactHostProps;
  node: MermaidStateNode | StateReactHostProps["model"]["composites"][number];
}) {
  const [scope, setScope] = useState(node.regionKey ?? ""),
    [confirm, setConfirm] = useState(false),
    [impact, setImpact] = useState<StateImpact | null>(null),
    [diagnostic, setDiagnostic] = useState<string | null>(null);
  const preview = useRef<(() => void) | null>(null);
  useEffect(() => () => preview.current?.(), []);
  useEffect(() => {
    preview.current?.();
    preview.current = null;
    setConfirm(false);
  }, [props.sourceBasis, props.readonly]);
  const run = () => {
    const result = props.onCommand(
      "reparentStateObject",
      [node.sourceKey!, stateScopeAnchor(props, scope)],
      props.sourceBasis,
    );
    setDiagnostic(result.diagnostic ?? null);
    if (!result.diagnostic) setConfirm(false);
  };
  return (
    <Stack>
      <StateScopeSelect
        props={props}
        value={scope}
        onChange={(value) => {
          preview.current?.();
          preview.current = null;
          setScope(value);
        }}
        excludedId={node.id}
      />
      <Button
        disabled={props.readonly || scope === (node.regionKey ?? "")}
        onClick={() => {
          preview.current?.();
          const next = props.previewCommand?.(
            "reparentStateObject",
            [node.sourceKey!, stateScopeAnchor(props, scope)],
            props.sourceBasis,
          );
          preview.current = next?.dispose ?? null;
          setDiagnostic(next?.feedback.diagnostic ?? null);
          setImpact(next?.feedback.impact ?? null);
          if (!next?.feedback.diagnostic) setConfirm(true);
        }}
      >
        {m.treemapMove()}
      </Button>
      {diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {diagnostic}
        </Alert>
      ) : null}
      <ConfirmModal
        open={confirm}
        onOpenChange={(value) => {
          setConfirm(value);
          if (!value) {
            preview.current?.();
            preview.current = null;
          }
        }}
        title={m.treemapMove()}
        confirmText={m.treemapMove()}
        onConfirm={run}
      >
        <Stack>
          <MyoxusText>
            {node.label} ·{" "}
            {
              stateScopeOptions(props, node.id).find((s) => s.value === scope)
                ?.label
            }
          </MyoxusText>
          {impact?.records.map((record) => (
            <MyoxusText key={record.id}>{record.label}</MyoxusText>
          ))}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
export function StateForm({
  props,
  initialDelete = false,
  node,
  initialScope,
  onClose,
}: {
  props: StateReactHostProps;
  initialDelete?: boolean;
  node?: MermaidStateNode;
  initialScope?: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    initial = {
      id: node?.id ?? "",
      label: stateDisplayText(node?.label ?? ""),
    },
    d = useStateDraft(initial, props);
  const [scope, setScope] = useState(node?.regionKey ?? initialScope ?? ""),
    [deleting, setDeleting] = useState(initialDelete),
    [styles, setStyles] = useState(false),
    [notation, setNotation] = useState(false);
  const save = () => {
    const r = node
      ? d.commit("editState", [
          node.sourceKey!,
          changedStateFields(initial, d.value),
        ])
      : d.commit("addState", [
          {
            ...d.value,
            label: d.value.label || undefined,
            anchor: stateScopeAnchor(props, scope),
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
        description={m.stateIdHelp()}
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
      {node?.declaration === "implicit" ? (
        <MyoxusText>{m.stateImplicit()}</MyoxusText>
      ) : null}
      {!node ? (
        <StateScopeSelect props={props} value={scope} onChange={setScope} />
      ) : null}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button disabled={props.readonly} onClick={save}>
          {t["Save"]()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
      {node ? (
        <>
          <MyoxusText>{m.stateDescriptionHelp()}</MyoxusText>
          {(node.descriptions ?? [])
            .filter(
              (description) =>
                description.id !== stateEffectiveDescriptions(node)[0]?.id,
            )
            .map((description) => (
              <StateDescriptionPopover
                key={description.id}
                props={props}
                owner={node}
                description={description}
              />
            ))}
          <StateDescriptionPopover props={props} owner={node} />
          <StateReparentForm props={props} node={node} />
          <StateObjectNotes props={props} targetId={node.id} />
          <Group>
            <Popover fitViewport opened={notation} onChange={setNotation}>
              <PopoverTarget>
                <Button
                  disabled={props.readonly}
                  onClick={() => setNotation(!notation)}
                >
                  {m.statePseudostate()}
                </Button>
              </PopoverTarget>
              <PopoverContent>
                <Scrollable.Viewport autosize maxHeight="floating">
                  {notation ? (
                    <StatePseudostateForm
                      props={props}
                      node={node}
                      onClose={() => setNotation(false)}
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
                    <StateAppearanceForm props={props} objectId={node.id} />
                  ) : null}
                </Scrollable.Viewport>
              </PopoverContent>
            </Popover>
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
              const r = d.commit("deleteStateSelection", [[node.sourceKey!]]);
              if (!r.diagnostic) {
                setDeleting(false);
                onClose();
              }
            }}
          >
            <Stack>
              {props
                .getImpact({ kind: "state", key: node.sourceKey! })
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
export function StateDescriptionForm({
  props,
  initialDelete = false,
  owner,
  description,
  onClose,
}: {
  props: StateReactHostProps;
  initialDelete?: boolean;
  owner: MermaidStateNode;
  description?: MermaidStateDescription;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useStateDraft(
      { text: stateDisplayText(description?.text ?? "") },
      props,
    ),
    siblings = owner.descriptions ?? [],
    index = siblings.findIndex((s) => s.id === description?.id);
  const [before, setBefore] = useState(""),
    [deleting, setDeleting] = useState(initialDelete);
  const save = () => {
    const r = description
      ? d.commit("editStateDescription", [description.id, d.value.text])
      : d.commit("insertStateDescription", [
          owner.sourceKey!,
          d.value.text,
          before || undefined,
        ]);
    if (!r.diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) => {
        handleStateDraftKeyDown(event, props.readonly, save, onClose, true);
        if (
          description &&
          !props.readonly &&
          event.altKey &&
          ["ArrowUp", "ArrowDown"].includes(event.key)
        ) {
          event.preventDefault();
          event.stopPropagation();
          const up = event.key === "ArrowUp";
          if (up ? index > 0 : index < siblings.length - 1)
            d.commit(
              "reorderStateDescription",
              up
                ? [description.id, siblings[index - 1]!.id]
                : [siblings[index + 1]!.id, description.id],
            );
        }
      }}
    >
      <Textarea
        autoFocus
        data-autofocus
        label={m.stateDescription()}
        value={d.value.text}
        disabled={props.readonly}
        autosize
        onChange={(value) => d.set("text", value)}
      />
      {!description ? (
        <Select
          label={m.timelineInsertPosition()}
          value={before}
          data={[
            { value: "", label: m.visualMoveDown() },
            ...siblings.map((s) => ({ value: s.id, label: s.text })),
          ]}
          onChange={setBefore}
        />
      ) : null}
      <MyoxusText>{m.stateDescriptionHelp()}</MyoxusText>
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button disabled={props.readonly} onClick={save}>
          {t["Save"]()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
      {description ? (
        <Group>
          <Button
            disabled={props.readonly || index <= 0}
            onClick={() =>
              d.commit("reorderStateDescription", [
                description.id,
                siblings[index - 1]!.id,
              ])
            }
          >
            {m.visualMoveUp()}
          </Button>
          <Button
            disabled={props.readonly || index >= siblings.length - 1}
            onClick={() =>
              d.commit("reorderStateDescription", [
                siblings[index + 1]!.id,
                description.id,
              ])
            }
          >
            {m.visualMoveDown()}
          </Button>
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
        </Group>
      ) : null}
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (
            description &&
            !d.commit("deleteStateDescription", [description.id]).diagnostic
          )
            onClose();
        }}
      >
        <MyoxusText>{description?.text}</MyoxusText>
      </ConfirmModal>
    </Stack>
  );
}
export function StateDescriptionPopover({
  props,
  owner,
  description,
}: {
  props: StateReactHostProps;
  owner: MermaidStateNode;
  description?: MermaidStateDescription;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover
      fitViewport
      trapFocus
      contentMeasure="reading"
      opened={opened}
      onChange={setOpened}
    >
      <PopoverTarget>
        <NavLink
          component="button"
          disabled={!description && props.readonly}
          onClick={() => setOpened(!opened)}
          label={
            <Text textWrap="pretty">
              {stateDisplayText(description?.text ?? m.stateDescription())}
            </Text>
          }
        />
      </PopoverTarget>
      <PopoverContent>
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <StateDescriptionForm
              props={props}
              owner={owner}
              description={description}
              onClose={() => setOpened(false)}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
