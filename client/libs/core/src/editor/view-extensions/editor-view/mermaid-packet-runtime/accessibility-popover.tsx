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
  mermaidMessages as messages,
  type MermaidPacketReactHostProps,
  type MermaidPacketModel,
  type PacketCommandResult,
} from "@virgultum/block-mermaid";
import { useState } from "react";
export function PacketAccessibilityPopover({
  props,
  onClose,
  onPreview,
  onApply,
}: {
  props: MermaidPacketReactHostProps;
  onClose: () => void;
  onPreview: (model?: MermaidPacketModel) => void;
  onApply: (result: PacketCommandResult) => boolean;
}) {
  const [basis] = useState(props.model.sourceDocument.source);
  const [title, setTitle] = useState(props.model.accessibilityTitle);
  const [description, setDescription] = useState(
    props.model.accessibilityDescription,
  );
  const [notice, setNotice] = useState<string>();
  const command = { type: "accessibility" as const, title, description };
  const preview = props.onPreviewCommand(command, basis);
  const readonly =
    props.readonly ||
    props.displayOnly ||
    Boolean(props.model.issues.length || props.model.diagnostics.length);
  return (
    <Stack data-myoxus-editor-keyboard-owner="packet-accessibility">
      <MyoxusTextInput
        label={messages.visualAccessibilityTitle()}
        value={title}
        disabled={readonly}
        onChange={(value) => {
          setTitle(value);
          const result = props.onPreviewCommand(
            { type: "accessibility", title: value, description },
            basis,
          );
          onPreview(result.status === "rejected" ? undefined : result.model);
        }}
      />
      <Textarea
        label={messages.visualAccessibilityDescription()}
        value={description}
        disabled={readonly}
        onChange={(value) => {
          setDescription(value);
          const result = props.onPreviewCommand(
            { type: "accessibility", title, description: value },
            basis,
          );
          onPreview(result.status === "rejected" ? undefined : result.model);
        }}
      />
      {notice || preview.diagnostic ? (
        <Alert>{notice ?? preview.diagnostic}</Alert>
      ) : null}
      <Group>
        <Button variant="plain" onClick={onClose}>
          {messages.cancel()}
        </Button>
        {!readonly ? (
          <Button
            disabled={preview.status === "rejected"}
            onClick={() => {
              const result = props.onCommand(command, basis);
              if (onApply(result)) return;
              else
                setNotice(
                  result.diagnostic ?? messages.ganttDiagnosticConflict(),
                );
            }}
          >
            {messages.architectureApply()}
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
