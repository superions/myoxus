// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef } from "react";
import { Box, MyoxusText, RadioGroup, Stack } from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import {
  CanvasRenderer,
  getSurfaceBlock,
} from "@virgultum/editor/blocks/surface";
import { Bound, getCommonBound } from "@virgultum/global/gfx";
import { GfxControllerIdentifier, Viewport } from "@virgultum/std/gfx";
import { ThemeProvider } from "@virgultum/shared/services";
import {
  MindmapDesign,
  projectMindmapTree,
  previewMermaidGfxModel,
  type MindmapPreviewHostProps,
} from "@virgultum/block-mermaid";
import { MindmapDesignPreview } from "./layout-popover";

/** Passive AI/chat preview uses the same projection and local GFX renderer.
 * A private camera filters its local elements from the document viewport;
 * no temporary workspace, persisted tree or editable Store is created. */
export function MindmapPassivePreview({
  props,
}: {
  props: MindmapPreviewHostProps;
}) {
  const t = useI18n(),
    container = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const { std } = props.host,
      surface = getSurfaceBlock(std.store);
    if (!surface) return;
    const gfx = std.get(GfxControllerIdentifier),
      theme = std.get(ThemeProvider);
    const visual = projectMindmapTree(props.model, { design: props.design });
    const bound = getCommonBound(
      visual.nodes.map(
        (node) => new Bound(node.x, node.y, node.width, node.height),
      ),
    );
    if (!bound) return;
    const viewport = new Viewport();
    viewport.ZOOM_MIN = 0.01;
    viewport.setShellElement(container.current);
    const renderer = new CanvasRenderer({
      std,
      viewport,
      layerManager: gfx.layer,
      gridManager: gfx.grid,
      surfaceModel: surface,
      provider: {
        selectedElements: () => [],
        getColorScheme: () => theme.edgelessTheme,
        getColorValue: (color, fallback, real) =>
          theme.getColorValue(color, fallback, real, theme.edgelessTheme),
        generateColorProperty: (color, fallback) =>
          theme.generateColorProperty(color, fallback, theme.edgelessTheme),
        getPropertyValue: (property) =>
          theme.getCssVariableColor(property, theme.edgelessTheme),
      },
    });
    const excluded = new Set(gfx.gfxElements.map((element) => element.id));
    const excludeDocument = () =>
      renderer.setLocallyExcludedElementIds(excluded);
    excludeDocument();
    const documentAddition = surface.elementAdded.subscribe(({ id }) => {
      excluded.add(id);
      excludeDocument();
    });
    renderer.attach(container.current);
    const preview = previewMermaidGfxModel(visual, {
      surface,
      viewport,
      origin: new Bound(0, 0, bound.w, bound.h),
      elements: [],
      refresh: () => renderer.refresh(),
    });
    const fit = () => {
      if (viewport.width > 0 && viewport.height > 0)
        viewport.setViewportByBound(bound, [36, 36, 36, 36]);
    };
    const size = viewport.sizeUpdated.subscribe(fit);
    const colorScheme = theme.edgeless$.subscribe(() => renderer.refresh());
    fit();
    return () => {
      colorScheme();
      size.unsubscribe();
      documentAddition.unsubscribe();
      preview();
      renderer.dispose();
      viewport.dispose();
      renderer.canvas.remove();
    };
  }, [props.host, props.model, props.design]);
  return (
    <Stack>
      {/* Height is preview renderer geometry, inherited from the existing AI/chat slot. */}
      <Box
        ref={container}
        role="img"
        aria-label={props.model.nodes[0]?.label}
        style={{ height: props.height }}
      />
      {props.showDesigns ? (
        <>
          <MyoxusText>{t["com.myoxus.editor.toolbar.style"]()}</MyoxusText>
          <RadioGroup
            value={String(props.design)}
            items={[
              MindmapDesign.ONE,
              MindmapDesign.TWO,
              MindmapDesign.THREE,
              MindmapDesign.FOUR,
            ].map((design) => ({
              value: String(design),
              label: <MindmapDesignPreview design={design} />,
            }))}
            onChange={(value) => {
              const design = [
                MindmapDesign.ONE,
                MindmapDesign.TWO,
                MindmapDesign.THREE,
                MindmapDesign.FOUR,
              ].find((design) => String(design) === value);
              if (design !== undefined) props.onDesignChange(design);
            }}
          />
        </>
      ) : null}
    </Stack>
  );
}
