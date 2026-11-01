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
  type MermaidErEntity,
} from "@virgultum/block-mermaid";
import { changedErFields, handleErDraftKeyDown, useErDraft } from "./drafts";
import { ErAddAttributePopover } from "./attribute-popover";
import { ErAppearanceForm } from "./appearance-popover";
export function ErEntityForm({
  props,
  node,
  onClose,
}: {
  props: ErReactHostProps;
  node?: MermaidErEntity;
  onClose: () => void;
}) {
  const t = useI18n(),
    initial = { id: node?.id ?? "", label: node?.label ?? "" },
    d = useErDraft(initial, props);
  const [parent, setParent] = useState(node?.subgraphId ?? ""),
    [deleting, setDeleting] = useState(false),
    [styles, setStyles] = useState(false);
  const save = () => {
    const r = node
      ? d.commit("editErEntity", [
          node.sourceKey,
          changedErFields(initial, d.value),
        ])
      : d.commit("addErEntity", [
          {
            ...d.value,
            label: d.value.label || undefined,
            subgraphId: parent || null,
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
        label={m.erEntityId()}
        value={d.value.id}
        disabled={props.readonly}
        onChange={(value) => d.set("id", value)}
      />
      <MyoxusTextInput
        label={m.erAlias()}
        value={d.value.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
      />
      {!node ? (
        <Select
          label={m.erSubgraph()}
          value={parent}
          disabled={props.readonly}
          data={[
            { value: "", label: t["admin.common.none"]() },
            ...props.model.subgraphs.map((g) => ({
              value: g.id,
              label: g.label,
            })),
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
        <Button disabled={props.readonly} onClick={save}>
          {t["Save"]()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
      {node ? (
        <>
          <Select
            label={m.erSubgraph()}
            value={parent}
            disabled={props.readonly}
            data={[
              { value: "", label: t["admin.common.none"]() },
              ...props.model.subgraphs.map((g) => ({
                value: g.id,
                label: g.label,
              })),
            ]}
            onChange={setParent}
          />
          <Button
            disabled={props.readonly || parent === (node.subgraphId ?? "")}
            onClick={() => {
              const r = d.commit("reparentErEntity", [
                node.sourceKey,
                parent || null,
              ]);
              if (!r.diagnostic) onClose();
            }}
          >
            {m.treemapMove()}
          </Button>
          <Group>
            <ErAddAttributePopover props={props} entityKey={node.sourceKey} />
            <Popover fitViewport opened={styles} onChange={setStyles}>
              <PopoverTarget>
                <Button onClick={() => setStyles(!styles)}>
                  {m.visualAppearance()}
                </Button>
              </PopoverTarget>
              <PopoverContent>
                <Scrollable.Viewport autosize maxHeight="floating">
                  {styles ? (
                    <ErAppearanceForm props={props} objectId={node.id} />
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
              const r = d.commit("deleteErSelection", [[node.sourceKey]]);
              if (!r.diagnostic) {
                setDeleting(false);
                onClose();
              }
            }}
          >
            <Stack>
              {props
                .getImpact({ kind: "entity", key: node.sourceKey })
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
