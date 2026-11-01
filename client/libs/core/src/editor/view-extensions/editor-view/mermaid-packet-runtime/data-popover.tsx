// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button, Stack } from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidPacketReactHostProps,
} from "@virgultum/block-mermaid";
import { MermaidDataValue } from "../mermaid-data-value";
export function PacketDataPopover({
  props,
  onClose,
}: {
  props: MermaidPacketReactHostProps;
  onClose: () => void;
}) {
  return (
    <Stack>
      <MermaidDataValue
        label={messages.treemapData()}
        value={props.model.fields.map((field) => ({
          label: field.label,
          startBit: field.startBit,
          endBit: field.endBit,
          width: field.width,
          sourceForm: field.sourceForm,
        }))}
        readonly
        onChange={() => {}}
      />
      <Button variant="plain" onClick={onClose}>
        {messages.cancel()}
      </Button>
    </Stack>
  );
}
