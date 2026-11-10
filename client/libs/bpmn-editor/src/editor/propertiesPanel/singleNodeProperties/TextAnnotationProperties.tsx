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

import {
  MyoxusTextInput,
  MyoxusTextarea,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Stack,
} from "@myoxus/ui-facade";
import { type BPMN20__tTextAnnotation } from "../../../schemas/bpmn-2_0/ts-gen/types";
import { updateTextAnnotation } from "../../mutations/renameNode";
import { type Normalized } from "../../normalization/normalize";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { TextAnnotationIcon } from "../../diagram/nodes/NodeIcons";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
import { useBpmnEditorI18n } from "../../i18n";
export function TextAnnotationProperties({
  textAnnotation,
}: {
  textAnnotation: Normalized<BPMN20__tTextAnnotation> & {
    __$$element: "textAnnotation";
  };
}) {
  const { i18n } = useBpmnEditorI18n();
  const store = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  return (
    <Accordion defaultValue="properties">
      <AccordionItem value="properties">
        <AccordionControl icon={<TextAnnotationIcon />}>
          {i18n.singleNodeProperties.textAnnotation}
        </AccordionControl>
        <AccordionPanel keepMounted keepMountedMode="display-none">
          <Stack>
            <MyoxusTextInput
              label={i18n.singleNodeProperties.format}
              disabled={readOnly}
              value={textAnnotation["@_textFormat"] ?? ""}
              onChange={(value) =>
                store.setState((s) => {
                  if (!s.settings.isReadOnly)
                    updateTextAnnotation({
                      definitions: s.bpmn.model.definitions,
                      id: textAnnotation["@_id"],
                      newTextAnnotation: {
                        "@_textFormat": value || undefined,
                      },
                    });
                })
              }
            />
            <MyoxusTextarea
              label={i18n.singleNodeProperties.text}
              disabled={readOnly}
              value={textAnnotation.text?.__$$text ?? ""}
              onChange={(value) =>
                store.setState((s) => {
                  if (!s.settings.isReadOnly)
                    updateTextAnnotation({
                      definitions: s.bpmn.model.definitions,
                      id: textAnnotation["@_id"],
                      newTextAnnotation: {
                        text: {
                          ...textAnnotation.text,
                          __$$text: value,
                        },
                      },
                    });
                })
              }
            />
            <NameDocumentationAndId element={textAnnotation} />
          </Stack>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
