// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useCallback, useEffect, useRef, useState } from "react";
import { effect } from "@preact/signals-core";
import { useSignalValue } from "@myoxus/core/modules/doc-info/utils";
import { useI18n } from "@myoxus/i18n";
import { Heading1Icon, LinkIcon, TextIcon } from "@myoxus/icons/react";
import { Box, Group } from "@myoxus/ui-facade";
import { addAttachments } from "@virgultum/editor/blocks/attachment";
import { insertLinkByQuickSearchCommand } from "@virgultum/editor/blocks/bookmark";
import {
  EdgelessFrameManagerIdentifier,
  FrameConfig,
  FrameTool,
} from "@virgultum/editor/blocks/frame";
import { addImages } from "@virgultum/editor/blocks/image";
import {
  CanvasElementType,
  DefaultTool,
  EdgelessCRUDIdentifier,
} from "@virgultum/editor/blocks/surface";
import {
  adjustColorAlpha,
  keepColor,
} from "@virgultum/editor/components/color-picker";
import {
  BrushTool,
  EdgelessEraserDarkIcon,
  EdgelessEraserLightIcon,
  EraserTool,
  HighlighterTool,
  penIconMap,
  penInfoMap,
  type Pen,
} from "@virgultum/editor/gfx/brush";
import { ConnectorTool } from "@virgultum/editor/gfx/connector";
import {
  NOTE_MENU_ITEMS,
  NoteTool,
  toShapeNotToAdapt,
  type NoteToolOption,
} from "@virgultum/editor/gfx/note";
import {
  ellipseSvg,
  roundedSvg,
  ShapeComponentConfig,
  ShapeTool,
  triangleSvg,
} from "@virgultum/editor/gfx/shape";
import {
  BRUSH_LINE_WIDTHS,
  ConnectorMode,
  DefaultTheme,
  getConnectorModeName,
  getShapeRadius,
  getShapeType,
  HIGHLIGHTER_LINE_WIDTHS,
  isTransparent,
  MAX_IMAGE_WIDTH,
  type Palette,
  resolveColor,
  type ShapeName,
  ShapeStyle,
  ShapeType,
} from "@virgultum/editor/model";
import {
  createToolbarColorControl,
  EditPropsStore,
  EditorI18nProvider,
  resolveEditorMessage,
  TelemetryProvider,
  ThemeProvider,
  type EditorCanvasPopoverControls,
} from "@virgultum/editor/shared/services";
import {
  getImageFilesFromLocal,
  openSingleFileWith,
} from "@virgultum/editor/shared/utils";
import type { BlockComponent } from "@virgultum/editor/std";
import {
  GfxControllerIdentifier,
  type ToolOptions,
  type ToolOptionWithType,
} from "@virgultum/editor/std/gfx";

import { startCanvasDragInsert } from "./canvas-drag-insert";
import { EditorCanvasPopover } from "./canvas-popover";
import { EditorCanvasTool } from "./canvas-toolbar";

type PopoverRegistrar = (close: () => void) => () => void;

/**
 * Registers an open dock popover with the shared mutual-exclusion coordinator
 * so opening another dock tool or pressing Escape closes it cleanly.
 */
function useActiveDockPopover(
  opened: boolean,
  setOpened: (next: boolean) => void,
  registerActivePopover: PopoverRegistrar,
) {
  useEffect(() => {
    if (!opened) return;
    return registerActivePopover(() => setOpened(false));
  }, [opened, registerActivePopover, setOpened]);
}

/** Direct AGPL React controller for the Edgeless Frame dock tool and preset menu. */
export function EditorCanvasFrameTool({
  edgeless,
  registerActivePopover,
}: {
  edgeless: BlockComponent;
  registerActivePopover: PopoverRegistrar;
}) {
  const t = useI18n();
  const gfx = edgeless.std.get(GfxControllerIdentifier);
  const frameManager = edgeless.std.get(EdgelessFrameManagerIdentifier);
  const currentToolName = useSignalValue(gfx.tool.currentToolName$);
  const active = currentToolName === FrameTool.toolName;
  const [opened, setOpened] = useState(false);

  useActiveDockPopover(opened, setOpened, registerActivePopover);

  useEffect(() => {
    return gfx.tool.currentToolName$.subscribe((name) => {
      if (name !== FrameTool.toolName) {
        setOpened(false);
      }
    });
  }, [gfx]);

  const toggleMenu = useCallback(() => {
    if (active && opened) {
      setOpened(false);
      return;
    }
    gfx.tool.setTool(FrameTool);
    setOpened(true);
  }, [active, gfx, opened]);

  const label = t["com.myoxus.editor.slash.frame"]();
  const popoverControls: EditorCanvasPopoverControls = {
    opened,
    onClose: () => setOpened(false),
    position: "top",
    offset: 16,
    closeOnClickOutside: false,
    label,
    testId: "canvas-frame-menu",
    trigger: {
      expanded: opened,
      action: {
        id: "canvas-frame",
        icon: "FrameIcon",
        label,
        shortcut: "F",
        active,
        disabled: false,
        run: toggleMenu,
      },
    },
    content: {
      kind: "menu",
      controls: {
        actions: [
          {
            id: "canvas-frame-custom",
            label: t["com.myoxus.editor.frame.custom"](),
            disabled: false,
          },
          ...FrameConfig.map((item) => ({
            id: `canvas-frame-${item.name}`,
            label: item.name,
            showLabel: true,
            disabled: false,
            run: () => {
              setOpened(false);
              gfx.tool.setTool(DefaultTool);
              frameManager.createFrameOnViewportCenter(item.wh);
            },
          })),
        ],
      },
    },
  };

  return (
    <EditorCanvasPopover controls={popoverControls} withinPortal={false} />
  );
}

