// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, useId } from "react";
import { createPortal } from "react-dom";
import { GripVerticalIcon } from "@myoxus/icons";
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
  Select,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  sequenceTimelineLabel,
  SEQUENCE_ARROW_MAP,
  createSequenceArrowPreviewMarker,
  MERMAID_SEQUENCE_MESSAGE_ARROWS,
  type MermaidSequenceMessage,
  type SequenceReactHostProps,
  type SequenceTimelineAnchor,
  type SequenceCommandArgs,
} from "@virgultum/block-mermaid";
import {
  useSequenceDraft,
  changedSequenceFields,
  handleSequenceDraftKeyDown,
  sequenceParticipantOptions,
  sequenceTimelineOptions,
  sequenceDraftAnchor,
} from "./drafts";
export function SequenceMessageForm({
  props,
  message,
  onClose,
}: {
  props: SequenceReactHostProps;
  message?: MermaidSequenceMessage;
  onClose: () => void;
}) {
  const initial = {
      from:
        message?.from ??
        props.model.participants.find(
          (p) => p.sourceKey === props.selectedKeys[0],
        )?.id ??
        props.model.participants[0]?.id ??
        "",
      to:
        message?.to ??
        props.model.participants[1]?.id ??
        props.model.participants[0]?.id ??
        "",
      label: message?.label ?? "",
      arrow: message?.arrow ?? ("->>" as const),
      centralFrom: message?.centralFrom ?? false,
      centralTo: message?.centralTo ?? false,
      activation: message?.activation ?? ("" as "" | "+" | "-"),
      wrap: message?.wrap ?? props.config.wrap,
    },
    d = useSequenceDraft(initial, props),
    v = d.value,
    [key, setKey] = useState(""),
    [position, setPosition] = useState<"before" | "after">("before"),
    [deleting, setDeleting] = useState(false);
  const run = (preview = false) => {
    const call = preview ? d.preview : d.commit;
    return message
      ? call("editSequenceMessage", [
          message.id,
          {
            ...changedSequenceFields(initial, v),
            activation: v.activation || undefined,
          },
        ])
      : call("addSequenceMessage", [
          { ...v, activation: v.activation || undefined },
          sequenceDraftAnchor(key, position),
        ]);
  };
  const save = () => {
    if (!run().diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) =>
        handleSequenceDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <Select
        autoFocus
        label={m.sankeyLinkSource()}
        data={sequenceParticipantOptions(props)}
        value={v.from}
        disabled={props.readonly}
        onChange={(value) => d.set("from", value ?? "")}
      />
      <Select
        label={m.sankeyLinkTarget()}
        data={sequenceParticipantOptions(props)}
        value={v.to}
        disabled={props.readonly}
        onChange={(value) => d.set("to", value ?? "")}
      />
      <Button
        disabled={props.readonly}
        onClick={() => {
          d.set("from", v.to);
          d.set("to", v.from);
          d.set("centralFrom", v.centralTo);
          d.set("centralTo", v.centralFrom);
        }}
      >
        {m.sequenceDirectionFlip()}
      </Button>
      <Select
        label={m.sequenceArrow()}
        data={MERMAID_SEQUENCE_MESSAGE_ARROWS.map((value) => ({
          value,
          label: m.sequenceArrowLabel(value),
        }))}
        value={v.arrow}
        disabled={props.readonly}
        onChange={(value) => d.set("arrow", value as typeof v.arrow)}
      />
      <SequenceArrowPreview
        arrow={v.arrow}
        centralFrom={v.centralFrom}
        centralTo={v.centralTo}
      />
      <Textarea
        label={m.timelineLabel()}
        value={v.label}
        disabled={props.readonly}
        autosize
        onChange={(value) => d.set("label", value)}
      />
      <Checkbox
        label={m.sequenceCentralFrom()}
        checked={v.centralFrom}
        disabled={props.readonly}
        onChange={(event) => d.set("centralFrom", event.currentTarget.checked)}
      />
      <Checkbox
        label={m.sequenceCentralTo()}
        checked={v.centralTo}
        disabled={props.readonly}
        onChange={(event) => d.set("centralTo", event.currentTarget.checked)}
      />
      <Select
        label={m.sequenceActivation()}
        value={v.activation}
        disabled={props.readonly}
        data={[
          { value: "", label: m.sequenceOff() },
          { value: "+", label: m.sequenceActivationStart() },
          { value: "-", label: m.sequenceActivationEnd() },
        ]}
        onChange={(value) => d.set("activation", value as typeof v.activation)}
      />
      <Checkbox
        label={m.sequenceWrap()}
        checked={v.wrap}
        disabled={props.readonly}
        onChange={(event) => d.set("wrap", event.currentTarget.checked)}
      />
      <Select
        label={m.sequenceSourceOrder()}
        data={sequenceTimelineOptions(props).filter(
          (option) => option.value !== message?.id,
        )}
        value={key}
        disabled={props.readonly}
        onChange={(value) => setKey(value ?? "")}
      />
      <Select
        label={m.sequencePosition()}
        data={[
          { value: "before", label: m.sequenceBefore() },
          { value: "after", label: m.sequenceAfter() },
        ]}
        value={position}
        disabled={props.readonly}
        onChange={(value) => setPosition(value as typeof position)}
      />
      {message ? (
        <Group>
          <Button
            disabled={props.readonly}
            onClick={() =>
              d.preview("reorderSequenceMessage", [
                message.id,
                sequenceDraftAnchor(key, position),
              ])
            }
          >
            {m.sequencePreview()}
          </Button>
          <Button
            disabled={props.readonly}
            onClick={() => {
              if (
                !d.commit("reorderSequenceMessage", [
                  message.id,
                  sequenceDraftAnchor(key, position),
                ]).diagnostic
              )
                onClose();
            }}
          >
            {m.treemapMove()}
          </Button>
        </Group>
      ) : null}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      {d.impact.map((record) => (
        <MyoxusText key={record.id}>{record.label}</MyoxusText>
      ))}
      <Group>
        <Button disabled={props.readonly} onClick={() => run(true)}>
          {m.sequencePreview()}
        </Button>
        <Button disabled={props.readonly || !v.from || !v.to} onClick={save}>
          {m.sequenceApply()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
        {message ? (
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
        ) : null}
      </Group>
      {message ? (
        <ConfirmModal
          open={deleting}
          onOpenChange={setDeleting}
          title={m.visualDelete()}
          confirmText={m.visualDelete()}
          onConfirm={() => {
            if (!d.commit("deleteSequenceMessage", [message.id]).diagnostic)
              onClose();
          }}
        >
          <Stack>
            {props
              .getImpact({ kind: "message", key: message.id })
              .records.map((record) => (
                <MyoxusText key={record.id}>{record.label}</MyoxusText>
              ))}
          </Stack>
        </ConfirmModal>
      ) : null}
    </Stack>
  );
}
/** The hit handle previews an explicit Source anchor. One valid release commits;
 * pointer cancel, external Source change and unmount only dispose the preview. */
export function SequenceTimelineHandle({
  props,
  id,
  command,
  boundary,
}: {
  props: SequenceReactHostProps;
  id: string;
  command:
    | "reorderSequenceMessage"
    | "reorderSequenceNote"
    | "reorderSequenceFragment"
    | "editSequenceActivation";
  boundary?: "start" | "end";
}) {
  const [target, setTarget] = useState<SequenceTimelineAnchor | null>(null),
    [diagnostic, setDiagnostic] = useState<string | null>(null),
    [impact, setImpact] = useState<readonly { id: string; label: string }[]>(
      [],
    ),
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
  const args = (anchor: SequenceTimelineAnchor) =>
    [id, boundary ? { [boundary]: anchor } : anchor] as SequenceCommandArgs<
      typeof command
    >;
  const execute = (preview: boolean, anchor: SequenceTimelineAnchor) => {
    const result = (
      preview ? latest.current.onPreview : latest.current.onCommand
    )(command, args(anchor), basis.current);
    setDiagnostic(result.diagnostic ?? null);
    setImpact(result.impact?.records ?? []);
    if (result.changed && result.sourceBasis)
      basis.current = result.sourceBasis;
    return result;
  };
  const records = props.model.sourceDocument.records.filter(
      (record) => record.temporal && record.sourceKey !== id,
    ),
    anchorPosition = target && props.resolveTimelineAnchor(target);
  return (
    <>
      <IconButton
        aria-label={
          boundary === "start"
            ? m.sequenceStart()
            : boundary === "end"
              ? m.sequenceEnd()
              : m.sequenceSourceOrder()
        }
        disabled={props.readonly}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Escape", "Enter"].includes(event.key))
            return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            props.onCancelPreview();
            setTarget(null);
            return;
          }
          if (event.key === "Enter" && target) {
            execute(false, target);
            setTarget(null);
            return;
          }
          const index = records.findIndex(
              (record) => record.sourceKey === target?.key,
            ),
            current = props.model.sourceDocument.records.findIndex(
              (record) => record.sourceKey === id,
            ),
            next =
              index < 0
                ? event.key === "ArrowUp"
                  ? records.findLast(
                      (record) =>
                        record.range.start <
                        (props.model.sourceDocument.records[current]?.range
                          .start ?? 0),
                    )
                  : records.find(
                      (record) =>
                        record.range.start >
                        (props.model.sourceDocument.records[current]?.range
                          .start ?? 0),
                    )
                : records[index + (event.key === "ArrowUp" ? -1 : 1)];
          if (next) {
            const anchor = sequenceDraftAnchor(
              next.sourceKey,
              event.key === "ArrowUp" ? "before" : "after",
            );
            setTarget(anchor);
            execute(true, anchor);
          }
        }}
        onPointerDown={(event) => {
          if (props.readonly) return;
          event.preventDefault();
          event.stopPropagation();
          basis.current = props.sourceBasis;
          dispose.current?.();
          let candidate: SequenceTimelineAnchor | null = null;
          const move = (event: PointerEvent) => {
            const next = latest.current.resolveTimelineDropAnchor(
              { left: event.clientX, top: event.clientY },
              id,
            );
            if (
              next?.key === candidate?.key &&
              next?.position === candidate?.position
            )
              return;
            candidate = next;
            setTarget(candidate);
            if (candidate) execute(true, candidate);
            else latest.current.onCancelPreview();
          };
          const cleanup = () => {
            document.removeEventListener("pointermove", move, true);
            document.removeEventListener("pointerup", up, true);
            document.removeEventListener("pointercancel", cancel, true);
            latest.current.onCancelPreview();
            setTarget(null);
            dispose.current = null;
          };
          const up = () => {
            const selected = candidate;
            cleanup();
            if (selected) execute(false, selected);
          };
          const cancel = () => cleanup();
          dispose.current = cleanup;
          document.addEventListener("pointermove", move, true);
          document.addEventListener("pointerup", up, true);
          document.addEventListener("pointercancel", cancel, true);
        }}
      >
        <GripVerticalIcon />
      </IconButton>
      {anchorPosition
        ? createPortal(
            <Box
              pos="fixed"
              role="status"
              style={{
                left: anchorPosition.left,
                top: anchorPosition.top,
                pointerEvents: "none",
                zIndex: "var(--myoxus-z-index-popover)",
              }}
            >
              <Stack>
                <Badge>
                  {diagnostic ||
                    `${target?.position === "before" ? m.sequenceBefore() : m.sequenceAfter()} · ${target?.key ? sequenceTimelineLabel(props.model, target.key) : ""}`}
                </Badge>
                {target?.key ? (
                  <MyoxusText>
                    {props.model.controls.find(
                      (c) =>
                        c.id ===
                        props.model.sourceDocument.records.find(
                          (r) => r.sourceKey === target.key,
                        )?.parentId,
                    )?.label || m.controlsLabel()}
                  </MyoxusText>
                ) : null}
                {impact.map((record) => (
                  <MyoxusText key={record.id}>{record.label}</MyoxusText>
                ))}
              </Stack>
            </Box>,
            document.body,
          )
        : null}
    </>
  );
}

