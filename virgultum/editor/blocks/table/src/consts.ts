export const ColumnMinWidth = 60;
export const ColumnMaxWidth = 240;
export const DefaultColumnWidth = 120;
export const DefaultRowHeight = 39;

// These values are table-content geometry, not application chrome. Keep the
// two density projections here so live cells, drag previews and HTML adapters
// cannot silently diverge.
export const TableCellPadding = {
  normal: { block: "8px", inline: "12px" },
  compact: { block: "4px", inline: "8px" },
} as const;
