import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Box,
  Masonry,
  type MasonryGroup,
  type MasonryItem,
  Scrollable,
  SurfaceListItem,
} from "@myoxus/ui-facade";
import {
  type ComponentType,
  forwardRef,
  type ReactNode,
  type PropsWithChildren,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Virtuoso } from "react-virtuoso";

import type { DocListItemView } from "./docs-view/doc-list-item";
import type { ExplorerPreviewSize } from "./types";

export interface ExplorerItemComponentProps {
  groupId: string;
  itemId: string;
  inventoryPreview?: "grid" | "masonry";
}

export interface ExplorerGroupHeaderProps {
  collapsed?: boolean;
  groupId: string;
  interactive?: boolean;
  itemCount: number;
}

export type ExplorerListGroupFrameProps = PropsWithChildren<{
  groupId: string;
  selected?: boolean;
}>;

/**
 * Mantine-backed frame for one grouped list section. Specialized scopes may
 * wrap its behaviour (for example, a semantic drop target) while preserving
 * the shared row density and selected-state chrome.
 */
export const ExplorerListGroupFrame = forwardRef<
  HTMLElement,
  ExplorerListGroupFrameProps
>(function ExplorerListGroupFrame({ children, groupId, selected }, ref) {
  return (
    <SurfaceListItem
      ref={ref}
      alignItems="center"
      density="compact"
      layout="row"
      selected={selected}
      data-group-id={groupId}
      data-myoxus-ui-role="explorer-list-accordion-header"
    >
      {children}
    </SurfaceListItem>
  );
});

export type ExplorerListScrollOwner = "explorer" | "parent";

const cardAspectRatios = [1.26, 1.304, 1.13, 1.391, 1.521];
const accordionGroupValue = (groupId: string) => `group:${groupId}`;
// Masonry consumes height/width, while the card presets are width/height.
const masonryHeightRatio = (aspectRatio: number) => 1 / aspectRatio;
const calcCardRatioById = (id: string) => {
  if (!id) return masonryHeightRatio(cardAspectRatios[0]);
  const hash = [...id].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  return masonryHeightRatio(cardAspectRatios[hash % cardAspectRatios.length]);
};

type ExplorerListEntry = ExplorerItemComponentProps;

function findScrollableParent(node: HTMLElement): HTMLElement {
  let parent = node.parentElement;
  while (parent) {
    const overflowY = getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return parent;
    parent = parent.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : document.documentElement;
}

/**
 * Virtualize parent-scrolled explorer rows without taking ownership of the
 * surrounding workbench viewport. Virtuoso measures content geometry; the
 * product surface therefore needs no local row height or responsive CSS.
 */
function VirtualizedExplorerItemList({
  entries,
  ItemComponent,
}: {
  entries: readonly ExplorerListEntry[];
  ItemComponent: ComponentType<ExplorerItemComponentProps>;
}) {
  const parentProbeRef = useRef<HTMLDivElement>(null);
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const probe = parentProbeRef.current;
    if (probe) setScrollParent(findScrollableParent(probe));
  }, []);

  if (!scrollParent) {
    return (
      <Box
        ref={parentProbeRef}
        data-myoxus-ui-role="explorer-list-scroll-parent-probe"
      />
    );
  }

  return (
    <Virtuoso
      computeItemKey={(_index, entry) => `${entry.groupId}:${entry.itemId}`}
      customScrollParent={scrollParent}
      data={entries}
      data-logical-item-count={entries.length}
      data-myoxus-ui-role="explorer-list-virtualized"
      // Measured desktop rows with a description are 48px. This is an estimate,
      // not a fixed UI height: Virtuoso still measures variable rows and themes.
      // An estimate skips the single-row probe without mounting offscreen rows.
      defaultItemHeight={48}
      itemContent={(_index, entry) => (
        <ItemComponent itemId={entry.itemId} groupId={entry.groupId} />
      )}
    />
  );
}

/**
 * Shared list/grid/masonry shell for document-only and mixed Page explorers.
 * Item capability dispatch remains outside this presentational layer.
 */
