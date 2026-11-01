// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Stack,
  Group,
  Button,
  MyoxusTextInput,
  MyoxusText,
  Select,
  NumberInput,
  Checkbox,
  Alert,
  ConfirmModal,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  SHAPE_SYNTAX,
  blockShapeLabel,
  isBlockSpan,
  blockParentCanContain,
  addBlockComposite,
  updateBlock,
  deleteBlockComposite,
  type BlockReactHostProps,
  type MermaidBlockGroup,
  type MermaidBlockNodeSyntax,
} from "@virgultum/block-mermaid";
import {
  useBlockDraft,
  changedBlockFields,
  useBlockCommandPreview,
  handleBlockDraftKeyDown,
} from "./drafts";
import {
  BlockGridForm,
  BlockReorderForm,
  BlockGridImpact,
} from "./grid-popover";
import { BlockForm } from "./block-popover";
import { BlockSpaceForm } from "./space-popover";
import { BlockAppearanceForm } from "./appearance-popover";
export function BlockCompositeForm({
  props,
  composite,
  group = false,
  parent,
  onClose,
}: {
  props: BlockReactHostProps;
  composite?: MermaidBlockGroup;
  group?: boolean;
  parent?: string | null;
  onClose: () => void;
}) {
  const t = useI18n(),
    initial = {
      id: composite?.explicitId ? composite.id : "",
      label: composite?.label ?? "",
      syntax: composite?.syntax ?? ("rectangle" as MermaidBlockNodeSyntax),
      span: composite?.span ?? 1,
    },
    d = useBlockDraft(initial, props),
    preview = useBlockCommandPreview(props),
    [anonymous, setAnonymous] = useState(
      composite ? !composite.explicitId : false,
    ),
    [scope, setScope] = useState(
      parent ??
        (group
          ? [...props.model.nodes, ...props.model.spaces].find(
              (n) => n.sourceKey === props.selectedKeys[0],
            )?.parentKey
          : undefined) ??
        "",
    ),
    [before, setBefore] = useState(""),
    [details, setDetails] = useState<
      | "grid"
      | "position"
      | "block"
      | "composite"
      | "space"
      | "appearance"
      | null
    >(null),
    [confirm, setConfirm] = useState(false),
    [deleting, setDeleting] = useState(false),
    [retain, setRetain] = useState(false),
    [destination, setDestination] = useState(composite?.parentKey ?? "");
  const args = {
    ...d.value,
    id: anonymous ? undefined : d.value.id,
    label: anonymous ? undefined : d.value.label || d.value.id,
    parent: scope || null,
    before: before || undefined,
    children: group ? [...props.selectedKeys] : undefined,
  };
  const changes = changedBlockFields(initial, d.value),
    trial = composite
      ? deleteBlockComposite(props.model, composite.sourceKey, {
          children: retain ? "retain" : "delete",
          parent: destination || null,
        })
      : addBlockComposite(props.model, args);
  const editTrial = composite
    ? updateBlock(props.model, composite.sourceKey, changes)
    : trial;
  const save = (confirmed = false) => {
    if (
      (group || (composite && d.value.span !== composite.span)) &&
      !confirmed
    ) {
      if (composite)
        preview.preview("updateBlock", [composite.sourceKey, changes]);
      else preview.preview("addBlockComposite", [args]);
      setConfirm(true);
      return;
    }
    preview.clear();
    const r = composite
      ? d.commit("updateBlock", [composite.sourceKey, changes])
      : d.commit("addBlockComposite", [args]);
    if (!r.diagnostic) onClose();
  };
  const targets = props.model.groups.filter(
    (g) =>
      !composite ||
      blockParentCanContain(props.model, composite.sourceKey, g.bodyKey),
  );
  return (
    <Stack
      onKeyDown={(e) =>
        handleBlockDraftKeyDown(e, props.readonly, () => save(), onClose)
      }
    >
      <MyoxusText>{m.blockCompositeHelp()}</MyoxusText>
      {!composite || !composite.explicitId ? (
        <Checkbox
          checked={anonymous}
          label={m.blockAnonymous()}
          disabled={props.readonly}
          onChange={(e) => setAnonymous(e.currentTarget.checked)}
        />
      ) : null}
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={m.sequenceId()}
        value={d.value.id}
        disabled={props.readonly || anonymous}
        onChange={(v) => d.set("id", v)}
      />
      <MyoxusTextInput
        label={m.sequenceAlias()}
        value={d.value.label}
        disabled={props.readonly || anonymous}
        onChange={(v) => d.set("label", v)}
      />
      <Select
        label={m.selectedNodeShape()}
        value={d.value.syntax}
        disabled={props.readonly || anonymous}
        data={[
          ...SHAPE_SYNTAX.map((s) => ({
            value: s.syntax,
            label: blockShapeLabel(s.syntax),
          })),
          ...(!SHAPE_SYNTAX.some((s) => s.syntax === d.value.syntax)
            ? [{ value: d.value.syntax, label: d.value.syntax }]
            : []),
        ]}
        onChange={(v) => d.set("syntax", v as MermaidBlockNodeSyntax)}
      />
      <NumberInput
        label={m.blockSpan()}
        value={d.value.span}
        min={0}
        clampBehavior="none"
        disabled={props.readonly}
        onChange={(v) => d.set("span", typeof v === "number" ? v : NaN)}
      />
      {!composite ? (
        <>
          <Select
            label={m.chartParent()}
            data={[
              { value: "", label: m.chartRoot() },
              ...targets.map((g) => ({
                value: g.bodyKey,
                label: g.label || (g.explicitId ? g.id : m.blockGroup()),
              })),
            ]}
            value={scope}
            disabled={props.readonly || group}
            onChange={(v) => {
              setScope(v);
              setBefore("");
            }}
          />
          <Select
            label={m.timelineInsertPosition()}
            data={[
              { value: "", label: m.visualMoveDown() },
              ...[
                ...props.model.nodes,
                ...props.model.groups,
                ...props.model.spaces,
              ]
                .filter((n) => n.parentKey === (scope || null))
                .map((n) => ({
                  value: n.sourceKey,
                  label:
                    "label" in n ? String(n.label || n.id) : m.blockSpace(),
                })),
            ]}
            value={before}
            onChange={setBefore}
          />
        </>
      ) : null}
      <Group>
        <Button
          disabled={
            props.readonly ||
            !isBlockSpan(d.value.span) ||
            (!anonymous && !d.value.id) ||
            (group && !props.groupAllowed)
          }
          onClick={() => save()}
        >
          {t["Save"]()}
        </Button>
        <Button
          onClick={() => {
            preview.clear();
            onClose();
          }}
        >
          {m.cancel()}
        </Button>
      </Group>
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      {composite ? (
        <>
          <Group>
            {(
              [
                "grid",
                "position",
                "block",
                "composite",
                "space",
                "appearance",
              ] as const
            ).map((action) => (
              <Popover
                key={action}
                fitViewport
                opened={details === action}
                onChange={(v) => setDetails(v ? action : null)}
              >
                <PopoverTarget>
                  <Button onClick={() => setDetails(action)}>
                    {{
                      grid: m.blockColumns,
                      position: m.blockReorder,
                      block: m.blockNode,
                      composite: m.blockEmptyComposite,
                      space: m.blockSpace,
                      appearance: m.visualAppearance,
                    }[action]()}
                  </Button>
                </PopoverTarget>
                <PopoverContent>
                  <Scrollable.Viewport autosize maxHeight="floating">
                    {details === action ? (
                      action === "grid" ? (
                        <BlockGridForm
                          props={props}
                          parent={composite.bodyKey}
                          onClose={() => setDetails(null)}
                        />
                      ) : action === "position" ? (
                        <BlockReorderForm
                          props={props}
                          itemKey={composite.sourceKey}
                          onClose={() => setDetails(null)}
                        />
                      ) : action === "block" ? (
                        <BlockForm
                          props={props}
                          parent={composite.bodyKey}
                          onClose={() => setDetails(null)}
                        />
                      ) : action === "space" ? (
                        <BlockSpaceForm
                          props={props}
                          parent={composite.bodyKey}
                          onClose={() => setDetails(null)}
                        />
                      ) : action === "appearance" ? (
                        <BlockAppearanceForm
                          props={props}
                          objectId={composite.id}
                        />
                      ) : (
                        <BlockCompositeForm
                          props={props}
                          parent={composite.bodyKey}
                          onClose={() => setDetails(null)}
                        />
                      )
                    ) : null}
                  </Scrollable.Viewport>
                </PopoverContent>
              </Popover>
            ))}
          </Group>
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
        </>
      ) : null}
      <ConfirmModal
        open={confirm}
        onOpenChange={(v) => {
          setConfirm(v);
          if (!v) preview.clear();
        }}
        title={m.blockGroup()}
        confirmText={t["Save"]()}
        onConfirm={() => {
          setConfirm(false);
          save(true);
        }}
      >
        <Stack>
          <MyoxusText>{m.blockGroupHelp()}</MyoxusText>
          <BlockGridImpact
            model={editTrial.model}
            scopes={editTrial.impact.grids}
          />
        </Stack>
      </ConfirmModal>
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (
            composite &&
            !d.commit("deleteBlockComposite", [
              composite.sourceKey,
              {
                children: retain ? "retain" : "delete",
                parent: destination || null,
              },
            ]).diagnostic
          )
            onClose();
        }}
      >
        <Stack>
          <Checkbox
            label={m.stateReassignChildren()}
            checked={retain}
            onChange={(e) => setRetain(e.currentTarget.checked)}
          />
          {retain ? (
            <Select
              label={m.chartParent()}
              data={[
                { value: "", label: m.chartRoot() },
                ...targets.map((g) => ({
                  value: g.bodyKey,
                  label: g.label || (g.explicitId ? g.id : m.blockGroup()),
                })),
              ]}
              value={destination}
              onChange={setDestination}
            />
          ) : null}
          {trial.impact.records.map((r) => (
            <MyoxusText key={r.id}>{r.label}</MyoxusText>
          ))}
          {trial.diagnostic ? (
            <Alert color="myoxusError" role="alert">
              {trial.diagnostic}
            </Alert>
          ) : null}
          <BlockGridImpact model={trial.model} scopes={trial.impact.grids} />
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
