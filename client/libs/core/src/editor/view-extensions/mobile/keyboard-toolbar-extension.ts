import { VirtualKeyboardProvider } from "@myoxus/core/mobile/modules/virtual-keyboard";
import type { FrameworkProvider } from "@myoxus/infra";
import { mobileShellCssVars } from "@myoxus/ui-facade/mobile-shell";
import { batch, signal } from "@preact/signals-core";
import type { Container } from "@virgultum/editor/global/di";
import { DisposableGroup } from "@virgultum/editor/global/disposable";
import {
  VirtualKeyboardProvider as BSVirtualKeyboardProvider,
  type VirtualKeyboardProviderWithAction,
} from "@virgultum/editor/shared/services";
import { LifeCycleWatcher } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";

export function KeyboardToolbarExtension(
  framework: FrameworkProvider,
): ExtensionType {
  const myoxusVirtualKeyboardProvider = framework.get(VirtualKeyboardProvider);

  class BSVirtualKeyboardService
    extends LifeCycleWatcher
    implements BSVirtualKeyboardProvider
  {
    static override key = BSVirtualKeyboardProvider.identifierName;

    private readonly _disposables = new DisposableGroup();

    readonly visible$ = signal(false);

    readonly height$ = signal(0);

    readonly staticHeight$ = signal(0);

    readonly appTabSafeArea$ = signal(
      `var(${mobileShellCssVars.appTabSafeArea})`,
    );

    static override setup(di: Container) {
      super.setup(di);
      di.addImpl(BSVirtualKeyboardProvider, (provider) => {
        return provider.get(this);
      });
    }

    override mounted() {
      this._disposables.add(
        myoxusVirtualKeyboardProvider.onChange(({ visible, height }) => {
          batch(() => {
            if (visible && this.staticHeight$.peek() !== height) {
              this.staticHeight$.value = height;
            }
            this.visible$.value = visible;
            this.height$.value = height;
          });
        }),
      );
    }

    override unmounted() {
      this._disposables.dispose();
    }
  }

  if ("show" in myoxusVirtualKeyboardProvider) {
    const providerWithAction = myoxusVirtualKeyboardProvider;

    class BSVirtualKeyboardServiceWithShowAndHide
      extends BSVirtualKeyboardService
      implements VirtualKeyboardProviderWithAction
    {
      show() {
        providerWithAction.show();
      }

      hide() {
        providerWithAction.hide();
      }
    }

    return BSVirtualKeyboardServiceWithShowAndHide;
  }

  return BSVirtualKeyboardService;
}
