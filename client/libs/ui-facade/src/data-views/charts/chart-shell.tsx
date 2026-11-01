// SPDX-License-Identifier: AGPL-3.0-or-later

import { Center, Stack, Text, VisuallyHidden } from "@mantine/core";
import { format as d3Format } from "d3-format";
import { type ReactNode, type Ref, useId } from "react";

export type DataChartValueFormatter = (value: number) => string;

export const localizedChartNumber: DataChartValueFormatter = (value) =>
  new Intl.NumberFormat().format(value);

export const localizedChartPreciseNumber: DataChartValueFormatter = (value) =>
  new Intl.NumberFormat(undefined, { maximumSignificantDigits: 12 }).format(
    value,
  );

/** Builds the formatter used by D3-backed chart projections. */
export function d3ChartNumberFormatter(
  formatString = ",",
): DataChartValueFormatter {
  try {
    if (formatString === "$0,0") {
      const formatter = d3Format(",");
      return (value) => `$${formatter(value)}`;
    }
    if (formatString.startsWith("$") && formatString.includes(",")) {
      const precision = /\.\d+/.exec(formatString)?.[0] ?? "";
      const formatter = d3Format(`,${precision}`);
      return (value) => `$${formatter(value)}`;
    }
    if (formatString.startsWith("$")) {
      const formatter = d3Format(formatString.slice(1));
      return (value) => `$${formatter(value)}`;
    }
    return d3Format(formatString);
  } catch {
    return d3Format(",");
  }
}

export type DataChartShellProps = {
  readonly ariaDescription?: string;
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly empty: boolean;
  readonly emptyAction?: ReactNode;
  readonly emptyLabel: string;
  readonly rootRef?: Ref<HTMLElement>;
  readonly selectedId?: string;
  readonly summary?: ReactNode;
  readonly testId?: string;
};

export function DataChartShell({
  ariaDescription,
  ariaLabel,
  children,
  empty,
  emptyAction,
  emptyLabel,
  rootRef,
  selectedId,
  summary,
  testId,
}: DataChartShellProps) {
  const descriptionId = useId();
  return (
    <section
      aria-describedby={ariaDescription ? descriptionId : undefined}
      aria-label={ariaLabel}
      className="myoxus-data-chart"
      data-empty={empty ? "true" : "false"}
      data-myoxus-ui-role="data-chart"
      data-selected-id={selectedId}
      data-testid={testId}
      ref={rootRef}
    >
      {ariaDescription ? (
        <VisuallyHidden id={descriptionId}>{ariaDescription}</VisuallyHidden>
      ) : null}
      {empty ? (
        <Center>
          <Stack align="center" gap="sm">
            {emptyLabel ? <Text c="dimmed">{emptyLabel}</Text> : null}
            {emptyAction}
          </Stack>
        </Center>
      ) : (
        children
      )}
      {summary ? (
        <div className="myoxus-data-chart-summary">{summary}</div>
      ) : null}
    </section>
  );
}
