// SPDX-License-Identifier: AGPL-3.0-or-later
import { useServices } from "@myoxus/infra";
import type { EventBlockModel } from "@virgultum/core/models";
import { useMemo } from "react";
import { WorkspaceService } from "../../../modules/workspace";
import { WorkspaceDialogService } from "../../../modules/dialogs";
import { IntegrationService } from "../../../modules/integration";
import { workspaceEventCommands } from "./myoxus-host-adapter";
import { EventReferenceCard } from "../../view-extensions/editor-view/editor-chrome/event-card";

export default function PageEvent({
  model,
  readonly,
}: {
  model: EventBlockModel;
  readonly: boolean;
}) {
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
  const current = () =>
    !readonly &&
    !model.store.readonly &&
    model.store.getModelById(model.id) === model &&
    model.props.eventId === eventId &&
    model.props.workspaceId === workspaceId;
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
      <EventReferenceCard controls={{ model, readonly, host }} />
    </div>
  );
}
