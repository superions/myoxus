// SPDX-License-Identifier: MIT

import "./masonry.css";

import {
  type CSSProperties,
  forwardRef,
  Fragment,
  type HTMLAttributes,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { joinClassName } from "./css-utils";
import { observeResize } from "./helpers/observe-resize";
import type {
  MasonryGroup,
  MasonryItem as MasonryItemType,
  MasonryItemXYWH,
  MasonryPX,
} from "./masonry-types";
import {
  calcActive,
  calcColumns,
  calcLayout,
  calcPX,
  calcSticky,
  measuredCardWidthMinimum,
} from "./masonry-utils";

export type { MasonryGroup, MasonryItem } from "./masonry-types";

function debounce<T extends (...args: never[]) => void>(fn: T, wait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function throttle<T extends (...args: never[]) => void>(fn: T, wait: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      last = now;
      fn(...args);
      return;
    }
    if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = undefined;
        fn(...args);
      }, remaining);
    }
  };
}

export interface MasonryProps extends HTMLAttributes<HTMLDivElement> {
  items: MasonryItemType[] | MasonryGroup[];
  gapX?: number;
  gapY?: number;
  paddingX?: MasonryPX;
  paddingY?: number;
  groupsGap?: number;
  groupHeaderGapWithItems?: number;
  stickyGroupHeader?: boolean;
  collapsedGroups?: string[];
  onGroupCollapse?: (groupId: string, collapsed: boolean) => void;
  itemWidth?: number | "stretch";
  itemWidthMin?: number;
  /** Opt-in measured inventory width tier; columns use its CSS-pixel minimum. */
  measuredCardSize?: keyof typeof measuredCardWidthMinimum;
  /** Placement of items within each group; the default preserves legacy packing. */
  layoutMode?: "masonry" | "grid";
  /** Reuse the nearest scrolling ancestor instead of adding a nested viewport. */
  scrollOwner?: "self" | "parent";
  virtualScroll?: boolean;
  locateMode?: "transform" | "leftTop" | "transform3d";
  columns?: number;
  resizeDebounce?: number;
  preloadHeight?: number;
  onStickyGroupChange?: (groupId?: string) => void;
}

export type MasonryRef = {
  scrollToGroup: (groupId: string) => void;
};

