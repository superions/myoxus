/**
 * Detail page header — the title bar rendered above the document editor.
 *
 * Responsible for:
 * - Displaying the document title as stable header context for non-journal pages.
 * - Rendering the mode switch (page ↔ edgeless toggle) as the left header control.
 * - Showing the favourite state next to the title and the document menu on the right.
 * - Providing document drag data for workbench drop targets.
 * - Registering "Copy Link" commands via `useRegisterCopyLinkCommands`.
 *
 * Two header variants are rendered based on document type:
 * - `JournalPageHeader` — shows journal week navigation, the contextual
 *   "Today" button and the shared tools-only burger. It intentionally omits
 *   document mode, share and generic document actions so an opened journal
 *   keeps the same header semantics as the `/journals` overview.
 * - `NormalPageHeader` — shows mode, title/favourite, and the consolidated
 *   document menu. Document commands live in the menu or contextual side panels,
 *   not as a busy header action row.
 *
 * Both variants are composed by `DetailPageHeader` which also wraps them in
 * a drag-enabled container and supplies a custom drag preview.
 */
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

/**
 * Template badge displayed in the header when the open document is a template.
 *
 * Renders a small "Template" label chip. Returns `null` for non-template docs
 * so it can be placed unconditionally in the header tree.
 */
const TemplateMark = memo(function TemplateMark({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const t = useI18n();
  const doc = useService(DocService).doc;
  const templateDocService = useService(TemplateDocService);
  const isTemplate = useLiveData(templateDocService.list.isTemplate$(doc.id));
  const metadata = useService(DocumentMetadataCacheService);
  const rows = useLiveData(metadata.watchIndexRows());

  if (
    !isTemplate ||
    rows.find((row) => row.externalId === doc.id)?.templateState === "guide"
  )
    return null;

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

interface PageHeaderProps {
  page: Store;
  workspace: Workspace;
}
/**
 * Header for journal (daily note) documents.
 *
 * Shows the same journal navigation chrome as the `/journals` overview. Daily
 * journals are document-backed, but their header is still date navigation, not
 * generic document chrome. The shared tools burger is available in both Journal
 * states; mode switching, sharing and document actions remain regular-document
 * commands.
 *
 * @param page - The Virgultum `Store` instance for the open document.
 */
export function JournalPageHeader({ page }: PageHeaderProps) {
  const journalService = useService(JournalService);
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const workbench = useService(WorkbenchService).workbench;
  const i18n = useI18n();
  const title = i18n.t(useLiveData(docDisplayMetaService.title$(page.id)));
  const journalDateStr = useLiveData(journalService.journalDate$(page.id));
  const dateString = (journalDateStr ? dayjs(journalDateStr) : dayjs()).format(
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

/**
 * Header for regular (non-journal) documents.
 *
 * Contains the mode switch, a stable non-editing title, the favourite star, and
 * the consolidated document menu. Renaming stays out of this header so the
 * title bar remains context chrome rather than an editing surface.
 *
 * @param page - The Virgultum `Store` instance for the open document.
 */
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

/**
 * Composite detail page header with drag-to-tab support.
 *
 * Selects between `<JournalPageHeader>` and `<NormalPageHeader>` based on
 * whether the document is a journal page. Wraps the chosen header in a
 * drag-enabled container so the user can drag the tab out into a new view or
 * re-order it. Trash pages always use the normal header variant.
 *
 * Drag data conforms to `MyoxusDNDData` and includes `from: 'doc-detail:header'`
 * so drop targets can distinguish header drags from sidebar drags.
 *
 * @param page - The Virgultum `Store` instance for the open document.
 * @param workspace - The currently active workspace.
 * @param onDragging - Optional callback notified whenever the drag state changes.
 */
export function DetailPageHeader(
  props: PageHeaderProps & {
    onDragging?: (dragging: boolean) => void;
  },
) {
  const { page, workspace, onDragging } = props;
  const journalService = useService(JournalService);
  const isJournal = !!useLiveData(journalService.journalDate$(page.id));
  const isInTrash = page.meta?.trash;

  useRegisterCopyLinkCommands({
    workspaceMeta: workspace.meta,
    docId: page.id,
  });

  const { dragRef, dragging, CustomDragPreview } =
    useDraggable<MyoxusDNDData>(() => {
      return {
        data: {
          from: {
            at: "doc-detail:header",
            docId: page.id,
          },
          entity: {
            type: "doc",
            id: page.id,
          },
        },
        canDrag: (args) => {
          // hack for preventing drag when editing the page title
          const editingElement =
            args.element.contains(document.activeElement) &&
            document.activeElement?.tagName === "INPUT";
          return !editingElement;
        },
        onDragStart: () => {
          track.$.header.$.dragStart();
        },
        dragPreviewPosition: "pointer-outside",
      };
    }, [page.id]);

  const inner =
    isJournal && !isInTrash ? (
      <JournalPageHeader {...props} />
    ) : (
      <NormalPageHeader {...props} />
    );

  useEffect(() => {
    onDragging?.(dragging);
  }, [dragging, onDragging]);

  return (
    <>
      <WorkbenchDocumentHeaderRoot ref={dragRef} dragging={dragging}>
        {inner}
      </WorkbenchDocumentHeaderRoot>
      <CustomDragPreview>
        <WorkbenchDocumentHeaderDragPreview>
          {inner}
        </WorkbenchDocumentHeaderDragPreview>
      </CustomDragPreview>
    </>
  );
}
