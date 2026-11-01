// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Badge,
  Box,
  Button,
  IconButton,
  Checkbox,
  ConfirmModal,
  Group,
  MultiSelect,
  MyoxusText,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import { GripVerticalIcon } from "@myoxus/icons";
import { createPortal } from "react-dom";
import {
  mermaidMessages as m,
  type ErReactHostProps,
  type MermaidErAttribute,
  type ErKey,
} from "@virgultum/block-mermaid";
import { changedErFields, handleErDraftKeyDown, useErDraft } from "./drafts";
export function ErAttributeForm({
  props,
  attribute,
  entityKey,
  onClose,
}: {
  props: ErReactHostProps;
  attribute?: MermaidErAttribute;
  entityKey: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    initial = {
      name: attribute?.name ?? "",
      type: attribute?.type ?? "string",
      optional: attribute?.optional ?? false,
      keys: attribute?.keys ?? ([] as ErKey[]),
      comment: attribute?.comment ?? "",
    },
    d = useErDraft(initial, props),
    v = d.value;
  const [deleting, setDeleting] = useState(false),
    [duplicating, setDuplicating] = useState(false),
    [duplicateName, setDuplicateName] = useState(attribute?.name ?? ""),
    [before, setBefore] = useState("");
  const siblings =
      props.model.entities.find((e) => e.sourceKey === entityKey)?.attributes ??
      [],
    index = siblings.findIndex((a) => a.id === attribute?.id),
    insertion =
      !attribute && before ? props.resolveAttributeInsertAnchor(before) : null;
  const reorder = (up: boolean) =>
    attribute &&
    d.commit("reorderErAttribute", [
      attribute.id,
      up
        ? (siblings[index - 1]?.id ?? null)
        : (siblings[index + 2]?.id ?? null),
    ]);
  const save = () => {
    const r = attribute
      ? d.commit("editErAttribute", [attribute.id, changedErFields(initial, v)])
      : d.commit("addErAttribute", [
          entityKey,
          v,
          undefined,
          before || undefined,
        ]);
    if (!r.diagnostic) onClose();
  };
  return (
    <>
      {insertion
        ? createPortal(
            <Box
              pos="fixed"
              role="status"
              style={{
                left: insertion.left,
                top: insertion.top,
                transform: "translate(0, -50%)",
                pointerEvents: "none",
                zIndex: "var(--myoxus-z-index-popover)",
              }}
            >
              <Badge>{m.timelineInsertPosition()}</Badge>
            </Box>,
            document.body,
          )
        : null}
      <Stack
        onKeyDown={(event) => {
          handleErDraftKeyDown(event, props.readonly, save, onClose);
          if (
            attribute &&
            !props.readonly &&
            event.altKey &&
            ["ArrowUp", "ArrowDown"].includes(event.key)
          ) {
            const up = event.key === "ArrowUp";
            if (up ? index > 0 : index >= 0 && index < siblings.length - 1) {
              event.preventDefault();
              event.stopPropagation();
              reorder(up);
            }
          }
        }}
      >
        <MyoxusTextInput
          autoFocus
          label={m.erName()}
          value={v.name}
          disabled={props.readonly}
          onChange={(value) => d.set("name", value)}
        />
        <MyoxusTextInput
          label={m.erType()}
          value={v.type}
          disabled={props.readonly}
          onChange={(value) => d.set("type", value)}
        />
        <Checkbox
          label={m.erOptional()}
          checked={v.optional}
          disabled={props.readonly}
          onChange={(event) => d.set("optional", event.currentTarget.checked)}
        />
        <MultiSelect
          label={m.erKeys()}
          data={["PK", "FK", "UK"]}
          value={v.keys}
          disabled={props.readonly}
          onChange={(value) => d.set("keys", value as ErKey[])}
        />
        <MyoxusTextInput
          label={m.erAttributeComment()}
          value={v.comment}
          disabled={props.readonly}
          onChange={(value) => d.set("comment", value)}
        />
        {!attribute ? (
          <Select
            label={m.timelineInsertPosition()}
            value={before}
            data={[
              { value: "", label: t["admin.common.none"]() },
              ...siblings.map((a) => ({
                value: a.id,
                label: `${a.name} · ${a.type}`,
              })),
            ]}
            onChange={setBefore}
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
          {attribute ? (
            <>
              <Button
                disabled={props.readonly}
                onClick={() => setDuplicating(true)}
              >
                {t["com.myoxus.editor.keyboard.duplicate"]()}
              </Button>
              <Button
                disabled={props.readonly || index <= 0}
                onClick={() => reorder(true)}
              >
                {m.visualMoveUp()}
              </Button>
              <Button
                disabled={
                  props.readonly || index < 0 || index >= siblings.length - 1
                }
                onClick={() => reorder(false)}
              >
                {m.visualMoveDown()}
              </Button>
              <Button
                disabled={props.readonly}
                onClick={() => setDeleting(true)}
              >
                {m.visualDelete()}
              </Button>
            </>
          ) : null}
        </Group>
        {duplicating && attribute ? (
          <Stack>
            <MyoxusTextInput
              autoFocus
              label={m.erName()}
              value={duplicateName}
              onChange={setDuplicateName}
            />
            <Group>
              <Button
                onClick={() => {
                  const r = d.commit("duplicateErAttribute", [
                    attribute.id,
                    duplicateName,
                  ]);
                  if (!r.diagnostic) {
                    setDuplicating(false);
                    onClose();
                  }
                }}
              >
                {t["com.myoxus.editor.keyboard.duplicate"]()}
              </Button>
              <Button onClick={() => setDuplicating(false)}>
                {m.cancel()}
              </Button>
            </Group>
          </Stack>
        ) : null}
        <ConfirmModal
          open={deleting}
          onOpenChange={setDeleting}
          title={m.visualDelete()}
          confirmText={m.visualDelete()}
          onConfirm={() => {
            if (!attribute) return;
            const r = d.commit("deleteErAttribute", [attribute.id]);
            if (!r.diagnostic) {
              setDeleting(false);
              onClose();
            }
          }}
        >
          <Stack>
            {attribute
              ? props
                  .getImpact({ kind: "attribute", key: attribute.id })
                  .records.map((r) => (
                    <MyoxusText key={r.id}>{r.label}</MyoxusText>
                  ))
              : null}
          </Stack>
        </ConfirmModal>
      </Stack>
    </>
  );
}
export function ErAddAttributePopover({
  props,
  entityKey,
}: {
  props: ErReactHostProps;
  entityKey: string;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover fitViewport trapFocus opened={opened} onChange={setOpened}>
      <PopoverTarget>
        <Button disabled={props.readonly} onClick={() => setOpened(!opened)}>
          {m.erAddAttribute()}
        </Button>
      </PopoverTarget>
      <PopoverContent>
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <ErAttributeForm
              props={props}
              entityKey={entityKey}
              onClose={() => setOpened(false)}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}

/** Pointer reordering previews only an insertion anchor. Release uses the same
 * checked record command as Alt+Arrow and never writes during pointer movement. */
export function ErAttributeReorderHandle({
  props,
  attribute,
  entityKey,
}: {
  props: ErReactHostProps;
  attribute: MermaidErAttribute;
  entityKey: string;
}) {
  const d = useErDraft({}, props),
    [target, setTarget] = useState<string | null | undefined>(undefined),
    cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);
  useEffect(() => {
    cancel.current?.();
    setTarget(undefined);
  }, [props.sourceBasis, props.readonly]);
  const anchor = props.resolveAttributeInsertAnchor(attribute.id),
    preview = target ? props.resolveAttributeInsertAnchor(target) : null;
  if (!anchor || props.readonly || props.displayOnly) return null;
  return createPortal(
    <>
      <Box
        pos="fixed"
        style={{
          left: anchor.left,
          top: anchor.top,
          transform: "translate(0, -50%)",
          zIndex: "var(--myoxus-z-index-popover)",
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <IconButton
          aria-label={m.timelineInsertPosition()}
          icon={<GripVerticalIcon />}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            cancel.current?.();
            const startY = event.clientY;
            let before: string | null = attribute.id,
              moved = false;
            const siblings =
              props.model.entities.find((e) => e.sourceKey === entityKey)
                ?.attributes ?? [];
            const move = (e: PointerEvent) => {
              moved ||= Math.abs(e.clientY - startY) > 4;
              if (!moved) return;
              before =
                siblings.find(
                  (a) =>
                    a.id !== attribute.id &&
                    (props.resolveAttributeInsertAnchor(a.id)?.top ??
                      Infinity) > e.clientY,
                )?.id ?? null;
              setTarget(before);
            };
            const cleanup = () => {
              document.removeEventListener("pointermove", move, true);
              document.removeEventListener("pointerup", up, true);
              document.removeEventListener("pointercancel", cleanup, true);
              document.removeEventListener("keydown", key, true);
              cancel.current = null;
              setTarget(undefined);
            };
            const up = (e: PointerEvent) => {
              e.stopPropagation();
              cleanup();
              if (moved) d.commit("reorderErAttribute", [attribute.id, before]);
            };
            const key = (e: KeyboardEvent) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cleanup();
              }
            };
            cancel.current = cleanup;
            document.addEventListener("pointermove", move, true);
            document.addEventListener("pointerup", up, true);
            document.addEventListener("pointercancel", cleanup, true);
            document.addEventListener("keydown", key, true);
          }}
        />
      </Box>
      {preview ? (
        <Box
          pos="fixed"
          role="status"
          style={{
            left: preview.left,
            top: preview.top,
            pointerEvents: "none",
            zIndex: "var(--myoxus-z-index-popover)",
          }}
        >
          <Badge>{m.timelineInsertPosition()}</Badge>
        </Box>
      ) : null}
    </>,
    document.body,
  );
}
