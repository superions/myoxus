// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button, Divider, Group, MyoxusText } from "@myoxus/ui-facade";
import { effect } from "@preact/signals-core";
import {
  EdgelessFrameManagerIdentifier,
  isFrameBlock,
  type NavigatorMode,
  PresentTool,
} from "@virgultum/editor/blocks/frame";
import {
  DefaultTool,
  EdgelessCRUDIdentifier,
  EdgelessLegacySlotIdentifier,
} from "@virgultum/editor/blocks/surface";
import { PanTool } from "@virgultum/editor/gfx/pointer";
import { Bound, clamp } from "@virgultum/editor/global/gfx";
import {
  EditPropsStore,
  type EditorCanvasDockControls,
  type EditorCanvasPopoverControls,
  EditorI18nProvider,
  type EditorI18nMessage,
  editorMessage,
  resolveEditorMessage,
  ViewportElementProvider,
} from "@virgultum/editor/shared/services";
import { editorToast } from "@virgultum/editor/shared/utils";
import {
  generateKeyBetweenV2,
  GfxControllerIdentifier,
  type ToolOptions,
} from "@virgultum/editor/std/gfx";
import { useCallback, useEffect, useRef, useState } from "react";

import { EditorCanvasPopover } from "./canvas-popover";
import { EditorCanvasTool } from "./canvas-toolbar";

type PresentationProps = {
  readonly edgeless: EditorCanvasDockControls["edgeless"];
  readonly frameMenuShow: boolean;
  readonly settingMenuShow: boolean;
  readonly setFrameMenuShow: (open: boolean) => void;
  readonly setSettingMenuShow: (open: boolean) => void;
};

function requestElementFullscreen(element: Element) {
  if (element.requestFullscreen) {
    element.requestFullscreen().catch(() => {
      // Headless or policy-restricted contexts reject fullscreen without user gesture.
    });
  } else if (
    "webkitRequestFullscreen" in element &&
    element.webkitRequestFullscreen instanceof Function
  ) {
    element.webkitRequestFullscreen();
  }
}

/**
 * Direct AGPL React/signal controller for Edgeless Presentation mode.
 * Coordinates frame stepping, fullscreen, playback settings, drag reordering,
 * and global hotkeys without an intermediate custom element.
 */
