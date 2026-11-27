// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  createElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSignalValue } from "@myoxus/core/modules/doc-info/utils";
import { useI18n } from "@myoxus/i18n";
import {
  Box,
  Center,
  Group,
  Divider,
  OverflowList,
  ToolbarSurface,
  IconButton,
  MenuTrigger,
  Menu,
  type MenuRef,
  MenuSearch,
  EmptyState,
} from "@myoxus/ui-facade";
import {
  DefaultTool,
  EdgelessLegacySlotIdentifier,
} from "@virgultum/editor/blocks/surface";
import {
  EditPropsStore,
  type EditorCanvasDockControls,
  type EditorCanvasToolbarItem,
  type EditorCanvasToolControls,
} from "@virgultum/editor/shared/services";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import {
  ActionButton,
  SelectionActions,
  preserveEditorCommandFocus,
} from "./selection-toolbar/block-actions";
import { renderControl } from "./selection-toolbar";
import { editorGlyph } from "./glyphs";
import { EditorPresentationToolbar } from "./presentation-toolbar";
import { EditorCanvasTemplatesTool } from "./canvas-templates";
import {
  EditorCanvasConnectorTool,
  EditorCanvasEraserTool,
  EditorCanvasFrameTool,
  EditorCanvasNoteTool,
  EditorCanvasPenAndEraserTools,
  EditorCanvasShapeTool,
} from "./canvas-dock-tools";

function NativeDomArtwork({
  svg,
  mount,
}: {
  svg?: string;
  mount?: (host: HTMLElement) => (() => void) | void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (mount) return mount(el) ?? undefined;
    if (svg !== undefined) el.innerHTML = svg;
    return () => {
      el.replaceChildren();
    };
  }, [svg, mount]);
  return <Box component="span" ref={ref} style={{ display: "contents" }} />;
}

// Primary dock buttons sit next to the 64 px senior-tool rail and use the
// Facade's larger semantic control scale rather than the compact 28 px default.
const DOCK_PRIMARY_TOOL_SIZE = "large" as const;

export function EditorCanvasTool({
  action,
  menu,
  artworkSvg,
  mountArtwork,
  nativeArtwork,
  artworkBounds,
  artworkColor,
  expanded,
}: EditorCanvasToolControls) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [actions, setActions] = useState<EditorCanvasToolControls["action"][]>(
    [],
  );
  const t = useI18n();
  const search = (value: string) => {
    setQuery(value);
    setActions(menu?.actions(value) ?? []);
  };
  const isExpanded = menu ? opened : expanded;
  const hasArtwork = Boolean(nativeArtwork ?? artworkSvg ?? mountArtwork);
  const glyph = !hasArtwork ? editorGlyph(action.icon) : null;
  const isMenuTrigger = !hasArtwork && isExpanded !== undefined;
  const trigger = isMenuTrigger ? (
    <MenuTrigger
      data-testid={action.id}
      size={DOCK_PRIMARY_TOOL_SIZE}
      prefix={glyph ?? undefined}
      tooltip={isExpanded ? undefined : action.label}
      tooltipShortcut={action.shortcut ? [action.shortcut] : undefined}
      aria-label={action.label}
      aria-pressed={action.active}
      aria-expanded={isExpanded}
      disabled={action.disabled}
      variant={action.active ? "secondary" : "plain"}
      onPointerDown={preserveEditorCommandFocus}
      onClick={(event) => action.run?.(event.currentTarget, event.nativeEvent)}
    />
  ) : (
    <IconButton
      data-testid={action.id}
      size={artworkBounds?.height ?? DOCK_PRIMARY_TOOL_SIZE}
      style={artworkBounds ? { width: artworkBounds.width } : undefined}
      tooltip={isExpanded ? undefined : action.label}
      tooltipShortcut={action.shortcut ? [action.shortcut] : undefined}
      aria-label={action.label}
      aria-pressed={action.active}
      aria-expanded={isExpanded}
      disabled={action.disabled}
      variant={action.active ? "secondary" : "plain"}
      onPointerDown={preserveEditorCommandFocus}
      onClick={(event) => action.run?.(event.currentTarget, event.nativeEvent)}
    >
      {hasArtwork ? (
        <Box component="span" style={{ color: artworkColor }}>
          {nativeArtwork ? (
            (nativeArtwork as ReactNode)
          ) : (
            <NativeDomArtwork svg={artworkSvg} mount={mountArtwork} />
          )}
        </Box>
      ) : (
        glyph
      )}
    </IconButton>
  );
  return menu ? (
    <Menu
      title={action.label}
      rootOptions={{
        onOpen: () => {
          menu.onOpen?.();
          setOpened(true);
          search("");
        },
        onClose: () => setOpened(false),
      }}
      contentOptions={{ side: "top", align: "start" }}
      items={
        <>
          <MenuSearch
            value={query}
            onChange={(event) => search(event.currentTarget.value)}
            aria-label={menu.searchPlaceholder}
            placeholder={menu.searchPlaceholder}
            onCopy={(event) => event.stopPropagation()}
            onCut={(event) => event.stopPropagation()}
            onPaste={(event) => event.stopPropagation()}
          />
          {actions.length ? (
            <SelectionActions
              actions={actions}
              menu
              renderControl={renderControl}
            />
          ) : (
            <EmptyState title={t["com.myoxus.cmdk.no-results"]()} />
          )}
        </>
      }
    >
      {trigger}
    </Menu>
  ) : (
    trigger
  );
}

