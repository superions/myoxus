// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Alert,
  Button,
  MyoxusText,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  readSequenceOpaqueData,
  type SequenceReactHostProps,
} from "@virgultum/block-mermaid";
import { useSequenceDraft } from "./drafts";
export function SequenceDataForm({
  props,
  participantId,
}: {
  props: SequenceReactHostProps;
  participantId?: string;
}) {
  const records = props.model.sourceDocument.records.filter(
    (record) =>
      ["properties", "details", "link"].includes(record.kind) &&
      (!participantId || record.ownerId === participantId),
  );
  return (
    <Stack>
      <MyoxusText>{m.sequenceOpaqueHelp()}</MyoxusText>
      <Accordion>
        {records.map((record) => (
          <AccordionItem key={record.sourceKey} value={record.sourceKey}>
            <AccordionControl>{`${record.ownerId ?? ""} · ${record.kind}`}</AccordionControl>
            <AccordionPanel>
              <SequenceDataRecordForm
                props={props}
                recordKey={record.sourceKey}
                json={record.kind !== "details"}
                raw={
                  record.values.payload
                    ? props.sourceBasis.slice(
                        record.values.payload.start,
                        record.values.payload.end,
                      )
                    : ""
                }
              />
            </AccordionPanel>
          </AccordionItem>
        ))}
        {readSequenceOpaqueData(props.model)
          .filter((entry) => !participantId || entry.ownerId === participantId)
          .map((entry) => (
            <AccordionItem
              key={`${entry.recordKey}:${entry.path.join(".")}`}
              value={`${entry.recordKey}:${entry.path.join(".")}`}
            >
              <AccordionControl>{entry.path.join(".")}</AccordionControl>
              <AccordionPanel>
                <SequenceOpaqueForm
                  props={props}
                  recordKey={entry.recordKey}
                  path={entry.path}
                  raw={entry.raw}
                />
              </AccordionPanel>
            </AccordionItem>
          ))}
      </Accordion>
    </Stack>
  );
}
function SequenceDataRecordForm({
  props,
  recordKey,
  json,
  raw,
}: {
  props: SequenceReactHostProps;
  recordKey: string;
  json: boolean;
  raw: string;
}) {
  const d = useSequenceDraft({ raw }, props),
    [diagnostic, setDiagnostic] = useState<string | null>(null);
  const save = () => {
    let value: unknown = d.value.raw;
    if (json) {
      try {
        value = JSON.parse(d.value.raw);
      } catch {
        setDiagnostic(m.sequencePatchRejected());
        return;
      }
    }
    setDiagnostic(null);
    return d.commit("editSequenceData", [recordKey, value]);
  };
  return (
    <Stack>
      <Textarea
        autosize
        label={m.pieData()}
        value={d.value.raw}
        disabled={props.readonly}
        onChange={(value) => d.set("raw", value)}
      />
      {d.diagnostic || diagnostic ? (
        <Alert color="myoxusError">{d.diagnostic || diagnostic}</Alert>
      ) : null}
      <Button disabled={props.readonly} onClick={save}>
        {m.sequenceApply()}
      </Button>
    </Stack>
  );
}

function SequenceOpaqueForm({
  props,
  recordKey,
  path,
  raw,
}: {
  props: SequenceReactHostProps;
  recordKey: string;
  path: string[];
  raw: string;
}) {
  const d = useSequenceDraft({ raw }, props);
  return (
    <Stack>
      <Textarea
        autosize
        label={m.pieData()}
        value={d.value.raw}
        disabled={props.readonly}
        onChange={(value) => d.set("raw", value)}
      />
      {d.diagnostic ? <Alert color="myoxusError">{d.diagnostic}</Alert> : null}
      <Button
        disabled={props.readonly}
        onClick={() =>
          d.commit("editSequenceOpaqueData", [recordKey, path, d.value.raw])
        }
      >
        {m.sequenceApply()}
      </Button>
    </Stack>
  );
}
