import { Entity, LiveData } from "@myoxus/infra";
import type { Location, To } from "react-router";
import { isEqual } from "lodash-es";
import {
  parseNavigationQuery,
  stringifyNavigationQuery,
} from "../../../utils/navigation-query";
import { Observable } from "rxjs";

import { createNavigableHistory } from "../../../utils/navigable-history";
import type {
  WorkbenchToolId,
  WorkbenchToolLayout,
  WorkbenchViewFamily,
} from "../../server/stores/user-preferences";
import type { ViewIconName } from "../constants";
import { ViewScope } from "../scopes/view";
import {
  ContextSurface,
  type ContextSurfaceDescriptor,
} from "./context-surface";
import {
  moveVisibleTool,
  type ResolvedWorkbenchToolLayout,
  resolveWorkbenchToolLayout,
} from "./tool-layout";

type ToolLayoutBinding = {
  token: symbol;
  workspaceId: string;
  viewFamily: WorkbenchViewFamily;
  override: WorkbenchToolLayout | null;
  persist: (layout: WorkbenchToolLayout) => void;
  openToolHost: () => void;
  closeToolHost: () => void;
};

export class View extends Entity<{
  id: string;
  defaultLocation?: To | undefined;
  title?: string;
  icon?: ViewIconName;
}> {
  scope = this.framework.createScope(ViewScope, {
    view: this as View,
  });

  get id() {
    return this.props.id;
  }

  set id(id: string) {
    this.props.id = id;
  }

  contextSurfaces$ = new LiveData<ContextSurface[]>([]);
  private contextSurfaceSequence = 0;

  scrollPositions = new WeakMap<
    Location,
    | number
    | {
        centerX: number;
        centerY: number;
        zoom: number;
      }
  >();

  private toolLayoutBinding$ = new LiveData<ToolLayoutBinding | null>(null);
  readonly toolViewFamily$ = LiveData.computed(
    (get) => get(this.toolLayoutBinding$)?.viewFamily ?? "document-page",
  );
  readonly toolLayout$ = LiveData.computed((get) => {
    const binding = get(this.toolLayoutBinding$);
    const surfaces = get(this.contextSurfaces$);
    const viewFamily = binding?.viewFamily ?? "document-page";
    return resolveWorkbenchToolLayout({
      viewFamily,
      registeredToolIds: surfaces
        .filter(
          (surface) =>
            surface.viewFamilies.length === 0 ||
            surface.viewFamilies.includes(viewFamily),
        )
        .map((surface) => surface.id),
      override: binding?.override ?? null,
    });
  });
  readonly toolHeaderFocusRequest$ = new LiveData<{
    id: WorkbenchToolId;
    sequence: number;
  } | null>(null);
  private toolHeaderFocusSequence = 0;

  // Initialize once before the LiveData seeds capture the pane's route/history.
  readonly history = createNavigableHistory({
    initialEntries: [this.props.defaultLocation ?? { pathname: "/all" }],
    initialIndex: 0,
  });
  private readonly closeGuards = new Set<() => boolean | Promise<boolean>>();
  readonly hasCloseGuards$ = new LiveData(false);
  private unblockHistory: (() => void) | null = null;

  /** A leased dialog may outlive its originating renderer. Register its public
   * close owner here before a pane/history intent can remove that origin. The
   * disposer belongs to the dialog/session, not the mounting editor view. */
  registerCloseGuard(guard: () => boolean | Promise<boolean>) {
    this.closeGuards.add(guard);
    this.hasCloseGuards$.next(true);
    this.bindGuardedHistory();
    return () => {
      this.closeGuards.delete(guard);
      this.hasCloseGuards$.next(this.closeGuards.size > 0);
      if (!this.closeGuards.size) {
        this.unblockHistory?.();
        this.unblockHistory = null;
      }
    };
  }
  /** Unguarded callers stay synchronous. Any failed participant vetoes the
   * intent; a guard registered during a pending decision was not admitted. */
  requestCloseGuards(): boolean | Promise<boolean> {
    const guards = [...this.closeGuards];
    const advance = (index: number): boolean | Promise<boolean> => {
      const guard = guards[index];
      if (!guard)
        return [...this.closeGuards].every((current) =>
          guards.includes(current),
        );
      if (!this.closeGuards.has(guard)) return advance(index + 1);
      try {
        const decision = guard();
        return typeof decision === "boolean"
          ? decision && advance(index + 1)
          : decision.then(
              (allowed) => allowed && advance(index + 1),
              () => false,
            );
      } catch {
        return false;
      }
    };
    return advance(0);
  }
  private bindGuardedHistory() {
    if (this.unblockHistory || !this.closeGuards.size) return;
    this.unblockHistory = this.history.block((intent) => {
      const origin = this.history.location;
      const proceed = (allowed: boolean) => {
        if (!allowed || this.history.location !== origin) return;
        // A blocker's retry re-enters history. Remove only our registration for
        // that replay; other blockers retain ownership of their own decisions.
        this.unblockHistory?.();
        this.unblockHistory = null;
        intent.retry();
        this.bindGuardedHistory();
      };
      const decision = this.requestCloseGuards();
      if (typeof decision === "boolean") proceed(decision);
      else void decision.then(proceed);
    });
  }

  location$ = LiveData.from<Location>(
    new Observable((subscriber) => {
      subscriber.next(this.history.location);
      return this.history.listen((update) => {
        subscriber.next(update.location);
      });
    }),
    this.history.location,
  );

  entries$ = LiveData.from<Location[]>(
    new Observable((subscriber) => {
      subscriber.next(this.history.entries);
      return this.history.listen(() => {
        subscriber.next(this.history.entries);
      });
    }),
    this.history.entries,
  );

  size$ = new LiveData(100);

  title$ = new LiveData(this.props.title ?? "");

  icon$ = new LiveData(this.props.icon ?? "allDocs");

  /** Split-pane routes own their inner scrolling; ordinary routes grow normally. */
  bodyViewportBounded$ = new LiveData(false);

  queryString$<T extends Record<string, unknown>>(
    parse: (search: string) => Partial<T> = (search) =>
      parseNavigationQuery(search, {
        parseNumbers: true,
        parseBooleans: true,
      }) as Partial<T>,
  ) {
    return this.location$.selector((v) => v.search).map(parse);
  }

  updateQueryString<T extends Record<string, unknown>>(
    patch: Partial<T>,
    {
      forceUpdate,
      parseNumbers,
      replace,
    }: {
      forceUpdate?: boolean;
      parseNumbers?: boolean;
      replace?: boolean;
    } = {},
  ) {
    const oldQueryStrings = parseNavigationQuery(location.search, {
      parseBooleans: true,
      parseNumbers: parseNumbers,
    });
    const newQueryStrings = { ...oldQueryStrings, ...patch };

    if (forceUpdate || !isEqual(oldQueryStrings, newQueryStrings)) {
      const search = stringifyNavigationQuery(newQueryStrings);

      const newState = {
        ...this.history.location,
        search,
      };

      if (replace) {
        this.history.replace(newState);
      } else {
        this.history.push(newState);
      }
    }
  }

  push(path: To) {
    this.history.push(path);
  }

  go(n: number) {
    this.history.go(n);
  }

  replace(path: To) {
    this.history.replace(path);
  }

  setSize(size?: number) {
    this.size$.next(size ?? 100);
  }

  addContextSurface(surface: ContextSurfaceDescriptor) {
    const descriptor = surface;
    const existing = this.contextSurfaces$.value.find(
      (candidate) => candidate.id === descriptor.id,
    );
    const sequence = existing?.sequence ?? this.contextSurfaceSequence++;
    const nextSurface = this.scope.createEntity(ContextSurface, {
      ...descriptor,
      sequence,
    });
    const nextSurfaces = [
      ...this.contextSurfaces$.value.filter(
        (candidate) => candidate.id !== descriptor.id,
      ),
      nextSurface,
    ].sort((a, b) => a.order - b.order || a.sequence - b.sequence);

    this.contextSurfaces$.next(nextSurfaces);
    return descriptor.id;
  }

  removeContextSurface(id: WorkbenchToolId) {
    this.contextSurfaces$.next(
      this.contextSurfaces$.value.filter((surface) => surface.id !== id),
    );
  }

  bindToolLayout(binding: Omit<ToolLayoutBinding, "token">): () => void {
    const token = Symbol("workbench-tool-layout-binding");
    this.toolLayoutBinding$.next({ ...binding, token });
    return () => {
      if (this.toolLayoutBinding$.value?.token === token) {
        this.toolLayoutBinding$.next(null);
      }
    };
  }

  private persistToolLayout(layout: ResolvedWorkbenchToolLayout) {
    const binding = this.toolLayoutBinding$.value;
    if (!binding) return;
    const override: WorkbenchToolLayout = {
      workspaceId: binding.workspaceId,
      viewFamily: binding.viewFamily,
      ...layout,
    };
    this.toolLayoutBinding$.next({ ...binding, override });
    binding.persist(override);
  }

  showTool(id: WorkbenchToolId) {
    if (!this.contextSurfaces$.value.some((surface) => surface.id === id)) {
      return;
    }
    const current = this.toolLayout$.value;
    if (
      !current.visibleToolIds.includes(id) ||
      current.collapsedToolIds.includes(id)
    ) {
      this.persistToolLayout({
        orderedToolIds: current.orderedToolIds.includes(id)
          ? current.orderedToolIds
          : [...current.orderedToolIds, id],
        visibleToolIds: current.visibleToolIds.includes(id)
          ? current.visibleToolIds
          : [...current.visibleToolIds, id],
        collapsedToolIds: current.collapsedToolIds.filter(
          (candidate) => candidate !== id,
        ),
      });
    }
    this.toolLayoutBinding$.value?.openToolHost();
    this.toolHeaderFocusRequest$.next({
      id,
      sequence: this.toolHeaderFocusSequence++,
    });
  }

  /** Open a registered product-default tool without materializing an override. */
  showDefaultTool(id: WorkbenchToolId) {
    const binding = this.toolLayoutBinding$.value;
    if (
      !binding ||
      binding.override !== null ||
      !this.contextSurfaces$.value.some((surface) => surface.id === id) ||
      !this.toolLayout$.value.visibleToolIds.includes(id)
    ) {
      return;
    }
    binding.openToolHost();
    this.toolHeaderFocusRequest$.next({
      id,
      sequence: this.toolHeaderFocusSequence++,
    });
  }

  /** Resolve each existing surface's draft before a pane is removed. */
  requestClose(next: () => void) {
    const decision = this.requestCloseGuards();
    if (typeof decision === "boolean") {
      if (decision) this.requestSurfaceClose(next);
    } else
      void decision.then((allowed) => {
        if (allowed) this.requestSurfaceClose(next);
      });
  }
  private requestSurfaceClose(next: () => void) {
    const surfaces = [...this.contextSurfaces$.value];
    const bindingToken = this.toolLayoutBinding$.value?.token;
    const advance = (index: number) => {
      if (this.toolLayoutBinding$.value?.token !== bindingToken) return;
      const surface = surfaces[index];
      if (!surface) {
        // A newly mounted surface was not part of this close decision.
        if (
          this.contextSurfaces$.value.some(
            (current) => !surfaces.includes(current),
          )
        )
          return;
        next();
        return;
      }
      if (!this.contextSurfaces$.value.includes(surface)) {
        advance(index + 1);
        return;
      }
      let continued = false;
      surface.requestClose(() => {
        if (continued) return;
        continued = true;
        advance(index + 1);
      });
    };
    advance(0);
  }

  hideTool(id: WorkbenchToolId) {
    if (!this.toolLayout$.value.visibleToolIds.includes(id)) return;
    const binding = this.toolLayoutBinding$.value;
    const surface = this.contextSurfaces$.value.find(
      (surface) => surface.id === id,
    );
    let continued = false;
    const hide = () => {
      if (continued || this.toolLayoutBinding$.value?.token !== binding?.token)
        return;
      if (surface && !this.contextSurfaces$.value.includes(surface)) return;
      continued = true;
      // Resolve current layout after an asynchronous decision, never a stale copy.
      const current = this.toolLayout$.value;
      if (!current.visibleToolIds.includes(id)) return;
      const visibleIndex = current.visibleToolIds.indexOf(id);
      const nextFocusId =
        current.visibleToolIds[visibleIndex + 1] ??
        current.visibleToolIds[visibleIndex - 1];
      this.persistToolLayout({
        ...current,
        visibleToolIds: current.visibleToolIds.filter(
          (candidate) => candidate !== id,
        ),
        collapsedToolIds: current.collapsedToolIds.filter(
          (candidate) => candidate !== id,
        ),
      });
      if (nextFocusId) {
        this.toolHeaderFocusRequest$.next({
          id: nextFocusId,
          sequence: this.toolHeaderFocusSequence++,
        });
      } else {
        this.toolLayoutBinding$.value?.closeToolHost();
      }
    };
    if (surface) surface.requestClose(hide);
    else hide();
  }

  toggleToolCollapsed(id: WorkbenchToolId) {
    const current = this.toolLayout$.value;
    if (!current.visibleToolIds.includes(id)) return;
    this.persistToolLayout({
      ...current,
      collapsedToolIds: current.collapsedToolIds.includes(id)
        ? current.collapsedToolIds.filter((candidate) => candidate !== id)
        : [...current.collapsedToolIds, id],
    });
  }

  moveTool(id: WorkbenchToolId, targetIndex: number) {
    const current = this.toolLayout$.value;
    const next = moveVisibleTool(current, id, targetIndex);
    if (next !== current) this.persistToolLayout(next);
  }

  getScrollPosition() {
    return this.scrollPositions.get(this.history.location);
  }

  setScrollPosition(
    position:
      | number
      | {
          centerX: number;
          centerY: number;
          zoom: number;
        },
  ) {
    this.scrollPositions.set(this.history.location, position);
  }

  setTitle(title: string) {
    this.title$.next(title);
  }

  setIcon(icon: ViewIconName) {
    this.icon$.next(icon);
  }
}
