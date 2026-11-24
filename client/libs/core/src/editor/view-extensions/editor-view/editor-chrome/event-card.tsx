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
import { useEffect, useReducer, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import type {
  MyoxusResolvedEvent,
  EditorEventReference,
} from "@virgultum/core/services";
import { eventCardDateRange } from "@virgultum/core/services/data";
/** The same reference resolves and edits its event in both Page and Canvas. */
export function EventReferenceCard({
  controls: { model, readonly, host },
}: {
  controls: EditorEventReference;
}) {
  const t = useI18n();
  const { workspaceId, eventId } = model.props;
  const [revision, reload] = useReducer((n) => n + 1, 0);
  const [resolved, setResolved] = useState<{
    workspaceId: string;
    eventId: string;
    revision: number;
    event: MyoxusResolvedEvent | null;
  }>();
  useEffect(() => {
    let live = true;
    const finish = (event: MyoxusResolvedEvent | null) => {
      if (live) setResolved({ workspaceId, eventId, revision, event });
    };
    if (workspaceId && eventId) {
      void host
        .resolveEventData({ workspaceId, eventId })
        .then(finish, (error) => {
          console.error(error);
          finish(null);
        });
    } else finish(null);
    return () => {
      live = false;
    };
  }, [host, workspaceId, eventId, revision]);
  // An old target must never flash or receive commands while the new read is pending.
  const event =
    resolved?.workspaceId === workspaceId &&
    resolved.eventId === eventId &&
    resolved.revision === revision
      ? resolved.event
      : undefined;
  const current = () =>
    !readonly &&
    !model.store.readonly &&
    model.store.getModelById(model.id) === model &&
    model.props.eventId === eventId &&
    model.props.workspaceId === workspaceId;
  const title =
    event === undefined
      ? t.Loading()
      : event === null
        ? t["com.myoxus.editor.event.unavailable"]()
        : event.title || t["com.myoxus.integration.calendar.untitled-event"]();
  const loading = event === undefined;
  const unavailable = event === null;
  const meta = event
    ? eventCardDateRange(
        event,
        t.language,
        t["com.myoxus.integration.calendar.all-day"](),
      )
    : unavailable
      ? t.Retry()
      : undefined;
  const accent = event?.tagColor?.trim();
  const label = event
    ? `${t["com.myoxus.integration.calendar.event-edit"]()}: ${title}`
    : unavailable
      ? t.Retry()
      : title;
  const activate = () => {
    if (!current() || loading) return;
    if (unavailable) return reload();
    void host
      .openEventEditDialog({
        workspaceId,
        eventId,
        sourceDocId: model.store.id,
      })
      .then((id) => {
        if (id && current()) reload();
      })
      .catch(console.error);
  };
  return (
    <ReferenceCard
      size="small"
      component={readonly ? "div" : "button"}
      interactive={!readonly}
      role={readonly ? "group" : undefined}
      aria-label={label}
      aria-busy={readonly ? undefined : loading}
      onClick={readonly ? undefined : activate}
      data-state={loading ? "loading" : unavailable ? "unavailable" : "ready"}
      data-testid="editor-event-card"
      title={title}
      metadata={meta}
      icon={
        loading ? (
          <Loading />
        ) : unavailable ? (
          <AlertTriangleIcon color={cssVar("errorColor")} />
        ) : (
          <Group component="span" gap="xs" wrap="nowrap">
            <CalendarClockIcon color={cssVar("iconColor")} />
            {accent && CSS.supports("color", accent) ? (
              <ColorDot color={accent} />
            ) : null}
          </Group>
        )
      }
      actions={
        !readonly && !loading ? (
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
