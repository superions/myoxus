/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
// SPDX-License-Identifier: Apache-2.0
// Modified by Myoxus; see provenance.json for retained source and patches.

import { useI18n } from "@myoxus/i18n";

import { Modal, EmptyState, Alert } from "@myoxus/ui-facade";
import {
  Button,
  MyoxusTextInput,
  Stack,
  Group,
  IconButton,
} from "@myoxus/ui-facade";
import * as React from "react";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { EditIcon } from "@myoxus/icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePendingEdit } from "../../../xyflow/reactExt/PendingEdits";
import {
  type BPMN20__tDataInputAssociation,
  type BPMN20__tDataOutputAssociation,
} from "../../../schemas/bpmn-2_0/ts-gen/types";
import { CloseIcon as TimesIcon } from "@myoxus/icons/react";
import { EyeIcon } from "@myoxus/icons/react";
import { PlusIcon as PlusCircleIcon } from "@myoxus/icons/react";
import { ItemDefinitionRefSelector } from "../itemDefinitionRefSelector/ItemDefinitionRefSelector";
import { VariableSelector } from "../variableSelector/VariableSelector";
import {
  type DataMapping,
  getDataMapping,
  dataMappingTypeOwner,
  setDataMappingForElement,
  type WithDataMapping,
  type WithInputDataMapping,
  type WithOutputDataMapping,
} from "../../mutations/data-mapping";
import { useBpmnEditorI18n } from "../../i18n";
export function DataMappingFormSection({
  count,
  elementName,
  children,
  showDataMappingModal,
  setShowDataMappingModal,
}: React.PropsWithChildren<{
  count: number;
  elementName: string | undefined;
  showDataMappingModal: boolean;
  setShowDataMappingModal: React.Dispatch<React.SetStateAction<boolean>>;
}>) {
  const { i18n, locale } = useBpmnEditorI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  return (
    <>
      <Button
        prefix={isReadOnly ? <EyeIcon /> : <EditIcon />}
        onClick={() => setShowDataMappingModal(true)}
      >
        {i18n.dataMapping.title} ({new Intl.NumberFormat(locale).format(count)})
      </Button>
      <Modal
        open={showDataMappingModal}
        onOpenChange={(open) => {
          if (!open) (() => setShowDataMappingModal(false))();
        }}
        scrollable
        title={i18n.dataMapping.mappingForElement(
          elementName || i18n.undefined,
        )}
      >
        {children}
      </Modal>
    </>
  );
}
function flaggedDataInputs<
  T extends {
    name?: string;
    "@_name"?: string;
  },
>(
  element: WithDataMapping,
  array: undefined | T[],
):
  | undefined
  | {
      dataMapping: T;
      hide: boolean;
    }[] {
  return array?.map((dataInput) => ({
    dataMapping: dataInput,
    hide:
      element.loopCharacteristics?.__$$element ===
        "multiInstanceLoopCharacteristics" &&
      element.loopCharacteristics.inputDataItem?.["@_name"] ===
        (dataInput["@_name"] ?? dataInput.name),
  }));
}
function flaggedDataOutputs<
  T extends {
    name?: string;
    "@_name"?: string;
  },