export function ExplorerItemsView({
  className,
  collapsedGroups,
  empty,
  GroupActionsComponent,
  GroupHeaderComponent,
  ListGroupFrameComponent = ExplorerListGroupFrame,
  GroupSelectionComponent,
  groups,
  groupBy,
  ItemComponent,
  listScrollOwner = "explorer",
  masonryItemWidthMin,
  measuredCards = false,
  previewSize = "normal",
  onCollapsedGroupsChange,
  view,
}: {
  className?: string;
  collapsedGroups: readonly string[];
  empty: ReactNode;
  GroupActionsComponent?: ComponentType<{ groupId: string }>;
  GroupHeaderComponent?: ComponentType<ExplorerGroupHeaderProps>;
  ListGroupFrameComponent?: ComponentType<ExplorerListGroupFrameProps>;
  GroupSelectionComponent?: ComponentType<{ groupId: string }>;
  groups: readonly { key: string; items: string[] }[];
  groupBy: boolean;
  ItemComponent: ComponentType<ExplorerItemComponentProps>;
  listScrollOwner?: ExplorerListScrollOwner;
  masonryItemWidthMin?: number;
  measuredCards?: boolean;
  previewSize?: ExplorerPreviewSize;
  onCollapsedGroupsChange: (groups: string[]) => void;
  view: DocListItemView;
}) {
  const responsivePaddingX = useCallback(
    (width: number) => (width > 500 ? 24 : width > 393 ? 20 : 16),
    [],
  );
  const InventoryItemComponent = useMemo(
    () =>
      function InventoryItem(props: ExplorerItemComponentProps) {
        return (
          <ItemComponent
            {...props}
            inventoryPreview={view === "grid" ? "grid" : "masonry"}
          />
        );
      },
    [ItemComponent, view],
  );
  const expandedGroupIds = useMemo(
    () =>
      groups
        .filter((group) => !collapsedGroups.includes(group.key))
        .map((group) => accordionGroupValue(group.key)),
    [collapsedGroups, groups],
  );
  const handleAccordionChange = useCallback(
    (nextValue: string | string[] | null) => {
      const expandedIds = Array.isArray(nextValue)
        ? nextValue
        : nextValue
          ? [nextValue]
          : [];
      onCollapsedGroupsChange(
        groups
          .filter(
            (group) => !expandedIds.includes(accordionGroupValue(group.key)),
          )
          .map((group) => group.key),
      );
    },
    [groups, onCollapsedGroupsChange],
  );

  if (groups.length === 0) return empty;

  if (view === "list") {
    const listContent = groupBy ? (
      <Accordion
        multiple
        value={expandedGroupIds}
        onChange={handleAccordionChange}
        data-myoxus-ui-role="explorer-list-accordion"
      >
        {groups.map((group) => (
          <AccordionItem
            key={group.key}
            value={accordionGroupValue(group.key)}
            data-myoxus-ui-role="explorer-list-accordion-item"
          >
            <ListGroupFrameComponent groupId={group.key}>
              {GroupSelectionComponent ? (
                <GroupSelectionComponent groupId={group.key} />
              ) : null}
              {group.items.length > 0 ? (
                <AccordionControl
                  flex="1 1 auto"
                  data-myoxus-ui-role="explorer-list-accordion-control"
                >
                  {GroupHeaderComponent ? (
                    <GroupHeaderComponent
                      groupId={group.key}
                      itemCount={group.items.length}
                      interactive={false}
                    />
                  ) : null}
                </AccordionControl>
              ) : (
                <Box
                  flex="1 1 auto"
                  data-myoxus-ui-role="explorer-list-static-group"
                >
                  {GroupHeaderComponent ? (
                    <GroupHeaderComponent
                      groupId={group.key}
                      itemCount={0}
                      interactive={false}
                    />
                  ) : null}
                </Box>
              )}
              {GroupActionsComponent ? (
                <GroupActionsComponent groupId={group.key} />
              ) : null}
            </ListGroupFrameComponent>
            {group.items.length > 0 ? (
              <AccordionPanel
                flushHorizontal
                data-myoxus-ui-role="explorer-list-accordion-panel"
              >
                {listScrollOwner === "parent" ? (
                  <VirtualizedExplorerItemList
                    entries={group.items.map((itemId) => ({
                      groupId: group.key,
                      itemId,
                    }))}
                    ItemComponent={ItemComponent}
                  />
                ) : (
                  group.items.map((itemId) => (
                    <ItemComponent
                      key={`${group.key}:${itemId}`}
                      itemId={itemId}
                      groupId={group.key}
                    />
                  ))
                )}
              </AccordionPanel>
            ) : null}
          </AccordionItem>
        ))}
      </Accordion>
    ) : listScrollOwner === "parent" ? (
      <VirtualizedExplorerItemList
        entries={groups.flatMap((group) =>
          group.items.map((itemId) => ({ groupId: group.key, itemId })),
        )}
        ItemComponent={ItemComponent}
      />
    ) : (
      groups.flatMap((group) =>
        group.items.map((itemId) => (
          <ItemComponent
            key={`${group.key}:${itemId}`}
            itemId={itemId}
            groupId={group.key}
          />
        )),
      )
    );

    if (listScrollOwner === "parent") {
      return (
        <Box miw={0} w="100%" data-myoxus-ui-role="explorer-list-parent-owned">
          {listContent}
        </Box>
      );
    }

    return (
      <Scrollable.Viewport
        className={className}
        fill
        data-myoxus-ui-role="explorer-list-accordion-viewport"
      >
        {listContent}
      </Scrollable.Viewport>
    );
  }

  const masonryItems = groups.map(
    (group) =>
      ({
        id: group.key,
        Component: groupBy ? GroupHeaderComponent : undefined,
        height: groupBy ? 24 : 0,
        items: group.items.map(
          (itemId) =>
            ({
              id: itemId,
              Component: measuredCards ? InventoryItemComponent : ItemComponent,
              ...(measuredCards
                ? { measured: true as const }
                : {
                    ratio:
                      view === "grid"
                        ? masonryHeightRatio(cardAspectRatios[0])
                        : calcCardRatioById(itemId),
                  }),
            }) satisfies MasonryItem,
        ),
      }) satisfies MasonryGroup,
  );

  return (
    <Masonry
      className={className}
      items={masonryItems}
      layoutMode={measuredCards && view === "grid" ? "grid" : "masonry"}
      scrollOwner={measuredCards ? "parent" : "self"}
      measuredCardSize={measuredCards ? previewSize : undefined}
      gapY={BUILD_CONFIG.isMobileEdition ? 12 : 24}
      gapX={BUILD_CONFIG.isMobileEdition ? 12 : 24}
      groupsGap={12}
      groupHeaderGapWithItems={12}
      itemWidthMin={masonryItemWidthMin ?? 220}
      preloadHeight={100}
      itemWidth="stretch"
      virtualScroll
      collapsedGroups={[...collapsedGroups]}
      paddingY={BUILD_CONFIG.isMobileEdition ? 12 : 0}
      paddingX={BUILD_CONFIG.isMobileEdition ? 16 : responsivePaddingX}
    />
  );
}