/** Direct AGPL React controller for the Edgeless Connector dock tool and style menu. */
export function EditorCanvasConnectorTool({
  edgeless,
  registerActivePopover,
}: {
  edgeless: BlockComponent;
  registerActivePopover: PopoverRegistrar;
}) {
  const t = useI18n();
  const gfx = edgeless.std.get(GfxControllerIdentifier);
  const editProps = edgeless.std.get(EditPropsStore);
  const themeProvider = edgeless.std.get(ThemeProvider);

  const currentToolName = useSignalValue(gfx.tool.currentToolName$);
  const lastProps = useSignalValue(editProps.lastProps$);
  const theme = useSignalValue(themeProvider.theme$);
  const { mode, stroke, strokeWidth } = lastProps.connector;
  const active = currentToolName === ConnectorTool.toolName;
  const [opened, setOpened] = useState(false);

  useActiveDockPopover(opened, setOpened, registerActivePopover);

  useEffect(() => {
    return gfx.tool.currentToolName$.subscribe((name) => {
      if (name !== ConnectorTool.toolName) {
        setOpened(false);
      }
    });
  }, [gfx]);

  const updateConnectorProps = useCallback(
    (props: Record<string, unknown>) => {
      editProps.recordLastProps("connector", props);
      const nextMode = editProps.lastProps$.peek().connector.mode;
      gfx.tool.setTool(ConnectorTool, { mode: nextMode });
    },
    [editProps, gfx],
  );

  const toggleMenu = useCallback(() => {
    if (active && opened) {
      setOpened(false);
      return;
    }
    gfx.tool.setTool(ConnectorTool, { mode });
    setOpened(true);
  }, [active, gfx, mode, opened]);

  const label = getConnectorModeName(mode);
  const icon =
    mode === ConnectorMode.Straight
      ? "ConnectorLIcon"
      : mode === ConnectorMode.Orthogonal
        ? "ConnectorEIcon"
        : "ConnectorCIcon";

  const popoverControls: EditorCanvasPopoverControls = {
    opened,
    onClose: () => setOpened(false),
    position: "top",
    offset: 16,
    closeOnClickOutside: false,
    label,
    testId: "canvas-connector-menu",
    trigger: {
      expanded: opened,
      action: {
        id: "canvas-connector",
        label,
        shortcut: "C",
        active,
        disabled: false,
        icon,
        run: toggleMenu,
      },
    },
    content: {
      kind: "menu",
      controls: {
        tools: [
          {
            action: {
              id: "canvas-connector-curve",
              icon: "ConnectorCIcon",
              label: t["com.myoxus.editor.menu.curve"](),
              active: mode === ConnectorMode.Curve,
              disabled: false,
              run: () => updateConnectorProps({ mode: ConnectorMode.Curve }),
            },
          },
          {
            action: {
              id: "canvas-connector-elbow",
              icon: "ConnectorEIcon",
              label: t["com.myoxus.editor.menu.elbowed"](),
              active: mode === ConnectorMode.Orthogonal,
              disabled: false,
              run: () =>
                updateConnectorProps({ mode: ConnectorMode.Orthogonal }),
            },
          },
          {
            action: {
              id: "canvas-connector-straight",
              icon: "ConnectorLIcon",
              label: t["com.myoxus.editor.menu.straight"](),
              active: mode === ConnectorMode.Straight,
              disabled: false,
              run: () => updateConnectorProps({ mode: ConnectorMode.Straight }),
            },
          },
        ],
        actions: [
          {
            id: "canvas-connector-width",
            label:
              t[
                "com.myoxus.settings.editorSettings.edgeless.connecter.border-thickness"
              ](),
            disabled: false,
            control: {
              type: "number",
              value: strokeWidth,
              presets: BRUSH_LINE_WIDTHS,
              change: (value) =>
                updateConnectorProps({ strokeWidth: Number(value) }),
            },
          },
          {
            id: "canvas-connector-color",
            label:
              t[
                "com.myoxus.settings.editorSettings.edgeless.connecter.color"
              ](),
            disabled: false,
            control: createToolbarColorControl({
              value: resolveColor(stroke, theme),
              theme,
              palettes: DefaultTheme.StrokeColorShortPalettes,
              custom: false,
              change: (value) => updateConnectorProps({ stroke: value }),
            }),
          },
        ],
      },
    },
  };

  return (
    <EditorCanvasPopover controls={popoverControls} withinPortal={false} />
  );
}

