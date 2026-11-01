// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button, Stack } from "@myoxus/ui-facade";
import {
  c4BoundaryCallFields,
  mermaidMessages as m,
  type C4ReactHostProps,
  type MermaidC4Boundary,
} from "@virgultum/block-mermaid";
import { C4ArgumentControl, C4SourceValueControl } from "./argument-popover";
import { C4AliasControl } from "./alias-popover";
import { C4DeleteControl } from "./delete-controls";

/** A repeated boundary's physical arguments are reachable without a second form model. */
export function C4BoundaryRecordForm({
  props,
  boundary,
  recordKey,
  onClose,
}: {
  props: C4ReactHostProps;
  boundary: MermaidC4Boundary;
  recordKey: string;
  onClose: () => void;
}) {
  const record = props.model.sourceDocument.records.find(
    (r) => r.sourceKey === recordKey && r.kind === "boundary-open",
  );
  if (
    !record?.callKind ||
    !record.arguments ||
    !boundary.resolution!.sourceKeys.includes(recordKey)
  )
    return null;
  const id = boundary.resolution!.selectionId;
  const fields = c4BoundaryCallFields(record.callKind);
  return (
    <Stack>
      <C4AliasControl props={props} selectionId={id} recordKey={recordKey} />
      {record.arguments.slice(1).map((argument, offset) => {
        const index = offset + 1;
        return argument.key || argument.named ? (
          <C4ArgumentControl
            key={index}
            props={props}
            selectionId={id}
            sourceKey={recordKey}
            index={index}
            argument={argument}
            call={record.callKind!}
            line={record.range.line}
            command="editC4BoundaryArgument"
          />
        ) : (
          <C4SourceValueControl
            key={index}
            props={props}
            selectionId={id}
            sourceKey={recordKey}
            index={index}
            argument={argument}
            field={fields[index]?.field ?? ""}
            command="editC4BoundaryArgument"
          />
        );
      })}
      <C4DeleteControl
        props={props}
        target={{ selectionId: id, recordKey }}
        onDeleted={onClose}
      />
      <Button onClick={onClose}>{m.cancel()}</Button>
    </Stack>
  );
}