export const Masonry = forwardRef<MasonryRef, MasonryProps>(function Masonry(
  {
    items,
    gapX = 12,
    gapY = 12,
    itemWidth = "stretch",
    itemWidthMin = 100,
    measuredCardSize,
    layoutMode = "masonry",
    scrollOwner = "self",
    paddingX = 0,
    paddingY = 0,
    className,
    style,
    virtualScroll = false,
    locateMode = "leftTop",
    groupsGap = 0,
    groupHeaderGapWithItems = 0,
    stickyGroupHeader = true,
    collapsedGroups,
    columns,
    preloadHeight = 50,
    resizeDebounce = 20,
    onGroupCollapse,
    onStickyGroupChange,
    ...props
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [layoutMap, setLayoutMap] = useState<
    Map<MasonryItemType["id"], MasonryItemXYWH>
  >(new Map());
  const [activeMap, setActiveMap] = useState<
    Map<MasonryItemType["id"], boolean>
  >(new Map());
  const [stickyGroupId, setStickyGroupId] = useState<string | undefined>(
    undefined,
  );
  const [totalWidth, setTotalWidth] = useState(0);
  const [measuredHeights, setMeasuredHeights] = useState<
    Map<string, { width: number; height: number }>
  >(new Map());
  const layoutRef = useRef(layoutMap);
  const pendingAnchor = useRef<{ id: string; offset: number } | null>(null);
  const stickyGroupCollapsed = !!(
    collapsedGroups &&
    stickyGroupId &&
    collapsedGroups.includes(stickyGroupId)
  );

  const scrollContext = useCallback(() => {
    const root = rootRef.current;
    if (!root) return null;
    if (scrollOwner === "self") {
      return {
        element: root,
        scrollY: root.scrollTop,
        viewportHeight: root.clientHeight,
        offset: 0,
      };
    }
    let parent = root.parentElement;
    while (parent) {
      const overflow = getComputedStyle(parent).overflowY;
      if (overflow === "auto" || overflow === "scroll") {
        // Include content above the list when translating the parent's scroll
        // position into item coordinates (for example the All Content toolbar).
        const offset =
          root.getBoundingClientRect().top -
          parent.getBoundingClientRect().top +
          parent.scrollTop;
        return {
          element: parent,
          scrollY: parent.scrollTop - offset,
          viewportHeight: parent.clientHeight,
          offset,
        };
      }
      parent = parent.parentElement;
    }
    return null;
  }, [scrollOwner]);

  const groups = useMemo(() => {
    if (items.length === 0) return [];
    if (items[0] && "items" in items[0]) return items as MasonryGroup[];
    return [{ id: "", height: 0, items: items as MasonryItemType[] }];
  }, [items]);

  const stickyGroup = useMemo(() => {
    if (!stickyGroupId) return undefined;
    return groups.find((group) => group.id === stickyGroupId);
  }, [groups, stickyGroupId]);

  const updateActiveMap = useCallback(
    (
      nextLayoutMap: Map<MasonryItemType["id"], MasonryItemXYWH>,
      _scrollY?: number,
    ) => {
      if (!virtualScroll) return;
      if (!rootRef.current) return;
      requestAnimationFrame(() => {
        const context = scrollContext();
        if (!context) return;
        const scrollY = _scrollY ?? context.scrollY;
        setActiveMap(
          calcActive({
            viewportHeight: context.viewportHeight,
            scrollY,
            layoutMap: nextLayoutMap,
            preloadHeight,
          }),
        );
      });
    },
    [preloadHeight, scrollContext, virtualScroll],
  );

  const onItemMeasure = useCallback(
    (id: string, width: number, height: number) => {
      if (!Number.isFinite(height) || height <= 0) return;
      setMeasuredHeights((previous) => {
        const old = previous.get(id);
        if (old?.width === width && Math.abs(old.height - height) < 0.5)
          return previous;
        const next = new Map(previous);
        next.set(id, { width, height });
        return next;
      });
    },
    [],
  );

  const calculateLayout = useCallback(() => {
    const rootEl = rootRef.current;
    if (!rootEl) return;
    const totalWidth = rootEl.clientWidth;
    const { columns: calculatedColumns, width } = calcColumns(
      totalWidth,
      itemWidth,
      measuredCardSize
        ? measuredCardWidthMinimum[measuredCardSize]
        : itemWidthMin,
      gapX,
      paddingX,
      columns,
    );
    const { layout, height } = calcLayout(groups, {
      totalWidth,
      columns: calculatedColumns,
      width,
      gapX,
      gapY,
      paddingX,
      paddingY,
      groupsGap,
      groupHeaderGapWithItems,
      collapsedGroups: collapsedGroups ?? [],
      layoutMode,
      measuredHeights: new Map(
        [...measuredHeights].flatMap(([id, measured]) =>
          Math.abs(measured.width - width) < 0.5
            ? [[id, measured.height] as const]
            : [],
        ),
      ),
    });
    const context = scrollContext();
    const scrollY = context?.scrollY ?? 0;
    // Only the opt-in measured layout changes card heights after mounting.
    // Keep the first visible key at its old viewport offset as those heights
    // settle, without changing the scroll semantics of legacy consumers.
    if (scrollOwner === "parent") {
      const firstVisible = [...layoutRef.current].find(
        ([, position]) =>
          position.type === "item" &&
          position.y + position.h > scrollY &&
          position.y < scrollY + (context?.viewportHeight ?? 0),
      );
      pendingAnchor.current = firstVisible
        ? { id: firstVisible[0], offset: firstVisible[1].y - scrollY }
        : null;
    }
    layoutRef.current = layout;
    setLayoutMap(layout);
    setHeight(height);
    setTotalWidth(totalWidth);
    updateActiveMap(layout);
    if (stickyGroupHeader) {
      setStickyGroupId(calcSticky({ scrollY, layoutMap: layout }));
    }
  }, [
    collapsedGroups,
    columns,
    gapX,
    gapY,
    groupHeaderGapWithItems,
    groups,
    groupsGap,
    itemWidth,
    itemWidthMin,
    measuredCardSize,
    layoutMode,
    measuredHeights,
    paddingX,
    paddingY,
    scrollContext,
    scrollOwner,
    stickyGroupHeader,
    updateActiveMap,
  ]);

  useEffect(() => {
    calculateLayout();
    if (!rootRef.current) return;
    return observeResize(
      rootRef.current,
      debounce(calculateLayout, resizeDebounce),
    );
  }, [calculateLayout, resizeDebounce]);

  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    const context = scrollContext();
    const position = anchor && layoutMap.get(anchor.id);
    if (!context || !position || !anchor) return;
    context.element.scrollTop = context.offset + position.y - anchor.offset;
    updateActiveMap(layoutMap);
  }, [layoutMap, scrollContext, updateActiveMap]);

  useEffect(() => {
    const context = scrollContext();
    if (!context || !virtualScroll) return;
    const handler = throttle(() => {
      const current = scrollContext();
      if (!current) return;
      const scrollY = current.scrollY;
      updateActiveMap(layoutMap, scrollY);
      if (stickyGroupHeader) {
        const nextStickyGroupId = calcSticky({ scrollY, layoutMap });
        setStickyGroupId(nextStickyGroupId);
        onStickyGroupChange?.(nextStickyGroupId);
      }
    }, 50);
    context.element.addEventListener("scroll", handler);
    return () => context.element.removeEventListener("scroll", handler);
  }, [
    layoutMap,
    onStickyGroupChange,
    scrollContext,
    stickyGroupHeader,
    updateActiveMap,
    virtualScroll,
  ]);

  const scrollToGroup = useCallback(
    (groupId: string) => {
      const group = layoutMap.get(groupId);
      if (!group) return;
      const context = scrollContext();
      context?.element.scrollTo({
        top: context.offset + group.y,
        behavior: "auto",
      });
    },
    [layoutMap, scrollContext],
  );

  useImperativeHandle(ref, () => ({ scrollToGroup }), [scrollToGroup]);

  return (
    <div
      className={joinClassName("myoxus-masonry-shell", className)}
      style={style}
    >
      <div
        ref={rootRef}
        data-masonry-root
        data-masonry-scroll-owner={scrollOwner}
        className="myoxus-masonry-root"
        {...props}
      >
        {groups.map((group) => {
          const {
            id: groupId,
            items,
            className: groupClassName,
            Component,
            ...groupProps
          } = group;
          const collapsed =
            collapsedGroups && collapsedGroups.includes(groupId);
          return (
            <Fragment key={groupId}>
              {virtualScroll && !activeMap.get(group.id) ? null : (
                <MasonryGroupHeader
                  className={joinClassName(
                    "myoxus-masonry-group-header",
                    groupClassName,
                  )}
                  key={`header-${groupId}`}
                  id={groupId}
                  locateMode={locateMode}
                  xywh={layoutMap.get(groupId)}
                  {...groupProps}
                  onClick={() => onGroupCollapse?.(groupId, !collapsed)}
                  Component={Component}
                  itemCount={items.length}
                  collapsed={!!collapsed}
                  groupId={groupId}
                  paddingX={calcPX(paddingX, totalWidth)}
                />
              )}
              {collapsed
                ? null
                : items.map(({ id: itemId, Component, ...item }) => {
                    const mixId = groupId ? `${groupId}:${itemId}` : itemId;
                    if (virtualScroll && !activeMap.get(mixId)) return null;
                    return (
                      <MasonryGroupItem
                        key={mixId}
                        id={mixId}
                        {...item}
                        locateMode={locateMode}
                        xywh={layoutMap.get(mixId)}
                        groupId={groupId}
                        itemId={itemId}
                        Component={Component}
                        onMeasure={
                          "measured" in item ? onItemMeasure : undefined
                        }
                      />
                    );
                  })}
            </Fragment>
          );
        })}
        <div data-masonry-placeholder style={{ height }} />
      </div>
      {stickyGroup ? (
        <div
          className={joinClassName(
            "myoxus-masonry-sticky-group-header",
            stickyGroup.className,
          )}
          style={{
            padding: `0 ${calcPX(paddingX, totalWidth)}px`,
            height: stickyGroup.height,
            ...stickyGroup.style,
          }}
          onClick={() =>
            onGroupCollapse?.(stickyGroup.id, !stickyGroupCollapsed)
          }
        >
          {stickyGroup.Component ? (
            <stickyGroup.Component
              groupId={stickyGroup.id}
              itemCount={stickyGroup.items.length}
              collapsed={stickyGroupCollapsed}
            />
          ) : (
            stickyGroup.children
          )}
        </div>
      ) : null}
    </div>
  );
});