/** Renderer-owned note paper & floating icon preview inside the 96x64 dock slot. */
function NotePaperArtwork({
  paperBg,
  appTheme,
}: {
  paperBg: string;
  appTheme: string;
}) {
  const [hovered, setHovered] = useState(false);
  const paperTextRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = paperTextRef.current;
    if (!el) return;
    el.innerHTML = toShapeNotToAdapt;
    return () => {
      el.replaceChildren();
    };
  }, []);

  const isDark = appTheme === "dark";
  const borderColor = isDark
    ? "var(--myoxus-divider-color)"
    : "var(--myoxus-border-color)";
  const foreignColor = isDark
    ? "var(--myoxus-border-color)"
    : "var(--myoxus-divider-color)";
  const paperShadow = isDark
    ? "var(--myoxus-shadow-2)"
    : "var(--myoxus-shadow-1)";
  const iconCardBg = isDark
    ? "var(--myoxus-background-overlay-panel-color)"
    : "var(--myoxus-background-primary-color)";
  const iconCardShadow = paperShadow;

  const iconCardBase: React.CSSProperties = {
    position: "absolute",
    width: 26,
    height: 26,
    borderRadius: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--myoxus-icon-secondary)",
    background: iconCardBg,
    boxShadow: iconCardShadow,
    bottom: 12,
    transition: "transform 0.4s ease",
  };

  return (
    <Box
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 96,
        height: 64,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <Box
        ref={paperTextRef}
        style={{
          width: 60,
          height: 72,
          background: paperBg,
          border: `1px solid ${borderColor}`,
          position: "absolute",
          transform: hovered
            ? "translateY(15px) rotate(4.42deg)"
            : "translateY(20px) rotate(4.42deg)",
          color: foreignColor,
          boxShadow: paperShadow,
          paddingTop: 32,
          paddingLeft: 3,
          transition: "transform 0.4s ease",
        }}
      />
      <Box
        style={{
          ...iconCardBase,
          transformOrigin: "0% 100%",
          transform: hovered
            ? "translateX(-25px) translateY(-5px) rotate(-9.5deg)"
            : "translateX(-22px) translateY(-5px) rotate(-6deg)",
        }}
      >
        <LinkIcon width={20} height={20} />
      </Box>
      <Box
        style={{
          ...iconCardBase,
          transformOrigin: "0% 100%",
          transform: hovered
            ? "translateX(23px) translateY(-8px) rotate(15deg)"
            : "translateX(21px) translateY(-7px) rotate(8deg)",
        }}
      >
        <Heading1Icon width={20} height={20} />
      </Box>
      <Box
        style={{
          ...iconCardBase,
          transform: hovered
            ? "translateX(0px) translateY(-10px) rotate(4deg)"
            : "translateX(0px) translateY(0px) rotate(4deg)",
        }}
      >
        <TextIcon width={20} height={20} />
      </Box>
    </Box>
  );
}

