// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Stack,
  Group,
  Button,
  MyoxusTextInput,
  Select,
  MultiSelect,
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
  SHAPE_SYNTAX,
  blockShapeLabel,
  BLOCK_DIRECTIONS,
  isBlockSpan,
  updateBlock,
  type BlockReactHostProps,
  type MermaidBlockNode,
  type MermaidBlockNodeSyntax,
  type MermaidBlockDirection,
} from "@virgultum/block-mermaid";
import {
  useBlockDraft,
  changedBlockFields,
  handleBlockDraftKeyDown,
  useBlockCommandPreview,
} from "./drafts";
import { BlockGridPreview, BlockReorderForm } from "./grid-popover";
import { BlockAppearanceForm } from "./appearance-popover";
export function BlockForm({
  props,
  node,
  onClose,
  parent,
}: {
  props: BlockReactHostProps;
  node?: MermaidBlockNode;
  onClose: () => void;
  parent?: string | null;
}) {
  const t = useI18n(),
    initial = {
      id: node?.id ?? "",
      label: node?.label ?? "",
      syntax: node?.syntax ?? ("rectangle" as MermaidBlockNodeSyntax),
      directions: node?.directions ?? [],
      span: node?.span ?? 1,
    },
    d = useBlockDraft(initial, props),
    preview = useBlockCommandPreview(props);
  const [scope, setScope] = useState(parent ?? node?.parentKey ?? ""),
    [before, setBefore] = useState(""),
    [details, setDetails] = useState<"position" | "appearance" | null>(null),
    [deleting, setDeleting] = useState(false),
    [confirmSpan, setConfirmSpan] = useState(false);
  const save = (confirmed = false) => {
    if (!isBlockSpan(d.value.span)) return;
    if (node && d.value.span !== node.span && !confirmed) {
      preview.preview("updateBlock", [
        node.sourceKey,
        changedBlockFields(initial, d.value),
      ]);
      setConfirmSpan(true);
      return;
    }
    preview.clear();
    const r = node
      ? d.commit("updateBlock", [
          node.sourceKey,
          changedBlockFields(initial, d.value),
        ])
      : d.commit("addBlock", [
          {
            ...d.value,
            label: d.value.label || d.value.id,
            parent: scope || null,
            before: before || undefined,
          },
        ]);
    if (!r.diagnostic) onClose();
  };
  const notationPreview = () => {
    if (node)
      preview.preview("updateBlock", [
        node.sourceKey,
        changedBlockFields(initial, d.value),
      ]);
    else if (d.value.id)
      preview.preview("addBlock", [
        {
          ...d.value,
          label: d.value.label || d.value.id,
          parent: scope || null,
          before: before || undefined,
        },
      ]);
  };
  return (
    <Stack
      onKeyDown={(e) =>
        handleBlockDraftKeyDown(e, props.readonly, () => save(), onClose)
      }
    >
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={m.sequenceId()}
        value={d.value.id}
        disabled={props.readonly}
        onChange={(v) => d.set("id", v)}
      />
      <MyoxusTextInput
        label={m.sequenceAlias()}
        value={d.value.label}
        disabled={props.readonly}
        onChange={(v) => d.set("label", v)}
      />
      {!node ? (
        <>
          <Select
            label={m.chartParent()}
            value={scope}
            disabled={props.readonly}
            data={[
              { value: "", label: m.chartRoot() },
              ...props.model.groups.map((g) => ({
                value: g.bodyKey,
                label: g.label || (g.explicitId ? g.id : m.blockGroup()),
              })),
            ]}
            onChange={(v) => {
              setScope(v);
              setBefore("");
            }}
          />
          <Select
            label={m.timelineInsertPosition()}
            value={before}
            data={[
              { value: "", label: m.visualMoveDown() },
              ...[
                ...props.model.nodes,
                ...props.model.groups,
                ...props.model.spaces,
              ]
                .filter((n) => n.parentKey === (scope || null))
                .sort((a, b) => a.order - b.order)
                .map((n) => ({
                  value: n.sourceKey,
                  label:
                    "label" in n ? String(n.label || n.id) : m.blockSpace(),
                })),
            ]}
            onChange={setBefore}
          />
        </>
      ) : null}
      <Select
        label={m.selectedNodeShape()}
        value={d.value.syntax}
        disabled={props.readonly}
        data={[
          ...SHAPE_SYNTAX.map((s) => ({
            value: s.syntax,
            label: blockShapeLabel(s.syntax),
          })),
          { value: "block-arrow", label: m.blockArrow() },
          ...(!SHAPE_SYNTAX.some((s) => s.syntax === d.value.syntax) &&
          d.value.syntax !== "block-arrow"
            ? [{ value: d.value.syntax, label: d.value.syntax }]
            : []),
        ]}
        onChange={(v) => d.set("syntax", v as MermaidBlockNodeSyntax)}
      />
      {d.value.syntax === "block-arrow" ? (
        <MultiSelect
          label={m.blockDirections()}
          data={BLOCK_DIRECTIONS.map((value) => ({ value, label: value }))}
          value={[...new Set(d.value.directions)]}
          disabled={props.readonly}
          onChange={(v) => d.set("directions", v as MermaidBlockDirection[])}
        />
      ) : null}
      <NumberInput
        label={m.blockSpan()}
        value={d.value.span}
        disabled={props.readonly}
        clampBehavior="none"
        min={0}
        onChange={(v) => d.set("span", typeof v === "number" ? v : NaN)}
      />
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={props.readonly || !d.value.id || !isBlockSpan(d.value.span)}
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
        <Button disabled={props.readonly} onClick={notationPreview}>
          {m.sequencePreview()}
        </Button>
      </Group>
      {node ? (
        <Group>
          <Popover
            fitViewport
            opened={details === "position"}
            onChange={(v) => setDetails(v ? "position" : null)}
          >
            <PopoverTarget>
              <Button onClick={() => setDetails("position")}>
                {m.blockReorder()}
              </Button>
            </PopoverTarget>
            <PopoverContent>
              <Scrollable.Viewport autosize maxHeight="floating">
                {details === "position" ? (
                  <BlockReorderForm
                    props={props}
                    itemKey={node.sourceKey}
                    onClose={() => setDetails(null)}
                  />
                ) : null}
              </Scrollable.Viewport>
            </PopoverContent>
          </Popover>
          <Popover
            fitViewport
            opened={details === "appearance"}
            onChange={(v) => setDetails(v ? "appearance" : null)}
          >
            <PopoverTarget>
              <Button onClick={() => setDetails("appearance")}>
                {m.visualAppearance()}
              </Button>
            </PopoverTarget>
            <PopoverContent>
              <Scrollable.Viewport autosize maxHeight="floating">
                {details === "appearance" ? (
                  <BlockAppearanceForm props={props} objectId={node.id} />
                ) : null}
              </Scrollable.Viewport>
            </PopoverContent>
          </Popover>
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
        </Group>
      ) : null}
      <ConfirmModal
        open={confirmSpan}
        onOpenChange={(v) => {
          setConfirmSpan(v);
          if (!v) preview.clear();
        }}
        title={m.blockSpan()}
        confirmText={t["Save"]()}
        onConfirm={() => {
          setConfirmSpan(false);
          save(true);
        }}
      >
        <Stack>
          <MyoxusText>{m.blockGridHelp()}</MyoxusText>
          {node ? (
            <BlockGridPreview
              model={
                updateBlock(
                  props.model,
                  node.sourceKey,
                  changedBlockFields(initial, d.value),
                ).model
              }
              parent={node.parentKey}
            />
          ) : null}
        </Stack>
      </ConfirmModal>
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (node && !d.commit("deleteBlock", [node.sourceKey]).diagnostic)
            onClose();
        }}
      >
        <Stack>
          {node
            ? props
                .getImpact({ kind: "block", key: node.sourceKey })
                .records.map((r) => (
                  <MyoxusText key={r.id}>{r.label}</MyoxusText>
                ))
            : null}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}

/** Double-click/Enter changes the display label at the same Source command
 * boundary; the explicit object action owns the full notation form. */
export function BlockInlineLabelForm({
  props,
  nodeKey,
  onClose,
}: {
  props: BlockReactHostProps;
  nodeKey: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    node = props.model.nodes.find((n) => n.sourceKey === nodeKey)!,
    d = useBlockDraft({ label: node.label }, props),
    save = () => {
      if (
        !d.commit("updateBlock", [nodeKey, { label: d.value.label }]).diagnostic
      )
        onClose();
    };
  return (
    <Stack
      onKeyDown={(e) =>
        handleBlockDraftKeyDown(e, props.readonly, save, onClose)
      }
    >
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={m.sequenceAlias()}
        value={d.value.label}
        disabled={props.readonly}
        onChange={(v) => d.set("label", v)}
      />
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
    </Stack>
  );
}
