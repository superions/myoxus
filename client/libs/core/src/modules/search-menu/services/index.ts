import type { TagMeta } from "@myoxus/core/components/page-list";
import { UserFriendlyError } from "@myoxus/error";
import { I18n } from "@myoxus/i18n";
import { Service } from "@myoxus/infra";
import { computed, signal } from "@preact/signals-core";
import { createSignalFromObservable } from "@virgultum/editor/shared/utils";
import type { DocMeta } from "@virgultum/editor/store";
import type {
  LinkedMenuGroup,
  LinkedMenuItem,
} from "@virgultum/editor/widgets/linked-doc";
import Fuse from "fuse.js";
import { decodeMenuHighlight } from "./menu-highlight";
import { catchError, map, of } from "rxjs";

import { normalizeSearchText } from "../../../utils/normalize-search-text";
import type { CollectionMeta, CollectionService } from "../../collection";
import type { DocDisplayMetaService } from "../../doc-display-meta";
import type { DocsSearchService } from "../../docs-search";
import { type RecentWorkspaceItemsService } from "../../quicksearch";
import type { TagService } from "../../tag";
import type { WorkspaceService } from "../../workspace";

const MAX_DOCS = 3;

type DocMetaWithHighlights = DocMeta & {
  highlights?: string;
};

export type SearchDocMenuAction = (meta: DocMeta) => Promise<void> | void;

export type SearchTagMenuAction = (tagId: TagMeta) => Promise<void> | void;

export type SearchCollectionMenuAction = (
  collection: CollectionMeta,
) => Promise<void> | void;

