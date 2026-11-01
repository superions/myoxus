import { useGuard } from "@myoxus/core/components/guard";
import { useDocumentViewContext } from "@myoxus/core/components/hooks/use-document-view-context";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { MyoxusErrorBoundary } from "@myoxus/core/components/myoxus/myoxus-error-boundary";
import { PageDetailEditor } from "@myoxus/core/components/page-detail-editor";
import { DetailPageWrapper } from "@myoxus/core/desktop/pages/workspace/detail-page/detail-page-wrapper";
import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import { PageHeader } from "@myoxus/core/mobile/components";
import { AIButtonService } from "@myoxus/core/modules/ai-button";
import { DocService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { EditorService } from "@myoxus/core/modules/editor";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { JournalService } from "@myoxus/core/modules/journal";
import { ServerService } from "@myoxus/core/modules/server";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { ViewService } from "@myoxus/core/modules/workbench/services/view";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { i18nTime } from "@myoxus/i18n";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import { cssVar } from "@myoxus/theme";
import {
  DetailPageEditorFrame,
  DetailPageMainFrame,
  DetailPageMobileEditorViewport,
  DetailPageMobileRoot,
  DetailPageMobileTitle,
  observeIntersection,
  PageDetailLoading,
  useThemeColor,
} from "@myoxus/ui-facade";
import { DisposableGroup } from "@virgultum/editor/global/disposable";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import {
  customImageProxyMiddleware,
  ImageProxyService,
} from "@virgultum/editor/shared/adapters";
import dayjs from "dayjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

import { AppTabs } from "../../../components";
import { JournalConflictBlock } from "./journal-conflict-block";
import { JournalDatePicker } from "./journal-date-picker";
import { PageHeaderMenuButton } from "./page-header-more-button";
import { PageHeaderShareButton } from "./page-header-share-button";

const MobileDocumentDetailView = ({
  onDocumentTitleVisibilityChange,
}: {
  onDocumentTitleVisibilityChange?: (visible: boolean) => void;
}) => {
  const {
    editorService,
    docService,
    workspaceService,
    featureFlagService,
    aIButtonService,
  } = useServices({
    WorkbenchService,
    ViewService,
    EditorService,
    DocService,
    WorkspaceService,
    FeatureFlagService,
    AIButtonService,
  });
  const editor = editorService.editor;
  const workspace = workspaceService.workspace;
  const docCollection = workspace.docCollection;
  const doc = docService.doc;

  const mode = useLiveData(editor.mode$);

  const isInTrash = useLiveData(doc.meta$.map((meta) => meta.trash));
  const { openPage, jumpToPageBlock } = useNavigateHelper();
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);

  const editorContainer = useLiveData(editor.editorContainer$);

  const enableKeyboardToolbar =
    featureFlagService.flags.enable_mobile_keyboard_toolbar.value;
  const enableEdgelessEditing =
    featureFlagService.flags.enable_mobile_edgeless_editing.value;
  const enableAIButton = useLiveData(
    featureFlagService.flags.enable_mobile_ai_button.$,
  );

  useDocumentViewContext({
    active: true,
    docId: doc.id,
    editorContainer,
    isInTrash,
    mode,
  });

  useEffect(() => {
    if (!enableAIButton) return;
    aIButtonService.presentAIButton(true);

    return () => {
      aIButtonService.presentAIButton(false);
    };
  }, [aIButtonService, enableAIButton]);

  const server = useService(ServerService).server;

  const onLoad = useCallback(
    (editorContainer: MyoxusEditorContainer) => {
      // provide image proxy endpoint to virgultum
      const imageProxyUrl = new URL(
        BUILD_CONFIG.imageProxyUrl,
        server.baseUrl,
      ).toString();

      editorContainer.std.clipboard.use(
        customImageProxyMiddleware(imageProxyUrl),
      );
      editorContainer.doc
        .get(ImageProxyService)
        .setImageProxyURL(imageProxyUrl);

      // provide page mode and updated date to virgultum
      const refNodeService =
        editorContainer.std.getOptional(RefNodeSlotsProvider);
      const disposable = new DisposableGroup();
      if (refNodeService) {
        disposable.add(
          refNodeService.docLinkClicked.subscribe(({ pageId, params }) => {
            if (params) {
              const { mode, blockIds, elementIds } = params;
              return jumpToPageBlock(
                docCollection.id,
                pageId,
                mode,
                blockIds,
                elementIds,
              );
            }

            return openPage(docCollection.id, pageId);
          }),
        );
      }

      const unbind = editor.bindEditorContainer(
        editorContainer,
        editorContainer.docTitle,
        scrollViewportRef.current,
      );

      const titleElement = editorContainer.docTitle;
      if (
        onDocumentTitleVisibilityChange &&
        typeof Element !== "undefined" &&
        typeof IntersectionObserver !== "undefined" &&
        titleElement instanceof Element
      ) {
        // Header-title visibility follows the actual editor title element;
        // this avoids route-local scroll thresholds or viewport breakpoints.
        disposable.add({
          dispose: observeIntersection(titleElement, (entry) =>
            onDocumentTitleVisibilityChange(entry.isIntersecting),
          ),
        });
      } else {
        onDocumentTitleVisibilityChange?.(false);
      }

      return () => {
        unbind();
        disposable.dispose();
      };
    },
    [
      docCollection.id,
      editor,
      jumpToPageBlock,
      onDocumentTitleVisibilityChange,
      openPage,
      server,
    ],
  );

  const canEdit = useGuard("Doc_Update", doc.id);

  const readonly =
    !canEdit ||
    isInTrash ||
    !enableKeyboardToolbar ||
    (mode === "edgeless" && !enableEdgelessEditing);

  return (
    <DetailPageMainFrame>
      <DetailPageEditorFrame>
        <DetailPageMobileEditorViewport
          editorMode={mode}
          ref={scrollViewportRef}
        >
          {/* Add a key to force rerender when page changed, to avoid error boundary persisting. */}
          <MyoxusErrorBoundary key={doc.id}>
            <PageDetailEditor onLoad={onLoad} readonly={readonly} />
          </MyoxusErrorBoundary>
        </DetailPageMobileEditorViewport>
      </DetailPageEditorFrame>
    </DetailPageMainFrame>
  );
};

