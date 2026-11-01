// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { useState } from "react";
import {
  Alert,
  Button,
  ConfirmModal,
  MyoxusText,
  MyoxusTextInput,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type StateReactHostProps,
} from "@virgultum/block-mermaid";
import { handleStateDraftKeyDown, useStateDraft } from "./drafts";
export function StateAccessibilityForm({
  props,
  onClose,
}: {
  props: StateReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useStateDraft(
      {
        title: props.model.accessibilityTitle,
        description: props.model.accessibilityDescription,
      },
      props,
    );
  const save = () => {
    const result = d.commit("editStateAccessibility", [d.value]);
    if (!result.diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) =>
        handleStateDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <MyoxusTextInput
        autoFocus
        data-autofocus
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

/** Native titles use the same checked draft boundary as other State objects. */
export function StateDiagramTitleForm({
  props,
  onClose,
  initialDelete = false,
}: {
  props: StateReactHostProps;
  onClose: () => void;
  initialDelete?: boolean;
}) {
  const t = useI18n(),
    d = useStateDraft({ title: props.model.diagramTitle }, props);
  const [deleting, setDeleting] = useState(initialDelete);
  const save = () => {
    const result = d.commit("editStateDiagramTitle", [d.value.title]);
    if (!result.diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) =>
        handleStateDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <MyoxusTextInput
        autoFocus
        data-autofocus
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
      <ConfirmModal
        open={deleting}
        onOpenChange={(opened) => {
          setDeleting(opened);
          if (!opened && initialDelete) onClose();
        }}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          const result = d.commit("editStateDiagramTitle", [""]);
          if (!result.diagnostic) onClose();
        }}
      >
        <Stack>
          <MyoxusText>{props.model.diagramTitle}</MyoxusText>
          {d.diagnostic ? (
            <Alert color="myoxusError" role="alert">
              {d.diagnostic}
            </Alert>
          ) : null}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
