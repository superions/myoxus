// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Journal conflict notice rendered in the editor surface. */
import { Guard } from "@myoxus/core/components/guard";
import { useDocumentOperations } from "@myoxus/core/components/hooks/myoxus/use-document-operations";
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
import { CalendarXmarkIcon, EditIcon } from "@myoxus/icons/react";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import {
  Badge,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  SidebarNavItem,
  SidebarNavSection,
  SidebarSectionContent,
  useConfirmModal,
} from "@myoxus/ui-facade";
import dayjs, { type Dayjs } from "dayjs";
import {
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useMemo,
} from "react";

interface PageItemProps extends Omit<
  HTMLAttributes<HTMLAnchorElement>,
  "onClick"
> {
  docId: string;
  right?: ReactNode;
  duplicate?: boolean;
}

const PageItem = ({
  docId,
  right,
  duplicate,
  "aria-selected": ariaSelected,
  ...attrs
}: PageItemProps) => {
  const t = useI18n();
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const Icon = useLiveData(docDisplayMetaService.icon$(docId));
  const title = useLiveData(docDisplayMetaService.title$(docId));

  return (
    <SidebarNavItem
      data-testid="journal-conflict-item"
      aria-label={title}
      aria-selected={ariaSelected}
      actions={right}
      actionsInteractive={Boolean(right)}
      component={WorkbenchLink}
      data-myoxus-ui-role="journal-conflict-item"
      icon={<Icon aria-hidden="true" focusable="false" />}
      label={
        <>
          {title}
          {duplicate ? (
            <Badge tone="error" data-myoxus-ui-role="journal-duplicate-badge">
              {t["com.myoxus.page-properties.property.journal-duplicated"]()}
            </Badge>
          ) : null}
        </>
      }
      to={`/${docId}`}
      {...attrs}
    />
  );
};

const MAX_CONFLICT_COUNT = 5;

interface ConflictListProps extends PropsWithChildren<
  HTMLAttributes<HTMLDivElement>
> {
  docRecords: DocRecord[];
  inset?: "none" | "panel";
}

const ConflictList = ({
  docRecords,
  children,
  inset = "panel",
  ...attrs
}: ConflictListProps) => {
  const t = useI18n();
  const currentDocId = useServiceOptional(DocService)?.doc.id;
  const journalService = useService(JournalService);
  const { openConfirmModal } = useConfirmModal();
  const { moveToTrash } = useDocumentOperations();
  const handleOpenTrashModal = useCallback(
    (docRecord: DocRecord) => {
      openConfirmModal({
        title: t["com.myoxus.moveToTrash.confirmModal.title"](),
        description: t["com.myoxus.moveToTrash.confirmModal.description"]({
          title: docRecord.title$.value || t["Untitled"](),
        }),
        cancelText: t["com.myoxus.confirmModal.button.cancel"](),
        confirmButtonOptions: { variant: "error" },
        confirmText: t.Delete(),
        onConfirm: async () => {
          await moveToTrash(docRecord);
        },
      });
    },
    [moveToTrash, openConfirmModal, t],
  );
  const handleRemoveJournalMark = useCallback(
    (docId: string) => journalService.removeJournalDate(docId),
    [journalService],
  );

  return (
    <SidebarSectionContent
      data-testid="journal-conflict-list"
      data-myoxus-ui-role="journal-conflict-list"
      gap="compact"
      inset={inset}
      {...attrs}
    >
      <SidebarNavSection data-myoxus-ui-role="journal-conflict-items">
        {docRecords.map((docRecord) => {
          const isCurrent = currentDocId === docRecord.id;
          return (
            <PageItem
              aria-selected={isCurrent}
              docId={docRecord.id}
              key={docRecord.id}
              duplicate
              right={
                <Menu
                  contentOptions={{ panelWidth: "wide", align: "end" }}
                  items={
                    <>
                      <Guard docId={docRecord.id} permission="Doc_Update">
                        {(canEdit) => (
                          <MenuItem
                            prefixIcon={<CalendarXmarkIcon />}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleRemoveJournalMark(docRecord.id);
                            }}
                            data-testid="journal-conflict-remove-mark"
                            disabled={!canEdit}
                          >
                            {t[
                              "com.myoxus.page-properties.property.journal-remove"
                            ]()}
                          </MenuItem>
                        )}
                      </Guard>
                      <MenuSeparator />
                      <Guard docId={docRecord.id} permission="Doc_Trash">
                        {(canTrash) => (
                          <MoveToTrash
                            onSelect={() => handleOpenTrashModal(docRecord)}
                            disabled={!canTrash}
                          />
                        )}
                      </Guard>
                    </>
                  }
                >
                  <IconButton
                    data-testid="journal-conflict-edit"
                    icon={<EditIcon />}
                  />
                </Menu>
              }
            />
          );
        })}
      </SidebarNavSection>
      {children}
    </SidebarSectionContent>
  );
};

export function JournalConflictBlock({ date }: { date: Dayjs | string }) {
  const t = useI18n();
  const docRecordList = useService(DocsService).list;
  const journalService = useService(JournalService);
  const dateString = dayjs(date).format("YYYY-MM-DD");
  const docs = useLiveData(
    useMemo(
      () => journalService.journalsByDate$(dateString),
      [dateString, journalService],
    ),
  );
  const docRecords = useLiveData(
    docRecordList.docs$.map((records) =>
      records.filter((record) => docs.some((doc) => doc.id === record.id)),
    ),
  );

  if (docs.length <= 1) return null;

  return (
    <section
      data-myoxus-ui-owner="primary-journal"
      data-myoxus-ui-role="journal-conflict-primary"
      data-testid="journal-conflict-primary"
    >
      <ConflictList docRecords={docRecords.slice(0, MAX_CONFLICT_COUNT)}>
        {docs.length > MAX_CONFLICT_COUNT ? (
          <Menu
            items={
              <ConflictList
                docRecords={docRecords.slice(MAX_CONFLICT_COUNT)}
                inset="none"
              />
            }
          >
            <SidebarNavItem data-myoxus-ui-role="button:journal-conflict-more">
              {t["com.myoxus.journal.conflict-show-more"]({
                count: (docRecords.length - MAX_CONFLICT_COUNT).toFixed(0),
              })}
            </SidebarNavItem>
          </Menu>
        ) : null}
      </ConflictList>
    </section>
  );
}
