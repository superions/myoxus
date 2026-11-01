import { sortPagesByDate } from "@myoxus/core/desktop/pages/workspace/detail-page/sidecards/journal";
import {
  type DocRecord,
  DocService,
  DocsService,
} from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { JournalService } from "@myoxus/core/modules/journal";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { HistoryIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  MenuInlineText,
  MenuItem,
  MenuSectionLabel,
  MenuSeparator,
  MobileMenuSub,
} from "@myoxus/ui-facade";
import dayjs from "dayjs";
import { type ReactNode, useCallback, useMemo } from "react";

interface JournalTodayActivityMenuItemProps {
  prefix?: ReactNode;
  suffix?: ReactNode;
}
type Category = "created" | "updated";

const DocItem = ({ docId }: { docId: string }) => {
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const Icon = useLiveData(docDisplayMetaService.icon$(docId));
  const title = useLiveData(docDisplayMetaService.title$(docId));
  return (
    <WorkbenchLink aria-label={title} to={`/${docId}`}>
      <MenuItem prefixIcon={<Icon />}>{title}</MenuItem>
    </WorkbenchLink>
  );
};

const ActivityBlock = ({
  name,
  list,
}: {
  name: Category;
  list: DocRecord[];
}) => {
  const t = useI18n();

  const title =
    name === "created"
      ? t["com.myoxus.journal.created-today"]()
      : t["com.myoxus.journal.updated-today"]();
  return (
    <>
      <MenuSectionLabel data-myoxus-ui-role="mobile-journal-activity-title">
        {title}
      </MenuSectionLabel>
      {list.length > 0 ? (
        list.map((doc) => {
          return <DocItem docId={doc.id} key={doc.id} />;
        })
      ) : (
        <MenuInlineText
          data-myoxus-ui-role="mobile-journal-activity-empty"
          tone="secondary"
          truncate={false}
        >
          {name === "created"
            ? t["com.myoxus.journal.daily-count-created-empty-tips"]()
            : t["com.myoxus.journal.daily-count-updated-empty-tips"]()}
        </MenuInlineText>
      )}
    </>
  );
};

const TodaysActivity = ({ date }: { date: string }) => {
  const docRecords = useLiveData(useService(DocsService).list.docs$);
  const getTodaysPages = useCallback(
    (field: "createDate" | "updatedDate") => {
      return sortPagesByDate(
        docRecords.filter((docRecord) => {
          const meta = docRecord.meta$.value;
          if (meta.trash) return false;
          return meta[field] && dayjs(meta[field]).isSame(date, "day");
        }),
        field,
      );
    },
    [date, docRecords],
  );

  const createdToday = useMemo(
    () => getTodaysPages("createDate"),
    [getTodaysPages],
  );
  const updatedToday = useMemo(
    () => getTodaysPages("updatedDate"),
    [getTodaysPages],
  );

  return (
    <>
      <ActivityBlock name="created" list={createdToday} />
      <MenuSeparator />
      <ActivityBlock name="updated" list={updatedToday} />
    </>
  );
};

export const JournalTodayActivityMenuItem = ({
  prefix,
  suffix,
}: JournalTodayActivityMenuItemProps) => {
  const docService = useService(DocService);
  const journalService = useService(JournalService);

  const docId = docService.doc.id;
  const journalDate = useLiveData(journalService.journalDate$(docId));

  const t = useI18n();

  if (!journalDate) return null;

  return (
    <>
      {prefix}
      <MobileMenuSub
        triggerOptions={{
          prefixIcon: <HistoryIcon />,
        }}
        items={<TodaysActivity date={journalDate} />}
        title={t["com.myoxus.m.selector.journal-menu.today-activity"]()}
      >
        {t["com.myoxus.m.selector.journal-menu.today-activity"]()}
      </MobileMenuSub>
      {suffix}
    </>
  );
};
