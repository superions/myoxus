// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  IconButton,
  Popover,
  PopoverContent,
  PopoverTarget,
} from "@myoxus/ui-facade";
import { PlusIcon } from "@myoxus/icons";
import {
  mermaidMessages as messages,
  type SankeyCommand,
  type MermaidSankeyReactHostProps,
} from "@virgultum/block-mermaid";
import { SankeyLinkPopover } from "./link-popover";

export function SankeyConnectOverlay({
  props,
  opened,
  onOpenedChange,
  onApply,
  onStartSelected,
  onPreviewModel,
}: {
  readonly props: MermaidSankeyReactHostProps;
  readonly opened: boolean;
  readonly onOpenedChange: (opened: boolean) => void;
  readonly onApply: (commands: readonly SankeyCommand[]) => boolean;
  readonly onStartSelected?: () => void;
  readonly onPreviewModel: (
    model: MermaidSankeyReactHostProps["model"],
  ) => void;
}) {
  return (
    <Popover opened={opened} onChange={onOpenedChange} fitViewport>
      <PopoverTarget>
        <IconButton
          icon={<PlusIcon />}
          aria-label={messages.chartAddLink()}
          tooltip={messages.chartAddLink()}
          disabled={props.readonly}
          onClick={() => {
            if (onStartSelected) onStartSelected();
            else onOpenedChange(!opened);
          }}
        />
      </PopoverTarget>
      <PopoverContent>
        <SankeyLinkPopover
          props={props}
          onApply={onApply}
          onCancel={() => onOpenedChange(false)}
          onPreviewModel={onPreviewModel}
        />
      </PopoverContent>
    </Popover>
  );
}