>(
  element: WithDataMapping,
  array: undefined | T[],
):
  | undefined
  | {
      dataMapping: T;
      hide: boolean;
    }[] {
  return array?.map((dataOutput) => ({
    dataMapping: dataOutput,
    hide:
      element.loopCharacteristics?.__$$element ===
        "multiInstanceLoopCharacteristics" &&
      element.loopCharacteristics.outputDataItem?.["@_name"] ===
        (dataOutput["@_name"] ?? dataOutput.name),
  }));
}
export function BidirectionalDataMappingFormSection({
  element,
}: {
  element: WithDataMapping;
}) {
  const { i18n } = useBpmnEditorI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const inputCount = flaggedDataInputs(
    element,
    element.ioSpecification?.dataInput,
  )?.filter((s) => !s.hide).length;
  const outputCount = flaggedDataOutputs(
    element,
    element.ioSpecification?.dataOutput,
  )?.filter((s) => !s.hide).length;
  const [showDataMappingModal, setShowDataMappingModal] = useState(false);
  const {
    formRef,
    handleSubmit,
    commandError,
    inputDataMapping,
    outputDataMapping,
    addDataMapping,
    removeDataMapping,
    handleInputChange,
  } = useDataMapping(element, setShowDataMappingModal, showDataMappingModal);
  return (
    <DataMappingFormSection
      count={(inputCount ?? 0) + (outputCount ?? 0)}
      elementName={element["@_name"]}
      showDataMappingModal={showDataMappingModal}
      setShowDataMappingModal={setShowDataMappingModal}
    >
      <form ref={formRef} onSubmit={handleSubmit}>
        <Stack>
          {commandError && <Alert>{commandError}</Alert>}
          <Stack>
            {i18n.dataMapping.inputs}
            <DataMappingsList
              flowElement={element}
              section={"input"}
              inputDataMapping={inputDataMapping}
              outputDataMapping={undefined}
              addDataMapping={addDataMapping}
              removeDataMapping={removeDataMapping}
              handleInputChange={handleInputChange}
            />
          </Stack>
          <Stack>
            {i18n.dataMapping.outputs}
            <DataMappingsList
              flowElement={element}
              section={"output"}
              inputDataMapping={undefined}
              outputDataMapping={outputDataMapping}
              addDataMapping={addDataMapping}
              removeDataMapping={removeDataMapping}
              handleInputChange={handleInputChange}
            />
          </Stack>
          {!isReadOnly && (
            <Group>
              <Button
                variant="primary"
                type="submit"
                onMouseUp={(e) => e.currentTarget.blur()}
              >
                {i18n.dataMapping.save}
              </Button>
            </Group>
          )}
        </Stack>
      </form>
    </DataMappingFormSection>
  );
}
export function InputOnlyAssociationFormSection({
  element,
}: {
  element: WithInputDataMapping;
}) {
  const { i18n } = useBpmnEditorI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const inputCount = element.dataInput?.length ?? 0;
  const [showDataMappingModal, setShowDataMappingModal] = useState(false);
  const {
    formRef,
    handleSubmit,
    commandError,
    inputDataMapping,
    addDataMapping,
    removeDataMapping,
    handleInputChange,
  } = useDataMapping(element, setShowDataMappingModal, showDataMappingModal);
  return (
    <DataMappingFormSection
      count={inputCount}
      elementName={element["@_name"]}
      showDataMappingModal={showDataMappingModal}
      setShowDataMappingModal={setShowDataMappingModal}
    >
      <form ref={formRef} onSubmit={handleSubmit}>
        <Stack>
          {commandError && <Alert>{commandError}</Alert>}
          <Stack>
            {i18n.dataMapping.inputs}
            <DataMappingsList
              flowElement={element}
              section={"input"}
              inputDataMapping={inputDataMapping}
              outputDataMapping={undefined}
              addDataMapping={addDataMapping}
              removeDataMapping={removeDataMapping}
              handleInputChange={handleInputChange}
            />
          </Stack>
          {!isReadOnly && (
            <Group>
              <Button
                variant="primary"
                type="submit"
                onMouseUp={(e) => e.currentTarget.blur()}
              >
                {i18n.dataMapping.save}
              </Button>
            </Group>
          )}
        </Stack>
      </form>
    </DataMappingFormSection>
  );
}
export function OutputOnlyAssociationFormSection({
  element,
}: {
  element: WithOutputDataMapping;
}) {
  const { i18n } = useBpmnEditorI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const outputCount = element.dataOutput?.length ?? 0;
  const [showDataMappingModal, setShowDataMappingModal] = useState(false);
  const {
    formRef,
    handleSubmit,
    commandError,
    outputDataMapping,
    addDataMapping,
    removeDataMapping,
    handleInputChange,
  } = useDataMapping(element, setShowDataMappingModal, showDataMappingModal);
  return (
    <DataMappingFormSection
      count={outputCount}
      elementName={element["@_name"]}
      showDataMappingModal={showDataMappingModal}
      setShowDataMappingModal={setShowDataMappingModal}
    >
      <form ref={formRef} onSubmit={handleSubmit}>
        <Stack>
          {commandError && <Alert>{commandError}</Alert>}
          <Stack>
            {i18n.dataMapping.outputs}
            <DataMappingsList
              flowElement={element}
              section={"output"}
              inputDataMapping={undefined}
              outputDataMapping={outputDataMapping}
              addDataMapping={addDataMapping}
              removeDataMapping={removeDataMapping}
              handleInputChange={handleInputChange}
            />
          </Stack>
          {!isReadOnly && (
            <Group>
              <Button
                variant="primary"
                type="submit"
                onMouseUp={(e) => e.currentTarget.blur()}
              >
                {i18n.dataMapping.save}
              </Button>
            </Group>
          )}
        </Stack>
      </form>
    </DataMappingFormSection>
  );
}
export function DataMappingsList({
  flowElement,
  section,
  inputDataMapping,
  outputDataMapping,
  addDataMapping,
  removeDataMapping,
  handleInputChange,
}:
  | {
      flowElement:
        WithDataMapping | WithInputDataMapping | WithOutputDataMapping;
      section: "input";
      inputDataMapping: DataMapping[];
      outputDataMapping: undefined;
      addDataMapping: (
        section: "input" | "output",
        args: {
          isExpression: boolean;
        },
      ) => void;
      removeDataMapping: (section: "input" | "output", index: number) => void;
      handleInputChange: (
        index: number,
        propertyName: "name" | "dtype" | "value" | "variableRef" | "targetRef",
        value: string,
        section: "input" | "output",
        args: {
          isExpression: boolean;
        },
      ) => void;
    }
  | {
      flowElement:
        WithDataMapping | WithInputDataMapping | WithOutputDataMapping;
      section: "output";
      inputDataMapping: undefined;
      outputDataMapping: DataMapping[];
      addDataMapping: (
        section: "input" | "output",
        args: {
          isExpression: boolean;
        },
      ) => void;
      removeDataMapping: (section: "input" | "output", index: number) => void;
      handleInputChange: (
        index: number,
        propertyName: "name" | "dtype" | "value" | "variableRef" | "targetRef",
        value: string,
        section: "input" | "output",
        args: {
          isExpression: boolean;
        },
      ) => void;
    }) {
  const t = useI18n();
  const { i18n } = useBpmnEditorI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const referenceOwner = (row: DataMapping, direction: "input" | "output") => {
    const owner = dataMappingTypeOwner(flowElement, row, direction);
    // A newly selected draft ID has not been encoded yet. Resolve only the
    // unchanged persisted token as a QName; draft IDs already identify choices.
    return !row.typeIsSelection &&
      "@_itemSubjectRef" in owner &&
      owner["@_itemSubjectRef"] === row.dtype
      ? owner
      : undefined;
  };

  return (
    (((
      flaggedDataInputs(flowElement as any, inputDataMapping)?.filter(
        (s) => !s.hide,
      ) ?? []
    ).length > 0 ||
      (
        flaggedDataOutputs(flowElement as any, outputDataMapping)?.filter(
          (s) => !s.hide,
        ) ?? []
      ).length > 0) && (
      <>
        <Group>
          <IconButton
            disabled={isReadOnly}
            tooltip={i18n.dataMapping.addDataMapping(section)}
            onClick={() => addDataMapping(section, { isExpression: false })}
          >
            <PlusCircleIcon />
          </IconButton>
        </Group>
        {section === "input" &&
          flaggedDataInputs(flowElement as any, inputDataMapping)?.flatMap(
            ({ hide, dataMapping: entry }, i) =>
              hide ? (
                []
              ) : (
                <Stack key={entry.id ?? entry.originalIndex ?? i}>
                  <MyoxusTextInput
                    label={i18n.dataMapping.name}
                    type="text"
                    placeholder={i18n.dataMapping.namePlaceholder}
                    value={entry.name}
                    onChange={(value) =>
                      handleInputChange(i, "name", value ?? "", "input", {
                        isExpression: false,
                      })
                    }
                    disabled={isReadOnly}
                  />
                  <ItemDefinitionRefSelector
                    referenceOwner={referenceOwner(entry, "input")}
                    value={entry.dtype || undefined}
                    onChange={(reference) => {
                      handleInputChange(i, "dtype", reference ?? "", "input", {
                        isExpression: false,
                      });
                    }}
                  />
                  <VariableSelector
                    value={entry.isExpression ? entry.value : entry.variableRef}
                    allowExpressions={true}
                    onChange={(value, { isExpression }) => {
                      if (isExpression) {
                        handleInputChange(
                          i,
                          "value" as any,
                          value ?? "",
                          "input",
                          {
                            isExpression,
                          },
                        );
                      } else {
                        handleInputChange(
                          i,
                          "variableRef" as any,
                          value ?? "",
                          "input",
                          {
                            isExpression,
                          },
                        );
                      }
                    }}
                  />
                  <IconButton
                    disabled={isReadOnly}
                    variant={"plain"}
                    onClick={() => removeDataMapping("input", i)}
                    tooltip={t.Delete()}
                  >
                    <TimesIcon />
                  </IconButton>
                </Stack>
              ),
          )}
        {section === "output" &&
          flaggedDataOutputs(flowElement as any, outputDataMapping)?.flatMap(
            ({ hide, dataMapping: entry }, i) =>
              hide ? (
                []
              ) : (
                <Stack key={entry.id ?? entry.originalIndex ?? i}>
                  <MyoxusTextInput
                    label={i18n.dataMapping.name}
                    type="text"
                    placeholder={i18n.dataMapping.namePlaceholder}
                    value={entry.name}
                    onChange={(value) =>
                      handleInputChange(i, "name", value ?? "", "output", {
                        isExpression: false,
                      })
                    }
                    disabled={isReadOnly}
                  />
                  <ItemDefinitionRefSelector
                    referenceOwner={referenceOwner(entry, "output")}
                    value={entry.dtype || undefined}
                    onChange={(reference) => {
                      handleInputChange(i, "dtype", reference ?? "", "output", {
                        isExpression: false,
                      });
                    }}
                  />
                  <VariableSelector
                    value={entry.isExpression ? entry.value : entry.variableRef}
                    allowExpressions={true}
                    onChange={(value, { isExpression }) => {
                      if (isExpression) {
                        handleInputChange(
                          i,
                          "value" as any,
                          value ?? "",
                          "output",
                          {
                            isExpression,
                          },
                        );
                      } else {
                        handleInputChange(
                          i,
                          "variableRef" as any,
                          value ?? "",
                          "output",
                          {
                            isExpression,
                          },
                        );
                      }
                    }}
                  />
                  {entry.isExpression && (
                    <VariableSelector
                      label={i18n.propertiesPanel.target}
                      value={entry.targetRef}
                      allowExpressions={false}
                      onChange={(value) =>
                        handleInputChange(
                          i,
                          "targetRef",
                          value ?? "",
                          "output",
                          { isExpression: true },
                        )
                      }
                    />
                  )}
                  <IconButton
                    disabled={isReadOnly}
                    variant={"plain"}
                    onClick={() => removeDataMapping("output", i)}
                    tooltip={t.Delete()}
                  >
                    <TimesIcon />
                  </IconButton>
                </Stack>
              ),
          )}
      </>
    )) || (
      <EmptyState
        title={
          isReadOnly
            ? i18n.dataMapping.noDataMappings(section)
            : i18n.dataMapping.noDataMappingsYet(section)
        }
        description={
          !isReadOnly && (
            <Button
              variant={"secondary"}
              onClick={() =>
                addDataMapping(section, {
                  isExpression: false,
                })
              }
            >
              {i18n.dataMapping.addDataMapping(section)}
            </Button>
          )
        }
      ></EmptyState>
    )
  );
}
export function useDataMapping(
  element:
    | WithDataMapping
    | (WithInputDataMapping & {
        dataOutputAssociation?: BPMN20__tDataOutputAssociation[];
      })
    | (WithOutputDataMapping & {
        dataInputAssociation?: BPMN20__tDataInputAssociation[];
      }),
  setShowDataMappingModal: React.Dispatch<React.SetStateAction<boolean>>,
  isOpen: boolean,
) {
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const t = useI18n();
  const [inputDataMapping, setInputDataMapping] = useState<DataMapping[]>([]);
  const [outputDataMapping, setOutputDataMapping] = useState<DataMapping[]>([]);
  const [commandError, setCommandError] = useState<string>();
  const formRef = useRef<HTMLFormElement>(null);
  const invalidField = useRef<HTMLInputElement | null>(null);
  const { i18n } = useBpmnEditorI18n();
  const handleInputChange = useCallback(
    (
      index: number,
      propertyName: "name" | "dtype" | "value" | "variableRef" | "targetRef",
      value: string,
      section: "input" | "output",
      {
        isExpression: _isExpression,
      }: {
        isExpression: boolean;
      },
    ) => {
      const setRows =
        section === "input" ? setInputDataMapping : setOutputDataMapping;
      setRows((previous) =>
        previous.map((row, rowIndex) => {
          if (rowIndex !== index) return row;
          if (propertyName === "value")
            return {
              id: row.id,
              originalIndex: row.originalIndex,
              name: row.name,
              dtype: row.dtype,
              typeIsSelection: row.typeIsSelection,
              targetRef: row.isExpression ? row.targetRef : row.variableRef,
              isExpression: true,
              value,
            };
          if (propertyName === "variableRef")
            return {
              id: row.id,
              originalIndex: row.originalIndex,
              name: row.name,
              dtype: row.dtype,
              typeIsSelection: row.typeIsSelection,
              isExpression: false,
              variableRef: value || undefined,
            };
          if (propertyName === "dtype")
            return { ...row, dtype: value, typeIsSelection: true };
          return { ...row, [propertyName]: value };
        }),
      );
    },
    [],
  );
  const addDataMapping = useCallback(
    (
      section: "input" | "output",
      {
        isExpression,
      }: {
        isExpression: boolean;
      },
    ) => {
      const newDataMapping: DataMapping = isExpression
        ? {
            name: "",
            dtype: "",
            isExpression: true,
            value: "",
          }
        : {
            name: "",
            dtype: "",
            isExpression: false,
            variableRef: undefined,
          };
      if (section === "input") {
        setInputDataMapping([...inputDataMapping, newDataMapping]);
      } else {
        setOutputDataMapping([...outputDataMapping, newDataMapping]);
      }
    },
    [inputDataMapping, outputDataMapping],
  );
  const removeDataMapping = useCallback(
    (section: "input" | "output", index: number) => {
      if (section === "input") {
        setInputDataMapping(inputDataMapping.filter((_, i) => i !== index));
      } else {
        setOutputDataMapping(outputDataMapping.filter((_, i) => i !== index));
      }
    },
    [inputDataMapping, outputDataMapping],
  );

  // populates intermediary data mapping state from the model
  useEffect(() => {
    if (!element) {
      return;
    }
    const { inputDataMapping, outputDataMapping } = getDataMapping(element);
    setCommandError(undefined);
    setInputDataMapping(inputDataMapping);
    setOutputDataMapping(outputDataMapping);
  }, [element, isOpen]);
  const commit = useCallback(() => {
    setCommandError(undefined);
    invalidField.current = null;
    if (!formRef.current?.checkValidity()) {
      formRef.current?.reportValidity();
      return false;
    }
    if (bpmnEditorStoreApi.getState().settings.isReadOnly) return false;
    try {
      bpmnEditorStoreApi.setState((s) => {
        if (s.settings.isReadOnly) return;
        setDataMappingForElement({
          definitions: s.bpmn.model.definitions,
          inputDataMapping,
          outputDataMapping,
          elementId: element["@_id"],
          element: element.__$$element,
        });
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "BPMN_OUTPUT_TARGET_REQUIRED"
      ) {
        invalidField.current =
          [
            ...(formRef.current?.querySelectorAll<HTMLInputElement>("input") ??
              []),
          ].find(
            (input) =>
              input.getAttribute("aria-label") ===
                i18n.propertiesPanel.target && !input.value,
          ) ?? null;
        invalidField.current?.focus();
      }
      // The mapping form is itself modal. Provider notifications can be behind
      // its top layer; retain the causal rejection beside the unsaved rows.
      setCommandError(
        error instanceof Error &&
          error.message === "BPMN_OUTPUT_TARGET_REQUIRED"
          ? t["com.myoxus.editor.bpmn.output-target-required"]()
          : error instanceof Error &&
              error.message === "BPMN_GRAPHICAL_DATA_MAPPING"
            ? t["com.myoxus.editor.bpmn.data-route-owned"]()
            : t["com.myoxus.common.operation-failed"](),
      );
      return false;
    }
    setShowDataMappingModal(false);
    return true;
  }, [
    bpmnEditorStoreApi,
    element,
    inputDataMapping,
    outputDataMapping,
    setShowDataMappingModal,
    t,
    i18n.propertiesPanel.target,
  ]);
  const original = getDataMapping(element);
  usePendingEdit(
    isOpen &&
      JSON.stringify([inputDataMapping, outputDataMapping]) !==
        JSON.stringify([original.inputDataMapping, original.outputDataMapping]),
    {
      commit,
      discard: () => {
        setInputDataMapping(original.inputDataMapping);
        setOutputDataMapping(original.outputDataMapping);
        setShowDataMappingModal(false);
      },
      focus: () =>
        (
          invalidField.current ??
          formRef.current?.querySelector("input:invalid") ??
          (formRef.current?.querySelector(
            "input:not(:disabled)",
          ) as HTMLInputElement | null)
        )?.focus(),
    },
  );
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    commit();
  };
  return {
    formRef,
    handleSubmit,
    commandError,
    inputDataMapping,
    outputDataMapping,
    addDataMapping,
    removeDataMapping,
    handleInputChange,
  };
}
