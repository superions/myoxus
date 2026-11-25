// SPDX-License-Identifier: MIT
import "katex/dist/katex.min.css";

import { useEditorCopilot } from "@myoxus/core/components/hooks/myoxus/use-enable-ai";
import { DocumentViewport } from "@myoxus/core/editor/editors";
import type { EditorHost } from "@virgultum/editor/std";
import { getViewManager } from "@myoxus/core/editor/manager/view";
import { createMyoxusHostServiceAdapter } from "@myoxus/core/editor/virgultum/doc-editor/myoxus-host-adapter";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { BpmnEditorService } from "@myoxus/core/modules/bpmn-editor/session";
import { ViewService } from "@myoxus/core/modules/workbench";
import { DocsService } from "@myoxus/core/modules/doc";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { IntegrationService } from "@myoxus/core/modules/integration";
import { useInsidePeekView } from "@myoxus/core/modules/peek-view";
import { ServerService } from "@myoxus/core/modules/server";
import { TemplateDocService } from "@myoxus/core/modules/template-doc";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { ServerFeature } from "@myoxus/graphql";
import {
  useFramework,
  useLiveData,
  useService,
  useServiceOptional,
  useServices,
} from "@myoxus/infra";
import { usePortalFactory } from "@myoxus/core/editor/portal";
import {
  DocumentEditorEdgelessViewport,
  useConfirmModal,
} from "@myoxus/ui-facade";
import type { Store } from "@virgultum/editor/store";
import { MyoxusHostExtension } from "@virgultum/core/services";
import {
  forwardRef,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import { bindDiagramDocumentTitleSync } from "./document-title-sync";
import { useTemplateVariablePicker } from "./template-variable-picker";
import { useBuildingBlockPicker } from "../../../modules/template-doc/view/building-block-picker";

interface VirgultumCanvasEditorProps {
  page: Store;
  readonly?: boolean;
  shared?: boolean;
  snapshot?: boolean;
  contentOnly?: boolean;
}

const usePatchCanvasSpecs = (shared?: boolean) => {
  const [portals, mountPortal] = usePortalFactory();
  const { workspaceService, featureFlagService } = useServices({
    WorkspaceService,
    FeatureFlagService,
  });
  const isCloud = workspaceService.workspace.flavour !== "local";
  const framework = useFramework();

  const { openConfirmModal, closeConfirmModal } = useConfirmModal();
  // Portal updates must not recreate the editor's extension scope.
  const confirmModal = useMemo(
    () => ({ openConfirmModal, closeConfirmModal }),
    [openConfirmModal, closeConfirmModal],
  );

  const enableAI = useEditorCopilot();
  const isInPeekView = useInsidePeekView();
  const enableTurboRenderer = useLiveData(
    featureFlagService.flags.enable_turbo_renderer.$,
  );
  const serverService = useService(ServerService);
  const serverConfig = useLiveData(serverService.server.config$);

  const enableComment =
    isCloud && serverConfig.features.includes(ServerFeature.Comment) && !shared;

  const patchedSpecs = useMemo(() => {
    const manager = getViewManager()
      .config.init()
      .foundation(framework)
      .ai(enableAI, framework, mountPortal)
      .theme(framework)
      .editorConfig(framework)
      .editorView({
        framework,
        mountPortal,
        confirmModal,
        scope: shared ? "workspace" : "doc",
        showAnnotations: !shared,
      })
      .cloud(framework, isCloud)
      .turboRenderer(enableTurboRenderer)
      .pdf(mountPortal)
      .edgelessBlockHeader({
        framework,
        isInPeekView,
        mountPortal,
      })
      .database(framework)
      .linkedDoc(framework)
      .paragraph(enableAI)
      .mobile(framework)
      .electron(framework)
      .linkPreview(framework)
      .codeBlockPreview(framework)
      .comment(enableComment, framework).value;

    return BUILD_CONFIG.isMobileEdition
      ? manager.get("mobile-edgeless")
      : manager.get("edgeless");
  }, [
    confirmModal,
    enableAI,
    enableTurboRenderer,
    enableComment,
    framework,
    isInPeekView,
    isCloud,
    mountPortal,
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

/** Canvas-only (edgeless) Virgultum EditorHost adapter. Page mode is owned by `VirgultumPageEditor`. */
export const VirgultumEdgelessEditor = forwardRef<
  EditorHost,
  VirgultumCanvasEditorProps
>(function VirgultumEdgelessEditor({ page, shared, snapshot }, ref) {
  const bpmnEditorService = useService(BpmnEditorService);
  const bpmnEditorView = useServiceOptional(ViewService)?.view;
  const templateDocService = useService(TemplateDocService);
  const { openTemplateVariablePicker, templateVariablePicker } =
    useTemplateVariablePicker();
  const {
    openBuildingBlockPicker,
    insertNamedBuildingBlock,
    saveBuildingBlockSelection,
    buildingBlockPicker,
  } = useBuildingBlockPicker();
  const [specs, portals] = usePatchCanvasSpecs(shared || snapshot);
  const editorRef = useRef<EditorHost | null>(null);
  const workspaceService = useService(WorkspaceService);
  const workspaceDialogService = useService(WorkspaceDialogService);
  const docsService = useService(DocsService);
  const featureFlagService = useService(FeatureFlagService);
  const integrationService = useService(IntegrationService);
  const serverService = useService(ServerService);

  useEffect(
    () => bindDiagramDocumentTitleSync(page, docsService),
    [docsService, page],
  );

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
          insertNamedBuildingBlock:
            !page.readonly && !snapshot ? insertNamedBuildingBlock : undefined,
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
      insertNamedBuildingBlock,
      saveBuildingBlockSelection,
      snapshot,
    ],
  );

  const onDocRef = useCallback(
    (el: EditorHost | null) => {
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
      <DocumentViewport
        mode="edgeless"
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
