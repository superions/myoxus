import { computed } from "@preact/signals-core";
import type { DisposableMember } from "@virgultum/global/disposable";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import type {
  DatabaseAllEvents,
  DatabaseAllViewEvents,
  EventTraceFn,
} from "@virgultum/shared/services";
import type { UniComponent } from "@virgultum/shared/types";
import type { InsertToPosition } from "@virgultum/shared/utils";
import {
  type EventName,
  ShadowlessElement,
  type UIEventHandler,
} from "@virgultum/std";
import { property } from "lit/decorators.js";

import type { DataViewRootUILogic } from "../data-view.js";
import type { DataViewSelection } from "../types.js";
import type { SingleView } from "../view-manager/single-view.js";
import type { DataViewWidget } from "../widget/index.js";
import type { DataViewInstance, DataViewProps } from "./types.js";

export abstract class DataViewBase<
  Selection extends DataViewSelection = DataViewSelection,
> extends SignalWatcher(WithDisposable(ShadowlessElement)) {
  abstract expose: DataViewInstance;

  @property({ attribute: false })
  accessor props!: DataViewProps<Selection>;
}
export abstract class DataViewUIBase<
  Logic extends DataViewUILogicBase = DataViewUILogicBase,
> extends SignalWatcher(WithDisposable(ShadowlessElement)) {
  @property({ attribute: false })
  accessor logic!: Logic;
}

export abstract class DataViewUILogicBase<
  T extends SingleView = SingleView,
  Selection extends DataViewSelection = DataViewSelection,
> {
  constructor(
    public readonly root: DataViewRootUILogic,
    public readonly view: T,
  ) {}

  get headerWidget(): DataViewWidget | undefined {
    return this.root.config.headerWidget;
  }
  bindHotkey(hotkeys: Record<string, UIEventHandler>): DisposableMember {
    return this.root.config.bindHotkey(
      Object.fromEntries(
        Object.entries(hotkeys).map(([key, fn]) => [
          key,
          (ctx) => {
            return fn(ctx);
          },
        ]),
      ),
    );
  }
  handleEvent(name: EventName, handler: UIEventHandler): DisposableMember {
    return this.root.config.handleEvent(name, (context) => {
      return handler(context);
    });
  }
  setSelection(selection?: Selection) {
    this.root.setSelection(selection);
  }

  /**
   * Liefert die aktuelle `ViewportContext` (P-VIRG-ARCH-E-02).
   *
   * Default: Page-Viewport (`{ scale: 1 }`). View-Presets, die
   * Edgeless-Skalierung benoetigen (z.B. Kanban), ueberschreiben
   * diese Methode. Wird auf der Basis-Klasse bereitgestellt, damit
   * die Controller (Selection, Drag) konsumiert werden koennen,
   * ohne dass Test-Stubs der View-Logik die Methode mocken muessen.
   */
  currentViewport(): { readonly scale: number } {
    return { scale: 1 };
  }

  selection$ = computed<Selection | undefined>(() => {
    const selection$ = this.root.selection$;
    if (selection$.value?.viewId === this.view.id) {
      return selection$.value as Selection | undefined;
    }
    return;
  });

  eventTrace: EventTraceFn<DatabaseAllViewEvents> = (key, params) => {
    this.root.config.eventTrace(key, {
      ...(params as DatabaseAllEvents[typeof key]),
      viewId: this.view.id,
      viewType: this.view.type,
    });
  };

  abstract clearSelection: () => void;
  abstract addRow: (position: InsertToPosition) => string | undefined;
  abstract focusFirstCell: () => void;
  abstract showIndicator: (evt: MouseEvent) => boolean;
  abstract hideIndicator: () => void;
  abstract moveTo: (id: string, evt: MouseEvent) => void;

  abstract renderer: UniComponent<{
    logic: DataViewUILogicBase<T, Selection>;
  }>;
}

type Constructor<T extends abstract new (...args: any) => any> = new (
  ...args: ConstructorParameters<T>
) => InstanceType<T>;

export type DataViewUILogicBaseConstructor = Constructor<
  typeof DataViewUILogicBase
>;
