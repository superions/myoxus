// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { createElement, type KeyboardEvent } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowLeftSmallIcon,
  ArrowRightSmallIcon,
  InvisibleIcon,
  ScissorsIcon,
} from "@myoxus/icons/react";
import {
  Box,
  Button,
  IconButton,
  Menu,
  MenuItem,
  Text,
  ToolbarSurface,
  Tooltip,
} from "@myoxus/ui-facade";
import type {
  EditorAutoCompleteControls,
  EditorAutoConnectControls,
  EditorNoteSlicerControls,
} from "@virgultum/editor/shared/services";
import { editorGlyph } from "./glyphs";

function stopCanvasKey(event: KeyboardEvent) {
  if (event.key !== "Tab") event.stopPropagation();
}

function stopSlicerActivationKey(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.key === " " || event.key === "Enter") event.stopPropagation();
}

/** React overlay view for Edgeless Note slicing (button + dividing lines). */
export function EditorNoteSlicer({
  controls,
}: {
  controls: EditorNoteSlicerControls;
}) {
  return (
    <Box
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <Box
        className="note-slicer-button"
        style={{
          left: `${controls.buttonLeft}px`,
          top: `${controls.buttonTop}px`,
          transform: "translateY(-50%)",
        }}
        onKeyDown={stopSlicerActivationKey}
        onKeyUp={stopSlicerActivationKey}
      >
        <IconButton
          data-testid="note-slicer-split"
          size="large"
          tooltip={controls.buttonLabel}
          aria-label={controls.buttonLabel}
          onClick={controls.slice}
        >
          <ScissorsIcon />
        </IconButton>
      </Box>
      {controls.lines.map((line, index) => (
        <Box
          key={index}
          className={
            index === controls.activeIndex
              ? "note-slicer-dividing-line-container active"
              : "note-slicer-dividing-line-container"
          }
          style={{
            left: `${line.left}px`,
            top: `${line.top}px`,
            width: `${controls.lineWidth}px`,
          }}
          onClick={controls.slice}
        >
          <Box component="span" className="note-slicer-dividing-line" />
        </Box>
      ))}
    </Box>
  );
}

/** React overlay view for Edgeless page-visibility index labels and navigator. */
export function EditorAutoConnect({
  controls,
}: {
  controls: EditorAutoConnectControls;
}) {
  const t = useI18n();
  const hiddenLabel = t["com.myoxus.editor.canvas.hidden-on-page"]();

  return (
    <>
      {controls.visibleGroups.map((group) => (
        <Box
          key={`visible:${group.id}`}
          style={{
            position: "absolute",
            left: `${group.left}px`,
            top: `${group.top}px`,
          }}
          onMouseEnter={() => group.onHoverChange(true)}
          onMouseLeave={() => group.onHoverChange(false)}
        >
          {group.items.map((item) => {
            const formatted = new Intl.NumberFormat(t.language).format(
              item.index,
            );
            const label = t["com.myoxus.editor.canvas.page-index"]({
              index: formatted,
            });
            return (
              <Box
                key={item.index}
                style={{
                  position: "absolute",
                  transform: `translate(${item.offsetX}px, ${item.offsetY}px) translateX(-50%)`,
                }}
              >
                <Tooltip content={label}>
                  <Button
                    aria-label={label}
                    aria-pressed={item.active}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      item.toggle();
                    }}
                    onKeyDown={stopCanvasKey}
                  >
                    {formatted}
                  </Button>
                </Tooltip>
              </Box>
            );
          })}
        </Box>
      ))}

      {controls.hiddenNotes.map((note) => (
        <Box
          key={`hidden:${note.id}`}
          style={{
            position: "absolute",
            transform: `translate(${note.left}px, ${note.top}px) translateX(-50%)`,
          }}
        >
          <Tooltip content={hiddenLabel}>
            <Text component="span" role="img" aria-label={hiddenLabel}>
              <InvisibleIcon />
            </Text>
          </Tooltip>
        </Box>
      ))}

      {controls.navigator && (
        <Box
          style={{
            position: "absolute",
            transform: `translate(${controls.navigator.left}px, ${controls.navigator.top}px) translateX(-50%)`,
          }}
        >
          <ToolbarSurface
            compact
            role="group"
            data-range-sync-exclude="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={stopCanvasKey}
          >
            <IconButton
              icon={<ArrowLeftSmallIcon />}
              tooltip={t["common.previous"]()}
              disabled={!controls.navigator.previous}
              onClick={() => controls.navigator?.navigate(-1)}
            />
            <IconButton
              icon={<ArrowRightSmallIcon />}
              tooltip={t["common.next"]()}
              disabled={!controls.navigator.next}
              onClick={() => controls.navigator?.navigate(1)}
            />
          </ToolbarSurface>
        </Box>
      )}
    </>
  );
}

