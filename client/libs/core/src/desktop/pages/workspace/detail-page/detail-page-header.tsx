// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DocumentHeaderMenuButton } from "@myoxus/core/components/document-header-menu";
import { useRegisterCopyLinkCommands } from "@myoxus/core/components/hooks/myoxus/use-register-copy-link-commands";
import { FavoriteButton } from "@myoxus/core/editor/virgultum/doc-header/favorite";
import { PublicStatusButton } from "@myoxus/core/editor/virgultum/doc-header/public-status";
import { EditorModeSwitch } from "@myoxus/core/editor/virgultum/mode-switch";
import { DocService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { EditorService } from "@myoxus/core/modules/editor";
import {
  JOURNAL_DATE_FORMAT,
  JournalService,
} from "@myoxus/core/modules/journal";
import { OrganizeService } from "@myoxus/core/modules/organize";
import { TemplateDocService } from "@myoxus/core/modules/template-doc";
import {
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import type { Workspace } from "@myoxus/core/modules/workspace";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  Badge,
  Group,
  useDraggable,
  WorkbenchDocumentHeaderDragPreview,
  WorkbenchDocumentHeaderRoot,
  WorkbenchHeaderContextPath,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import type { Store } from "@virgultum/editor/store";
import dayjs from "dayjs";
import {
  type HTMLAttributes,
  memo,
  useCallback,
  useEffect,
  useMemo,
} from "react";

import { JournalWorkbenchHeader } from "../journals/journal-workbench-header";

export interface PageHeaderProps {
  page: Store;
  workspace: Workspace;
}

const TemplateMark = memo(function TemplateMark({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const t = useI18n();
  const doc = useService(DocService).doc;
  const templateDocService = useService(TemplateDocService);
  const metadata = useService(DocumentMetadataCacheService);
  const isTemplate = useLiveData(templateDocService.list.isTemplate$(doc.id));
  const rows = useLiveData(metadata.watchIndexRows());

  if (
    !isTemplate ||
    rows.find((row) => row.externalId === doc.id)?.templateState === "guide"
  ) {
    return null;
  }

  return (
    <Badge
      {...props}
      tone="info"
      className={className}
      data-myoxus-ui-role="workbench-document-template-badge"
    >
      {t["Template"]()}
    </Badge>
  );
});

export function JournalPageHeader({ page }: PageHeaderProps) {
  const journalService = useService(JournalService);
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const workbench = useService(WorkbenchService).workbench;
  const i18n = useI18n();

  const title = i18n.t(useLiveData(docDisplayMetaService.title$(page.id)));
  const journalDate = useLiveData(journalService.journalDate$(page.id));
  const dateString = (journalDate ? dayjs(journalDate) : dayjs()).format(
    JOURNAL_DATE_FORMAT,
  );

  const openJournal = useCallback(
    (date: string) => {
      const docs = journalService.getJournalsByDate(date);
      if (docs.length > 0) {
        workbench.openDoc(docs[0].id, { at: "active" });
        return;
      }
      workbench.open(`/journals?date=${date}`, { at: "active" });
    },
    [journalService, workbench],
  );

  return (
    <JournalWorkbenchHeader
      dateString={dateString}
      title={title}
      onDateChange={openJournal}
    />
  );
}

export function NormalPageHeader({ page }: PageHeaderProps) {
  const editor = useService(EditorService).editor;
  const currentMode = useLiveData(editor.mode$);
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const organizeService = useService(OrganizeService);
  const i18n = useI18n();

  const title = i18n.t(useLiveData(docDisplayMetaService.title$(page.id)));
  const folderPath$ = useMemo(
    () => organizeService.folderTree.folderPathNamesForLinkedDoc$(page.id),
    [organizeService, page.id],
  );
  const folderPath = useLiveData(folderPath$);

  return (
    <>
      <ViewTitle title={title} />
      <ViewIcon icon={currentMode ?? "page"} />
      <WorkbenchHeaderFrame
        data-myoxus-ui-role="workbench-document-header-frame"
        left={<EditorModeSwitch />}
        title={
          <WorkbenchHeaderContextPath
            current={title}
            parents={[i18n["All content"](), ...folderPath]}
          />
        }
        right={
          <Group wrap="nowrap">
            <FavoriteButton pageId={page.id} />
            <PublicStatusButton pageId={page.id} />
            <TemplateMark />
            <DocumentHeaderMenuButton page={page} />
          </Group>
        }
      />
    </>
  );
}

export function DetailPageHeader(
  props: PageHeaderProps & {
    onDragging?: (dragging: boolean) => void;
  },
) {
  const { page, workspace, onDragging } = props;
  const journalService = useService(JournalService);
  const isJournal = Boolean(useLiveData(journalService.journalDate$(page.id)));
  const isInTrash = page.meta?.trash;

  useRegisterCopyLinkCommands({
    workspaceMeta: workspace.meta,
    docId: page.id,
  });

  const { dragRef, dragging, CustomDragPreview } = useDraggable<MyoxusDNDData>(
    () => ({
      data: {
        from: { at: "doc-detail:header", docId: page.id },
        entity: { type: "doc", id: page.id },
      },
      canDrag: (args) =>
        !(
          args.element.contains(document.activeElement) &&
          document.activeElement?.tagName === "INPUT"
        ),
      onDragStart: () => {
        track.$.header.$.dragStart();
      },
      dragPreviewPosition: "pointer-outside",
    }),
    [page.id],
  );

  useEffect(() => {
    onDragging?.(dragging);
  }, [dragging, onDragging]);

  const header =
    isJournal && !isInTrash ? (
      <JournalPageHeader {...props} />
    ) : (
      <NormalPageHeader {...props} />
    );

  return (
    <>
      <WorkbenchDocumentHeaderRoot ref={dragRef} dragging={dragging}>
        {header}
      </WorkbenchDocumentHeaderRoot>
      <CustomDragPreview>
        <WorkbenchDocumentHeaderDragPreview>
          {header}
        </WorkbenchDocumentHeaderDragPreview>
      </CustomDragPreview>
    </>
  );
}
