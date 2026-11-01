// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps } from "./helpers/ui-role";
import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  forwardRef,
  useState,
  useRef,
  useCallback,
  useId,
  useLayoutEffect,
} from "react";
import {
  Tabs as MantineTabs,
  Box,
  Tooltip as MantineTooltip,
  VisuallyHidden as MantineVisuallyHidden,
} from "@mantine/core";
import {
  type DNDData,
  useDraggable,
  useDropTarget,
  DropIndicator,
} from "./dnd";
import { cssVar } from "@myoxus/theme";
import { Menu, MenuTrigger, MenuItem } from "./menu";
import { IconButton } from "./button";
import { MoreHorizontalIcon } from "@myoxus/icons/react";
import { useResponsiveElementSize } from "./responsive";

export function Tabs({
  value,
  defaultValue,
  onChange,
  children,
  className,
  style,
  layout = "default",
  variant,
  fill = false,
  keepMounted,
  "data-testid": dataTestId,
  onValueChange,
}: RoleBoxProps & {
  value?: string | null;
  defaultValue?: string;
  onChange?: (value: string | null) => void;
  onValueChange?: (value: string) => void;
  fill?: boolean;
  /** Mantine's retention policy; a panel can opt in with `forceMount`. */
  keepMounted?: boolean;
  layout?: "default" | "page" | "embedded";
  /** Native appearance is independent of the page/embedded scroll contract. */
  variant?: ComponentProps<typeof MantineTabs>["variant"];
}) {
  // Centralize page/embedded tab overflow behavior here so route-local tab
  // panel stacks do not reappear.
  const layoutStyle =
    layout === "default" && !fill
      ? undefined
      : ({
          display: "flex",
          flex: fill ? 1 : layout === "page" ? 1 : undefined,
          height: fill ? "100%" : undefined,
          width: "100%",
          minWidth: 0,
          minHeight: 0,
          flexDirection: "column",
          overflow: layout === "embedded" ? "visible" : "hidden",
          gap: layout === "embedded" ? "var(--mantine-spacing-md)" : undefined,
        } satisfies CSSProperties);

  return (
    <MantineTabs
      value={value}
      defaultValue={defaultValue}
      keepMounted={keepMounted}
      variant={variant ?? (layout === "default" ? "default" : "pills")}
      onChange={(nextValue) => {
        onChange?.(nextValue);
        if (nextValue !== null) {
          onValueChange?.(nextValue);
        }
      }}
      className={className}
      style={{ ...layoutStyle, ...style }}
      data-testid={dataTestId}
      data-myoxus-ui-role={layout === "default" ? "tabs" : `tabs:${layout}`}
    >
      {children}
    </MantineTabs>
  );
}

export function TabsList({
  children,
  className,
  variant = "default",
  style,
  "data-testid": dataTestId,
}: RoleBoxProps & {
  variant?: "default" | "page" | "panel";
}) {
  return (
    <MantineTabs.List
      className={className}
      style={style}
      data-testid={dataTestId}
      data-myoxus-ui-role="tabs-list"
      data-myoxus-ui-variant={variant === "default" ? undefined : variant}
    >
      {children}
    </MantineTabs.List>
  );
}

export type TabsTriggerProps = RoleBoxProps & {
  value: string;
  "aria-describedby"?: string;
  disabled?: boolean;
  grow?: boolean;
  variant?: "default" | "page" | "panel";
  leftSection?: ReactNode;
  rightSection?: ReactNode;
  title?: string;
  /**
   * Keeps user-authored labels from monopolizing a wrapping tab list. The
   * ratio remains container-relative so product routes need no width rules or
   * viewport probes.
   */
  truncate?: boolean;
};