export function EditorPresentationToolbar({
  presentation,
}: {
  presentation: PresentationProps;
}) {
  const {
    edgeless,
    frameMenuShow,
    settingMenuShow,
    setFrameMenuShow,
    setSettingMenuShow,
  } = presentation;
  const std = edgeless.std;
  const gfx = std.get(GfxControllerIdentifier);
  const frameManager = std.get(EdgelessFrameManagerIdentifier);
  const editProps = std.get(EditPropsStore);
  const slots = std.get(EdgelessLegacySlotIdentifier);

  const resolveText = useCallback(
    (message: EditorI18nMessage) =>
      resolveEditorMessage(
        message,
        std.getOptional(EditorI18nProvider) ?? undefined,
      ),
    [std],
  );

  const initialFrameIndex = () => {
    const selected = gfx.selection.selectedElements[0];
    if (selected && isFrameBlock(selected)) {
      const idx = frameManager.frames.findIndex((f) => f.id === selected.id);
      if (idx !== -1) return idx;
    }
    return 0;
  };

  const [currentFrameIndex, setCurrentFrameIndex] = useState(initialFrameIndex);
  const [navigatorMode, setNavigatorMode] = useState<NavigatorMode>(() => {
    const toolOption = gfx.tool.currentToolOption$.peek();
    const opts = toolOption?.options as ToolOptions<PresentTool> | undefined;
    if (opts?.mode) return opts.mode;
    return editProps.getStorage("presentFillScreen") === true ? "fill" : "fit";
  });
  const [blackBackground, setBlackBackground] = useState<boolean>(
    () => editProps.getStorage("presentBlackBackground") ?? false,
  );
  const [hideToolbar, setHideToolbar] = useState<boolean>(() =>
    Boolean(editProps.getStorage("presentHideToolbar")),
  );
  const [fullscreenActive, setFullscreenActive] = useState<boolean>(() =>
    Boolean(document.fullscreenElement),
  );
  const [, bumpRevision] = useState(0);

  const currentFrameIndexRef = useRef(currentFrameIndex);
  currentFrameIndexRef.current = currentFrameIndex;
  const navigatorModeRef = useRef(navigatorMode);
  navigatorModeRef.current = navigatorMode;
  const fullScreenModeRef = useRef(true);
  const cachedIndexRef = useRef(currentFrameIndex);

  const moveToFrame = useCallback(
    (index: number, forceMove = false) => {
      const currentToolOption = gfx.tool.currentToolOption$.peek();
      const toolOptions = currentToolOption?.options as
        ToolOptions<PresentTool> | undefined;

      if (
        currentToolOption?.toolType === PresentTool &&
        toolOptions?.restoredAfterPan &&
        !forceMove
      ) {
        const currentTool = gfx.tool.currentTool$.peek();
        if (currentTool?.activatedOption) {
          currentTool.activatedOption.restoredAfterPan = false;
        }
        return;
      }

      const frame = frameManager.frames[index];
      if (!frame) return;

      const viewport = gfx.viewport;
      let bound = Bound.deserialize(frame.xywh);
      if (navigatorModeRef.current === "fill") {
        const vb = viewport.viewportBounds;
        const center = bound.center;
        let w: number;
        let h: number;
        if (vb.w / vb.h > bound.w / bound.h) {
          w = bound.w;
          h = (w * vb.h) / vb.w;
        } else {
          h = bound.h;
          w = (h * vb.w) / vb.h;
        }
        bound = Bound.fromCenter(center, w, h);
      }

      viewport.setViewportByBound(bound, [0, 0, 0, 0], false);
      slots.navigatorFrameChanged.next(frame);
    },
    [frameManager, gfx, slots],
  );

  const exitPresentation = useCallback(() => {
    if (edgeless.store.readonly) {
      gfx.tool.setTool(PanTool, { panning: false });
    } else {
      gfx.tool.setTool(DefaultTool);
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    editProps.setStorage("presentNoFrameToastShown", false);
  }, [edgeless.store.readonly, editProps, gfx]);

  const stepFrame = useCallback(
    (delta: -1 | 1) => {
      const frames = frameManager.frames;
      const current = currentFrameIndexRef.current;
      if (delta === 1 && current >= frames.length - 1) {
        editorToast(
          edgeless.host,
          editorMessage(
            "com.myoxus.editor.presentation.last-frame",
            "You have reached the last frame",
          ),
        );
        return;
      }
      if (delta === -1 && current <= 0) {
        editorToast(
          edgeless.host,
          editorMessage(
            "com.myoxus.editor.presentation.first-frame",
            "You have reached the first frame",
          ),
        );
        return;
      }
      const next = clamp(current + delta, 0, Math.max(frames.length - 1, 0));
      currentFrameIndexRef.current = next;
      setCurrentFrameIndex(next);
      moveToFrame(next, true);
    },
    [edgeless.host, frameManager, moveToFrame],
  );

  const toggleFullScreen = useCallback(() => {
    if (document.fullscreenElement) {
      fullScreenModeRef.current = false;
      document.exitFullscreen().catch(() => {});
    } else {
      const { viewportElement } = std.get(ViewportElementProvider);
      fullScreenModeRef.current = true;
      requestElementFullscreen(viewportElement);
    }
  }, [std]);

  const handleBlackBackgroundChange = useCallback(
    (checked: boolean) => {
      setBlackBackground(checked);
      slots.navigatorSettingUpdated.next({ blackBackground: checked });
      editProps.setStorage("presentBlackBackground", checked);
    },
    [editProps, slots],
  );

  const handleHideToolbarChange = useCallback(
    (checked: boolean) => {
      setHideToolbar(checked);
      editProps.setStorage("presentHideToolbar", checked);
    },
    [editProps],
  );

  const moveFrame = useCallback(
    (id: string, before: string | null) => {
      if (edgeless.store.readonly || id === before) return;
      const frames = frameManager.frames;
      const source = frames.findIndex((frame) => frame.id === id);
      const target =
        before === null
          ? frames.length
          : frames.findIndex((frame) => frame.id === before);
      if (
        source < 0 ||
        target < 0 ||
        target === source ||
        target === source + 1
      ) {
        return;
      }

      frameManager.refreshLegacyFrameOrder();
      const neighbours = frameManager.frames.filter((frame) => frame.id !== id);
      const insertion =
        before === null
          ? neighbours.length
          : neighbours.findIndex((frame) => frame.id === before);
      std.get(EdgelessCRUDIdentifier).updateElement(id, {
        presentationIndex: generateKeyBetweenV2(
          neighbours[insertion - 1]?.props.presentationIndex || null,
          neighbours[insertion]?.props.presentationIndex || null,
        ),
      });
      edgeless.store.captureSync();
      bumpRevision((v) => v + 1);
    },
    [edgeless.store, frameManager, std],
  );

  useEffect(() => {
    let enterTimer: ReturnType<typeof setTimeout> | undefined;
    let moveTimer: ReturnType<typeof setTimeout> | undefined;

    const disposeToolEffect = effect(() => {
      const currentToolOption = gfx.tool.currentToolOption$.value;
      if (currentToolOption?.toolType !== PresentTool) return;

      const opts = currentToolOption.options as
        ToolOptions<PresentTool> | undefined;
      if (!document.fullscreenElement) {
        toggleFullScreen();
      } else {
        fullScreenModeRef.current = true;
      }

      let nextIndex = currentFrameIndexRef.current;
      const selected = gfx.selection.selectedElements[0];
      if (selected && isFrameBlock(selected)) {
        const idx = frameManager.frames.findIndex((f) => f.id === selected.id);
        if (idx !== -1) nextIndex = idx;
      }
      cachedIndexRef.current = nextIndex;
      currentFrameIndexRef.current = nextIndex;
      setCurrentFrameIndex(nextIndex);

      if (opts?.mode) {
        navigatorModeRef.current = opts.mode;
        setNavigatorMode(opts.mode);
      }

      if (frameManager.frames.length === 0) {
        if (!editProps.getStorage("presentNoFrameToastShown")) {
          editorToast(
            edgeless.host,
            editorMessage(
              "com.myoxus.editor.presentation.no-frame-toast",
              "The presentation requires at least 1 frame. Create a frame first.",
            ),
            5000,
          );
          editProps.setStorage("presentNoFrameToastShown", true);
        }
      } else if (editProps.getStorage("presentNoFrameToastShown")) {
        editProps.setStorage("presentNoFrameToastShown", false);
      }

      moveToFrame(nextIndex, !opts?.restoredAfterPan);
    });

    const handleKeyIfPresenting = (action: () => void) => () => {
      if (gfx.tool.currentToolOption$.peek()?.toolType === PresentTool) {
        action();
      }
    };
    const disposeHotkeys = edgeless.bindHotKey(
      {
        ArrowLeft: handleKeyIfPresenting(() => stepFrame(-1)),
        ArrowRight: handleKeyIfPresenting(() => stepFrame(1)),
        Escape: handleKeyIfPresenting(exitPresentation),
      },
      { global: true },
    );

    const settingSub = slots.navigatorSettingUpdated.subscribe(
      ({ fillScreen, blackBackground: nextBg }) => {
        if (fillScreen !== undefined) {
          const nextMode: NavigatorMode = fillScreen ? "fill" : "fit";
          navigatorModeRef.current = nextMode;
          setNavigatorMode(nextMode);
        }
        if (nextBg !== undefined) {
          setBlackBackground(nextBg);
        }
      },
    );

    const blockSub = edgeless.store.slots.blockUpdated.subscribe(() => {
      bumpRevision((v) => v + 1);
    });

    const i18n = std.getOptional(EditorI18nProvider);
    const disposeLocale = i18n
      ? effect(() => {
          void i18n.locale$.value;
          bumpRevision((v) => v + 1);
        })
      : undefined;

    const onFullscreenChange = () => {
      setFullscreenActive(Boolean(document.fullscreenElement));
      if (document.fullscreenElement) {
        enterTimer = setTimeout(() => {
          const idx = cachedIndexRef.current;
          currentFrameIndexRef.current = idx;
          setCurrentFrameIndex(idx);
          moveToFrame(idx, true);
        }, 400);
      } else {
        clearTimeout(enterTimer);
        if (
          gfx.tool.currentToolOption$.peek()?.toolType === PresentTool &&
          fullScreenModeRef.current
        ) {
          exitPresentation();
        }
      }
      clearTimeout(moveTimer);
      moveTimer = setTimeout(
        () => moveToFrame(currentFrameIndexRef.current, true),
        400,
      );
      slots.fullScreenToggled.next();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);

    return () => {
      clearTimeout(enterTimer);
      clearTimeout(moveTimer);
      disposeToolEffect();
      disposeHotkeys();
      settingSub.unsubscribe();
      blockSub.unsubscribe();
      disposeLocale?.();
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [
    edgeless,
    editProps,
    exitPresentation,
    frameManager,
    gfx,
    moveToFrame,
    slots,
    std,
    stepFrame,
    toggleFullScreen,
  ]);

  const frames = frameManager.frames;
  const safeIndex =
    frames.length === 0 ? 0 : clamp(currentFrameIndex, 0, frames.length - 1);
  const currentFrame = frames[safeIndex];
  const readonly = edgeless.store.readonly;

  const title =
    currentFrame?.props.title.toString() ||
    resolveText(
      editorMessage("com.myoxus.editor.presentation.no-frame", "No frame"),
    );
  const count = `${frames.length === 0 ? 0 : safeIndex + 1} / ${frames.length}`;

  const frameOrderLabel = resolveText(
    editorMessage("com.myoxus.editor.presentation.frame-order", "Frame order"),
  );
  const settingsLabel = resolveText(
    editorMessage("com.myoxus.sidebar.outline.settings", "Settings"),
  );

  const frameOrderPopover: EditorCanvasPopoverControls = {
    opened: frameMenuShow && !readonly,
    onClose: () => setFrameMenuShow(false),
    position: "top",
    offset: 16,
    label: frameOrderLabel,
    trigger: {
      action: {
        id: "presentation-frame-order",
        icon: "LayerIcon",
        label: frameOrderLabel,
        disabled: readonly,
        run: () => {
          if (readonly) return;
          setFrameMenuShow(!frameMenuShow);
        },
      },
      expanded: frameMenuShow,
    },
    content: {
      kind: "frame-order",
      controls: {
        items: frames.map((item) => ({
          id: item.id,
          title: item.props.title.toString(),
        })),
        embedded: false,
        readonly,
        move: moveFrame,
      },
    },
  };

  const settingsPopover: EditorCanvasPopoverControls = {
    opened: settingMenuShow,
    onClose: () => setSettingMenuShow(false),
    position: "top",
    offset: 16,
    label: settingsLabel,
    trigger: {
      action: {
        id: "presentation-settings",
        icon: "SettingsIcon",
        label: settingsLabel,
        disabled: false,
        run: () => setSettingMenuShow(!settingMenuShow),
      },
      expanded: settingMenuShow,
    },
    content: {
      kind: "menu",
      controls: {
        actions: [
          {
            id: "presentation-settings-label",
            label: resolveText(
              editorMessage(
                "com.myoxus.sidebar.frame.playback-settings",
                "Playback Settings",
              ),
            ),
            disabled: false,
          },
          {
            id: "presentation-dark-background",
            label: resolveText(
              editorMessage(
                "com.myoxus.sidebar.frame.dark-background",
                "Black background",
              ),
            ),
            disabled: false,
            control: {
              type: "toggle",
              checked: blackBackground,
              change: handleBlackBackgroundChange,
            },
          },
          {
            id: "presentation-hide-toolbar",
            label: resolveText(
              editorMessage(
                "com.myoxus.sidebar.frame.hide-toolbar",
                "Hide toolbar",
              ),
            ),
            disabled: false,
            control: {
              type: "toggle",
              checked: hideToolbar,
              change: handleHideToolbarChange,
            },
          },
        ],
      },
    },
  };

  return (
    <Group wrap="nowrap" gap="xs" align="center">
      <EditorCanvasTool
        action={{
          id: "presentation-previous",
          icon: "StartPointArrowIcon",
          label: resolveText(
            editorMessage(
              "com.myoxus.editor.presentation.previous",
              "Previous",
            ),
          ),
          disabled: false,
          run: () => stepFrame(-1),
        }}
      />
      <Button
        variant="plain"
        size="compact-sm"
        onClick={() => moveToFrame(safeIndex, true)}
      >
        <Group wrap="nowrap" gap="xs" align="center">
          <MyoxusText
            component="span"
            typographySlot="body-small"
            truncate
            maw={140}
            data-testid="presentation-frame-title"
          >
            {title}
          </MyoxusText>
          <MyoxusText
            component="span"
            tone="secondary"
            typographySlot="dense-label"
          >
            {count}
          </MyoxusText>
        </Group>
      </Button>
      <EditorCanvasTool
        action={{
          id: "presentation-next",
          icon: "EndPointArrowIcon",
          label: resolveText(
            editorMessage("com.myoxus.editor.presentation.next", "Next"),
          ),
          disabled: false,
          run: () => stepFrame(1),
        }}
      />
      <Divider orientation="vertical" />
      <Group wrap="nowrap" gap="xs" align="center">
        <EditorCanvasTool
          action={{
            id: "presentation-fullscreen",
            icon: fullscreenActive ? "ExpandCloseIcon" : "ExpandFullIcon",
            label: resolveText(
              editorMessage(
                "com.myoxus.workbench.split-view-menu.full-screen",
                "Full screen",
              ),
            ),
            active: fullscreenActive,
            disabled: false,
            run: toggleFullScreen,
          }}
        />
        <EditorCanvasPopover
          controls={frameOrderPopover}
          withinPortal={false}
        />
        <EditorCanvasPopover controls={settingsPopover} withinPortal={false} />
      </Group>
      <Divider orientation="vertical" />
      <EditorCanvasTool
        action={{
          id: "presentation-stop",
          icon: "StopAiIcon",
          label: resolveText(
            editorMessage("com.myoxus.peek-view-controls.close", "Close"),
          ),
          disabled: false,
          run: exitPresentation,
        }}
      />
    </Group>
  );
}
