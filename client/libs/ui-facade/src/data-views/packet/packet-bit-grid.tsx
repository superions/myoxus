// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box, Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { PrimaryScrollArea } from "../primary-scroll-area";
import type { PacketBitGridProps } from "./types";
import { PacketMarkers } from "./packet-markers";
import { PacketRow } from "./packet-row";
import { usePacketGeometryDraft } from "./use-packet-geometry-draft";
export function PacketBitGrid(props: PacketBitGridProps) {
  const geometry = usePacketGeometryDraft(props);
  const [hoveredFieldId, setHoveredFieldId] = useState<string>();
  const appliedFocus = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (
      !props.focusRequest ||
      appliedFocus.current === props.focusRequest.requestId
    )
      return;
    const fields = [
      ...(geometry.rootRef.current?.querySelectorAll<HTMLElement>(
        "[data-packet-field-id]",
      ) ?? []),
    ];
    const candidates = fields.filter(
      (field) => field.dataset.packetFieldId === props.focusRequest?.fieldId,
    );
    const viewport = geometry.viewportRef.current?.getBoundingClientRect();
    const visible = candidates.find((field) => {
      if (!viewport) return true;
      const bounds = field.getBoundingClientRect();
      return (
        bounds.right > viewport.left &&
        bounds.left < viewport.right &&
        bounds.bottom > viewport.top &&
        bounds.top < viewport.bottom
      );
    });
    const target = props.focusRequest.fieldId
      ? (visible ?? candidates[0])
      : geometry.rootRef.current?.querySelector<HTMLElement>("button");
    if (!target) return;
    // A confirmed command can arrive before the new Source projection. Retry
    // when Rows materialize, then consume the request exactly once.
    appliedFocus.current = props.focusRequest.requestId;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.focusRequest, props.rows]);
  const selected = props.rows
    .flatMap((row) => row.fragments)
    .find((fragment) => fragment.fieldId === props.selectedFieldId);
  return (
    <Stack
      aria-label={props["aria-label"]}
      aria-description={props["aria-description"]}
      data-myoxus-ui-role="packet-bit-editor"
      role="region"
    >
      {props.error}
      <Text>{props.labels.totalWidth(props.totalWidth)}</Text>
      <PacketMarkers>{props.markers}</PacketMarkers>
      <PrimaryScrollArea
        data-myoxus-ui-role="packet-bit-scroll"
        owner={props.scrollOwner ?? "self"}
        viewportRef={geometry.viewportRef}
        type="always"
        scrollbars="x"
      >
        <Box
          data-myoxus-ui-role="packet-bit-grid"
          ref={geometry.rootRef}
          tabIndex={-1}
          onPointerMove={geometry.move}
          onPointerUp={geometry.finish}
          onPointerCancel={geometry.pointerCancel}
          onLostPointerCapture={geometry.lostCapture}
          onKeyDown={(event) => {
            if (event.key === "Escape" && geometry.intent) {
              event.preventDefault();
              event.stopPropagation();
              geometry.cancel(event.nativeEvent);
            }
          }}
          style={
            {
              "--packet-column-count": props.bitsPerRow,
              "--packet-bit-width": `${props.bitWidth}px`,
              "--packet-row-height": `${props.rowHeight}px`,
              "--packet-padding-x": `${props.paddingX}px`,
              "--packet-padding-y": `${props.paddingY}px`,
            } as CSSProperties
          }
        >
          {props.rows.map((row) => (
            <PacketRow
              key={row.row}
              row={row}
              props={props}
              geometry={geometry}
              hoveredFieldId={hoveredFieldId}
              onHoverField={setHoveredFieldId}
            />
          ))}
          {props.rows.length ? null : props.empty}
        </Box>
      </PrimaryScrollArea>
      {selected || geometry.intent ? (
        <Stack role="status">
          {selected ? (
            <Text>
              {props.labels.field(
                selected.label,
                selected.fieldStartBit,
                selected.fieldEndBit,
                selected.continuesBefore || selected.continuesAfter,
              )}
            </Text>
          ) : null}
          {geometry.intent ? (
            <Text>
              {geometry.intent.kind === "boundary"
                ? props.labels.boundary(
                    geometry.intent.bit,
                    selected?.label ?? "",
                  )
                : props.labels.reorderTarget(geometry.intent.targetIndex + 1)}
            </Text>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