export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(
  function TabsTrigger(
    {
      value,
      children,
      className,
      style,
      disabled,
      grow = false,
      variant = "default",
      leftSection,
      rightSection,
      title,
      truncate = false,
      onKeyDown,
      "aria-describedby": ariaDescribedBy,
      "data-myoxus-ui-role": uiRole,
      "data-testid": dataTestId,
    },
    ref,
  ) {
    return (
      <MantineTabs.Tab
        ref={ref}
        value={value}
        className={className}
        style={{
          flex: grow ? 1 : undefined,
          maxWidth: truncate ? "calc(100% / 3)" : undefined,
          minWidth: truncate ? 0 : undefined,
          overflow: truncate ? "hidden" : undefined,
          ...style,
        }}
        disabled={disabled}
        leftSection={leftSection}
        rightSection={rightSection}
        styles={
          truncate
            ? {
                tabLabel: {
                  flex: "0 1 auto",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
              }
            : undefined
        }
        data-testid={dataTestId}
        data-myoxus-ui-role={uiRole ?? "tabs-trigger"}
        data-myoxus-ui-variant={variant === "default" ? undefined : variant}
        title={title}
        onKeyDown={onKeyDown}
        aria-describedby={ariaDescribedBy}
      >
        {children}
      </MantineTabs.Tab>
    );
  },
);

export interface OverflowTabItem {
  value: string;
  label: ReactNode;
  textLabel: string;
  leftSection?: ReactNode;
  menuItems?: ReactNode;
  menuLabel?: string;
  disabled?: boolean;
  testId?: string;
}

export interface OverflowTabsListProps {
  activeValue: string;
  /** Compact, jointly framed icon navigation for Workbench headers. */
  appearance?: "tabs" | "switcher";
  items: OverflowTabItem[];
  moreLabel: string;
  onValueChange: (value: string) => void;
  variant?: "default" | "page" | "panel";
  endControl?: ReactNode;
  onReorder?: (orderedValues: string[]) => Promise<void> | void;
  reorderAnnouncement?: (
    item: OverflowTabItem,
    index: number,
    total: number,
  ) => string;
  reorderInstruction?: string;
  "data-testid"?: string;
}

type OverflowTabsDndData = DNDData<
  { kind: "overflow-tab"; listId: string; value: string },
  { kind: "overflow-tab"; listId: string; value: string }
>;

function sameStringArray(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function reorderedTabValues(
  values: string[],
  sourceValue: string,
  targetValue: string,
  edge: "left" | "right",
) {
  if (sourceValue === targetValue) return values;
  const remaining = values.filter((value) => value !== sourceValue);
  const targetIndex = remaining.indexOf(targetValue);
  if (targetIndex < 0) return values;
  remaining.splice(targetIndex + (edge === "right" ? 1 : 0), 0, sourceValue);
  return remaining;
}

/**
 * Resolves a stable server-order subset while always retaining the active tab.
 * Width measurement is intentionally Facade-owned so product routes never add
 * viewport probes or local overflow thresholds.
 */
export function resolveOverflowTabValues({
  activeValue,
  availableWidth,
  itemWidths,
  values,
}: {
  activeValue: string;
  availableWidth: number;
  itemWidths: Map<string, number>;
  values: string[];
}) {
  if (availableWidth <= 0) return values;
  const totalWidth = values.reduce(
    (total, value) => total + (itemWidths.get(value) ?? 0),
    0,
  );
  if (totalWidth <= availableWidth) return values;

  const visible: string[] = [];
  let usedWidth = 0;
  for (const value of values) {
    const width = itemWidths.get(value) ?? 0;
    if (usedWidth + width > availableWidth) break;
    visible.push(value);
    usedWidth += width;
  }

  if (visible.includes(activeValue)) return visible;
  const activeWidth = itemWidths.get(activeValue) ?? 0;
  const nextVisible = [activeValue];
  usedWidth = activeWidth;
  for (const value of values) {
    if (value === activeValue) continue;
    const width = itemWidths.get(value) ?? 0;
    if (usedWidth + width > availableWidth) break;
    nextVisible.push(value);
    usedWidth += width;
  }
  return nextVisible.sort(
    (left, right) => values.indexOf(left) - values.indexOf(right),
  );
}

function OverflowTabSlot({
  active,
  appearance,
  item,
  listId,
  onPointerReorder,
  onKeyboardReorder,
  onMeasure,
  reorderInstructionId,
  variant,
}: {
  active: boolean;
  appearance: "tabs" | "switcher";
  item: OverflowTabItem;
  listId: string;
  onPointerReorder?: (
    sourceValue: string,
    targetValue: string,
    edge: "left" | "right",
  ) => void;
  onKeyboardReorder?: (value: string, delta: -1 | 1) => void;
  onMeasure: (value: string, node: HTMLDivElement | null) => void;
  reorderInstructionId?: string;
  variant: "default" | "page" | "panel";
}) {
  const [actionsVisible, setActionsVisible] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const { dragRef, dragHandleRef, dragging } =
    useDraggable<OverflowTabsDndData>(
      () => ({
        canDrag: Boolean(onPointerReorder),
        data: { kind: "overflow-tab", listId, value: item.value },
        dragPreviewPosition: "pointer-outside",
      }),
      [item.value, listId, onPointerReorder],
    );
  const { closestEdge, draggedOver, dropTargetRef } =
    useDropTarget<OverflowTabsDndData>(
      () => ({
        canDrop: ({ source }) =>
          Boolean(onPointerReorder) &&
          source.data.kind === "overflow-tab" &&
          source.data.listId === listId,
        closestEdge: { allowedEdges: ["left", "right"] },
        data: { kind: "overflow-tab", listId, value: item.value },
        onDrop: ({ closestEdge: edge, source }) => {
          if (edge !== "left" && edge !== "right") {
            return;
          }
          onPointerReorder?.(source.data.value, item.value, edge);
        },
      }),
      [item.value, listId, onPointerReorder],
    );

  const setSlotRef = useCallback(
    (node: HTMLDivElement | null) => {
      dragRef.current = node;
      dropTargetRef.current = node;
      onMeasure(item.value, node);
    },
    [dragRef, dropTargetRef, item.value, onMeasure],
  );

  return (
    <Box
      ref={setSlotRef}
      role="presentation"
      onPointerEnter={() => setActionsVisible(true)}
      onPointerLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) {
          setActionsVisible(false);
        }
      }}
      onFocus={() => setActionsVisible(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setActionsVisible(false);
        }
      }}
      data-dragging={dragging ? "true" : undefined}
      data-myoxus-ui-role="overflow-tab-slot"
      style={{
        alignItems: "center",
        display: "flex",
        flex: "0 0 auto",
        maxWidth: appearance === "tabs" ? "calc(100% / 3)" : undefined,
        minWidth: 0,
        position: "relative",
      }}
    >
      <TabsTrigger
        ref={dragHandleRef}
        value={item.value}
        variant={variant}
        leftSection={appearance === "tabs" ? item.leftSection : undefined}
        title={appearance === "tabs" ? item.textLabel : undefined}
        truncate={appearance === "tabs"}
        style={{
          background:
            appearance === "switcher" && active
              ? cssVar("backgroundPrimaryColor")
              : undefined,
          color:
            appearance === "switcher"
              ? cssVar(active ? "iconColor" : "iconSecondary")
              : undefined,
          maxWidth: "100%",
        }}
        disabled={item.disabled}
        data-testid={item.testId}
        data-myoxus-ui-role="overflow-tabs-trigger"
        aria-describedby={reorderInstructionId}
        onKeyDown={(event) => {
          if (
            !onKeyboardReorder ||
            !event.altKey ||
            !event.shiftKey ||
            (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const direction = getComputedStyle(event.currentTarget).direction;
          const physicalDelta = event.key === "ArrowLeft" ? -1 : 1;
          onKeyboardReorder(
            item.value,
            (direction === "rtl" ? -physicalDelta : physicalDelta) as -1 | 1,
          );
        }}
      >
        {appearance === "switcher" ? (
          <MantineTooltip label={item.textLabel} position="bottom">
            <Box
              component="span"
              data-myoxus-ui-role="overflow-tabs-switcher-icon"
              style={{
                alignItems: "center",
                display: "flex",
                fontSize:
                  "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
              }}
            >
              {item.leftSection}
              <MantineVisuallyHidden>{item.textLabel}</MantineVisuallyHidden>
            </Box>
          </MantineTooltip>
        ) : (
          item.label
        )}
      </TabsTrigger>
      {item.menuItems && item.menuLabel ? (
        <Menu
          items={item.menuItems}
          rootOptions={{
            onOpenChange: (open) => {
              if (open) {
                setActionsVisible(true);
              } else {
                // Mantine intentionally does not restore pointer-opened Menu
                // focus. Defer until its close cycle has finished so every
                // input path returns to the owning tab action consistently.
                requestAnimationFrame(() => menuTriggerRef.current?.focus());
              }
            },
          }}
          contentOptions={{ align: "start", panelWidth: "comfortable" }}
        >
          <IconButton
            ref={menuTriggerRef}
            aria-label={item.menuLabel}
            size="small"
            variant="plain"
            tabIndex={actionsVisible ? 0 : -1}
            style={{ visibility: actionsVisible ? "visible" : "hidden" }}
            data-testid={
              item.testId ? `${item.testId}-menu-trigger` : undefined
            }
            data-myoxus-ui-role="overflow-tab-menu-trigger"
          >
            <MoreHorizontalIcon />
          </IconButton>
        </Menu>
      ) : null}
      {draggedOver ? <DropIndicator edge={closestEdge} /> : null}
    </Box>
  );
}

