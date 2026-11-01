// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box, Text } from "@mantine/core";
import type { PacketBitGridProps, PacketRowProjection } from "./types";
import type { usePacketGeometryDraft } from "./use-packet-geometry-draft";
import { PacketField } from "./packet-field";
export function PacketRow({
  row,
  props,
  geometry,
  hoveredFieldId,
  onHoverField,
}: {
  row: PacketRowProjection;
  props: PacketBitGridProps;
  geometry: ReturnType<typeof usePacketGeometryDraft>;
  hoveredFieldId?: string;
  onHoverField: (fieldId?: string) => void;
}) {
  return (
    <Box data-myoxus-ui-role="packet-bit-row" data-packet-row={row.row}>
      {props.showBits
        ? Array.from({ length: row.endBit - row.startBit + 1 }, (_, column) => (
            <Text data-myoxus-ui-role="packet-bit-ruler" key={column} size="xs">
              {props.labels.bit?.(row.startBit + column) ??
                row.startBit + column}
            </Text>
          ))
        : null}
      {row.fragments.map((fragment) => (
        <PacketField
          key={fragment.fieldId}
          fragment={fragment}
          props={props}
          geometry={geometry}
          hoveredFieldId={hoveredFieldId}
          onHoverField={onHoverField}
        />
      ))}
    </Box>
  );
}
