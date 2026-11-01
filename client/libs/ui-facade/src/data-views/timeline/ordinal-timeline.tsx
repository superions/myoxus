// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box, ScrollArea, Stack } from "@mantine/core";
import {
  useLayoutEffect,
  useState,
  useCallback,
  type CSSProperties,
} from "react";
import { useResponsiveElementSize } from "../../responsive";
import { ordinalTimelineGeometry } from "./geometry";
import { TimelineSection } from "./timeline-section";
import { Fragment } from "react";
import { TimelineOverlays, TimelineInsertMarker } from "./timeline-overlays";
import type { OrdinalTimelineViewProps } from "./timeline-view";

/** Browser intrinsic/subgrid layout measures wrapped labels and complete card stacks. */
export function OrdinalTimeline(props: OrdinalTimelineViewProps) {
  const { ref, width } = useResponsiveElementSize<HTMLDivElement>();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [font, setFont] = useState("");
  const [chromeWidth, setChromeWidth] = useState(32);
  const measureRef = useCallback(
    (node: HTMLDivElement | null) => {
      ref(node);
      setElement(node);
    },
    [ref],
  );
  const text = props.sections.flatMap((section) =>
    section.periods.flatMap((period) => [
      period.label,
      ...period.events.map((event) => event.label),
    ]),
  );
  useLayoutEffect(() => {
    if (!element) return;
    const style = getComputedStyle(element);
    const next = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    setFont((previous) => (previous === next ? previous : next));
  });
  useLayoutEffect(() => {
    if (!element) return;
    // Native controls retain their themed size. Only the renderer's card
    // geometry reserves their actual width; density never shrinks labels.
    const reserves = Array.from(
      element.querySelectorAll<HTMLElement>(
        '[data-timeline-kind="period"], [data-timeline-kind="event"]',
      ),
    ).map((actor) => {
      const group = actor.parentElement!;
      const siblings = Array.from(group.children).filter(
        (child) => child !== actor,
      );
      const gap = parseFloat(getComputedStyle(group).columnGap) || 0;
      const labelStyle = getComputedStyle(actor);
      const card = actor.closest<HTMLElement>("[data-timeline-event-id]");
      const cardStyle = card ? getComputedStyle(card) : undefined;
      return (
        siblings.reduce(
          (sum, sibling) => sum + sibling.getBoundingClientRect().width,
          0,
        ) +
        gap * siblings.length +
        (parseFloat(labelStyle.paddingLeft) || 0) +
        (parseFloat(labelStyle.paddingRight) || 0) +
        (parseFloat(cardStyle?.paddingLeft ?? "0") || 0) +
        (parseFloat(cardStyle?.paddingRight ?? "0") || 0)
      );
    });
    setChromeWidth(Math.max(32, ...reserves));
  }, [element, props.comments !== undefined, props.readonly]);
  const geometry = ordinalTimelineGeometry(
    width,
    text,
    font,
    props.density ?? 40,
    props.fitWidth && props.axis.direction === "LR"
      ? Math.max(0, ...props.sections.map((section) => section.periods.length))
      : 0,
    chromeWidth,
  );
  const style = {
    "--timeline-card-width": `${geometry.cardWidth}px`,
    "--timeline-anchor-gap": `${geometry.anchorGap}px`,
  } as CSSProperties;
  return (
    <Box
      ref={measureRef}
      data-myoxus-ui-role="timeline-view"
      data-direction={props.axis.direction}
      style={style}
      aria-label={props.accessibility.title}
      aria-description={props.accessibility.description}
      role="region"
    >
      <ScrollArea type="auto" offsetScrollbars>
        <Stack>
          {props.sections.map((section) => (
            <Fragment key={section.id}>
              {!section.implicit ? (
                <TimelineInsertMarker
                  props={props}
                  kind="section"
                  order={props.sections
                    .filter(
                      (s) => !s.implicit && s.id !== props.moveDraft?.object.id,
                    )
                    .findIndex((s) => s.id === section.id)}
                />
              ) : null}
              <TimelineSection section={section} props={props} />
            </Fragment>
          ))}
          <TimelineInsertMarker
            props={props}
            kind="section"
            order={
              props.sections.filter(
                (s) => !s.implicit && s.id !== props.moveDraft?.object.id,
              ).length
            }
          />
        </Stack>
      </ScrollArea>
      <TimelineOverlays
        diagnostics={props.diagnostics.filter((item) => item.anchorId === null)}
      />
    </Box>
  );
}
