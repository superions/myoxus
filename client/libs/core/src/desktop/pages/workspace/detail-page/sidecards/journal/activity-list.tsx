// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Journal activity rows shared by the activity sidecard. */
import type { DocRecord } from "@myoxus/core/modules/doc";
import { DocsService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  EmptyState,
  SidebarNavItem,
  SidebarNavSection,
} from "@myoxus/ui-facade";
import dayjs, { type Dayjs } from "dayjs";
import { useMemo } from "react";

export type JournalActivityRecord = Pick<DocRecord, "id" | "meta$">;
type JournalActivityKind = "new" | "updated" | "both";

export interface JournalActivityItem {
  docId: string;
  kind: JournalActivityKind;
  timestamp: number;
}

export function buildJournalActivityItems(
  records: readonly JournalActivityRecord[],
  date: Dayjs,
): JournalActivityItem[] {
  const items: JournalActivityItem[] = [];

  for (const record of records) {
    const meta = record.meta$.value;
    if (meta.trash) continue;

    const createdAt = meta.createDate ? dayjs(meta.createDate) : null;
    const updatedAt = meta.updatedDate ? dayjs(meta.updatedDate) : null;
    const created = createdAt?.isSame(date, "day") ?? false;
    const updated = updatedAt?.isSame(date, "day") ?? false;
    if (!created && !updated) continue;

    items.push({
      docId: record.id,
      kind: created && updated ? "both" : created ? "new" : "updated",
      timestamp: Math.max(
        created ? (createdAt?.valueOf() ?? 0) : 0,
        updated ? (updatedAt?.valueOf() ?? 0) : 0,
      ),
    });
  }

  return items.sort((left, right) => right.timestamp - left.timestamp);
}

const activityTagTone = (kind: JournalActivityKind) =>
  kind === "new" ? "success" : kind === "updated" ? "info" : "neutral";

export function JournalActivityList({ date }: { date: Dayjs }) {
  const t = useI18n();
  const docRecords = useLiveData(useService(DocsService).list.docs$);
  const items = useMemo(
    () => buildJournalActivityItems(docRecords, date),
    [date, docRecords],
  );

  if (items.length === 0) {
    return (
      <EmptyState
        title={t["com.myoxus.journal.changes.empty"]()}
        data-testid="journal-activity-empty"
      />
    );
  }

  return (
    <SidebarNavSection
      data-myoxus-ui-role="journal-activity-list"
      data-testid="journal-activity-list"
    >
      {items.map((item) => (
        <JournalActivityRow key={item.docId} item={item} />
      ))}
    </SidebarNavSection>
  );
}

function JournalActivityRow({ item }: { item: JournalActivityItem }) {
  const t = useI18n();
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const Icon = useLiveData(docDisplayMetaService.icon$(item.docId));
  const title = useLiveData(docDisplayMetaService.title$(item.docId));

  const tagLabel =
    item.kind === "both"
      ? t["com.myoxus.journal.changes.tag-new-and-updated"]()
      : item.kind === "new"
        ? t["com.myoxus.journal.changes.tag-new"]()
        : t["com.myoxus.journal.changes.tag-updated"]();

  return (
    <SidebarNavItem
      component={WorkbenchLink}
      to={`/${item.docId}`}
      aria-label={title}
      actions={
        <Badge
          tone={activityTagTone(item.kind)}
          data-myoxus-ui-role="status-badge"
        >
          {tagLabel}
        </Badge>
      }
      icon={<Icon aria-hidden="true" />}
      data-myoxus-ui-role="journal-activity-row"
      data-testid="journal-activity-item"
    >
      {title}
    </SidebarNavItem>
  );
}
