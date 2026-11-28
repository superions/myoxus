// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { CollectionMeta } from "@myoxus/core/modules/collection";
import type { TagColorRole } from "@myoxus/ui-facade";
import type { DocMeta, Workspace } from "@virgultum/editor/store";
import type {
  CSSProperties,
  HTMLAttributes,
  JSX,
  PropsWithChildren,
  ReactNode,
} from "react";
import type { To } from "react-router";

export type TagMeta = {
  id: string;
  name: string;
  color: TagColorRole;
  archived?: boolean;
  pageCount?: number;
  createDate?: Date | number;
  updatedDate?: Date | number;
};

export type ListItem =
  | DocMeta
  | (CollectionMeta & {
      createDate?: Date | number;
      updatedDate?: Date | number;
    })
  | TagMeta;

export type PageListItemProps = {
  pageId: string;
  pageIds?: string[];
  icon: JSX.Element;
  title: ReactNode;
  preview?: ReactNode;
  createDate: Date;
  updatedDate?: Date;
  isPublicPage?: boolean;
  to?: To;
  draggable?: boolean;
  selectable?: boolean;
  selected?: boolean;
  operations?: ReactNode;
  onClick?: () => void;
  onSelectedChange?: () => void;
};

export type CollectionListItemProps = {
  collectionId: string;
  icon: JSX.Element;
  title: ReactNode;
  createDate?: Date;
  updatedDate?: Date;
  to?: To;
  draggable?: boolean;
  selectable?: boolean;
  selected?: boolean;
  operations?: ReactNode;
  onClick?: () => void;
  onSelectedChange?: () => void;
};

export type TagListItemProps = {
  tagId: string;
  color: TagColorRole;
  archived?: boolean;
  title: ReactNode;
  createDate?: Date | number;
  updatedDate?: Date | number;
  to?: To;
  draggable?: boolean;
  selectable?: boolean;
  selected?: boolean;
  operations?: ReactNode;
  onClick?: () => void;
  onSelectedChange?: () => void;
};

export interface ItemListHeaderProps {}

export type DateKey = "createDate" | "updatedDate";
export type ItemGroupByType = DateKey;

export interface SortBy {
  key: DateKey;
  order: "asc" | "desc";
}

export type PageGroupByType =
  "createDate" | "updatedDate" | "tag" | "favourites" | "none";

export interface ItemGroupDefinition<T> {
  id: string;
  label: ((count: number) => ReactNode) | ReactNode;
  match: (item: T) => boolean;
}

export interface ItemGroupProps<T> {
  id: string;
  label?: ReactNode;
  items: T[];
  allItems: T[];
}

export interface ListProps<T> {
  items: T[];
  docCollection: Workspace;
  className?: string;
  hideHeader?: boolean;
  groupBy?: ItemGroupDefinition<T>[] | false;
  rowAsLink?: boolean;
  selectable?: "toggle" | boolean;
  selectedIds?: string[];
  onSelectedIdsChange?: (selected: string[]) => void;
  onSelectionActiveChange?: (active: boolean) => void;
  draggable?: boolean;
  operationsRenderer?: (item: T) => ReactNode;
}

export interface VirtualizedListProps<T> extends ListProps<T> {
  heading?: ReactNode;
  headerRenderer?: (item?: T) => ReactNode;
  itemRenderer?: (item: T) => ReactNode;
  atTopThreshold?: number;
  atTopStateChange?: (atTop: boolean) => void;
}

export interface ItemListHandle {
  toggleSelectable: () => void;
}

export type MetaRecord<T> = { [K in keyof T]: T[K] };

export type DraggableTitleCellData = {
  preview: ReactNode;
};

export type ColWrapperProps = PropsWithChildren<{
  flex?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  alignment?: "start" | "center" | "end";
  styles?: CSSProperties;
  hideInSmallContainer?: boolean;
}> &
  HTMLAttributes<Element>;

export type HeaderColDef = {
  key: string;
  content: ReactNode;
  flex: ColWrapperProps["flex"];
  alignment?: ColWrapperProps["alignment"];
  sortable?: boolean;
  hideInSmallContainer?: boolean;
  hidden?: boolean;
};

export type PageDisplayProperties = {
  bodyNotes: boolean;
  tags: boolean;
  createDate: boolean;
  updatedDate: boolean;
};

export type DisplayProperties = {
  groupBy: PageGroupByType;
  displayProperties: PageDisplayProperties;
};
