// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box, Stack, Group, ActionIcon, Tooltip } from "@mantine/core";
import { PlusIcon } from "@myoxus/icons/react";
import type {
  TimelineSectionProjection,
  OrdinalTimelineViewProps,
} from "./timeline-view";
import {
  TimelineObjectLabel,
  TimelineObjectActions,
  TimelineInsertMarker,
  TimelineOverlays,
} from "./timeline-overlays";
import { TimelinePeriod } from "./timeline-period";

export function TimelineSection({
  section,
  props,
}: {
  readonly section: TimelineSectionProjection;
  readonly props: OrdinalTimelineViewProps;
}) {
  return (
    <Stack data-myoxus-ui-role="timeline-section" data-section-id={section.id}>
      <Group wrap="nowrap">
        {!props.readonly &&
        props.labels &&
        section.id !== "timeline-create-draft" ? (
          <Tooltip label={props.labels.addPeriod}>
            <ActionIcon
              variant="subtle"
              aria-label={props.labels.addPeriod}
              onClick={() => props.onCreate?.("period", section.id)}
            >
              <PlusIcon />
            </ActionIcon>
          </Tooltip>
        ) : null}
        <TimelineObjectLabel
          object={{ kind: "section", id: section.id }}
          label={section.label}
          props={props}
        />
        {!section.implicit && section.id !== "timeline-create-draft" ? (
          <TimelineObjectActions
            object={{ kind: "section", id: section.id }}
            props={props}
          />
        ) : null}
      </Group>
      <TimelineOverlays
        diagnostics={props.diagnostics.filter(
          (item) => item.anchorId === section.id,
        )}
      />
      <Box className="timeline-ordinal-flow">
        {section.periods.map((period) => (
          <Box key={period.id} className="timeline-period-slot">
            <TimelineInsertMarker
              props={props}
              kind="period"
              parentId={section.id}
              order={section.periods
                .filter((p) => p.id !== props.moveDraft?.object.id)
                .findIndex((p) => p.id === period.id)}
            />
            <TimelinePeriod period={period} props={props} />
          </Box>
        ))}
        <TimelineInsertMarker
          props={props}
          kind="period"
          parentId={section.id}
          order={
            section.periods.filter((p) => p.id !== props.moveDraft?.object.id)
              .length
          }
        />
      </Box>
    </Stack>
  );
}
