// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Stack,
  Select,
  Button,
  Checkbox,
  MyoxusNumberInput,
  MyoxusTextInput,
  MyoxusTextarea,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { useBpmnEditor } from "../../BpmnEditorContext";
import { findConnectionElement } from "../../mutations/connection";
import {
  createDataStore,
  referencedDataStore,
  setDataStoreDetails,
  setDataStoreReference,
} from "../../mutations/data-store";
import {
  setDataObjectDetails,
  setDataObjectItemType,
} from "../../mutations/data";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
import { ItemDefinitionRefSelector } from "../itemDefinitionRefSelector/ItemDefinitionRefSelector";
import { DataStoreIcon } from "../../diagram/nodes/NodeIcons";

/** The reference fields and the definitions root are separate native sections;
 * selecting a shared store is not an implicit edit of its capacity or state. */
export function DataStoreProperties({ id }: { id: string }) {
  const t = useI18n(),
    store = useBpmnEditorStoreApi(),
    definitions = useBpmnEditorStore((state) => state.bpmn.model.definitions),
    readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly),
    { onCommandError } = useBpmnEditor();
  const element = findConnectionElement(definitions, id)?.element,
    root = referencedDataStore(definitions, id);
  if (element?.__$$element !== "dataStoreReference") return null;
  const command = (run: (model: typeof definitions) => void) => {
    try {
      store.setState((state) => {
        if (!state.settings.isReadOnly) run(state.bpmn.model.definitions);
      });
    } catch (error) {
      onCommandError(error);
    }
  };
  const change = (value: Parameters<typeof setDataStoreDetails>[2]) => {
    if (root)
      command((model) => setDataStoreDetails(model, root["@_id"], value));
  };
  return (
    <Accordion defaultValue="reference">
      <AccordionItem value="reference">
        <AccordionControl icon={<DataStoreIcon />}>
          {element["@_name"] || t["com.myoxus.editor.shape.bpmn.data-store"]()}
        </AccordionControl>
        <AccordionPanel keepMounted keepMountedMode="display-none">
          <Stack>
            <NameDocumentationAndId element={element} />
            <Select
              label={t["com.myoxus.editor.bpmn.referenced-data-store"]()}
              disabled={readOnly}
              value={
                indexBpmnIds(definitions).resolveReference(
                  element,
                  element["@_dataStoreRef"],
                ) ?? ""
              }
              data={[
                { value: "", label: t["com.myoxus.editor.bpmn.undefined"]() },
                ...(definitions.rootElement ?? [])
                  .filter((root) => root.__$$element === "dataStore")
                  .map((root) => ({
                    value: root["@_id"],
                    label: `${root["@_name"] || root["@_id"]} (${root["@_id"]})`,
                  })),
              ]}
              onChange={(target) =>
                command((model) =>
                  setDataStoreReference(model, id, target || undefined),
                )
              }
            />
            <Button
              disabled={readOnly}
              onClick={() => command((model) => createDataStore(model, id))}
            >
              {t["com.myoxus.editor.bpmn.create-data-store"]()}
            </Button>
            <ItemDefinitionRefSelector
              referenceOwner={element}
              value={element["@_itemSubjectRef"]}
              onChange={(target) =>
                command((model) => setDataObjectItemType(model, id, target))
              }
            />
            <MyoxusTextInput
              label={t["com.myoxus.editor.bpmn.data-state"]()}
              disabled={readOnly}
              value={element.dataState?.["@_name"] ?? ""}
              onChange={(state) =>
                command((model) => setDataObjectDetails(model, id, { state }))
              }
            />
          </Stack>
        </AccordionPanel>
      </AccordionItem>
      {root?.__$$element === "dataStore" && (
        <AccordionItem value="root">
          <AccordionControl>
            {t["com.myoxus.editor.bpmn.referenced-data-store"]()}
          </AccordionControl>
          <AccordionPanel keepMounted keepMountedMode="display-none">
            <Stack>
              <MyoxusTextInput
                label={t["com.myoxus.common.name"]()}
                disabled={readOnly}
                value={root["@_name"] ?? ""}
                onChange={(name) => change({ name })}
              />
              <MyoxusTextarea
                label={t["com.myoxus.editor.bpmn.documentation"]()}
                disabled={readOnly}
                value={root.documentation?.[0]?.__$$text ?? ""}
                onChange={(documentation) => change({ documentation })}
              />
              <MyoxusTextInput
                label={t["com.myoxus.editor.bpmn.element-id"]()}
                readOnly
                value={root["@_id"]}
              />
              <ItemDefinitionRefSelector
                referenceOwner={root}
                value={root["@_itemSubjectRef"]}
                onChange={(itemId) => change({ itemId: itemId ?? null })}
              />
              <Checkbox
                label={t["com.myoxus.editor.bpmn.store-unlimited"]()}
                checked={root["@_isUnlimited"] ?? true}
                disabled={readOnly}
                onChange={(_event, unlimited) => change({ unlimited })}
              />
              <MyoxusNumberInput
                label={t["com.myoxus.editor.bpmn.store-capacity"]()}
                value={root["@_capacity"] ?? ""}
                disabled={readOnly || (root["@_isUnlimited"] ?? true)}
                min={0}
                allowDecimal={false}
                onChange={(capacity) => {
                  if (capacity === "" || typeof capacity === "number")
                    change({ capacity });
                }}
              />
              <MyoxusTextInput
                label={t["com.myoxus.editor.bpmn.data-state"]()}
                disabled={readOnly}
                value={root.dataState?.["@_name"] ?? ""}
                onChange={(state) => change({ state })}
              />
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      )}
    </Accordion>
  );
}