function renderToolbarItem(
  item: EditorCanvasToolbarItem,
  registerActivePopover: (close: () => void) => () => void,
) {
  if (item.type === "control") return <EditorCanvasTool {...item.controls} />;
  switch (item.tool) {
    case "templates":
      return (
        <EditorCanvasTemplatesTool
          edgeless={item.edgeless}
          registerActivePopover={registerActivePopover}
        />
      );
    case "frame":
      return (
        <EditorCanvasFrameTool
          edgeless={item.edgeless}
          registerActivePopover={registerActivePopover}
        />
      );
    case "connector":
      return (
        <EditorCanvasConnectorTool
          edgeless={item.edgeless}
          registerActivePopover={registerActivePopover}
        />
      );
    case "note":
      return (
        <EditorCanvasNoteTool
          edgeless={item.edgeless}
          registerActivePopover={registerActivePopover}
        />
      );
    case "pen":
      return (
        <EditorCanvasPenAndEraserTools
          edgeless={item.edgeless}
          registerActivePopover={registerActivePopover}
        />
      );
    case "eraser":
      return <EditorCanvasEraserTool edgeless={item.edgeless} />;
    case "shape":
      return (
        <EditorCanvasShapeTool
          edgeless={item.edgeless}
          registerActivePopover={registerActivePopover}
        />
      );
    default:
      return null;
  }
}

function toolbarItemKey(item: EditorCanvasToolbarItem): string {
  if (item.type === "control") return item.controls.action.id;
  return `popover-${item.tool}`;
}

/**
 * Direct AGPL React Edgeless canvas dock host replacing `EdgelessToolbarWidget`.
 * Owns active-popover mutual exclusion, presentation auto-hide state, default
 * pointer tool persistence, and the global Escape reset hotkey.
 */
