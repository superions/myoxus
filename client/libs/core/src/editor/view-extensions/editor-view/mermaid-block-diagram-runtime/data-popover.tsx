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
  readBlockOpaqueConfig,
  type BlockReactHostProps,
} from "@virgultum/block-mermaid";
import { useBlockDraft } from "./drafts";
export function BlockDataForm({ props }: { props: BlockReactHostProps }) {
  return (
    <Stack>
      <MyoxusText>{m.journeyRawNoop()}</MyoxusText>
      <Accordion>
        {readBlockOpaqueConfig(props.model).map((r) => (
          <AccordionItem
            key={`${r.recordKey}:${r.path.join(".")}`}
            value={`${r.recordKey}:${r.path.join(".")}`}
          >
            <AccordionControl>{r.path.join(".")}</AccordionControl>
            <AccordionPanel>
              <BlockOpaqueRecordForm
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
function BlockOpaqueRecordForm({
  props,
  id,
  path,
  value,
}: {
  props: BlockReactHostProps;
  id: string;
  path: string[];
  value: string;
}) {
  const t = useI18n(),
    d = useBlockDraft({ raw: value }, props);
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
        onClick={() =>
          d.commit("editBlockOpaqueConfig", [id, path, d.value.raw])
        }
      >
        {t["Save"]()}
      </Button>
    </Stack>
  );
}
