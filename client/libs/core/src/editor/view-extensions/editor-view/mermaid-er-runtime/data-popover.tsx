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
  readErOpaqueConfig,
  type ErReactHostProps,
} from "@virgultum/block-mermaid";
import { useErDraft } from "./drafts";
export function ErDataForm({ props }: { props: ErReactHostProps }) {
  return (
    <Stack>
      <MyoxusText>{m.erConfigHelp()}</MyoxusText>
      <Accordion>
        {readErOpaqueConfig(props.model).map((r) => (
          <AccordionItem
            key={`${r.recordKey}:${r.path.join(".")}`}
            value={`${r.recordKey}:${r.path.join(".")}`}
          >
            <AccordionControl>{r.path.join(".")}</AccordionControl>
            <AccordionPanel>
              <ErOpaqueRecordForm
                props={props}
                id={r.recordKey}
                path={r.path}
                value={r.raw}
              />
            </AccordionPanel>
          </AccordionItem>
        ))}
      </Accordion>
    </Stack>
  );
}
function ErOpaqueRecordForm({
  props,
  id,
  path,
  value,
}: {
  props: ErReactHostProps;
  id: string;
  path: string[];
  value: string;
}) {
  const t = useI18n(),
    d = useErDraft({ raw: value }, props);
  return (
    <Stack>
      <Textarea
        label={m.pieData()}
        value={d.value.raw}
        disabled={props.readonly}
        autosize
        onChange={(value) => d.set("raw", value)}
      />
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Button
        disabled={props.readonly}
        onClick={() => d.commit("editErOpaqueConfig", [id, path, d.value.raw])}
      >
        {t["Save"]()}
      </Button>
    </Stack>
  );
}
