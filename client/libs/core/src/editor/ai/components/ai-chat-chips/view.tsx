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
  Image,
  MyoxusLoader,
  RemovableBadge,
  Scrollable,
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
  images,
  onRemove,
  onError,
}: {
  images: readonly { file: File; url: string }[];
  onRemove: (file: File) => void;
  onError: (file: File, url: string) => void;
}) {
  const t = useI18n();
  return (
    <Scrollable.Root
      data-myoxus-ui-role="chat-image-previews"
      // Intrinsic chat hosts must not grow to the thumbnail strip's content width.
      style={{ contain: "inline-size" }}
    >
      <Scrollable.Viewport autosize scrollbars="x" offsetScrollbars="x">
        <Group wrap="nowrap">
          {images.map(({ file, url }) => (
            <Group key={url} wrap="nowrap">
              <Image
                src={url}
                alt={file.name}
                // Bound input thumbnails while preserving the entire authored image.
                h="calc(var(--mantine-spacing-2xl) * 2)"
                w="calc(var(--mantine-spacing-2xl) * 2)"
                fit="contain"
                onError={() => onError(file, url)}
              />
              <IconButton
                aria-label={t["com.myoxus.ai.chat-panel.remove-image"]()}
                tooltip={t["com.myoxus.common.remove-item"]({
                  item: file.name,
                })}
                onClick={() => onRemove(file)}
              >
                <CloseIcon />
              </IconButton>
            </Group>
          ))}
        </Group>
      </Scrollable.Viewport>
    </Scrollable.Root>
  );
}
