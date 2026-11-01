import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { stopPropagation } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import {
  Checkbox,
  DragHandle as DragHandleIcon,
  SurfaceListDragHandle,
  SurfaceListItem,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListMeta,
  SurfaceListSelectionSlot,
  SurfaceListSpacer,
  SurfaceListText,
  useDraggable,
} from "@myoxus/ui-facade";
import {
  type ForwardedRef,
  forwardRef,
  memo,
  type MouseEvent as ReactMouseEvent,
  type PropsWithChildren,
  useCallback,
  useMemo,
} from "react";

import { selectionStateAtom, useAtom } from "../scoped-atoms";
import type { CollectionListItemProps, PageListItemProps } from "../types";

const preventLinkRowAction = (event: ReactMouseEvent<HTMLElement>) => {
  event.preventDefault();
  event.stopPropagation();
};

const ListTitleCell = ({
  title,
  preview,
}: Pick<PageListItemProps, "title" | "preview">) => {
  const t = useI18n();
  return (
    <SurfaceListItemMain compact data-testid="page-list-item-title">
      <SurfaceListText data-testid="page-list-item-title-text" kind="title">
        {title || t["Untitled"]()}
      </SurfaceListText>
      {preview ? (
        <SurfaceListText
          data-testid="page-list-item-preview-text"
          kind="preview"
        >
          {preview}
        </SurfaceListText>
      ) : null}
    </SurfaceListItemMain>
  );
};

const ListIconCell = ({ icon }: Pick<PageListItemProps, "icon">) => {
  return (
    <SurfaceListItemIcon data-testid="page-list-item-icon">
      {icon}
    </SurfaceListItemIcon>
  );
};

const CollectionSelectionCell = ({
  selectable,
  onSelectedChange,
  selected,
}: Pick<
  CollectionListItemProps,
  "selectable" | "onSelectedChange" | "selected"
>) => {
  const onSelectionChange = useCallback(
    (_event: React.ChangeEvent<HTMLInputElement>) => {
      return onSelectedChange?.();
    },
    [onSelectedChange],
  );
  if (!selectable) {
    return null;
  }
  return (
    <SurfaceListSelectionSlot active>
      <Checkbox
        onClick={stopPropagation}
        checked={!!selected}
        onChange={onSelectionChange}
      />
    </SurfaceListSelectionSlot>
  );
};

const CollectionListOperationsCell = ({
  operations,
}: Pick<CollectionListItemProps, "operations">) => {
  return operations ? (
    <SurfaceListMeta
      layout="row-cluster"
      onClick={preventLinkRowAction}
      data-myoxus-ui-role="page-list-row-actions"
    >
      {operations}
    </SurfaceListMeta>
  ) : null;
};

export const CollectionListItem = memo(function CollectionListItem(
  props: CollectionListItemProps,
) {
  const collectionTitleElement = useMemo(() => {
    return (
      <SurfaceListItem
        alignItems="center"
        component="div"
        density="compact"
        fullWidth
        layout="row"
        role="presentation"
        data-myoxus-ui-role="surface-list-drag-preview"
      >
        <SurfaceListMeta layout="row-cluster">
          <CollectionSelectionCell
            onSelectedChange={props.onSelectedChange}
            selectable={props.selectable}
            selected={props.selected}
          />
          <ListIconCell icon={props.icon} />
        </SurfaceListMeta>
        <ListTitleCell title={props.title} />
      </SurfaceListItem>
    );
  }, [
    props.icon,
    props.onSelectedChange,
    props.selectable,
    props.selected,
    props.title,
  ]);

  const { dragRef, dragging, CustomDragPreview } = useDraggable<MyoxusDNDData>(
    () => ({
      data: {
        entity: {
          type: "collection",
          id: props.collectionId,
        },
        from: {
          at: "all-collections:list",
        },
      },
      canDrag: props.draggable,
    }),
    [props.collectionId, props.draggable],
  );

  return (
    <>
      <CollectionListItemWrapper
        onClick={props.onClick}
        to={props.to}
        collectionId={props.collectionId}
        draggable={props.draggable}
        isDragging={dragging}
        ref={dragRef}
      >
        <SurfaceListItem
          alignItems="center"
          component="div"
          density="compact"
          fullWidth
          interactive={!!props.onClick || !!props.to}
          layout="row"
          selected={!!props.selected}
          data-draggable={props.draggable ? "true" : undefined}
          data-dragging={dragging ? "true" : undefined}
          data-page-list-surface-row="true"
        >
          {props.draggable ? (
            <SurfaceListDragHandle>
              <DragHandleIcon />
            </SurfaceListDragHandle>
          ) : null}
          <CollectionSelectionCell
            onSelectedChange={props.onSelectedChange}
            selectable={props.selectable}
            selected={props.selected}
          />
          <ListIconCell icon={props.icon} />
          <ListTitleCell title={props.title} />
          <SurfaceListSpacer />
          {props.operations ? (
            <CollectionListOperationsCell operations={props.operations} />
          ) : null}
        </SurfaceListItem>
      </CollectionListItemWrapper>
      <CustomDragPreview position="pointer-outside">
        {collectionTitleElement}
      </CustomDragPreview>
    </>
  );
});

type collectionListWrapperProps = PropsWithChildren<
  Pick<
    CollectionListItemProps,
    "to" | "collectionId" | "onClick" | "draggable"
  > & {
    isDragging: boolean;
  }
>;

const CollectionListItemWrapper = forwardRef(
  (
    {
      to,
      isDragging,
      collectionId,
      onClick,
      children,
      draggable,
    }: collectionListWrapperProps,
    ref: ForwardedRef<HTMLAnchorElement & HTMLDivElement>,
  ) => {
    const [selectionState, setSelectionActive] = useAtom(selectionStateAtom);
    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        if (!selectionState.selectable) {
          return;
        }
        if (e.shiftKey) {
          stopPropagation(e);
          setSelectionActive(true);
          onClick?.();
          return;
        }
        if (selectionState.selectionActive) {
          return onClick?.();
        }
      },
      [
        onClick,
        selectionState.selectable,
        selectionState.selectionActive,
        setSelectionActive,
      ],
    );

    const commonProps = useMemo(
      () => ({
        "data-testid": "collection-list-item",
        "data-collection-id": collectionId,
        "data-draggable": draggable,
        "data-myoxus-ui-role": "surface-list-row-link",
        "data-clickable": !!onClick || !!to,
        "data-dragging": isDragging,
        onClick: handleClick,
      }),
      [collectionId, draggable, isDragging, onClick, to, handleClick],
    );

    if (to) {
      return (
        <WorkbenchLink {...commonProps} to={to} ref={ref}>
          {children}
        </WorkbenchLink>
      );
    } else {
      return (
        <div {...commonProps} ref={ref}>
          {children}
        </div>
      );
    }
  },
);

CollectionListItemWrapper.displayName = "CollectionListItemWrapper";
