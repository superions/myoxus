// SPDX-License-Identifier: AGPL-3.0-or-later

import { ActionIcon, Box, Button, Text, Tooltip } from "@mantine/core";
import type { CSSProperties } from "react";
import type { PacketBitGridProps, PacketFragment } from "./types";
import type { usePacketGeometryDraft } from "./use-packet-geometry-draft";
export function PacketField({
  fragment,
  props,
  geometry,
  hoveredFieldId,
  onHoverField,
}: {
  fragment: PacketFragment;
  props: PacketBitGridProps;
  geometry: ReturnType<typeof usePacketGeometryDraft>;
  hoveredFieldId?: string;
  onHoverField: (fieldId?: string) => void;
}) {
  const selected = props.selectedFieldId === fragment.fieldId;
  const index = props.fieldOrder.indexOf(fragment.fieldId);
  const reorder = {
    kind: "reorder" as const,
    fieldKey: fragment.fieldId,
    targetIndex: index,
  };
  const text = props.labels.field(
    fragment.label,
    fragment.fieldStartBit,
    fragment.fieldEndBit,
    fragment.continuesBefore || fragment.continuesAfter,
  );
  const field = (
    <Button
      aria-label={text}
      aria-pressed={selected}
      title={text}
      data-packet-field-id={fragment.fieldId}
      data-packet-fragment-row={fragment.row}
      data-myoxus-ui-role="packet-bit-field"
      tabIndex={
        !fragment.continuesBefore &&
        (props.selectedFieldId ? selected : index === 0)
          ? 0
          : -1
      }
      variant={
        selected || hoveredFieldId === fragment.fieldId ? "light" : "default"
      }
      onMouseEnter={() => onHoverField(fragment.fieldId)}
      onMouseLeave={() => onHoverField()}
      onFocus={(event) =>
        props.onSelectField?.(fragment.fieldId, event.currentTarget)
      }
      onClick={(event) =>
        props.onSelectField?.(fragment.fieldId, event.currentTarget)
      }
      onDoubleClick={(event) => {
        event.stopPropagation();
        props.onOpenField?.(fragment, event.currentTarget);
      }}
      onPointerDown={(event) => {
        props.onSelectField?.(fragment.fieldId, event.currentTarget);
        geometry.begin(event, reorder);
      }}
      onPointerMove={geometry.move}
      onPointerUp={geometry.finish}
      onPointerCancel={geometry.pointerCancel}
      onLostPointerCapture={geometry.lostCapture}
      onKeyDown={(event) => {
        geometry.keyboard(event, reorder);
        if (event.defaultPrevented) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          props.onOpenField?.(fragment, event.currentTarget);
        }
        if (event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          props.onSelectField?.(fragment.fieldId, event.currentTarget);
        }
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          event.stopPropagation();
          props.onDeleteField?.(fragment.fieldId);
        }
        if (
          !event.altKey &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight")
        ) {
          event.preventDefault();
          event.stopPropagation();
          const id =
            props.fieldOrder[index + (event.key === "ArrowLeft" ? -1 : 1)];
          const target = [
            ...(geometry.rootRef.current?.querySelectorAll<HTMLElement>(
              "[data-packet-field-id]",
            ) ?? []),
          ].find((el) => el.dataset.packetFieldId === id);
          if (id && target) {
            props.onSelectField?.(id, target);
            target.focus();
          }
        }
      }}
    >
      <Text truncate>
        {fragment.continuesBefore ? "↪ " : ""}
        {fragment.label}
        {fragment.continuesAfter ? " ↩" : ""}
      </Text>
    </Button>
  );
  const boundary = fragment.boundary;
  return (
    <Box
      data-myoxus-ui-role="packet-bit-field-shell"
      data-selected={selected || undefined}
      style={
        {
          "--packet-grid-start": fragment.columnStart + 1,
          "--packet-grid-width": fragment.columnEnd - fragment.columnStart + 1,
        } as CSSProperties
      }
    >
      {props.frameField?.(fragment, field) ?? field}
      <Box data-myoxus-ui-role="packet-bit-field-marker">
        {props.fieldMarker?.(fragment)}
      </Box>
      {boundary &&
      !props.readonly &&
      !props.displayOnly &&
      (selected ||
        Boolean(
          props.selectedFieldId && props.selectedFieldId === boundary.rightKey,
        )) ? (
        <Tooltip label={props.labels.boundary(boundary.bit, fragment.label)}>
          <ActionIcon
            aria-label={props.labels.boundary(boundary.bit, fragment.label)}
            data-packet-boundary-left={boundary.leftKey}
            data-packet-resize-edge="end"
            data-packet-boundary-side={selected ? "after" : "before"}
            size="xs"
            onPointerDown={(event) =>
              geometry.begin(event, {
                kind: "boundary",
                leftKey: boundary.leftKey,
                rightKey: boundary.rightKey,
                bit: boundary.bit,
              })
            }
            onPointerMove={geometry.move}
            onPointerUp={geometry.finish}
            onPointerCancel={geometry.pointerCancel}
            onLostPointerCapture={geometry.lostCapture}
            onKeyDown={(event) =>
              geometry.keyboard(event, {
                kind: "boundary",
                leftKey: boundary.leftKey,
                rightKey: boundary.rightKey,
                bit: boundary.bit,
              })
            }
            variant="default"
          >
            ↔
          </ActionIcon>
        </Tooltip>
      ) : null}
    </Box>
  );
}
