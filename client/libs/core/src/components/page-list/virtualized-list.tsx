import { Scrollable, useResponsiveElementSize } from "@myoxus/ui-facade";
import { selectAtom } from "jotai/utils";
import {
  forwardRef,
  type HTMLAttributes,
  type PropsWithChildren,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { Virtuoso } from "react-virtuoso";

import { ListInnerWrapper, toListPropsAtomSnapshot } from "./list";
import { ItemGroupHeader } from "./page-group";
import {
  groupCollapseStateAtom,
  groupsAtom,
  listPropsAtom,
  ListProvider,
  useAtomValue,
} from "./scoped-atoms";
import type {
  ItemGroupProps,
  ItemListHandle,
  ListItem,
  ListProps,
  VirtualizedListProps,
} from "./types";

// we have three item types for rendering rows in Virtuoso
type VirtuosoItemType = "sticky-header" | "group-header" | "item";

interface BaseVirtuosoItem {
  type: VirtuosoItemType;
}

interface VirtuosoItemStickyHeader<T> extends BaseVirtuosoItem {
  type: "sticky-header";
  data?: T;
}

interface VirtuosoItemItem<T> extends BaseVirtuosoItem {
  type: "item";
  data: T;
}

interface VirtuosoItemGroupHeader<T> extends BaseVirtuosoItem {
  type: "group-header";
  data: ItemGroupProps<T>;
}

type VirtuosoItem<T> =
  | VirtuosoItemStickyHeader<T>
  | VirtuosoItemItem<T>
  | VirtuosoItemGroupHeader<T>;

/**
 * Given a list of pages, render a list of pages
 * Similar to normal PageList, but uses react-virtuoso to render the list (virtual rendering)
 */
export const VirtualizedList = forwardRef<
  ItemListHandle,
  VirtualizedListProps<ListItem>
>(function VirtualizedList(props, ref) {
  const initialListPropsRef = useRef<ListProps<ListItem> | null>(null);
  if (!initialListPropsRef.current) {
    initialListPropsRef.current = toListPropsAtomSnapshot(props);
  }
  return (
    // push pageListProps to the atom so that downstream components can consume it
    // this makes sure pageListPropsAtom is always populated
    <ListProvider initialListProps={initialListPropsRef.current}>
      <ListInnerWrapper {...props} handleRef={ref}>
        <ListInner {...props} />
      </ListInnerWrapper>
    </ListProvider>
  );
});

const headingAtom = selectAtom(listPropsAtom, (props) => props?.heading);

const PageListHeading = () => {
  const heading = useAtomValue(headingAtom);
  return <div>{heading}</div>;
};

const useVirtuosoItems = <T extends ListItem>() => {
  const groups = useAtomValue(groupsAtom);
  const groupCollapsedState = useAtomValue(groupCollapseStateAtom);

  return useMemo(() => {
    const items: VirtuosoItem<T>[] = [];

    // 1.
    // always put sticky header at the top
    // the visibility of sticky header is inside of PageListTableHeader
    items.push({
      type: "sticky-header",
    });

    // 2.
    // iterate groups and add page items
    for (const group of groups) {
      // skip empty group header since it will cause issue in virtuoso ("Zero-sized element")
      if (group.label) {
        items.push({
          type: "group-header",
          data: group as ItemGroupProps<T>,
        });
      }
      // do not render items if the group is collapsed
      if (!groupCollapsedState[group.id]) {
        for (const item of group.items) {
          items.push({
            type: "item",
            data: item as T,
          });
        }
      }
    }
    return items;
  }, [groupCollapsedState, groups]);
};

const Scroller = forwardRef<
  HTMLDivElement,
  PropsWithChildren<HTMLAttributes<HTMLDivElement>>
>(({ children, ...props }, ref) => {
  const { ref: sizeRef, width } = useResponsiveElementSize<HTMLDivElement>();
  const setViewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      sizeRef(node);
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref, sizeRef],
  );
  const density = width > 0 && width <= 800 ? "compact" : "regular";

  return (
    <Scrollable.VirtualizedViewport
      {...props}
      data-list-density={density}
      ref={setViewportRef}
    >
      {children}
    </Scrollable.VirtualizedViewport>
  );
});

Scroller.displayName = "Scroller";

const ListInner = ({
  atTopStateChange,
  atTopThreshold,
  ...props
}: VirtualizedListProps<ListItem>) => {
  const virtuosoItems = useVirtuosoItems<ListItem>();
  const [atTop, setAtTop] = useState(false);
  const handleAtTopStateChange = useCallback(
    (atTop: boolean) => {
      setAtTop(atTop);
      atTopStateChange?.(atTop);
    },
    [atTopStateChange],
  );
  const components = useMemo(() => {
    return {
      Header: props.heading ? PageListHeading : undefined,
      Scroller: Scroller,
    };
  }, [props.heading]);
  const itemContentRenderer = useCallback(
    (_index: number, data: VirtuosoItem<ListItem>) => {
      switch (data.type) {
        case "sticky-header":
          return props.headerRenderer?.(data.data);
        case "group-header":
          return <ItemGroupHeader {...data.data} />;
        case "item":
          return props.itemRenderer?.(data.data);
      }
    },
    [props],
  );
  return (
    <Virtuoso<VirtuosoItem<ListItem>>
      data-has-scroll-top={!atTop}
      atTopThreshold={atTopThreshold ?? 0}
      atTopStateChange={handleAtTopStateChange}
      components={components}
      data={virtuosoItems}
      data-testid="virtualized-page-list"
      data-total-count={props.items.length} // for testing, since we do not know the total count in test
      data-virtualized-item-count={virtuosoItems.length}
      topItemCount={1} // sticky header
      totalCount={virtuosoItems.length}
      itemContent={itemContentRenderer}
      className={props.className}
      data-myoxus-ui-role="surface-list-virtualized-root"
      // TODO(@Peng): set a reasonable overscan value to avoid blank space?
      // overscan={100}
    />
  );
};
