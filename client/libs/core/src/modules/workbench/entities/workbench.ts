import { toDocSearchParams } from "@myoxus/core/modules/navigation/utils";
import { Unreachable } from "@myoxus/env/constant";
import { Entity, LiveData } from "@myoxus/infra";
import type { ReferenceParams } from "@virgultum/editor/model";
import { type To } from "react-router";
import { omit } from "lodash-es";
import { nanoid } from "nanoid";

import type { GlobalState } from "../../storage";
import type { WorkbenchNewTabHandler } from "../services/workbench-new-tab-handler";
import type { WorkbenchDefaultState } from "../services/workbench-view-state";
import { View } from "./view";

export type WorkbenchPosition = "beside" | "active" | "head" | "tail" | number;

export type WorkbenchOpenOptions = {
  at?: WorkbenchPosition | "new-tab";
  replaceHistory?: boolean;
  show?: boolean; // only for new tab
};

const workspaceSelectorOpenKey = "workspaceSelectorOpen";

export class Workbench extends Entity {
  constructor(
    private readonly defaultState: WorkbenchDefaultState,
    private readonly newTabHandler: WorkbenchNewTabHandler,
    private readonly globalState: GlobalState,
  ) {
    super();
  }

  readonly activeViewIndex$ = new LiveData(this.defaultState.activeViewIndex);
  readonly basename$ = new LiveData(this.defaultState.basename);

  readonly views$: LiveData<View[]> = new LiveData(
    this.defaultState.views.map((meta) => {
      return this.framework.createEntity(View, {
        id: meta.id,
        defaultLocation: meta.path,
        icon: meta.icon,
        title: meta.title,
      });
    }),
  );

  activeView$ = LiveData.computed((get) => {
    const activeIndex = get(this.activeViewIndex$);
    const views = get(this.views$);
    // activeIndex could be out of bounds when reordering views
    return views.at(activeIndex) || views[0];
  });

  location$ = LiveData.computed((get) => {
    return get(get(this.activeView$).location$);
  });
  /** Rail visibility is transient Workbench state, never an account/device preference. */
  contextPanelOpen$ = new LiveData(false);
  setContextPanelOpen(open: boolean) {
    if (this.contextPanelOpen$.value === open) return;
    this.contextPanelOpen$.next(open);
  }

  workspaceSelectorOpen$ = LiveData.from(
    this.globalState.watch<boolean>(workspaceSelectorOpenKey),
    this.globalState.get<boolean>(workspaceSelectorOpenKey) ?? false,
  );
  setWorkspaceSelectorOpen(open: boolean) {
    if (this.workspaceSelectorOpen$.value === open) return;
    this.globalState.set(workspaceSelectorOpenKey, open);
  }

  active(index: number | View) {
    const origin = this.activeView$.value;
    const target =
      typeof index === "number"
        ? this.views$.value[
            Math.max(0, Math.min(index, this.views$.value.length - 1))
          ]
        : index;
    if (!target || target === origin) return;
    const activate = (allowed: boolean) => {
      if (
        allowed &&
        this.activeView$.value === origin &&
        this.views$.value.includes(target)
      )
        this.activeViewIndex$.next(this.views$.value.indexOf(target));
    };
    const decision = origin.requestCloseGuards();
    if (typeof decision === "boolean") activate(decision);
    else void decision.then(activate);
  }
  /** Browser/router scope changes must consult every leased pane participant
   * before replacing the workspace, not after its services have been disposed. */
  requestCloseGuards(): boolean | Promise<boolean> {
    const views = [...this.views$.value];
    const advance = (index: number): boolean | Promise<boolean> => {
      const view = views[index];
      if (!view)
        return this.views$.value.every(
          (current) =>
            !current.hasCloseGuards$.value || views.includes(current),
        );
      const decision = view.requestCloseGuards();
      return typeof decision === "boolean"
        ? decision && advance(index + 1)
        : decision.then((allowed) => allowed && advance(index + 1));
    };
    return advance(0);
  }

  updateBasename(basename: string) {
    this.basename$.next(basename);
  }

  createView(
    at: WorkbenchPosition = "beside",
    defaultLocation: To,
    active = true,
  ) {
    const origin = this.activeView$.value;
    const create = () => {
      if (active && this.activeView$.value !== origin) return undefined;
      const view = this.framework.createEntity(View, {
        id: nanoid(),
        defaultLocation,
      });
      const newViews = [...this.views$.value];
      newViews.splice(this.indexAt(at), 0, view);
      this.views$.next(newViews);
      // Inserting before the active pane must not select a different pane while
      // a decision is pending. Activation below has already been admitted.
      const index = newViews.indexOf(view);
      this.activeViewIndex$.next(active ? index : newViews.indexOf(origin));
      return index;
    };
    if (!active) return create();
    const decision = origin.requestCloseGuards();
    if (typeof decision === "boolean") return decision ? create() : undefined;
    // Existing callers remain synchronous when unguarded; a guarded split/open
    // is deferred as one intent, with no orphan pane left behind after Cancel.
    void decision.then((allowed) => {
      if (allowed) create();
    });
    return undefined;
  }

  openContextPanel() {
    this.setContextPanelOpen(true);
  }

  closeContextPanel() {
    this.setContextPanelOpen(false);
  }

  toggleContextPanel() {
    this.setContextPanelOpen(!this.contextPanelOpen$.value);
  }

  openWorkspaceSelector() {
    this.setWorkspaceSelectorOpen(true);
  }

  closeWorkspaceSelector() {
    this.setWorkspaceSelectorOpen(false);
  }

