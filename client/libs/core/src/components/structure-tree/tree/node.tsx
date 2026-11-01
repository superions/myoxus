/**
 * `StructureTreeNode` — the fundamental building block of the
 * structure tree.
 *
 * Each node can:
 * - Render an optional icon (custom component or auto-extracted emoji).
 * - Be collapsible, showing child nodes indented below it.
 * - Navigate to a route (`to` prop) or invoke a callback (`onClick`).
 * - Display inline operation buttons and a `...` context-menu populated by
 *   `NodeOperation` entries.
 * - Be renamed in-place via `StructureTreeNodeRenameModal` (which is
 *   extracted into a separate component to avoid re-rendering the whole tree
 *   when the sidebar width changes).
 * - Participate in drag-and-drop: draggable with `dndData` / droppable with
 *   `onDrop` + `canDrop` / visual `DropEffect` overlay showing tree
 *   instruction (insert-above, insert-below, make-child).
 *
 * ### Context
 * The node reads `StructureTreeContext` to discover its nesting `level`
 * and provides a new context (level + 1) to its children.
 *
 * ### Permission guard
 * When `renameableGuard` is supplied the rename action is wrapped in a
 * `<Guard action={...}>` component that hides the rename trigger when the
 * current user lacks the required document permission.
 *
 * ### Types exported from this file
 * - `BaseStructureTreeNodeProps` — props shared by both the base node
 *   and its web-only extension (`WebStructureTreeNodeProps`).
 * - `StructureTreeNodeIcon` — render-prop type for the icon slot.
 * - `StructureTreeNodeDropEffect` / `StructureTreeNodeDropEffectData`
 *   — callback types for computing the visual drop cursor during DnD.
 */
