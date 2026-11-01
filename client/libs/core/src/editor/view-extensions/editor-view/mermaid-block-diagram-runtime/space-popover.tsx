// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Stack,
  Group,
  Button,
  Select,
  NumberInput,
  Alert,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  ConfirmModal,
  MyoxusText,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  blockItems,
  isBlockSpan,
  addBlockSpace,
  updateBlockSpace,
  deleteBlockSpace,
  type BlockReactHostProps,
  type MermaidBlockSpace,
} from "@virgultum/block-mermaid";
import { useBlockDraft, useBlockCommandPreview } from "./drafts";
import { BlockReorderForm, BlockGridImpact } from "./grid-popover";
export function BlockSpaceForm({
  props,
  space,
  parent,
  onClose,
}: {
  props: BlockReactHostProps;
  space?: MermaidBlockSpace;
  parent?: string | null;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useBlockDraft(
      {
        span: space?.span ?? 1,
        parent: parent ?? space?.parentKey ?? "",
        before: "",
      },
      props,
    ),
    preview = useBlockCommandPreview(props),
    [position, setPosition] = useState(false),
    [confirm, setConfirm] = useState(false),
    [deleting, setDeleting] = useState(false);
  const args = {
    span: d.value.span,
    parent: d.value.parent || null,
    before: d.value.before || undefined,
  };
  const trial = space
    ? updateBlockSpace(props.model, space.sourceKey, d.value.span)
    : addBlockSpace(props.model, args);
  const deletion = space
    ? deleteBlockSpace(props.model, space.sourceKey)
    : undefined;
  const save = () => {
    preview.clear();
    const r = space
      ? d.commit("updateBlockSpace", [space.sourceKey, d.value.span])
      : d.commit("addBlockSpace", [
          {
            span: d.value.span,
            parent: d.value.parent || null,
            before: d.value.before || undefined,
          },
        ]);
    if (!r.diagnostic) onClose();
  };
  return (
    <Stack>
      {!space ? (
        <>
          <Select
            label={m.chartParent()}
            value={d.value.parent}
            data={[
              { value: "", label: m.chartRoot() },
              ...props.model.groups.map((g) => ({
                value: g.bodyKey,
                label: g.label || (g.explicitId ? g.id : m.blockGroup()),
              })),
            ]}
            onChange={(v) => {
              d.set("parent", v);
              d.set("before", "");
              preview.clear();
            }}
          />
          <Select
            label={m.timelineInsertPosition()}
            value={d.value.before}
            data={[
              { value: "", label: m.visualMoveDown() },
              ...blockItems(props.model)
                .filter((n) => n.parentKey === (d.value.parent || null))
                .sort((a, b) => a.order - b.order)
                .map((n) => ({
                  value: n.sourceKey,
                  label:
                    "label" in n ? String(n.label || n.id) : m.blockSpace(),
                })),
            ]}
            onChange={(v) => d.set("before", v)}
          />
        </>
      ) : null}
      <NumberInput
        label={m.blockSpan()}
        value={d.value.span}
        min={0}
        clampBehavior="none"
        disabled={props.readonly}
        onChange={(v) => d.set("span", typeof v === "number" ? v : NaN)}
      />
      <BlockGridImpact model={trial.model} scopes={trial.impact.grids} />
      <MyoxusText>{m.blockGridHelp()}</MyoxusText>
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={
            props.readonly ||
            !isBlockSpan(d.value.span) ||
            trial.status === "rejected"
          }
          onClick={() => {
            if (space)
              preview.preview("updateBlockSpace", [
                space.sourceKey,
                d.value.span,
              ]);
            else preview.preview("addBlockSpace", [args]);
            setConfirm(true);
          }}
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
        {space ? (
          <>
            <Popover fitViewport opened={position} onChange={setPosition}>
              <PopoverTarget>
                <Button onClick={() => setPosition(true)}>
                  {m.blockReorder()}
                </Button>
              </PopoverTarget>
              <PopoverContent>
                <Scrollable.Viewport autosize maxHeight="floating">
                  {position ? (
                    <BlockReorderForm
                      props={props}
                      itemKey={space.sourceKey}
                      onClose={() => setPosition(false)}
                    />
                  ) : null}
                </Scrollable.Viewport>
              </PopoverContent>
            </Popover>
            <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
              {m.visualDelete()}
            </Button>
          </>
        ) : null}
      </Group>
      <ConfirmModal
        open={confirm}
        onOpenChange={(v) => {
          setConfirm(v);
          if (!v) preview.clear();
        }}
        title={m.blockSpace()}
        confirmText={t["Save"]()}
        onConfirm={save}
      >
        <Stack>
          <MyoxusText>{m.blockGridHelp()}</MyoxusText>
          <BlockGridImpact model={trial.model} scopes={trial.impact.grids} />
        </Stack>
      </ConfirmModal>
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (
            space &&
            !d.commit("deleteBlockSpace", [space.sourceKey]).diagnostic
          )
            onClose();
        }}
      >
        <Stack>
          <MyoxusText>{m.blockSpace()}</MyoxusText>
          {deletion ? (
            <BlockGridImpact
              model={deletion.model}
              scopes={deletion.impact.grids}
            />
          ) : null}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
