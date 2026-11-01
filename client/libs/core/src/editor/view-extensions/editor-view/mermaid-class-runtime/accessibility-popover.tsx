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
  type ClassReactHostProps,
  readClassDiagramTitle,
} from "@virgultum/block-mermaid";
import { useClassDraft } from "./drafts";
export function ClassAccessibilityForm({
  props,
  onClose,
}: {
  props: ClassReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useClassDraft(
      {
        title: props.model.accessibilityTitle,
        description: props.model.accessibilityDescription,
      },
      props,
    );
  return (
    <Stack>
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
      {!props.readonly ? (
        <Button
          onClick={() => {
            const result = d.commit("editClassAccessibility", [d.value]);
            if (!result.diagnostic) onClose();
          }}
        >
          {t["com.myoxus.editCollection.save"]()}
        </Button>
      ) : null}
    </Stack>
  );
}

/** Native titles use the same checked draft boundary as other Class objects. */
export function ClassDiagramTitleForm({
  props,
  onClose,
}: {
  props: ClassReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useClassDraft({ title: readClassDiagramTitle(props.model) }, props);
  return (
    <Stack>
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
      {!props.readonly ? (
        <Button
          onClick={() => {
            const result = d.commit("editClassDiagramTitle", [d.value.title]);
            if (!result.diagnostic) onClose();
          }}
        >
          {t["com.myoxus.editCollection.save"]()}
        </Button>
      ) : null}
    </Stack>
  );
}
