import { I18n } from "@myoxus/i18n";
import { AIViewExtension } from "@myoxus/core/editor/view-extensions/ai";
import { CloudViewExtension } from "@myoxus/core/editor/view-extensions/cloud";
import { CodeBlockPreviewViewExtension } from "@myoxus/core/editor/view-extensions/code-block-preview";
import { CommentViewExtension } from "@myoxus/core/editor/view-extensions/comment";
import {
  EdgelessBlockHeaderConfigViewExtension,
  type EdgelessBlockHeaderViewOptions,
} from "@myoxus/core/editor/view-extensions/edgeless-block-header";
import { MyoxusEditorConfigViewExtension } from "@myoxus/core/editor/view-extensions/editor-config";
import { createDatabaseReferenceOptionsConfig } from "@myoxus/core/editor/view-extensions/editor-config/database";
import { createLinkedWidgetConfig } from "@myoxus/core/editor/view-extensions/editor-config/linked";
import {
  type MyoxusEditorViewOptions,
  MyoxusEditorViewExtension,
} from "@myoxus/core/editor/view-extensions/editor-view/editor-view";
import { ElectronViewExtension } from "@myoxus/core/editor/view-extensions/electron";
import { MyoxusIconPickerExtension } from "@myoxus/core/editor/view-extensions/icon-picker";
import { MyoxusLinkPreviewExtension } from "@myoxus/core/editor/view-extensions/link-preview-service";
import { MobileViewExtension } from "@myoxus/core/editor/view-extensions/mobile";
import { PdfViewExtension } from "@myoxus/core/editor/view-extensions/pdf";
import { MyoxusThemeViewExtension } from "@myoxus/core/editor/view-extensions/theme";
import { TurboRendererViewExtension } from "@myoxus/core/editor/view-extensions/turbo-renderer";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { DebugLogger } from "@myoxus/debug";
import type { FrameworkProvider } from "@myoxus/infra";
import type { ReactToLit } from "@myoxus/lit-react";
import { tracker } from "@myoxus/track";
import { DatabaseReferenceViewExtension } from "@virgultum/block-database/reference-view";
import { ParagraphViewExtension } from "@virgultum/editor/blocks/paragraph/view";
import type {
  PeekOptions,
  PeekViewService as BSPeekViewService,
} from "@virgultum/editor/components/peek";
import { ViewExtensionManager } from "@virgultum/editor/ext-loader";
import { internalManifestRegistry } from "@virgultum/editor/extensions/manifest-registry";
import {
  buildScopeReport,
  buildScopeReportByScope,
  type ScopeReportByScope,
  type ScopeReportEntry,
} from "@virgultum/editor/extensions/scope-report";
import { getInternalViewExtensions } from "@virgultum/editor/extensions/view";
import { FoundationViewExtension } from "@virgultum/editor/foundation/view";
import { InlineCommentViewExtension } from "@virgultum/editor/inlines/comment";
import { LinkedDocViewExtension } from "@virgultum/editor/widgets/linked-doc/view";
import type { TemplateResult } from "lit";

import { configureEditorI18n } from "../virgultum/editor-i18n";
import { configureMermaidI18n } from "../virgultum/mermaid-i18n";

type Configure = {
  init: () => Configure;

  foundation: (framework?: FrameworkProvider) => Configure;
  editorView: (options?: MyoxusEditorViewOptions) => Configure;
  theme: (framework?: FrameworkProvider) => Configure;
  editorConfig: (framework?: FrameworkProvider) => Configure;
  edgelessBlockHeader: (options?: EdgelessBlockHeaderViewOptions) => Configure;
  database: (framework?: FrameworkProvider) => Configure;
  linkedDoc: (framework?: FrameworkProvider) => Configure;
  paragraph: (enableAI?: boolean) => Configure;
  cloud: (framework?: FrameworkProvider, enableCloud?: boolean) => Configure;
  turboRenderer: (enableTurboRenderer?: boolean) => Configure;
  pdf: (reactToLit?: ReactToLit) => Configure;
  mobile: (framework?: FrameworkProvider) => Configure;
  ai: (enable?: boolean, framework?: FrameworkProvider) => Configure;
  electron: (framework?: FrameworkProvider) => Configure;
  linkPreview: (framework?: FrameworkProvider) => Configure;
  codeBlockPreview: (framework?: FrameworkProvider) => Configure;
  iconPicker: (framework?: FrameworkProvider) => Configure;
  comment: (
    enableComment?: boolean,
    framework?: FrameworkProvider,
  ) => Configure;

  value: ViewExtensionManager;
};

const peekViewLogger = new DebugLogger("myoxus::patch-peek-view-service");

