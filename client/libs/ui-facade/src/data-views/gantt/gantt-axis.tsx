// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box, Text } from "@mantine/core";

import { ganttValueToOffset } from "./geometry";
import type { GanttAxisProjection } from "./gantt-view";

function tickPosition(axis: GanttAxisProjection, value: number, width: number) {
  const offset = ganttValueToOffset(axis, value, width);
  if (offset <= 48) return "start" as const;
  if (offset >= width - 48) return "end" as const;
  return "middle" as const;
}

/** Axis header only; gridlines and excluded bands live in the row layer. */
export function GanttAxis({
  axis,
  width,
}: {
  axis: GanttAxisProjection;
  width: number;
}) {
  return (
    <Box data-myoxus-ui-role="gantt-axis" style={{ position: "relative" }}>
      <Box data-myoxus-ui-role="gantt-axis-header">
        {axis.ticks.map((tick) => (
          <Text
            data-myoxus-ui-role="gantt-axis-tick"
            data-position={tickPosition(axis, tick.value, width)}
            key={tick.value}
            size="xs"
            textWrap="nowrap"
            style={{
              insetInlineStart: ganttValueToOffset(axis, tick.value, width),
              position: "absolute",
            }}
          >
            {tick.label}
          </Text>
        ))}
      </Box>
      <Box
        data-myoxus-ui-role="gantt-axis-body"
        style={{ position: "relative" }}
      />
    </Box>
  );
}
