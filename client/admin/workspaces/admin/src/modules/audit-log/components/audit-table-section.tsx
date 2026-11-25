// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared filter and paginated table frame for Admin audit-log surfaces
 * (`audit-log` and `documents/audit-tab`).
 */
import { useI18n } from "@myoxus/i18n";
import {
  Pagination,
  SettingsEmptyState,
  SettingsListItemMeta,
  SettingsToolbar,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export interface AuditTableColumn {
  key: string;
  label: ReactNode;
}

export function AuditPaginatedTable({
  columns,
  entryCount,
  totalCount,
  offset,
  pageSize,
  onOffsetChange,
  emptyTitle,
  children,
  "data-testid": dataTestId,
}: {
  columns: AuditTableColumn[];
  entryCount: number;
  totalCount: number;
  offset: number;
  pageSize: number;
  onOffsetChange: (nextOffset: number) => void;
  emptyTitle: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  const i18n = useI18n();
  const rangeStart = entryCount === 0 || totalCount === 0 ? 0 : offset + 1;
  const rangeEnd =
    entryCount === 0 ? 0 : Math.min(offset + entryCount, totalCount);
  const pageNum = Math.floor(offset / pageSize);

  return (
    <Stack data-testid={dataTestId}>
      <SettingsToolbar justify="space-between">
        <SettingsListItemMeta>
          {rangeStart}-{rangeEnd} / {totalCount}
        </SettingsListItemMeta>
        <Pagination
          totalCount={totalCount}
          pageNum={pageNum}
          countPerPage={pageSize}
          previousLabel={i18n.t("admin.audit-log.previous")}
          nextLabel={i18n.t("admin.audit-log.next")}
          onPageChange={(skip) => onOffsetChange(skip)}
        />
      </SettingsToolbar>
      {entryCount === 0 ? (
        <SettingsEmptyState title={emptyTitle} />
      ) : (
        <TableScrollContainer>
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((column) => (
                  <TableHead key={column.key}>{column.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>{children}</TableBody>
          </Table>
        </TableScrollContainer>
      )}
    </Stack>
  );
}