/** Direct AGPL React controller for the Edgeless Note senior dock tool and menu. */
export function EditorCanvasNoteTool({
  edgeless,
  registerActivePopover,
}: {
  edgeless: BlockComponent;
  registerActivePopover: PopoverRegistrar;
}) {
  const t = useI18n();
  const gfx = edgeless.std.get(GfxControllerIdentifier);
  const editProps = edgeless.std.get(EditPropsStore);
  const themeProvider = edgeless.std.get(ThemeProvider);
  const i18n = edgeless.std.getOptional(EditorI18nProvider) ?? undefined;

  const currentToolName = useSignalValue(gfx.tool.currentToolName$);
  const lastProps = useSignalValue(editProps.lastProps$);
  const appTheme = useSignalValue(themeProvider.app$);

  const [opened, setOpened] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [childFlavour, setChildFlavour] =
    useState<NoteToolOption["childFlavour"]>("myoxus:paragraph");
  const [childType, setChildType] = useState<string | null>("text");
  const [tip, setTip] = useState<string>("Note");

  const active = currentToolName === NoteTool.toolName;

  useActiveDockPopover(opened, setOpened, registerActivePopover);

  useEffect(() => {
    return effect(() => {
      const tool = gfx.tool.currentToolOption$.value;
      if (tool?.toolType === NoteTool) {
        const options = tool.options as ToolOptions<NoteTool>;
        if (options) {
          setChildFlavour(options.childFlavour);
          setChildType(options.childType);
          setTip(options.tip);
        }
      }
    });
  }, [gfx]);

  useEffect(() => {
    return gfx.tool.currentToolName$.subscribe((name) => {
      if (name !== NoteTool.toolName) {
        setOpened(false);
      }
    });
  }, [gfx]);

  const toggleMenu = useCallback(() => {
    if (active && opened) {
      setOpened(false);
      return;
    }
    gfx.tool.setTool(NoteTool, { childFlavour, childType, tip });
    setOpened(true);
  }, [active, childFlavour, childType, gfx, opened, tip]);

  const pickNoteChild = useCallback(
    (next: {
      childFlavour: NoteToolOption["childFlavour"];
      childType: string | null;
      tip: string;
    }) => {
      setChildFlavour(next.childFlavour);
      setChildType(next.childType);
      setTip(next.tip);
      gfx.tool.setTool(NoteTool, next);
    },
    [gfx],
  );

  const handleAddImages = useCallback(async () => {
    setImageLoading(true);
    try {
      const imageFiles = await getImageFilesFromLocal();
      const ids = await addImages(edgeless.std, imageFiles, {
        maxWidth: MAX_IMAGE_WIDTH,
      });
      gfx.tool.setTool(DefaultTool);
      gfx.selection.set({ elements: ids });
    } finally {
      setImageLoading(false);
    }
  }, [edgeless.std, gfx]);

  const handleAddLink = useCallback(() => {
    const [, { insertedLinkType }] = edgeless.service.std.command.exec(
      insertLinkByQuickSearchCommand,
    );
    insertedLinkType
      ?.then((type) => {
        const flavour = type?.flavour;
        if (!flavour) return;
        edgeless.std
          .getOptional(TelemetryProvider)
          ?.track("CanvasElementAdded", {
            control: "toolbar:general",
            page: "whiteboard editor",
            module: "toolbar",
            type: flavour.split(":")[1],
          });
      })
      .catch(console.error);
  }, [edgeless]);

  const handleAddAttachment = useCallback(async () => {
    const file = await openSingleFileWith();
    if (!file) return;
    await addAttachments(edgeless.std, [file]);
    gfx.tool.setTool(DefaultTool);
    edgeless.std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
      control: "toolbar:general",
      page: "whiteboard editor",
      module: "toolbar",
      segment: "toolbar",
      type: "attachment",
    });
  }, [edgeless.std, gfx]);

  const paperBg = themeProvider.generateColorProperty(
    lastProps["myoxus:note"].background,
  );
  const label = t["com.myoxus.keyboardShortcuts.note"]();

  const popoverControls: EditorCanvasPopoverControls = {
    opened,
    onClose: () => setOpened(false),
    position: "top",
    offset: 16,
    closeOnClickOutside: false,
    label,
    testId: "canvas-note-menu",
    trigger: {
      expanded: opened,
      action: {
        id: "canvas-note",
        label,
        shortcut: "N",
        active,
        disabled: false,
        run: toggleMenu,
      },
      artworkBounds: { width: 96, height: 64 },
      nativeArtwork: <NotePaperArtwork paperBg={paperBg} appTheme={appTheme} />,
    },
    content: {
      kind: "menu",
      controls: {
        tools: [
          {
            action: {
              id: "canvas-note-image",
              icon: "ImageIcon",
              label: t["Image"](),
              disabled: imageLoading,
              run: () => {
                void handleAddImages();
              },
            },
          },
          {
            action: {
              id: "canvas-note-link",
              icon: "LinkIcon",
              label: t["com.myoxus.editor.keyboard.link"](),
              shortcut: "@",
              disabled: false,
              run: handleAddLink,
            },
          },
          {
            action: {
              id: "canvas-note-attachment",
              icon: "AttachmentIcon",
              label: t["com.myoxus.editor.slash.attachment"](),
              disabled: false,
              run: () => {
                void handleAddAttachment();
              },
            },
          },
          ...NOTE_MENU_ITEMS.map((item, index) => {
            const itemLabel = resolveEditorMessage(item.tooltip, i18n);
            return {
              action: {
                id: `canvas-note-${item.childFlavour}-${item.childType}`,
                icon: item.icon,
                label: itemLabel,
                disabled: false,
                active: childType === item.childType,
                run: () =>
                  pickNoteChild({
                    childFlavour: item.childFlavour,
                    childType: item.childType,
                    tip: itemLabel,
                  }),
              },
              separatorBefore: index === 0,
            };
          }),
        ],
        actions: [],
      },
    },
  };

  return (
    <EditorCanvasPopover controls={popoverControls} withinPortal={false} />
  );
}

