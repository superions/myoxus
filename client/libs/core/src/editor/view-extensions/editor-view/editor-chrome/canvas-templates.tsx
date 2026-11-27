// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { LayoutTemplateIcon } from "@myoxus/icons/react";
import {
  AspectRatio,
  Box,
  Button,
  Card,
  EmptyState,
  Group,
  MenuPanel,
  MyoxusLoader,
  Scrollable,
  SearchInput,
  SelectableCardRow,
  SimpleGrid,
  Tooltip,
} from "@myoxus/ui-facade";
import { DefaultTool } from "@virgultum/editor/blocks/surface";
import {
  builtInTemplates,
  createTemplateJob,
  TemplateTool,
  type Template,
} from "@virgultum/editor/gfx/template";
import { Bound } from "@virgultum/editor/global/gfx";
import {
  EditPropsStore,
  type EditorCanvasPopoverControls,
  type EditorCanvasTemplateControls,
  type EditorCanvasTemplatePreview,
} from "@virgultum/editor/shared/services";
import type { BlockComponent } from "@virgultum/editor/std";
import {
  GfxControllerIdentifier,
  type ToolOptionWithType,
} from "@virgultum/editor/std/gfx";

import {
  type CanvasDragPreview,
  startCanvasDragInsert,
} from "./canvas-drag-insert";
import { EditorCanvasPopover } from "./canvas-popover";

function TemplatePreview({
  preview,
}: {
  preview: EditorCanvasTemplatePreview;
}) {
  const svgRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (!el || preview.kind !== "svg") return;
    el.innerHTML = preview.markup;
    const svg = el.querySelector("svg");
    if (svg) {
      svg.style.display = "block";
      svg.style.width = "100%";
      svg.style.height = "100%";
    }
    return () => {
      el.replaceChildren();
    };
  }, [preview]);

  if (preview.kind === "svg") {
    return (
      <Box
        className="canvas-template-preview"
        ref={svgRef}
        style={{ width: "100%", height: "100%" }}
      />
    );
  }
  if (preview.kind === "image") {
    return (
      <Box
        className="canvas-template-preview"
        style={{ width: "100%", height: "100%" }}
      >
        <img
          src={preview.src}
          loading="lazy"
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            objectFit: "contain",
          }}
        />
      </Box>
    );
  }
  return (
    <Box className="canvas-template-preview">
      <LayoutTemplateIcon />
    </Box>
  );
}

export function EditorCanvasTemplates({
  controls,
}: {
  controls: EditorCanvasTemplateControls;
}) {
  const t = useI18n();
  return (
    <Card withBorder={false}>
      <MenuPanel
        panelWidth="large"
        role="dialog"
        aria-label={t["Template"]()}
        aria-busy={controls.loading}
      >
        <SearchInput
          value={controls.query}
          onChange={controls.search}
          aria-label={t["com.myoxus.editor.template.search"]()}
          placeholder={t["com.myoxus.editor.template.search"]()}
          onCut={(event) => event.stopPropagation()}
          onCopy={(event) => event.stopPropagation()}
          onPaste={(event) => event.stopPropagation()}
        />
        {controls.categories.length > 0 && (
          <Scrollable.Viewport autosize scrollbars="x">
            <Group wrap="nowrap" gap="xs">
              {controls.categories.map((category) => (
                <Button
                  key={category}
                  variant={
                    controls.category === category ? "secondary" : "plain"
                  }
                  aria-pressed={controls.category === category}
                  onClick={() => controls.chooseCategory(category)}
                >
                  {category}
                </Button>
              ))}
            </Group>
          </Scrollable.Viewport>
        )}
        <Scrollable.Viewport autosize maxHeight="selector" scrollbars="y">
          {controls.loading ? (
            <MyoxusLoader />
          ) : controls.items.length ? (
            <SimpleGrid cols={3} spacing="xs">
              {controls.items.map((item) => (
                <Tooltip key={item.id} content={item.label}>
                  <SelectableCardRow
                    density="compact"
                    aria-label={item.label}
                    disabled={controls.readonly || item.loading}
                    aria-busy={item.loading}
                    style={{ opacity: item.dragging ? 0 : 1 }}
                    onMouseDown={(event) =>
                      item.mouseDown(event.currentTarget, event.nativeEvent)
                    }
                    onTouchStart={(event) =>
                      item.touchStart(event.currentTarget, event.nativeEvent)
                    }
                    onClick={(event) => {
                      if (event.detail === 0) item.activate();
                    }}
                  >
                    {/* Match the existing catalog preview ratio; artwork is renderer-owned. */}
                    <AspectRatio ratio={135 / 80}>
                      <TemplatePreview preview={item.preview} />
                    </AspectRatio>
                    {item.loading && <MyoxusLoader />}
                  </SelectableCardRow>
                </Tooltip>
              ))}
            </SimpleGrid>
          ) : (
            <EmptyState
              title={
                controls.query
                  ? t["com.myoxus.cmdk.no-results"]()
                  : t["com.myoxus.templates.library.empty"]()
              }
            />
          )}
        </Scrollable.Viewport>
      </MenuPanel>
    </Card>
  );
}

