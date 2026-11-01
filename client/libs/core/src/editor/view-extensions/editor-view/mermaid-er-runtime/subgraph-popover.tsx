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
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type ErReactHostProps,
  type MermaidErSubgraph,
  type ErDirection,
} from "@virgultum/block-mermaid";
import { changedErFields, handleErDraftKeyDown, useErDraft } from "./drafts";
import { ErAppearanceForm } from "./appearance-popover";
export function ErSubgraphForm({
  props,
  subgraph,
  group,
  onClose,
}: {
  props: ErReactHostProps;
  subgraph?: MermaidErSubgraph;
  group?: boolean;
  onClose: () => void;
}) {
  const t = useI18n(),
    initial = {
      id: subgraph?.id ?? "",
      label: subgraph?.label ?? "",
      direction: subgraph?.direction ?? "",
    },
    d = useErDraft(initial, props),
    v = d.value;
  const [parent, setParent] = useState(subgraph?.parentId ?? ""),
    [deleting, setDeleting] = useState(false),
    [strategy, setStrategy] = useState<"ungroup" | "delete">("ungroup"),
    [styles, setStyles] = useState(false);
  const impact = subgraph
    ? props.getImpact({
        kind: "subgraph",
        key: subgraph.sourceKey,
        deleteStrategy: strategy,
      })
    : null;
  const save = () => {
    const changes = changedErFields(initial, v),
      direction = v.direction as ErDirection;
    const { direction: changedDirection, ...fields } = changes;
    const r = subgraph
      ? d.commit("editErSubgraph", [
          subgraph.sourceKey,
          {
            ...fields,
            ...(changedDirection !== undefined
              ? { direction: direction || null }
              : {}),
          },
        ])
      : group
        ? d.commit("groupErEntities", [
            props.selectedKeys,
            {
              id: v.id,
              label: v.label || undefined,
              direction: direction || undefined,
            },
          ])
        : d.commit("addErSubgraph", [
            {
              id: v.id,
              label: v.label || undefined,
              parentId: parent || null,
              direction: direction || undefined,
            },
          ]);
    if (!r.diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) =>
        handleErDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <MyoxusTextInput
        autoFocus
        label={m.erSubgraph()}
        value={v.id}
        disabled={props.readonly}
        onChange={(value) => d.set("id", value)}
      />
      <MyoxusTextInput
        label={m.timelineLabel()}
        value={v.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
      />
      <Select
        label={m.erLayoutDirection()}
        value={v.direction}
        disabled={props.readonly}
        data={[
          { value: "", label: m.optionDefault() },
          ...["TB", "BT", "LR", "RL"].map((value) => ({ value, label: value })),
        ]}
        onChange={(value) => d.set("direction", value)}
      />
      {!group ? (
        <Select
          label={m.erSubgraph()}
          value={parent}
          disabled={props.readonly}
          data={[
            { value: "", label: t["admin.common.none"]() },
            ...props.model.subgraphs
              .filter((g) => g.sourceKey !== subgraph?.sourceKey)
              .map((g) => ({ value: g.id, label: g.label })),
          ]}
          onChange={setParent}
        />
      ) : null}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={props.readonly || (group && !props.groupAllowed)}
          onClick={save}
        >
          {t["Save"]()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
      {subgraph ? (
        <>
          <Group>
            <Button
              disabled={props.readonly || parent === (subgraph.parentId ?? "")}
              onClick={() => {
                const r = d.commit("reparentErSubgraph", [
                  subgraph.sourceKey,
                  parent || null,
                ]);
                if (!r.diagnostic) onClose();
              }}
            >
              {m.visualMoveSubgraph()}
            </Button>
            <Popover fitViewport opened={styles} onChange={setStyles}>
              <PopoverTarget>
                <Button onClick={() => setStyles(!styles)}>
                  {m.visualAppearance()}
                </Button>
              </PopoverTarget>
              <PopoverContent>
                <Scrollable.Viewport autosize maxHeight="floating">
                  {styles ? (
                    <ErAppearanceForm props={props} objectId={subgraph.id} />
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
              const r = d.commit("deleteErSubgraph", [
                subgraph.sourceKey,
                strategy,
              ]);
              if (!r.diagnostic) {
                setDeleting(false);
                onClose();
              }
            }}
          >
            <Stack>
              <Select
                label={m.visualDelete()}
                value={strategy}
                data={[
                  { value: "ungroup", label: m.erUngroup() },
                  { value: "delete", label: m.erDeleteContent() },
                ]}
                onChange={(value) => setStrategy(value as typeof strategy)}
              />
              {impact?.records.map((r) => (
                <MyoxusText key={r.id}>{r.label}</MyoxusText>
              ))}
            </Stack>
          </ConfirmModal>
        </>
      ) : null}
    </Stack>
  );
}