export function EditorCanvasDock({
  controls,
}: {
  controls: EditorCanvasDockControls;
}) {
  const { edgeless, anchor, resolveTools } = controls;
  const gfx = edgeless.std.get(GfxControllerIdentifier);
  const editProps = edgeless.std.get(EditPropsStore);
  const slots = edgeless.std.get(EdgelessLegacySlotIdentifier);
  const t = useI18n();

  const currentToolName = useSignalValue(gfx.tool.currentToolName$);
  const readonly = useSignalValue(edgeless.store.readonly$);
  const [, bumpRevision] = useState(0);
  const [presentSettingMenuShow, setPresentSettingMenuShow] = useState(false);
  const [presentFrameMenuShow, setPresentFrameMenuShow] = useState(false);
  const [presentHideToolbar, setPresentHideToolbar] = useState(() =>
    Boolean(editProps.getStorage("presentHideToolbar")),
  );

  const overflowMenu = useRef<MenuRef>(null);
  const activePopoverRef = useRef<(() => void) | null>(null);

  const closeActivePopover = useCallback(() => {
    const close = activePopoverRef.current;
    activePopoverRef.current = null;
    close?.();
  }, []);

  const registerActivePopover = useCallback((close: () => void) => {
    const prev = activePopoverRef.current;
    activePopoverRef.current = null;
    prev?.();
    activePopoverRef.current = close;
    return () => {
      if (activePopoverRef.current === close) {
        activePopoverRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (
      (currentToolName === "default" || currentToolName === "pan") &&
      localStorage.defaultTool !== currentToolName
    ) {
      localStorage.defaultTool = currentToolName;
    }
  }, [currentToolName]);

  useEffect(() => {
    const refresh = () => bumpRevision((n) => n + 1);
    const viewportSub = gfx.viewport.viewportUpdated.subscribe(refresh);
    const readonlySub = slots.readonlyUpdated.subscribe(refresh);
    const storageSub = editProps.slots.storageUpdated.subscribe(({ key }) => {
      if (key === "presentHideToolbar") {
        setPresentHideToolbar(
          Boolean(editProps.getStorage("presentHideToolbar")),
        );
      }
    });
    const disposeEscape = edgeless.bindHotKey(
      {
        Escape: () => {
          if (gfx.selection.editing) return;
          const activeTool = gfx.tool.currentToolName$.peek();
          if (activeTool === "frameNavigator") return;
          closeActivePopover();
          if (activeTool !== "default") {
            gfx.tool.setTool(DefaultTool);
          }
        },
      },
      { global: true },
    );
    return () => {
      viewportSub.unsubscribe();
      readonlySub.unsubscribe();
      storageSub.unsubscribe();
      disposeEscape();
      closeActivePopover();
    };
  }, [closeActivePopover, edgeless, editProps, gfx, slots]);

  const isPresentMode = currentToolName === "frameNavigator";
  const enableAutoHide =
    isPresentMode &&
    presentHideToolbar &&
    !presentSettingMenuShow &&
    !presentFrameMenuShow;

  useEffect(() => {
    anchor.dataset.enable = String(enableAutoHide);
  }, [anchor, enableAutoHide]);

  if (readonly && !isPresentMode) {
    return null;
  }

  const { quick, senior } = isPresentMode
    ? { quick: [], senior: [] }
    : resolveTools(closeActivePopover);

  // Tool popovers and retained artwork extend beyond the canvas dock bounds.
  return (
    <ToolbarSurface
      compact
      justify="center"
      role="toolbar"
      style={{ overflow: "visible" }}
    >
      <Group
        className="edgeless-toolbar-container"
        wrap="nowrap"
        gap="xs"
        maw="100%"
      >
        {isPresentMode ? (
          <Box
            renderRoot={(props) => createElement("presentation-toolbar", props)}
          >
            <EditorPresentationToolbar
              presentation={{
                edgeless,
                settingMenuShow: presentSettingMenuShow,
                frameMenuShow: presentFrameMenuShow,
                setSettingMenuShow: setPresentSettingMenuShow,
                setFrameMenuShow: setPresentFrameMenuShow,
              }}
            />
          </Box>
        ) : (
          <>
            <OverflowList
              data={[...quick]}
              gap="xs"
              getItemKey={toolbarItemKey}
              renderItem={(content) => (
                <Box key={toolbarItemKey(content)}>
                  {renderToolbarItem(content, registerActivePopover)}
                </Box>
              )}
              renderOverflow={(hiddenItems) => {
                const menuActions = hiddenItems
                  .map((item) => item.menu)
                  .filter(
                    (
                      action,
                    ): action is NonNullable<EditorCanvasToolbarItem["menu"]> =>
                      Boolean(action),
                  );
                if (!menuActions.length) return <Box component="span" />;
                return (
                  <Box component="span">
                    <Menu
                      ref={overflowMenu}
                      noPortal
                      items={
                        <SelectionActions
                          actions={menuActions}
                          menu
                          afterAction={() =>
                            overflowMenu.current?.changeOpen(false)
                          }
                          renderControl={renderControl}
                        />
                      }
                    >
                      <ActionButton
                        size={DOCK_PRIMARY_TOOL_SIZE}
                        action={{
                          id: "canvas-more-tools",
                          icon: "MoreHorizontalIcon",
                          label: t["com.myoxus.editor.toolbar.more-tools"](),
                          disabled: false,
                        }}
                      />
                    </Menu>
                  </Box>
                );
              }}
            />
            <Divider orientation="vertical" />
            <Group wrap="nowrap" gap={0}>
              {senior.map((content) => (
                // Existing artwork and drag hit boxes retain their canvas geometry.
                <Center key={toolbarItemKey(content)} w={96} h={64}>
                  {renderToolbarItem(content, registerActivePopover)}
                </Center>
              ))}
            </Group>
          </>
        )}
      </Group>
    </ToolbarSurface>
  );
}
