// SPDX-License-Identifier: AGPL-3.0-or-later

export type DashboardDocument = {
  createDate?: number;
  id: string;
  journalDate?: string;
  mode: "edgeless" | "page";
  title: string;
  trash: boolean;
  updatedDate?: number;
};

function isVisibleDocument(document: DashboardDocument) {
  return !document.trash && (!document.journalDate || document.updatedDate);
}

function compareTimestamp(
  left: DashboardDocument,
  right: DashboardDocument,
  timestamp: "createDate" | "updatedDate",
) {
  const difference = (right[timestamp] ?? 0) - (left[timestamp] ?? 0);
  return difference || left.id.localeCompare(right.id);
}

/**
 * Projects the synchronized document inventory for Workspace Home.
 *
 * The projections intentionally overlap and never use search pages or
 * device-local recents. Keeping this function pure makes trash, empty-journal
 * and stable tie-break behavior directly testable.
 */
export function projectDashboardDocuments(
  documents: readonly DashboardDocument[],
  limit = 6,
) {
  const visible = documents.filter(isVisibleDocument);
  return {
    newDocuments: visible
      .filter((document) => document.createDate != null)
      .sort((left, right) => compareTimestamp(left, right, "createDate"))
      .slice(0, limit),
    recentlyEdited: visible
      .filter((document) => document.updatedDate != null)
      .sort((left, right) => compareTimestamp(left, right, "updatedDate"))
      .slice(0, limit),
  };
}
