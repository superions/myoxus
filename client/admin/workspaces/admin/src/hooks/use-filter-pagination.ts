/**
 * Hook that encapsulates the pagination-reset-on-filter-change pattern shared
 * by Organization member lists and `useWorkspaceList`.
 *
 * Tracks a `{ pageIndex, pageSize }` state and resets `pageIndex` to 0
 * whenever the serialized `filterKey` changes.
 *
 * @param initialPageSize - Page size used on first render (default 10).
 * @returns Pagination state, setter, and the current filter key.
 */
import { useEffect, useState } from "react";

export interface PaginationState {
  pageIndex: number;
  pageSize: number;
}

export interface UseFilterPaginationReturn {
  pagination: PaginationState;
  setPagination: React.Dispatch<React.SetStateAction<PaginationState>>;
}

/**
 * @param filterKey - Serialized representation of active filters. When this
 *   string changes the page index is reset to 0.
 * @param initialPageSize - Initial page size (default `10`).
 */
export function useFilterPagination(
  filterKey: string,
  initialPageSize = 10,
): UseFilterPaginationReturn {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: initialPageSize,
  });

  useEffect(() => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }, [filterKey]);

  return { pagination, setPagination };
}
