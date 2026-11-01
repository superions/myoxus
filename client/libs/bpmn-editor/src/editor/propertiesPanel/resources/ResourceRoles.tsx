/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Modified by Myoxus; retained Apache KIE source and changes are recorded in provenance.json.

// SPDX-License-Identifier: Apache-2.0
// Resource-role controls extracted from the retained TaskProperties owner.

import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Button,
  Select,
  Stack,
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
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
import { generateUuid } from "../../../xyflow/uuid/uuid";
import {
  resourceRoleOwner,
  changeResourceRoles,
  setRoleResource,
  assertResourceSubtreeUnused,
  type ResourceRole,
} from "../../mutations/resource";

/** One schema-backed field owner for process, activities and callable tasks.
 * Mutations re-resolve the owner and role by identity; optional imported IDs
 * fall back to current synchronous positions without manufacturing IDs on read. */
export function ResourceRoles({ ownerId }: { ownerId: string }) {
  const t = useI18n(),
    store = useBpmnEditorStoreApi(),
    definitions = useBpmnEditorStore((state) => state.bpmn.model.definitions),
    readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const [commandError, setCommandError] = useState(false);
  const owner = resourceRoleOwner(definitions, ownerId),
    references = indexBpmnIds(definitions),
    resources = (definitions.rootElement ?? [])
      .filter((root) => root.__$$element === "resource")
      .filter((root) => root["@_id"]);
  if (!owner) return null;
  const kinds = [
    {
      value: "resourceRole",
      label: t["com.myoxus.editor.bpmn.resource-role"](),
    },
    { value: "performer", label: t["com.myoxus.editor.bpmn.performer"]() },
    {
      value: "humanPerformer",
      label: t["com.myoxus.editor.bpmn.human-performer"](),
    },
    { value: "potentialOwner", label: t["com.myoxus.editor.bpmn.actors"]() },
  ];
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
    <AccordionItem value="resources">
      <AccordionControl>
        {t["com.myoxus.editor.bpmn.resource-roles"]()}
      </AccordionControl>
      <AccordionPanel>
        <Stack>
          {commandError && (
            <Alert>{t["com.myoxus.editor.bpmn.definition-in-use"]()}</Alert>
          )}
          {(owner.resourceRole ?? []).map((role, position) => {
            const resourceId = references.resolveReference(
                role.resourceRef ?? role,
                role.resourceRef?.__$$text,
              ),
              current = role.resourceRef?.__$$text;
            const options = resources.map((root) => ({
              value: `resource:${root["@_id"]}`,
              label: `${root["@_name"] || root["@_id"]} (${root["@_id"]})`,
            }));
            if (current && !resourceId)
              options.push({ value: `lexical:${current}`, label: current });
            const parameters =
              resources.find((root) => root["@_id"] === resourceId)
                ?.resourceParameter ?? [];
            const update = (
              run: (role: ResourceRole, model: typeof definitions) => void,
            ) =>
              command((model) =>
                changeResourceRoles(model, ownerId, (roles) => {
                  const value = role["@_id"]
                    ? roles.find((value) => value["@_id"] === role["@_id"])
                    : roles[position];
                  if (!value) throw new Error("BPMN_DEFINITION_NOT_FOUND");
                  run(value, model);
                }),
              );
            return (
              <Accordion key={role["@_id"] ?? position}>
                <AccordionItem value={role["@_id"] ?? String(position)}>
                  <AccordionControl>
                    {role["@_name"] ||
                      kinds.find(
                        (kind) =>
                          kind.value === (role.__$$element ?? "resourceRole"),
                      )?.label}
                  </AccordionControl>
                  <AccordionPanel>
                    <Stack>
                      <Select
                        label={t["com.myoxus.editor.bpmn.resource-role"]()}
                        data={kinds}
                        value={role.__$$element ?? "resourceRole"}
                        disabled={readOnly}
                        onChange={(value) => {
                          if (kinds.some((kind) => kind.value === value))
                            update((role) => {
                              if (value === "resourceRole")
                                delete role.__$$element;
                              else
                                role.__$$element =
                                  value as ResourceRole["__$$element"];
                            });
                        }}
                      />
                      <MyoxusTextInput
                        label={t["com.myoxus.common.name"]()}
                        value={role["@_name"] ?? ""}
                        disabled={readOnly}
                        onChange={(value) =>
                          update((role) => {
                            if (value) role["@_name"] = value;
                            else delete role["@_name"];
                          })
                        }
                      />
                      <MyoxusTextInput
                        label={t["com.myoxus.editor.bpmn.element-id"]()}
                        value={role["@_id"] ?? ""}
                        readOnly
                      />
                      <Select
                        label={t["com.myoxus.editor.bpmn.resource"]()}
                        data={options}
                        value={
                          resourceId
                            ? `resource:${resourceId}`
                            : current
                              ? `lexical:${current}`
                              : null
                        }
                        clearable
                        clearButtonProps={{
                          "aria-label":
                            t["com.myoxus.common.clear-selection"](),
                        }}
                        disabled={readOnly}
                        onClear={() =>
                          update((role, model) => setRoleResource(model, role))
                        }
                        onChange={(value) => {
                          if (value?.startsWith("resource:"))
                            update((role, model) =>
                              setRoleResource(
                                model,
                                role,
                                value.slice("resource:".length),
                              ),
                            );
                        }}
                      />
                      <MyoxusTextarea
                        label={t["com.myoxus.editor.bpmn.expression"]()}
                        value={
                          role.resourceAssignmentExpression?.expression
                            .__$$text ?? ""
                        }
                        disabled={readOnly}
                        onChange={(text) =>
                          update((role) => {
                            role.resourceAssignmentExpression ??= {
                              "@_id": generateUuid(),
                              expression: {
                                "@_id": generateUuid(),
                                __$$element: "formalExpression",
                                __$$text: "",
                              },
                            };
                            role.resourceAssignmentExpression.expression.__$$text =
                              text;
                          })
                        }
                      />
                      <MyoxusTextInput
                        label={t[
                          "com.myoxus.editor.bpmn.expression-language"
                        ]()}
                        value={
                          role.resourceAssignmentExpression?.expression
                            .__$$element === "formalExpression"
                            ? (role.resourceAssignmentExpression.expression[
                                "@_language"
                              ] ?? "")
                            : ""
                        }
                        disabled={readOnly}
                        onChange={(value) =>
                          update((role) => {
                            role.resourceAssignmentExpression ??= {
                              "@_id": generateUuid(),
                              expression: {
                                "@_id": generateUuid(),
                                __$$element: "formalExpression",
                                __$$text: "",
                              },
                            };
                            role.resourceAssignmentExpression.expression = {
                              ...role.resourceAssignmentExpression.expression,
                              __$$element: "formalExpression",
                              "@_language": value || undefined,
                            };
                            if (!value)
                              delete role.resourceAssignmentExpression
                                .expression["@_language"];
                          })
                        }
                      />
                      <Accordion>
                        {role.resourceParameterBinding?.map(
                          (binding, bindingPosition) => {
                            const parameterId = references.resolveReference(
                                binding,
                                binding["@_parameterRef"],
                              ),
                              choices = parameters
                                .filter(
                                  (parameter) =>
                                    parameter["@_id"] &&
                                    !role.resourceParameterBinding?.some(
                                      (other) =>
                                        other !== binding &&
                                        references.resolveReference(
                                          other,
                                          other["@_parameterRef"],
                                        ) === parameter["@_id"],
                                    ),
                                )
                                .map((parameter) => ({
                                  value: parameter["@_id"]!,
                                  label: `${parameter["@_name"] || parameter["@_id"]} (${parameter["@_id"]})`,
                                }));
                            if (
                              !choices.some(
                                (choice) => choice.value === parameterId,
                              )
                            )
                              choices.push({
                                value: `lexical:${binding["@_parameterRef"]}`,
                                label: binding["@_parameterRef"],
                              });
                            const change = (
                              run: (
                                value: typeof binding,
                                model: typeof definitions,
                              ) => void,
                            ) =>
                              update((role, model) => {
                                const value = binding["@_id"]
                                  ? role.resourceParameterBinding?.find(
                                      (value) =>
                                        value["@_id"] === binding["@_id"],
                                    )
                                  : role.resourceParameterBinding?.[
                                      bindingPosition
                                    ];
                                if (!value)
                                  throw new Error("BPMN_DEFINITION_NOT_FOUND");
                                run(value, model);
                              });
                            return (
                              <AccordionItem
                                key={binding["@_id"] ?? bindingPosition}
                                value={
                                  binding["@_id"] ?? String(bindingPosition)
                                }
                              >
                                <AccordionControl>
                                  {parameters.find(
                                    (parameter) =>
                                      parameter["@_id"] === parameterId,
                                  )?.["@_name"] || binding["@_parameterRef"]}
                                </AccordionControl>
                                <AccordionPanel>
                                  <Stack>
                                    <Select
                                      label={t[
                                        "com.myoxus.editor.bpmn.resource-parameter"
                                      ]()}
                                      data={choices}
                                      value={
                                        choices.some(
                                          (choice) =>
                                            choice.value === parameterId,
                                        )
                                          ? parameterId
                                          : `lexical:${binding["@_parameterRef"]}`
                                      }
                                      disabled={readOnly}
                                      onChange={(id) => {
                                        if (id && !id.startsWith("lexical:"))
                                          change((binding, model) => {
                                            binding["@_parameterRef"] =
                                              indexBpmnIds(model).referenceFor(
                                                binding,
                                                id,
                                                binding["@_parameterRef"],
                                              )!;
                                          });
                                      }}
                                    />
                                    <MyoxusTextarea
                                      label={t[
                                        "com.myoxus.editor.bpmn.expression"
                                      ]()}
                                      value={binding.expression.__$$text ?? ""}
                                      disabled={readOnly}
                                      onChange={(text) =>
                                        change((binding) => {
                                          binding.expression.__$$text = text;
                                        })
                                      }
                                    />
                                    <MyoxusTextInput
                                      label={t[
                                        "com.myoxus.editor.bpmn.expression-language"
                                      ]()}
                                      value={
                                        binding.expression.__$$element ===
                                        "formalExpression"
                                          ? (binding.expression["@_language"] ??
                                            "")
                                          : ""
                                      }
                                      disabled={readOnly}
                                      onChange={(value) =>
                                        change((binding) => {
                                          binding.expression = {
                                            ...binding.expression,
                                            __$$element: "formalExpression",
                                            "@_language": value || undefined,
                                          };
                                          if (!value)
                                            delete binding.expression[
                                              "@_language"
                                            ];
                                        })
                                      }
                                    />
                                    <Button
                                      disabled={readOnly}
                                      onClick={() =>
                                        update((role, model) => {
                                          const index = binding["@_id"]
                                            ? role.resourceParameterBinding!.findIndex(
                                                (value) =>
                                                  value["@_id"] ===
                                                  binding["@_id"],
                                              )
                                            : bindingPosition;
                                          assertResourceSubtreeUnused(
                                            model,
                                            role.resourceParameterBinding![
                                              index
                                            ],
                                          );
                                          role.resourceParameterBinding!.splice(
                                            index,
                                            1,
                                          );
                                          if (
                                            !role.resourceParameterBinding!
                                              .length
                                          )
                                            delete role.resourceParameterBinding;
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
                        disabled={
                          readOnly ||
                          !parameters.some(
                            (parameter) =>
                              parameter["@_id"] &&
                              !role.resourceParameterBinding?.some(
                                (binding) =>
                                  references.resolveReference(
                                    binding,
                                    binding["@_parameterRef"],
                                  ) === parameter["@_id"],
                              ),
                          )
                        }
                        onClick={() =>
                          update((role, model) => {
                            const index = indexBpmnIds(model),
                              resourceId = index.resolveReference(
                                role.resourceRef ?? role,
                                role.resourceRef?.__$$text,
                              ),
                              root = model.rootElement?.find(
                                (root) =>
                                  root.__$$element === "resource" &&
                                  root["@_id"] === resourceId,
                              );
                            if (root?.__$$element !== "resource")
                              throw new Error("BPMN_DEFINITION_NOT_FOUND");
                            const parameter = root.resourceParameter?.find(
                              (parameter) =>
                                parameter["@_id"] &&
                                !role.resourceParameterBinding?.some(
                                  (binding) =>
                                    index.resolveReference(
                                      binding,
                                      binding["@_parameterRef"],
                                    ) === parameter["@_id"],
                                ),
                            );
                            if (!parameter?.["@_id"])
                              throw new Error("BPMN_DEFINITION_NOT_FOUND");
                            const binding = {
                              "@_id": generateUuid(),
                              "@_parameterRef": "",
                              expression: {
                                "@_id": generateUuid(),
                                __$$element: "formalExpression" as const,
                                __$$text: "",
                              },
                            };
                            binding["@_parameterRef"] = index.referenceFor(
                              role,
                              parameter["@_id"],
                            )!;
                            (role.resourceParameterBinding ??= []).push(
                              binding,
                            );
                          })
                        }
                      >
                        {t["com.myoxus.editor.bpmn.add-resource-binding"]()}
                      </Button>
                      <Button
                        disabled={readOnly}
                        onClick={() =>
                          command((model) =>
                            changeResourceRoles(model, ownerId, (roles) => {
                              const index = role["@_id"]
                                ? roles.findIndex(
                                    (value) => value["@_id"] === role["@_id"],
                                  )
                                : position;
                              if (index < 0)
                                throw new Error("BPMN_DEFINITION_NOT_FOUND");
                              assertResourceSubtreeUnused(model, roles[index]);
                              roles.splice(index, 1);
                            }),
                          )
                        }
                      >
                        {t.Delete()}
                      </Button>
                    </Stack>
                  </AccordionPanel>
                </AccordionItem>
              </Accordion>
            );
          })}
          <Button
            disabled={readOnly}
            onClick={() =>
              command((model) =>
                changeResourceRoles(model, ownerId, (roles) => {
                  roles.push({ "@_id": generateUuid() });
                }),
              )
            }
          >
            {t.Create()}
          </Button>
        </Stack>
      </AccordionPanel>
    </AccordionItem>
  );
}
