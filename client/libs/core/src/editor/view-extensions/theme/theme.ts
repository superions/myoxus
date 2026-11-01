import { DocService, DocsService } from "@myoxus/core/modules/doc";
import { AppThemeService } from "@myoxus/core/modules/theme";
import { type FrameworkProvider } from "@myoxus/infra";
import type { Container } from "@virgultum/editor/global/di";
import { ColorScheme } from "@virgultum/editor/model";
import {
  type ThemeExtension,
  ThemeExtensionIdentifier,
} from "@virgultum/editor/shared/services";
import {
  createSignalFromObservable,
  type Signal,
} from "@virgultum/editor/shared/utils";
import { LifeCycleWatcher, StdIdentifier } from "@virgultum/editor/std";
import { combineLatest, map, type Observable } from "rxjs";

export function getThemeExtension(
  framework: FrameworkProvider,
): typeof LifeCycleWatcher {
  class MyoxusThemeExtension
    extends LifeCycleWatcher
    implements ThemeExtension
  {
    static override readonly key = "myoxus-theme";

    private readonly themes: Map<string, Signal<ColorScheme>> = new Map();

    protected readonly disposables: (() => void)[] = [];

    static override setup(di: Container) {
      super.setup(di);
      di.override(ThemeExtensionIdentifier, MyoxusThemeExtension, [
        StdIdentifier,
      ]);
    }

    getAppTheme() {
      const keyName = "app-theme";
      const cache = this.themes.get(keyName);
      if (cache) return cache;

      const theme$: Observable<ColorScheme> = framework
        .get(AppThemeService)
        .appTheme.theme$.map((theme) => {
          return theme === ColorScheme.Dark
            ? ColorScheme.Dark
            : ColorScheme.Light;
        });
      const { signal: themeSignal, cleanup } =
        createSignalFromObservable<ColorScheme>(theme$, ColorScheme.Light);
      this.disposables.push(cleanup);
      this.themes.set(keyName, themeSignal);
      return themeSignal;
    }

    getEdgelessTheme(docId?: string) {
      const doc =
        (docId && framework.get(DocsService).list.doc$(docId).getValue()) ||
        framework.get(DocService).doc;

      const cache = this.themes.get(doc.id);
      if (cache) return cache;

      const appTheme$ = framework.get(AppThemeService).appTheme.theme$;
      const docTheme$ = doc.edgelessColorTheme$.map(
        (theme) => theme || "system",
      );
      const theme$: Observable<ColorScheme> = combineLatest([
        appTheme$,
        docTheme$,
      ]).pipe(
        map(([appTheme, docTheme]) => {
          const theme = docTheme === "system" ? appTheme : docTheme;
          return theme === ColorScheme.Dark
            ? ColorScheme.Dark
            : ColorScheme.Light;
        }),
      );
      const { signal: themeSignal, cleanup } =
        createSignalFromObservable<ColorScheme>(theme$, ColorScheme.Light);
      this.disposables.push(cleanup);
      this.themes.set(doc.id, themeSignal);
      return themeSignal;
    }

    override unmounted() {
      this.dispose();
    }

    dispose() {
      this.disposables.forEach((dispose) => dispose());
    }
  }

  return MyoxusThemeExtension;
}
