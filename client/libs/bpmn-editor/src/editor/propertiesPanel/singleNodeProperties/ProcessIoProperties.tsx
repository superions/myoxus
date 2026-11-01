// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Stack,
  Checkbox,
  Text,
  MyoxusTextInput,
  MyoxusTextarea,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { useBpmnEditor } from "../../BpmnEditorContext";
import { addOrGetProcessAndDiagramElements } from "../../mutations/addOrGetProcessAndDiagramElements";
import { findProcessIoItem } from "../../mutations/process-io-context";
import { setProcessIoDetails } from "../../mutations/process-io";
import { ItemDefinitionRefSelector } from "../itemDefinitionRefSelector/ItemDefinitionRefSelector";
import { DataObjectIcon } from "../../diagram/nodes/NodeIcons";

/** These fields mutate the process interface item, never a flow-element copy.
 * Bracketed state is notation; the name field and inline rename edit only name. */
export function ProcessIoProperties({ id }: { id: string }) {
  const t = useI18n(),
    store = useBpmnEditorStoreApi(),
    definitions = useBpmnEditorStore((state) => state.bpmn.model.definitions),
    readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly),
    { onCommandError } = useBpmnEditor();
  const location = findProcessIoItem(
    addOrGetProcessAndDiagramElements({ definitions }).process,
    id,
  );
  if (!location) return null;
  const item = location.element,
    change = (details: Parameters<typeof setProcessIoDetails>[2]) => {
      try {
        store.setState((state) => {
          if (!state.settings.isReadOnly)
            setProcessIoDetails(state.bpmn.model.definitions, id, details);
        });
      } catch (error) {
        onCommandError(error);
      }
    };
  return (
    <Accordion defaultValue="properties">
      <AccordionItem value="properties">
        <AccordionControl icon={<DataObjectIcon />}>
          {item["@_name"] ||
            (location.kind === "dataInput"
              ? t["com.myoxus.editor.bpmn.data-input"]()
              : t["com.myoxus.editor.bpmn.data-output"]())}
        </AccordionControl>
        <AccordionPanel>
          <Stack>
            <MyoxusTextInput
              label={t["com.myoxus.common.name"]()}
              value={item["@_name"] ?? ""}
              disabled={readOnly}
              onChange={(name) => change({ name })}
            />
            <MyoxusTextarea
              label={t["com.myoxus.editor.bpmn.documentation"]()}
              value={item.documentation?.[0]?.__$$text ?? ""}
              disabled={readOnly}
              onChange={(documentation) => change({ documentation })}
            />
            <MyoxusTextInput
              label={t["com.myoxus.editor.bpmn.element-id"]()}
              value={id}
              readOnly
            />
            <ItemDefinitionRefSelector
              referenceOwner={item}
              value={item["@_itemSubjectRef"]}
              onChange={(itemId) => change({ itemId: itemId ?? null })}
            />
            <Checkbox
              label={t["com.myoxus.editor.bpmn.data-collection"]()}
              checked={item["@_isCollection"] ?? false}
              disabled={readOnly || !!item["@_itemSubjectRef"]}
              onChange={(_event, collection) => change({ collection })}
            />
            {item["@_itemSubjectRef"] && (
              <Text>
                {t["com.myoxus.editor.bpmn.data-collection-from-type"]()}
              </Text>
            )}
            <MyoxusTextInput
              label={t["com.myoxus.editor.bpmn.data-state"]()}
              value={item.dataState?.["@_name"] ?? ""}
              disabled={readOnly}
              onChange={(state) => change({ state })}
            />
          </Stack>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