class ViewProvider {
  static instance: ViewProvider | null = null;
  static getInstance() {
    if (!ViewProvider.instance) {
      ViewProvider.instance = new ViewProvider();
    }
    return ViewProvider.instance;
  }

  private readonly _manager: ViewExtensionManager;
  private readonly _editorI18n = configureEditorI18n();

  constructor() {
    configureMermaidI18n();

    this._manager = new ViewExtensionManager([
      ...getInternalViewExtensions(),

      MyoxusThemeViewExtension,
      MyoxusEditorViewExtension,
      MyoxusEditorConfigViewExtension,
      MyoxusIconPickerExtension,
      CodeBlockPreviewViewExtension,
      EdgelessBlockHeaderConfigViewExtension,
      TurboRendererViewExtension,
      CloudViewExtension,
      PdfViewExtension,
      MobileViewExtension,
      AIViewExtension,
      ElectronViewExtension,
      MyoxusLinkPreviewExtension,
      CommentViewExtension,
    ]);
  }

  get value() {
    return this._manager;
  }

  /**
   * The C-04 scope report: a frozen list of
   * `ScopeReportEntry` objects, one per feature
   * manifest in registration order. The report
   * mirrors the `virgultum/editor/all`
   * `FeatureManifestRegistry` and lets Myoxus-side
   * code (and tests) introspect which features are
   * registered for which surface.
   *
   * The report is computed lazily and cached on the
   * singleton. It is **frozen**, so callers must not
   * mutate it.
   *
   * @see docs/dev/virgultum/refactor-roadmap.md §C
   *      (P-VIRG-ARCH-C-04)
   */
  private _scopeReport: ReadonlyArray<ScopeReportEntry> | null = null;
  get scopeReport(): ReadonlyArray<ScopeReportEntry> {
    if (this._scopeReport === null) {
      // Build the report on demand by reading the
      // internal manifest registry. The registry is
      // module-load-time constant, so the report is
      // stable across calls.
      this._scopeReport = buildScopeReport(internalManifestRegistry);
    }
    return this._scopeReport;
  }

  /**
   * The C-04 scope report sliced by the four scopes
   * the C-04 acceptance criterion names: `page`,
   * `edgeless`, `mobile-page`, `mobile-edgeless`.
   * Lazy and cached.
   */
  private _scopeReportByScope: ScopeReportByScope | null = null;
  get scopeReportByScope(): ScopeReportByScope {
    if (this._scopeReportByScope === null) {
      this._scopeReportByScope = buildScopeReportByScope(this.scopeReport);
    }
    return this._scopeReportByScope;
  }

  get config(): Configure {
    return {
      init: this._initDefaultConfig,
      foundation: this._configureFoundation,
      editorView: this._configureEditorView,
      theme: this._configureTheme,
      editorConfig: this._configureEditorConfig,
      edgelessBlockHeader: this._configureEdgelessBlockHeader,
      database: this._configureDatabase,
      linkedDoc: this._configureLinkedDoc,
      paragraph: this._configureParagraph,
      cloud: this._configureCloud,
      turboRenderer: this._configureTurboRenderer,
      pdf: this._configurePdf,
      mobile: this._configureMobile,
      ai: this._configureAI,
      electron: this._configureElectron,
      linkPreview: this._configureLinkPreview,
      codeBlockPreview: this._configureCodeBlockHtmlPreview,
      iconPicker: this._configureIconPicker,
      comment: this._configureComment,
      value: this._manager,
    };
  }

  private readonly _initDefaultConfig = () => {
    this.config
      .foundation()
      .theme()
      .editorView()
      .editorConfig()
      .edgelessBlockHeader()
      .database()
      .linkedDoc()
      .paragraph()
      .cloud()
      .turboRenderer()
      .pdf()
      .mobile()
      .ai()
      .electron()
      .linkPreview()
      .codeBlockPreview()
      .iconPicker()
      .comment();

    return this.config;
  };

  private readonly _configureFoundation = (framework?: FrameworkProvider) => {
    const peekViewService = framework?.get(PeekViewService);

    this._manager.configure(FoundationViewExtension, {
      i18n: this._editorI18n,
      telemetry: {
        track: (eventName, props) => {
          tracker.track(eventName, props);
        },
      },
      peekView: !peekViewService
        ? undefined
        : ({
            peek: (
              element: {
                target: HTMLElement;
                docId: string;
                blockIds?: string[];
                template?: TemplateResult;
              },
              options?: PeekOptions,
            ) => {
              peekViewLogger.debug("center peek", element);
              const { template, target, ...props } = element;

              return peekViewService.peekView.open(
                {
                  element: target,
                  docRef: props,
                },
                template,
                options?.abortSignal,
              );
            },
          } satisfies BSPeekViewService),
    });

    return this.config;
  };

