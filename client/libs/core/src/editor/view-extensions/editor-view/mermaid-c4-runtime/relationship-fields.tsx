// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Alert,
  Button,
  Group,
  MyoxusTextInput,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  C4_RELATIONSHIP_FIELD_KEYS,
  readC4RelationshipFields,
  editC4RelationshipFields,
  type C4ReactHostProps,
  type MermaidC4Relationship,
  type C4RelationshipFields,
} from "@virgultum/block-mermaid";
import {
  useC4Draft,
  useC4CommandPreview,
  handleC4DraftKeyDown,
} from "./drafts";

/** Effective content edits name the real provider; metadata remains a folded local section. */
export function C4RelationshipFieldsForm({
  props,
  relationship,
}: {
  props: C4ReactHostProps;
  relationship: MermaidC4Relationship;
}) {
  const t = useI18n(),
    id = relationship.resolution!.selectionId;
  const d = useC4Draft(readC4RelationshipFields(relationship), props),
    preview = useC4CommandPreview(props);
  const writable = !props.readonly && !props.displayOnly;
  const prepared = editC4RelationshipFields(props.model, id, d.value);
  const save = () => {
    preview.clear();
    d.commit("editC4RelationshipFields", [id, d.value]);
  };
  const input = (key: keyof C4RelationshipFields, label: string) => {
    const provider =
      relationship.resolution!.providers[C4_RELATIONSHIP_FIELD_KEYS[key]];
    const record = props.model.sourceDocument.records.find(
      (r) => r.sourceKey === provider?.sourceKey,
    );
    return (
      <MyoxusTextInput
        label={label}
        value={d.value[key]}
        disabled={!writable}
        description={
          record && provider?.form !== "omitted"
            ? t["com.myoxus.editor.mermaid.c4-record-position"]({
                call: record.callKind!,
                line: new Intl.NumberFormat(t.language).format(
                  record.range.line,
                ),
              })
            : t["com.myoxus.editor.mermaid.c4-new-relation-update"]()
        }
        onChange={(value) => {
          preview.clear();
          d.set(key, value);
        }}
      />
    );
  };
  return (
    <Stack
      onKeyDown={(e) =>
        handleC4DraftKeyDown(e, writable, save, () => {
          preview.clear();
          props.onCloseSelection();
          props.resolveReturnFocusTarget()?.focus();
        })
      }
    >
      {relationship.dynamicStep ? (
        <Text>
          {t["com.myoxus.editor.mermaid.c4-dynamic-step"]({
            step: new Intl.NumberFormat(t.language).format(
              relationship.dynamicStep,
            ),
          })}
        </Text>
      ) : null}
      {input("label", m.timelineLabel())}
      {input("technology", m.selectedC4Technology())}
      {input("description", m.selectedC4Description())}
      <Accordion>
        <AccordionItem value="metadata">
          <AccordionControl>
            {t["com.myoxus.editor.mermaid.metadata"]()}
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              {input("tags", t["Tags"]())}
              {input("link", t["com.myoxus.editor.mermaid.selected-c4-link"]())}
              {input(
                "sprite",
                t["com.myoxus.editor.mermaid.selected-c4-sprite"](),
              )}
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
      {prepared.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? prepared.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!writable || prepared.status === "invalid"}
            onClick={() =>
              preview.preview("editC4RelationshipFields", [id, d.value])
            }
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button
          disabled={!writable || prepared.status === "invalid"}
          onClick={save}
        >
          {t["Apply"]()}
        </Button>
        <Button
          onClick={() => {
            preview.clear();
            props.onCloseSelection();
            props.resolveReturnFocusTarget()?.focus();
          }}
        >
          {m.cancel()}
        </Button>
      </Group>
    </Stack>
  );
}
