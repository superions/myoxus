// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type ComponentProps } from "react";
import {
  Table as MantineTable,
  Pagination as MantinePagination,
} from "@mantine/core";
import { cssVar, cssTypographyVar } from "@myoxus/theme";

type MyoxusTableProps = ComponentProps<typeof MantineTable> & {
  "data-myoxus-ui-role"?: string;
};

type MyoxusTableHeaderProps = ComponentProps<typeof MantineTable.Thead> & {
  "data-myoxus-ui-role"?: string;
};

type MyoxusTableBodyProps = ComponentProps<typeof MantineTable.Tbody> & {
  "data-myoxus-ui-role"?: string;
};

type MyoxusTableRowProps = ComponentProps<typeof MantineTable.Tr> & {
  "data-myoxus-ui-role"?: string;
};

type MyoxusTableHeadProps = ComponentProps<typeof MantineTable.Th> & {
  "data-myoxus-ui-role"?: string;
};

type MyoxusTableCellProps = ComponentProps<typeof MantineTable.Td> & {
  "data-myoxus-ui-role"?: string;
  mono?: boolean;
  muted?: boolean;
  selected?: boolean;
  selectionFocus?: boolean;
  tabular?: boolean;
  truncate?: boolean;
};

type MyoxusTableScrollContainerProps = Omit<
  ComponentProps<typeof MantineTable.ScrollContainer>,
  "minWidth"
> & {
  /** Prevents wide table content from widening an outer scroll owner. */
  containInlineSize?: boolean;
  "data-myoxus-ui-role"?: string;
  minWidth?: ComponentProps<typeof MantineTable.ScrollContainer>["minWidth"];
};

export const Table = ({
  "data-myoxus-ui-role": uiRole = "table",
  borderColor = cssVar("borderColor"),
  ...props
}: MyoxusTableProps) => (
  <MantineTable
    {...props}
    borderColor={borderColor}
    data-myoxus-ui-role={uiRole}
  />
);

export const TableHeader = ({
  "data-myoxus-ui-role": uiRole = "table-header",
  ...props
}: MyoxusTableHeaderProps) => (
  <MantineTable.Thead {...props} data-myoxus-ui-role={uiRole} />
);

export const TableBody = ({
  "data-myoxus-ui-role": uiRole = "table-body",
  ...props
}: MyoxusTableBodyProps) => (
  <MantineTable.Tbody {...props} data-myoxus-ui-role={uiRole} />
);

export const TableRow = ({
  "data-myoxus-ui-role": uiRole = "table-row",
  ...props
}: MyoxusTableRowProps) => (
  <MantineTable.Tr {...props} data-myoxus-ui-role={uiRole} />
);

export const TableHead = ({
  "data-myoxus-ui-role": uiRole = "table-head",
  ...props
}: MyoxusTableHeadProps) => (
  <MantineTable.Th {...props} data-myoxus-ui-role={uiRole} />
);

export const TableCell = ({
  "data-myoxus-ui-role": uiRole = "table-cell",
  mono,
  muted,
  selected,
  selectionFocus,
  style,
  tabular,
  truncate,
  ...props
}: MyoxusTableCellProps) => (
  <MantineTable.Td
    {...props}
    data-myoxus-ui-role={uiRole}
    style={{
      color: muted ? cssVar("textSecondaryColor") : undefined,
      background: selected ? cssVar("hoverColor") : undefined,
      boxShadow: selectionFocus
        ? `inset 0 0 0 1px ${cssVar("primaryColor")}`
        : undefined,
      fontFamily: mono
        ? cssTypographyVar(
            "monospace",
            "family",
            cssTypographyVar("body-small", "family", cssVar("fontFamily")),
          )
        : undefined,
      fontVariantNumeric: tabular ? "tabular-nums" : undefined,
      maxWidth: truncate ? "24rem" : undefined,
      overflow: truncate ? "hidden" : undefined,
      textOverflow: truncate ? "ellipsis" : undefined,
      whiteSpace: truncate ? "nowrap" : undefined,
      ...style,
    }}
  />
);

export const TableScrollContainer = ({
  "data-myoxus-ui-role": uiRole = "table-scroll-container",
  containInlineSize = false,
  minWidth = "100%",
  style,
  ...props
}: MyoxusTableScrollContainerProps) => (
  <MantineTable.ScrollContainer
    {...props}
    data-myoxus-ui-role={uiRole}
    miw={0}
    minWidth={minWidth}
    style={{ contain: containInlineSize ? "inline-size" : undefined, ...style }}
    w="100%"
  />
);

export function Pagination({
  totalCount,
  pageNum = 0,
  countPerPage,
  onPageChange,
  disabled = false,
  withEdges = false,
}: {
  totalCount: number;
  pageNum?: number;
  countPerPage: number;
  onPageChange: (skip: number, pageNum: number) => void;
  disabled?: boolean;
  withEdges?: boolean;
}) {
  const total = Math.max(1, Math.ceil(totalCount / countPerPage));
  return (
    <MantinePagination
      total={total}
      value={pageNum + 1}
      disabled={disabled}
      withEdges={withEdges}
      onChange={(page) =>
        !disabled &&
        onPageChange(((page - 1) * countPerPage) % totalCount, page - 1)
      }
      data-myoxus-ui-role="settings-pagination"
    />
  );
}
