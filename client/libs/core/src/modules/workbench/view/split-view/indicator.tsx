import { useI18n } from "@myoxus/i18n";
import {
  Menu,
  type MenuProps,
  SplitViewDragHandleChrome,
  SplitViewIndicatorFrame,
  SplitViewIndicatorMenuAnchor,
  Tooltip,
} from "@myoxus/ui-facade";
import {
  forwardRef,
  type HTMLAttributes,
  memo,
  useCallback,
  useMemo,
  useState,
} from "react";

import type { View } from "../../entities/view";

export interface SplitViewDragHandleProps extends HTMLAttributes<HTMLDivElement> {
  active?: boolean;
  dragging?: boolean;
  open?: boolean;
  onOpenMenu?: () => void;
}

export const SplitViewDragHandle = memo(
  forwardRef<HTMLDivElement, SplitViewDragHandleProps>(
    function SplitViewDragHandle(
      { className, active, open, onOpenMenu, dragging, onClick, ...attrs },
      ref,
    ) {
      return (
        <SplitViewDragHandleChrome
          ref={ref}
          active={active}
          className={className}
          dragging={dragging}
          onClick={onClick}
          onOpenMenu={onOpenMenu}
          open={open}
          {...attrs}
        />
      );
    },
  ),
);

interface SplitViewIndicatorProps extends HTMLAttributes<HTMLDivElement> {
  view: View;
  isActive?: boolean;
  isDragging?: boolean;
  menuItems?: React.ReactNode;
  setPressed?: (pressed: boolean) => void;
  dragHandleRef?: React.RefObject<HTMLDivElement>;
}
export const SplitViewIndicator = memo(
  forwardRef<HTMLDivElement, SplitViewIndicatorProps>(
    function SplitViewIndicator(
      { isActive, menuItems, isDragging, dragHandleRef },
      ref,
    ) {
      const [menuOpen, setMenuOpen] = useState(false);

      // prevent menu from opening when dragging
      const setOpenMenuManually = useCallback((open: boolean) => {
        if (open) return;
        setMenuOpen(open);
      }, []);

      const openMenu = useCallback(() => {
        setMenuOpen(true);
      }, []);

      const menuRootOptions = useMemo(
        () =>
          ({
            open: menuOpen,
            onOpenChange: setOpenMenuManually,
          }) satisfies MenuProps["rootOptions"],
        [menuOpen, setOpenMenuManually],
      );
      const menuContentOptions = useMemo(
        () =>
          ({
            align: "center",
          }) satisfies MenuProps["contentOptions"],
        [],
      );

      const t = useI18n();
      return (
        <SplitViewIndicatorFrame ref={ref} data-is-dragging={isDragging}>
          <Menu
            contentOptions={menuContentOptions}
            items={menuItems}
            rootOptions={menuRootOptions}
          >
            <SplitViewIndicatorMenuAnchor />
          </Menu>
          <Tooltip
            content={t["com.myoxus.split-view-drag-handle.tooltip"]()}
            side="bottom"
          >
            <SplitViewDragHandle
              ref={dragHandleRef}
              open={menuOpen}
              onOpenMenu={openMenu}
              active={isActive}
              dragging={isDragging}
            />
          </Tooltip>
        </SplitViewIndicatorFrame>
      );
    },
  ),
);
