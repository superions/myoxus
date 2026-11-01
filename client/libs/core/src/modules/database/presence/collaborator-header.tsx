// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Avatar,
  AvatarStack,
  Badge,
  CountIndicator,
  Group,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
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

export interface DatabaseCollaboratorHeaderProps {
  records: ReadonlyArray<DatabasePresenceRecord>;
  maxAvatars?: number;
  localSocketId?: string;
  label: string;
  onlyYouLabel: string;
  oneCollaboratorLabel: (displayName: string) => string;
  manyCollaboratorsLabel: (count: number) => string;
  moreLabel: (count: number) => string;
  recordMetaLabel: (record: DatabasePresenceRecord) => string;
}

/** Shared Facade/Mantine collaborator summary for every Database view. */
export function DatabaseCollaboratorHeader({
  records,
  maxAvatars = 5,
  localSocketId,
  label,
  onlyYouLabel,
  oneCollaboratorLabel,
  manyCollaboratorsLabel,
  moreLabel,
  recordMetaLabel,
}: DatabaseCollaboratorHeaderProps) {
  const localRecord = records.find(
    (record) => record.socketId === localSocketId,
  );
  const others = records.filter((record) => record.socketId !== localSocketId);
  const displayedRecords =
    others.length > 0 ? others : localRecord ? [localRecord] : [];
  const visible = displayedRecords.slice(0, maxAvatars);
  const overflow = others.length - visible.length;

  return (
    <Group
      gap="sm"
      align="center"
      wrap="nowrap"
      aria-label={label}
      data-myoxus-database-collaborator-header="true"
    >
      {visible.length > 0 ? (
        <AvatarStack data-myoxus-ui-role="database-collaborator-stack">
          {visible.map((record) => (
            <DatabasePresenceDot
              key={record.socketId}
              record={record}
              tooltip={
                <Stack gap="none">
                  <MyoxusText>{record.displayName}</MyoxusText>
                  <MyoxusText typographySlot="body-small" tone="secondary">
                    {recordMetaLabel(record)}
                  </MyoxusText>
                </Stack>
              }
            />
          ))}
        </AvatarStack>
      ) : null}
      {overflow > 0 ? (
        <Badge tone="neutral" aria-label={moreLabel(overflow)}>
          +{overflow}
        </Badge>
      ) : null}
      <MyoxusText>
        {others.length === 0
          ? onlyYouLabel
          : others.length === 1
            ? oneCollaboratorLabel(others[0]!.displayName)
            : manyCollaboratorsLabel(others.length)}
      </MyoxusText>
      {displayedRecords.length === 1 ? (
        <MyoxusText typographySlot="body-small" tone="secondary">
          {recordMetaLabel(displayedRecords[0]!)}
        </MyoxusText>
      ) : null}
    </Group>
  );
}
