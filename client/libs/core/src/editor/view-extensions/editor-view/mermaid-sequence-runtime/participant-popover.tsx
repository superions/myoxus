// SPDX-License-Identifier: AGPL-3.0-or-later
import { createPortal } from "react-dom";
import { GripVerticalIcon } from "@myoxus/icons";
import { isValidUrl } from "@virgultum/shared/utils";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  ConfirmModal,
  Group,
  IconButton,
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
  SEQUENCE_PARTICIPANT_TYPES,
  type SequenceParticipantType,
  type SequenceReactHostProps,
  type MermaidSequenceParticipant,
} from "@virgultum/block-mermaid";
import {
  useSequenceDraft,
  changedSequenceFields,
  handleSequenceDraftKeyDown,
} from "./drafts";
import { SequenceDataForm } from "./data-popover";
export function SequenceParticipantForm({
  props,
  participant: p,
  onClose,
}: {
  props: SequenceReactHostProps;
  participant?: MermaidSequenceParticipant;
  onClose: () => void;
}) {
  const initial = {
      id: p?.id ?? "",
      label: p?.label ?? "",
      type: p?.type ?? ("participant" as SequenceParticipantType),
    },
    d = useSequenceDraft(initial, props),
    move = useSequenceDraft({ boxId: p?.boxId ?? "", beforeId: "" }, props),
    life = useSequenceDraft(
      { kind: "create" as "create" | "destroy", messageId: p?.createdBy ?? "" },
      props,
    ),
    [deleting, setDeleting] = useState(false),
    [data, setData] = useState(false),
    [lifecycle, setLifecycle] = useState(false);
  const run = (preview = false) =>
    p
      ? (preview ? d.preview : d.commit)("editSequenceParticipant", [
          p.sourceKey,
          changedSequenceFields(initial, d.value),
        ])
      : (preview ? d.preview : d.commit)("addSequenceParticipant", [
          {
            ...d.value,
            label: d.value.label || undefined,
            boxId: move.value.boxId || null,
          },
        ]);
  const save = () => {
    if (!run().diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) =>
        handleSequenceDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <MyoxusTextInput
        autoFocus
        label={m.sequenceId()}
        value={d.value.id}
        disabled={props.readonly}
        onChange={(value) => d.set("id", value)}
      />
      <MyoxusTextInput
        label={m.sequenceAlias()}
        value={d.value.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
      />
      <Select
        label={m.sequenceType()}
        value={d.value.type}
        disabled={props.readonly}
        data={SEQUENCE_PARTICIPANT_TYPES.map((value) => ({
          value,
          label: m.sequenceParticipantType(value),
        }))}
        onChange={(value) => d.set("type", value as SequenceParticipantType)}
      />
      <Select
        label={m.sequenceBox()}
        value={move.value.boxId}
        disabled={props.readonly}
        data={[
          { value: "", label: m.sequenceOff() },
          ...props.model.backgrounds
            .filter((b) => b.kind === "box")
            .map((b) => ({ value: b.id, label: b.label || m.sequenceBox() })),
        ]}
        onChange={(value) => move.set("boxId", value ?? "")}
      />
      {p ? (
        <>
          <Select
            label={m.sequenceSourceOrder()}
            value={move.value.beforeId}
            disabled={props.readonly || Boolean(p.createdBy)}
            data={[
              { value: "", label: m.sequenceEnd() },
              ...props.model.participants
                .filter(
                  (o) =>
                    o !== p &&
                    !o.createdBy &&
                    o.boxId === (move.value.boxId || null),
                )
                .map((o) => ({
                  value: o.sourceKey,
                  label: `${m.sequenceBefore()} · ${o.label}`,
                })),
            ]}
            onChange={(value) => move.set("beforeId", value ?? "")}
          />
          <Group>
            <Button
              disabled={props.readonly || Boolean(p.createdBy)}
              onClick={() =>
                move.preview("moveSequenceParticipant", [
                  p.sourceKey,
                  {
                    boxId: move.value.boxId || null,
                    beforeId: move.value.beforeId || undefined,
                  },
                ])
              }
            >
              {m.sequencePreview()}
            </Button>
            <Button
              disabled={props.readonly || Boolean(p.createdBy)}
              onClick={() => {
                if (
                  !move.commit("moveSequenceParticipant", [
                    p.sourceKey,
                    {
                      boxId: move.value.boxId || null,
                      beforeId: move.value.beforeId || undefined,
                    },
                  ]).diagnostic
                )
                  onClose();
              }}
            >
              {m.treemapMove()}
            </Button>
          </Group>
        </>
      ) : null}
      {d.diagnostic || move.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic || move.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button disabled={props.readonly} onClick={() => run(true)}>
          {m.sequencePreview()}
        </Button>
        <Button disabled={props.readonly} onClick={save}>
          {m.sequenceApply()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
      {p ? (
        <>
          <Checkbox
            label={m.sequenceLifecycleEdit()}
            checked={lifecycle}
            onChange={(event) => setLifecycle(event.currentTarget.checked)}
          />
          {lifecycle ? (
            <Stack>
              <Select
                label={m.sequenceLifecycleAction()}
                value={life.value.kind}
                data={[
                  { value: "create", label: m.sequenceLifecycleCreate() },
                  { value: "destroy", label: m.sequenceLifecycleDestroy() },
                ]}
                onChange={(value) =>
                  life.set("kind", value as "create" | "destroy")
                }
              />
              <Select
                label={m.sequenceMessage()}
                value={life.value.messageId}
                disabled={props.readonly}
                data={[
                  { value: "", label: m.sequenceOff() },
                  ...props.model.messages
                    .filter((msg) =>
                      life.value.kind === "create"
                        ? msg.to === p.id
                        : msg.from === p.id || msg.to === p.id,
                    )
                    .map((msg) => ({
                      value: msg.id,
                      label: `${msg.from} → ${msg.to} · ${msg.label}`,
                    })),
                ]}
                onChange={(value) => life.set("messageId", value ?? "")}
              />
              <Group>
                <Button
                  disabled={props.readonly}
                  onClick={() =>
                    life.preview("setSequenceLifecycle", [
                      p.sourceKey,
                      {
                        kind: life.value.kind,
                        messageId: life.value.messageId || undefined,
                      },
                    ])
                  }
                >
                  {m.sequencePreview()}
                </Button>
                <Button
                  disabled={props.readonly}
                  onClick={() => {
                    if (
                      !life.commit("setSequenceLifecycle", [
                        p.sourceKey,
                        {
                          kind: life.value.kind,
                          messageId: life.value.messageId || undefined,
                        },
                      ]).diagnostic
                    )
                      onClose();
                  }}
                >
                  {m.sequenceApply()}
                </Button>
              </Group>
              {life.diagnostic ? (
                <Alert color="myoxusError">{life.diagnostic}</Alert>
              ) : null}
            </Stack>
          ) : null}
          {p.links.map((link) => (
            <SequenceLinkForm
              key={link.label}
              props={props}
              participant={p}
              label={link.label}
              url={link.url}
            />
          ))}
          <SequenceLinkForm props={props} participant={p} />
          <Group>
            <Popover fitViewport opened={data} onChange={setData}>
              <PopoverTarget>
                <Button onClick={() => setData(!data)}>{m.pieData()}</Button>
              </PopoverTarget>
              <PopoverContent>
                <Scrollable.Viewport
                  autosize
                  maxHeight="floating"
                  scrollbars="y"
                >
                  {data ? (
                    <SequenceDataForm props={props} participantId={p.id} />
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
              if (
                !d.commit("deleteSequenceParticipant", [p.sourceKey]).diagnostic
              )
                onClose();
            }}
          >
            <Stack>
              {props
                .getImpact({ kind: "participant", key: p.sourceKey })
                .records.map((record) => (
                  <MyoxusText key={record.id}>{record.label}</MyoxusText>
                ))}
            </Stack>
          </ConfirmModal>
        </>
      ) : null}
    </Stack>
  );
}
function SequenceLinkForm({
  props,
  participant,
  label = "",
  url = "",
}: {
  props: SequenceReactHostProps;
  participant: MermaidSequenceParticipant;
  label?: string;
  url?: string;
}) {
  const d = useSequenceDraft({ label, url }, props);
  return (
    <Stack>
      <MyoxusTextInput
        label={m.timelineLabel()}
        value={d.value.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
      />
      <MyoxusTextInput
        label={m.ganttBindingUrl()}
        value={d.value.url}
        disabled={props.readonly}
        onChange={(value) => d.set("url", value)}
      />
      <Group>
        {url && isValidUrl(url) ? (
          <Button
            onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
          >
            {m.sequenceOpenLink()}
          </Button>
        ) : null}
        <Button
          disabled={props.readonly}
          onClick={() =>
            d.commit("editSequenceLink", [
              participant.sourceKey,
              { ...d.value, previousLabel: label || undefined },
            ])
          }
        >
          {m.sequenceApply()}
        </Button>
        {url ? (
          <Button
            disabled={props.readonly}
            onClick={() =>
              d.commit("editSequenceLink", [
                participant.sourceKey,
                { label, url: "", previousLabel: label },
              ])
            }
          >
            {m.visualDelete()}
          </Button>
        ) : null}
      </Group>
      {d.diagnostic ? <Alert color="myoxusError">{d.diagnostic}</Alert> : null}
    </Stack>
  );
}

/** Horizontal gesture targets a Source declaration in the same Box. Membership
 * changes use the explicit Box command rather than overlap inference. */
export function SequenceParticipantHandle({
  props,
  id,
}: {
  props: SequenceReactHostProps;
  id: string;
}) {
  const [target, setTarget] = useState<string | null>(null),
    [diagnostic, setDiagnostic] = useState<string | null>(null),
    dispose = useRef<(() => void) | null>(null),
    basis = useRef(props.sourceBasis),
    latest = useRef(props);
  latest.current = props;
  useEffect(() => () => dispose.current?.(), []);
  useEffect(() => {
    basis.current = props.sourceBasis;
    dispose.current?.();
    setTarget(null);
  }, [props.sourceBasis, props.readonly, id]);
  const participant = props.model.participants.find((p) => p.sourceKey === id),
    siblings = props.model.participants.filter(
      (p) => !p.createdBy && p.boxId === participant?.boxId,
    ),
    run = (preview: boolean, before: string) => {
      const result = (
        preview ? latest.current.onPreview : latest.current.onCommand
      )(
        "moveSequenceParticipant",
        [
          id,
          { boxId: participant?.boxId ?? null, beforeId: before || undefined },
        ],
        basis.current,
      );
      if (result.changed && result.sourceBasis)
        basis.current = result.sourceBasis;
      setDiagnostic(result.diagnostic ?? null);
    };
  const point =
    target !== null
      ? props.resolveParticipantAnchor(
          target || siblings.at(-1)?.sourceKey || id,
        )
      : null;
  return (
    <>
      <IconButton
        aria-label={m.sequenceSourceOrder()}
        disabled={props.readonly || Boolean(participant?.createdBy)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            props.onCancelPreview();
            setTarget(null);
            return;
          }
          if (event.key === "Enter" && target !== null) {
            event.preventDefault();
            event.stopPropagation();
            run(false, target);
            setTarget(null);
            return;
          }
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const index = siblings.findIndex((p) => p.sourceKey === id),
            before =
              event.key === "ArrowLeft"
                ? siblings[index - 1]?.sourceKey
                : (siblings[index + 2]?.sourceKey ?? "");
          if (before === undefined) return;
          setTarget(before);
          run(true, before);
        }}
        onPointerDown={(event) => {
          if (props.readonly || participant?.createdBy) return;
          event.preventDefault();
          event.stopPropagation();
          dispose.current?.();
          basis.current = props.sourceBasis;
          let candidate: string | null = null;
          const move = (event: PointerEvent) => {
            const next = latest.current.resolveParticipantDropBefore(
              { left: event.clientX, top: event.clientY },
              id,
            );
            if (next === candidate) return;
            candidate = next;
            setTarget(next);
            if (next !== null) run(true, next);
            else latest.current.onCancelPreview();
          };
          const cleanup = () => {
            document.removeEventListener("pointermove", move, true);
            document.removeEventListener("pointerup", up, true);
            document.removeEventListener("pointercancel", cleanup, true);
            latest.current.onCancelPreview();
            setTarget(null);
            dispose.current = null;
          };
          const up = () => {
            const chosen = candidate;
            cleanup();
            if (chosen !== null) run(false, chosen);
          };
          dispose.current = cleanup;
          document.addEventListener("pointermove", move, true);
          document.addEventListener("pointerup", up, true);
          document.addEventListener("pointercancel", cleanup, true);
        }}
      >
        <GripVerticalIcon />
      </IconButton>
      {target !== null
        ? createPortal(
            <Box
              pos="fixed"
              role="status"
              style={{
                left: point?.left,
                top: point?.top,
                pointerEvents: "none",
                zIndex: "var(--myoxus-z-index-popover)",
              }}
            >
              <Badge>
                {diagnostic ||
                  (target
                    ? `${m.sequenceBefore()} · ${siblings.find((p) => p.sourceKey === target)?.label}`
                    : m.sequenceEnd())}
              </Badge>
            </Box>,
            document.body,
          )
        : null}
    </>
  );
}
