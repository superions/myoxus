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
  MyoxusTextarea,
  Stack,
} from "@myoxus/ui-facade";
import {
  editC4PreambleRecord,
  mermaidMessages as m,
  type C4ReactHostProps,
} from "@virgultum/block-mermaid";
import {
  handleC4DraftKeyDown,
  useC4CommandPreview,
  useC4Draft,
} from "./drafts";

/** Raw Data is bounded to one actual preamble record, never a second model editor. */
export function C4PreambleControls({
  props,
  onClose,
}: {
  props: C4ReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n();
  return (
    <Accordion>
      {props.model.sourceDocument.records
        .filter((r) => r.kind === "frontmatter" || r.kind === "directive")
        .map((r) => (
          <AccordionItem key={r.sourceKey} value={r.sourceKey}>
            <AccordionControl>
              {r.kind === "frontmatter" ? "YAML" : "%%{…}%%"} ·{" "}
              {new Intl.NumberFormat(t.language).format(r.range.line)}
            </AccordionControl>
            <AccordionPanel>
              <PreambleForm
                props={props}
                sourceKey={r.sourceKey}
                onClose={onClose}
              />
            </AccordionPanel>
          </AccordionItem>
        ))}
    </Accordion>
  );
}
function PreambleForm({
  props,
  sourceKey,
  onClose,
}: {
  props: C4ReactHostProps;
  sourceKey: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    record = props.model.sourceDocument.records.find(
      (r) => r.sourceKey === sourceKey,
    )!,
    d = useC4Draft({ raw: record.raw }, props),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly,
    command = editC4PreambleRecord(props.model, sourceKey, d.value.raw);
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    preview.clear();
    if (!d.commit("editC4PreambleRecord", [sourceKey, d.value.raw]).diagnostic)
      close();
  };
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <MyoxusTextarea
        label={m.modeSource()}
        value={d.value.raw}
        disabled={!writable}
        onChange={(value) => {
          preview.clear();
          d.set("raw", value);
        }}
      />
      {command.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? command.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!writable || command.status === "invalid"}
            onClick={() =>
              preview.preview("editC4PreambleRecord", [sourceKey, d.value.raw])
            }
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button
          disabled={!writable || command.status === "invalid"}
          onClick={save}
        >
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
