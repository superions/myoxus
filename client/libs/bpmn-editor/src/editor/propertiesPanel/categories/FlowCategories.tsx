// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { MultiSelect, notify } from "@myoxus/ui-facade";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import {
  flowCategoryOwner,
  flowCategoryChoices,
  setFlowCategories,
} from "../../mutations/group";
import { useBpmnEditorI18n } from "../../i18n";

/** One standard FlowElement field shared by node and sequence-flow inspectors;
 * shared category values remain owned by the retained category/group commands. */
export function FlowCategories({ id }: { id: string }) {
  const t = useI18n(),
    { i18n } = useBpmnEditorI18n();
  const store = useBpmnEditorStoreApi();
  const definitions = useBpmnEditorStore((s) => s.bpmn.model.definitions);
  const readOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const owner = flowCategoryOwner(definitions, id);
  if (!owner) return null;
  const choices = flowCategoryChoices(definitions, owner);
  return (
    <MultiSelect
      label={t["com.myoxus.editor.bpmn.category-values"]()}
      data={choices.options}
      value={choices.selected}
      disabled={readOnly}
      searchable
      nothingFoundMessage={i18n.propertiesPanel.noMatches}
      onChange={(values) => {
        try {
          store.setState((s) => {
            if (!s.settings.isReadOnly)
              setFlowCategories(s.bpmn.model.definitions, id, values);
          });
        } catch {
          notify.error(t["com.myoxus.common.operation-failed"]());
        }
      }}
    />
  );
}
