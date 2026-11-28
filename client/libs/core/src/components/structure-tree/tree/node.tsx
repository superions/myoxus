// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Guard } from "@myoxus/core/components/guard";
import { ExplorerIconService } from "@myoxus/core/modules/explorer-icon/services/explorer-icon";
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
  IconRenderer,
  Menu,
  MenuItem,
  STRUCTURE_TREE_INDENT_PER_LEVEL,
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
  StructureTreeRow,
  useDraggable,
  useDropTarget,
} from "@myoxus/ui-facade";
import {
  type ComponentType,
  Fragment,
  type PropsWithChildren,
  type ReactNode,
  type RefAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { To } from "react-router";

import { StructureTreeContext } from "./context";
import { DropEffect } from "./drop-effect";
import {
  type ExplorerIconConfig,
  StructureTreeNodeRenameModal,
} from "./rename-modal";
import type { NodeOperation } from "./types";

export { StructureTreeNodeRenameModal };

export type StructureTreeNodeDropEffectData = {
  source: { data: MyoxusDNDData["draggable"] };
  treeInstruction: DropTargetTreeInstruction | null;
};

export type StructureTreeNodeDropEffect = (
  data: StructureTreeNodeDropEffectData,
) => "copy" | "move" | "link" | undefined;

export type StructureTreeNodeIcon = ComponentType<{
  className?: string;
  draggedOver?: boolean;
  treeInstruction?: DropTargetTreeInstruction | null;
  collapsed?: boolean;
}>;

export interface BaseStructureTreeNodeProps {
  name?: string;
  icon?: StructureTreeNodeIcon;
  children?: ReactNode;
  active?: boolean;
  extractEmojiAsIcon?: boolean;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  collapsible?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  to?: To;
  postfix?: ReactNode;
  operations?: NodeOperation[];
  childrenOperations?: NodeOperation[];
  childrenPlaceholder?: ReactNode;
  linkComponent?: ComponentType<
    PropsWithChildren<{ to: To; className?: string }> &
      RefAttributes<any> & { draggable?: boolean }
  >;
  [key: `data-${string}`]: any;
}

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
  const t = useI18n();
  const explorerIconService = useService(ExplorerIconService);
  const instanceId = useId();
  const parentContext = useContext(StructureTreeContext);
  const level = parentContext?.level ?? 0;
  const clickTogglesCollapse = !onClick && !to && !disabled;

  const [childCount, setChildCount] = useState(0);
  const [renaming, setRenaming] = useState(Boolean(defaultRenaming));
  const [menuOpen, setMenuOpen] = useState(false);
  const [lastInGroup, setLastInGroup] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const { dragRef, dragging, CustomDragPreview } = useDraggable<
    MyoxusDNDData & { draggable: { __cid: string } }
  >(
    () => ({
      data: { ...dndData?.draggable, __cid: instanceId },
      dragPreviewPosition: "pointer-outside",
    }),
    [dndData, instanceId],
  );

  const evaluateCanDrop = useMemo<DropTargetOptions<MyoxusDNDData>["canDrop"]>(
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
      onDrop: (event) => {
        if (
          event.source.data.__cid === instanceId &&
          event.treeInstruction?.type !== "reparent"
        ) {
          return;
        }
        onDrop?.(event);
        if (event.treeInstruction?.type === "make-child" && collapsible) {
          setCollapsed(false);
        }
      },
      canDrop: evaluateCanDrop,
      allowExternal: true,
    }),
    [
      collapsed,
      collapsible,
      dndData?.dropTarget,
      evaluateCanDrop,
      instanceId,
      lastInGroup,
      level,
      onDrop,
      reorderable,
      setCollapsed,
    ],
  );

  const isSelfHover = draggedOverDraggable?.data.__cid === instanceId;

  useEffect(() => parentContext?.registerChild(), [parentContext]);

  useEffect(() => {
    if (
      !collapsible ||
      !draggedOver ||
      isSelfHover ||
      treeInstruction?.type !== "make-child"
    ) {
      return;
    }
    const timer = setTimeout(() => setCollapsed(false), 1000);
    return () => clearTimeout(timer);
  }, [
    collapsible,
    draggedOver,
    isSelfHover,
    setCollapsed,
    treeInstruction?.type,
  ]);

  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;

    const syncLastInGroup = () => {
      setLastInGroup(parent.lastElementChild === rootRef.current);
    };
    syncLastInGroup();
    const observer = new MutationObserver(syncLastInGroup);
    observer.observe(parent, { childList: true });
    return () => observer.disconnect();
  }, []);

  const builtInOperations = useMemo<NodeOperation[]>(() => {
    if (!renameable) return [];
    return [
      {
        index: 0,
        view: renameableGuard ? (
          <Guard
            permission={renameableGuard.action}
            docId={renameableGuard.docId}
          >
            {(allowed) => (
              <MenuItem
                key="structure-tree-rename"
                type="default"
                prefixIcon={<EditIcon />}
                onClick={() => setRenaming(true)}
                disabled={!allowed}
              >
                {t["com.myoxus.menu.rename"]()}
              </MenuItem>
            )}
          </Guard>
        ) : (
          <MenuItem
            key="structure-tree-rename"
            type="default"
            prefixIcon={<EditIcon />}
            onClick={() => setRenaming(true)}
          >
            {t["com.myoxus.menu.rename"]()}
          </MenuItem>
        ),
      },
    ];
  }, [renameable, renameableGuard, t]);

  const { menuOperations, inlineOperations } = useMemo(() => {
    const sorted = [...builtInOperations, ...operations].sort(
      (a, b) => a.index - b.index,
    );
    return {
      menuOperations: sorted.filter((op) => !op.inline),
      inlineOperations: sorted.filter((op) => Boolean(op.inline)),
    };
  }, [builtInOperations, operations]);

  const childContext = useMemo(
    () => ({
      operations: childrenOperations,
      level: level + 1,
      registerChild: () => {
        setChildCount((count) => count + 1);
        return () => setChildCount((count) => count - 1);
      },
    }),
    [childrenOperations, level],
  );

  const handleRename = useCallback(
    (nextName: string) => {
      onRename?.(nextName);
    },
    [onRename],
  );

  const handleRowClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.defaultPrevented) return;
      if (!clickTogglesCollapse) {
        onClick?.();
      } else if (collapsible) {
        setCollapsed(!collapsed);
      }
    },
    [clickTogglesCollapse, collapsed, collapsible, onClick, setCollapsed],
  );

  const handleCollapseToggle = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      setCollapsed(!collapsed);
    },
    [collapsed, setCollapsed],
  );

  const handleRowKeyDown = useCallback(
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

  const isKeyboardInteractive = Boolean(
    onClick || (clickTogglesCollapse && collapsible),
  );

  const fallbackIcon = Icon ? (
    <Icon
      draggedOver={draggedOver && !isSelfHover}
      treeInstruction={treeInstruction}
      collapsed={collapsed}
    />
  ) : null;

  const disclosureButton =
    !clickTogglesCollapse && collapsible ? (
      <StructureTreeCollapseButton
        aria-label={collapsed ? "Expand" : "Collapse"}
        collapsed={collapsed}
        collapsible
        data-testid="structure-tree-collapsed-button"
        disabled={disabled}
        onClick={handleCollapseToggle}
      />
    ) : null;

  const actionsSlot =
    inlineOperations.length > 0 || menuOperations.length > 0 ? (
      <StructureTreeActions onClick={(event) => event.preventDefault()}>
        {inlineOperations.map(({ view, index }) => (
          <Fragment key={index}>{view}</Fragment>
        ))}
        {menuOperations.length > 0 ? (
          <Menu
            rootOptions={{ open: menuOpen, onOpenChange: setMenuOpen }}
            items={menuOperations.map(({ view, index }) => (
              <Fragment key={index}>{view}</Fragment>
            ))}
          >
            <StructureTreeActionButton data-testid="structure-tree-node-operation-button">
              <MoreHorizontalIcon />
            </StructureTreeActionButton>
          </Menu>
        ) : null}
      </StructureTreeActions>
    ) : undefined;

  const row = (
    <StructureTreeRow
      onClick={handleRowClick}
      active={active}
      aria-expanded={
        clickTogglesCollapse && collapsible ? !collapsed : undefined
      }
      disabled={disabled}
      collapsible={collapsible}
      dragging={dragging}
      onKeyDown={isKeyboardInteractive ? handleRowKeyDown : undefined}
      role={isKeyboardInteractive ? "treeitem" : undefined}
      tabIndex={isKeyboardInteractive ? 0 : undefined}
      label={
        <StructureTreeMain>
          <StructureTreeLabel>{rawName}</StructureTreeLabel>
          {postfix}
          {renameable && renaming ? (
            <StructureTreeNodeRenameModal
              setRenaming={setRenaming}
              handleRename={handleRename}
              rawName={rawName}
              explorerIconConfig={explorerIconConfig}
              fallbackIcon={fallbackIcon}
            />
          ) : null}
        </StructureTreeMain>
      }
      leftSection={
        <StructureTreeLeading
          alignDisclosure={level > 0}
          disclosure={disclosureButton}
        >
          <StructureTreeIconSlot>
            <IconRenderer data={explorerIcon?.icon} fallback={fallbackIcon} />
          </StructureTreeIconSlot>
        </StructureTreeLeading>
      }
      rightSection={actionsSlot}
      rightSectionAlwaysVisible={
        menuOpen || inlineOperations.some((op) => op.alwaysVisible)
      }
    />
  );

  const showDropIndicator =
    Boolean(treeInstruction) &&
    !(treeInstruction?.type !== "reparent" && isSelfHover) &&
    treeInstruction?.type !== "instruction-blocked";

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
          selfDraggedOver={isSelfHover}
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
              {row}
            </StructureTreeLink>
          ) : (
            <div ref={dragRef}>{row}</div>
          )}

          <CustomDragPreview>
            <StructureTreeDragPreview>{row}</StructureTreeDragPreview>
          </CustomDragPreview>

          {showDropIndicator && treeInstruction ? (
            <DropIndicator instruction={treeInstruction} />
          ) : null}

          {draggedOver &&
          dropEffect &&
          draggedOverPosition &&
          !isSelfHover &&
          draggedOverDraggable ? (
            <DropEffect
              dropEffect={dropEffect({
                source: draggedOverDraggable,
                treeInstruction,
              })}
              position={draggedOverPosition}
            />
          ) : null}
        </StructureTreeContent>
      </ContextMenu>

      <StructureTreeChildren hidden={dragging}>
        {childCount === 0 && !collapsed ? childrenPlaceholder : null}
        <StructureTreeContext.Provider value={childContext}>
          {collapsed ? null : children}
        </StructureTreeContext.Provider>
      </StructureTreeChildren>
    </StructureTreeNodeRoot>
  );
};
