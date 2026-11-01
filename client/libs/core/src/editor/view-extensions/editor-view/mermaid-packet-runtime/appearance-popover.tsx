// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  NumberInput,
  Checkbox,
  Stack,
} from "@myoxus/ui-facade";
import {
  PACKET_CONFIG_FIELDS,
  packetConfigLabel,
  mermaidMessages as messages,
  type PacketConfig,
  type MermaidPacketReactHostProps,
  type MermaidPacketModel,
  type PacketCommandResult,
} from "@virgultum/block-mermaid";
import { useState } from "react";
export function PacketAppearancePopover({
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
  const [initial] = useState(props.model.configResolution.effective);
  const [draft, setDraft] = useState(initial);
  const changes = Object.fromEntries(
    PACKET_CONFIG_FIELDS.filter(
      (field) => !Object.is(draft[field], initial[field]),
    ).map((field) => [field, draft[field]]),
  ) as Partial<PacketConfig>;
  const command = { type: "appearance" as const, changes };
  const preview = props.onPreviewCommand(command, basis);
  const [notice, setNotice] = useState<string>();
  const change = (next: typeof draft) => {
    setDraft(next);
    const changes = Object.fromEntries(
      PACKET_CONFIG_FIELDS.filter(
        (field) => !Object.is(next[field], initial[field]),
      ).map((field) => [field, next[field]]),
    ) as Partial<PacketConfig>;
    const result = props.onPreviewCommand(
      { type: "appearance", changes },
      basis,
    );
    onPreview(result.status === "rejected" ? undefined : result.model);
  };
  const readonly =
    props.readonly ||
    props.displayOnly ||
    Boolean(
      props.model.issues.length ||
      props.model.diagnostics.some((issue) => issue.code !== "config"),
    );
  return (
    <Stack data-myoxus-editor-keyboard-owner="packet-appearance">
      {PACKET_CONFIG_FIELDS.map((field) =>
        field === "showBits" || field === "useMaxWidth" ? (
          <Checkbox
            key={field}
            label={packetConfigLabel(field)}
            checked={draft[field] === true}
            disabled={readonly}
            onChange={(event) =>
              change({ ...draft, [field]: event.currentTarget.checked })
            }
          />
        ) : (
          <NumberInput
            key={field}
            label={packetConfigLabel(field)}
            value={
              typeof draft[field] === "number"
                ? draft[field]
                : String(draft[field] ?? "")
            }
            disabled={readonly}
            onChange={(value) =>
              change({
                ...draft,
                [field]: typeof value === "number" ? value : Number.NaN,
              })
            }
          />
        ),
      )}
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
