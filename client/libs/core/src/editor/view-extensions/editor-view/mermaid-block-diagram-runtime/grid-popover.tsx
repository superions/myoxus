// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Stack,
  Group,
  Button,
  Select,
  NumberInput,
  Checkbox,
  ConfirmModal,
  MyoxusText,
  Alert,
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  blockGridSlots,
  blockParentCanContain,
  blockItems,
  isBlockColumns,
  updateBlockColumns,
  reorderBlockItem,
  blockSourceDiagnostic,
  type BlockReactHostProps,
  type MermaidBlockDiagramModel,
} from "@virgultum/block-mermaid";
import { useBlockDraft, useBlockCommandPreview } from "./drafts";
export function BlockGridPreview({
  model,
  parent,
}: {
  model: MermaidBlockDiagramModel;
  parent: string | null;
}) {
  const items = blockItems(model);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{m.blockNode()}</TableHead>
          <TableHead>{m.blockRow()}</TableHead>
          <TableHead>{m.blockColumns()}</TableHead>
          <TableHead>{m.blockSpan()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {blockGridSlots(model, parent).map((s) => {
          const item = items.find((n) => n.sourceKey === s.key)!;
          return (
            <TableRow key={s.key}>
              <TableCell>
                {"label" in item
                  ? String(item.label || item.id)
                  : m.blockSpace()}
              </TableCell>
              <TableCell>{s.row + 1}</TableCell>
              <TableCell>{s.column + 1}</TableCell>
              <TableCell>{s.span}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
/** Show every explicitly affected scope from the same command result used by
 * the transient projection and confirmed write. */
export function BlockGridImpact({
  model,
  scopes,
}: {
  model: MermaidBlockDiagramModel;
  scopes: readonly (string | null)[];
}) {
  return (
    <Stack>
      {[...new Set(scopes)].map((parent) => {
        const group = model.groups.find((g) => g.bodyKey === parent);
        if (parent && !group) return null;
        return (
          <Stack key={parent ?? "root"}>
            <MyoxusText>
              {group
                ? group.label || (group.explicitId ? group.id : m.blockGroup())
                : m.chartRoot()}
            </MyoxusText>
            <BlockGridPreview model={model} parent={parent} />
            {model.diagnostics
              .filter(
                (d) =>
                  d.stage === "render" && d.scope === (parent ?? undefined),
              )
              .map((d) => (
                <Alert key={`${d.code}:${d.range.start}`} color="myoxusWarning">
                  {blockSourceDiagnostic(d)}
                </Alert>
              ))}
          </Stack>
        );
      })}
    </Stack>
  );
}
export function BlockGridForm({
  props,
  parent,
  onClose,
}: {
  props: BlockReactHostProps;
  parent?: string | null;
  onClose?: () => void;
}) {
  const t = useI18n(),
    [scope, setScope] = useState(parent ?? ""),
    group = props.model.groups.find((g) => g.bodyKey === scope),
    current = group?.columns ?? props.model.columns,
    d = useBlockDraft({ columns: current }, props),
    [automatic, setAutomatic] = useState(current === -1),
    preview = useBlockCommandPreview(props),
    [confirm, setConfirm] = useState(false),
    // Auto is an explicit UI choice, never an accidentally typed negative count.
    columns = automatic ? -1 : d.value.columns,
    validColumns = automatic || (isBlockColumns(columns) && columns >= 0),
    trial = updateBlockColumns(
      props.model,
      scope || null,
      validColumns ? columns : NaN,
    );
  return (
    <Stack>
      <Select
        label={m.chartParent()}
        value={scope}
        data={[
          { value: "", label: m.chartRoot() },
          ...props.model.groups.map((g) => ({
            value: g.bodyKey,
            label: g.label || (g.explicitId ? g.id : m.blockGroup()),
          })),
        ]}
        onChange={(v) => {
          setScope(v);
          const next =
            props.model.groups.find((g) => g.bodyKey === v)?.columns ??
            props.model.columns;
          setAutomatic(next === -1);
          d.set("columns", next);
          preview.clear();
        }}
      />
      <Checkbox
        label={m.radarAutomatic()}
        checked={automatic}
        disabled={props.readonly}
        onChange={(e) => {
          setAutomatic(e.currentTarget.checked);
          d.set("columns", e.currentTarget.checked ? -1 : 1);
        }}
      />
      {!automatic ? (
        <NumberInput
          label={m.blockColumns()}
          value={d.value.columns}
          clampBehavior="none"
          min={0}
          error={!validColumns ? m.blockInvalidRecord() : undefined}
          disabled={props.readonly}
          onChange={(v) => d.set("columns", typeof v === "number" ? v : NaN)}
        />
      ) : null}
      <BlockGridPreview model={trial.model} parent={scope || null} />
      {trial.model.diagnostics
        .filter(
          (diag) =>
            diag.stage === "render" && diag.scope === (scope || undefined),
        )
        .map((diag) => (
          <Alert key={`${diag.code}:${diag.range.start}`} color="myoxusWarning">
            {blockSourceDiagnostic(diag)}
          </Alert>
        ))}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <MyoxusText>{m.blockGridHelp()}</MyoxusText>
      <Group>
        <Button
          disabled={props.readonly || trial.status === "rejected"}
          onClick={() => {
            preview.preview("updateBlockColumns", [scope || null, columns]);
            setConfirm(true);
          }}
        >
          {t["Save"]()}
        </Button>
        <Button
          onClick={() => {
            preview.clear();
            onClose?.();
          }}
        >
          {m.cancel()}
        </Button>
      </Group>
      <ConfirmModal
        open={confirm}
        onOpenChange={(v) => {
          setConfirm(v);
          if (!v) preview.clear();
        }}
        title={m.blockGrid()}
        confirmText={t["Save"]()}
        onConfirm={() => {
          preview.clear();
          const r = d.commit("updateBlockColumns", [scope || null, columns]);
          if (!r.diagnostic) {
            setConfirm(false);
            onClose?.();
          }
        }}
      >
        <Stack>
          <MyoxusText>{group?.label || group?.id || m.chartRoot()}</MyoxusText>
          <BlockGridPreview model={trial.model} parent={scope || null} />
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
export function BlockReorderForm({
  props,
  itemKey,
  onClose,
}: {
  props: BlockReactHostProps;
  itemKey: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    item = blockItems(props.model).find((n) => n.sourceKey === itemKey)!,
    [parent, setParent] = useState(item.parentKey ?? ""),
    [before, setBefore] = useState(""),
    d = useBlockDraft({}, props),
    preview = useBlockCommandPreview(props),
    [confirm, setConfirm] = useState(false),
    trial = reorderBlockItem(
      props.model,
      itemKey,
      parent || null,
      before || undefined,
    );
  return (
    <Stack>
      <Select
        label={m.chartParent()}
        value={parent}
        disabled={props.readonly}
        data={[
          { value: "", label: m.chartRoot() },
          ...props.model.groups
            .filter((g) =>
              blockParentCanContain(props.model, itemKey, g.bodyKey),
            )
            .map((g) => ({
              value: g.bodyKey,
              label: g.label || (g.explicitId ? g.id : m.blockGroup()),
            })),
        ]}
        onChange={(v) => {
          setParent(v);
          setBefore("");
          preview.clear();
        }}
      />
      <Select
        label={m.timelineInsertPosition()}
        value={before}
        disabled={props.readonly}
        data={[
          { value: "", label: m.visualMoveDown() },
          { value: "$first", label: m.visualMoveUp() },
          ...blockItems(props.model)
            .filter(
              (n) =>
                n.sourceKey !== itemKey && n.parentKey === (parent || null),
            )
            .sort((a, b) => a.order - b.order)
            .map((n) => ({
              value: n.sourceKey,
              label: "label" in n ? String(n.label || n.id) : m.blockSpace(),
            })),
        ]}
        onChange={setBefore}
      />
      <BlockGridImpact model={trial.model} scopes={trial.impact.grids} />
      <MyoxusText>{m.blockGridHelp()}</MyoxusText>
      {d.diagnostic || trial.status === "rejected" ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? m.blockInvalidRecord()}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={props.readonly || trial.status === "rejected"}
          onClick={() => {
            preview.preview("reorderBlockItem", [
              itemKey,
              parent || null,
              before || undefined,
            ]);
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
      </Group>
      <ConfirmModal
        open={confirm}
        onOpenChange={(v) => {
          setConfirm(v);
          if (!v) preview.clear();
        }}
        title={m.blockReorder()}
        confirmText={t["Save"]()}
        onConfirm={() => {
          preview.clear();
          const r = d.commit("reorderBlockItem", [
            itemKey,
            parent || null,
            before || undefined,
          ]);
          if (!r.diagnostic) {
            setConfirm(false);
            onClose();
          }
        }}
      >
        <Stack>
          <MyoxusText>{m.blockGridHelp()}</MyoxusText>
          <BlockGridImpact model={trial.model} scopes={trial.impact.grids} />
          {trial.impact.records.map((r) => (
            <MyoxusText key={r.id}>{r.label}</MyoxusText>
          ))}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
