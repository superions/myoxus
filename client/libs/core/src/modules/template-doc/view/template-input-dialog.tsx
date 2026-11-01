// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { useLiveData } from "@myoxus/infra";
import {
  Button,
  Group,
  Input,
  Modal,
  MyoxusText,
  Notice,
  Stack,
} from "@myoxus/ui-facade";
import { useState } from "react";
import type { DialogComponentProps } from "../../dialogs/types";
import type { WORKSPACE_DIALOG_SCHEMA } from "../../dialogs/constant";
import {
  normalizeTemplateInputs,
  templateInputLabel,
} from "../services/template-inputs";

export function TemplateInputDialog({
  prompt,
  close,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["template-inputs"]>) {
  const t = useI18n();
  const state = useLiveData(prompt.state$);
  const [values, setValues] = useState<Record<string, string>>({});
  let valid = true;
  try {
    normalizeTemplateInputs(state.names, values);
  } catch {
    valid = false;
  }
  return (
    <Modal
      open
      title={t["com.myoxus.template-input.title"]()}
      onOpenChange={(open) => {
        if (!open && !state.busy) close();
      }}
      persistent={state.busy}
      withoutCloseButton={state.busy}
      scrollable
      contentOptions={{ "data-testid": "template-input-dialog" }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !state.busy && !state.blocked) prompt.submit(values);
        }}
      >
        <Stack>
          <MyoxusText>
            {t["com.myoxus.template-input.description"]()}
          </MyoxusText>
          {state.names.map((name) => (
            <Input
              key={name}
              label={templateInputLabel(name)}
              description={`{{${name}}}`}
              value={values[name] ?? ""}
              required
              disabled={state.busy || state.blocked}
              onChange={(value) =>
                setValues((previous) => ({ ...previous, [name]: value }))
              }
              autoComplete="off"
            />
          ))}
          {state.error ? <Notice tone="error">{state.error}</Notice> : null}
          <Group justify="end">
            <Button disabled={state.busy} onClick={() => close()}>
              {t["Cancel"]()}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={!valid || state.busy || state.blocked}
              loading={state.busy}
            >
              {t["Apply"]()}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