  private readonly _configureEditorView = (
    options?: MyoxusEditorViewOptions,
  ) => {
    this._manager.configure(MyoxusEditorViewExtension, options);
    return this.config;
  };

  private readonly _configureTheme = (framework?: FrameworkProvider) => {
    this._manager.configure(MyoxusThemeViewExtension, { framework });
    return this.config;
  };

  private readonly _configureEditorConfig = (framework?: FrameworkProvider) => {
    this._manager.configure(MyoxusEditorConfigViewExtension, { framework });
    return this.config;
  };

  private readonly _configureEdgelessBlockHeader = (
    options?: EdgelessBlockHeaderViewOptions,
  ) => {
    this._manager.configure(EdgelessBlockHeaderConfigViewExtension, options);
    return this.config;
  };

  private readonly _configureDatabase = (framework?: FrameworkProvider) => {
    if (framework) {
      this._manager.configure(
        DatabaseReferenceViewExtension,
        createDatabaseReferenceOptionsConfig(framework),
      );
    }
    return this.config;
  };

  private readonly _configureLinkedDoc = (framework?: FrameworkProvider) => {
    if (framework) {
      this._manager.configure(
        LinkedDocViewExtension,
        createLinkedWidgetConfig(framework),
      );
    }
    return this.config;
  };

  private readonly _configureParagraph = (enableAI?: boolean) => {
    if (BUILD_CONFIG.isMobileEdition) {
      this._manager.configure(ParagraphViewExtension, {
        getPlaceholder: (model) => {
          const placeholders = {
            text: "",
            h1: "Heading 1",
            h2: "Heading 2",
            h3: "Heading 3",
            h4: "Heading 4",
            h5: "Heading 5",
            h6: "Heading 6",
            quote: "",
          };
          return placeholders[model.props.type] ?? "";
        },
      });
    } else {
      this._manager.configure(ParagraphViewExtension, {
        getPlaceholder: (model) => {
          const placeholders = {
            text: enableAI
              ? I18n.t("com.myoxus.editor.placeholder.text-ai")
              : I18n.t("com.myoxus.editor.placeholder.text"),
            h1: "Heading 1",
            h2: "Heading 2",
            h3: "Heading 3",
            h4: "Heading 4",
            h5: "Heading 5",
            h6: "Heading 6",
            quote: "",
          };
          return placeholders[model.props.type] ?? "";
        },
      });
    }
    return this.config;
  };

  private readonly _configureCloud = (
    framework?: FrameworkProvider,
    enableCloud?: boolean,
  ) => {
    this._manager.configure(CloudViewExtension, { framework, enableCloud });
    return this.config;
  };

  private readonly _configureTurboRenderer = (
    enableTurboRenderer?: boolean,
  ) => {
    this._manager.configure(TurboRendererViewExtension, {
      enableTurboRenderer,
    });
    return this.config;
  };

  private readonly _configurePdf = (reactToLit?: ReactToLit) => {
    this._manager.configure(PdfViewExtension, { reactToLit });
    return this.config;
  };

  private readonly _configureMobile = (framework?: FrameworkProvider) => {
    this._manager.configure(MobileViewExtension, { framework });
    return this.config;
  };

  private readonly _configureAI = (
    enable?: boolean,
    framework?: FrameworkProvider,
  ) => {
    this._manager.configure(AIViewExtension, { framework, enable });
    return this.config;
  };

  private readonly _configureElectron = (framework?: FrameworkProvider) => {
    this._manager.configure(ElectronViewExtension, { framework });
    return this.config;
  };

  private readonly _configureLinkPreview = (framework?: FrameworkProvider) => {
    this._manager.configure(MyoxusLinkPreviewExtension, { framework });
    return this.config;
  };

  private readonly _configureCodeBlockHtmlPreview = (
    framework?: FrameworkProvider,
  ) => {
    this._manager.configure(CodeBlockPreviewViewExtension, { framework });
    return this.config;
  };

  private readonly _configureIconPicker = (framework?: FrameworkProvider) => {
    this._manager.configure(MyoxusIconPickerExtension, { framework });
    return this.config;
  };

  private readonly _configureComment = (
    enableComment?: boolean,
    framework?: FrameworkProvider,
  ) => {
    this._manager.configure(CommentViewExtension, {
      enableComment,
      framework,
    });

    this._manager.configure(InlineCommentViewExtension, {
      enabled: enableComment,
    });

    return this.config;
  };
}

export function getViewManager() {
  return ViewProvider.getInstance();
}
