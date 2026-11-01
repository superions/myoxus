// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import {
  Alert,
  Button,
  ConfirmModal,
  Group,
  MyoxusText,
  Menu,
  MenuItem,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type StateReactHostProps,
  type MermaidStateComposite,
  stateRegionRecords,
  stateCompositeBodyKeys,
  stateImpact,
} from "@virgultum/block-mermaid";
import { useStateDraft, useStateCommandPreview } from "./drafts";
export function StateRegionForm({
  props,
  initialDelete = false,
  composite,
  regionKey,
}: {
  props: StateReactHostProps;
  initialDelete?: boolean;
  composite?: MermaidStateComposite;
  regionKey?: string;
}) {
  const d = useStateDraft({ composite: composite?.sourceKey ?? "" }, props);
  const preview = useStateCommandPreview(props),
    [reorder, setReorder] = useState<readonly [string, string] | null>(null),
    [previewDiagnostic, setPreviewDiagnostic] = useState<string | null>(null);
  const prepareReorder = (keys: readonly [string, string]) => {
    const result = preview.preview("reorderStateRegion", [...keys]);
    setPreviewDiagnostic(result?.diagnostic ?? null);
    if (!result?.diagnostic) setReorder(keys);
  };
  const [deleting, setDeleting] = useState(initialDelete),
    [children, setChildren] = useState<"delete" | "reassign">("reassign"),
    [target, setTarget] = useState(
      composite ? composite.primaryRegionKey! : "",
    );
  const c =
    composite ??
    props.model.composites.find((c) => c.sourceKey === d.value.composite);
  const regions = c
    ? [
        ...stateCompositeBodyKeys(props.model, c)
          .filter(
            (key) =>
              !regionKey ||
              stateRegionRecords(props.model, key)?.open.sourceKey ===
                stateRegionRecords(props.model, regionKey)?.open.sourceKey,
          )
          .map((key) => ({ id: key, label: m.statePrimaryRegion() })),
        ...props.model.regions
          .filter((r) => r.compositeId === c.id)
          .filter(
            (r) =>
              !regionKey ||
              stateRegionRecords(props.model, r.id)?.open.sourceKey ===
                stateRegionRecords(props.model, regionKey)?.open.sourceKey,
          )
          .map((r) => ({
            id: r.id,
            label: `${m.stateRegion()} ${r.regionIndex + 1}`,
          })),
      ]
    : [];
  const index = regions.findIndex((r) => r.id === regionKey),
    scope = regionKey ? stateRegionRecords(props.model, regionKey) : null;
  const contents = stateImpact(
    props.model,
    scope?.records ?? [],
  ).records.filter((record) =>
    [
      "state",
      "description",
      "pseudostate",
      "transition",
      "note",
      "composite",
    ].includes(record.kind),
  );
  const closeDelete = () => {
    setDeleting(false);
    if (initialDelete) {
      props.onParentIntent(null);
      props.onCloseSelection();
    }
  };
  return (
    <Stack>
      {!composite ? (
        <Select
          label={m.stateComposite()}
          value={d.value.composite}
          disabled={props.readonly}
          data={props.model.composites.map((c) => ({
            value: c.sourceKey!,
            label: c.label,
          }))}
          onChange={(value) => d.set("composite", value)}
        />
      ) : null}
      {scope ? (
        <>
          <MyoxusText>{regions[index]?.label}</MyoxusText>
          {contents.map((record) => (
            <MyoxusText key={record.id}>{record.label}</MyoxusText>
          ))}
          <Group>
            <Menu
              title={m.stateAddRegion()}
              items={
                <>
                  {["before", "after"].map((position) => (
                    <MenuItem
                      key={position}
                      disabled={props.readonly}
                      onClick={() =>
                        c &&
                        d.commit("addStateRegion", [
                          c.sourceKey!,
                          {
                            regionKey: regionKey!,
                            position: position as "before" | "after",
                          },
                        ])
                      }
                    >
                      {position === "before"
                        ? m.sequenceBefore()
                        : m.sequenceAfter()}
                    </MenuItem>
                  ))}
                </>
              }
            >
              <Button disabled={props.readonly}>{m.stateAddRegion()}</Button>
            </Menu>
            <Button
              disabled={props.readonly || index <= 0}
              onClick={() =>
                prepareReorder([regionKey!, regions[index - 1]!.id])
              }
            >
              {m.visualMoveUp()}
            </Button>
            <Button
              disabled={props.readonly || index >= regions.length - 1}
              onClick={() =>
                prepareReorder([regions[index + 1]!.id, regionKey!])
              }
            >
              {m.visualMoveDown()}
            </Button>
            <Button
              disabled={props.readonly || !scope.divider}
              onClick={() => setDeleting(true)}
            >
              {m.visualDelete()}
            </Button>
          </Group>
        </>
      ) : (
        <Button
          disabled={props.readonly || !c}
          onClick={() => c && d.commit("addStateRegion", [c.sourceKey!])}
        >
          {m.stateAddRegion()}
        </Button>
      )}
      {d.diagnostic || previewDiagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? previewDiagnostic}
        </Alert>
      ) : null}
      <ConfirmModal
        open={Boolean(reorder)}
        onOpenChange={(opened) => {
          if (!opened) {
            preview.clear();
            setReorder(null);
          }
        }}
        title={m.stateRegion()}
        confirmText={m.treemapMove()}
        onConfirm={() => {
          if (!reorder) return;
          const result = d.commit("reorderStateRegion", [...reorder]);
          if (!result.diagnostic) {
            preview.clear();
            setReorder(null);
          }
        }}
      >
        <Stack>
          {reorder ? (
            <MyoxusText>
              {regions.find((r) => r.id === reorder[0])?.label} ·{" "}
              {m.sequenceBefore()} ·{" "}
              {regions.find((r) => r.id === reorder[1])?.label}
            </MyoxusText>
          ) : null}
          {d.diagnostic ? (
            <Alert color="myoxusError" role="alert">
              {d.diagnostic}
            </Alert>
          ) : null}
        </Stack>
      </ConfirmModal>
      <ConfirmModal
        open={deleting}
        onOpenChange={(opened) => (opened ? setDeleting(true) : closeDelete())}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          const r = d.commit("deleteStateRegion", [
            regionKey!,
            { children, targetRegion: target },
          ]);
          if (!r.diagnostic) closeDelete();
        }}
      >
        <Stack>
          <Select
            label={m.stateRegion()}
            value={children}
            data={[
              { value: "reassign", label: m.stateReassignChildren() },
              { value: "delete", label: m.stateDeleteChildren() },
            ]}
            onChange={(value) => setChildren(value as typeof children)}
          />
          {children === "reassign" ? (
            <Select
              label={m.stateRegion()}
              value={target}
              data={regions
                .filter((r) => r.id !== regionKey)
                .map((r) => ({ value: r.id, label: r.label }))}
              onChange={setTarget}
            />
          ) : null}
          {contents.map((record) => (
            <MyoxusText key={record.id}>{record.label}</MyoxusText>
          ))}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
export function StateRegionPopover({
  props,
  composite,
  regionKey,
}: {
  props: StateReactHostProps;
  composite: MermaidStateComposite;
  regionKey: string;
}) {
  const [opened, setOpened] = useState(false),
    region = props.model.regions.find((r) => r.id === regionKey),
    label = region
      ? `${m.stateRegion()} ${region.regionIndex + 1}`
      : m.statePrimaryRegion();
  return (
    <Popover
      fitViewport
      trapFocus
      contentMeasure="reading"
      opened={opened}
      onChange={setOpened}
    >
      <PopoverTarget>
        <Button onClick={() => setOpened(!opened)}>{label}</Button>
      </PopoverTarget>
      <PopoverContent aria-labelledby={undefined} aria-label={label}>
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <StateRegionForm
              props={props}
              composite={composite}
              regionKey={regionKey}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
