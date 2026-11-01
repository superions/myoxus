import { SortDownIcon, SortUpIcon } from "@myoxus/icons/react";
import {
  SurfaceListHeaderCell,
  SurfaceListHeaderSortIcon,
} from "@myoxus/ui-facade";
import { useCallback } from "react";

import type { ColWrapperProps, ListItem } from "../types";

type HeaderCellProps = ColWrapperProps & {
  sortKey: keyof ListItem;
  sortable?: boolean;
  order?: "asc" | "desc";
  sorting?: boolean;
  onSort?: (sortable?: boolean, sortKey?: keyof ListItem) => void;
  visibilityHidden?: boolean;
};

export const ListHeaderCell = ({
  sortKey,
  sortable,
  order,
  sorting,
  onSort,
  alignment,
  flex,
  className,
  style,
  hidden,
  hideInSmallContainer,
  children,
  visibilityHidden,
}: HeaderCellProps) => {
  const handleClick = useCallback(() => {
    if (sortable) {
      onSort?.(sortable, sortKey);
    }
  }, [sortable, sortKey, onSort]);

  return (
    <SurfaceListHeaderCell
      flex={flex}
      alignment={alignment}
      onClick={handleClick}
      className={className}
      data-testid="page-list-flex-wrapper"
      sortable={sortable}
      sorting={sorting}
      hidden={hidden}
      style={style}
      hideInCompact={hideInSmallContainer}
      visibilityHidden={visibilityHidden}
    >
      {children}
      {sorting ? (
        <SurfaceListHeaderSortIcon>
          {order === "asc" ? <SortUpIcon /> : <SortDownIcon />}
        </SurfaceListHeaderSortIcon>
      ) : null}
    </SurfaceListHeaderCell>
  );
};
