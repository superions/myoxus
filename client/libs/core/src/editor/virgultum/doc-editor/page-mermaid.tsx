// SPDX-License-Identifier: AGPL-3.0-or-later
import { usePortalFactory } from "@myoxus/core/editor/portal";
import { useFramework } from "@myoxus/infra";
import { useConfirmModal } from "@myoxus/ui-facade";
import { signal, type Signal } from "@preact/signals-core";
import { MermaidBlockSpec } from "@virgultum/block-mermaid/view";
import { EdgelessCRUDExtension } from "@virgultum/editor/blocks/surface";
import { ViewExtensionManagerIdentifier } from "@virgultum/core/extensions";
import { ColorScheme, type MermaidBlockModel } from "@virgultum/core/models";
import type { Container } from "@virgultum/core/primitives/di";
import {
  BlockStdScope,
  LifeCycleWatcher,
  StdIdentifier,
} from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import {
  EditPropsStore,
  EditorI18nExtension,
  FontLoaderService,
  type ThemeExtension,
  ThemeExtensionIdentifier,
  ThemeService,
} from "@virgultum/core/services";
import type { ExtensionType } from "@virgultum/core/store";
import { createSignalFromObservable } from "@virgultum/core/utils";
import { ViewExtensionManager } from "@virgultum/editor/ext-loader";
import { getInternalViewExtensions } from "@virgultum/editor/extensions/view";
import { FoundationViewExtension } from "@virgultum/editor/foundation/view";
import { Fragment, useEffect, useMemo, useRef } from "react";
import { AppThemeService } from "../../../modules/theme";
import { MyoxusEditorConfigViewExtension } from "../../view-extensions/editor-config";
import { MyoxusEditorViewExtension } from "../../view-extensions/editor-view/editor-view";
import { patchFileSizeLimitExtension } from "../../view-extensions/editor-view/file-size-limit";
import { patchMermaidFamilyReactHost } from "../../view-extensions/editor-view/mermaid-family-react-host";
import { patchNotificationService } from "../../view-extensions/editor-view/notification-service";
import { MyoxusThemeViewExtension } from "../../view-extensions/theme";
import { configureEditorI18n } from "../editor-i18n";
import { configureMermaidI18n } from "../mermaid-i18n";

let mermaidI18nReady = false;

function ensureMermaidI18n() {
  if (!mermaidI18nReady) {
    configureMermaidI18n();
    mermaidI18nReady = true;
  }
}

export default function PageMermaid({
  model,
  readonly,
}: {
  model: MermaidBlockModel;
  readonly: boolean;
}) {
  const effectiveReadonly = readonly || model.store.readonly;
  const hostRef = useRef<HTMLDivElement>(null);
  const [portals, mountPortal] = usePortalFactory();
  const framework = useFramework();
  const { openConfirmModal, closeConfirmModal } = useConfirmModal();
  const confirmModal = useMemo(
    () => ({ openConfirmModal, closeConfirmModal }),
    [openConfirmModal, closeConfirmModal],
  );

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;

    ensureMermaidI18n();
    const editorI18n = configureEditorI18n();

    // Isolated ViewExtensionManager so scoped GFX visual editors get the full
    // preview-edgeless extensions without mutating the shared Canvas singleton.
    const manager = new ViewExtensionManager([
      ...getInternalViewExtensions(),
      MyoxusThemeViewExtension,
      MyoxusEditorViewExtension,
      MyoxusEditorConfigViewExtension,
    ]);
    manager.configure(FoundationViewExtension, { i18n: editorI18n });
    manager.configure(MyoxusThemeViewExtension, { framework });
    manager.configure(MyoxusEditorConfigViewExtension, { framework });
    manager.configure(MyoxusEditorViewExtension, {
      framework,
      mountPortal,
      confirmModal,
      scope: "workspace",
      showAnnotations: false,
    });
    // Trigger one-time custom-element registration (myoxus-mermaid, surface, etc.)
    // before mounting the block view into the dedicated host shell.
    manager.get("preview-edgeless");

    class PageMermaidThemeExtension
      extends LifeCycleWatcher
      implements ThemeExtension
    {
      static override readonly key = "myoxus-page-mermaid-theme";
      private readonly cleanupFns: (() => void)[] = [];
      private themeSignal?: Signal<ColorScheme>;

      static override setup(di: Container) {
        super.setup(di);
        di.override(ThemeExtensionIdentifier, PageMermaidThemeExtension, [
          StdIdentifier,
        ]);
      }

      getAppTheme() {
        if (this.themeSignal) return this.themeSignal;
        const appTheme = framework.getOptional(AppThemeService);
        if (!appTheme) {
          this.themeSignal = signal(ColorScheme.Light);
          return this.themeSignal;
        }
        const { signal: themeSignal, cleanup } =
          createSignalFromObservable<ColorScheme>(
            appTheme.appTheme.theme$.map((theme) =>
              theme === ColorScheme.Dark ? ColorScheme.Dark : ColorScheme.Light,
            ),
            ColorScheme.Light,
          );
        this.cleanupFns.push(cleanup);
        this.themeSignal = themeSignal;
        return themeSignal;
      }

      getEdgelessTheme() {
        return this.getAppTheme();
      }

      override unmounted() {
        for (const fn of this.cleanupFns) fn();
        this.cleanupFns.length = 0;
      }
    }

    const extensions: ExtensionType[] = [
      {
        setup(di) {
          di.addImpl(ViewExtensionManagerIdentifier, () => manager);
        },
      },
      ThemeService,
      PageMermaidThemeExtension,
      EditPropsStore,
      FontLoaderService,
      EditorI18nExtension(editorI18n),
      patchFileSizeLimitExtension(framework),
      patchNotificationService(confirmModal),
      patchMermaidFamilyReactHost(mountPortal),
      EdgelessCRUDExtension,
      ...MermaidBlockSpec,
    ];

    const std = new BlockStdScope({
      store: model.store,
      extensions,
    });
    let mounted: ReturnType<typeof std.mountBlock> | null = null;
    try {
      std.get(GfxControllerIdentifier).setModeResolver(() => "page");
      mounted = std.mountBlock(container, model);
    } catch (error) {
      std.unmount();
      throw error;
    }

    return () => {
      mounted?.dispose();
      std.unmount();
    };
  }, [confirmModal, framework, model, mountPortal]);

  return (
    <div
      data-page-mermaid={model.id}
      data-block-id={model.id}
      data-readonly={effectiveReadonly ? "true" : undefined}
      contentEditable={false}
    >
      <div ref={hostRef} />
      {portals.map((entry) => (
        <Fragment key={entry.id}>{entry.portal}</Fragment>
      ))}
    </div>
  );
}
