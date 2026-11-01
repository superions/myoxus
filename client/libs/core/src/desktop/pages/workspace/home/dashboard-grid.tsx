// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  WorkspaceDashboardDashletId,
  WorkspaceDashboardDashletSize,
} from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import {
  Box,
  Button,
  type DNDData,
  DragHandle,
  DropIndicator,
  Grid,
  Group,
  Menu,
  MenuItem,
  useDraggable,
  useDropTarget,
  VisuallyHidden,
} from "@myoxus/ui-facade";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { DashboardEditChromeProvider } from "./dashboard-edit-context";
import {
  DASHBOARD_COMPACT_DASHLET_IDS,
  type ResolvedWorkspaceDashboardLayout,
} from "./dashboard-layout";

interface DashboardDndData extends DNDData<
  {
    type: "workspace-dashboard-dashlet";
    dashletId: WorkspaceDashboardDashletId;
  },
  { type: "workspace-dashboard-target"; dashletId: WorkspaceDashboardDashletId }
> {}

export function DashboardGrid({
  childrenById,
  editMode,
  focusFirstDashletRevision,
  labels,
  layout,
  onCommit,
  onMove,
  onResize,
}: {
  childrenById: Readonly<Record<WorkspaceDashboardDashletId, ReactNode>>;
  editMode: boolean;
  focusFirstDashletRevision: number;
  labels: Readonly<Record<WorkspaceDashboardDashletId, string>>;
  layout: ResolvedWorkspaceDashboardLayout;
  onCommit: () => void;
  onMove: (
    dashletId: WorkspaceDashboardDashletId,
    targetIndex: number,
    persist: boolean,
  ) => void;
  onResize: (
    dashletId: WorkspaceDashboardDashletId,
    size: WorkspaceDashboardDashletSize,
  ) => void;
}) {
  return (
    <Grid columns={12} grow data-myoxus-ui-role="workspace-home-grid">
      {layout.orderedDashletIds.map((dashletId, index) => (
        <DashboardGridItem
          dashletId={dashletId}
          editMode={editMode}
          focusRequested={
            index === 0 && focusFirstDashletRevision > 0
              ? focusFirstDashletRevision
              : 0
          }
          index={index}
          key={dashletId}
          label={labels[dashletId]}
          layout={layout}
          onCommit={onCommit}
          onMove={onMove}
          onResize={onResize}
        >
          {childrenById[dashletId]}
        </DashboardGridItem>
      ))}
    </Grid>
  );
}

