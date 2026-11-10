// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Stack,
  Button,
  MyoxusTextInput,
  MyoxusTextarea,
  MultiSelect,
  Select,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { useContext } from "react";
import { TechnicalPropertiesContext } from "../nameDocumentationAndId/NameDocumentationAndId";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { useBpmnEditor } from "../../BpmnEditorContext";
import {
  dataAssociationById,
  setDataAssociationTransformation,
  setDataAssociationDocumentation,
  addDataAssignment,
  editDataAssignment,
  removeDataAssignment,
  reverseDataAssociation,
  setDataAssociationSources,
  setDataAssociationTarget,
} from "../../mutations/data-association";
import {
  dataAssociationSourceItems,
  dataAssociationTargetItems,
} from "../../mutations/data-association-context";

export function DataAssociationProperties({
  id,
  primaryOnly = false,
}: {
  id: string;
  primaryOnly?: boolean;
}) {
  const technicalOnly = useContext(TechnicalPropertiesContext);
  const t = useI18n(),
    store = useBpmnEditorStoreApi(),
    definitions = useBpmnEditorStore((state) => state.bpmn.model.definitions),
    readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly),
    { onCommandError } = useBpmnEditor();
  const location = dataAssociationById(definitions, id);
  if (!location) return null;
  const association = location.association,
    targets = dataAssociationTargetItems(location),
    command = (run: (model: typeof definitions) => void) => {
      try {
        store.setState((state) => {
          if (!state.settings.isReadOnly) run(state.bpmn.model.definitions);
        });
      } catch (error) {
        onCommandError(error);
      }
    };
  const primary = (
    <MyoxusTextarea
      label={t["com.myoxus.editor.bpmn.documentation"]()}
      value={association.documentation?.[0]?.__$$text ?? ""}
      disabled={readOnly}
      onChange={(text) =>
        command((model) => setDataAssociationDocumentation(model, id, text))
      }
    />
  );
  if (primaryOnly) return primary;
  return (
    <Stack>
      {!technicalOnly && primary}
      <MyoxusTextInput
        label={t["com.myoxus.editor.bpmn.element-id"]()}
        value={id}
        readOnly
      />
      <MultiSelect
        label={t["com.myoxus.editor.bpmn.semantic-source"]()}
        data={dataAssociationSourceItems(location).map((item) => ({
          value: item.id,
          label: `${item.name} (${item.id})`,
        }))}
        value={association.sourceRef?.map((ref) => ref.__$$text.trim()) ?? []}
        disabled={readOnly}
        onChange={(values) =>
          command((model) => setDataAssociationSources(model, id, values))
        }
      />
      {targets.length > 1 ? (
        <Select
          label={t["com.myoxus.editor.bpmn.semantic-target"]()}
          data={targets.map((item) => ({
            value: item.id,
            label: `${item.name} (${item.id})`,
          }))}
          value={association.targetRef.__$$text.trim()}
          disabled={readOnly}
          onChange={(value) => {
            if (value)
              command((model) => setDataAssociationTarget(model, id, value));
          }}
        />
      ) : (
        <MyoxusTextInput
          label={t["com.myoxus.editor.bpmn.semantic-target"]()}
          value={association.targetRef?.__$$text ?? ""}
          readOnly
        />
      )}
      <Button
        disabled={readOnly}
        onClick={() => command((model) => reverseDataAssociation(model, id))}
      >
        {t["com.myoxus.editor.bpmn.reverse-data-association"]()}
      </Button>
      <MyoxusTextarea
        label={t["com.myoxus.editor.bpmn.transformation"]()}
        value={association.transformation?.__$$text ?? ""}
        disabled={readOnly}
        onChange={(text) =>
          command((model) => setDataAssociationTransformation(model, id, text))
        }
      />
      <Button
        disabled={readOnly}
        onClick={() => command((model) => addDataAssignment(model, id))}
      >
        {t["com.myoxus.editor.bpmn.add-assignment"]()}
      </Button>
      <Accordion>
        {association.assignment?.map((assignment, index) => (
          <AccordionItem
            key={assignment["@_id"] ?? index}
            value={assignment["@_id"] ?? String(index)}
          >
            <AccordionControl>
              {assignment["@_id"] ?? String(index + 1)}
            </AccordionControl>
            <AccordionPanel>
              <Stack>
                <MyoxusTextarea
                  label={t["com.myoxus.editor.bpmn.assignment-from"]()}
                  value={assignment.from.__$$text ?? ""}
                  disabled={readOnly}
                  onChange={(text) =>
                    command((model) =>
                      editDataAssignment(
                        model,
                        id,
                        assignment["@_id"] ?? index,
                        "from",
                        text,
                      ),
                    )
                  }
                />
                <MyoxusTextarea
                  label={t["com.myoxus.editor.bpmn.assignment-to"]()}
                  value={assignment.to.__$$text ?? ""}
                  disabled={readOnly}
                  onChange={(text) =>
                    command((model) =>
                      editDataAssignment(
                        model,
                        id,
                        assignment["@_id"] ?? index,
                        "to",
                        text,
                      ),
                    )
                  }
                />
                <Button
                  disabled={readOnly}
                  onClick={() =>
                    command((model) =>
                      removeDataAssignment(
                        model,
                        id,
                        assignment["@_id"] ?? index,
                      ),
                    )
                  }
                >
                  {t.Delete()}
                </Button>
              </Stack>
            </AccordionPanel>
          </AccordionItem>
        ))}
      </Accordion>
    </Stack>
  );
}
