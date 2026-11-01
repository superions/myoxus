import {
  archiveWorkspaceTagMutation,
  createWorkspaceTagMutation,
  deleteWorkspaceTagPermanentlyMutation,
  recolorWorkspaceTagMutation,
  renameWorkspaceTagMutation,
  restoreWorkspaceTagMutation,
  setDocumentWorkspaceTagsMutation,
  updateWorkspaceTagDescriptionMutation,
  workspaceTagCatalogQuery,
  workspaceTagsQuery,
  type DocumentMetadataIndexQuery,
  documentWorkspaceTagAssignmentsQuery,
  workspaceTagDatabaseRowUsagesQuery,
  type WorkspaceTagDatabaseRowUsagesQuery,
  type WorkspaceTagDocumentUsagesQuery,
  workspaceTagDocumentUsagesQuery,
  type WorkspaceTagFieldsFragment,
} from "@myoxus/graphql";
import { LiveData, Store, yjsObserveDeep } from "@myoxus/infra";
import type { TagColorRole } from "@myoxus/ui-facade";
import { BehaviorSubject, Observable, switchMap } from "rxjs";
import type { WorkspaceServerService } from "../../server";
import { GraphQLService } from "../../server/services/graphql";
import type { WorkspaceService } from "../../workspace";
import {
  isWorkspaceTagColorRole,
  workspaceTagColorRoleOrGrey,
} from "../color-role";
import { nanoid } from "nanoid";

const REFRESH_MS = 5_000;
const BATCH_SIZE = 200;
function tagColorRole(value: string): TagColorRole {
  if (isWorkspaceTagColorRole(value)) return value;
  throw new Error(
    `Server returned unsupported workspace tag color role: ${value}`,
  );
}
export type Tag = {
  value: string;
  id: string;
  color: TagColorRole;
  description: string | null;
  archived?: boolean;
  createDate?: number | Date | undefined;
  updateDate?: number | Date | undefined;
  parentId?: string | undefined;
  documentCount?: number;
  databaseRowCount?: number;
};

export type TagCatalogState =
  | {
      status: "loading";
      tags: Tag[];
      error: null;
    }
  | {
      status: "ready";
      tags: Tag[];
      error: null;
    }
  | {
      status: "error";
      tags: Tag[];
      error: unknown;
    };

function fromServerTag(tag: WorkspaceTagFieldsFragment): Tag {
  return {
    id: tag.id,
    value: tag.name,
    color: tagColorRole(tag.colorRole),
    description: tag.description,
    archived: tag.archived,
    createDate: Date.parse(tag.createdAt),
    updateDate: Date.parse(tag.updatedAt),
  };
}

function compareTags(left: Tag, right: Tag) {
  if (Boolean(left.archived) !== Boolean(right.archived)) {
    return left.archived ? 1 : -1;
  }
  const byName = left.value.localeCompare(right.value, undefined, {
    sensitivity: "base",
  });
  return byName || left.id.localeCompare(right.id);
}

export type TagAssignmentState = {
  status: "loading" | "ready" | "error";
  /** null is unavailable/unconfirmed; [] is a confirmed empty assignment. */
  ids: string[] | null;
  error: unknown;
};
type ObservedIds = {
  state: BehaviorSubject<TagAssignmentState>;
  observers: number;
  fetchedAt: number;
};

type DatabaseUsage = NonNullable<
  WorkspaceTagDatabaseRowUsagesQuery["workspace"]
>["workspaceTagDatabaseRowUsages"][number];
type DatabaseUsageState = {
  status: "loading" | "ready" | "error";
  rows: DatabaseUsage[];
  hasMore: boolean;
  error: unknown;
};
type ObservedDatabaseUsage = {
  state: BehaviorSubject<DatabaseUsageState>;
  observers: number;
  limit: number;
  fetchedAt: number;
};

