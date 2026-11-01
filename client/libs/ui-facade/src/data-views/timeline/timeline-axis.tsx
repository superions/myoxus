// SPDX-License-Identifier: AGPL-3.0-or-later
import { Box, Group, ActionIcon, Tooltip } from "@mantine/core";
import { PlusIcon } from "@myoxus/icons/react";
import {
  TimelineObjectLabel,
  TimelineObjectActions,
  TimelineOverlays,
} from "./timeline-overlays";
import type {
  TimelinePeriodProjection,
  OrdinalTimelineViewProps,
} from "./timeline-view";
export function TimelineAxis({
  period,
  props,
}: {
  readonly period: TimelinePeriodProjection;
  readonly props: OrdinalTimelineViewProps;
}) {
  return (
    <Box className="timeline-period-axis">
      <Group wrap="nowrap">
        <TimelineObjectLabel
          object={{ kind: "period", id: period.id }}
          label={period.label}
          props={props}
        />
        {period.id !== "timeline-create-draft" ? (
          <>
            <TimelineObjectActions
              object={{ kind: "period", id: period.id }}
              props={props}
            />
            {!props.readonly && props.labels ? (
              <Tooltip label={props.labels.addEvent}>
                <ActionIcon
                  variant="subtle"
                  aria-label={props.labels.addEvent}
                  onClick={() => props.onCreate?.("event", period.id)}
                >
                  <PlusIcon />
                </ActionIcon>
              </Tooltip>
            ) : null}
          </>
        ) : null}
      </Group>
      <TimelineOverlays
        diagnostics={props.diagnostics.filter(
          (item) => item.anchorId === period.id,
        )}
      />
    </Box>
  );
}