function templatePreview(template: Template): EditorCanvasTemplatePreview {
  if (!template.preview) return { kind: "fallback" };
  return template.preview.startsWith("<svg")
    ? { kind: "svg", markup: template.preview }
    : { kind: "image", src: template.preview };
}

function templateDragPreview(
  template: Template,
  fallbackLabel: string,
): CanvasDragPreview {
  if (!template.preview) return { kind: "text", label: fallbackLabel };
  return template.preview.startsWith("<svg")
    ? { kind: "svg", markup: template.preview }
    : { kind: "image", src: template.preview };
}

/**
 * Direct AGPL React dock tool & popover controller for Edgeless Templates.
 * Uses `startCanvasDragInsert` for pointer drag-to-canvas insertion and
 * coordinates mutual exclusion through `registerActivePopover`.
 */
export function EditorCanvasTemplatesTool({
  edgeless,
  registerActivePopover,
}: {
  edgeless: BlockComponent;
  registerActivePopover: (close: () => void) => () => void;
}) {
  const t = useI18n();
  const gfx = edgeless.std.get(GfxControllerIdentifier);
  const editProps = edgeless.std.get(EditPropsStore);

  const [opened, setOpened] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [currentCategory, setCurrentCategory] = useState<string>("");
  const [query, setQuery] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingTemplate, setLoadingTemplate] = useState<Template | null>(null);
  const [draggingTemplate, setDraggingTemplate] = useState<Template | null>(
    null,
  );

  const prevToolRef = useRef<ToolOptionWithType | null>(null);
  const isDraggingRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const fetchSeqRef = useRef(0);
  const currentCategoryRef = useRef(currentCategory);
  currentCategoryRef.current = currentCategory;

  const restoreTool = useCallback(() => {
    const prev = prevToolRef.current;
    prevToolRef.current = null;
    if (prev?.toolType && prev.toolType !== TemplateTool) {
      gfx.tool.setTool(prev.toolType, prev.options);
    } else {
      gfx.tool.setTool(DefaultTool);
    }
  }, [gfx]);

  const closePanel = useCallback(
    (force = false) => {
      if (!force && isDraggingRef.current) return;
      if (currentCategoryRef.current) {
        editProps.setStorage("templateCache", currentCategoryRef.current);
      }
      setOpened(false);
      restoreTool();
    },
    [editProps, restoreTool],
  );

  const loadTemplates = useCallback(
    async (search: string, category: string) => {
      const seq = ++fetchSeqRef.current;
      setLoading(true);
      try {
        const next = search
          ? await builtInTemplates.search(search)
          : await builtInTemplates.list(category);
        if (seq !== fetchSeqRef.current) return;
        setTemplates(next);
      } catch (error) {
        if (seq !== fetchSeqRef.current) return;
        console.error("Failed to load templates", error);
      } finally {
        if (seq === fetchSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!opened) return;
    const unregister = registerActivePopover(() => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      isDraggingRef.current = false;
      setDraggingTemplate(null);
      closePanel(true);
    });
    return () => {
      unregister();
    };
  }, [opened, registerActivePopover, closePanel]);

  useEffect(() => {
    if (!opened) return;
    let canceled = false;
    void (async () => {
      try {
        const nextCategories = await builtInTemplates.categories();
        if (canceled) return;
        setCategories(nextCategories);
        const cached = editProps.getStorage("templateCache");
        const initial =
          (cached && nextCategories.includes(cached)
            ? cached
            : nextCategories[0]) ?? "";
        setCurrentCategory(initial);
        await loadTemplates("", initial);
      } catch (error) {
        if (!canceled) console.error("Failed to load categories", error);
      }
    })();
    return () => {
      canceled = true;
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, [opened, editProps, loadTemplates]);

  const insertTemplate = useCallback(
    async (template: Template, bound: Bound) => {
      setLoadingTemplate(template);
      const cloned = structuredClone(template);
      const center = {
        x: bound.x + bound.w / 2,
        y: bound.y + bound.h / 2,
      };
      const templateJob = createTemplateJob(edgeless.std, cloned.type, center);
      try {
        if (cloned.assets) {
          await Promise.all(
            Object.entries(cloned.assets).map(([key, value]) =>
              fetch(value)
                .then((res) => res.blob())
                .then((blob) => templateJob.job.assets.set(key, blob)),
            ),
          );
        }
        const insertedBound = await templateJob.insertTemplate(cloned.content);
        if (insertedBound && cloned.type === "template") {
          const padding = 20 / gfx.viewport.zoom;
          gfx.viewport.setViewportByBound(
            insertedBound,
            [padding, padding, padding, padding],
            true,
          );
        }
      } finally {
        setLoadingTemplate(null);
        isDraggingRef.current = false;
        setDraggingTemplate(null);
        setOpened(false);
        gfx.tool.setTool(DefaultTool);
      }
    },
    [edgeless.std, gfx],
  );

  const startItemDrag = useCallback(
    (
      template: Template,
      element: HTMLElement,
      clientX: number,
      clientY: number,
    ) => {
      if (edgeless.store.readonly || loadingTemplate) return;
      dragCleanupRef.current?.();
      const label = template.name ?? t["Template"]();
      dragCleanupRef.current = startCanvasDragInsert<Template>({
        edgeless,
        data: template,
        sourceElement: element,
        preview: templateDragPreview(template, label),
        standardWidth: 560,
        startClientX: clientX,
        startClientY: clientY,
        onDragStart: () => {
          isDraggingRef.current = true;
          setDraggingTemplate(template);
        },
        onClick: (selected) => {
          const { x, y } = gfx.viewport.center;
          void insertTemplate(selected, new Bound(x, y, 0, 0)).catch(
            console.error,
          );
        },
        onDrop: (selected, bound) => {
          void insertTemplate(selected, bound).catch(console.error);
        },
        onCancel: () => {
          isDraggingRef.current = false;
          setDraggingTemplate(null);
        },
      });
    },
    [edgeless, gfx, insertTemplate, loadingTemplate, t],
  );

  const togglePanel = useCallback(() => {
    if (opened) {
      closePanel();
      return;
    }
    const currentTool = gfx.tool.currentToolOption$.peek();
    prevToolRef.current = currentTool ? { ...currentTool } : null;
    gfx.tool.setTool(TemplateTool);
    setQuery("");
    setOpened(true);
  }, [closePanel, gfx, opened]);

  const label = t["Template"]();
  const isDragging = draggingTemplate !== null;

  const templateControls: EditorCanvasTemplateControls = {
    query,
    categories,
    category: currentCategory,
    loading,
    readonly: edgeless.store.readonly,
    search: (value) => {
      setQuery(value);
      void loadTemplates(value, currentCategory);
    },
    chooseCategory: (category) => {
      setCurrentCategory(category);
      editProps.setStorage("templateCache", category);
      void loadTemplates(query, category);
    },
    items: templates.map((template, index) => ({
      id: template.name ?? String(index),
      label: template.name ?? label,
      preview: templatePreview(template),
      loading: template === loadingTemplate,
      dragging: template === draggingTemplate,
      mouseDown: (element, event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        startItemDrag(template, element, event.clientX, event.clientY);
      },
      touchStart: (element, event) => {
        const touch = event.touches[0];
        if (!touch) return;
        startItemDrag(template, element, touch.clientX, touch.clientY);
      },
      activate: () => {
        const { x, y } = gfx.viewport.center;
        void insertTemplate(template, new Bound(x, y, 0, 0)).catch(
          console.error,
        );
      },
    })),
  };

  const popoverControls: EditorCanvasPopoverControls = {
    opened,
    onClose: () => closePanel(),
    position: "top",
    offset: 16,
    withArrow: true,
    closeOnClickOutside: !isDragging,
    label,
    trigger: {
      expanded: opened,
      action: {
        id: "canvas-template",
        icon: "LayoutTemplateIcon",
        label,
        disabled: false,
        active: opened,
        run: togglePanel,
      },
    },
    content: {
      kind: "templates",
      controls: templateControls,
    },
  };

  return (
    <Box style={isDragging ? { opacity: 0, pointerEvents: "none" } : undefined}>
      <EditorCanvasPopover controls={popoverControls} withinPortal={false} />
    </Box>
  );
}