export class TagStore extends Store {
  private readonly catalog = new BehaviorSubject<TagCatalogState>({
    status: "loading",
    tags: [],
    error: null,
  });
  private catalogObservers = 0;
  private catalogFetchedAt = 0;
  private countsFetchedAt = 0;
  private countObservers = 0;
  private readonly catalogCounts = new BehaviorSubject<TagCatalogState>({
    status: "loading",
    tags: [],
    error: null,
  });
  readonly catalogWithCountsState$ = LiveData.from(
    new Observable<TagCatalogState>((subscriber) => {
      this.countObservers++;
      const subscription = this.catalogCounts.subscribe(subscriber);
      this.observeChanged(this.countsFetchedAt);
      return () => {
        subscription.unsubscribe();
        this.countObservers--;
      };
    }),
    this.catalogCounts.value,
  );
  readonly catalogState$ = LiveData.from(
    new Observable<TagCatalogState>((subscriber) => {
      this.catalogObservers++;
      const subscription = this.catalog.subscribe(subscriber);
      this.observeChanged(this.catalogFetchedAt);
      return () => {
        subscription.unsubscribe();
        this.catalogObservers--;
      };
    }),
    this.catalog.value,
  );
  readonly tagOptions$ = this.catalogState$.map((state) => state.tags);
  private readonly assignments = new Map<string, ObservedIds>();
  private readonly usages = new Map<string, ObservedIds>();
  private readonly databaseUsages = new Map<string, ObservedDatabaseUsage>();
  private refreshRun: Promise<void> | null = null;
  private refreshQueued = false;
  private queuedForce = false;
  private pending = false;
  private pendingForce = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Older reads cannot overwrite an acknowledged write or a newer inventory.
  readonly inventoryRevision$ = new LiveData(0);
  private get writeRevision() {
    return this.inventoryRevision$.value;
  }

  get inventoryRevision() {
    return this.writeRevision;
  }

  /** Prime labels before publishing the authorized list, without per-row reads.
   * Reads started before an acknowledged Tag write cannot replace its result.
   */
  primeInventory(snapshot: DocumentMetadataIndexQuery, revision: number) {
    if (this.local || !this.canRead || revision !== this.writeRevision) return;
    if (snapshot.workspace?.id !== this.workspace.id)
      throw new Error("Workspace label index is unavailable");
    const tags = snapshot.workspace.workspaceTags
      .map(fromServerTag)
      .sort(compareTags);
    const known = new Set(tags.map((tag) => tag.id));
    if (
      snapshot.documentMetadataIndex.some((row) =>
        row.tagIds.some((id) => !known.has(id)),
      )
    )
      throw new Error("Document label index references an unavailable label");
    // Fence an older standalone label read as well as older list responses.
    this.inventoryRevision$.next(this.writeRevision + 1);
    this.catalogFetchedAt = Date.now();
    this.catalog.next({ status: "ready", tags, error: null });
    for (const row of snapshot.documentMetadataIndex) {
      if (row.externalId)
        this.accept(this.entry(this.assignments, row.externalId), row.tagIds);
    }
    if (this.countObservers) this.scheduleRefresh();
    this.armTimer();
  }