type MasonryItemProps = MasonryItemType &
  Omit<HTMLAttributes<HTMLDivElement>, "id" | "height"> & {
    locateMode?: "transform" | "leftTop" | "transform3d";
    xywh?: MasonryItemXYWH;
  };

const MasonryGroupHeader = memo(function MasonryGroupHeader({
  id,
  children,
  style,
  className,
  Component,
  groupId,
  itemCount,
  collapsed,
  paddingX,
  ...props
}: Omit<MasonryItemProps, "Component"> & {
  Component?: MasonryGroup["Component"];
  groupId: string;
  itemCount: number;
  collapsed: boolean;
  paddingX?: number;
}) {
  const content = useMemo(() => {
    if (Component) {
      return (
        <Component
          groupId={groupId}
          itemCount={itemCount}
          collapsed={collapsed}
        />
      );
    }
    return children;
  }, [Component, children, collapsed, groupId, itemCount]);

  return (
    <MasonryPositionedItem
      id={id}
      style={{ padding: `0 ${paddingX}px`, height: "100%", ...style }}
      className={className}
      {...props}
    >
      {content}
    </MasonryPositionedItem>
  );
});

const MasonryGroupItem = memo(function MasonryGroupItem({
  id,
  children,
  className,
  Component,
  groupId,
  itemId,
  onMeasure,
  ...props
}: MasonryItemProps & {
  groupId: string;
  itemId: string;
  measured?: true;
  onMeasure?: (id: string, width: number, height: number) => void;
}) {
  const content = useMemo(() => {
    if (Component) return <Component groupId={groupId} itemId={itemId} />;
    return children;
  }, [Component, children, groupId, itemId]);

  return (
    <MasonryPositionedItem
      id={id}
      className={className}
      {...props}
      onMeasure={onMeasure}
    >
      {content}
    </MasonryPositionedItem>
  );
});

