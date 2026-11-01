// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
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
  type ClassReactHostProps,
} from "@virgultum/block-mermaid";
import { useClassDraft } from "./drafts";
export function ClassDataForm({ props }: { props: ClassReactHostProps }) {
  return (
    <Stack>
      <MyoxusText>{m.classCallbackHelp()}</MyoxusText>
      <Accordion>
        {props.model.interactions
          .filter((i) => i.kind === "callback")
          .map((i) => (
            <AccordionItem key={i.id} value={i.id}>
              <AccordionControl>{i.classId}</AccordionControl>
              <AccordionPanel>
                <ClassOpaqueRecordForm
                  props={props}
                  id={i.id}
                  value={i.payload}
                  config={false}
                />
              </AccordionPanel>
            </AccordionItem>
          ))}
        {props.model.sourceDocument.records
          .filter((r) => r.kind === "frontmatter" || r.kind === "directive")
          .map((r) => (
            <AccordionItem key={r.sourceKey} value={r.sourceKey}>
              <AccordionControl>
                {r.kind === "frontmatter" ? m.visualAppearance() : m.pieData()}
              </AccordionControl>
              <AccordionPanel>
                <ClassOpaqueRecordForm
                  props={props}
                  id={r.sourceKey}
                  value={r.raw}
                  config
                />
              </AccordionPanel>
            </AccordionItem>
          ))}
      </Accordion>
    </Stack>
  );
}
function ClassOpaqueRecordForm({
  props,
  id,
  value,
  config,
}: {
  props: ClassReactHostProps;
  id: string;
  value: string;
  config: boolean;
}) {
  const t = useI18n(),
    d = useClassDraft({ raw: value }, props);
  return (
    <Stack>
      <Textarea
        label={m.pieData()}
        value={d.value.raw}
        disabled={props.readonly}
        onChange={(value) => d.set("raw", value)}
        autosize
      />
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      {!props.readonly ? (
        <Button
          onClick={() =>
            config
              ? d.commit("editClassOpaqueConfig", [id, d.value.raw])
              : d.commit("editClassOpaquePayload", [id, d.value.raw])
          }
        >
          {t["com.myoxus.editCollection.save"]()}
        </Button>
      ) : null}
    </Stack>
  );
}
