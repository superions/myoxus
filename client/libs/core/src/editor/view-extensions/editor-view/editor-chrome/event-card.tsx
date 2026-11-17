// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  AlertTriangleIcon,
  CalendarClockIcon,
  PencilIcon,
  RefreshCwIcon,
} from "@myoxus/icons/react";
import { cssVar } from "@myoxus/theme";
import { ColorDot, Group, Loading, ReferenceCard } from "@myoxus/ui-facade";
import type { EditorEventCardControls } from "@virgultum/editor/shared/services";

/** Event lifecycle and permission guards stay with the mounted block. */
export function EditorEventCard({
  controls: c,
}: {
  controls: EditorEventCardControls;
}) {
  const unavailable = c.state === "unavailable";
  return (
    <ReferenceCard
      size="small"
      component={c.readonly ? "div" : "button"}
      interactive={!c.readonly}
      role={c.readonly ? "group" : undefined}
      aria-label={c.label}
      aria-busy={c.readonly ? undefined : c.state === "loading"}
      onClick={c.readonly ? undefined : c.activate}
      data-state={c.state}
      data-testid="editor-event-card"
      title={c.title}
      metadata={c.meta || undefined}
      icon={
        c.state === "loading" ? (
          <Loading />
        ) : unavailable ? (
          <AlertTriangleIcon color={cssVar("errorColor")} />
        ) : (
          <Group component="span" gap="xs" wrap="nowrap">
            <CalendarClockIcon color={cssVar("iconColor")} />
            {c.accent ? <ColorDot color={c.accent} /> : null}
          </Group>
        )
      }
      actions={
        !c.readonly && c.state !== "loading" ? (
          unavailable ? (
            <RefreshCwIcon aria-hidden />
          ) : (
            <PencilIcon aria-hidden />
          )
        ) : undefined
      }
    />
  );
}
