import { Entity, LiveData } from "@myoxus/infra";
import type { Signal } from "@preact/signals-core";
import { ColorScheme } from "@virgultum/editor/model";
import { createSignalFromObservable } from "@virgultum/shared/utils";

export class AppTheme extends Entity {
  theme$ = new LiveData<string | undefined>(undefined);

  themeSignal: Signal<ColorScheme>;

  constructor() {
    super();
    const { signal, cleanup } = createSignalFromObservable<ColorScheme>(
      this.theme$.map((theme) =>
        theme === "dark" ? ColorScheme.Dark : ColorScheme.Light,
      ),
      ColorScheme.Light,
    );
    this.themeSignal = signal;
    this.disposables.push(cleanup);
  }
}
