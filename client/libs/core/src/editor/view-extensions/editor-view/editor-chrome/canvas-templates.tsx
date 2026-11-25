// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useEffect, useRef } from "react";
import { useI18n } from "@myoxus/i18n";
import { LayoutTemplateIcon } from "@myoxus/icons/react";
import {
  AspectRatio,
  Box,
  Card,
  Button,
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
import type {
  EditorCanvasTemplateControls,
  EditorCanvasTemplatePreview,
} from "@virgultum/editor/shared/services";

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
    return () => {
      el.replaceChildren();
    };
  }, [preview]);

  if (preview.kind === "svg") {
    return <Box className="canvas-template-preview" ref={svgRef} />;
  }
  if (preview.kind === "image") {
    return (
      <Box className="canvas-template-preview">
        <img src={preview.src} loading="lazy" />
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
    <Card withBorder>
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