function DashboardGridItem({
  children,
  dashletId,
  editMode,
  focusRequested,
  index,
  label,
  layout,
  onCommit,
  onMove,
  onResize,
}: {
  children: ReactNode;
  dashletId: WorkspaceDashboardDashletId;
  editMode: boolean;
  focusRequested: number;
  index: number;
  label: string;
  layout: ResolvedWorkspaceDashboardLayout;
  onCommit: () => void;
  onMove: (
    dashletId: WorkspaceDashboardDashletId,
    targetIndex: number,
    persist: boolean,
  ) => void;
  onResize: (
    dashletId: WorkspaceDashboardDashletId,
    size: WorkspaceDashboardDashletSize,
  ) => void;
}) {
  const t = useI18n();
  const [keyboardDragging, setKeyboardDragging] = useState(false);
  const [keyboardOrigin, setKeyboardOrigin] = useState(index);
  const [desktopReorderMenuOpen, setDesktopReorderMenuOpen] = useState(false);
  const [compactReorderMenuOpen, setCompactReorderMenuOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const focusRef = useRef<HTMLDivElement | null>(null);
  const size = layout.dashletSizes[dashletId];
  const span = size === "wide" ? 12 : size === "compact" ? 4 : 6;
  const { dragRef, dragHandleRef, dragging } = useDraggable<DashboardDndData>(
    () => ({
      canDrag: editMode,
      data: { type: "workspace-dashboard-dashlet", dashletId },
      dragPreviewPosition: "pointer-outside",
    }),
    [dashletId, editMode],
  );
  const { dropTargetRef, closestEdge } = useDropTarget<DashboardDndData>(
    () => ({
      canDrop: ({ source }) =>
        editMode &&
        source.data.type === "workspace-dashboard-dashlet" &&
        source.data.dashletId !== dashletId,
      closestEdge: { allowedEdges: ["top", "right", "bottom", "left"] },
      data: { type: "workspace-dashboard-target", dashletId },
      dropEffect: "move",
      onDrop: ({ closestEdge, source }) => {
        if (source.data.type !== "workspace-dashboard-dashlet") return;
        const sourceIndex = layout.orderedDashletIds.indexOf(
          source.data.dashletId,
        );
        const after = closestEdge === "bottom" || closestEdge === "right";
        let targetIndex = index + (after ? 1 : 0);
        if (sourceIndex >= 0 && sourceIndex < targetIndex) targetIndex -= 1;
        onMove(source.data.dashletId, targetIndex, true);
      },
    }),
    [dashletId, editMode, index, layout.orderedDashletIds, onMove],
  );
  const itemRef = useCallback(
    (node: HTMLDivElement | null) => {
      focusRef.current = node;
      dragRef.current = node;
      dropTargetRef.current = node;
    },
    [dragRef, dropTargetRef],
  );

  const focusHandle = useCallback(() => {
    requestAnimationFrame(() => {
      focusRef.current
        ?.querySelector<HTMLElement>('[data-myoxus-ui-role="drag-handle"]')
        ?.focus();
    });
  }, []);

  useEffect(() => {
    if (focusRequested > 0) focusHandle();
  }, [focusHandle, focusRequested]);

  const move = useCallback(
    (targetIndex: number, persist: boolean) => {
      const bounded = Math.max(
        0,
        Math.min(targetIndex, layout.orderedDashletIds.length - 1),
      );
      if (bounded === index) return;
      onMove(dashletId, bounded, persist);
      setAnnouncement(
        t["com.myoxus.database.view.reorder-announcement"]({
          name: label,
          position: String(bounded + 1),
          total: String(layout.orderedDashletIds.length),
        }),
      );
      focusHandle();
    },
    [
      dashletId,
      focusHandle,
      index,
      label,
      layout.orderedDashletIds.length,
      onMove,
      t,
    ],
  );

  const handleKeyboard = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, openMenu: () => void) => {
      if (event.key === "Enter") {
        event.preventDefault();
        openMenu();
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        if (keyboardDragging) {
          onCommit();
        } else {
          setKeyboardOrigin(index);
        }
        setKeyboardDragging(!keyboardDragging);
        return;
      }
      if (!keyboardDragging) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onMove(dashletId, keyboardOrigin, false);
        setKeyboardDragging(false);
        focusHandle();
        return;
      }
      if (
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
      ) {
        return;
      }
      event.preventDefault();
      move(
        index + (event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1),
        false,
      );
    },
    [
      dashletId,
      focusHandle,
      index,
      keyboardDragging,
      keyboardOrigin,
      move,
      onCommit,
      onMove,
    ],
  );

  const chrome = editMode ? (
    <Group gap="xs" wrap="nowrap">
      <Box visibleFrom="md">
        <Menu
          rootOptions={{
            open: desktopReorderMenuOpen,
            onOpenChange: setDesktopReorderMenuOpen,
          }}
          items={
            <>
              <MenuItem
                disabled={index === 0}
                onSelect={() => move(index - 1, true)}
              >
                {t["com.myoxus.keyboardShortcuts.moveUp"]()}
              </MenuItem>
              <MenuItem
                disabled={index === layout.orderedDashletIds.length - 1}
                onSelect={() => move(index + 1, true)}
              >
                {t["com.myoxus.keyboardShortcuts.moveDown"]()}
              </MenuItem>
            </>
          }
        >
          <DragHandle
            ref={dragHandleRef}
            dragging={dragging}
            aria-label={`${t["com.myoxus.workspace-pages.move.confirm"]()} ${label}`}
            aria-pressed={keyboardDragging}
            data-myoxus-ui-role="drag-handle"
            onKeyDown={(event) =>
              handleKeyboard(event, () => setDesktopReorderMenuOpen(true))
            }
          />
        </Menu>
      </Box>
      <Box hiddenFrom="md">
        <Menu
          rootOptions={{
            open: compactReorderMenuOpen,
            onOpenChange: setCompactReorderMenuOpen,
          }}
          items={
            <>
              <MenuItem
                disabled={index === 0}
                onSelect={() => move(index - 1, true)}
              >
                {t["com.myoxus.keyboardShortcuts.moveUp"]()}
              </MenuItem>
              <MenuItem
                disabled={index === layout.orderedDashletIds.length - 1}
                onSelect={() => move(index + 1, true)}
              >
                {t["com.myoxus.keyboardShortcuts.moveDown"]()}
              </MenuItem>
            </>
          }
        >
          <DragHandle
            aria-label={`${t["com.myoxus.workspace-pages.move.confirm"]()} ${label}`}
            aria-pressed={keyboardDragging}
            data-myoxus-ui-role="drag-handle"
            onKeyDown={(event) =>
              handleKeyboard(event, () => setCompactReorderMenuOpen(true))
            }
          />
        </Menu>
      </Box>
      <DashboardSizeMenu
        dashletId={dashletId}
        label={label}
        onResize={(nextSize) => {
          onResize(dashletId, nextSize);
          setAnnouncement(
            `${label}: ${
              nextSize === "compact"
                ? t["com.myoxus.database.view.density.compact"]()
                : nextSize === "standard"
                  ? t[
                      "com.myoxus.settings.editorSettings.page.default-page-width.standard"
                    ]()
                  : t[
                      "com.myoxus.settings.editorSettings.page.default-page-width.full-width"
                    ]()
            }`,
          );
          focusHandle();
        }}
        size={size}
      />
    </Group>
  ) : null;

  return (
    <Grid.Col span={{ base: 12, md: span }}>
      <Box
        ref={itemRef}
        data-dragging={dragging || undefined}
        data-myoxus-ui-role="workspace-home-dashlet"
        data-dashlet-id={dashletId}
        data-dashlet-size={size}
        pos="relative"
      >
        {closestEdge ? <DropIndicator edge={closestEdge} /> : null}
        <DashboardEditChromeProvider value={chrome}>
          {children}
        </DashboardEditChromeProvider>
        <VisuallyHidden aria-live="polite">{announcement}</VisuallyHidden>
      </Box>
    </Grid.Col>
  );
}

