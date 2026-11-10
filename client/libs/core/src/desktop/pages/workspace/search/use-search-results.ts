// SPDX-License-Identifier: AGPL-3.0-or-later

import { DocsSearchService } from "@myoxus/core/modules/docs-search";
import {
  findDatabases,
  findDatabaseRows,
} from "@myoxus/core/modules/quicksearch/impls/database-discovery";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect, useMemo, useRef, useState } from "react";
import { firstValueFrom, fromEvent, takeUntil } from "rxjs";

const PAGE_SIZE = 50;
type ReadSource<T> =
  ((signal: AbortSignal, offset: number) => Promise<T[]>) | null;
const documentIdentity = (hit: { docId: string }) => hit.docId;
const databaseIdentity = (hit: { id: string }) => hit.id;
const rowIdentity = (hit: { databaseId: string; rowId: string }) =>
  JSON.stringify([hit.databaseId, hit.rowId]);

/** Each source owns its failure and lifetime; no cross-source ranking or cache. */
export function useSource<T>(
  read: ReadSource<T>,
  identity: (hit: T) => string,
) {
  const action = useRef<{ read: ReadSource<T>; load: () => void } | null>(null);
  const [state, setState] = useState({
    read,
    items: [] as T[],
    loading: !!read,
    error: false,
    hasMore: !!read,
  });
  useEffect(() => {
    let live = true;
    let controller: AbortController | null = null;
    let items: T[] = [];
    let offset = 0;
    let hasMore = !!read;
    const load = () => {
      if (!live || !read || controller || !hasMore) return;
      const current = new AbortController();
      controller = current; // Synchronous admission also fences duplicate clicks before render.
      setState({ read, items, loading: true, error: false, hasMore });
      void Promise.resolve()
        .then(() =>
          current.signal.aborted ? [] : read(current.signal, offset),
        )
        .then((page) => {
          if (!live) return;
          // Raw page size advances the reader, regardless of duplicates or local sorting.
          offset += page.length;
          const seen = new Set(items.map(identity));
          items = [
            ...items,
            ...page.filter((hit) => {
              const key = identity(hit);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }),
          ];
          hasMore = page.length === PAGE_SIZE;
          setState({ read, items, loading: false, error: false, hasMore });
        })
        .catch(() => {
          if (live)
            setState({ read, items, loading: false, error: true, hasMore });
        })
        .finally(() => {
          if (controller === current) controller = null;
        });
    };
    action.current = { read, load };
    setState({ read, items, loading: !!read, error: false, hasMore });
    load();
    return () => {
      live = false;
      controller?.abort();
      if (action.current?.load === load) action.current = null;
    };
  }, [read, identity]);
  // Never show the previous owner's hits during the render before effect cleanup.
  return {
    ...(state.read === read
      ? state
      : { items: [] as T[], loading: !!read, error: false, hasMore: !!read }),
    loadMore: () => {
      if (action.current?.read === read) action.current.load();
    },
    retry: () => {
      if (action.current?.read === read) action.current.load();
    },
  };
}

export function useSearchResults(query: string) {
  const workspace = useService(WorkspaceService).workspace;
  const docsSearch = useService(DocsSearchService);
  const server = useLiveData(useService(WorkspaceServerService).server$);
  const account = useLiveData(server?.account$);
  const reads = useMemo(() => {
    const readyServer = () => {
      if (!server || workspace.flavour === "local")
        throw new Error("Workspace search is unavailable");
      return server;
    };
    return {
      documents: query
        ? async (signal: AbortSignal, offset: number) => {
            readyServer();
            return firstValueFrom(
              docsSearch
                .search$(query, "remote", { offset, limit: PAGE_SIZE })
                .pipe(takeUntil(fromEvent(signal, "abort"))),
            );
          }
        : null,
      databases: query
        ? (signal: AbortSignal, offset: number) =>
            findDatabases(readyServer(), workspace.id, {
              first: PAGE_SIZE,
              offset,
              search: query,
              signal,
            })
        : null,
      rows: query
        ? async (signal: AbortSignal, offset: number) => {
            const server = readyServer();
            const hits = await findDatabaseRows(
              server,
              workspace.id,
              query,
              PAGE_SIZE,
              signal,
              offset,
            );
            const databaseIds = [...new Set(hits.map((hit) => hit.databaseId))];
            let names = new Map<string, string>();
            if (databaseIds.length && !signal.aborted) {
              try {
                const parents = await findDatabases(server, workspace.id, {
                  databaseIds,
                  first: databaseIds.length,
                  signal,
                });
                names = new Map(
                  parents.map((parent) => [parent.id, parent.title]),
                );
              } catch {
                // Optional batched context must never turn authorized Row hits into a failed source.
              }
            }
            return hits.map((hit) => ({
              ...hit,
              parentTitle: names.get(hit.databaseId),
            }));
          }
        : null,
    };
  }, [query, workspace.id, workspace.flavour, server, account?.id, docsSearch]);
  return {
    documents: useSource(reads.documents, documentIdentity),
    databases: useSource(reads.databases, databaseIdentity),
    rows: useSource(reads.rows, rowIdentity),
  };
}