import { Guard } from "@myoxus/core/components/guard";
import { AppSidebarService } from "@myoxus/core/modules/app-sidebar";
import { ExplorerIconService } from "@myoxus/core/modules/explorer-icon/services/explorer-icon";
import type { ExplorerType } from "@myoxus/core/modules/explorer-icon/store/explorer-icon";
import type { DocPermissionActions } from "@myoxus/core/modules/permissions";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { EditIcon, MoreHorizontalIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  ContextMenu,
  DropIndicator,
  type DropTargetDropEvent,
  type DropTargetOptions,
  type DropTargetTreeInstruction,
  IconAndNameEditorMenu,
  type IconData,
  IconRenderer,
  Menu,
  MenuItem,
  STRUCTURE_TREE_INDENT_PER_LEVEL,
  STRUCTURE_TREE_RENAME_MENU_CONTENT_OPTIONS,
  StructureTreeActionButton,
  StructureTreeActions,
  StructureTreeChildren,
  StructureTreeCollapseButton,
  StructureTreeContent,
  StructureTreeDragPreview,
  StructureTreeIconSlot,
  StructureTreeLabel,
  StructureTreeLeading,
  StructureTreeLink,
  StructureTreeMain,
  StructureTreeNodeRoot,
  StructureTreeRenameAnchor,
  structureTreeRenameMenuWidth,
  StructureTreeRow,
  useDraggable,
  useDropTarget,
} from "@myoxus/ui-facade";
import type { To } from "react-router";
import {
  Fragment,
  type RefAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { StructureTreeContext } from "./context";
import { DropEffect } from "./drop-effect";
import type { NodeOperation } from "./types";

export type StructureTreeNodeDropEffectData = {
  source: { data: MyoxusDNDData["draggable"] };
  treeInstruction: DropTargetTreeInstruction | null;
};
export type StructureTreeNodeDropEffect = (
  data: StructureTreeNodeDropEffectData,
) => "copy" | "move" | "link" | undefined;
export type StructureTreeNodeIcon = React.ComponentType<{
  className?: string;
  draggedOver?: boolean;
  treeInstruction?: DropTargetTreeInstruction | null;
  collapsed?: boolean;
}>;

export interface BaseStructureTreeNodeProps {
  name?: string;
  icon?: StructureTreeNodeIcon;
  children?: React.ReactNode;
  active?: boolean;
  extractEmojiAsIcon?: boolean;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  collapsible?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  to?: To;
  postfix?: React.ReactNode;
  operations?: NodeOperation[];
  childrenOperations?: NodeOperation[];
  childrenPlaceholder?: React.ReactNode;

  linkComponent?: React.ComponentType<
    React.PropsWithChildren<{ to: To; className?: string }> &
      RefAttributes<any> & { draggable?: boolean }
  >;
  [key: `data-${string}`]: any;
}

type ExplorerIconConfig = {
  where: ExplorerType;
  id: string;
};
interface WebStructureTreeNodeProps extends BaseStructureTreeNodeProps {
  renameable?: boolean;
  onRename?: (newName: string) => void;
  renameableGuard?: { docId: string; action: DocPermissionActions };
  defaultRenaming?: boolean;

  explorerIconConfig?: ExplorerIconConfig | null;

  canDrop?: DropTargetOptions<MyoxusDNDData>["canDrop"];
  reorderable?: boolean;
  dndData?: MyoxusDNDData;
  onDrop?: (data: DropTargetDropEvent<MyoxusDNDData>) => void;
  dropEffect?: StructureTreeNodeDropEffect;
}

/**
 * specific rename modal for a structure tree node,
 * Separate it into a separate component to prevent re-rendering the entire component when width changes.
 */
export const StructureTreeNodeRenameModal = ({
  setRenaming,
  handleRename,
  rawName,
  explorerIconConfig,
  className,
  fallbackIcon,
}: {
  setRenaming: (renaming: boolean) => void;
  handleRename: (newName: string) => void;
  rawName: string | undefined;
  className?: string;
  explorerIconConfig?: ExplorerIconConfig | null;
  fallbackIcon?: React.ReactNode;
}) => {
  const explorerIconService = useService(ExplorerIconService);
  const appSidebarService = useService(AppSidebarService).sidebar;
  const sidebarWidth = useLiveData(appSidebarService.width$);

  const explorerIcon = useLiveData(
    useMemo(
      () =>
        explorerIconConfig
          ? explorerIconService.icon$(
              explorerIconConfig.where,
              explorerIconConfig.id,
            )
          : null,
      [explorerIconConfig, explorerIconService],
    ),
  );

  const onIconChange = useCallback(
    (data?: IconData) => {
      if (!explorerIconConfig) return;
      explorerIconService.setIcon({
        where: explorerIconConfig.where,
        id: explorerIconConfig.id,
        icon: data,
      });
    },
    [explorerIconConfig, explorerIconService],
  );

  return (
    <IconAndNameEditorMenu
      open
      onOpenChange={setRenaming}
      onIconChange={onIconChange}
      onNameChange={handleRename}
      name={rawName ?? ""}
      icon={explorerIcon?.icon}
      width={structureTreeRenameMenuWidth(sidebarWidth)}
      contentOptions={STRUCTURE_TREE_RENAME_MENU_CONTENT_OPTIONS}
      iconPlaceholder={fallbackIcon}
      inputTestId="rename-modal-input"
    >
      <StructureTreeRenameAnchor className={className} />
    </IconAndNameEditorMenu>
  );
};

export const StructureTreeNode = ({
  children,
  icon: Icon,
  name: rawName,
  onClick,
  to,
  active,
  defaultRenaming,
  renameable,
  renameableGuard,
  onRename,
  disabled,
  extractEmojiAsIcon: _extractEmojiAsIcon,
  collapsed,
  setCollapsed,
  collapsible = true,
  canDrop,
  reorderable = true,
  operations = [],
  postfix,
  childrenOperations = [],
  childrenPlaceholder,
  linkComponent: LinkComponent = WorkbenchLink,
  dndData,
  explorerIconConfig,
  onDrop,
  dropEffect,
  ...otherProps
}: WebStructureTreeNodeProps) => {
  const explorerIconService = useService(ExplorerIconService);
  const t = useI18n();
  const cid = useId();
  const context = useContext(StructureTreeContext);
  const level = context?.level ?? 0;
  // If no onClick or to is provided, clicking on the node will toggle the collapse state
  const clickForCollapse = !onClick && !to && !disabled;
  const [childCount, setChildCount] = useState(0);
  const [renaming, setRenaming] = useState(defaultRenaming);
  const [lastInGroup, setLastInGroup] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const explorerIcon = useLiveData(
    useMemo(
      () =>
        explorerIconConfig
          ? explorerIconService.icon$(
              explorerIconConfig?.where,
              explorerIconConfig?.id,
            )
          : null,
      [explorerIconConfig, explorerIconService],
    ),
  );

  const { dragRef, dragging, CustomDragPreview } = useDraggable<
    MyoxusDNDData & { draggable: { __cid: string } }
  >(
    () => ({
      data: { ...dndData?.draggable, __cid: cid },
      dragPreviewPosition: "pointer-outside",
    }),
    [cid, dndData],
  );
  const handleCanDrop = useMemo<DropTargetOptions<MyoxusDNDData>["canDrop"]>(
    () => (args) => {
      if (!reorderable && args.treeInstruction?.type !== "make-child") {
        return false;
      }
      return (typeof canDrop === "function" ? canDrop(args) : canDrop) ?? true;
    },
    [canDrop, reorderable],
  );

  const {
    dropTargetRef,
    treeInstruction,
    draggedOverDraggable,
    draggedOver,
    draggedOverPosition,
  } = useDropTarget<MyoxusDNDData & { draggable: { __cid: string } }>(
    () => ({
      data: dndData?.dropTarget,
      treeInstruction: {
        currentLevel: level,
        indentPerLevel: STRUCTURE_TREE_INDENT_PER_LEVEL,
        mode: !collapsed
          ? "expanded"
          : lastInGroup
            ? "last-in-group"
            : "standard",
        block:
          reorderable === false
            ? ["reorder-above", "reorder-below", "reparent"]
            : [],
      },
      onDrop: (data) => {
        if (
          data.source.data.__cid === cid &&
          data.treeInstruction?.type !== "reparent"
        ) {
          // Do nothing if dropped on self
          return;
        }
        onDrop?.(data);
        if (data.treeInstruction?.type === "make-child" && collapsible) {
          setCollapsed(false);
        }
      },
      canDrop: handleCanDrop,
      allowExternal: true,
    }),
    [
      dndData?.dropTarget,
      level,
      collapsed,
      lastInGroup,
      reorderable,
      handleCanDrop,
      cid,
      onDrop,
      collapsible,
      setCollapsed,
    ],
  );
  const isSelfDraggedOver = draggedOverDraggable?.data.__cid === cid;

  useEffect(() => context?.registerChild(), [context]);

  useEffect(() => {
    if (
      draggedOver &&
      treeInstruction?.type === "make-child" &&
      !isSelfDraggedOver
    ) {
      if (!collapsible) return;
      // auto expand when dragged over
      const timeout = setTimeout(() => {
        setCollapsed(false);
      }, 1000);
      return () => clearTimeout(timeout);
    }
    return;
  }, [
    collapsible,
    draggedOver,
    isSelfDraggedOver,
    setCollapsed,
    treeInstruction?.type,
  ]);

  useEffect(() => {
    if (rootRef.current) {
      const parent = rootRef.current.parentElement;
      if (parent) {
        const updateLastInGroup = () => {
          setLastInGroup(parent?.lastElementChild === rootRef.current);
        };
        updateLastInGroup();
        const observer = new MutationObserver(updateLastInGroup);
        observer.observe(parent, {
          childList: true,
        });
        return () => observer.disconnect();
      }
    }
    return;
  }, []);

  const presetOperations = useMemo(
    () =>
      (
        [
          renameable
            ? {
                index: 0,
                view: renameableGuard ? (
                  <Guard
                    permission={renameableGuard.action}
                    docId={renameableGuard.docId}
                  >
                    {(can) => (
                      <MenuItem
                        key={"structure-tree-rename"}
                        type={"default"}
                        prefixIcon={<EditIcon />}
                        onClick={() => setRenaming(true)}
                        disabled={!can}
                      >
                        {t["com.myoxus.menu.rename"]()}
                      </MenuItem>
                    )}
                  </Guard>
                ) : (
                  <MenuItem
                    key={"structure-tree-rename"}
                    type={"default"}
                    prefixIcon={<EditIcon />}
                    onClick={() => setRenaming(true)}
                  >
                    {t["com.myoxus.menu.rename"]()}
                  </MenuItem>
                ),
              }
            : null,
        ] as (NodeOperation | null)[]
      ).filter((t): t is NodeOperation => t !== null),
    [renameable, renameableGuard, t],
  );

  const { menuOperations, inlineOperations } = useMemo(() => {
    const sorted = [...presetOperations, ...operations].sort(
      (a, b) => a.index - b.index,
    );
    return {
      menuOperations: sorted.filter(({ inline }) => !inline),
      inlineOperations: sorted.filter(({ inline }) => !!inline),
    };
  }, [presetOperations, operations]);

  const contextValue = useMemo(() => {
    return {
      operations: childrenOperations,
      level: (context?.level ?? 0) + 1,
      registerChild: () => {
        setChildCount((c) => c + 1);
        return () => setChildCount((c) => c - 1);
      },
    };
  }, [childrenOperations, context?.level]);

  const handleRename = useCallback(
    (newName: string) => {
      onRename?.(newName);
    },
    [onRename],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.defaultPrevented) {
        return;
      }
      if (!clickForCollapse) {
        onClick?.();
      } else if (collapsible) {
        setCollapsed(!collapsed);
      }
    },
    [clickForCollapse, collapsed, collapsible, onClick, setCollapsed],
  );

  const handleCollapsedChange = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      setCollapsed(!collapsed);
    },
    [collapsed, setCollapsed],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (
        event.target !== event.currentTarget ||
        (event.key !== "Enter" && event.key !== " ")
      ) {
        return;
      }
      event.preventDefault();
      if (onClick) {
        onClick();
      } else if (collapsible) {
        setCollapsed(!collapsed);
      }
    },
    [collapsed, collapsible, onClick, setCollapsed],
  );
  const keyboardInteractive = Boolean(
    onClick || (clickForCollapse && collapsible),
  );

  const fallbackIcon = Icon && (
    <Icon
      draggedOver={draggedOver && !isSelfDraggedOver}
      treeInstruction={treeInstruction}
      collapsed={collapsed}
    />
  );

  const collapseControl =
    !clickForCollapse && collapsible ? (
      <StructureTreeCollapseButton
        aria-label={collapsed === false ? "Collapse" : "Expand"}
        collapsed={collapsed}
        collapsible
        data-testid="structure-tree-collapsed-button"
        disabled={disabled}
        onClick={handleCollapsedChange}
      />
    ) : null;

  const rowLabel = (
    <StructureTreeMain>
      <StructureTreeLabel>{rawName}</StructureTreeLabel>
      {postfix}
      {renameable && renaming && (
        <StructureTreeNodeRenameModal
          setRenaming={setRenaming}
          handleRename={handleRename}
          rawName={rawName}
          explorerIconConfig={explorerIconConfig}
          fallbackIcon={fallbackIcon}
        />
      )}
    </StructureTreeMain>
  );

  const rowActions =
    inlineOperations.length > 0 || menuOperations.length > 0 ? (
      <StructureTreeActions
        onClick={(e) => {
          // prevent jump to page
          e.preventDefault();
        }}
      >
        {inlineOperations.map(({ view, index }) => (
          <Fragment key={index}>{view}</Fragment>
        ))}
        {menuOperations.length > 0 && (
          <Menu
            items={menuOperations.map(({ view, index }) => (
              <Fragment key={index}>{view}</Fragment>
            ))}
          >
            <StructureTreeActionButton data-testid="structure-tree-node-operation-button">
              <MoreHorizontalIcon />
            </StructureTreeActionButton>
          </Menu>
        )}
      </StructureTreeActions>
    ) : undefined;

  const content = (
    <StructureTreeRow
      onClick={handleClick}
      active={active}
      aria-expanded={clickForCollapse && collapsible ? !collapsed : undefined}
      disabled={disabled}
      collapsible={collapsible}
      dragging={dragging}
      onKeyDown={keyboardInteractive ? handleKeyDown : undefined}
      role={keyboardInteractive ? "treeitem" : undefined}
      tabIndex={keyboardInteractive ? 0 : undefined}
      label={rowLabel}
      leftSection={
        <StructureTreeLeading>
          {collapseControl}
          <StructureTreeIconSlot>
            <IconRenderer data={explorerIcon?.icon} fallback={fallbackIcon} />
          </StructureTreeIconSlot>
        </StructureTreeLeading>
      }
      rightSection={rowActions}
      rightSectionAlwaysVisible={inlineOperations.some(
        ({ alwaysVisible }) => alwaysVisible,
      )}
    />
  );

  return (
    <StructureTreeNodeRoot
      open={!collapsed}
      level={level}
      ref={rootRef}
      {...otherProps}
    >
      <ContextMenu
        asChild
        items={menuOperations.map(({ view, index }) => (
          <Fragment key={index}>{view}</Fragment>
        ))}
      >
        <StructureTreeContent
          open={!collapsed}
          selfDraggedOver={isSelfDraggedOver}
          treeInstruction={treeInstruction}
          ref={dropTargetRef}
        >
          {to ? (
            <StructureTreeLink
              component={LinkComponent}
              to={to}
              ref={dragRef}
              draggable={false}
            >
              {content}
            </StructureTreeLink>
          ) : (
            <div ref={dragRef}>{content}</div>
          )}
          <CustomDragPreview>
            <StructureTreeDragPreview>{content}</StructureTreeDragPreview>
          </CustomDragPreview>
          {treeInstruction &&
            // Do not show drop indicator for self dragged over
            !(treeInstruction.type !== "reparent" && isSelfDraggedOver) &&
            treeInstruction.type !== "instruction-blocked" && (
              <DropIndicator instruction={treeInstruction} />
            )}
          {draggedOver &&
            dropEffect &&
            draggedOverPosition &&
            !isSelfDraggedOver &&
            draggedOverDraggable && (
              <DropEffect
                dropEffect={dropEffect({
                  source: draggedOverDraggable,
                  treeInstruction: treeInstruction,
                })}
                position={draggedOverPosition}
              />
            )}
        </StructureTreeContent>
      </ContextMenu>
      <StructureTreeChildren hidden={dragging}>
        {childCount === 0 && !collapsed ? childrenPlaceholder : null}
        <StructureTreeContext.Provider value={contextValue}>
          {collapsed ? null : children}
        </StructureTreeContext.Provider>
      </StructureTreeChildren>
    </StructureTreeNodeRoot>
  );
};
