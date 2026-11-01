import { Guard } from "@myoxus/core/components/guard";
import { MoveToTrash } from "@myoxus/core/components/page-list";
import {
  type DocRecord,
  DocService,
  DocsService,
} from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { JournalService } from "@myoxus/core/modules/journal";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { CalendarXmarkIcon, EditIcon, TodayIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  IconButton,
  MenuInlineText,
  MobileMenu,
  MobileMenuItem,
  MobileMenuSub,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { type MouseEvent, useCallback, useMemo } from "react";

export const ResolveConflictOperations = ({
  docRecord,
}: {
  docRecord: DocRecord;
}) => {
  const t = useI18n();
  const journalService = useService(JournalService);
  const { openConfirmModal } = useConfirmModal();

  const handleOpenTrashModal = useCallback(
    (docRecord: DocRecord) => {
      openConfirmModal({
        title: t["com.myoxus.moveToTrash.confirmModal.title"](),
        description: t["com.myoxus.moveToTrash.confirmModal.description"]({
          title: docRecord.title$.value || t["Untitled"](),
        }),
        cancelText: t["com.myoxus.confirmModal.button.cancel"](),
        confirmText: t.Delete(),
        confirmButtonOptions: {
          variant: "error",
        },
        onConfirm: () => {
          docRecord.moveToTrash();
        },
      });
    },
    [openConfirmModal, t],
  );
  const handleRemoveJournalMark = useCallback(
    (docId: string) => {
      journalService.removeJournalDate(docId);
    },
    [journalService],
  );

  return (
    <>
      <Guard docId={docRecord.id} permission="Doc_Update">
        {(canEdit) => (
          <MobileMenuItem
            prefixIcon={<CalendarXmarkIcon />}
            onClick={() => {
              handleRemoveJournalMark(docRecord.id);
            }}
            data-testid="journal-conflict-remove-mark"
            disabled={!canEdit}
          >
            {t["com.myoxus.page-properties.property.journal-remove"]()}
          </MobileMenuItem>
        )}
      </Guard>
      <Guard docId={docRecord.id} permission="Doc_Trash">
        {(canTrash) => (
          <MoveToTrash
            onSelect={() => handleOpenTrashModal(docRecord)}
            disabled={!canTrash}
          />
        )}
      </Guard>
    </>
  );
};

const preventNav = (e: MouseEvent<HTMLButtonElement>) => {
  e.stopPropagation();
  e.preventDefault();
};

const DocItem = ({ docRecord }: { docRecord: DocRecord }) => {
  const docId = docRecord.id;
  const i18n = useI18n();
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const Icon = useLiveData(docDisplayMetaService.icon$(docId));
  const title = useLiveData(docDisplayMetaService.title$(docId));
  return (
    <WorkbenchLink aria-label={title} to={`/${docId}`}>
      <MobileMenuItem
        prefixIcon={<Icon />}
        suffix={
          <MobileMenu
            items={<ResolveConflictOperations docRecord={docRecord} />}
          >
            <IconButton onClick={preventNav} icon={<EditIcon />} />
          </MobileMenu>
        }
      >
        <MenuInlineText
          data-myoxus-ui-role="mobile-journal-conflict-doc"
          truncate={false}
        >
          <span>{title}</span>
          <Badge
            data-myoxus-ui-role="mobile-journal-conflict-duplicate-badge"
            tone="error"
          >
            {i18n["com.myoxus.page-properties.property.journal-duplicated"]()}
          </Badge>
        </MenuInlineText>
      </MobileMenuItem>
    </WorkbenchLink>
  );
};

export const ConflictList = ({ docRecords }: { docRecords: DocRecord[] }) => {
  return docRecords.map((docRecord) => (
    <DocItem key={docRecord.id} docRecord={docRecord} />
  ));
};

export const MobileJournalConflictList = ({ date }: { date: string }) => {
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

  return <ConflictList docRecords={docRecords} />;
};

const ConflictListMenuItem = ({ docRecords }: { docRecords: DocRecord[] }) => {
  const t = useI18n();
  return (
    <MobileMenuSub
      triggerOptions={{
        prefixIcon: <TodayIcon />,
        type: "danger",
      }}
      items={<ConflictList docRecords={docRecords} />}
    >
      {t["com.myoxus.m.selector.journal-menu.conflicts"]()}
    </MobileMenuSub>
  );
};

const JournalConflictsChecker = ({ date }: { date: string }) => {
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

  return <ConflictListMenuItem docRecords={docRecords} />;
};

export const JournalConflictsMenuItem = () => {
  const journalService = useService(JournalService);
  const docId = useService(DocService).doc.id;
  const journalDate = useLiveData(journalService.journalDate$(docId));

  if (!journalDate) return null;

  return <JournalConflictsChecker date={journalDate} />;
};
