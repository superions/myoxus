import { type DocRecord, DocsService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { JournalService } from "@myoxus/core/modules/journal";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { EditIcon, TodayIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  IconButton,
  Menu,
  NavigationLink,
  SurfaceList,
  SurfaceListHeader,
  SurfaceListHeaderTitle,
} from "@myoxus/ui-facade";
import { type MouseEvent, useMemo } from "react";

import { ResolveConflictOperations } from "./menu/journal-conflicts";

export const JournalConflictBlock = ({ date }: { date?: string }) => {
  return date ? <JournalConflictChecker date={date} /> : null;
};

const JournalConflictChecker = ({ date }: { date: string }) => {
  const docRecordList = useService(DocsService).list;
  const journalService = useService(JournalService);
  const docs = useLiveData(
    useMemo(() => journalService.journalsByDate$(date), [journalService, date]),
  );
  const docRecords = useLiveData(
    docRecordList.docs$.map((records) =>
      records.filter((v) => {
        return docs.some((doc) => doc.id === v.id);
      }),
    ),
  );

  if (docRecords.length <= 1) return null;

  return <JournalConflictList docRecords={docRecords} />;
};

const JournalConflictList = ({ docRecords }: { docRecords: DocRecord[] }) => {
  const t = useI18n();
  const title = t["com.myoxus.editor.journal-conflict.title"]();

  return (
    <SurfaceList label={title} data-testid="mobile-journal-conflict-list">
      <SurfaceListHeader
        density="section"
        data-myoxus-ui-role="mobile-journal-conflict-header"
      >
        <SurfaceListHeaderTitle tone="danger">{title}</SurfaceListHeaderTitle>
      </SurfaceListHeader>
      <div data-myoxus-ui-role="mobile-journal-conflict-items">
        {docRecords.map((docRecord) => (
          <ConflictItem docRecord={docRecord} key={docRecord.id} />
        ))}
      </div>
    </SurfaceList>
  );
};

const preventNav = (event: MouseEvent<HTMLButtonElement>) => {
  event.preventDefault();
  event.stopPropagation();
};

const ConflictItem = ({ docRecord }: { docRecord: DocRecord }) => {
  const docId = docRecord.id;
  const i18n = useI18n();
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const title = useLiveData(docDisplayMetaService.title$(docId));

  return (
    <NavigationLink
      component={WorkbenchLink}
      data-myoxus-ui-role="mobile-journal-conflict-link"
      label={
        <>
          <span>{title}</span>
          <Badge
            data-myoxus-ui-role="mobile-journal-conflict-duplicate-badge"
            tone="error"
          >
            {i18n["com.myoxus.page-properties.property.journal-duplicated"]()}
          </Badge>
        </>
      }
      leftSection={<TodayIcon />}
      rightSection={
        <Menu items={<ResolveConflictOperations docRecord={docRecord} />}>
          <IconButton onClick={preventNav} icon={<EditIcon />} />
        </Menu>
      }
      to={`/${docId}`}
    />
  );
};
