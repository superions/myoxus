// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  MyoxusTextInput,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type ErReactHostProps,
  readErDiagramTitle,
} from "@virgultum/block-mermaid";
import { handleErDraftKeyDown, useErDraft } from "./drafts";
export function ErAccessibilityForm({
  props,
  onClose,
}: {
  props: ErReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useErDraft(
      {
        title: props.model.accessibilityTitle,
        description: props.model.accessibilityDescription,
      },
      props,
    );
  const save = () => {
    const result = d.commit("editErAccessibility", [d.value]);
    if (!result.diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) =>
        handleErDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <MyoxusTextInput
        autoFocus
        label={m.architectureAccessibilityTitle()}
        value={d.value.title}
        disabled={props.readonly}
        onChange={(value) => d.set("title", value)}
      />
      <Textarea
        label={m.architectureAccessibilityDescription()}
        value={d.value.description}
        disabled={props.readonly}
        onChange={(value) => d.set("description", value)}
        autosize
      />
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      {!props.readonly ? <Button onClick={save}>{t["Save"]()}</Button> : null}
      <Button onClick={onClose}>{m.cancel()}</Button>
    </Stack>
  );
}

/** Native titles use the same checked draft boundary as other ER objects. */
export function ErDiagramTitleForm({
  props,
  onClose,
}: {
  props: ErReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useErDraft({ title: readErDiagramTitle(props.model) }, props);
  const save = () => {
    const result = d.commit("editErDiagramTitle", [d.value.title]);
    if (!result.diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) =>
        handleErDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <MyoxusTextInput
        autoFocus
        label={m.titlePlaceholder()}
        value={d.value.title}
        disabled={props.readonly}
        onChange={(value) => d.set("title", value)}
      />
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      {!props.readonly ? <Button onClick={save}>{t["Save"]()}</Button> : null}
      <Button onClick={onClose}>{m.cancel()}</Button>
    </Stack>
  );
}
