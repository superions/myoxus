// SPDX-License-Identifier: AGPL-3.0-or-later
import { useLayoutEffect, useRef } from "react";
import { CursorSelection } from "@virgultum/core/runtime";
import { StoreSelectionExtension } from "@virgultum/core/store";
import { mountCanvasPeerOverlay } from "@virgultum/editor/widgets/remote-selection/canvas";
import { canvasCameraStorage } from "@virgultum/core/services";
import { EditorService } from "../../../modules/editor";
import { EditorSettingService } from "../../../modules/editor-setting";
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import { useService, useLiveData } from "@myoxus/infra";
import { DocsService } from "../../../modules/doc";
import { ColorScheme } from "@virgultum/core/models";
import { EMBED_CARD_HEIGHT } from "@virgultum/core/consts";
import { ViewportColors } from "@virgultum/core/services/data";
import { Bound, getCommonBound } from "@virgultum/core/primitives/gfx";
import {
  FIT_TO_SCREEN_PADDING,
  ZOOM_INITIAL,
  type SurfaceBlockModel,
  type Viewport,
} from "@virgultum/core/runtime/gfx";
import {
  mountCanvasScene,
  getBgGridGap,
  wheelCanvas,
  cameraPan,
} from "@virgultum/editor/blocks/surface";
import { canvasPainters } from "@virgultum/editor/gfx/painters";

