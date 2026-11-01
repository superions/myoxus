// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Box,
  Card,
  Collapse,
  type DNDData,
  DragHandle,
  DropIndicator,
  Group,
  IconButton,
  Menu,
  MenuItem,
  MyoxusText,
  Stack,
  useDraggable,
  useDropTarget,
  VisuallyHidden,
} from "@myoxus/ui-facade";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { WorkbenchToolId } from "../../../server/stores/user-preferences";
import type { ContextSurface } from "../../entities/context-surface";
import { ViewService } from "../../services/view";
import {
  ViewContextSurfaceBodyTarget,
  ViewContextSurfaceIconTarget,
} from "../view-islands";

interface ToolDndData extends DNDData<
  { type: "workbench-tool"; toolId: WorkbenchToolId },
  { type: "workbench-tool-target"; toolId: WorkbenchToolId }
> {}

export function ContextSurfaceHost() {
  const view = useService(ViewService).view;
  const contextSurfaces = useLiveData(view.contextSurfaces$);
  const layout = useLiveData(view.toolLayout$);
  const viewFamily = useLiveData(view.toolViewFamily$);
  if (!contextSurfaces.length) return null;

  const surfaceById = new Map(
    contextSurfaces
      .filter(
        (surface) =>
          surface.viewFamilies.length === 0 ||
          surface.viewFamilies.includes(viewFamily),
      )
      .map((surface) => [surface.id, surface]),
  );
  const visibleSurfaces = layout.orderedToolIds
    .filter((id) => layout.visibleToolIds.includes(id))
    .map((id) => surfaceById.get(id))
    .filter((surface): surface is ContextSurface => Boolean(surface));

  return (
    <Stack gap="sm" data-myoxus-ui-role="workbench-tool-stack">
      {visibleSurfaces.map((surface, index) => (
        <WorkbenchToolCard
          key={surface.id}
          index={index}
          surface={surface}
          viewId={view.id}
        />
      ))}
    </Stack>
  );
}