const getSkeleton = (back: boolean) => (
  <>
    <PageHeader back={back} variant="detail" />
    <PageDetailLoading />
  </>
);
const getNotFound = (back: boolean) => (
  <>
    <PageHeader back={back} variant="detail" />
    Page Not Found (TODO)
  </>
);
const skeleton = getSkeleton(false);
const skeletonWithBack = getSkeleton(true);
const notFound = getNotFound(false);
const notFoundWithBack = getNotFound(true);

const MobileDetailPage = ({
  pageId,
  date,
}: {
  pageId: string;
  date?: string;
}) => {
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const journalService = useService(JournalService);
  const workbench = useService(WorkbenchService).workbench;
  const [showTitle, setShowTitle] = useState(false);
  const title = useLiveData(docDisplayMetaService.title$(pageId));

  const allJournalDates = useLiveData(journalService.allJournalDates$);

  const location = useLiveData(workbench.location$);
  const fromTab = location.search.includes("fromTab");

  const handleDateChange = useCallback(
    (date: string) => {
      const docs = journalService.getJournalsByDate(date);
      if (docs.length > 0) {
        workbench.openDoc(
          { docId: docs[0].id, fromTab: fromTab ? "true" : undefined },
          { replaceHistory: true },
        );
      } else {
        workbench.open(`/journals?date=${date}`);
      }
    },
    [fromTab, journalService, workbench],
  );

  const handleDocumentTitleVisibilityChange = useCallback(
    (visible: boolean) => setShowTitle(!visible),
    [],
  );

  return (
    <DetailPageMobileRoot>
      <DetailPageWrapper
        skeleton={date ? skeleton : skeletonWithBack}
        notFound={date ? notFound : notFoundWithBack}
        pageId={pageId}
      >
        <PageHeader
          back={!fromTab}
          variant="detail"
          suffix={
            <>
              <PageHeaderShareButton />
              <PageHeaderMenuButton />
            </>
          }
          bottom={
            date ? (
              <JournalDatePicker
                date={date}
                onChange={handleDateChange}
                withDotDates={allJournalDates}
              />
            ) : null
          }
          bottomSpacing="journal-date-picker"
        >
          <DetailPageMobileTitle shown={!!date || showTitle}>
            {date
              ? i18nTime(dayjs(date), { absolute: { accuracy: "month" } })
              : title}
          </DetailPageMobileTitle>
        </PageHeader>
        <JournalConflictBlock date={date} />
        <MobileDocumentDetailView
          onDocumentTitleVisibilityChange={handleDocumentTitleVisibilityChange}
        />
        <AppTabs background={cssVar("backgroundPrimaryColor")} />
      </DetailPageWrapper>
    </DetailPageMobileRoot>
  );
};

export const Component = () => {
  useThemeColor("backgroundPrimaryColor");
  const journalService = useService(JournalService);
  const params = useParams();
  const pageId = params.pageId;
  const journalDate = useLiveData(journalService.journalDate$(pageId ?? ""));

  if (!pageId) {
    return null;
  }

  return <MobileDetailPage pageId={pageId} date={journalDate} />;
};
