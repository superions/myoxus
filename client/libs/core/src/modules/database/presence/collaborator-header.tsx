// SPDX-License-Identifier: AGPL-3.0-or-later

import { Avatar, AvatarStack, CountIndicator } from "@myoxus/ui-facade";
import type { HTMLAttributes, ReactNode } from "react";

import type { DatabasePresenceRecord } from "./service";

export interface DatabasePresenceIndicatorProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  records: ReadonlyArray<DatabasePresenceRecord>;
  dragging?: boolean;
  ariaLabel?: string;
  children?: ReactNode;
}

/** A theme-owned Facade avatar; user colors and sizing remain Mantine-owned. */
export function DatabasePresenceDot({
  record,
  tooltip,
}: {
  record: DatabasePresenceRecord;
  tooltip?: ReactNode;
}) {
  return (
    <Avatar
      name={record.displayName}
      colorfulFallback
      avatarTooltipOptions={{ content: tooltip ?? record.displayName }}
      data-myoxus-ui-role="database-presence-avatar"
      data-myoxus-database-presence-dot="true"
      data-dragging={record.dragging ? "true" : undefined}
    />
  );
}

/**
 * Shared item/cell presence slot. The host chooses an existing semantic slot;
 * this component never adds absolute geometry, outlines or local colors.
 */
export function DatabasePresenceIndicator({
  records,
  dragging,
  ariaLabel,
  children,
  ...props
}: DatabasePresenceIndicatorProps) {
  return (
    <CountIndicator
      {...props}
      count={records.length}
      disabled={records.length === 0}
      aria-label={ariaLabel}
      data-myoxus-ui-role="database-presence-indicator"
      data-myoxus-database-presence-indicator="true"
      data-dragging={dragging ? "true" : undefined}
    >
      {children ?? (
        <AvatarStack data-myoxus-ui-role="database-presence-indicator-avatars">
          {records.map((record) => (
            <DatabasePresenceDot key={record.socketId} record={record} />
          ))}
        </AvatarStack>
      )}
    </CountIndicator>
  );
}
