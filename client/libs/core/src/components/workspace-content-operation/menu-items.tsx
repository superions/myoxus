// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import {
  type WorkspaceContentOperationSelection,
  WorkspaceContentOperationService,
} from "@myoxus/core/modules/workspace-content-operation";
import {
  WorkspaceContentOperationKindType,
  WorkspaceContentResourceKindType,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  CopyIcon,
  FolderOpenIcon,
  LinkIcon,
  MoveToIcon,
} from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { IconButton, Menu, MenuItem, MenuSeparator } from "@myoxus/ui-facade";
import { useCallback, useEffect } from "react";

function containsCollection(selection: WorkspaceContentOperationSelection) {
  return (
    selection.type === "resources" &&
    selection.resources.some(
      (resource) =>
        resource.kind === WorkspaceContentResourceKindType.Collection,
    )
  );
}

export function WorkspaceContentOperationMenuItems({
  selection,
  withSeparator = true,
}: {
  selection: WorkspaceContentOperationSelection;
  withSeparator?: boolean;
}) {
  const t = useI18n();
  const { workspaceContentOperationService, workspaceDialogService } =
    useServices({
      WorkspaceContentOperationService,
      WorkspaceDialogService,
    });
  const availability = useLiveData(
    workspaceContentOperationService.availability$,
  );

  useEffect(() => {
    void workspaceContentOperationService.refreshAvailability();
  }, [workspaceContentOperationService]);

  const open = useCallback(
    (kind: WorkspaceContentOperationKindType) => {
      workspaceDialogService.open("workspace-content-operation", {
        kind,
        selection,
      });
    },
    [selection, workspaceDialogService],
  );

  if (availability.status !== "available" || containsCollection(selection))
    return null;

  const hasTarget = availability.targets.length > 0;
  const canMove =
    workspaceContentOperationService.canStart(
      WorkspaceContentOperationKindType.Move,
    ) && hasTarget;
  const canCopy =
    hasTarget &&
    workspaceContentOperationService.canStart(
      WorkspaceContentOperationKindType.Copy,
    );
  const canLink =
    hasTarget &&
    selection.type === "resources" &&
    selection.resources.length === 1 &&
    workspaceContentOperationService.canStart(
      WorkspaceContentOperationKindType.Link,
    );
  const canExtract =
    selection.type === "folder" &&
    workspaceContentOperationService.canStart(
      WorkspaceContentOperationKindType.ExtractFolder,
    );

  if (!canMove && !canCopy && !canLink && !canExtract) return null;

  return (
    <>
      {withSeparator ? (
        <MenuSeparator key="workspace-content-separator" />
      ) : null}
      {canMove ? (
        <MenuItem
          data-testid="workspace-content-operation-move"
          key={WorkspaceContentOperationKindType.Move}
          prefixIcon={<MoveToIcon />}
          onClick={() => open(WorkspaceContentOperationKindType.Move)}
        >
          {t["com.myoxus.workspace-content-operation.action.move"]()}
        </MenuItem>
      ) : null}
      {canCopy ? (
        <MenuItem
          data-testid="workspace-content-operation-copy"
          key={WorkspaceContentOperationKindType.Copy}
          prefixIcon={<CopyIcon />}
          onClick={() => open(WorkspaceContentOperationKindType.Copy)}
        >
          {t["com.myoxus.workspace-content-operation.action.copy"]()}
        </MenuItem>
      ) : null}
      {canLink ? (
        <MenuItem
          data-testid="workspace-content-operation-link"
          key={WorkspaceContentOperationKindType.Link}
          prefixIcon={<LinkIcon />}
          onClick={() => open(WorkspaceContentOperationKindType.Link)}
        >
          {t["com.myoxus.workspace-content-operation.action.link"]()}
        </MenuItem>
      ) : null}
      {canExtract ? (
        <MenuItem
          data-testid="workspace-content-operation-extract"
          key={WorkspaceContentOperationKindType.ExtractFolder}
          prefixIcon={<FolderOpenIcon />}
          onClick={() => open(WorkspaceContentOperationKindType.ExtractFolder)}
        >
          {t["com.myoxus.workspace-content-operation.action.extract"]()}
        </MenuItem>
      ) : null}
    </>
  );
}

export function WorkspaceContentOperationSelectionMenu({
  selection,
}: {
  selection: WorkspaceContentOperationSelection;
}) {
  const t = useI18n();
  const workspaceContentOperationService = useServices({
    WorkspaceContentOperationService,
  }).workspaceContentOperationService;
  const availability = useLiveData(
    workspaceContentOperationService.availability$,
  );

  useEffect(() => {
    void workspaceContentOperationService.refreshAvailability();
  }, [workspaceContentOperationService]);

  const hasCommand =
    !containsCollection(selection) &&
    availability.status === "available" &&
    availability.targets.length > 0 &&
    [
      WorkspaceContentOperationKindType.Move,
      WorkspaceContentOperationKindType.Copy,
      ...(selection.type === "resources" && selection.resources.length === 1
        ? [WorkspaceContentOperationKindType.Link]
        : []),
    ].some((kind) => workspaceContentOperationService.canStart(kind));

  if (!hasCommand) return null;

  return (
    <Menu
      items={
        <WorkspaceContentOperationMenuItems
          selection={selection}
          withSeparator={false}
        />
      }
    >
      <IconButton
        aria-label={t[
          "com.myoxus.workspace-content-operation.selection-menu"
        ]()}
        icon={<MoveToIcon />}
      />
    </Menu>
  );
}
