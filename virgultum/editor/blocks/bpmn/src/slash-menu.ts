import { BpmnBlockSchema } from "@virgultum/model";
import {
  editorMessage,
  EditorI18nProvider,
  NotificationProvider,
  resolveEditorMessage,
} from "@virgultum/shared/services";
import type {
  SlashMenuConfig,
  SlashMenuContext,
} from "@virgultum/widget-slash-menu";

import { insertBpmnBlockCommand } from "./commands.js";
import { requestBpmnEditor } from "./session-request.js";

const flavour = BpmnBlockSchema.model.flavour;

export function canShowBpmnSlashItem({ model }: SlashMenuContext) {
  return (
    !model.store.readonly && model.store.schema.flavourSchemaMap.has(flavour)
  );
}

export const bpmnSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "bpmn",
      label: editorMessage("com.myoxus.editor.bpmn.slash-name", "BPMN diagram"),
      description: editorMessage(
        "com.myoxus.editor.bpmn.slash-description",
        "Insert a BPMN process diagram.",
      ),
      icon: "WorkflowIcon",
      group: "5_Edgeless Element@2",
      searchAlias: ["bpmn", "process", "workflow", "diagramm", "prozess"],
      when: canShowBpmnSlashItem,
      action: ({ std, model }) => {
        const failed = () =>
          std
            .getOptional(NotificationProvider)
            ?.toast(
              resolveEditorMessage(
                editorMessage(
                  "com.myoxus.common.operation-failed",
                  "Operation failed",
                ),
                std.getOptional(EditorI18nProvider) ?? undefined,
              ),
            );
        const [_, result] = std.command.exec(insertBpmnBlockCommand, {
          place: "after",
          removeEmptyLine: true,
          selectedModels: [model],
        });
        const blockId = result.insertedBpmnBlockId;
        if (!blockId) {
          failed();
          return;
        }
        // Insertion owns one valid XML block before opening. A dialog failure
        // never rolls that source back; the visible block's Open retries it.
        void requestBpmnEditor(std, blockId).catch(failed);
      },
    },
  ],
};
