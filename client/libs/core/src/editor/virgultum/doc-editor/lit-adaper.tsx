import "katex/dist/katex.min.css";

import { useGuard } from "@myoxus/core/components/guard/use-guard";
import { useEnableAI } from "@myoxus/core/components/hooks/myoxus/use-enable-ai";
import {
  type EdgelessEditor,
  LitDocEditor,
  LitDocTitle,
  LitEdgelessEditor,
  type PageEditor,
} from "@myoxus/core/editor/editors";
import { getViewManager } from "@myoxus/core/editor/manager/view";
import { createMyoxusHostServiceAdapter } from "@myoxus/core/editor/virgultum/doc-editor/myoxus-host-adapter";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { BpmnEditorService } from "@myoxus/core/modules/bpmn-editor/session";
import { ViewService } from "@myoxus/core/modules/workbench";
import { DocsService } from "@myoxus/core/modules/doc";
import {
  DocumentMetadataProvider,
  DocumentMetadataSummary,
  shouldShowDocumentMetadata,
} from "@myoxus/core/modules/document-metadata";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { IntegrationService } from "@myoxus/core/modules/integration";
import { JournalService } from "@myoxus/core/modules/journal";
import { DIAGRAM_DOC_KIND } from "@myoxus/core/modules/mermaid-diagrams";
import { useInsidePeekView } from "@myoxus/core/modules/peek-view";
import { ServerService, UserFeatureService } from "@myoxus/core/modules/server";
import { TemplateDocService } from "@myoxus/core/modules/template-doc";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { ServerFeature } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  useFramework,
  useLiveData,
  useService,
  useServiceOptional,
  useServices,
} from "@myoxus/infra";
import { useLitPortalFactory } from "@myoxus/lit-react";
import {
  DetailPageEditorViewport,
  DocumentEditorBlankGap,
  documentEditorContentClassName,
  DocumentEditorEdgelessViewport,
  DocumentEditorPageViewport,
  DocumentTitleRow,
  useConfirmModal,
} from "@myoxus/ui-facade";
import type { DocTitle } from "@virgultum/editor/fragments/doc-title";
import type { DocMode, RootBlockModel } from "@virgultum/editor/model";
import type { Store } from "@virgultum/editor/store";
import type { BpmnBlockModel, MermaidBlockModel } from "@virgultum/model";
import { MyoxusHostExtension } from "@virgultum/shared/services";
import { debounce } from "lodash-es";
import type React from "react";
import {
  forwardRef,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import { DocIconPicker } from "./doc-icon-picker";
import {
  bindDocumentTitleSync,
  observeDocumentTitle,
} from "./document-title-sync";
import { VirgultumEditorJournalDocTitle } from "./journal-doc-title";
import { ReadingSnapshotContext } from "./reading-snapshot-context";
import { StarterBar } from "./starter-bar";
import { useTemplateVariablePicker } from "./template-variable-picker";
import { useBuildingBlockPicker } from "../../../modules/template-doc/view/building-block-picker";

interface VirgultumEditorProps {
  page: Store;
  readonly?: boolean;
  shared?: boolean;
  snapshot?: boolean;
  contentOnly?: boolean;
}

function useMermaidDiagramDocumentTitle(page: Store, docsService: DocsService) {
  useEffect(() => {
    if (page.readonly) return;
    let pendingTitle = "";
    let observedTitle: RootBlockModel["props"]["title"] | null = null;
    let stopObservingTitle: (() => void) | null = null;
    const commitTitle = debounce(
      ({ title, generation }: { title: string; generation: number }) => {
        void docsService
          .commitDocTitleIntent(page.id, title, generation)
          .catch((error) => {
            console.error(
              "[doc-title] failed to sync dedicated diagram title",
              {
                docId: page.id,
                error,
              },
            );
          })
          .finally(() => {
            if (pendingTitle === title) pendingTitle = "";
          });
      },
      250,
    );
    const dedicatedTitle = () => {
      const metadata = page.workspace.meta.getDocMeta(page.id);
      if (
        metadata?.docKind !== DIAGRAM_DOC_KIND ||
        (metadata.diagramFormat !== "mermaid" &&
          metadata.diagramFormat !== "bpmn")
      )
        return null;
      const blocks = page.getBlocksByFlavour(
        metadata.diagramFormat === "bpmn" ? "myoxus:bpmn" : "myoxus:mermaid",
      );
      return blocks.length === 1
        ? (blocks[0].model as BpmnBlockModel | MermaidBlockModel).props.title
        : null;
    };
    const projectTitle = (candidate?: string) => {
      const blockTitle = dedicatedTitle();
      if (!blockTitle) return;
      const title = String(candidate ?? blockTitle).trim();
      const rootTitle = String(
        (page.root as RootBlockModel | null)?.props.title ?? "",
      ).trim();
      if (!title || title === rootTitle || title === pendingTitle) return;
      // Only explicitly classified dedicated documents project their single
      // block title. Inline blocks never rename their containing document, and
      // BPMN process names/XML remain independent from this presentation title.
      pendingTitle = title;
      const generation = docsService.beginDocTitleIntent(page.id, title);
      commitTitle({ title, generation });
    };
    const bindTitle = () => {
      const title = dedicatedTitle();
      if (title !== observedTitle) {
        stopObservingTitle?.();
        observedTitle = title;
        stopObservingTitle = title?.yText
          ? observeDocumentTitle(title.yText, (value) => projectTitle(value))
          : null;
      }
      projectTitle();
    };
    const readySubscription = page.slots.ready.subscribe(bindTitle);
    const blockSubscription = page.slots.blockUpdated.subscribe(bindTitle);
    bindTitle();
    return () => {
      readySubscription.unsubscribe();
      blockSubscription.unsubscribe();
      stopObservingTitle?.();
      commitTitle.flush();
      commitTitle.cancel();
    };
  }, [docsService, page]);
}

const usePatchSpecs = (mode: DocMode, shared?: boolean) => {
  const [reactToLit, portals] = useLitPortalFactory();
  const { workspaceService, featureFlagService } = useServices({
    WorkspaceService,
    FeatureFlagService,
  });
  const isCloud = workspaceService.workspace.flavour !== "local";
  const framework = useFramework();

  const confirmModal = useConfirmModal();

  const enableAI = useEnableAI();

  const isInPeekView = useInsidePeekView();

  const enableTurboRenderer = useLiveData(
    featureFlagService.flags.enable_turbo_renderer.$,
  );

  const serverService = useService(ServerService);
  const serverConfig = useLiveData(serverService.server.config$);

  // comment may not be supported by the server
  const enableComment =
    isCloud && serverConfig.features.includes(ServerFeature.Comment) && !shared;

  const patchedSpecs = useMemo(() => {
    const manager = getViewManager()
      .config.init()
      .foundation(framework)
      .ai(enableAI, framework)
      .theme(framework)
      .editorConfig(framework)
      .editorView({
        framework,
        reactToLit,
        confirmModal,
        // Detached snapshots have no Doc/Editor scope. Keep their read-only
        // renderer on workspace services instead of binding a live editor.
        scope: shared ? "workspace" : "doc",
        showAnnotations: !shared,
      })
      .cloud(framework, isCloud)
      .turboRenderer(enableTurboRenderer)
      .pdf(reactToLit)
      .edgelessBlockHeader({
        framework,
        isInPeekView,
        reactToLit,
      })
      .database(framework)
      .linkedDoc(framework)
      .paragraph(enableAI)
      .mobile(framework)
      .electron(framework)
      .linkPreview(framework)
      .codeBlockPreview(framework)
      .iconPicker(framework)
      .comment(enableComment, framework).value;

    if (BUILD_CONFIG.isMobileEdition) {
      if (mode === "page") {
        return manager.get("mobile-page");
      } else {
        return manager.get("mobile-edgeless");
      }
    } else {
      return manager.get(mode);
    }
  }, [
    confirmModal,
    enableAI,
    enableTurboRenderer,
    enableComment,
    framework,
    isInPeekView,
    isCloud,
    mode,
    reactToLit,
    shared,
  ]);

  return [
    patchedSpecs,
    useMemo(
      () => (
        <>
          {portals.map((p) => (
            <Fragment key={p.id}>{p.portal}</Fragment>
          ))}
        </>
      ),
      [portals],
    ),
  ] as const;
};

export const VirgultumDocEditor = forwardRef<
  PageEditor,
  VirgultumEditorProps & {
    onClickBlank?: () => void;
    titleRef?: React.Ref<DocTitle>;
  }
>(function VirgultumDocEditor(
  {
    page,
    shared,
    onClickBlank,
    titleRef: externalTitleRef,
    readonly,
    snapshot,
    contentOnly,
  },
  ref,
) {
  const titleRef = useRef<DocTitle | null>(null);
  const docRef = useRef<PageEditor | null>(null);
  const journalService = useService(JournalService);
  const templateDocService = useService(TemplateDocService);
  const bpmnEditorService = useService(BpmnEditorService);
  const bpmnEditorView = useServiceOptional(ViewService)?.view;
  const { openTemplateVariablePicker, templateVariablePicker } =
    useTemplateVariablePicker();
  const {
    openBuildingBlockPicker,
    saveBuildingBlockSelection,
    buildingBlockPicker,
  } = useBuildingBlockPicker();
  const isJournal =
    !!useLiveData(journalService.journalDate$(page.id)) && !snapshot;

  const serverService = useService(ServerService);
  const userFeatureService = useService(UserFeatureService);
  const workspaceService = useService(WorkspaceService);
  const workspaceDialogService = useService(WorkspaceDialogService);
  const docsService = useService(DocsService);
  const featureFlagService = useService(FeatureFlagService);
  const integrationService = useService(IntegrationService);
  const workspace = workspaceService.workspace;
  useMermaidDiagramDocumentTitle(page, docsService);

  // Build the `MyoxusHostService` adapter that bridges Virgultum
  // features (event block, BPMN block) to the Myoxus application
  // shell. The extension is registered against the editor's
  // `BlockStdScope` via the `hostExtension` prop on
  // `PageEditor`/`EdgelessEditor`. We rebuild it whenever any of
  // the underlying Core services change identity (workspace
  // switch) or the workspace id itself changes.
  const hostExtension = useMemo(
    () =>
      MyoxusHostExtension(
        createMyoxusHostServiceAdapter({
          store: page,
          workspaceService,
          workspaceDialogService,
          featureFlagService,
          integrationService,
          docsService,
          serverService,
          templateDocService,
          bpmnEditorService,
          bpmnEditorView,
          openTemplateVariablePicker,
          openBuildingBlockPicker:
            !page.readonly && !snapshot ? openBuildingBlockPicker : undefined,
          saveBuildingBlockSelection:
            !page.readonly && !snapshot
              ? saveBuildingBlockSelection
              : undefined,
        }),
      ),
    [
      page,
      workspaceService,
      workspaceDialogService,
      featureFlagService,
      integrationService,
      docsService,
      serverService,
      templateDocService,
      bpmnEditorService,
      bpmnEditorView,
      openTemplateVariablePicker,
      openBuildingBlockPicker,
      saveBuildingBlockSelection,
      snapshot,
    ],
  );
  const canConfigureWorkspaceDocumentSettings = useGuard(
    "Workspace_Settings_Update",
  );
  const isMyoxusAdmin = useLiveData(userFeatureService.userFeature.isAdmin$);
  const t = useI18n();

  useEffect(() => {
    userFeatureService.userFeature.revalidate();
  }, [userFeatureService]);

  useEffect(() => {
    if (readonly || page.readonly) return;
    const rootTitle = (page.root as RootBlockModel | null)?.props.title;
    const yText = rootTitle?.yText;
    if (!rootTitle || !yText) {
      return;
    }

    const stopObserving = bindDocumentTitleSync(
      page.id,
      yText,
      docsService,
      (error) => {
        console.error("[doc-title] failed to persist leaf title", {
          docId: page.id,
          error,
        });
      },
    );
    return () => {
      stopObserving();
    };
  }, [docsService, page, readonly]);

  const onDocRef = useCallback(
    (el: PageEditor) => {
      docRef.current = el;
      if (ref) {
        if (typeof ref === "function") {
          ref(el);
        } else {
          ref.current = el;
        }
      }
    },
    [ref],
  );

  const onTitleRef = useCallback(
    (el: DocTitle) => {
      titleRef.current = el;
      if (externalTitleRef) {
        if (typeof externalTitleRef === "function") {
          externalTitleRef(el);
        } else {
          externalTitleRef.current = el;
        }
      }
    },
    [externalTitleRef],
  );

  const [specs, portals] = usePatchSpecs("page", shared || snapshot);

  const showDocumentMetadata =
    !snapshot &&
    !contentOnly &&
    shouldShowDocumentMetadata({
      shared,
      isJournal,
      workspaceFlavour: workspace.flavour,
    });

  const onConfigureWorkspaceDocumentSettings = useCallback(() => {
    workspaceDialogService.open("workspace-settings", {
      activeTab: "workspace:documents",
    });
  }, [workspaceDialogService]);

  const onOpenGlobalDocumentPolicy = useCallback(() => {
    const adminUrl = new URL(
      "/adminfrontend/documents?tab=metadata",
      serverService.server.baseUrl,
    );
    window.open(adminUrl.toString(), "_blank", "noopener,noreferrer");
  }, [serverService.server.baseUrl]);

  const content = (
    <>
      {!contentOnly &&
        (!isJournal ? (
          <DocumentTitleRow data-testid="doc-title-row">
            {!snapshot && !BUILD_CONFIG.isMobileEdition ? (
              <DocIconPicker docId={page.id} readonly={readonly || shared} />
            ) : null}
            <LitDocTitle
              doc={page}
              placeholder={t["Title"]()}
              ref={onTitleRef}
            />
          </DocumentTitleRow>
        ) : (
          <VirgultumEditorJournalDocTitle page={page} />
        ))}
      {showDocumentMetadata ? <DocumentMetadataSummary /> : null}
      <LitDocEditor
        className={documentEditorContentClassName}
        ref={onDocRef}
        doc={page}
        specs={specs}
        hostExtension={hostExtension}
      />
      {!contentOnly ? (
        <DocumentEditorBlankGap
          data-testid="page-editor-blank"
          onClick={onClickBlank}
        />
      ) : null}
      {!contentOnly &&
      !isJournal &&
      !readonly &&
      !BUILD_CONFIG.isMobileEdition ? (
        <StarterBar doc={page} />
      ) : null}
    </>
  );

  const body = showDocumentMetadata ? (
    <DocumentMetadataProvider
      canOpenGlobalPolicy={Boolean(isMyoxusAdmin)}
      canConfigureWorkspaceDefaults={canConfigureWorkspaceDocumentSettings}
      docId={page.id}
      onOpenGlobalPolicy={onOpenGlobalDocumentPolicy}
      onConfigureWorkspaceDefaults={onConfigureWorkspaceDocumentSettings}
      readonly={readonly}
    >
      {content}
    </DocumentMetadataProvider>
  ) : (
    content
  );

  return (
    <ReadingSnapshotContext.Provider value={Boolean(snapshot)}>
      {contentOnly ? (
        <DetailPageEditorViewport editorMode="page" pageModeContentBox>
          {body}
        </DetailPageEditorViewport>
      ) : (
        <DocumentEditorPageViewport>{body}</DocumentEditorPageViewport>
      )}
      {portals}
      {templateVariablePicker}
      {buildingBlockPicker}
    </ReadingSnapshotContext.Provider>
  );
});
export const VirgultumEdgelessEditor = forwardRef<
  EdgelessEditor,
  VirgultumEditorProps
>(function VirgultumEdgelessEditor({ page, shared, snapshot }, ref) {
  const bpmnEditorService = useService(BpmnEditorService);
  const bpmnEditorView = useServiceOptional(ViewService)?.view;
  const templateDocService = useService(TemplateDocService);
  const { openTemplateVariablePicker, templateVariablePicker } =
    useTemplateVariablePicker();
  const {
    openBuildingBlockPicker,
    saveBuildingBlockSelection,
    buildingBlockPicker,
  } = useBuildingBlockPicker();
  const [specs, portals] = usePatchSpecs("edgeless", shared || snapshot);
  const editorRef = useRef<EdgelessEditor | null>(null);
  const workspaceService = useService(WorkspaceService);
  const workspaceDialogService = useService(WorkspaceDialogService);
  const docsService = useService(DocsService);
  const featureFlagService = useService(FeatureFlagService);
  const integrationService = useService(IntegrationService);
  const serverService = useService(ServerService);
  useMermaidDiagramDocumentTitle(page, docsService);

  // Mirror the `VirgultumDocEditor` host-service wiring so the
  // edgeless surface has the same `MyoxusHostService` binding.
  const hostExtension = useMemo(
    () =>
      MyoxusHostExtension(
        createMyoxusHostServiceAdapter({
          store: page,
          workspaceService,
          workspaceDialogService,
          featureFlagService,
          integrationService,
          docsService,
          serverService,
          templateDocService,
          bpmnEditorService,
          bpmnEditorView,
          openTemplateVariablePicker,
          openBuildingBlockPicker:
            !page.readonly && !snapshot ? openBuildingBlockPicker : undefined,
          saveBuildingBlockSelection:
            !page.readonly && !snapshot
              ? saveBuildingBlockSelection
              : undefined,
        }),
      ),
    [
      page,
      workspaceService,
      workspaceDialogService,
      featureFlagService,
      integrationService,
      docsService,
      serverService,
      templateDocService,
      bpmnEditorService,
      bpmnEditorView,
      openTemplateVariablePicker,
      openBuildingBlockPicker,
      saveBuildingBlockSelection,
      snapshot,
    ],
  );

  const onDocRef = useCallback(
    (el: EdgelessEditor) => {
      editorRef.current = el;
      if (ref) {
        if (typeof ref === "function") {
          ref(el);
        } else {
          ref.current = el;
        }
      }
    },
    [ref],
  );

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateComplete
        .then(() => {
          // make sure editor can get keyboard events on showing up
          editorRef.current
            ?.querySelector<HTMLElement>("myoxus-edgeless-root")
            ?.click();
        })
        .catch(console.error);
    }
  }, []);

  return (
    <DocumentEditorEdgelessViewport>
      <LitEdgelessEditor
        ref={onDocRef}
        doc={page}
        specs={specs}
        hostExtension={hostExtension}
      />
      {portals}
      {templateVariablePicker}
      {buildingBlockPicker}
    </DocumentEditorEdgelessViewport>
  );
});
