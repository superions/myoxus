// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  MyoxusTextarea,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidGanttReactHostProps,
} from "@virgultum/block-mermaid";
import { useState } from "react";

/** `accTitle` / `accDescr` stay structured document content, never raw source. */
export function GanttAccessibilityPopover({
  props,
}: {
  readonly props: MermaidGanttReactHostProps;
}) {
  const [title, setTitle] = useState(props.model.accessibilityTitle);
  const [description, setDescription] = useState(
    props.model.accessibilityDescription,
  );
  return (
    <Stack p="sm" w={340}>
      <MyoxusText typographySlot="dense-label">
        {messages.architectureAccessibility()}
      </MyoxusText>
      <MyoxusTextInput
        label={messages.architectureAccessibilityTitle()}
        value={title}
        onChange={setTitle}
      />
      <MyoxusTextarea
        label={messages.architectureAccessibilityDescription()}
        minRows={3}
        value={description}
        onChange={setDescription}
      />
      <Group justify="flex-end">
        <Button
          disabled={props.readonly || (!title && !description)}
          variant="plain"
          onClick={() =>
            props.onCommand([
              { field: "accTitle", type: "metadata.remove" },
              { field: "accDescr", type: "metadata.remove" },
            ])
          }
        >
          {messages.visualDelete()}
        </Button>
        <Button
          disabled={props.readonly || (!title.trim() && !description.trim())}
          onClick={() =>
            props.onCommand([
              title.trim()
                ? { field: "accTitle", type: "metadata.set", value: title }
                : { field: "accTitle", type: "metadata.remove" },
              description.trim()
                ? {
                    field: "accDescr",
                    type: "metadata.set",
                    value: description,
                  }
                : { field: "accDescr", type: "metadata.remove" },
            ])
          }
        >
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}
