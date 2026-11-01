// SPDX-License-Identifier: AGPL-3.0-or-later

import { WORKSPACE_DATABASE_PAGE_SIZE } from "@myoxus/core/modules/database/model";
import type { DatabasePageIdentityFragment } from "@myoxus/graphql";

import { workspacePageKey } from "./identity";

export interface DatabasePageRecord {
  createdAt: string;
  description: string | null;
  deletedAt?: string | null;
  editRevision: number;
  id: string;
  key: string;
  profileKind: DatabasePageIdentityFragment["profileKind"];
  systemRole?: DatabasePageIdentityFragment["systemRole"];
  title: string;
  updatedAt: string;
}

export class DatabasePageLoadError extends Error {
  constructor(
    readonly failedOffset: number,
    readonly records: DatabasePageRecord[],
    options?: ErrorOptions,
  ) {
    super("Unable to load the complete Database Page inventory", options);
    this.name = "DatabasePageLoadError";
  }
}

export function projectDatabasePage(
  database: DatabasePageIdentityFragment,
): DatabasePageRecord {
  return {
    createdAt: database.createdAt,
    description: database.description,
    deletedAt: database.deletedAt,
    editRevision: database.editRevision,
    id: database.id,
    key: workspacePageKey({ kind: "database", id: database.id }),
    profileKind: database.profileKind,
    systemRole: database.systemRole,
    title: database.title,
    updatedAt: database.updatedAt,
  };
}

export interface LoadDatabasePagesOptions {
  existingRecords?: readonly DatabasePageRecord[];
  fetchPage: (
    offset: number,
    pageSize: number,
  ) => Promise<readonly DatabasePageIdentityFragment[]>;
  isCurrent?: () => boolean;
  onPage?: (records: readonly DatabasePageRecord[], nextOffset: number) => void;
  startOffset?: number;
}

/**
 * Load the authorized Database inventory without guessing a server total.
 * Later-page retries resume from the exact failed offset while the ID map
 * prevents duplicate records from retries or overlapping server pages.
 */
export async function loadDatabasePages({
  existingRecords = [],
  fetchPage,
  isCurrent = () => true,
  onPage,
  startOffset = 0,
}: LoadDatabasePagesOptions): Promise<DatabasePageRecord[]> {
  const recordsById = new Map(
    existingRecords.map((record) => [record.id, record] as const),
  );
  let offset = startOffset;

  while (isCurrent()) {
    let page: readonly DatabasePageIdentityFragment[];
    try {
      page = await fetchPage(offset, WORKSPACE_DATABASE_PAGE_SIZE);
    } catch (cause) {
      throw new DatabasePageLoadError(offset, [...recordsById.values()], {
        cause,
      });
    }

    if (!isCurrent()) return [...recordsById.values()];

    for (const record of page) {
      recordsById.set(record.id, projectDatabasePage(record));
    }
    offset += page.length;
    onPage?.([...recordsById.values()], offset);

    if (page.length < WORKSPACE_DATABASE_PAGE_SIZE) break;
  }

  return [...recordsById.values()];
}
