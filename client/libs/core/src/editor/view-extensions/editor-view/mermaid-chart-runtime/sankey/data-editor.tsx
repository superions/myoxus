// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type SankeyCommand,
  type SankeySelection,
  type MermaidSankeyReactHostProps,
} from "@virgultum/block-mermaid";
import { Actions } from "../common";

export function SankeyDataEditor({
  props,
  onEdit,
  onApply,
  onDelete,
}: {
  readonly props: MermaidSankeyReactHostProps;
  readonly onEdit: (selection: Exclude<SankeySelection, null>) => void;
  readonly onApply: (command: SankeyCommand) => boolean;
  readonly onDelete: (id: string) => void;
}) {
  const records = props.model.sourceDocument.records.filter(
    (record) => record.kind === "csv",
  );
  return (
    <Table aria-label={messages.pieData()}>
      <TableHeader>
        <TableRow>
          {[
            messages.chartSource(),
            messages.chartTarget(),
            messages.selectedSankeyValue(),
            messages.visualMoreActions(),
          ].map((label) => (
            <TableHead key={label}>{label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record, recordIndex) => (
          <TableRow key={record.id}>
            {[0, 1, 2].map((index) => (
              <TableCell key={index}>
                <Button
                  variant="plain"
                  onClick={() => onEdit({ kind: "link", id: record.id })}
                >
                  {record.fields[index]?.value ?? ""}
                </Button>
              </TableCell>
            ))}
            <TableCell>
              <Actions
                disabled={props.readonly}
                upLabel={messages.visualMoveUp()}
                downLabel={messages.visualMoveDown()}
                deleteLabel={messages.visualDelete()}
                onUp={() => {
                  const previous = records[recordIndex - 1];
                  if (previous)
                    onApply({
                      type: "link.reorder",
                      id: record.id,
                      beforeId: previous.id,
                    });
                }}
                onDown={() => {
                  const next = records[recordIndex + 1];
                  if (next)
                    onApply({
                      type: "link.reorder",
                      id: next.id,
                      beforeId: record.id,
                      selectionId: record.id,
                    });
                }}
                onDelete={() => onDelete(record.id)}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
