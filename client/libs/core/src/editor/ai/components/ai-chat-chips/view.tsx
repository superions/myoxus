// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  CloseIcon,
  MoreHorizontalIcon,
  PlusIcon,
  WarningIcon,
  RefreshCwIcon,
} from "@myoxus/icons/react";
import {
  Button,
  ColorDot,
  Group,
  IconButton,
  MyoxusLoader,
  RemovableBadge,
  Tooltip,
} from "@myoxus/ui-facade";
import { isValidElement, type ReactNode } from "react";

import { ContextPicker } from "./context-picker";
import type { ChipState } from "./type";

export function ChatChipView({
  state,
  name,
  tooltip,
  icon,
  tagColor,
  closeable,
  onAdd,
  onRemove,
  onRetry,
}: {
  state: ChipState;
  name: string;
  tooltip: string;
  icon: ReactNode;
  tagColor?: string;
  closeable: boolean;
  onAdd: () => void;
  onRemove: () => void;
  onRetry?: () => void;
}) {
  const t = useI18n();
  if (state === "candidate")
    return (
      <Button
        data-testid="chat-panel-chip"
        data-state={state}
        prefix={isValidElement<{ className?: string }>(icon) ? icon : undefined}
        suffix={<PlusIcon />}
        onClick={onAdd}
        tooltip={tooltip}
      >
        {name}
      </Button>
    );
  const prefix =
    state === "processing" ? (
      <MyoxusLoader />
    ) : state === "failed" ? (
      <WarningIcon />
    ) : tagColor ? (
      <ColorDot color={tagColor} aria-label={name} />
    ) : (
      icon
    );
  const badge = (
    <Tooltip
      content={
        <>
          {name}
          {tooltip !== name ? (
            <>
              <br />
              {tooltip}
            </>
          ) : null}
        </>
      }
    >
      <RemovableBadge
        data-testid="chat-panel-chip"
        data-state={state}
        tone={state === "failed" ? "error" : "neutral"}
        prefix={prefix}
        removeLabel={t["com.myoxus.common.remove-item"]({ item: name })}
        onRemove={closeable ? onRemove : undefined}
      >
        <span data-testid="chat-panel-chip-title">{name}</span>
      </RemovableBadge>
    </Tooltip>
  );
  return state === "failed" && onRetry ? (
    <Group wrap="nowrap">
      {badge}
      <IconButton
        aria-label={t["Retry"]()}
        tooltip={t["Retry"]()}
        onClick={onRetry}
      >
        <RefreshCwIcon />
      </IconButton>
    </Group>
  ) : (
    badge
  );
}

export function ChatChipsView({
  children,
  hiddenCount,
  onExpand,
  renderCandidates,
}: {
  children?: ReactNode;
  hiddenCount: number;
  onExpand: () => void;
  renderCandidates?: (controller: AbortController) => ReactNode;
}) {
  const t = useI18n();
  return (
    <Group data-myoxus-ui-role="chat-context-chips">
      {children}
      {renderCandidates ? (
        <ContextPicker
          disabled={false}
          label={t["com.myoxus.ai.chat-panel.context-candidate"]()}
          triggerIcon={<MoreHorizontalIcon />}
          testId="chat-context-candidates"
          renderContent={renderCandidates}
        />
      ) : null}
      {hiddenCount > 0 ? (
        <Button aria-label={t["Expand"]()} onClick={onExpand}>
          +{hiddenCount}
        </Button>
      ) : null}
    </Group>
  );
}

export function ChatImagePreviewView({
  preview,
  name,
  onRemove,
}: {
  preview: ReactNode;
  name: string;
  onRemove: () => void;
}) {
  const t = useI18n();
  return (
    <Group wrap="nowrap">
      {preview}
      <IconButton
        aria-label={t["com.myoxus.ai.chat-panel.remove-image"]()}
        tooltip={t["com.myoxus.common.remove-item"]({ item: name })}
        onClick={onRemove}
      >
        <CloseIcon />
      </IconButton>
    </Group>
  );
}
