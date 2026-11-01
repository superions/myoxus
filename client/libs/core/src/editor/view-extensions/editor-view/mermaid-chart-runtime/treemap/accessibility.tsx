// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  Group,
  MyoxusTextInput,
  MyoxusTextarea,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidTreemapReactHostProps,
  type TreemapCommand,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

export function TreemapAccessibility({
  onCancel,
  onApply,
  props,
}: {
  readonly onApply: (
    command: TreemapCommand | readonly TreemapCommand[],
  ) => boolean;
  readonly onCancel: () => void;
  readonly props: MermaidTreemapReactHostProps;
}) {
  const [title, setTitle] = useState(props.model.accessibilityTitle);
  const [description, setDescription] = useState(
    props.model.accessibilityDescription,
  );
  useEffect(() => {
    setTitle(props.model.accessibilityTitle);
    setDescription(props.model.accessibilityDescription);
  }, [props.model.accessibilityDescription, props.model.accessibilityTitle]);
  const commands: TreemapCommand[] = [];
  if (title !== props.model.accessibilityTitle)
    commands.push(
      title.trim()
        ? { type: "metadata.set", field: "accTitle", value: title }
        : { type: "metadata.remove", field: "accTitle" },
    );
  if (description !== props.model.accessibilityDescription)
    commands.push(
      description.trim()
        ? { type: "metadata.set", field: "accDescr", value: description }
        : { type: "metadata.remove", field: "accDescr" },
    );
  return (
    <Stack>
      <MyoxusTextInput
        disabled={props.readonly}
        label={messages.visualAccessibilityTitle()}
        value={title}
        onChange={setTitle}
      />
      <MyoxusTextarea
        disabled={props.readonly}
        label={messages.visualAccessibilityDescription()}
        value={description}
        onChange={setDescription}
      />
      <Group justify="flex-end">
        <Button
          variant="plain"
          onClick={() => {
            setTitle(props.model.accessibilityTitle);
            setDescription(props.model.accessibilityDescription);
            onCancel();
          }}
        >
          {messages.cancel()}
        </Button>
        <Button
          variant="plain"
          disabled={
            props.readonly ||
            (!props.model.accessibilityTitle &&
              !props.model.accessibilityDescription)
          }
          onClick={() => {
            const removals: TreemapCommand[] = [];
            if (props.model.accessibilityTitle)
              removals.push({
                type: "metadata.remove",
                field: "accTitle",
              });
            if (props.model.accessibilityDescription)
              removals.push({
                type: "metadata.remove",
                field: "accDescr",
              });
            if (removals.length && onApply(removals)) onCancel();
          }}
        >
          {messages.structuredRemoveEntry()}
        </Button>
        <Button disabled={!commands.length} onClick={() => onApply(commands)}>
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}
