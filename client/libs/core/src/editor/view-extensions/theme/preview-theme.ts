import { AppThemeService } from "@myoxus/core/modules/theme";
import type { FrameworkProvider } from "@myoxus/infra";
import { ColorScheme } from "@virgultum/editor/model";
import {
  type ThemeExtension,
  ThemeExtensionIdentifier,
} from "@virgultum/editor/shared/services";
import {
  createSignalFromObservable,
  type Signal,
} from "@virgultum/editor/shared/utils";
import {
  type BlockStdScope,
  LifeCycleWatcher,
  StdIdentifier,
} from "@virgultum/editor/std";
import type { Container } from "@virgultum/global/di";
import type { Observable } from "rxjs";

export function getPreviewThemeExtension(framework: FrameworkProvider) {
  class MyoxusPagePreviewThemeExtension
    extends LifeCycleWatcher
    implements ThemeExtension
  {
    static override readonly key = "myoxus-page-preview-theme";

    readonly theme: Signal<ColorScheme>;

    readonly disposables: (() => void)[] = [];

    static override setup(di: Container) {
      super.setup(di);
      di.override(ThemeExtensionIdentifier, MyoxusPagePreviewThemeExtension, [
        StdIdentifier,
      ]);
    }

    constructor(std: BlockStdScope) {
      super(std);
      const theme$: Observable<ColorScheme> = framework
        .get(AppThemeService)
        .appTheme.theme$.map((theme) => {
          return theme === ColorScheme.Dark
            ? ColorScheme.Dark
            : ColorScheme.Light;
        });
      const { signal, cleanup } = createSignalFromObservable<ColorScheme>(
        theme$,
        ColorScheme.Light,
      );
      this.theme = signal;
      this.disposables.push(cleanup);
    }

    getAppTheme() {
      return this.theme;
    }

    getEdgelessTheme() {
      return this.theme;
    }

    override unmounted() {
      this.dispose();
    }

    dispose() {
      this.disposables.forEach((dispose) => dispose());
    }
  }

  return MyoxusPagePreviewThemeExtension;
}
