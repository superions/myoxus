// SPDX-License-Identifier: AGPL-3.0-or-later
import { Fragment } from "react";
import { Card, Group, Stack, Text } from "@mantine/core";
import {
  TimelineObjectLabel,
  TimelineObjectActions,
  TimelineInsertMarker,
} from "./timeline-overlays";
import type {
  TimelinePeriodProjection,
  OrdinalTimelineViewProps,
} from "./timeline-view";
export function TimelineEventStack({
  period,
  props,
}: {
  readonly period: TimelinePeriodProjection;
  readonly props: OrdinalTimelineViewProps;
}) {
  return (
    <Stack className="timeline-event-stack">
      {period.events.map((event) => (
        <Fragment key={event.id}>
          <TimelineInsertMarker
            props={props}
            kind="event"
            parentId={period.id}
            order={period.events
              .filter((e) => e.id !== props.moveDraft?.object.id)
              .findIndex((e) => e.id === event.id)}
          />
          <Card withBorder data-timeline-event-id={event.id}>
            <Group wrap="nowrap">
              <TimelineObjectLabel
                object={{ kind: "event", id: event.id }}
                label={event.label}
                accessibleLabel={`${event.label}, ${period.label}`}
                props={props}
              />
              {event.id !== "timeline-create-draft" ? (
                <TimelineObjectActions
                  object={{ kind: "event", id: event.id }}
                  props={props}
                />
              ) : null}
            </Group>
            {event.description ? <Text>{event.description}</Text> : null}
          </Card>
        </Fragment>
      ))}
      <TimelineInsertMarker
        props={props}
        kind="event"
        parentId={period.id}
        order={
          period.events.filter((e) => e.id !== props.moveDraft?.object.id)
            .length
        }
      />
    </Stack>
  );
}
