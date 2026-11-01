// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box } from "@mantine/core";
import { TimelineAxis } from "./timeline-axis";
import { TimelineEventStack } from "./timeline-event-stack";
import type {
  TimelinePeriodProjection,
  OrdinalTimelineViewProps,
} from "./timeline-view";

export function TimelinePeriod({
  period,
  props,
}: {
  readonly period: TimelinePeriodProjection;
  readonly props: OrdinalTimelineViewProps;
}) {
  return (
    <Box className="timeline-period" data-period-id={period.id}>
      <TimelineAxis period={period} props={props} />
      <TimelineEventStack period={period} props={props} />
    </Box>
  );
}
