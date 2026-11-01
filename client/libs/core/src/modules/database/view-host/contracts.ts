// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseRowGroupSummaryFragment } from "@myoxus/graphql";
import type { ReactNode, RefObject } from "react";

import type { DatabaseChangeEventPayload } from "../presence";
import type { DatabaseRowDetailLoadState } from "../row-detail";
import type { DatabaseChangeHandler } from "../shared/change-invalidation";
import type {
  DatabaseRecord,
  DatabaseView,
  DatabaseRowRecord,
  DatabaseRowTemplateBinding,
} from "../types";

/** Stable route/embed contract for the server-backed Database view host. */
export interface DatabaseViewHostProps {
  activeViewId: string | null;
  databaseId: string;
  /** Optional server-validated Row deep link opened in the canonical detail host. */
  initialRowId?: string | null;
  initialRowLoadState?: DatabaseRowDetailLoadState | null;
  /** Retains the list while current route-owner admission hides all detail content. */
  ownerAdmissionPending?: boolean;
  layout?: "page" | "embedded";
  onActiveViewChange: (viewId: string | null) => void;
  onChanged: DatabaseChangeHandler;
  /** Writes a canonical standalone Row URL for the active View. */
  onCopyRowLink?: (rowId: string, viewId: string) => Promise<boolean>;
  /** Writes the canonical standalone Database View URL to the clipboard. */
  onCopyViewLink?: (viewId: string) => Promise<boolean>;
  onExportCsvRows?: (rowIds: string[]) => Promise<void> | void;
  onOpenDoc: (docId: string) => void;
  onRemoteChange?: (event: DatabaseChangeEventPayload) => Promise<void> | void;
  /** Keeps the canonical Row deep link synchronized with detail open/close. */
  onRowDetailChange?: (rowId: string | null) => void;
  /** Refreshes only server-filtered temporal rows after schedule mutations. */
  onScheduleChanged?: DatabaseChangeHandler;
  onScheduleDateChange?: (date: string) => void;
  onSearchChange?: (value: string) => void;
  pagination?: ReactNode;
  /** Renders standalone View navigation in the owning Workbench header. */
  renderPageHeader?: (
    navigation: ReactNode,
    assistanceItems?: ReactNode,
  ) => ReactNode;
  assistanceReturnFocusRef?: RefObject<HTMLButtonElement | null>;
  record: DatabaseRecord;
  rowTemplates?: DatabaseRowTemplateBinding[];
  rows: DatabaseRowRecord[];
  rowGroups?: DatabaseRowGroupSummaryFragment[];
  /** Keeps confirmed structure mounted while a transient Row read is unavailable. */
  rowsError?: "offline" | "unavailable";
  /** Shows readback progress while Gantt retains its last complete snapshot. */
  rowsLoading?: boolean;
  /** Gantt geometry stays on the confirmed Row window until the next readback. */
  rowsScheduleDate?: string | null;
  /** Fields, grouping and zoom belong to the same complete snapshot as Rows. */
  rowsScheduleView?: DatabaseView | null;
  /** Retries authoritative demand; the owning loader may choose a safe full reload. */
  onRowsRetry?: () => void;
  scheduleDate?: string;
  search?: string;
  workspaceId: string;
}