export class SearchMenuService extends Service {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly docDisplayMetaService: DocDisplayMetaService,
    private readonly recentItemsService: RecentWorkspaceItemsService,
    private readonly docsSearch: DocsSearchService,
    private readonly tagService: TagService,
    private readonly collectionService: CollectionService,
  ) {
    super();
  }

  getDocMenuGroup(
    query: string,
    action: SearchDocMenuAction,
    abortSignal: AbortSignal,
  ): LinkedMenuGroup {
    const showRecent = query.trim().length === 0;
    if (showRecent) {
      return this.getRecentDocMenuGroup(action);
    } else {
      return this.getSearchDocMenuGroup(query, action, abortSignal);
    }
  }

  private getRecentDocMenuGroup(action: SearchDocMenuAction): LinkedMenuGroup {
    const currentWorkspace = this.workspaceService.workspace;
    const rawMetas = currentWorkspace.docCollection.meta.docMetas;
    const recentDocs = this.recentItemsService.getRecentDocs();
    return {
      name: I18n.t("com.myoxus.editor.at-menu.recent-docs"),
      items: recentDocs
        .map((doc) => {
          const meta = rawMetas.find((meta) => meta.id === doc.id);
          if (!meta) {
            return null;
          }
          return this.toDocMenuItem(meta, action);
        })
        .filter((m) => !!m),
    };
  }

  private getSearchDocMenuGroup(
    query: string,
    action: SearchDocMenuAction,
    abortSignal: AbortSignal,
  ): LinkedMenuGroup {
    const currentWorkspace = this.workspaceService.workspace;
    const rawMetas = currentWorkspace.docCollection.meta.docMetas;
    const loading = signal(true);
    const { signal: docsSignal, cleanup: cleanupDocs } =
      createSignalFromObservable(
        this.searchDocs$(query).pipe(
          map((result) => {
            const docs = result
              .map((doc) => {
                const meta = rawMetas.find((meta) => meta.id === doc.id);
                if (!meta) {
                  return null;
                }
                const highlights =
                  "highlights" in doc ? doc.highlights : undefined;
                return this.toDocMenuItem(
                  {
                    ...meta,
                    highlights,
                  },
                  action,
                );
              })
              .filter((m) => !!m);
            loading.value = false;
            return docs;
          }),
          catchError((err) => {
            loading.value = false;
            const userFriendlyError = UserFriendlyError.fromAny(err);
            return of([
              {
                name: I18n.t(
                  `error.${userFriendlyError.name}`,
                  userFriendlyError.data,
                ),
                key: "error",
                icon: "WarningIcon" as const,
                disabled: true,
                action: () => {},
              },
            ]);
          }),
        ),
        [],
      );

    const overflowText = computed(() => {
      const overflowCount = docsSignal.value.length - MAX_DOCS;
      return I18n.t("com.myoxus.editor.at-menu.more-docs-hint", {
        count: overflowCount > 100 ? "100+" : overflowCount,
      });
    });

    abortSignal.addEventListener("abort", () => {
      cleanupDocs();
    });

    return {
      name: I18n.t("com.myoxus.editor.at-menu.link-to-doc", {
        query,
      }),
      loading: loading,
      items: docsSignal,
      maxDisplay: MAX_DOCS,
      overflowText,
    };
  }

  // only search docs by title, excluding blocks
  private searchDocs$(query: string) {
    return this.docsSearch.indexer
      .search$(
        "doc",
        {
          type: "match",
          field: "title",
          match: query,
        },
        {
          fields: ["docId", "title"],
          highlights: [
            {
              field: "title",
              before: "\uE000",
              end: "\uE001",
            },
          ],
        },
      )
      .pipe(
        map(({ nodes }) =>
          nodes.map((node) => {
            const id =
              typeof node.fields.docId === "string"
                ? node.fields.docId
                : node.fields.docId[0];
            const title = normalizeSearchText(
              typeof node.fields.title === "string"
                ? node.fields.title
                : node.fields.title[0],
            );
            const highlights = normalizeSearchText(node.highlights?.title?.[0]);
            return {
              id,
              title,
              highlights: highlights || undefined,
            };
          }),
        ),
      );
  }

  private toDocMenuItem(
    meta: DocMetaWithHighlights,
    action: SearchDocMenuAction,
  ): LinkedMenuItem | null {
    const title = this.docDisplayMetaService.title$(meta.id, {
      reference: true,
    }).value;

    if (meta.trash) {
      return null;
    }

    return {
      ...(meta.highlights
        ? decodeMenuHighlight(meta.highlights)
        : { name: title }),
      key: meta.id,
      icon: "LinkIcon",
      action: async () => {
        await action(meta);
      },
    };
  }

  getTagMenuGroup(
    query: string,
    action: SearchTagMenuAction,
    _abortSignal: AbortSignal,
  ): LinkedMenuGroup {
    const tags: TagMeta[] = this.tagService.tagList.tagMetas$.value;
    if (query.trim().length === 0) {
      return {
        name: I18n.t("com.myoxus.editor.at-menu.tags", {
          query,
        }),
        items: tags.map((tag) => this.toTagMenuItem(tag, action)),
      };
    }

    const fuse = new Fuse(tags, {
      keys: ["name"],
      includeMatches: true,
      includeScore: true,
      ignoreLocation: true,
      threshold: 0.0,
    });
    const result = fuse.search(query);

    return {
      name: I18n.t("com.myoxus.editor.at-menu.link-to-doc", {
        query,
      }),
      items: result.map(({ item, matches }) => ({
        ...this.toTagMenuItem(item, action),
        highlights: matches?.flatMap((match) =>
          match.indices.map(([start, end]) => [start, end + 1] as const),
        ),
      })),
    };
  }

  private toTagMenuItem(
    tag: TagMeta,
    action: SearchTagMenuAction,
  ): LinkedMenuItem {
    return {
      key: tag.id,
      name: tag.name,
      icon: "TagsIcon",
      color: tag.color,
      action: async () => {
        await action(tag);
      },
    };
  }

  getCollectionMenuGroup(
    query: string,
    action: SearchCollectionMenuAction,
    _abortSignal: AbortSignal,
  ): LinkedMenuGroup {
    const collections = this.collectionService.collectionMetas$.value;
    if (query.trim().length === 0) {
      return {
        name: I18n.t("com.myoxus.editor.at-menu.collections", {
          query,
        }),
        items: collections.map((collection) =>
          this.toCollectionMenuItem(
            {
              ...collection,
              title: collection.name,
            },
            action,
          ),
        ),
      };
    }

    const fuse = new Fuse(collections, {
      keys: ["name"],
      includeMatches: true,
      includeScore: true,
      ignoreLocation: true,
      threshold: 0.0,
    });
    const result = fuse.search(query);

    return {
      name: I18n.t("com.myoxus.editor.at-menu.link-to-doc", {
        query,
      }),
      items: result.map(({ item, matches }) => ({
        ...this.toCollectionMenuItem({ ...item, title: item.name }, action),
        highlights: matches?.flatMap((match) =>
          match.indices.map(([start, end]) => [start, end + 1] as const),
        ),
      })),
    };
  }

  private toCollectionMenuItem(
    collection: CollectionMeta,
    action: SearchCollectionMenuAction,
  ): LinkedMenuItem {
    return {
      key: collection.id,
      name: collection.title,
      icon: "CollectionsIcon",
      action: async () => {
        await action(collection);
      },
    };
  }
}