  private get workspace() {
    return this.workspaceService.workspace;
  }
  private get local() {
    return this.workspace.flavour === "local";
  }
  private get graphqlService() {
    const server = this.workspaceServerService.server;
    if (!server) throw new Error("Workspace label server is unavailable");
    return server.scope.get(GraphQLService);
  }
  private get online() {
    return typeof navigator === "undefined" || navigator.onLine;
  }
  private get visible() {
    return (
      typeof document === "undefined" || document.visibilityState !== "hidden"
    );
  }
  private get canRead() {
    return !this.stopped && this.online && this.visible;
  }

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
  ) {
    super();
    if (this.local) {
      const subscription = yjsObserveDeep(
        this.workspace.rootYDoc.getMap("meta"),
      ).subscribe(() => this.refreshLocal());
      this.disposables.push(() => subscription.unsubscribe());
      this.refreshLocal();
    } else if (typeof window !== "undefined") {
      const changed = () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (!this.online)
          this.markUnavailable(
            new Error("Workspace labels are unavailable offline"),
          );
        if (this.canRead) this.scheduleRefresh(true);
      };
      window.addEventListener("online", changed);
      window.addEventListener("offline", changed);
      window.addEventListener("focus", changed);
      document.addEventListener("visibilitychange", changed);
      this.disposables.push(() => {
        window.removeEventListener("online", changed);
        window.removeEventListener("offline", changed);
        window.removeEventListener("focus", changed);
        document.removeEventListener("visibilitychange", changed);
      });
    }
  }

  private entry(map: Map<string, ObservedIds>, id: string): ObservedIds {
    let entry = map.get(id);
    if (!entry) {
      entry = {
        state: new BehaviorSubject<TagAssignmentState>({
          status: "loading",
          ids: null,
          error: null,
        }),
        observers: 0,
        fetchedAt: 0,
      };
      map.set(id, entry);
    }
    return entry;
  }
  private observe(map: Map<string, ObservedIds>, id: string) {
    return new Observable<TagAssignmentState>((subscriber) => {
      const entry = this.entry(map, id);
      entry.observers++;
      if (this.local) this.refreshLocal();
      const subscription = entry.state.subscribe(subscriber);
      this.observeChanged(entry.fetchedAt);
      return () => {
        subscription.unsubscribe();
        entry.observers--;
      };
    });
  }
  pageTagState$(id: string) {
    return LiveData.from(
      this.observe(this.assignments, id),
      this.entry(this.assignments, id).state.value,
    );
  }
  watchPageTags(id: string) {
    return this.pageTagState$(id).map((state) => state.ids ?? []);
  }
  private observeChanged(fetchedAt: number) {
    if (this.local) return;
    if (!this.online)
      this.markUnavailable(
        new Error("Workspace labels are unavailable offline"),
      );
    if (!fetchedAt || Date.now() - fetchedAt >= REFRESH_MS)
      this.scheduleRefresh();
    else this.armTimer();
  }
  private hasObservers() {
    return (
      this.catalogObservers > 0 ||
      this.countObservers > 0 ||
      [
        ...this.assignments.values(),
        ...this.usages.values(),
        ...this.databaseUsages.values(),
      ].some((entry) => entry.observers > 0)
    );
  }
  private armTimer() {
    if (this.local || this.timer || !this.canRead || !this.hasObservers())
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.hasObservers()) this.scheduleRefresh();
    }, REFRESH_MS);
  }
  private scheduleRefresh(force = false) {
    if (this.local || !this.canRead) return;
    this.queuedForce ||= force;
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    // Coalesce synchronous subscriptions into one bounded assignment batch.
    queueMicrotask(() => {
      this.refreshQueued = false;
      const force = this.queuedForce;
      this.queuedForce = false;
      if (!this.stopped) void this.refresh(force);
    });
  }
  private fail(entry: ObservedIds, error: unknown) {
    entry.state.next({ ...entry.state.value, status: "error", error });
  }
  private markUnavailable(error: unknown) {
    if (this.catalog.value.status !== "error") {
      this.catalog.next({
        status: "error",
        tags: this.catalog.value.tags,
        error,
      });
    }
    this.catalogCounts.next({
      ...this.catalogCounts.value,
      status: "error",
      error,
    });
    for (const entry of [
      ...this.assignments.values(),
      ...this.usages.values(),
    ]) {
      if (entry.state.value.status !== "error") this.fail(entry, error);
    }
    for (const entry of this.databaseUsages.values()) {
      if (entry.state.value.status !== "error")
        entry.state.next({ ...entry.state.value, status: "error", error });
    }
  }
  private accept(entry: ObservedIds, ids: string[]) {
    entry.fetchedAt = Date.now();
    const previous = entry.state.value;
    if (
      previous.status === "ready" &&
      previous.ids?.length === ids.length &&
      previous.ids.every((id, index) => id === ids[index])
    )
      return;
    entry.state.next({ status: "ready", ids, error: null });
  }
  private async readCatalog(force = true) {
    if (
      !force &&
      this.catalogFetchedAt &&
      Date.now() - this.catalogFetchedAt < REFRESH_MS &&
      (!this.countObservers ||
        (this.countsFetchedAt &&
          Date.now() - this.countsFetchedAt < REFRESH_MS))
    )
      return;
    this.catalogFetchedAt = Date.now();
    const revision = this.writeRevision;
    const withCounts = this.countObservers > 0;
    try {
      const variables = {
        workspaceId: this.workspace.id,
        includeArchived: true,
      };
      const tags = withCounts
        ? await this.graphqlService
            .gql({ query: workspaceTagCatalogQuery, variables })
            .then((result) => {
              if (!result.workspace)
                throw new Error("Workspace label catalog is unavailable");
              return result.workspace.workspaceTagCatalog.map((entry) => ({
                ...fromServerTag(entry.tag),
                documentCount: entry.documentCount,
                databaseRowCount: entry.databaseRowCount,
              }));
            })
        : await this.graphqlService
            .gql({ query: workspaceTagsQuery, variables })
            .then((result) => {
              if (!result.workspace)
                throw new Error("Workspace labels are unavailable");
              return result.workspace.workspaceTags.map(fromServerTag);
            });
      if (revision !== this.writeRevision || !this.canRead) return;
      const state: TagCatalogState = {
        status: "ready",
        tags: tags.sort(compareTags),
        error: null,
      };
      this.catalog.next(state);
      if (withCounts) {
        this.countsFetchedAt = Date.now();
        this.catalogCounts.next(state);
      }
      this.catalogFetchedAt = Date.now();
    } catch (error) {
      if (revision === this.writeRevision)
        this.catalog.next({
          status: "error",
          tags: this.catalog.value.tags,
          error,
        });
      if (withCounts && revision === this.writeRevision)
        this.catalogCounts.next({
          ...this.catalogCounts.value,
          status: "error",
          error,
        });
    }
  }
  private async readAssignments(force = true) {
    const observed = [...this.assignments].filter(
      ([, entry]) =>
        entry.observers > 0 &&
        (force ||
          !entry.fetchedAt ||
          Date.now() - entry.fetchedAt >= REFRESH_MS),
    );
    for (
      let offset = 0;
      offset < observed.length && this.canRead;
      offset += BATCH_SIZE
    ) {
      const batch = observed.slice(offset, offset + BATCH_SIZE);
      const revision = this.writeRevision;
      for (const [, entry] of batch) entry.fetchedAt = Date.now();
      try {
        const result = await this.graphqlService.gql({
          query: documentWorkspaceTagAssignmentsQuery,
          variables: {
            workspaceId: this.workspace.id,
            externalIds: batch.map(([id]) => id),
          },
        });
        if (revision !== this.writeRevision || !this.canRead) continue;
        if (result.workspace?.id !== this.workspace.id)
          throw new Error("Workspace label assignments are unavailable");
        const rows = new Map(
          result.workspace.documentWorkspaceTagAssignments.map((row) => [
            row.externalId,
            row.tagIds,
          ]),
        );
        const known = new Set(this.catalog.value.tags.map((tag) => tag.id));
        if ([...rows.values()].some((ids) => ids?.some((id) => !known.has(id))))
          await this.readCatalog();
        if (revision !== this.writeRevision || !this.canRead) continue;
        const catalogIds = new Set(
          this.catalog.value.tags.map((tag) => tag.id),
        );
        for (const [id, entry] of batch) {
          const ids = rows.get(id);
          if (!ids || ids.some((id) => !catalogIds.has(id)))
            this.fail(
              entry,
              new Error("Document label assignment is unavailable"),
            );
          else this.accept(entry, ids);
        }
      } catch (error) {
        if (revision === this.writeRevision)
          for (const [, entry] of batch) this.fail(entry, error);
      }
    }
  }
  private async readUsages(force = true) {
    for (const [tagId, entry] of this.usages) {
      if (!entry.observers || !this.canRead) continue;
      if (
        !force &&
        entry.fetchedAt &&
        Date.now() - entry.fetchedAt < REFRESH_MS
      )
        continue;
      const revision = this.writeRevision;
      entry.fetchedAt = Date.now();
      const ids: string[] = [];
      let offset: number | null = 0;
      try {
        while (
          offset !== null &&
          this.canRead &&
          revision === this.writeRevision
        ) {
          const result: WorkspaceTagDocumentUsagesQuery =
            await this.graphqlService.gql({
              query: workspaceTagDocumentUsagesQuery,
              variables: {
                workspaceId: this.workspace.id,
                tagId,
                first: BATCH_SIZE,
                offset,
              },
            });
          if (result.workspace?.id !== this.workspace.id)
            throw new Error("Workspace label usages are unavailable");
          const page = result.workspace.workspaceTagDocumentUsages;
          ids.push(...page.items.map((item) => item.externalId));
          if (page.nextOffset != null && page.nextOffset <= offset)
            throw new Error("Invalid workspace label usage cursor");
          offset = page.nextOffset ?? null;
        }
        if (offset === null && revision === this.writeRevision && this.canRead)
          this.accept(entry, [...new Set(ids)]);
      } catch (error) {
        if (revision === this.writeRevision) this.fail(entry, error);
      }
    }
  }
  documentUsageState$(id: string) {
    return LiveData.from(
      this.observe(this.usages, id),
      this.entry(this.usages, id).state.value,
    );
  }
  private databaseEntry(id: string) {
    let entry = this.databaseUsages.get(id);
    if (!entry) {
      entry = {
        state: new BehaviorSubject<DatabaseUsageState>({
          status: this.local ? "ready" : "loading",
          rows: [],
          hasMore: false,
          error: null,
        }),
        observers: 0,
        limit: 100,
        fetchedAt: 0,
      };
      this.databaseUsages.set(id, entry);
    }
    return entry;
  }
  databaseUsageState$(id: string) {
    const entry = this.databaseEntry(id);
    return LiveData.from(
      new Observable<DatabaseUsageState>((subscriber) => {
        entry.observers++;
        const subscription = entry.state.subscribe(subscriber);
        this.observeChanged(entry.fetchedAt);
        return () => {
          subscription.unsubscribe();
          entry.observers--;
        };
      }),
      entry.state.value,
    );
  }
  async loadMoreDatabaseUsages(id: string) {
    this.databaseEntry(id).limit += 100;
    await this.refresh();
  }
  private async readDatabaseUsages(force = true) {
    for (const [tagId, entry] of this.databaseUsages) {
      if (!entry.observers || !this.canRead) continue;
      if (
        !force &&
        entry.fetchedAt &&
        Date.now() - entry.fetchedAt < REFRESH_MS
      )
        continue;
      const revision = this.writeRevision;
      entry.fetchedAt = Date.now();
      const rows: DatabaseUsage[] = [];
      let hasMore = true;
      try {
        for (
          let offset = 0;
          offset < entry.limit &&
          hasMore &&
          this.canRead &&
          revision === this.writeRevision;
          offset += 100
        ) {
          const result = await this.graphqlService.gql({
            query: workspaceTagDatabaseRowUsagesQuery,
            variables: {
              workspaceId: this.workspace.id,
              tagId,
              first: 100,
              offset,
            },
          });
          if (!result.workspace)
            throw new Error("Workspace label database usages are unavailable");
          const page = result.workspace.workspaceTagDatabaseRowUsages;
          rows.push(...page);
          hasMore = page.length === 100;
        }
        if (this.canRead && revision === this.writeRevision)
          entry.state.next({ status: "ready", rows, hasMore, error: null });
      } catch (error) {
        if (revision === this.writeRevision)
          entry.state.next({ ...entry.state.value, status: "error", error });
      }
    }
  }
  /** One workspace refresh owns catalog, bounded assignments and whole usage traversals. */
  async refresh(force = true): Promise<void> {
    if (this.local) {
      this.refreshLocal();
      return;
    }
    if (!this.canRead) return;
    this.pending = true;
    this.pendingForce ||= force;
    if (this.refreshRun) return this.refreshRun;
    const run = (async () => {
      while (this.pending && this.canRead) {
        this.pending = false;
        const force = this.pendingForce;
        this.pendingForce = false;
        await this.readCatalog(force);
        await this.readAssignments(force);
        await this.readUsages(force);
        await this.readDatabaseUsages(force);
      }
    })();
    this.refreshRun = run;
    try {
      await run;
    } finally {
      this.refreshRun = null;
      this.armTimer();
    }
  }
  async waitUntilReady() {
    if (this.local) this.refreshLocal();
    else if (!this.catalogFetchedAt || this.catalog.value.status !== "ready")
      await this.refresh();
    const state = this.catalog.value;
    if (state.status !== "ready")
      throw state.error ?? new Error("Workspace labels are unavailable");
  }
  async retry() {
    await this.refresh();
    await this.waitUntilReady();
  }
  async getPageTags(pageId: string) {
    const entry = this.entry(this.assignments, pageId);
    entry.observers++;
    try {
      if (this.local) this.refreshLocal();
      else await this.refresh();
      if (
        entry.state.value.status !== "ready" ||
        entry.state.value.ids === null
      )
        throw (
          entry.state.value.error ??
          new Error("Document labels are unavailable")
        );
      return [...entry.state.value.ids];
    } finally {
      entry.observers--;
    }
  }
  private async writable() {
    if (this.stopped || (!this.local && !this.online))
      throw new Error("Workspace labels are unavailable offline");
    await this.waitUntilReady();
  }
  private acknowledged() {
    this.inventoryRevision$.next(this.writeRevision + 1);
    this.scheduleRefresh(true);
  }
  private upsertServerTag(value: WorkspaceTagFieldsFragment) {
    const previous = this.catalog.value.tags.find((tag) => tag.id === value.id);
    const tag = {
      ...fromServerTag(value),
      documentCount: previous?.documentCount ?? 0,
      databaseRowCount: previous?.databaseRowCount ?? 0,
    };
    this.catalog.next({
      status: "ready",
      tags: [
        ...this.catalog.value.tags.filter((item) => item.id !== tag.id),
        tag,
      ].sort(compareTags),
      error: null,
    });
    this.acknowledged();
    return tag;
  }

  private refreshLocal() {
    if (!this.local || this.stopped) return;
    const tags = (
      this.workspace.docCollection.meta.properties.tags?.options ?? []
    ).map((tag) => ({
      ...tag,
      color: workspaceTagColorRoleOrGrey(tag.color),
      description: (tag as Tag).description ?? null,
    }));
    this.catalog.next({
      status: "ready",
      tags: tags.sort(compareTags),
      error: null,
    });
    this.catalogCounts.next(this.catalog.value);
    for (const [id, entry] of this.assignments) {
      const meta = this.workspace.docCollection.meta.getDocMeta(id);
      if (meta) this.accept(entry, meta.tags ?? []);
      else this.fail(entry, new Error("Document is unavailable"));
    }
    for (const [id, entry] of this.usages)
      this.accept(
        entry,
        [...this.workspace.docCollection.docs.values()]
          .filter((doc) => doc.meta?.tags?.includes(id))
          .map((doc) => doc.id),
      );
  }
  private updateLocalTag(id: string, patch: Partial<Tag>) {
    const properties = this.workspace.docCollection.meta.properties;
    const options = properties.tags?.options ?? [];
    if (!options.some((tag) => tag.id === id))
      throw new Error("Workspace label is unavailable");
    this.workspace.docCollection.meta.setProperties({
      ...properties,
      tags: {
        ...properties.tags,
        options: options.map((tag) =>
          tag.id === id ? { ...tag, ...patch, updateDate: Date.now() } : tag,
        ),
      },
    });
    this.refreshLocal();
    return this.catalog.value.tags.find((tag) => tag.id === id)!;
  }
  subscribe(cb: () => void) {
    const tags = this.tagOptions$.subscribe(cb);
    const docs =
      this.workspace.docCollection.slots.docListUpdated.subscribe(cb);
    return () => {
      tags.unsubscribe();
      docs.unsubscribe();
    };
  }
  watchTagIds() {
    return this.tagOptions$
      .map((tags) => tags.map((tag) => tag.id))
      .asObservable();
  }
  watchTagInfo(id: string) {
    return this.tagOptions$.map((tags) => tags.find((tag) => tag.id === id));
  }
  watchTagPageIds(id: string) {
    return this.observe(this.usages, id).pipe(
      switchMap((state) => (state.ids === null ? [] : [state.ids])),
    );
  }
  async createNewTag(value: string, color: TagColorRole, description?: string) {
    await this.writable();
    if (this.local) {
      const tag: Tag = {
        id: nanoid(),
        value,
        color,
        description: description ?? null,
        createDate: Date.now(),
        updateDate: Date.now(),
      };
      const properties = this.workspace.docCollection.meta.properties;
      this.workspace.docCollection.meta.setProperties({
        ...properties,
        tags: {
          ...properties.tags,
          options: [...(properties.tags?.options ?? []), tag],
        },
      });
      this.refreshLocal();
      return tag;
    }
    const result = await this.graphqlService.gql({
      query: createWorkspaceTagMutation,
      variables: {
        input: {
          workspaceId: this.workspace.id,
          name: value,
          colorRole: color,
          description,
        },
      },
    });
    return this.upsertServerTag(result.createWorkspaceTag);
  }
  async archiveTag(id: string) {
    await this.writable();
    if (this.local) return this.updateLocalTag(id, { archived: true });
    const result = await this.graphqlService.gql({
      query: archiveWorkspaceTagMutation,
      variables: { input: { workspaceId: this.workspace.id, tagId: id } },
    });
    return this.upsertServerTag(result.archiveWorkspaceTag);
  }
  async restoreTag(id: string) {
    await this.writable();
    if (this.local) return this.updateLocalTag(id, { archived: false });
    const result = await this.graphqlService.gql({
      query: restoreWorkspaceTagMutation,
      variables: { input: { workspaceId: this.workspace.id, tagId: id } },
    });
    return this.upsertServerTag(result.restoreWorkspaceTag);
  }
  async renameTag(id: string, value: string) {
    await this.writable();
    if (this.local) return this.updateLocalTag(id, { value });
    const result = await this.graphqlService.gql({
      query: renameWorkspaceTagMutation,
      variables: {
        input: { workspaceId: this.workspace.id, tagId: id, name: value },
      },
    });
    return this.upsertServerTag(result.renameWorkspaceTag);
  }
  async recolorTag(id: string, color: TagColorRole) {
    await this.writable();
    if (this.local) return this.updateLocalTag(id, { color });
    const result = await this.graphqlService.gql({
      query: recolorWorkspaceTagMutation,
      variables: {
        input: { workspaceId: this.workspace.id, tagId: id, colorRole: color },
      },
    });
    return this.upsertServerTag(result.recolorWorkspaceTag);
  }
  async updateTagDescription(id: string, description: string | null) {
    await this.writable();
    if (this.local) return this.updateLocalTag(id, { description });
    const result = await this.graphqlService.gql({
      query: updateWorkspaceTagDescriptionMutation,
      variables: {
        input: { workspaceId: this.workspace.id, tagId: id, description },
      },
    });
    return this.upsertServerTag(result.updateWorkspaceTagDescription);
  }
  async deleteTagPermanently(id: string) {
    await this.writable();
    if (this.local) {
      const properties = this.workspace.docCollection.meta.properties;
      this.workspace.docCollection.doc.transact(() => {
        this.workspace.docCollection.meta.setProperties({
          ...properties,
          tags: {
            ...properties.tags,
            options: (properties.tags?.options ?? []).filter(
              (tag) => tag.id !== id,
            ),
          },
        });
        for (const doc of this.workspace.docCollection.docs.values()) {
          if (doc.meta?.tags?.includes(id))
            this.workspace.docCollection.meta.setDocMeta(doc.id, {
              tags: doc.meta.tags.filter((tag) => tag !== id),
            });
        }
      });
      this.refreshLocal();
      return true;
    }
    const result = await this.graphqlService.gql({
      query: deleteWorkspaceTagPermanentlyMutation,
      variables: { input: { workspaceId: this.workspace.id, tagId: id } },
    });
    if (!result.deleteWorkspaceTagPermanently)
      throw new Error("Permanent workspace Tag deletion was not acknowledged");
    this.catalog.next({
      status: "ready",
      tags: this.catalog.value.tags.filter((tag) => tag.id !== id),
      error: null,
    });
    for (const entry of this.assignments.values())
      if (entry.state.value.ids)
        this.accept(
          entry,
          entry.state.value.ids.filter((tag) => tag !== id),
        );
    this.acknowledged();
    return true;
  }
  async setPageTags(pageId: string, tags: string[], copyFromDocId?: string) {
    await this.writable();
    if (this.local) {
      this.workspace.docCollection.meta.setDocMeta(pageId, { tags });
      this.refreshLocal();
      return tags;
    }
    const result = await this.graphqlService.gql({
      query: setDocumentWorkspaceTagsMutation,
      variables: {
        input: {
          workspaceId: this.workspace.id,
          docId: pageId,
          tagIds: tags,
          copyFromDocId,
        },
      },
    });
    this.accept(
      this.entry(this.assignments, pageId),
      result.setDocumentWorkspaceTags,
    );
    this.acknowledged();
    return result.setDocumentWorkspaceTags;
  }
  override dispose() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    super.dispose();
  }
}