const MasonryPositionedItem = memo(function MasonryPositionedItem({
  id,
  xywh,
  locateMode = "leftTop",
  children,
  className,
  style: styleProp,
  onMeasure,
  measured,
  ...props
}: Omit<MasonryItemProps, "height" | "ratio"> & {
  onMeasure?: (id: string, width: number, height: number) => void;
  measured?: true;
}) {
  const itemRef = useRef<HTMLDivElement>(null);
  const width = xywh?.w;
  useEffect(() => {
    const element = itemRef.current;
    if (!element || width === undefined || !onMeasure) return;
    const measure = () =>
      onMeasure(id, width, element.getBoundingClientRect().height);
    measure();
    return observeResize(element, measure);
  }, [id, onMeasure, width]);
  const style = useMemo<CSSProperties>(() => {
    if (!xywh) return { display: "none" };
    const { x, y, w, h } = xywh;
    const posStyle =
      locateMode === "transform"
        ? { transform: `translate(${x}px, ${y}px)` }
        : locateMode === "leftTop"
          ? { left: `${x}px`, top: `${y}px` }
          : { transform: `translate3d(${x}px, ${y}px, 0)` };
    return {
      left: 0,
      top: 0,
      ...styleProp,
      ...posStyle,
      width: `${w}px`,
      height: measured ? undefined : `${h}px`,
    };
  }, [locateMode, measured, styleProp, xywh]);

  if (!xywh) return null;

  return (
    <div
      ref={itemRef}
      data-masonry-item
      data-masonry-item-id={id}
      style={style}
      className={joinClassName("myoxus-masonry-item", className)}
      {...props}
    >
      {children}
    </div>
  );
});
