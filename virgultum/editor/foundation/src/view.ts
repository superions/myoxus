import { FileDropExtension } from "@virgultum/components/drop-indicator";
import {
  PeekViewExtension,
  type PeekViewService,
} from "@virgultum/components/peek";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import {
  AutoClearSelectionService,
  BlockElementCommentManager,
  CitationService,
  DefaultOpenDocExtension,
  DNDAPIExtension,
  DocDisplayMetaService,
  DocModeService,
  EditPropsStore,
  EmbedOptionService,
  FileSizeLimitService,
  FontConfigExtension,
  fontConfigSchema,
  FontLoaderService,
  EditorI18nExtension,
  type EditorI18nAdapter,
  LinkPreviewCache,
  LinkPreviewCacheConfigSchema,
  LinkPreviewCacheExtension,
  LinkPreviewService,
  PageViewportServiceExtension,
  TelemetryExtension,
  type TelemetryService,
  ThemeService,
  ToolbarRegistryExtension,
} from "@virgultum/shared/services";
import { InteractivityManager, ToolController } from "@virgultum/std/gfx";
import { z } from "zod";

import { clipboardConfigs } from "./clipboard";
import { effects } from "./effects";

const optionsSchema = z.object({
  i18n: z.optional(z.custom<EditorI18nAdapter>()),
  linkPreviewCacheConfig: z.optional(LinkPreviewCacheConfigSchema),
  fontConfig: z.optional(z.array(fontConfigSchema)),
  telemetry: z.optional(z.custom<TelemetryService>()),
  peekView: z.optional(z.custom<PeekViewService>()),
});

export type FoundationViewExtensionOptions = z.infer<typeof optionsSchema>;

export class FoundationViewExtension extends ViewExtensionProvider<FoundationViewExtensionOptions> {
  override name = "foundation";

  override schema = optionsSchema;

  override effect() {
    super.effect();
    effects();
  }

  override setup(
    context: ViewExtensionContext,
    options?: FoundationViewExtensionOptions,
  ) {
    super.setup(context, options);
    context.register([
      DocDisplayMetaService,
      EditPropsStore,
      DefaultOpenDocExtension,
      FontLoaderService,

      DocModeService,
      ThemeService,
      EmbedOptionService,
      PageViewportServiceExtension,
      DNDAPIExtension,
      FileDropExtension,
      ToolbarRegistryExtension,
      AutoClearSelectionService,
      FileSizeLimitService,
      LinkPreviewCache,
      LinkPreviewService,
      CitationService,
      BlockElementCommentManager,
    ]);
    context.register(clipboardConfigs);
    const i18n = options?.i18n;
    if (i18n) {
      context.register(EditorI18nExtension(i18n));
    }
    if (this.isEdgeless(context.scope)) {
      context.register([InteractivityManager, ToolController]);
    }
    const fontConfig = options?.fontConfig;
    if (fontConfig) {
      context.register(FontConfigExtension(fontConfig));
    }
    const linkPreviewCacheConfig = options?.linkPreviewCacheConfig;
    if (linkPreviewCacheConfig) {
      context.register(LinkPreviewCacheExtension(linkPreviewCacheConfig));
    }
    const telemetry = options?.telemetry;
    if (telemetry) {
      context.register(TelemetryExtension(telemetry));
    }
    const peekView = options?.peekView;
    if (peekView) {
      context.register(PeekViewExtension(peekView));
    }
  }
}
