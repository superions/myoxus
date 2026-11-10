// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import { useLiveData, useService } from "@myoxus/infra";
import {
  type ComponentType,
  lazy,
  type LazyExoticComponent,
  Suspense,
} from "react";

type WorkspaceDialogComponent = ComponentType<any>;

const WORKSPACE_DIALOGS = {
  "task-card-create": lazy(async () => ({
    default: (await import("../../modules/database/tasks/task-card-create"))
      .TaskCardCreate,
  })),
  // Only an active open request crosses this boundary. Source/preview consumers
  // stay on their non-UI subpaths; bundler CSS grouping must retain it as well.
  "bpmn-editor": lazy(async () => ({
    default: (await import("../../modules/bpmn-editor/dialog"))
      .BpmnEditorDialog,
  })),
  "template-inputs": lazy(async () => {
    const { TemplateInputDialog } =
      await import("../../modules/template-doc/view/template-input-dialog");
    return { default: TemplateInputDialog };
  }),
  "task-reference-insert": lazy(async () => {
    const { TaskReferencePicker } =
      await import("../../modules/database/tasks/task-reference-picker");
    return { default: TaskReferencePicker };
  }),
  "task-capture": lazy(async () => {
    const { TaskCaptureDialog } =
      await import("../../modules/database/tasks/task-capture-dialog");
    return { default: TaskCaptureDialog };
  }),
  "doc-info": lazy(async () => {
    const { DocInfoDialog } = await import("./doc-info");
    return { default: DocInfoDialog };
  }),
  "collection-editor": lazy(async () => {
    const { CollectionEditorDialog } = await import("./collection-editor");
    return { default: CollectionEditorDialog };
  }),
  "tag-selector": lazy(async () => {
    const { TagSelectorDialog } = await import("./selectors/tag");
    return { default: TagSelectorDialog };
  }),
  "doc-selector": lazy(async () => {
    const { DocSelectorDialog } = await import("./selectors/doc");
    return { default: DocSelectorDialog };
  }),
  "collection-selector": lazy(async () => {
    const { CollectionSelectorDialog } = await import("./selectors/collection");
    return { default: CollectionSelectorDialog };
  }),
  "database-selector": lazy(async () => {
    const { DatabaseSelectorDialog } = await import("./selectors/database");
    return { default: DatabaseSelectorDialog };
  }),
  "date-selector": lazy(async () => {
    const { DateSelectorDialog } = await import("./selectors/date");
    return { default: DateSelectorDialog };
  }),
  "user-settings": lazy(async () => {
    const { UserSettingDialog } =
      await import("./setting/user-settings-dialog");
    return { default: UserSettingDialog };
  }),
  "workspace-settings": lazy(async () => {
    const { WorkspaceSettingDialog } =
      await import("./setting/workspace-settings-dialog");
    return { default: WorkspaceSettingDialog };
  }),
  import: lazy(async () => {
    const { ImportDialog } = await import("./import");
    return { default: ImportDialog };
  }),
  "event-edit": lazy(async () => {
    const { EventEditDialog } = await import("./calendar/event-edit-dialog");
    return { default: EventEditDialog };
  }),
  "event-block-remove": lazy(async () => {
    const { EventBlockRemoveDialog } =
      await import("./calendar/event-block-remove-dialog");
    return { default: EventBlockRemoveDialog };
  }),
  "pdf-export": lazy(async () => {
    const { PdfExportDialog } =
      await import("../../modules/pdf-export/export-dialog");
    return { default: PdfExportDialog };
  }),
  "pdf-export-edgeless-preflight": lazy(async () => {
    const { EdgelessPreflightDialog } =
      await import("../../modules/pdf-export/edgeless-preflight-dialog");
    return { default: EdgelessPreflightDialog };
  }),
  "workspace-content-operation": lazy(async () => {
    const { WorkspaceContentOperationDialog } =
      await import("../../components/workspace-content-operation/dialog");
    return { default: WorkspaceContentOperationDialog };
  }),
} satisfies Partial<
  Record<keyof WORKSPACE_DIALOG_SCHEMA, LazyExoticComponent<ComponentType<any>>>
>;

/**
 * Renders workspace-scoped dialogs through per-dialog chunks. Closed settings,
 * import, selector and export surfaces add no code to the workspace route.
 */
export const WorkspaceDialogs = () => {
  const workspaceDialogService = useService(WorkspaceDialogService);
  const dialogs = useLiveData(workspaceDialogService.dialogs$);

  return (
    <>
      {dialogs.map((dialog) => {
        const DialogComponent = WORKSPACE_DIALOGS[
          dialog.type as keyof typeof WORKSPACE_DIALOGS
        ] as WorkspaceDialogComponent | undefined;
        if (!DialogComponent) {
          return null;
        }

        return (
          <Suspense key={dialog.id} fallback={null}>
            <DialogComponent
              {...(dialog.props as any)}
              close={(result?: unknown) => {
                workspaceDialogService.close(dialog.id, result);
              }}
            />
          </Suspense>
        );
      })}
    </>
  );
};