export default function CanvasPreview({
  surface,
  title,
  mode = "embed",
  targetId,
  refreshKey,
}: {
  surface: SurfaceBlockModel;
  title: string;
  mode?: "embed" | "document" | "snapshot";
  targetId?: string;
  refreshKey?: string;
}) {
  const interactive = mode !== "embed";
  const liveDocument = mode === "document";
  const record = useLiveData(
      useService(DocsService).list.doc$(surface.store.id),
    ),
    scheme = useLiveData(record?.edgelessColorTheme$);
  const root = useRef<HTMLDivElement>(null),
    theme = useMyoxusTheme().resolvedTheme;
  const color =
    (scheme === "system" || !scheme ? theme : scheme) === "dark"
      ? ColorScheme.Dark
      : ColorScheme.Light;
  const activeCamera = useRef<Viewport | null>(null);
  const editor = useService(EditorService).editor,
    settings = useService(EditorSettingService).editorSetting;
  useLayoutEffect(() => {
    const el = root.current!,
      colors = new ViewportColors(() => color);
    const scene = mountCanvasScene(el, surface, {
      resolvePainter: canvasPainters(),
      turboEnabled: () => false,
      provider: {
        getColorScheme: () => color,
        getColorValue: colors.getColorValue.bind(colors),
        generateColorProperty: colors.generateColorProperty.bind(colors),
        getPropertyValue: colors.getCssVariableColor.bind(colors),
      },
    });
    const camera = scene.viewport;
    activeCamera.current = camera;
    const fit = () => {
      // Match the document viewport's fit, including the authored bounds of
      // Page-only notes even though their contents are not painted on Canvas.
      const bounds = getCommonBound(
        [...scene.layer.blocks, ...scene.layer.canvasElements].map((m) =>
          Bound.deserialize(m.xywh),
        ),
      );
      if (!bounds || !camera.width || !camera.height) return;
      const { zoom, centerX, centerY } = camera.getFitToScreenData(
        bounds,
        undefined,
        ZOOM_INITIAL,
        FIT_TO_SCREEN_PADDING,
      );
      camera.setViewport(zoom, [centerX, centerY]);
    };
    const grid = () => {
      const gap = getBgGridGap(camera.zoom);
      el.style.backgroundSize = `${gap}px ${gap}px`;
      el.style.backgroundPosition = `${camera.translateX}px ${camera.translateY}px`;
    };
    const changed = camera.viewportUpdated.subscribe(grid),
      size = !interactive ? camera.sizeUpdated.subscribe(fit) : undefined;
    const stop = new AbortController();
    const storage = canvasCameraStorage(surface.store.id);
    if (liveDocument) {
      const presence = el.ownerDocument.createElement("div");
      presence.dataset.canvasPeers = "";
      el.append(presence);
      const releasePeers = mountCanvasPeerOverlay(
        presence,
        surface.store,
        camera,
        surface,
        (id) => surface.getElementById(id),
      );
      const selection = surface.store.get(StoreSelectionExtension);
      let frame = 0;
      let cursor: CursorSelection | undefined;
      const publishCursor = (e: PointerEvent) => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const [x, y] = camera.toModelCoordFromClientCoord([
            e.clientX,
            e.clientY,
          ]);
          cursor = new CursorSelection(x, y);
          selection.setGroup("gfx", [
            ...selection
              .getGroup("gfx")
              .filter((value) => !value.is(CursorSelection)),
            cursor,
          ]);
        });
      };
      el.addEventListener("pointermove", publishCursor, {
        signal: stop.signal,
      });
      stop.signal.addEventListener(
        "abort",
        () => {
          cancelAnimationFrame(frame);
          if (cursor && selection.value.includes(cursor))
            selection.clear([CursorSelection.type]);
          releasePeers();
          presence.remove();
        },
        { once: true },
      );
    }
    if (interactive) {
      // Detached history fits the captured scene and never reads or publishes
      // the live document's camera or presence.
      const saved = liveDocument
        ? (editor.scrollPosition.edgeless ?? storage.read())
        : null;
      if (saved && "zoom" in saved)
        camera.setViewport(saved.zoom, [saved.centerX, saved.centerY]);
      else if (saved && "xywh" in saved)
        camera.setViewportByBound(Bound.deserialize(saved.xywh), saved.padding);
      else fit();
      let drag: number | null = null;
      const pan = cameraPan(camera);
      const opts = { signal: stop.signal };
      stop.signal.addEventListener(
        "abort",
        () => {
          pan.end();
          if (drag !== null && el.hasPointerCapture(drag))
            el.releasePointerCapture(drag);
        },
        { once: true },
      );
      el.addEventListener(
        "wheel",
        (e) =>
          wheelCanvas(
            camera,
            e,
            el.getBoundingClientRect(),
            settings.settings$.value?.edgelessScrollZoom ?? false,
          ),
        { ...opts, passive: false },
      );
      el.addEventListener(
        "pointerdown",
        (e) => {
          if (drag !== null || e.button > 2) return;
          e.preventDefault();
          el.focus({ preventScroll: true });
          el.setPointerCapture(e.pointerId);
          drag = e.pointerId;
          pan.start(e.clientX, e.clientY);
        },
        opts,
      );
      el.addEventListener(
        "pointermove",
        (e) => {
          if (e.pointerId === drag) pan.move(e.clientX, e.clientY);
        },
        opts,
      );
      const end = (e: PointerEvent) => {
        if (drag !== e.pointerId) return;
        pan.end();
        drag = null;
        if (el.hasPointerCapture(e.pointerId))
          el.releasePointerCapture(e.pointerId);
      };
      el.addEventListener("pointerup", end, opts);
      el.addEventListener("pointercancel", end, opts);
      el.addEventListener("lostpointercapture", end, opts);
    } else {
      surface.store.spaceDoc.on("afterTransaction", fit);
      fit();
    }
    grid();
    // Font loading may finish after reference replacement or permission loss.
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) scene.renderer.refresh();
    });
    return () => {
      live = false;
      stop.abort();
      if (liveDocument) {
        const position = {
          centerX: camera.centerX,
          centerY: camera.centerY,
          zoom: camera.zoom,
        };
        editor.scrollPosition.edgeless = position;
        if (editor.mode$.value === "edgeless")
          editor.workbenchView?.setScrollPosition(position);
        storage.write(position);
      } else if (!interactive)
        surface.store.spaceDoc.off("afterTransaction", fit);
      changed.unsubscribe();
      size?.unsubscribe();
      activeCamera.current = null;
      scene.dispose();
    };
  }, [surface, color, interactive, liveDocument, editor, settings]);
  useLayoutEffect(() => {
    const camera = activeCamera.current,
      el = root.current;
    const target = targetId && surface.getElementById(targetId);
    if (!camera || !el || !target || !interactive) return;
    const bounds = Bound.deserialize(target.xywh);
    const mark = el.ownerDocument.createElement("div");
    mark.dataset.canvasAnchor = target.id;
    const paint = () => {
      const { x, y, w, h } = camera.toViewBound(bounds);
      Object.assign(mark.style, {
        left: x + "px",
        top: y + "px",
        width: w + "px",
        height: h + "px",
      });
    };
    let focused = false;
    const focus = () => {
      if (focused || !camera.width || !camera.height) return;
      focused = true;
      camera.focusLinkedBounds(bounds);
      paint();
      el.append(mark);
    };
    const dismiss = () => {
      focused = true;
      mark.remove();
    };
    const resize = camera.sizeUpdated.subscribe(focus);
    const moved = camera.viewportUpdated.subscribe(paint);
    el.addEventListener("pointerdown", dismiss, { once: true });
    focus();
    return () => {
      resize.unsubscribe();
      moved.unsubscribe();
      el.removeEventListener("pointerdown", dismiss);
      mark.remove();
    };
  }, [surface, targetId, refreshKey, color, interactive, editor, settings]);
  // The two-pixel inset is the existing preview frame; its canvas includes
  // the synced-document header space, not the dimensions of a Page card.
  return (
    <div
      data-canvas-preview=""
      data-canvas-reader={interactive || undefined}
      tabIndex={interactive ? -1 : undefined}
      data-theme={color}
      ref={root}
      role="img"
      aria-label={title}
      title={title}
      style={{
        height: interactive ? "100%" : EMBED_CARD_HEIGHT.syncedDoc + 34,
      }}
    />
  );
}