/** Direct AGPL React controller for the Edgeless Pen/Highlighter senior dock tool. */
export function EditorCanvasPenTool({
  edgeless,
  registerActivePopover,
}: {
  edgeless: BlockComponent;
  registerActivePopover: PopoverRegistrar;
}) {
  const t = useI18n();
  const gfx = edgeless.std.get(GfxControllerIdentifier);
  const editProps = edgeless.std.get(EditPropsStore);
  const themeProvider = edgeless.std.get(ThemeProvider);

  const currentToolName = useSignalValue(gfx.tool.currentToolName$);
  const lastProps = useSignalValue(editProps.lastProps$);
  const theme = useSignalValue(themeProvider.theme$);
  const appTheme = useSignalValue(themeProvider.app$);

  const [pen, setPen] = useState<Pen>("brush");
  const [opened, setOpened] = useState(false);
  const penRef = useRef<Pen>(pen);
  penRef.current = pen;
  const wasActiveRef = useRef(
    currentToolName === BrushTool.toolName ||
      currentToolName === HighlighterTool.toolName,
  );

  const active =
    currentToolName === BrushTool.toolName ||
    currentToolName === HighlighterTool.toolName;

  useActiveDockPopover(opened, setOpened, registerActivePopover);

  useEffect(() => {
    return gfx.tool.currentToolName$.subscribe((name) => {
      const isPen =
        name === BrushTool.toolName || name === HighlighterTool.toolName;
      if (!isPen) {
        wasActiveRef.current = false;
        setOpened(false);
        return;
      }
      const nextPen = name as Pen;
      if (nextPen !== penRef.current) {
        penRef.current = nextPen;
        setPen(nextPen);
      }
      if (!wasActiveRef.current) {
        wasActiveRef.current = true;
        setOpened(true);
      }
    });
  }, [gfx]);

  const setPenTool = useCallback(
    (nextPen: Pen) => {
      if (nextPen === "brush") {
        gfx.tool.setTool(BrushTool);
      } else {
        gfx.tool.setTool(HighlighterTool);
      }
    },
    [gfx],
  );

  const toggleMenu = useCallback(() => {
    if (active && opened) {
      setOpened(false);
      return;
    }
    if (!active) {
      setPenTool(penRef.current);
    }
    setOpened(true);
  }, [active, opened, setPenTool]);

  const pickPen = useCallback(
    (nextPen: Pen) => {
      penRef.current = nextPen;
      setPen(nextPen);
      setPenTool(nextPen);
    },
    [setPenTool],
  );

  const updatePenProps = useCallback(
    (props: Record<string, unknown>) => {
      const currentPen = penRef.current;
      editProps.recordLastProps(currentPen, props);
      setPenTool(currentPen);
    },
    [editProps, setPenTool],
  );

  const brushColor = keepColor(
    themeProvider.generateColorProperty(
      lastProps.brush.color,
      undefined,
      theme,
    ),
  );
  const highlighterColor = keepColor(
    themeProvider.generateColorProperty(
      lastProps.highlighter.color,
      undefined,
      theme,
    ),
  );
  const icons = penIconMap[appTheme];
  const activeColor = pen === "brush" ? brushColor : highlighterColor;
  const activeLineWidth =
    pen === "brush"
      ? lastProps.brush.lineWidth
      : lastProps.highlighter.lineWidth;
  const lineWidths =
    pen === "brush" ? BRUSH_LINE_WIDTHS : HIGHLIGHTER_LINE_WIDTHS;

  const brushLabel = t["com.myoxus.keyboardShortcuts.pen"]();
  const highlighterLabel = t["com.myoxus.editor.tool.highlighter"]();
  const activeLabel = pen === "brush" ? brushLabel : highlighterLabel;

  const popoverControls: EditorCanvasPopoverControls = {
    opened,
    onClose: () => setOpened(false),
    position: "top",
    offset: 16,
    closeOnClickOutside: false,
    label: activeLabel,
    testId: "canvas-pen-menu",
    trigger: {
      expanded: opened,
      action: {
        id: "canvas-pen",
        label: activeLabel,
        shortcut: penInfoMap[pen].shortcut,
        disabled: false,
        active,
        run: toggleMenu,
      },
      artworkSvg: icons[pen],
      artworkColor: activeColor,
      artworkBounds: { width: 42, height: 64 },
    },
    content: {
      kind: "menu",
      controls: {
        tools: [
          {
            action: {
              id: "canvas-brush",
              label: brushLabel,
              shortcut: penInfoMap.brush.shortcut,
              disabled: false,
              active: pen === "brush",
              run: () => pickPen("brush"),
            },
            artworkSvg: icons.brush,
            artworkColor: brushColor,
            artworkBounds: { width: 38, height: 64 },
          },
          {
            action: {
              id: "canvas-highlighter",
              label: highlighterLabel,
              shortcut: penInfoMap.highlighter.shortcut,
              disabled: false,
              active: pen === "highlighter",
              run: () => pickPen("highlighter"),
            },
            artworkSvg: icons.highlighter,
            artworkColor: highlighterColor,
            artworkBounds: { width: 38, height: 64 },
          },
        ],
        actions: [
          {
            id: "canvas-pen-width",
            label:
              t["com.myoxus.settings.editorSettings.edgeless.pen.thickness"](),
            disabled: false,
            control: {
              type: "number",
              value: activeLineWidth,
              presets: lineWidths,
              change: (value) => updatePenProps({ lineWidth: Number(value) }),
            },
          },
          {
            id: "canvas-pen-color",
            label: t["com.myoxus.settings.editorSettings.edgeless.pen.color"](),
            disabled: false,
            control: createToolbarColorControl({
              value: activeColor,
              theme,
              palettes: DefaultTheme.StrokeColorShortPalettes,
              custom: false,
              change: (value) => {
                const nextColor =
                  penRef.current === "highlighter"
                    ? adjustColorAlpha(value, 0.3)
                    : value;
                updatePenProps({ color: nextColor });
              },
            }),
          },
        ],
      },
    },
  };

  return (
    <Box component="span" data-drawing-tool={pen}>
      <EditorCanvasPopover controls={popoverControls} withinPortal={false} />
    </Box>
  );
}