  toggleWorkspaceSelector() {
    this.setWorkspaceSelectorOpen(!this.workspaceSelectorOpen$.value);
  }

  open(to: To, option: WorkbenchOpenOptions = {}) {
    if (option.at === "new-tab") {
      this.newTab(to, {
        show: option.show,
      });
    } else {
      const { at = "active", replaceHistory = false } = option;
      let view = this.viewAt(at);
      if (!view) {
        const newIndex = this.createView(at, to, option.show);
        if (newIndex === undefined) return;
        view = this.viewAt(newIndex);
        if (!view) {
          throw new Unreachable();
        }
      } else {
        if (replaceHistory) {
          view.history.replace(to);
        } else {
          view.history.push(to);
        }
      }
    }
  }

  newTab(
    to: To,
    {
      show,
    }: {
      show?: boolean;
    } = {},
  ) {
    this.newTabHandler.handle({
      basename: this.basename$.value,
      to,
      show: show ?? true,
    });
  }

  openDoc(
    id:
      | string
      | ({
          docId: string;
          refreshKey?: string;
          fromTab?: string;
        } & ReferenceParams),
    options?: WorkbenchOpenOptions,
  ) {
    const isString = typeof id === "string";
    const docId = isString ? id : id.docId;

    let query = "";
    if (!isString) {
      const search = toDocSearchParams(omit(id, ["docId"]));
      if (search?.size) {
        query = `?${search.toString()}`;
      }
    }

    this.open(`/${docId}${query}`, options);
  }

  openAttachment(
    docId: string,
    blockId: string,
    options?: WorkbenchOpenOptions,
  ) {
    this.open(`/${docId}/attachments/${blockId}`, options);
  }

  openCollections(options?: WorkbenchOpenOptions) {
    this.open("/collection", options);
  }

  openCollection(collectionId: string, options?: WorkbenchOpenOptions) {
    const search = new URLSearchParams({ collection: collectionId });
    this.open(`/all?${search.toString()}`, options);
  }

  openAll(options?: WorkbenchOpenOptions) {
    this.open("/all", options);
  }

  openTrash(options?: WorkbenchOpenOptions) {
    this.open("/trash", options);
  }

  openTag(tagId: string, options?: WorkbenchOpenOptions) {
    this.open(`/tag/${tagId}`, options);
  }

  viewAt(positionIndex: WorkbenchPosition): View | undefined {
    return this.views$.value[this.indexAt(positionIndex)];
  }

  close(view: View) {
    if (this.views$.value.length === 1 || !this.views$.value.includes(view))
      return;
    view.requestClose(() => {
      // A draft decision may outlive another pane close or reorder.
      const index = this.views$.value.indexOf(view);
      if (index === -1 || this.views$.value.length === 1) return;
      const newViews = [...this.views$.value];
      newViews.splice(index, 1);
      const active = this.activeView$.value;
      // Removing a background pane only reindexes the same active entity; it
      // must not request that unrelated pane's close guard. If the active pane
      // is removed, its own close decision has already been obtained above.
      this.activeViewIndex$.next(
        active === view ? Math.max(0, index - 1) : newViews.indexOf(active),
      );
      this.views$.next(newViews);
    });
  }

  closeOthers(view: View) {
    if (!this.views$.value.includes(view)) return;
    const removed = this.views$.value.filter((candidate) => candidate !== view);
    const advance = (index: number) => {
      if (!this.views$.value.includes(view)) return;
      const candidate = removed[index];
      if (candidate) {
        if (!this.views$.value.includes(candidate)) {
          advance(index + 1);
          return;
        }
        let continued = false;
        candidate.requestClose(() => {
          if (continued) return;
          continued = true;
          advance(index + 1);
        });
        return;
      }
      // Panes opened while confirmation was pending were not admitted to close.
      const remaining = this.views$.value.filter(
        (candidate) => !removed.includes(candidate),
      );
      if (remaining.length === 1) view.size$.next(100);
      this.views$.next(remaining);
      this.active(remaining.indexOf(view));
    };
    advance(0);
  }

  moveView(from: number, to: number) {
    from = Math.max(0, Math.min(from, this.views$.value.length - 1));
    to = Math.max(0, Math.min(to, this.views$.value.length - 1));
    if (from === to) return;
    const views = [...this.views$.value];
    const fromView = views[from];
    const toView = views[to];
    views[to] = fromView;
    views[from] = toView;
    this.views$.next(views);
    this.active(to);
  }

  /**
   * resize specified view and the next view
   * @param view
   * @param percent from 0 to 1
   * @returns
   */
  resize(index: number, percent: number) {
    const view = this.views$.value[index];
    const nextView = this.views$.value[index + 1];
    if (!nextView) return;

    const totalViewSize = this.views$.value.reduce(
      (sum, v) => sum + v.size$.value,
      0,
    );
    const percentOfTotal = totalViewSize * percent;
    const newSize = Number((view.size$.value + percentOfTotal).toFixed(4));
    const newNextSize = Number(
      (nextView.size$.value - percentOfTotal).toFixed(4),
    );
    // TODO(@catsjuice): better strategy to limit size
    if (newSize / totalViewSize < 0.2 || newNextSize / totalViewSize < 0.2)
      return;
    view.setSize(newSize);
    nextView.setSize(newNextSize);
  }

  private indexAt(positionIndex: WorkbenchPosition): number {
    if (positionIndex === "active") {
      return this.activeViewIndex$.value;
    }
    if (positionIndex === "beside") {
      return this.activeViewIndex$.value + 1;
    }
    if (positionIndex === "head") {
      return 0;
    }
    if (positionIndex === "tail") {
      return this.views$.value.length;
    }
    return positionIndex;
  }
}
