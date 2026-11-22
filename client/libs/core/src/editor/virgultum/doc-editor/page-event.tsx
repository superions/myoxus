// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { useServices } from "@myoxus/infra";
import type { EventBlockModel } from "@virgultum/core/models";
import type { MyoxusResolvedEvent } from "@virgultum/core/services";
import { eventCardDateRange } from "@virgultum/core/services/data";
import { useEffect, useMemo, useState, useReducer } from "react";
import { WorkspaceService } from "../../../modules/workspace";
import { WorkspaceDialogService } from "../../../modules/dialogs";
import { IntegrationService } from "../../../modules/integration";
import { workspaceEventCommands } from "./myoxus-host-adapter";
import { EditorEventCard } from "../../view-extensions/editor-view/editor-chrome/event-card";

export default function PageEvent({
  model,
  readonly,
}: {
  model: EventBlockModel;
  readonly: boolean;
}) {
  const t = useI18n();
  const { workspaceService, workspaceDialogService, integrationService } =
    useServices({
      WorkspaceService,
      WorkspaceDialogService,
      IntegrationService,
    });
  const host = useMemo(
    () =>
      workspaceEventCommands({
        workspaceService,
        workspaceDialogService,
        integrationService,
      }),
    [workspaceService, workspaceDialogService, integrationService],
  );
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
    void host.resolveEventData({ workspaceId, eventId }).then((event) => {
      if (live) setResolved({ workspaceId, eventId, revision, event });
    });
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
  return (
    <div
      contentEditable={false}
      data-page-event={model.id}
      data-block-id={model.id}
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && current()) {
          e.preventDefault();
          e.stopPropagation();
          void host
            .confirmEventBlockRemoval({
              workspaceId,
              eventId,
              blockId: model.id,
            })
            .then((ok) => {
              if (ok && current()) model.store.deleteBlock(model);
            })
            .catch(console.error);
        }
      }}
    >
      <EditorEventCard
        controls={{
          state:
            event === undefined
              ? "loading"
              : event === null
                ? "unavailable"
                : "ready",
          readonly,
          title,
          meta: event
            ? eventCardDateRange(
                event,
                t.language,
                t["com.myoxus.integration.calendar.all-day"](),
              )
            : event === null
              ? t.Retry()
              : "",
          label: event
            ? `${t["com.myoxus.integration.calendar.event-edit"]()}: ${title}`
            : event === null
              ? t.Retry()
              : title,
          accent:
            event?.tagColor && CSS.supports("color", event.tagColor)
              ? event.tagColor
              : null,
          activate: () => {
            if (!current() || event === undefined) return;
            if (!event) return reload();
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
          },
        }}
      />
    </div>
  );
}