/** Direct AGPL React controller for the Edgeless Eraser dock tool. */
export function EditorCanvasEraserTool({
  edgeless,
}: {
  edgeless: BlockComponent;
}) {
  const t = useI18n();
  const gfx = edgeless.std.get(GfxControllerIdentifier);
  const themeProvider = edgeless.std.get(ThemeProvider);

  const currentToolName = useSignalValue(gfx.tool.currentToolName$);
  const appTheme = useSignalValue(themeProvider.app$);

  useEffect(() => {
    const disposable = edgeless.bindHotKey(
      {
        Escape: () => {
          if (gfx.tool.currentToolOption$.peek()?.toolType === EraserTool) {
            gfx.tool.setTool(DefaultTool);
          }
        },
      },
      { global: true },
    );
    return () => {
      disposable();
    };
  }, [edgeless, gfx]);

  const icon =
    appTheme === "dark" ? EdgelessEraserDarkIcon : EdgelessEraserLightIcon;

  return (
    <EditorCanvasTool
      action={{
        id: "canvas-eraser",
        label: t["com.myoxus.editor.tool.eraser"](),
        shortcut: "E",
        disabled: false,
        active: currentToolName === EraserTool.toolName,
        run: () => gfx.tool.setTool(EraserTool),
      }}
      artworkSvg={icon}
      artworkBounds={{ width: 49, height: 64 }}
    />
  );
}

/** Combined Pen + Eraser senior dock slot preserving the side-by-side layout. */
export function EditorCanvasPenAndEraserTools({
  edgeless,
  registerActivePopover,
}: {
  edgeless: BlockComponent;
  registerActivePopover: PopoverRegistrar;
}) {
  return (
    <Group wrap="nowrap" gap="xs">
      <EditorCanvasPenTool
        edgeless={edgeless}
        registerActivePopover={registerActivePopover}
      />
      <EditorCanvasEraserTool edgeless={edgeless} />
    </Group>
  );
}

interface DockShapeCard {
  readonly name: ShapeName;
  readonly svg: string;
  readonly defaultX: number;
  readonly defaultY: number;
  readonly hoverY: number;
}

const DOCK_SHAPE_CARDS: readonly DockShapeCard[] = [
  {
    name: "roundedRect",
    svg: roundedSvg,
    defaultX: -9,
    defaultY: 4,
    hoverY: -7,
  },
  {
    name: ShapeType.Ellipse,
    svg: ellipseSvg,
    defaultX: -20,
    defaultY: 29,
    hoverY: 13,
  },
  {
    name: ShapeType.Triangle,
    svg: triangleSvg,
    defaultX: 18,
    defaultY: 23,
    hoverY: 5,
  },
];

function SvgMarkup({ markup }: { markup: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = markup;
    const svg = el.querySelector("svg");
    if (svg) svg.style.display = "block";
    return () => {
      el.replaceChildren();
    };
  }, [markup]);
  return <Box component="span" ref={ref} style={{ display: "contents" }} />;
}

