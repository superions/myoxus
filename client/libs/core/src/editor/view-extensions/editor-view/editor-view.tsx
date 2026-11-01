import { patchEditorChromeHost } from "./editor-chrome";
import {
  MyoxusPageReference,
  MyoxusSharedPageReference,
} from "@myoxus/core/components/myoxus/reference-link";
import { DocService, DocsService } from "@myoxus/core/modules/doc";
import { EditorService } from "@myoxus/core/modules/editor";
import { toDocSearchParams } from "@myoxus/core/modules/navigation";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { FrameworkProvider } from "@myoxus/infra";
import type { ElementOrFactory } from "@myoxus/lit-react";
import type { ConfirmModalProps } from "@myoxus/ui-facade";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import type { TemplateResult } from "lit";
import { z } from "zod";

import { patchForAudioEmbedView } from "./audio/audio-view";
import { buildDocDisplayMetaExtension } from "./display-meta";
import { patchDocEmbedService } from "./doc-embed";
import { patchDocModeService } from "./doc-mode-service";
import { patchDocUrlExtensions } from "./doc-url";
import { patchFileSizeLimitExtension } from "./file-size-limit";
import { patchMermaidFamilyReactHost } from "./mermaid-family-react-host";
import { patchNotificationService } from "./notification-service";
import { patchOpenDocExtension } from "./open-doc";
import { patchQuickSearchService } from "./quick-search-service";
import {
  patchReferenceRenderer,
  type ReferenceReactRenderer,
} from "./reference-renderer";
import { patchSideBarService } from "./side-bar-service";
import { patchAnnotationHost } from "./annotation";
import { patchCalloutTitleHost } from "./callout";
import { patchFootnoteHost } from "./footnote";
import { patchBpmnBlockPresentation } from "./bpmn-block-presentation";

const optionsSchema = z.object({
  // services
  framework: z.instanceof(FrameworkProvider),

  // react renderer
  reactToLit: z
    .function()
    .args(z.custom<ElementOrFactory>(), z.boolean().optional())
    .returns(z.custom<TemplateResult>()),
  confirmModal: z.object({
    openConfirmModal: z
      .function()
      .args(z.custom<ConfirmModalProps>().optional(), z.any().optional()),
    closeConfirmModal: z.function(),
  }),

  scope: z.enum(["doc", "workspace"]).optional(),
  showAnnotations: z.boolean().optional(),
});

export type MyoxusEditorViewOptions = z.infer<typeof optionsSchema>;

export class MyoxusEditorViewExtension extends ViewExtensionProvider<MyoxusEditorViewOptions> {
  override name = "myoxus-editor-view";

  override schema = optionsSchema;

  private readonly _getCustomReferenceRenderer = (
    framework: FrameworkProvider,
  ): ReferenceReactRenderer => {
    const workspaceService = framework.get(WorkspaceService);
    return function customReference(reference) {
      const data = reference.resolvedReferenceInfo;
      if (!data) return <span />;

      const pageId = data.pageId;
      if (!pageId) return <span />;

      // title alias
      const title = data.title;
      const params = toDocSearchParams(data.params);

      if (workspaceService.workspace.openOptions.isSharedMode) {
        return (
          <MyoxusSharedPageReference
            docCollection={workspaceService.workspace.docCollection}
            pageId={pageId}
            resolutionState={reference.referenceResolutionState}
            workspaceId={data.workspaceId}
            params={params}
            title={title}
          />
        );
      }

      return (
        <MyoxusPageReference
          pageId={pageId}
          resolutionState={reference.referenceResolutionState}
          workspaceId={data.workspaceId}
          params={params}
          title={title}
        />
      );
    };
  };

  override setup(
    context: ViewExtensionContext,
    options?: MyoxusEditorViewOptions,
  ) {
    super.setup(context, options);
    if (!options) {
      return;
    }
    const { framework, reactToLit, confirmModal, scope = "doc" } = options;

    const referenceRenderer = this._getCustomReferenceRenderer(framework);

    context
      .register([
        patchReferenceRenderer(reactToLit, referenceRenderer),
        patchNotificationService(confirmModal),
        patchOpenDocExtension(),
        patchSideBarService(framework),
        patchFileSizeLimitExtension(framework),
        buildDocDisplayMetaExtension(framework),
        patchDocEmbedService(framework),
        patchForAudioEmbedView(reactToLit),
        patchMermaidFamilyReactHost(reactToLit),
        patchBpmnBlockPresentation(
          reactToLit,
          framework.get(WorkspaceService).workspace.engine.doc,
        ),
        patchAnnotationHost(reactToLit, options.showAnnotations ?? false),
        patchCalloutTitleHost(reactToLit),
        patchFootnoteHost(reactToLit),
        patchEditorChromeHost(reactToLit),
      ])
      .register(patchDocUrlExtensions(framework))
      .register(patchQuickSearchService(framework));

    if (scope === "doc") {
      const docService = framework.get(DocService);
      const docsService = framework.get(DocsService);
      const editorService = framework.get(EditorService);
      context.register([
        patchDocModeService(docService, docsService, editorService),
      ]);
    }
  }
}
