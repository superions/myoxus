import { Entity, LiveData } from "@myoxus/infra";

import type { DocsService } from "../../doc";
import { WorkspaceTagAssignmentController } from "../assignment-controller";
import { Tag } from "../entities/tag";
import type { TagStore } from "../stores/tag";

export class TagList extends Entity {
  constructor(
    private readonly store: TagStore,
    private readonly docs: DocsService,
  ) {
    super();
  }

  private readonly pool = new Map<string, Tag>();
  private readonly pageTags = new Map<string, LiveData<Tag[]>>();

  readonly catalogState$ = this.store.catalogState$.map((state) => state);
  readonly inventoryRevision$ = this.store.inventoryRevision$;
  readonly catalogWithCountsState$ = this.store.catalogWithCountsState$;

  readonly tags$ = LiveData.from(this.store.watchTagIds(), []).map((ids) => {
    return ids.map((id) => {
      const exists = this.pool.get(id);
      if (exists) {
        return exists;
      }
      const record = this.framework.createEntity(Tag, { id });
      this.pool.set(id, record);
      return record;
    });
  });
  private readonly tagsById$ = this.tags$.map(
    (tags) => new Map(tags.map((tag) => [tag.id, tag])),
  );

  async createTag(
    value: string,
    color: Parameters<TagStore["createNewTag"]>[1],
    description?: string,
  ) {
    const created = await this.store.createNewTag(value, color, description);
    return this.framework.createEntity(Tag, { id: created.id });
  }

  archiveTag(tagId: string) {
    return this.store.archiveTag(tagId);
  }

  restoreTag(tagId: string) {
    return this.store.restoreTag(tagId);
  }

  deleteTagPermanently(tagId: string) {
    return this.store.deleteTagPermanently(tagId);
  }

  retryCatalog() {
    return this.store.retry();
  }

  setPageTags(pageId: string, tagIds: string[]) {
    return this.store.setPageTags(pageId, tagIds);
  }

  async clearPageTags(pageId: string) {
    const docRecord = this.docs.list.doc$(pageId).value;
    if (!docRecord) return [];

    const controller = new WorkspaceTagAssignmentController(
      await this.store.getPageTags(pageId),
      (nextIds) => this.store.setPageTags(pageId, nextIds),
    );
    controller.replace([]);
    return await controller.flush();
  }

  /**
   * Moves a document between tag groups with one full-value server commit.
   * Other assigned tags keep their order; an already assigned destination is
   * deduplicated instead of leaving the source tag behind.
   */
  async movePageTag(
    pageId: string,
    sourceTagId: string | null,
    targetTagId: string,
  ) {
    const docRecord = this.docs.list.doc$(pageId).value;
    if (!docRecord) return [];

    const current = await this.store.getPageTags(pageId);
    let replacedSource = false;
    const nextIds = current.map((tagId) => {
      if (sourceTagId && tagId === sourceTagId) {
        replacedSource = true;
        return targetTagId;
      }
      return tagId;
    });
    if (!replacedSource && !nextIds.includes(targetTagId)) {
      nextIds.push(targetTagId);
    }

    const controller = new WorkspaceTagAssignmentController(
      current,
      (confirmedIds) => this.store.setPageTags(pageId, confirmedIds),
    );
    controller.replace(nextIds);
    return await controller.flush();
  }

  tagsByPageId$(pageId: string) {
    const existing = this.pageTags.get(pageId);
    if (existing) return existing;
    const doc$ = this.docs.list.doc$(pageId);
    // Keep one dependency graph per row across React renders. Recreating it
    // repeatedly tears down subscriptions and rebuilds the catalog lookup.
    const tags$ = LiveData.computed((get) => {
      const docRecord = get(doc$);
      if (!docRecord) return [];
      const tagIds = get(docRecord.tagIds$);
      const tagsById = get(this.tagsById$);

      // Assignment order is persisted by the server. Mapping the assignment
      // IDs through the catalog preserves that order across local and remote
      // clients instead of accidentally replacing it with catalog sorting.
      return (tagIds ?? [])
        .map((tagId) => tagsById.get(tagId))
        .filter((tag): tag is Tag => tag !== undefined);
    });
    this.pageTags.set(pageId, tags$);
    return tags$;
  }

  documentUsageState$(id: string) {
    return this.store.documentUsageState$(id);
  }
  databaseUsageState$(id: string) {
    return this.store.databaseUsageState$(id);
  }
  loadMoreDatabaseUsages(id: string) {
    return this.store.loadMoreDatabaseUsages(id);
  }

  assignmentState$(pageId: string) {
    return this.store.pageTagState$(pageId);
  }

  tagIdsByPageId$(pageId: string) {
    return this.store.watchPageTags(pageId);
  }

  tagByTagId$(tagId?: string) {
    return this.tags$.map((tags) => tags.find((tag) => tag.id === tagId));
  }

  tagMetas$ = LiveData.computed((get) => {
    return get(this.tags$).map((tag) => {
      return {
        id: tag.id,
        name: get(tag.value$),
        color: get(tag.color$),
        description: get(tag.description$),
        archived: get(tag.archived$),
        createDate: get(tag.createDate$),
        updatedDate: get(tag.updateDate$),
      };
    });
  });

  private filterFn(value: string, query?: string) {
    const trimmedQuery = query?.trim().toLowerCase() ?? "";
    const trimmedValue = value.trim().toLowerCase();
    return trimmedValue.includes(trimmedQuery);
  }

  filterTagsByName$(name: string) {
    return LiveData.computed((get) => {
      return get(this.tags$).filter((tag) =>
        this.filterFn(get(tag.value$), name),
      );
    });
  }
}
