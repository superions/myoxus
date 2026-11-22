// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DocumentGraphDirection,
  outgoingNavigationQuery,
} from "@myoxus/graphql";
import { fromPromise, Service } from "@myoxus/infra";
import {
  catchError,
  combineLatest,
  debounceTime,
  defer,
  distinctUntilChanged,
  EMPTY,
  filter,
  finalize,
  fromEvent,
  map,
  merge,
  mergeMap,
  Observable,
  of,
  shareReplay,
  startWith,
  Subject,
  switchMap,
  takeUntil,
  tap,
  timer,
} from "rxjs";

import type { DocumentLifecycleStore } from "../../doc/stores/document-lifecycle";
import type { GuardService } from "../../permissions";
import type { WorkspaceServerService } from "../../server";
import type { Server } from "../../server/entities/server";
import { GraphQLService } from "../../server/services/graphql";
import type { WorkspaceService } from "../../workspace";
import { urlSearchParamsFromJson } from "../entities/doc-links";

type Target = { docId: string; title: string; params?: URLSearchParams };
type Block = { blockId: string; links: Target[] };

/** Last occurrence supplies parameters; first occurrence supplies position. */
export function navigationTargets(blocks: Block[], sources: string[]) {
  const targets = new Map<string, Target>();
  for (const block of blocks.slice(0, 100)) {
    for (const target of block.links) {
      if (!sources.includes(target.docId)) targets.set(target.docId, target);
    }
  }
  return Array.from(targets.values());
}

export class OutgoingNavigationService extends Service {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServer: WorkspaceServerService,
    private readonly lifecycle: DocumentLifecycleStore,
    private readonly guard: GuardService,
  ) {
    super();
  }

  private readonly active = new Map<string, Observable<Block[] | null>>();
  private readonly jobs = new Subject<() => Observable<unknown>>();
  private readonly pool = this.jobs
    .pipe(mergeMap((run) => run(), 4))
    .subscribe();
  private readonly stop = new Subject<void>();

  /** Entries exist only while observed. Losing the last subscriber cancels
   * queued and in-flight work; reopening reads in the current account scope. */
  watch(source: string): Observable<Block[] | null> {
    return defer(() => {
      const existing = this.active.get(source);
      if (existing) return existing;
      const session = this.workspaceServer.server$.pipe(
        switchMap((server) =>
          server
            ? server.account$.pipe(
                map((account) => account?.id),
                distinctUntilChanged(),
                map((id) => (id ? { server, id } : null)),
              )
            : of(null),
        ),
      );
      const result = combineLatest([
        session,
        this.lifecycle.state$(source),
        this.guard.can$("Doc_Read", source),
      ]).pipe(
        // Remote membership may remain `creating` until a leaf is mounted in
        // the editor. The graph can authorize that projected membership on
        // the server without hydrating the leaf or admitting a local create.
        map(([session, state, readable]) =>
          session &&
          state !== "not-found" &&
          readable !== false &&
          (state === "available" ||
            readable === true ||
            this.lifecycle.isRemoteMembershipPending(source))
            ? session
            : null,
        ),
        distinctUntilChanged(),
        switchMap((session) =>
          session ? this.observe(session.server, source) : of([]),
        ),
        takeUntil(this.stop),
        finalize(() => this.active.delete(source)),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      this.active.set(source, result);
      return result;
    });
  }

  private observe(server: Server, source: string) {
    const doc = this.workspaceService.workspace.engine.doc;
    const writes = doc.storedDocUpdates$.pipe(
      filter((id) => id === source),
      debounceTime(250),
      map(() => true),
    );
    return merge(
      writes,
      fromEvent(window, "online").pipe(map(() => false)),
    ).pipe(
      startWith(false),
      switchMap((afterWrite) => {
        // Deferring the initial request also avoids fetching for a LiveData
        // snapshot read that never acquires subscription demand.
        const ready: Observable<unknown> = afterWrite
          ? fromPromise((signal) => doc.waitForSynced(source, signal))
          : timer(0);
        return ready.pipe(
          switchMap(() => this.read(server, source)),
          switchMap((blocks) => this.applyRevocations(blocks)),
          catchError(() => of([])),
          startWith(null),
        );
      }),
    );
  }

  private read(
    server: Server,
    source: string,
    attempt = 0,
  ): Observable<Block[]> {
    const workspaceId = this.workspaceService.workspace.id;
    return this.schedule((signal) =>
      server.scope.get(GraphQLService).gql({
        query: outgoingNavigationQuery,
        variables: {
          workspaceId,
          input: {
            docId: source,
            direction: DocumentGraphDirection.Outgoing,
            first: 100,
          },
        },
        context: { signal },
      }),
    ).pipe(
      switchMap((data) => {
        const nav = data.workspace?.documentLinks.outgoingNavigation;
        if (nav?.pending && attempt < 3) {
          // Queue pickup takes seconds even for a single changed document.
          return timer([2000, 6000, 30000][attempt]).pipe(
            switchMap(() => this.read(server, source, attempt + 1)),
          );
        }
        return of(
          !nav || nav.pending
            ? []
            : nav.blocks.map((block) => ({
                blockId: block.blockId,
                links: block.links
                  .filter((link) => link.workspaceId === workspaceId)
                  .map((link) => ({
                    docId: link.docId,
                    title: link.title ?? link.docId,
                    params: urlSearchParamsFromJson(link.paramsJson),
                  })),
              })),
        );
      }),
    );
  }

  private applyRevocations(blocks: Block[]) {
    const ids = [
      ...new Set(blocks.flatMap((b) => b.links.map((link) => link.docId))),
    ];
    if (!ids.length) return of(blocks);
    // Observing existing decisions does not request permissions per target.
    return combineLatest(ids.map((id) => this.guard.can$("Doc_Read", id))).pipe(
      map((roles) => {
        const denied = new Set(ids.filter((_, i) => roles[i] === false));
        return blocks.map((b) => ({
          ...b,
          links: b.links.filter((l) => !denied.has(l.docId)),
        }));
      }),
    );
  }

  private schedule<T>(read: (signal: AbortSignal) => Promise<T>) {
    return new Observable<T>((sub) => {
      const cancel = new Subject<void>();
      this.jobs.next(() =>
        sub.closed
          ? EMPTY
          : fromPromise(read).pipe(
              takeUntil(cancel),
              tap((value) => sub.next(value)),
              catchError((error) => {
                sub.error(error);
                return EMPTY;
              }),
              finalize(() => sub.complete()),
            ),
      );
      return () => {
        cancel.next();
        cancel.complete();
      };
    });
  }

  override dispose() {
    this.stop.next();
    this.stop.complete();
    this.pool.unsubscribe();
    this.jobs.complete();
    super.dispose();
  }
}
