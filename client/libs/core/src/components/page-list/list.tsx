import {
  type ForwardedRef,
  memo,
  type PropsWithChildren,
  useEffect,
  useImperativeHandle,
} from "react";

import {
  listPropsAtom,
  selectionStateAtom,
  useAtom,
  useSetAtom,
} from "./scoped-atoms";
import type {
  ItemListHandle,
  ListItem,
  ListProps,
  VirtualizedListProps,
} from "./types";

export function toListPropsAtomSnapshot(
  props: ListProps<ListItem> & Partial<VirtualizedListProps<ListItem>>,
): ListProps<ListItem> & Partial<VirtualizedListProps<ListItem>> {
  return {
    ...props,
    // Several workspace services update their list arrays in place. The scoped
    // atoms use shallow selectors, so keep an immutable snapshot at the atom
    // boundary instead of letting a later in-place mutation hide Empty -> Row
    // transitions from virtualized list grouping and sorting.
    items: [...props.items],
    selectedIds: props.selectedIds ? [...props.selectedIds] : props.selectedIds,
  };
}

// when pressing ESC or double clicking outside of the page list, close the selection mode
const useItemSelectionStateEffect = () => {
  const [selectionState, setSelectionActive] = useAtom(selectionStateAtom);
  useEffect(() => {
    if (
      selectionState.selectionActive &&
      selectionState.selectable === "toggle"
    ) {
      const startTime = Date.now();
      const dblClickHandler = (e: MouseEvent) => {
        if (Date.now() - startTime < 200) {
          return;
        }
        const target = e.target as HTMLElement;
        // skip if event target is inside of a button or input
        // or within a toolbar (like page list floating toolbar)
        if (
          target.tagName === "BUTTON" ||
          target.tagName === "INPUT" ||
          (e.target as HTMLElement).closest(
            'button, input, [role="toolbar"], [role="listitem"]',
          )
        ) {
          return;
        }
        setSelectionActive(false);
        selectionState.onSelectedIdsChange?.([]);
      };

      const escHandler = (e: KeyboardEvent) => {
        if (Date.now() - startTime < 200) {
          return;
        }
        if (e.key === "Escape") {
          setSelectionActive(false);
          selectionState.onSelectedIdsChange?.([]);
        }
      };

      document.addEventListener("dblclick", dblClickHandler);
      document.addEventListener("keydown", escHandler);

      return () => {
        document.removeEventListener("dblclick", dblClickHandler);
        document.removeEventListener("keydown", escHandler);
      };
    }
    return;
  }, [
    selectionState,
    selectionState.selectable,
    selectionState.selectionActive,
    setSelectionActive,
  ]);
};

export const ListInnerWrapper = memo(
  ({
    handleRef,
    children,
    onSelectionActiveChange,
    ...props
  }: PropsWithChildren<
    ListProps<ListItem> &
      Partial<VirtualizedListProps<ListItem>> & {
        handleRef: ForwardedRef<ItemListHandle>;
      }
  >) => {
    const setListPropsAtom = useSetAtom(listPropsAtom);
    const [selectionState, setListSelectionState] = useAtom(selectionStateAtom);
    useItemSelectionStateEffect();
    const groupBySize = Array.isArray(props.groupBy)
      ? props.groupBy.length
      : props.groupBy;
    const selectedIdsSize = props.selectedIds?.length ?? 0;

    useEffect(() => {
      setListPropsAtom(
        toListPropsAtomSnapshot({
          className: props.className,
          docCollection: props.docCollection,
          draggable: props.draggable,
          groupBy: props.groupBy,
          heading: props.heading,
          hideHeader: props.hideHeader,
          items: props.items,
          onSelectedIdsChange: props.onSelectedIdsChange,
          operationsRenderer: props.operationsRenderer,
          rowAsLink: props.rowAsLink,
          selectable: props.selectable,
          selectedIds: props.selectedIds,
        }),
      );
    }, [
      groupBySize,
      props.className,
      props.docCollection,
      props.draggable,
      props.groupBy,
      props.heading,
      props.hideHeader,
      props.items,
      props.items.length,
      props.onSelectedIdsChange,
      props.operationsRenderer,
      props.rowAsLink,
      props.selectable,
      props.selectedIds,
      selectedIdsSize,
      setListPropsAtom,
    ]);

    useEffect(() => {
      onSelectionActiveChange?.(!!selectionState.selectionActive);
    }, [onSelectionActiveChange, selectionState.selectionActive]);

    useImperativeHandle(handleRef, () => {
      return {
        toggleSelectable: () => {
          setListSelectionState(false);
        },
      };
    }, [setListSelectionState]);
    return children;
  },
);

ListInnerWrapper.displayName = "ListInnerWrapper";
