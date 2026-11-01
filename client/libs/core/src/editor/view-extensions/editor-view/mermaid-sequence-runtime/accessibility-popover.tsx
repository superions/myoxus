// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Alert,
  Button,
  Group,
  MyoxusTextInput,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  readSequenceDiagramTitle,
  type SequenceReactHostProps,
} from "@virgultum/block-mermaid";
import { useSequenceDraft, handleSequenceDraftKeyDown } from "./drafts";
export function SequenceAccessibilityForm({
  props,
  onClose,
}: {
  props: SequenceReactHostProps;
  onClose: () => void;
}) {
  const d = useSequenceDraft(
      {
        title: props.model.accessibilityTitle,
        description: props.model.accessibilityDescription,
      },
      props,
    ),
    save = () => {
      if (!d.commit("editSequenceAccessibility", [d.value]).diagnostic)
        onClose();
    };
  return (
    <Stack
      onKeyDown={(event) =>
        handleSequenceDraftKeyDown(event, props.readonly, save, onClose)
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
        autosize
        label={m.architectureAccessibilityDescription()}
        value={d.value.description}
        disabled={props.readonly}
        onChange={(value) => d.set("description", value)}
      />
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={props.readonly}
          onClick={() => d.preview("editSequenceAccessibility", [d.value])}
        >
          {m.sequencePreview()}
        </Button>
        <Button disabled={props.readonly} onClick={save}>
          {m.sequenceApply()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
export function SequenceDiagramTitleForm({
  props,
  onClose,
}: {
  props: SequenceReactHostProps;
  onClose: () => void;
}) {
  const d = useSequenceDraft(
      { title: readSequenceDiagramTitle(props.model) },
      props,
    ),
    save = () => {
      const result = d.commit("editSequenceDiagramTitle", [d.value.title]);
      if (!result.diagnostic) onClose();
    };
  return (
    <Stack
      onKeyDown={(event) =>
        handleSequenceDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <MyoxusTextInput
        autoFocus
        label={m.titlePlaceholder()}
        value={d.value.title}
        disabled={props.readonly}
        onChange={(value) => d.set("title", value)}
      />
      {d.diagnostic ? <Alert color="myoxusError">{d.diagnostic}</Alert> : null}
      <Group>
        <Button disabled={props.readonly} onClick={save}>
          {m.sequenceApply()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