function DashboardSizeMenu({
  dashletId,
  label,
  onResize,
  size,
}: {
  dashletId: WorkspaceDashboardDashletId;
  label: string;
  onResize: (size: WorkspaceDashboardDashletSize) => void;
  size: WorkspaceDashboardDashletSize;
}) {
  const t = useI18n();
  const renderItems = (compactViewport: boolean) =>
    (["compact", "standard", "wide"] as const).map((candidate) => (
      <MenuItem
        checked={candidate === size}
        disabled={
          compactViewport ||
          (candidate === "compact" &&
            !DASHBOARD_COMPACT_DASHLET_IDS.includes(
              dashletId as (typeof DASHBOARD_COMPACT_DASHLET_IDS)[number],
            ))
        }
        key={candidate}
        onSelect={() => onResize(candidate)}
      >
        {candidate === "compact"
          ? t["com.myoxus.database.view.density.compact"]()
          : candidate === "standard"
            ? t[
                "com.myoxus.settings.editorSettings.page.default-page-width.standard"
              ]()
            : t[
                "com.myoxus.settings.editorSettings.page.default-page-width.full-width"
              ]()}
      </MenuItem>
    ));
  return (
    <>
      <Box visibleFrom="md">
        <Menu items={renderItems(false)}>
          <Button variant="plain">
            {t["com.myoxus.editor.toolbar.size"]()}
          </Button>
        </Menu>
      </Box>
      <Box hiddenFrom="md">
        <Menu
          title={t["com.myoxus.workspace-home.layout.size.desktop-only"]()}
          items={renderItems(true)}
        >
          <Button
            aria-label={`${label}: ${t[
              "com.myoxus.workspace-home.layout.size.desktop-only"
            ]()}`}
            variant="plain"
          >
            {t["com.myoxus.editor.toolbar.size"]()}
          </Button>
        </Menu>
      </Box>
    </>
  );
}