/** Stacked 3-shape draggable dock preview wired to `startCanvasDragInsert`. */
function ShapeStackArtwork({
  edgeless,
  draggingShape,
  onStartDrag,
}: {
  edgeless: BlockComponent;
  draggingShape: ShapeName | null;
  onStartDrag: (
    card: DockShapeCard,
    element: HTMLElement,
    clientX: number,
    clientY: number,
    style: { color: string; stroke: string },
  ) => void;
}) {
  const editProps = edgeless.std.get(EditPropsStore);
  const themeProvider = edgeless.std.get(ThemeProvider);
  const lastProps = useSignalValue(editProps.lastProps$);
  // Subscribe to theme changes so resolved fill/stroke tokens refresh immediately.
  useSignalValue(themeProvider.theme$);
  const [hoveredShape, setHoveredShape] = useState<ShapeName | null>(null);

  return (
    <Box
      style={{
        width: 96,
        height: 64,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {DOCK_SHAPE_CARDS.map((card) => {
        const props = lastProps[`shape:${card.name}`];
        const color = themeProvider.generateColorProperty(props?.fillColor);
        const stroke = themeProvider.generateColorProperty(props?.strokeColor);
        const isHovered = hoveredShape === card.name;
        const isDragging = draggingShape === card.name;
        return (
          <Box
            key={card.name}
            data-shape-card={card.name}
            onMouseEnter={() => setHoveredShape(card.name)}
            onMouseLeave={() =>
              setHoveredShape((prev) => (prev === card.name ? null : prev))
            }
            // Prevent the outer toolbar IconButton's pointerdown preventDefault from
            // blocking mouse drag tracking on the individual shape cards.
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              event.preventDefault();
              onStartDrag(
                card,
                event.currentTarget,
                event.clientX,
                event.clientY,
                { color, stroke },
              );
            }}
            onTouchStart={(event) => {
              const touch = event.touches[0];
              if (!touch) return;
              event.stopPropagation();
              onStartDrag(
                card,
                event.currentTarget,
                touch.clientX,
                touch.clientY,
                { color, stroke },
              );
            }}
            onClick={(event) => event.stopPropagation()}
            style={{
              position: "absolute",
              width: "fit-content",
              height: "fit-content",
              cursor: "grab",
              color,
              stroke,
              filter: "drop-shadow(0 0 4px var(--myoxus-border-color))",
              opacity: isDragging ? 0 : 1,
              zIndex: isHovered ? 1 : 0,
              transform: `translateX(${card.defaultX}px) translateY(${isHovered ? card.hoverY : card.defaultY}px)`,
              transition: "transform 0.3s, z-index 0.1s",
            }}
          >
            <SvgMarkup markup={card.svg} />
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Direct AGPL React controller for the Edgeless Shape dock tool, style submenu,
 * `s` hotkey cycling, and drag-to-canvas insertion via `startCanvasDragInsert`.
 */
export function EditorCanvasShapeTool({
  edgeless,
  registerActivePopover,
}: {
  edgeless: BlockComponent;
  registerActivePopover: PopoverRegistrar;
}) {
  const t = useI18n();
  const gfx = edgeless.std.get(GfxControllerIdentifier);
  const crud = edgeless.std.get(EdgelessCRUDIdentifier);
  const editProps = edgeless.std.get(EditPropsStore);
  const themeProvider = edgeless.std.get(ThemeProvider);
  const i18n = edgeless.std.getOptional(EditorI18nProvider) ?? undefined;

  const currentToolName = useSignalValue(gfx.tool.currentToolName$);
  const lastProps = useSignalValue(editProps.lastProps$);
  const theme = useSignalValue(themeProvider.theme$);

  const [opened, setOpened] = useState(false);
  const [shapeName, setShapeName] = useState<ShapeName>(ShapeType.Rect);
  const [draggingShape, setDraggingShape] = useState<ShapeName | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const active = currentToolName === ShapeTool.toolName;

  useActiveDockPopover(opened, setOpened, registerActivePopover);

  useEffect(() => {
    return effect(() => {
      const tool = gfx.tool.currentToolOption$.value;
      if (tool?.toolType === ShapeTool) {
        const nextName = (tool as ToolOptionWithType<ShapeTool>).options
          ?.shapeName;
        if (nextName) {
          setShapeName(nextName);
        }
      }
    });
  }, [gfx]);

  useEffect(() => {
    return gfx.tool.currentToolName$.subscribe((name) => {
      if (name !== ShapeTool.toolName) {
        setOpened(false);
      }
    });
  }, [gfx]);

  useEffect(() => {
    const disposable = edgeless.bindHotKey(
      {
        s: (ctx) => {
          if (ctx.get("keyboardState").raw.shiftKey) return;
          if (gfx.viewport.locked || gfx.selection.editing) return;
          if (gfx.tool.dragging$.peek()) return;

          const currentName = gfx.tool.currentToolName$.peek();
          const shapeTool = gfx.tool.get(ShapeTool);
          const nextShape =
            currentName === ShapeTool.toolName
              ? shapeTool.cycleShapeName("next")
              : shapeTool.activatedOption.shapeName;
          gfx.tool.setTool(ShapeTool, { shapeName: nextShape });
        },
      },
      { global: true },
    );
    return () => {
      disposable();
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, [edgeless, gfx]);

  const setShapeOverlayLock = useCallback(
    (locked: boolean) => {
      const controller = gfx.tool.currentTool$.peek();
      if (controller instanceof ShapeTool) {
        controller.setDisableOverlay(locked);
      }
    },
    [gfx],
  );

  const refreshShapeOverlay = useCallback(() => {
    const controller = gfx.tool.currentTool$.peek();
    if (controller instanceof ShapeTool) {
      controller.createOverlay();
    }
  }, [gfx]);

  const selectShape = useCallback(
    (nextName: ShapeName) => {
      setShapeName(nextName);
      gfx.tool.setTool(ShapeTool, { shapeName: nextName });
      refreshShapeOverlay();
    },
    [gfx, refreshShapeOverlay],
  );

  const handleWrapperClick = useCallback(() => {
    if (active && opened) {
      setOpened(false);
      return;
    }
    setShapeName(ShapeType.Rect);
    gfx.tool.setTool(ShapeTool, { shapeName: ShapeType.Rect });
    setOpened(true);
  }, [active, gfx, opened]);

  const handleStartDrag = useCallback(
    (
      card: DockShapeCard,
      element: HTMLElement,
      clientX: number,
      clientY: number,
      previewStyle: { color: string; stroke: string },
    ) => {
      if (edgeless.store.readonly) return;
      dragCleanupRef.current?.();
      dragCleanupRef.current = startCanvasDragInsert<DockShapeCard>({
        edgeless,
        data: card,
        sourceElement: element,
        preview: { kind: "svg", markup: card.svg },
        standardWidth: 100,
        previewStyle,
        startClientX: clientX,
        startClientY: clientY,
        onDragStart: () => {
          setDraggingShape(card.name);
          setOpened(false);
          gfx.tool.setTool(ShapeTool, { shapeName: card.name });
          const controller = gfx.tool.currentTool$.peek();
          if (controller instanceof ShapeTool) {
            controller.clearOverlay();
            controller.setDisableOverlay(true);
          }
        },
        onClick: (clicked) => {
          setShapeName(clicked.name);
          gfx.tool.setTool(ShapeTool, { shapeName: clicked.name });
          setOpened(true);
        },
        onDrop: (dropped, bound) => {
          setDraggingShape(null);
          const id = crud.addElement(CanvasElementType.SHAPE, {
            shapeType: getShapeType(dropped.name),
            xywh: bound.serialize(),
            radius: getShapeRadius(dropped.name),
          });
          setShapeOverlayLock(false);
          if (!id) return;
          edgeless.std
            .getOptional(TelemetryProvider)
            ?.track("CanvasElementAdded", {
              control: "toolbar:dnd",
              page: "whiteboard editor",
              module: "toolbar",
              segment: "toolbar",
              type: "shape",
              other: {
                shapeType: getShapeType(dropped.name),
              },
            });
          gfx.tool.setTool(DefaultTool);
          gfx.selection.set({
            elements: [id],
            editing: false,
          });
        },
        onCancel: () => {
          setDraggingShape(null);
          setShapeOverlayLock(false);
        },
      });
    },
    [crud, edgeless, gfx, setShapeOverlayLock],
  );

  const setFillColor = useCallback(
    ({ key, value }: Palette) => {
      const filled = !isTransparent(value);
      const strokeColor = filled
        ? DefaultTheme.StrokeColorShortPalettes.find(
            (palette) => palette.key === key,
          )?.value
        : DefaultTheme.StrokeColorShortMap.Grey;

      editProps.recordLastProps(`shape:${shapeName}`, {
        filled,
        fillColor: value,
        strokeColor,
      });
      selectShape(shapeName);
    },
    [editProps, selectShape, shapeName],
  );

  const shapeProps = lastProps[`shape:${shapeName}`];
  const { shapeStyle, fillColor } = shapeProps;
  const label = t["com.myoxus.keyboardShortcuts.shape"]();

  const popoverControls: EditorCanvasPopoverControls = {
    opened,
    onClose: () => setOpened(false),
    position: "top",
    offset: 16,
    closeOnClickOutside: false,
    label,
    testId: "canvas-shape-menu",
    trigger: {
      expanded: opened,
      action: {
        id: "canvas-shape",
        label,
        shortcut: "S",
        active,
        disabled: false,
        run: handleWrapperClick,
      },
      artworkBounds: { width: 96, height: 64 },
      nativeArtwork: (
        <ShapeStackArtwork
          edgeless={edgeless}
          draggingShape={draggingShape}
          onStartDrag={handleStartDrag}
        />
      ),
    },
    content: {
      kind: "menu",
      controls: {
        tools: ShapeComponentConfig.map(
          ({ name, iconName, scribbledIcon, tooltip }) => ({
            action: {
              id: `canvas-shape-${name}`,
              icon: shapeStyle === ShapeStyle.General ? iconName : undefined,
              label: resolveEditorMessage(tooltip, i18n),
              active: shapeName === name,
              disabled: false,
              run: () => selectShape(name),
            },
            artworkSvg:
              shapeStyle === ShapeStyle.General ? undefined : scribbledIcon,
          }),
        ),
        actions: [
          {
            id: "canvas-shape-color",
            label: t["com.myoxus.settings.editorSettings.edgeless.pen.color"](),
            disabled: false,
            control: createToolbarColorControl({
              value: resolveColor(fillColor, theme),
              theme,
              palettes: DefaultTheme.FillColorShortPalettes,
              custom: false,
              change: (value) => {
                const palette = DefaultTheme.FillColorShortPalettes.find(
                  (item) => item.value === value,
                );
                if (palette) setFillColor(palette);
              },
            }),
          },
        ],
      },
    },
  };

  return (
    <EditorCanvasPopover controls={popoverControls} withinPortal={false} />
  );
}
