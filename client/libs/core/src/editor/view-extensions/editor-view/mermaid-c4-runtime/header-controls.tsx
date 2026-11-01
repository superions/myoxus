// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { Alert, Button, Group, Select, Stack } from "@myoxus/ui-facade";
import {
  C4_HEADERS,
  changeC4Header,
  mermaidMessages as m,
  type C4ReactHostProps,
  type MermaidC4Header,
} from "@virgultum/block-mermaid";
import {
  useC4Draft,
  useC4CommandPreview,
  handleC4DraftKeyDown,
} from "./drafts";

export function C4HeaderForm({
  props,
  onClose,
}: {
  props: C4ReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n();
  const draft = useC4Draft(
      { header: props.model.headerLine as MermaidC4Header },
      props,
    ),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const candidate = changeC4Header(props.model, draft.value.header);
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    if (!writable || candidate.status === "invalid") return;
    preview.clear();
    if (!draft.commit("changeC4Header", [draft.value.header]).diagnostic)
      close();
  };
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <Select
        label={m.toolbarSearchPlaceholder()}
        value={draft.value.header}
        disabled={!writable}
        data={C4_HEADERS.map((header) => ({ value: header, label: header }))}
        onChange={(value) => {
          const header = C4_HEADERS.find((h) => h === value);
          if (header) {
            preview.clear();
            draft.set("header", header);
          }
        }}
      />
      {draft.diagnostic || preview.diagnostic || candidate.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {draft.diagnostic ?? preview.diagnostic ?? candidate.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={!writable || candidate.status !== "changed"}
          onClick={() =>
            preview.preview("changeC4Header", [draft.value.header])
          }
        >
          {m.sequencePreview()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
        <Button
          disabled={!writable || candidate.status === "invalid"}
          onClick={save}
        >
          {t["Apply"]()}
        </Button>
      </Group>
    </Stack>
  );
}