function SequenceArrowPreview({
  arrow,
  centralFrom,
  centralTo,
}: {
  arrow: MermaidSequenceMessage["arrow"];
  centralFrom: boolean;
  centralTo: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null),
    id = useId().replaceAll(":", "");
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs"),
      line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    defs.append(
      createSequenceArrowPreviewMarker(`${id}-start`, arrow, true),
      createSequenceArrowPreviewMarker(`${id}-end`, arrow, false),
    );
    line.setAttribute("d", "M 20 24 L 140 24");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("marker-start", `url(#${id}-start)`);
    line.setAttribute("marker-end", `url(#${id}-end)`);
    if (SEQUENCE_ARROW_MAP[arrow].dotted)
      line.setAttribute("stroke-dasharray", "12 12");
    svg.replaceChildren(defs, line);
    for (const [enabled, x] of [
      [centralFrom, 20],
      [centralTo, 140],
    ] as const) {
      if (enabled) {
        const circle = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle",
        );
        circle.setAttribute("cx", String(x));
        circle.setAttribute("cy", "24");
        circle.setAttribute("r", "4");
        circle.setAttribute("fill", "currentColor");
        svg.append(circle);
      }
    }
  }, [arrow, centralFrom, centralTo, id]);
  return (
    <svg
      ref={ref}
      viewBox="0 0 160 48"
      width="160"
      height="48"
      role="img"
      aria-label={m.sequenceArrowLabel(arrow)}
    />
  );
}