function WorkbenchToolCard({
  index,
  surface,
  viewId,
}: {
  index: number;
  surface: ContextSurface;
  viewId: string;
}) {
  const t = useI18n();
  const view = useService(ViewService).view;
  const layout = useLiveData(view.toolLayout$);
  const focusRequest = useLiveData(view.toolHeaderFocusRequest$);
  const collapsed = layout.collapsedToolIds.includes(surface.id);
  const headerRef = useRef<HTMLButtonElement | null>(null);
  const [keyboardDragging, setKeyboardDragging] = useState(false);
  const [keyboardOrigin, setKeyboardOrigin] = useState(index);
  const [announcement, setAnnouncement] = useState("");
  const [reorderMenuOpen, setReorderMenuOpen] = useState(false);
  const { dragRef, dragHandleRef, dragging } = useDraggable<ToolDndData>(
    () => ({
      data: { type: "workbench-tool", toolId: surface.id },
      dragPreviewPosition: "pointer-outside",
    }),
    [surface.id],
  );
  const { dropTargetRef, closestEdge } = useDropTarget<ToolDndData>(
    () => ({
      data: { type: "workbench-tool-target", toolId: surface.id },
      canDrop: ({ source }) =>
        source.data.type === "workbench-tool" &&
        source.data.toolId !== surface.id,
      closestEdge: { allowedEdges: ["top", "bottom"] },
      dropEffect: "move",
      onDrop: ({ source, closestEdge }) => {
        if (source.data.type !== "workbench-tool") return;
        const sourceIndex = layout.visibleToolIds.indexOf(source.data.toolId);
        let targetIndex = index + (closestEdge === "bottom" ? 1 : 0);
        if (sourceIndex >= 0 && sourceIndex < targetIndex) targetIndex -= 1;
        view.moveTool(source.data.toolId, targetIndex);
      },
    }),
    [index, layout.visibleToolIds, surface.id, view],
  );
  const cardRef = useCallback(
    (node: HTMLElement | null) => {
      dragRef.current = node;
      dropTargetRef.current = node;
    },
    [dragRef, dropTargetRef],
  );

  useEffect(() => {
    if (focusRequest?.id === surface.id) headerRef.current?.focus();
  }, [focusRequest, surface.id]);

  const handleKeyboardReorder = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        setReorderMenuOpen(true);
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        if (!keyboardDragging) setKeyboardOrigin(index);
        setKeyboardDragging(!keyboardDragging);
        setAnnouncement(`${surface.label}: ${index + 1}`);
        return;
      }
      if (!keyboardDragging) return;
      if (event.key === "Escape") {
        event.preventDefault();
        view.moveTool(surface.id, keyboardOrigin);
        setKeyboardDragging(false);
        setAnnouncement(`${surface.label}: ${keyboardOrigin + 1}`);
        return;
      }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const targetIndex = Math.max(
        0,
        Math.min(
          index + (event.key === "ArrowUp" ? -1 : 1),
          layout.visibleToolIds.length - 1,
        ),
      );
      if (targetIndex === index) return;
      view.moveTool(surface.id, targetIndex);
      setAnnouncement(`${surface.label}: ${targetIndex + 1}`);
    },
    [
      index,
      keyboardDragging,
      keyboardOrigin,
      layout.visibleToolIds.length,
      surface.id,
      surface.label,
      view,
    ],
  );

  const hideTool = useCallback(() => {
    const lastVisible = layout.visibleToolIds.length === 1;
    view.hideTool(surface.id);
    if (lastVisible) {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="context-panel-toggle"]',
          )
          ?.focus();
      });
    }
  }, [layout.visibleToolIds.length, surface.id, view]);

  return (
    <Box ref={cardRef} data-myoxus-ui-role="workbench-tool-dnd-target">
      <Card
        padding="sm"
        withBorder
        data-dragging={dragging || undefined}
        data-testid={`context-surface-${surface.id}`}
        data-myoxus-ui-role="workbench-tool-card"
      >
        {closestEdge ? <DropIndicator edge={closestEdge} /> : null}
        <Group gap="xs" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Menu
              rootOptions={{
                open: reorderMenuOpen,
                onOpenChange: setReorderMenuOpen,
              }}
              items={
                <>
                  <MenuItem
                    disabled={index === 0}
                    onSelect={() => view.moveTool(surface.id, index - 1)}
                  >
                    {t["com.myoxus.keyboardShortcuts.moveUp"]()}
                  </MenuItem>
                  <MenuItem
                    disabled={index === layout.visibleToolIds.length - 1}
                    onSelect={() => view.moveTool(surface.id, index + 1)}
                  >
                    {t["com.myoxus.keyboardShortcuts.moveDown"]()}
                  </MenuItem>
                </>
              }
            >
              <DragHandle
                ref={dragHandleRef}
                dragging={dragging}
                aria-label={`${t["com.myoxus.workspace-pages.move.confirm"]()} ${surface.label}`}
                aria-pressed={keyboardDragging}
                onKeyDown={handleKeyboardReorder}
              />
            </Menu>
            <ViewContextSurfaceIconTarget
              viewId={viewId}
              surfaceId={surface.id}
              aria-hidden
            />
            <MyoxusText>{surface.label}</MyoxusText>
          </Group>
          <Group gap={0} wrap="nowrap">
            <IconButton
              ref={headerRef}
              aria-expanded={!collapsed}
              aria-label={surface.tooltip}
              icon={collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
              onClick={() => view.toggleToolCollapsed(surface.id)}
            />
            <IconButton
              aria-label={t["com.myoxus.workbench.tool.remove"]({
                tool: surface.label,
              })}
              icon={<CloseIcon />}
              onClick={hideTool}
            />
          </Group>
        </Group>
        <Collapse
          expanded={!collapsed}
          // Activity hiding reconnects retained portal targets and resets drafts.
          keepMountedMode={
            surface.retainBodyWhenCollapsed ? "display-none" : "activity"
          }
        >
          <ViewContextSurfaceBodyTarget
            surfaceId={surface.id}
            viewId={viewId}
            data-myoxus-ui-role="workbench-context-surface"
          />
        </Collapse>
        <VisuallyHidden aria-live="polite">{announcement}</VisuallyHidden>
      </Card>
    </Box>
  );
}