/** Mantine Tabs with theme-owned overflow, menus and pointer/keyboard reorder. */
export function OverflowTabsList({
  activeValue,
  appearance = "tabs",
  items,
  moreLabel,
  onValueChange,
  variant = "default",
  endControl,
  onReorder,
  reorderAnnouncement,
  reorderInstruction,
  "data-testid": dataTestId,
}: OverflowTabsListProps) {
  const listId = useId();
  const instructionId = useId();
  const { ref: sizeRef, width } = useResponsiveElementSize<HTMLDivElement>();
  const listElementRef = useRef<HTMLDivElement>(null);
  const itemElements = useRef(new Map<string, HTMLDivElement>());
  const itemWidths = useRef(new Map<string, number>());
  const moreMeasureRef = useRef<HTMLSpanElement>(null);
  const endControlRef = useRef<HTMLSpanElement>(null);
  const [visibleValues, setVisibleValues] = useState(() =>
    items.map((item) => item.value),
  );
  const [announcement, setAnnouncement] = useState("");
  const itemSignature = items
    .map((item) => `${item.value}:${item.textLabel}`)
    .join("\u0000");
  const previousSignature = useRef(itemSignature);

  const setItemElement = useCallback(
    (value: string, node: HTMLDivElement | null) => {
      if (node) itemElements.current.set(value, node);
      else itemElements.current.delete(value);
    },
    [],
  );
  const setListElement = useCallback(
    (node: HTMLDivElement | null) => {
      listElementRef.current = node;
      sizeRef(node);
    },
    [sizeRef],
  );

  useLayoutEffect(() => {
    if (previousSignature.current !== itemSignature) {
      previousSignature.current = itemSignature;
      itemWidths.current.clear();
      setVisibleValues(items.map((item) => item.value));
      return;
    }
    for (const item of items) {
      const measuredWidth = itemElements.current
        .get(item.value)
        ?.getBoundingClientRect().width;
      if (measuredWidth) itemWidths.current.set(item.value, measuredWidth);
    }
    if (
      width <= 0 ||
      items.some((item) => !itemWidths.current.has(item.value))
    ) {
      return;
    }
    const values = items.map((item) => item.value);
    const endWidth = endControlRef.current?.getBoundingClientRect().width ?? 0;
    const totalTabsWidth = values.reduce(
      (total, value) => total + (itemWidths.current.get(value) ?? 0),
      0,
    );
    const requiresOverflow = totalTabsWidth + endWidth > width;
    const moreWidth = requiresOverflow
      ? (moreMeasureRef.current?.getBoundingClientRect().width ?? 0)
      : 0;
    const nextVisible = resolveOverflowTabValues({
      activeValue,
      availableWidth: Math.max(0, width - endWidth - moreWidth),
      itemWidths: itemWidths.current,
      values,
    });
    setVisibleValues((current) =>
      sameStringArray(current, nextVisible) ? current : nextVisible,
    );
  }, [activeValue, itemSignature, items, width]);

  useLayoutEffect(() => {
    const listElement = listElementRef.current;
    const endControlElement = endControlRef.current;
    if (!listElement || !endControlElement || width <= 0) return;
    let overflow =
      endControlElement.getBoundingClientRect().right -
      listElement.getBoundingClientRect().right;
    if (overflow <= 0) return;

    const nextVisible = [...visibleValues];
    for (let index = nextVisible.length - 1; index >= 0; index -= 1) {
      const value = nextVisible[index];
      if (!value || value === activeValue) continue;
      nextVisible.splice(index, 1);
      overflow -= itemWidths.current.get(value) ?? 0;
      if (overflow <= 0) break;
    }
    setVisibleValues((current) =>
      sameStringArray(current, nextVisible) ? current : nextVisible,
    );
  }, [activeValue, visibleValues, width]);

  const orderedValues = items.map((item) => item.value);
  const hiddenItems = items.filter(
    (item) => !visibleValues.includes(item.value),
  );
  const commitReorder = useCallback(
    (nextValues: string[], movedValue: string) => {
      if (!onReorder || sameStringArray(orderedValues, nextValues)) return;
      const movedItem = items.find((item) => item.value === movedValue);
      const nextIndex = nextValues.indexOf(movedValue);
      if (movedItem && reorderAnnouncement) {
        setAnnouncement(
          reorderAnnouncement(movedItem, nextIndex, nextValues.length),
        );
      }
      void onReorder(nextValues);
    },
    [items, onReorder, orderedValues, reorderAnnouncement],
  );
  const pointerReorder = useCallback(
    (sourceValue: string, targetValue: string, edge: "left" | "right") => {
      commitReorder(
        reorderedTabValues(orderedValues, sourceValue, targetValue, edge),
        sourceValue,
      );
    },
    [commitReorder, orderedValues],
  );
  const keyboardReorder = useCallback(
    (value: string, delta: -1 | 1) => {
      const currentIndex = orderedValues.indexOf(value);
      const nextIndex = currentIndex + delta;
      if (
        currentIndex < 0 ||
        nextIndex < 0 ||
        nextIndex >= orderedValues.length
      ) {
        return;
      }
      const nextValues = [...orderedValues];
      nextValues.splice(currentIndex, 1);
      nextValues.splice(nextIndex, 0, value);
      commitReorder(nextValues, value);
    },
    [commitReorder, orderedValues],
  );

  return (
    <MantineTabs.List
      ref={setListElement}
      data-testid={dataTestId}
      data-myoxus-ui-role="overflow-tabs-list"
      data-myoxus-ui-appearance={appearance}
      data-myoxus-ui-variant={variant === "default" ? undefined : variant}
      style={{
        background:
          appearance === "switcher"
            ? cssVar("backgroundSecondaryColor")
            : undefined,
        borderRadius:
          appearance === "switcher" ? "var(--mantine-radius-md)" : undefined,
        flexWrap: "nowrap",
        maxWidth: "100%",
        minWidth: 0,
        overflow: "hidden",
        padding:
          appearance === "switcher" ? "var(--mantine-spacing-2xs)" : undefined,
        position: "relative",
        width: appearance === "switcher" ? "fit-content" : "100%",
      }}
    >
      {items
        .filter((item) => visibleValues.includes(item.value))
        .map((item) => (
          <OverflowTabSlot
            key={item.value}
            active={item.value === activeValue}
            appearance={appearance}
            item={item}
            listId={listId}
            onMeasure={setItemElement}
            onPointerReorder={onReorder ? pointerReorder : undefined}
            onKeyboardReorder={onReorder ? keyboardReorder : undefined}
            reorderInstructionId={
              onReorder && reorderInstruction ? instructionId : undefined
            }
            variant={variant}
          />
        ))}
      <span
        ref={moreMeasureRef}
        aria-hidden="true"
        data-myoxus-ui-role="overflow-tabs-more-measure"
        style={{
          pointerEvents: "none",
          position: "absolute",
          visibility: "hidden",
        }}
      >
        {appearance === "switcher" ? (
          <IconButton
            aria-label={moreLabel}
            size="small"
            tabIndex={-1}
            variant="plain"
          >
            <MoreHorizontalIcon />
          </IconButton>
        ) : (
          <MenuTrigger size="small" tabIndex={-1} variant="plain">
            {moreLabel}
          </MenuTrigger>
        )}
      </span>
      {hiddenItems.length ? (
        <Menu
          items={hiddenItems.map((item) => (
            <MenuItem
              key={item.value}
              prefix={item.leftSection}
              active={item.value === activeValue}
              onSelect={() => onValueChange(item.value)}
              data-testid={`overflow-tab-item-${item.value}`}
            >
              {item.label}
            </MenuItem>
          ))}
          contentOptions={{ align: "end", panelWidth: "comfortable" }}
        >
          {appearance === "switcher" ? (
            <IconButton
              aria-label={moreLabel}
              size="small"
              tooltip={moreLabel}
              variant="plain"
              data-myoxus-ui-role="overflow-tabs-more-trigger"
            >
              <MoreHorizontalIcon />
            </IconButton>
          ) : (
            <MenuTrigger
              size="small"
              variant="plain"
              data-myoxus-ui-role="overflow-tabs-more-trigger"
            >
              {moreLabel}
            </MenuTrigger>
          )}
        </Menu>
      ) : null}
      {endControl ? (
        <span
          ref={endControlRef}
          data-myoxus-ui-role="overflow-tabs-end-control"
          style={{ display: "flex", flex: "0 0 auto" }}
        >
          {endControl}
        </span>
      ) : null}
      {onReorder && reorderInstruction ? (
        <MantineVisuallyHidden id={instructionId}>
          {reorderInstruction}
        </MantineVisuallyHidden>
      ) : null}
      <MantineVisuallyHidden aria-live="polite">
        {announcement}
      </MantineVisuallyHidden>
    </MantineTabs.List>
  );
}

