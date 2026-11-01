// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Stack,
  Button,
  Checkbox,
  MyoxusTextInput,
  MyoxusTextarea,
  Alert,
} from "@myoxus/ui-facade";
import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import {
  createResource,
  deleteResource,
  resourceById,
  assertResourceSubtreeUnused,
} from "../../mutations/resource";
import { generateUuid } from "../../../xyflow/uuid/uuid";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
import { ItemDefinitionRefSelector } from "../itemDefinitionRefSelector/ItemDefinitionRefSelector";

/** Definitions-level resources outlive roles. Only explicit, reference-aware
 * deletion may retire a declaration or parameter; ordinary graph commands do not. */
export function ResourceDefinitions() {
  const t = useI18n(),
    store = useBpmnEditorStoreApi(),
    definitions = useBpmnEditorStore((state) => state.bpmn.model.definitions),
    readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const [commandError, setCommandError] = useState(false);
  const command = (run: (model: typeof definitions) => void) => {
    setCommandError(false);
    try {
      store.setState((state) => {
        if (!state.settings.isReadOnly) run(state.bpmn.model.definitions);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "BPMN_DEFINITION_IN_USE")
        setCommandError(true);
      else throw error;
    }
  };
  return (
    <Stack>
      {commandError && (
        <Alert>{t["com.myoxus.editor.bpmn.definition-in-use"]()}</Alert>
      )}
      <Button
        disabled={readOnly}
        onClick={() =>
          command((model) => {
            createResource(model);
          })
        }
      >
        {t.Create()}
      </Button>
      <Accordion>
        {(definitions.rootElement ?? [])
          .filter((root) => root.__$$element === "resource")
          .map((resource) => {
            const identity =
              resource["@_id"] ?? definitions.rootElement!.indexOf(resource);
            const update = (
              run: (root: typeof resource, model: typeof definitions) => void,
            ) => command((model) => run(resourceById(model, identity), model));
            return (
              <AccordionItem key={identity} value={String(identity)}>
                <AccordionControl>
                  {resource["@_name"] ||
                    resource["@_id"] ||
                    t["com.myoxus.editor.bpmn.resource"]()}
                </AccordionControl>
                <AccordionPanel>
                  <Stack>
                    <MyoxusTextInput
                      label={t["com.myoxus.common.name"]()}
                      value={resource["@_name"]}
                      disabled={readOnly}
                      onChange={(name) =>
                        update((root) => {
                          root["@_name"] = name;
                        })
                      }
                    />
                    <MyoxusTextInput
                      label={t["com.myoxus.editor.bpmn.element-id"]()}
                      value={resource["@_id"]}
                      readOnly
                    />
                    <MyoxusTextarea
                      label={t["com.myoxus.editor.bpmn.documentation"]()}
                      value={resource.documentation?.[0]?.__$$text ?? ""}
                      disabled={readOnly}
                      onChange={(text) =>
                        update((root) => {
                          if (!text && !root.documentation?.length) return;
                          root.documentation ??= [];
                          root.documentation[0] ??= { "@_id": generateUuid() };
                          root.documentation[0].__$$text = text;
                        })
                      }
                    />
                    <Accordion>
                      {resource.resourceParameter?.map(
                        (parameter, position) => {
                          const change = (
                            run: (
                              value: typeof parameter,
                              model: typeof definitions,
                            ) => void,
                          ) =>
                            update((root, model) => {
                              const value = parameter["@_id"]
                                ? root.resourceParameter?.find(
                                    (value) =>
                                      value["@_id"] === parameter["@_id"],
                                  )
                                : root.resourceParameter?.[position];
                              if (!value)
                                throw new Error("BPMN_DEFINITION_NOT_FOUND");
                              run(value, model);
                            });
                          return (
                            <AccordionItem
                              key={parameter["@_id"] ?? position}
                              value={parameter["@_id"] ?? String(position)}
                            >
                              <AccordionControl>
                                {parameter["@_name"] ||
                                  parameter["@_id"] ||
                                  t[
                                    "com.myoxus.editor.bpmn.resource-parameter"
                                  ]()}
                              </AccordionControl>
                              <AccordionPanel>
                                <Stack>
                                  <MyoxusTextInput
                                    label={t["com.myoxus.common.name"]()}
                                    disabled={readOnly}
                                    value={parameter["@_name"] ?? ""}
                                    onChange={(name) =>
                                      change((parameter) => {
                                        if (name) parameter["@_name"] = name;
                                        else delete parameter["@_name"];
                                      })
                                    }
                                  />
                                  <MyoxusTextInput
                                    label={t[
                                      "com.myoxus.editor.bpmn.element-id"
                                    ]()}
                                    value={parameter["@_id"] ?? ""}
                                    readOnly
                                  />
                                  <ItemDefinitionRefSelector
                                    referenceOwner={parameter}
                                    value={parameter["@_type"]}
                                    onChange={(id) =>
                                      change((parameter, model) => {
                                        if (id)
                                          parameter["@_type"] = indexBpmnIds(
                                            model,
                                          ).referenceFor(
                                            parameter,
                                            id,
                                            parameter["@_type"],
                                          );
                                        else delete parameter["@_type"];
                                      })
                                    }
                                  />
                                  <Checkbox
                                    label={t[
                                      "com.myoxus.page-properties.property.required"
                                    ]()}
                                    disabled={readOnly}
                                    checked={parameter["@_isRequired"] ?? false}
                                    onChange={(_event, checked) =>
                                      change((parameter) => {
                                        parameter["@_isRequired"] = checked;
                                      })
                                    }
                                  />
                                  <Button
                                    disabled={readOnly}
                                    onClick={() =>
                                      update((root, model) => {
                                        const index = parameter["@_id"]
                                          ? root.resourceParameter!.findIndex(
                                              (value) =>
                                                value["@_id"] ===
                                                parameter["@_id"],
                                            )
                                          : position;
                                        assertResourceSubtreeUnused(
                                          model,
                                          root.resourceParameter![index],
                                        );
                                        root.resourceParameter!.splice(
                                          index,
                                          1,
                                        );
                                        if (!root.resourceParameter!.length)
                                          delete root.resourceParameter;
                                      })
                                    }
                                  >
                                    {t.Delete()}
                                  </Button>
                                </Stack>
                              </AccordionPanel>
                            </AccordionItem>
                          );
                        },
                      )}
                    </Accordion>
                    <Button
                      disabled={readOnly}
                      onClick={() =>
                        update((root) => {
                          (root.resourceParameter ??= []).push({
                            "@_id": generateUuid(),
                          });
                        })
                      }
                    >
                      {t["com.myoxus.editor.bpmn.add-resource-parameter"]()}
                    </Button>
                    <Button
                      disabled={readOnly}
                      onClick={() =>
                        command((model) => deleteResource(model, identity))
                      }
                    >
                      {t.Delete()}
                    </Button>
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
            );
          })}
      </Accordion>
    </Stack>
  );
}
