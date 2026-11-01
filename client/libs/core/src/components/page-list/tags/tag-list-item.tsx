import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { stopPropagation } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import { ArchiveIcon } from "@myoxus/icons/react";
import {
  Badge,
  Checkbox,
  ColorSwatch,
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
import type { TagListItemProps } from "../types";

const preventLinkRowAction = (event: ReactMouseEvent<HTMLElement>) => {
  event.preventDefault();
  event.stopPropagation();
};

const TagListTitleCell = ({
  archived,
  title,
}: Pick<TagListItemProps, "archived" | "title">) => {
  const t = useI18n();
  return (
    <SurfaceListItemMain compact data-testid="tag-list-item-title">
      <SurfaceListText data-testid="tag-list-item-title-text" kind="title">
        {title || t["Untitled"]()}
      </SurfaceListText>
      {archived ? (
        <Badge prefix={<ArchiveIcon />}>
          {t["com.myoxus.tags.status.archived"]()}
        </Badge>
      ) : null}
      {/* // TODO(@EYHN): when indexer is ready, add this back
      <SurfaceListText
        data-testid="page-list-item-preview-text"
        kind="preview"
      >
        {` · ${t['com.myoxus.tags.count']({ count: pageCount || 0 })}`}
      </SurfaceListText> */}
    </SurfaceListItemMain>
  );
};

const ListIconCell = ({ color }: Pick<TagListItemProps, "color">) => {
  return (
    <SurfaceListItemIcon data-testid="tag-list-item-icon">
      <ColorSwatch aria-label="Tag color" tagColorRole={color} shape="circle" />
    </SurfaceListItemIcon>
  );
};

const TagSelectionCell = ({
  selectable,
  onSelectedChange,
  selected,
}: Pick<TagListItemProps, "selectable" | "onSelectedChange" | "selected">) => {
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

const TagListOperationsCell = ({
  operations,
}: Pick<TagListItemProps, "operations">) => {
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

export const TagListItem = memo(function TagListItem(props: TagListItemProps) {
  const { dragRef, CustomDragPreview, dragging } = useDraggable<MyoxusDNDData>(
    () => ({
      canDrag: props.draggable,
      data: {
        entity: {
          type: "tag",
          id: props.tagId,
        },
        from: {
          at: "tag-selector:list",
        },
      },
    }),
    [props.draggable, props.tagId],
  );

  return (
    <>
      <TagListItemWrapper
        onClick={props.onClick}
        to={props.to}
        tagId={props.tagId}
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
          <TagSelectionCell
            onSelectedChange={props.onSelectedChange}
            selectable={props.selectable}
            selected={props.selected}
          />
          <ListIconCell color={props.color} />
          <TagListTitleCell archived={props.archived} title={props.title} />
          <SurfaceListSpacer />
          {props.operations ? (
            <TagListOperationsCell operations={props.operations} />
          ) : null}
        </SurfaceListItem>
      </TagListItemWrapper>
      <CustomDragPreview position="pointer-outside">
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
            <TagSelectionCell
              onSelectedChange={props.onSelectedChange}
              selectable={props.selectable}
              selected={props.selected}
            />
            <ListIconCell color={props.color} />
          </SurfaceListMeta>
          <TagListTitleCell archived={props.archived} title={props.title} />
        </SurfaceListItem>
      </CustomDragPreview>
    </>
  );
});

type TagListWrapperProps = PropsWithChildren<
  Pick<TagListItemProps, "to" | "tagId" | "onClick" | "draggable"> & {
    isDragging: boolean;
  }
>;

const TagListItemWrapper = forwardRef(
  (
    {
      to,
      isDragging,
      tagId,
      onClick,
      children,
      draggable,
    }: TagListWrapperProps,
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
        "data-testid": "tag-list-item",
        "data-tag-id": tagId,
        "data-draggable": draggable,
        "data-myoxus-ui-role": "surface-list-row-link",
        "data-clickable": !!onClick || !!to,
        "data-dragging": isDragging,
        onClick: handleClick,
      }),
      [tagId, draggable, isDragging, onClick, to, handleClick],
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
TagListItemWrapper.displayName = "TagListItemWrapper";
