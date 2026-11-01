import { LiveData, Service } from "@myoxus/infra";
import { mobileShellCssVars } from "@myoxus/ui-facade/mobile-shell";

import type { VirtualKeyboardProvider } from "../providers/virtual-keyboard";

function setCssVars(element: HTMLElement, vars: Record<string, string>) {
  for (const [name, value] of Object.entries(vars)) {
    element.style.setProperty(name, value);
  }
}

export class VirtualKeyboardService extends Service {
  readonly visible$ = new LiveData(false);
  readonly height$ = new LiveData(0);

  staticHeight = 0;

  constructor(
    private readonly virtualKeyboardProvider: VirtualKeyboardProvider,
  ) {
    super();
    this._observe();
  }

  private _observe() {
    this.disposables.push(
      this.virtualKeyboardProvider.onChange((info) => {
        this.visible$.next(info.visible);
        this.height$.next(info.height);

        setCssVars(document.body, {
          [mobileShellCssVars.appKeyboardHeight]: `${this.height$.value}px`,
        });

        if (info.visible && this.staticHeight !== info.height) {
          this.staticHeight = info.height;
          setCssVars(document.body, {
            [mobileShellCssVars.appKeyboardStaticHeight]: `${this.staticHeight}px`,
          });
        }
      }),
    );
  }
}
