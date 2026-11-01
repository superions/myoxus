// SPDX-License-Identifier: AGPL-3.0-or-later

import { SimpleGrid, Slider, Stack, Text } from "@mantine/core";

export interface OrdinalSliderOption {
  value: number;
  label: string;
}

export interface OrdinalSliderProps {
  value: number;
  options: OrdinalSliderOption[];
  onChange?: (value: number) => void;
  onChangeEnd?: (value: number) => void;
  readonly?: boolean;
  ariaLabel: string;
  testId?: string;
}

/**
 * Product-neutral ordered choice control backed by Mantine Slider.
 *
 * Product code owns option meaning and order. The Facade only enforces native
 * marked-slider interaction and a single end-of-interaction commit boundary.
 */
export function OrdinalSlider({
  value,
  options,
  onChange,
  onChangeEnd,
  readonly = false,
  ariaLabel,
  testId,
}: OrdinalSliderProps) {
  const ordered = [...options].sort((left, right) => left.value - right.value);
  const first = ordered.at(0);
  const last = ordered.at(-1);
  if (!first || !last) return null;
  const current =
    ordered.find((option) => option.value === value) ??
    ordered.reduce((closest, option) =>
      Math.abs(option.value - value) < Math.abs(closest.value - value)
        ? option
        : closest,
    );
  const visibleLabelValues =
    ordered.length <= 3
      ? new Set(ordered.map((option) => option.value))
      : new Set([first.value, current.value, last.value]);
  const marks = ordered.map((option) => ({ value: option.value }));

  if (readonly) {
    return (
      <Text
        c="dimmed"
        data-testid={testId}
        data-myoxus-ui-role="ordinal-slider-readonly"
      >
        {current.label}
      </Text>
    );
  }

  return (
    <Stack gap="xs" data-testid={testId} data-myoxus-ui-role="ordinal-slider">
      <Slider
        value={current.value}
        min={first.value}
        max={last.value}
        marks={marks}
        restrictToMarks
        label={(nextValue) =>
          ordered.find((option) => option.value === nextValue)?.label
        }
        thumbLabel={ariaLabel}
        thumbValueText={(nextValue) =>
          ordered.find((option) => option.value === nextValue)?.label ??
          String(nextValue)
        }
        onChange={onChange}
        onChangeEnd={onChangeEnd}
      />
      <SimpleGrid
        cols={ordered.length}
        spacing={0}
        data-myoxus-ui-role="ordinal-slider-labels"
      >
        {ordered.map((option, index) => (
          <Text
            key={option.value}
            c="dimmed"
            size="sm"
            ta={
              index === 0
                ? "start"
                : index === ordered.length - 1
                  ? "end"
                  : "center"
            }
          >
            {visibleLabelValues.has(option.value) ? option.label : null}
          </Text>
        ))}
      </SimpleGrid>
    </Stack>
  );
}