/**
 * React overlay view for Edgeless auto-complete arrows and target-type picker.
 * Preserves `<edgeless-auto-complete>`, `.edgeless-auto-complete-arrow`,
 * `<edgeless-auto-complete-panel>`, and `.auto-complete-panel-container` hooks.
 */
export function EditorAutoComplete({
  controls,
}: {
  controls: EditorAutoCompleteControls;
}) {
  const { triggers, panel } = controls;

  return (
    <>
      {triggers && (
        <Box
          renderRoot={(props) => createElement("edgeless-auto-complete", props)}
          style={{ display: "contents" }}
        >
          <Box
            className="edgeless-auto-complete-container"
            style={{
              position: "absolute",
              top: `${triggers.rect.top}px`,
              left: `${triggers.rect.left}px`,
              width: `${triggers.rect.width}px`,
              height: `${triggers.rect.height}px`,
              transform: `rotate(${triggers.rect.rotate}deg)`,
            }}
          >
            {triggers.items.map((item) => (
              <Box
                key={item.key}
                className={
                  item.family
                    ? "edgeless-auto-complete-arrow-wrapper family"
                    : "edgeless-auto-complete-arrow-wrapper edgeless-auto-complete-arrow"
                }
                style={{
                  position: "absolute",
                  width: `${item.width}px`,
                  height: `${item.height}px`,
                  display: item.hidden ? "none" : "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "auto",
                  transform: item.transform,
                  transformOrigin: item.family ? undefined : "left top",
                }}
              >
                <IconButton
                  tooltip={item.label}
                  aria-label={item.label}
                  data-range-sync-exclude="true"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    if (event.button === 0) item.pointerDown(event.nativeEvent);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (event.detail === 0) item.activate();
                  }}
                  onKeyDown={stopCanvasKey}
                  onMouseEnter={() => item.preview(true)}
                  onMouseLeave={() => item.preview(false)}
                  onFocus={() => item.preview(true)}
                  onBlur={() => item.preview(false)}
                >
                  {editorGlyph(item.icon)}
                </IconButton>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {panel && (
        <Box
          renderRoot={(props) =>
            createElement("edgeless-auto-complete-panel", props)
          }
          style={{ display: "contents" }}
        >
          <Menu
            noPortal
            rootOptions={{
              open: true,
              onClose: panel.close,
              clickOutsideEvents: ["pointerdown"],
              closeOnItemClick: false,
            }}
            contentOptions={{
              side: "bottom",
              align: "start",
              className: "auto-complete-panel-container",
              style: { pointerEvents: "auto" },
              "aria-label": panel.label,
              "data-range-sync-exclude": "true",
              onPointerDown: (event) => event.stopPropagation(),
              onClick: (event) => event.stopPropagation(),
              onKeyDown: stopCanvasKey,
            }}
            items={panel.options.map((option, index) => (
              <MenuItem
                key={index}
                prefixIcon={editorGlyph(option.icon)}
                onMouseEnter={() => option.preview(true)}
                onMouseLeave={() => option.preview(false)}
                onFocus={() => option.preview(true)}
                onBlur={() => option.preview(false)}
                onSelect={option.choose}
              >
                {option.label}
              </MenuItem>
            ))}
          >
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: `${panel.left}px`,
                top: `${panel.top}px`,
                width: "1px",
                height: "1px",
              }}
            />
          </Menu>
        </Box>
      )}
    </>
  );
}
