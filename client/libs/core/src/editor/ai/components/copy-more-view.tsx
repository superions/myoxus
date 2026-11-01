// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { CopyIcon, MoreHorizontalIcon, ResetIcon } from "@myoxus/icons/react";
import { Group, IconButton, Menu, MenuItem } from "@myoxus/ui-facade";
import { type ReactNode, useState } from "react";

export interface ChatMessageActionOption {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => Promise<void>;
}

/** One predictable command group; native Menu owns keyboard and focus return. */
export function ChatMessageActions({
  copy,
  retry,
  actions,
  onFailure,
}: {
  copy?: () => Promise<void>;
  retry?: () => void | Promise<void>;
  actions: ChatMessageActionOption[];
  onFailure: () => void;
}) {
  const t = useI18n();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const run = async (action: () => void | Promise<void>) => {
    if (pending) return;
    setPending(true);
    try {
      await action();
    } catch {
      onFailure();
    } finally {
      setPending(false);
    }
  };
  return (
    <Group data-myoxus-ui-role="chat-message-actions">
      {copy ? (
        <IconButton
          size="small"
          data-testid="action-copy-button"
          aria-label={t["Copy"]()}
          tooltip={t["Copy"]()}
          disabled={pending}
          onClick={() => void run(copy)}
        >
          <CopyIcon />
        </IconButton>
      ) : null}
      {retry ? (
        <IconButton
          size="small"
          data-testid="action-retry-button"
          aria-label={t["Retry"]()}
          tooltip={t["Retry"]()}
          disabled={pending}
          onClick={() => void run(retry)}
        >
          <ResetIcon />
        </IconButton>
      ) : null}
      {actions.length ? (
        <Menu
          rootOptions={{ open, onOpenChange: setOpen }}
          items={actions.map((action) => (
            <MenuItem
              key={action.id}
              prefixIcon={action.icon}
              disabled={pending}
              onSelect={() => void run(action.run)}
            >
              {action.label}
            </MenuItem>
          ))}
        >
          <IconButton
            size="small"
            data-testid="action-more-button"
            aria-label={t["com.myoxus.common.open-menu"]()}
            tooltip={t["com.myoxus.common.open-menu"]()}
            tooltipOptions={{ opened: open ? false : undefined }}
            disabled={pending}
          >
            <MoreHorizontalIcon />
          </IconButton>
        </Menu>
      ) : null}
    </Group>
  );
}