export function TabsContent({
  value,
  children,
  className,
  fill = false,
  gap = "var(--mantine-spacing-md)",
  layout,
  flush = false,
  padding,
  scroll = false,
  style,
  "data-testid": dataTestId,
  forceMount,
}: RoleBoxProps & {
  value: string;
  forceMount?: boolean;
  fill?: boolean;
  gap?: CSSProperties["gap"];
  flush?: boolean;
  layout?: "stack";
  padding?: CSSProperties["padding"];
  scroll?: boolean;
}) {
  return (
    <MantineTabs.Panel
      value={value}
      keepMounted={forceMount}
      className={className}
      style={{
        display: layout === "stack" ? "flex" : undefined,
        flex: fill ? 1 : undefined,
        flexDirection: layout === "stack" ? "column" : undefined,
        gap: layout === "stack" ? gap : undefined,
        marginTop: flush ? 0 : undefined,
        minHeight: fill ? 0 : undefined,
        minWidth: layout === "stack" || fill ? 0 : undefined,
        overflow: scroll ? "auto" : undefined,
        padding,
        width: layout === "stack" || fill ? "100%" : undefined,
        ...style,
      }}
      data-testid={dataTestId}
      data-myoxus-ui-role="tabs-content"
    >
      {children}
    </MantineTabs.Panel>
  );
}
