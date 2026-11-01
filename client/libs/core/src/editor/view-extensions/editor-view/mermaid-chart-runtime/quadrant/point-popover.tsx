// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  ColorInput,
  Group,
  MyoxusTextInput,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import type {
  MermaidQuadrantPoint,
  MermaidQuadrantReactHostProps,
  MermaidQuadrantTextForm,
} from "@virgultum/block-mermaid";
import { useEffect, useRef, useState } from "react";

export function MermaidQuadrantPointPopover({
  mode,
  layerActions = true,
  onApply,
  onClose,
  onDelete,
  onPreview,
  point,
  preview,
  props,
}: {
  readonly mode: "coordinates" | "label";
  readonly layerActions?: boolean;
  readonly onApply: (draft: {
    className?: string;
    inlineStyle: MermaidQuadrantPoint["inlineStyle"];
    label: string;
    labelForm: MermaidQuadrantTextForm;
    reorderDirection?: -1 | 1;
    x: number;
    y: number;
  }) => boolean;
  readonly onClose: () => void;
  readonly onDelete: () => void;
  readonly onPreview: (
    preview: {
      readonly className?: string;
      readonly inlineStyle: MermaidQuadrantPoint["inlineStyle"];
      readonly reorderDirection?: -1 | 1;
    } | null,
  ) => void;
  readonly point: MermaidQuadrantPoint;
  readonly preview?: {
    readonly className?: string;
    readonly inlineStyle: MermaidQuadrantPoint["inlineStyle"];
    readonly reorderDirection?: -1 | 1;
  };
  readonly props: MermaidQuadrantReactHostProps;
}) {
  const [label, setLabel] = useState(point.label);
  const [x, setX] = useState<number | string>(point.x);
  const [y, setY] = useState<number | string>(point.y);
  const [labelForm, setLabelForm] = useState(point.labelForm);
  const [className, setClassName] = useState(
    preview?.className ?? point.className,
  );
  const [radius, setRadius] = useState<number | string>(
    preview?.inlineStyle.radius ?? point.inlineStyle.radius ?? "",
  );
  const [color, setColor] = useState(
    preview?.inlineStyle.color ?? point.inlineStyle.color ?? "",
  );
  const [strokeColor, setStrokeColor] = useState(
    preview?.inlineStyle.strokeColor ?? point.inlineStyle.strokeColor ?? "",
  );
  const [strokeWidth, setStrokeWidth] = useState(
    preview?.inlineStyle.strokeWidth ?? point.inlineStyle.strokeWidth ?? "",
  );
  const [reorderDirection, setReorderDirection] = useState<-1 | 0 | 1>(
    preview?.reorderDirection ?? 0,
  );
  const previewMountedRef = useRef(false);
  const validColor = (value: string) =>
    !value || /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value);
  const styleValid =
    (radius === "" ||
      (typeof radius === "number" &&
        Number.isInteger(radius) &&
        radius >= 0)) &&
    validColor(color) &&
    validColor(strokeColor) &&
    (!strokeWidth || /^\d+px$/.test(strokeWidth));
  const valid =
    Boolean(label.trim()) &&
    typeof x === "number" &&
    x >= 0 &&
    x <= 1 &&
    typeof y === "number" &&
    y >= 0 &&
    y <= 1 &&
    styleValid;
  useEffect(() => {
    if (!previewMountedRef.current) {
      previewMountedRef.current = true;
      return;
    }
    if (!styleValid) return;
    const preview = {
      className,
      inlineStyle: {
        color: color || undefined,
        radius: typeof radius === "number" ? radius : undefined,
        strokeColor: strokeColor || undefined,
        strokeWidth: strokeWidth || undefined,
      },
      reorderDirection: reorderDirection || undefined,
    };
    onPreview(preview);
  }, [
    className,
    color,
    onPreview,
    radius,
    reorderDirection,
    strokeColor,
    strokeWidth,
    styleValid,
  ]);
  return (
    <Popover opened position="bottom" returnFocus trapFocus>
      <PopoverTarget>
        <span data-mermaid-quadrant-popover-anchor={point.id} />
      </PopoverTarget>
      <PopoverContent
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Stack gap="xs">
          {props.model.diagnostics
            .filter(
              (diagnostic) => diagnostic.recordId === point.sourceRecordId,
            )
            .map((diagnostic) => (
              <Alert color="myoxusWarning" key={diagnostic.id} variant="light">
                {diagnostic.message}
              </Alert>
            ))}
          {mode === "label" ? (
            <MyoxusTextInput
              aria-label={props.labels.label}
              autoFocus
              onChange={setLabel}
              onKeyDown={(event) => {
                if (event.key === "Escape") onClose();
                else if (
                  event.key === "Enter" &&
                  valid &&
                  typeof x === "number" &&
                  typeof y === "number" &&
                  onApply({
                    className,
                    inlineStyle: {
                      color: color || undefined,
                      radius: typeof radius === "number" ? radius : undefined,
                      strokeColor: strokeColor || undefined,
                      strokeWidth: strokeWidth || undefined,
                    },
                    label,
                    labelForm,
                    reorderDirection: reorderDirection || undefined,
                    x,
                    y,
                  })
                ) {
                  return;
                }
              }}
              value={label}
            />
          ) : (
            <Stack gap="xs">
              <Group grow wrap="nowrap">
                <NumberInput
                  aria-label={props.labels.x}
                  autoFocus
                  decimalScale={4}
                  max={1}
                  min={0}
                  onChange={setX}
                  step={0.01}
                  value={x}
                />
                <NumberInput
                  aria-label={props.labels.y}
                  decimalScale={4}
                  max={1}
                  min={0}
                  onChange={setY}
                  step={0.01}
                  value={y}
                />
              </Group>
              <Select
                aria-label={props.labels.classes}
                clearable
                data={props.model.classes.map((classDef) => ({
                  label: classDef.name,
                  value: classDef.name,
                }))}
                onChange={setClassName}
                onClear={() => setClassName(undefined)}
                value={className ?? null}
              />
              <Group grow wrap="nowrap">
                <NumberInput
                  aria-label={props.labels.pointRadius}
                  min={0}
                  onChange={setRadius}
                  value={radius}
                />
                <ColorInput
                  allowEmpty
                  aria-label={props.labels.fillColor}
                  onChange={setColor}
                  value={color}
                />
              </Group>
              <Group grow wrap="nowrap">
                <ColorInput
                  allowEmpty
                  aria-label={props.labels.strokeColor}
                  onChange={setStrokeColor}
                  value={strokeColor}
                />
                <MyoxusTextInput
                  aria-label={props.labels.strokeWidth}
                  onChange={setStrokeWidth}
                  value={strokeWidth}
                />
              </Group>
            </Stack>
          )}
          <Select
            aria-label={props.labels.labelForm}
            data={[
              { label: props.labels.plain, value: "plain" },
              { label: props.labels.quoted, value: "quoted" },
              { label: props.labels.markdown, value: "markdown" },
            ]}
            onChange={(value) => setLabelForm(value as MermaidQuadrantTextForm)}
            value={labelForm}
          />
          <Group justify="flex-end" wrap="nowrap">
            {layerActions ? (
              <>
                <Button
                  onClick={() => setReorderDirection(-1)}
                  variant={reorderDirection === -1 ? undefined : "plain"}
                >
                  {props.labels.up}
                </Button>
                <Button
                  onClick={() => setReorderDirection(1)}
                  variant={reorderDirection === 1 ? undefined : "plain"}
                >
                  {props.labels.down}
                </Button>
              </>
            ) : null}
            <Button onClick={onDelete} variant="plain">
              {props.labels.delete}
            </Button>
            <Button onClick={onClose} variant="plain">
              {props.labels.cancel}
            </Button>
            <Button
              disabled={!valid}
              onClick={() => {
                if (
                  typeof x === "number" &&
                  typeof y === "number" &&
                  onApply({
                    className,
                    inlineStyle: {
                      color: color || undefined,
                      radius: typeof radius === "number" ? radius : undefined,
                      strokeColor: strokeColor || undefined,
                      strokeWidth: strokeWidth || undefined,
                    },
                    label,
                    labelForm,
                    reorderDirection: reorderDirection || undefined,
                    x,
                    y,
                  })
                ) {
                  return;
                }
              }}
            >
              {props.labels.apply}
            </Button>
          </Group>
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
